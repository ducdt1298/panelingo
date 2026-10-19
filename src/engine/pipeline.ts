// Image pipeline. Jobs per (frameKey, imageKey) share work per contentKey (jobs.ts).
// Unless the submit forces a re-translation, the cache answers first: urlKey alias → contentKey → units + translations
// → img:units + img:bulk with no detector or translator call. Otherwise: acquire → sha256 → decode → detect (persist
// geometry; 0 units = no-text, nothing uploaded) → img:units → packs (batcher) → queue → translator, streaming every
// unit result to the translation store and to each frame that shows the image. Uploads wait for the privacy notice
// and a sendable API (img:state paused carries the reason; neither gate applies in offline mode, which uploads
// nothing); nothing in flight is aborted and late results are still stored. Cached AI records count only for the
// engine that wrote them (TranslationRecord.model: the API model, or "offline:…"). Per frame the order is img:units, then img:unit / img:bulk, then img:done.
// Series memory (memory.ts): each pack is sent with the context of its page's series and chapter (glossary, earlier
// lines, summary, the series language when known), and what its answers teach is learned once it finishes.
// Look-ahead: a prefetch submit (tier-B discovery: a lazy image the page has not loaded) is fetched, decoded and
// detected, but nothing of it is uploaded until a submit without `prefetch` (the image entered the translate window
// or the page loaded it) asks for the translation. Each frame gets en:horizons (shared/core/priority.ts
// computeHorizons) from its reading speed and the measured request latency. Images read from a screen capture
// (ladder step 3) are marked lowRes in img:units, and their bytes are the last ones the bytes LRU drops (a new
// capture would not reproduce them).

import { readinessErrorCode } from "../shared/core/health.ts";
import { computeHorizons, createLatencyEstimator, type Horizons } from "../shared/core/priority.ts";
import { profileForModel, scriptForLang } from "../shared/core/model-profile.ts";
import { currentSource, translationSource } from "../shared/offline/routing.ts";
import { resolveBoxBudget } from "../shared/core/packing.ts";
import { chooseReadingDir } from "../shared/core/reading-order.ts";
import {
  allowAutoPass,
  AUTO_PASSES,
  RATE_LIMIT_CONCURRENCY,
  TIMEOUT_CONCURRENCY,
} from "../shared/core/retry-policy.ts";
import { CtvError, ERRORS, toErrorInfo, type ErrorInfo } from "../shared/errors.ts";
import type { EngineToCs, EngineToCsMap, ImageSubmit, PageHints } from "../shared/protocol.ts";
import type { ImageRecord, PatchRecord, TranslationRecord, UnitsRecord } from "../shared/records.ts";
import { inFlightCap, type SiteSettings } from "../shared/settings.ts";
import type {
  EngineStatus,
  Lang,
  ReadingDir,
  TranscriptItem,
  UnitRender,
  UnitStatus,
} from "../shared/types.ts";
import { urlKeyOf } from "../shared/url-normalize.ts";
import { pageKeysOf, type PageKeys } from "../shared/series-key.ts";
import { ERASE_VERSION, PROMPT_VERSION, UNITS_VERSION } from "../shared/versions.ts";
import { createBatcher, toPackUnits, URGENT_PACK_MAX, type PackPlanner } from "./batcher.ts";
import type {
  AcquireContext,
  AcquiredImage,
  ApiHealth,
  CoreDeps,
  DecodedImage,
  DetectOptions,
  EngineStores,
  EraseOutput,
  Eraser,
  FrameInfo,
  FrameSink,
  ImageAcquirer,
  ImageDecoder,
  MemoryScope,
  PackMemory,
  PackReport,
  PackTranslator,
  PackUnit,
  Pipeline,
  SeriesMemory,
  TextDetector,
  UiBroadcast,
  UnitOutcomeStatus,
  UnitResult,
} from "./contracts.ts";
import {
  attachJob,
  countStatuses,
  createJobTable,
  createWorkTable,
  detachJob,
  displayStatus,
  errorInfo,
  needsPass,
  newWork,
  setUnits,
  unitRender,
  viewOf,
  viewSignature,
  workActive,
  type ContentWork,
  type GateView,
  type ImageJob,
  type UnitSlot,
  type WorkPack,
} from "./jobs.ts";
import { createSeriesMemory } from "./memory.ts";
import { promptTarget } from "./translator.ts";
import {
  compareRanks,
  createQueue,
  createSlots,
  type Lane,
  type QueueGate,
  type QueueTask,
} from "./queue.ts";

export interface PipelineDeps extends CoreDeps {
  stores: EngineStores;
  health: ApiHealth;
  acquirer: ImageAcquirer;
  decoder: ImageDecoder;
  detector: TextDetector;
  translator: PackTranslator;
  ui: UiBroadcast;
  /** Erase patches; without it units are drawn on a plate over their text area. */
  eraser?: Eraser;
  /** urlKey of an image src ("u:" + normalized URL); default shared/url-normalize.ts urlKeyOf. */
  urlKeyOf?: (src: string) => string | null;
  /** Pack planner seam (packing across the images of one frame and chapter is not implemented). */
  planPacks?: PackPlanner;
  /** Series memory; default createSeriesMemory over `stores` (a no-op without the series memory stores). */
  memory?: SeriesMemory;
}

/** Images prepared at once (acquire → hash → decode → detect); the detector itself runs one model at a time. */
export const PREP_CONCURRENCY = 2;
/** Works kept in memory without a job, least recently used first out. */
export const MAX_IDLE_WORKS = 256;
/** urlKey → contentKey memo entries. */
export const MAX_URL_MEMO = 2048;
/** Page URL + title → series and chapter keys memo entries. */
const MAX_KEYS_MEMO = 64;
/** UnitRenders per img:bulk message: far below the 8 MiB soft limit. */
export const BULK_CHUNK = 100;

/** The submit without its image bytes (kept on the job after acquisition). */
export function withoutBytes(submit: ImageSubmit): ImageSubmit {
  const { bytes: _bytes, mime: _mime, source: _source, ...rest } = submit;
  return rest;
}

/** Fetching again later: bytes the content script sent once are not kept, so the engine fetches the URL (step 2). */
export function reacquireSubmit(submit: ImageSubmit): ImageSubmit {
  const rest = withoutBytes(submit);
  return submit.acquire === "bytes" && submit.bytes === undefined ? { ...rest, acquire: "url" } : submit;
}

function layoutDir(layout: PageHints["layout"]): ReadingDir | "auto" {
  switch (layout) {
    case "paged-rtl":
      return "rtl";
    case "paged-ltr":
    case "webtoon":
      return "ltr";
    case "auto":
      return "auto";
  }
}

interface PackEntry extends WorkPack {
  readonly id: string;
  readonly work: ContentWork;
  readonly units: PackUnit[];
  readonly frameKey: string;
  readonly lang: Lang | "auto";
  /** Document order of the image in its page (chapter history). */
  readonly docOrder: number;
  readonly task: QueueTask;
}

/** Encoded bytes of released images (settings.cache.encodedBytesLruMb), so a retry decodes without refetching. */
interface BytesCache {
  has(contentKey: string): boolean;
  get(contentKey: string): AcquiredImage | null;
  put(contentKey: string, image: AcquiredImage): void;
  clear(): void;
}

function createBytesCache(maxBytes: () => number): BytesCache {
  const entries = new Map<string, AcquiredImage>();
  let total = 0;
  return {
    has: (contentKey) => entries.has(contentKey),
    get(contentKey) {
      const image = entries.get(contentKey);
      if (image === undefined) return null;
      entries.delete(contentKey);
      entries.set(contentKey, image);
      return image;
    },
    put(contentKey, image) {
      const old = entries.get(contentKey);
      if (old !== undefined) total -= old.bytes.byteLength;
      entries.delete(contentKey);
      entries.set(contentKey, image);
      total += image.bytes.byteLength;
      const cap = maxBytes();
      // Screen captures go last: their bytes cannot be fetched again.
      for (const lowRes of [false, true]) {
        for (const [key, value] of entries) {
          if (total <= cap) break;
          if (value.lowRes !== lowRes) continue;
          entries.delete(key);
          total -= value.bytes.byteLength;
        }
      }
    },
    clear() {
      entries.clear();
      total = 0;
    },
  };
}

type PassMode = "auto" | "manual";

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { clock, log, settings, stores, health, acquirer, decoder, detector, translator, ui, eraser } = deps;
  const urlKeyFor = deps.urlKeyOf ?? urlKeyOf;
  const memory = deps.memory ?? createSeriesMemory({ clock, log, settings, stores });
  const keysMemo = new Map<string, PageKeys | null>();
  const batcher = createBatcher(deps.planPacks);
  const jobs = createJobTable();
  const works = createWorkTable();
  const frames = new Map<string, FrameSink>();
  const urlMemo = new Map<string, string>();
  const loading = new Map<string, Promise<ContentWork | null>>();
  const entries = new Map<QueueTask, PackEntry>();
  const bytes = createBytesCache(() => settings.current().cache.encodedBytesLruMb * 1024 * 1024);
  const prep = createSlots(PREP_CONCURRENCY);
  const stats = { done: 0, failed: 0 };
  const latency = createLatencyEstimator();
  /** Last en:horizons signature per frame. */
  const horizonsSent = new Map<string, string>();
  /** Frames that submitted a webtoon strip member (the Strip look-ahead maximum applies). */
  const stripFrames = new Set<string>();
  let flows = 0;
  let packSeq = 0;

  const queue = createQueue({
    clock,
    limits: () => {
      const s = settings.current();
      return { concurrency: s.api.concurrency, cap: inFlightCap(s) };
    },
    gate: () => gateState(),
    onBusy: (busy) => health.setBusy(busy),
    onCrash: (error) => log.error("pack task crashed", { error: String(error) }),
  });

  health.onChange(() => refreshAll());
  settings.onChange(() => refreshAll());

  /* ---------------------------------------------------------------- gates and views */

  /** Offline mode (experimental): nothing is uploaded and no endpoint is needed, so neither gate applies. */
  function offlineEngine(): boolean {
    return settings.current().translate.engine === "offline";
  }

  function privacyBlocked(): boolean {
    return !offlineEngine() && settings.current().privacy.ackUploadNoticeAt === null;
  }

  function gateState(): QueueGate {
    if (privacyBlocked()) return { open: false, code: "privacy.consent" };
    if (!offlineEngine() && !health.sendable()) {
      return { open: false, code: readinessErrorCode(health.reading().readiness) };
    }
    return { open: true };
  }

  function gateView(): GateView {
    let healthError: ErrorInfo | null = null;
    if (!offlineEngine() && !health.sendable()) {
      const readiness = health.reading().readiness;
      const code = readinessErrorCode(readiness);
      if (code !== null) healthError = errorInfo(code, `API not sendable: ${readiness}`);
    }
    return {
      privacy: privacyBlocked() ? errorInfo("privacy.consent", "upload notice not confirmed") : null,
      health: healthError,
    };
  }

  /** Gate or settings change: re-derive every image state (paused ↔ waiting) and dispatch what may run now. */
  function refreshAll(): void {
    try {
      const gate = gateView();
      for (const job of jobs.all()) sendState(job, gate);
      queue.pump();
    } catch (error) {
      log.error("refresh failed", { error: String(error) });
    }
  }

  function boxBudgetNow(): number {
    return resolveBoxBudget(
      profileForModel(settings.current().api.model).boxBudget,
      settings.current().translate.boxBudget,
    );
  }

  /* ---------------------------------------------------------------- frames and messages */

  function frameInfo(job: ImageJob): FrameInfo | null {
    return frames.get(job.frameKey)?.info ?? null;
  }

  function post(job: ImageJob, message: EngineToCs): void {
    const frame = frames.get(job.frameKey);
    if (frame === undefined || job.dropped) return;
    try {
      frame.post(message);
    } catch (error) {
      log.warn("post to frame failed", { frameKey: job.frameKey, error: String(error) });
    }
  }

  function sendState(job: ImageJob, gate: GateView = gateView(), force = false): void {
    const view = viewOf(job, gate);
    const signature = viewSignature(view);
    if (!force && job.sent === signature) return;
    job.sent = signature;
    const message: { readonly type: "img:state" } & EngineToCsMap["img:state"] = {
      type: "img:state",
      imageKey: job.imageKey,
      state: view.state,
    };
    if (view.progress !== undefined) message.progress = { ...view.progress };
    if (view.error !== undefined) message.error = { ...view.error };
    post(job, message);
  }

  function updateStates(work: ContentWork): void {
    const gate = gateView();
    for (const job of work.jobs) sendState(job, gate);
  }

  function postUnitsMessage(job: ImageJob, work: ContentWork): void {
    if (work.natural === null) return;
    const message: { readonly type: "img:units" } & EngineToCsMap["img:units"] = {
      type: "img:units",
      imageKey: job.imageKey,
      contentKey: work.contentKey,
      natural: { ...work.natural },
      units: work.units,
    };
    if (work.lang !== null) message.lang = work.lang;
    if (work.record?.lowRes === true || work.source?.lowRes === true) message.lowRes = true;
    post(job, message);
  }

  /* ---------------------------------------------------------------- look-ahead */

  /** Some frame shows the image as more than a prefetch candidate: its units may be uploaded. */
  function wantsTranslation(work: ContentWork): boolean {
    for (const job of work.jobs) if (job.submit.prefetch !== true) return true;
    return false;
  }

  function horizonsOf(frame: FrameSink): Horizons {
    const discovery = settings.current().discovery;
    const strip =
      stripFrames.has(frame.info.frameKey) ||
      frame.info.page.layout === "webtoon" ||
      settings.site(frame.info.siteKey).layout === "webtoon";
    return computeHorizons({
      secondsPerScreen: frame.info.viewport?.secondsPerScreen ?? discovery.secondsPerScreenDefault,
      latencyMs: latency.ms,
      strip,
      settings: discovery,
    });
  }

  /** en:horizons when the frame's horizons changed since the last one it got. */
  function postHorizons(frameKey: string): void {
    const frame = frames.get(frameKey);
    if (frame === undefined || !frame.connected) return;
    const horizons = horizonsOf(frame);
    const signature = `${horizons.translateScreens}|${horizons.detectScreens}|${horizons.detectMaxImages}`;
    if (horizonsSent.get(frameKey) === signature) return;
    try {
      if (frame.post({ type: "en:horizons", ...horizons })) horizonsSent.set(frameKey, signature);
    } catch (error) {
      log.warn("en:horizons post failed", { frameKey, error: String(error) });
    }
  }

  function postDone(job: ImageJob, work: ContentWork): void {
    post(job, {
      type: "img:done",
      imageKey: job.imageKey,
      contentKey: work.contentKey,
      counts: countStatuses(work),
    });
  }

  /** Everything a job's frame needs to show the image as it is now ("served from cache" after a reconnect). */
  function replay(job: ImageJob): void {
    const work = job.work;
    if (work !== null && work.phase === "ready" && work.natural !== null) {
      postUnitsMessage(job, work);
      const shown = [...work.slots.values()].filter((slot) => displayStatus(slot) !== "pending");
      for (let i = 0; i < shown.length; i += BULK_CHUNK) {
        post(job, {
          type: "img:bulk",
          imageKey: job.imageKey,
          contentKey: work.contentKey,
          natural: { ...work.natural },
          units: shown.slice(i, i + BULK_CHUNK).map((slot) => renderFor(job, work, slot)),
        });
      }
    }
    sendState(job, gateView(), true);
    if (work !== null && work.phase === "ready" && work.settled) postDone(job, work);
  }

  function transcriptItem(job: ImageJob, slot: UnitSlot): TranscriptItem {
    const status = displayStatus(slot);
    const r = slot.result;
    return {
      contentKey: job.contentKey ?? "",
      unitKey: slot.geometry.unitKey,
      pageOrder: job.submit.pos.docOrder,
      order: slot.geometry.order,
      type: r?.type ?? "dialogue",
      speaker: r?.speaker ?? "",
      original: r?.original ?? "",
      translation: status === "manual" ? (slot.manual ?? "") : status === "ok" ? (r?.translation ?? "") : "",
      status,
      manual: slot.manual !== null,
      flags: [],
    };
  }

  function postTranscript(work: ContentWork, slots: readonly UnitSlot[], only: ImageJob | null = null): void {
    if (slots.length === 0) return;
    const byTab = new Map<number, ImageJob>();
    for (const job of only === null ? work.jobs : [only]) {
      const info = frameInfo(job);
      if (info !== null && !byTab.has(info.tabId)) byTab.set(info.tabId, job);
    }
    for (const [tabId, job] of byTab) {
      try {
        ui.post({ type: "tx:delta", tabId, items: slots.map((slot) => transcriptItem(job, slot)) }, tabId);
      } catch (error) {
        log.warn("ui post failed", { error: String(error) });
      }
    }
  }

  /** Series and chapter keys of a frame's page (memoized: URL parsing per record write adds up). */
  function keysOf(info: FrameInfo | null): PageKeys | null {
    if (info === null) return null;
    const memoKey = `${info.url}\u0000${info.page.title}`;
    if (keysMemo.has(memoKey)) return keysMemo.get(memoKey) ?? null;
    const keys = pageKeysOf(info.url, info.page.title);
    keysMemo.set(memoKey, keys);
    if (keysMemo.size > MAX_KEYS_MEMO) {
      const oldest = keysMemo.keys().next();
      if (oldest.done !== true) keysMemo.delete(oldest.value);
    }
    return keys;
  }

  /** Where a pack of this frame belongs in series memory; null for pages without keys (not http(s)). */
  function scopeOf(frameKey: string): MemoryScope | null {
    const info = frames.get(frameKey)?.info ?? null;
    const keys = keysOf(info);
    if (info === null || keys === null) return null;
    return {
      seriesKey: keys.seriesKey,
      chapterKey: keys.chapterKey,
      siteKey: keys.siteKey,
      url: info.url,
      title: info.page.title,
    };
  }

  /** URL and title of a frame's page (TranslatePack.pageUrl / pageTitle). */
  function pageOf(frameKey: string): { pageUrl?: string; pageTitle?: string } {
    for (const work of works.values()) {
      for (const job of work.jobs) {
        if (job.frameKey !== frameKey) continue;
        const info = frameInfo(job);
        if (info !== null) return { pageUrl: info.url, pageTitle: info.page.title };
      }
    }
    return {};
  }

  /** UnitRender in the job's frame codec (patch bytes as ArrayBuffer or base64). */
  function renderFor(job: ImageJob, work: ContentWork, slot: UnitSlot): UnitRender {
    return unitRender(slot, work.natural, frameInfo(job)?.codec ?? "sc", work.lang);
  }

  /* ---------------------------------------------------------------- erase patches */

  /** Starts the eraser for every unit that has no patch yet; needs the decoded bitmap open now. */
  function startErase(work: ContentWork, decoded: DecodedImage): void {
    if (eraser === undefined) return;
    const todo = [...work.slots.values()].filter((slot) => slot.erase === null && !slot.eraseStarted);
    if (todo.length === 0) return;
    for (const slot of todo) slot.eraseStarted = true;
    let started: Map<string, Promise<EraseOutput>>;
    try {
      started = eraser.start(
        decoded,
        todo.map((slot) => slot.geometry),
      );
    } catch (error) {
      for (const slot of todo) slot.eraseStarted = false;
      log.warn("erase start failed", { error: String(error) });
      return;
    }
    for (const [unitKey, pending] of started) {
      pending.then(
        (output) => {
          const slot = work.slots.get(unitKey);
          if (slot === undefined) return;
          slot.erase = output;
          persistPatch(work, unitKey, output);
          const status = displayStatus(slot);
          if (status === "ok" || status === "manual") postUnit(work, slot);
        },
        (error: unknown) => log.warn("erase failed", { unitKey, error: String(error) }),
      );
    }
  }

  function persistPatch(work: ContentWork, unitKey: string, output: EraseOutput): void {
    const png = output.png ?? new ArrayBuffer(0);
    const record: PatchRecord = {
      contentKey: work.contentKey,
      unitKey,
      eraseVersion: ERASE_VERSION,
      kind: output.kind,
      rect: output.rect,
      bg: output.bg,
      textColor: output.textColor,
      glyphPx: output.glyphPx,
      interior: output.interior,
      rectLike: output.rectLike,
      png,
      bytes: png.byteLength,
      lastUsedAt: clock.now(),
    };
    persist("patch write", () => stores.patches.put(record));
  }

  function patchesInto(work: ContentWork, records: readonly PatchRecord[]): void {
    for (const record of records) {
      if (record.eraseVersion !== ERASE_VERSION) continue;
      const slot = work.slots.get(record.unitKey);
      if (slot === undefined || slot.erase !== null) continue;
      slot.erase = {
        kind: record.kind,
        rect: record.rect,
        bg: record.bg,
        textColor: record.textColor,
        png: record.kind === "mask" && record.png.byteLength > 0 ? record.png : null,
        glyphPx: record.glyphPx,
        interior: record.interior ?? null,
        rectLike: record.rectLike ?? false,
      };
    }
  }

  /** img:unit for one slot to every frame that shows the image. */
  function postUnit(work: ContentWork, slot: UnitSlot): void {
    for (const job of work.jobs) {
      post(job, { type: "img:unit", imageKey: job.imageKey, unit: renderFor(job, work, slot) });
    }
    postTranscript(work, [slot]);
  }

  /* ---------------------------------------------------------------- ranks */

  function jobOnScreen(job: ImageJob): boolean {
    const info = frameInfo(job);
    return info !== null && info.page.visible && (info.viewport?.onScreen.includes(job.imageKey) ?? false);
  }

  /** Hidden frames last (eta +∞), then the submit priority, then the most recently focused tab, then age. */
  function jobRank(job: ImageJob): number[] {
    const info = frameInfo(job);
    const hidden = info === null || !info.page.visible ? 1 : 0;
    return [hidden, job.submit.priority, -(info?.focusSeq ?? 0), job.seq];
  }

  function prepRank(job: ImageJob): number[] {
    return [jobOnScreen(job) ? 0 : 1, ...jobRank(job)];
  }

  function leadJob(work: ContentWork): ImageJob | null {
    let lead: ImageJob | null = null;
    let leadRank: number[] = [];
    for (const job of work.jobs) {
      const rank = jobRank(job);
      if (lead === null || compareRanks(rank, leadRank) < 0) {
        lead = job;
        leadRank = rank;
      }
    }
    return lead;
  }

  function workOnScreen(work: ContentWork): boolean {
    for (const job of work.jobs) if (jobOnScreen(job)) return true;
    return false;
  }

  function workRank(work: ContentWork): number[] {
    const lead = leadJob(work);
    return lead === null ? [2] : jobRank(lead);
  }

  /* ---------------------------------------------------------------- store helpers */

  function persist(what: string, write: () => Promise<void>): void {
    try {
      void write().catch((error: unknown) =>
        log.warn(`${what} failed`, { error: String(error) }, "store.io"),
      );
    } catch (error) {
      log.warn(`${what} failed`, { error: String(error) }, "store.io");
    }
  }

  function remember(urlKey: string, contentKey: string): void {
    urlMemo.delete(urlKey);
    urlMemo.set(urlKey, contentKey);
    while (urlMemo.size > MAX_URL_MEMO) {
      const oldest = urlMemo.keys().next();
      if (oldest.done === true) break;
      urlMemo.delete(oldest.value);
    }
  }

  async function aliasOf(urlKey: string): Promise<string | null> {
    const known = urlMemo.get(urlKey);
    if (known !== undefined) return known;
    try {
      const contentKey = await stores.images.alias(urlKey);
      if (contentKey === undefined) return null;
      remember(urlKey, contentKey);
      return contentKey;
    } catch (error) {
      log.warn("alias lookup failed", { error: String(error) }, "store.io");
      return null;
    }
  }

  function storeAlias(urlKey: string | null, contentKey: string): void {
    if (urlKey === null || urlMemo.get(urlKey) === contentKey) return;
    remember(urlKey, contentKey);
    persist("alias write", () => stores.images.putAlias(urlKey, contentKey, clock.now()));
  }

  function dirFor(work: ContentWork, info: FrameInfo | null, site: SiteSettings): ReadingDir {
    const fromSite = layoutDir(site.layout);
    const fromPage = info === null ? "auto" : layoutDir(info.page.layout);
    return chooseReadingDir({
      size: work.natural ?? { w: 1, h: 1 },
      site: fromSite !== "auto" ? fromSite : fromPage,
      lang: work.lang ?? site.sourceLang,
      textBoxes: work.units.map((unit) => unit.text),
    });
  }

  function siteOf(job: ImageJob | null): SiteSettings {
    const info = job === null ? null : frameInfo(job);
    return settings.site(info?.siteKey ?? "");
  }

  function liveWork(contentKey: string): ContentWork | null {
    return works.get(contentKey) ?? null;
  }

  /** Geometry + translations from IndexedDB; null when either the units or the image record is missing. */
  async function loadWork(contentKey: string): Promise<ContentWork | null> {
    let unitsRecord: UnitsRecord | undefined;
    let imageRecord: ImageRecord | undefined;
    let records: TranslationRecord[];
    let patches: PatchRecord[];
    try {
      [unitsRecord, imageRecord, records, patches] = await Promise.all([
        stores.units.get(contentKey),
        stores.images.get(contentKey),
        stores.translations.forImage(contentKey),
        stores.patches.forImage(contentKey).catch(() => [] as PatchRecord[]),
      ]);
    } catch (error) {
      log.warn("cache read failed", { error: String(error) }, "store.io");
      return null;
    }
    if (unitsRecord === undefined || imageRecord === undefined) return null;
    const existing = liveWork(contentKey);
    if (existing !== null) return existing;
    const now = clock.now();
    const work = newWork(contentKey, now);
    work.natural = { w: imageRecord.w, h: imageRecord.h };
    work.lang = imageRecord.lang;
    work.record = imageRecord;
    work.seriesKey = imageRecord.seriesKey;
    // AI translations into another target language, or made by another engine (the API model, Opus-MT or NLLB in
    // offline mode), are translated again; manual edits always stay.
    const target = currentTarget();
    const source = currentSourceKey();
    setUnits(
      work,
      unitsRecord.units,
      records.filter(
        (r) =>
          r.manual === 1 ||
          ((r.target === undefined || r.target === target) && translationSource(r.model) === source),
      ),
    );
    patchesInto(work, patches);
    works.add(work);
    return work;
  }

  /** In-memory work, else the stored one (concurrent lookups of one key share a read). */
  async function obtainWork(contentKey: string): Promise<ContentWork | null> {
    const live = liveWork(contentKey);
    if (live !== null) return live;
    let pending = loading.get(contentKey);
    if (pending === undefined) {
      const started = loadWork(contentKey).finally(() => {
        if (loading.get(contentKey) === started) loading.delete(contentKey);
      });
      loading.set(contentKey, started);
      pending = started;
    }
    const loaded = await pending;
    return liveWork(contentKey) ?? loaded;
  }

  /* ---------------------------------------------------------------- decoding */

  function decodeLimits(): { maxImageBytes: number; maxImagePixels: number } {
    const p = settings.current().privacy;
    return { maxImageBytes: p.maxImageBytes, maxImagePixels: p.maxImagePixels };
  }

  function acquireContext(job: ImageJob): AcquireContext {
    const info = frameInfo(job);
    if (info === null) throw new CtvError("cancelled", "the frame of this image is gone");
    return { frame: info, site: settings.site(info.siteKey), settings: settings.current() };
  }

  /** Bytes again for an image whose source was released: the LRU, else a new acquisition checked against the key. */
  async function reacquire(work: ContentWork): Promise<AcquiredImage> {
    const cached = bytes.get(work.contentKey);
    if (cached !== null) return cached;
    const lead = leadJob(work);
    if (lead === null) throw new CtvError("cancelled", "no frame shows this image any more");
    const acquired = await acquirer.acquire(reacquireSubmit(lead.submit), acquireContext(lead));
    const contentKey = await decoder.contentKeyOf(acquired.bytes);
    if (contentKey !== work.contentKey) throw new CtvError("cancelled", "the image bytes changed");
    return acquired;
  }

  async function decodeInto(work: ContentWork, slotted: boolean): Promise<DecodedImage> {
    let release: (() => void) | null = null;
    if (!slotted) {
      const lead = leadJob(work);
      release = await prep.take(() => (lead === null ? [9] : prepRank(lead))).granted;
    }
    try {
      const source = work.source ?? (await reacquire(work));
      work.source = source;
      const decoded = await decoder.decode(source, work.contentKey, decodeLimits());
      if (work.decoded !== null && work.decoded !== decoded) work.decoded.release();
      work.decoded = decoded;
      work.natural ??= { w: decoded.size.w, h: decoded.size.h };
      return decoded;
    } finally {
      release?.();
    }
  }

  /** The decoded image of a work; `slotted` callers already hold a preparation slot. */
  function ensureDecoded(work: ContentWork, slotted: boolean): Promise<DecodedImage> {
    if (work.decoded !== null) return Promise.resolve(work.decoded);
    if (work.decoding !== null) return work.decoding;
    const pending = decodeInto(work, slotted).finally(() => {
      if (work.decoding === pending) work.decoding = null;
    });
    work.decoding = pending;
    return pending;
  }

  /**
   * Packs waiting for a lane (or behind a closed gate) keep only the encoded bytes: the bitmap is closed and decoded
   * again when a pack starts, so a long queue never pins one bitmap per image (cache.decodedBitmapsMax).
   */
  function parkBitmap(work: ContentWork): void {
    if (work.decoded === null || work.decoding !== null || work.phase !== "ready") return;
    for (const pack of work.packs) if (pack.started) return;
    work.decoded.release();
    work.decoded = null;
  }

  /** Closes the bitmap and parks the encoded bytes in the LRU once nothing is outstanding. */
  function releaseImage(work: ContentWork): void {
    if (work.decoded !== null) {
      work.decoded.release();
      work.decoded = null;
    }
    if (work.source !== null) {
      bytes.put(work.contentKey, work.source);
      work.source = null;
    }
  }

  /* ---------------------------------------------------------------- job flow */

  function stale(job: ImageJob, gen: number): boolean {
    return job.dropped || job.gen !== gen;
  }

  function startJob(job: ImageJob, force: boolean): void {
    flows += 1;
    void runJob(job, force).finally(() => {
      flows -= 1;
    });
  }

  async function runJob(job: ImageJob, force: boolean): Promise<void> {
    const gen = job.gen;
    try {
      if (!force && job.urlKey !== null) {
        const known = await aliasOf(job.urlKey);
        if (stale(job, gen)) return;
        if (known !== null) {
          const work = await obtainWork(known);
          if (stale(job, gen)) return;
          // A prefetch candidate starts no pass, so a known work needs no bytes for it.
          if (work !== null && (!needsBytes(work) || job.submit.prefetch === true)) {
            attach(job, work, null, false);
            return;
          }
        }
      }
      await acquireAndAttach(job, gen, force);
    } catch (error) {
      if (!stale(job, gen)) failJob(job, toErrorInfo(error));
    }
  }

  /** Attaching would start a pass but no bytes are at hand: acquire them first (a cache hit needs none). */
  function needsBytes(work: ContentWork): boolean {
    if (work.phase !== "ready") return false;
    if (work.source !== null || work.decoded !== null || work.decoding !== null) return false;
    if (bytes.has(work.contentKey)) return false;
    const now = clock.now();
    for (const slot of work.slots.values()) {
      if (needsPass(slot) || autoCandidate(slot, now)) return true;
    }
    return false;
  }

  async function acquireAndAttach(job: ImageJob, gen: number, force: boolean): Promise<void> {
    const ticket = prep.take(() => prepRank(job));
    job.cancelWait = () => ticket.cancel();
    const release = await ticket.granted;
    job.cancelWait = null;
    if (release === null) return;
    try {
      if (stale(job, gen)) return;
      job.phase = "acquiring";
      sendState(job);
      const acquired = await acquirer.acquire(job.submit, acquireContext(job));
      if (stale(job, gen)) return;
      job.submit = withoutBytes(job.submit);
      const contentKey = await decoder.contentKeyOf(acquired.bytes);
      storeAlias(job.urlKey, contentKey);
      if (stale(job, gen)) return;
      const found = await obtainWork(contentKey);
      if (stale(job, gen)) return;
      const work = found ?? liveWork(contentKey);
      if (work !== null) {
        attach(job, work, acquired, force);
        return;
      }
      const created = newWork(contentKey, clock.now());
      created.source = acquired;
      works.add(created);
      attach(job, created, null, false);
      await detectWork(created);
    } finally {
      release();
    }
  }

  /** Decode + detect inside the creating job's preparation slot. */
  async function detectWork(work: ContentWork): Promise<void> {
    try {
      const decoded = await ensureDecoded(work, true);
      const lead = leadJob(work);
      if (lead === null) {
        // Every frame forgot the image before the model ran: skip detection, keep nothing.
        works.delete(work.contentKey);
        releaseImage(work);
        return;
      }
      const site = siteOf(lead);
      const source = work.source;
      const minSide = settings.current().discovery.minNaturalSide;
      if (
        (lead.submit.prefetch === true || lead.submit.natural === null) &&
        Math.min(decoded.size.w, decoded.size.h) < minSide
      ) {
        // A prefetched candidate that turns out too small is never uploaded.
        setUnits(work, []);
        finishPrep(work);
        return;
      }
      if (source !== null) persistImage(work, decoded, source);
      work.dir = dirFor(work, frameInfo(lead), site);
      work.dirSet = true;
      const result = await detector.detect(decoded, detectOptions(work.dir));
      log.info("text detected", {
        units: result.units.length,
        backend: result.backend,
        ms: Math.round(result.timings.totalMs),
      });
      setUnits(work, result.units);
      startErase(work, decoded);
      const record: UnitsRecord = {
        contentKey: work.contentKey,
        detectorVersion: result.detectorVersion,
        unitsVersion: UNITS_VERSION,
        backend: result.backend,
        slices: result.slices,
        rawDetections: result.rawDetections,
        units: work.units,
        createdAt: clock.now(),
      };
      persist("units write", () => stores.units.put(record));
      finishPrep(work);
    } catch (error) {
      failWork(work, toErrorInfo(error));
    }
  }

  function finishPrep(work: ContentWork): void {
    for (const job of work.jobs) postUnitsMessage(job, work);
    startPendingPass(work, "auto");
    maybeSettle(work);
  }

  function persistImage(work: ContentWork, decoded: DecodedImage, source: AcquiredImage): void {
    const now = clock.now();
    const record: ImageRecord = {
      contentKey: work.contentKey,
      w: decoded.size.w,
      h: decoded.size.h,
      mime: source.mime,
      byteLength: source.bytes.byteLength,
      source: source.source,
      lowRes: source.lowRes,
      lang: work.lang,
      seriesKey: work.seriesKey,
      firstSeenAt: work.record?.firstSeenAt ?? now,
      lastUsedAt: now,
    };
    work.record = record;
    persist("image write", () => stores.images.put(record));
  }

  function detectOptions(dir: ReadingDir): DetectOptions {
    const d = settings.current().detector;
    return {
      scoreMin: d.scoreMin,
      slice: {
        triggerRatio: d.sliceTriggerRatio,
        heightRatio: d.sliceHeightRatio,
        overlap: d.sliceOverlap,
        overlapMinPx: d.sliceOverlapMinPx,
        quietRows: d.quietRows,
      },
      dir,
    };
  }

  function autoCandidate(slot: UnitSlot, now: number): boolean {
    return (
      slot.manual === null &&
      !slot.inPass &&
      (slot.status === "untranslated" || slot.status === "error") &&
      allowAutoPass(slot.autoPasses, now)
    );
  }

  /** Units an explicit re-translation sends again; an explicitly named unit goes even when edited by hand. */
  function retranslateKeys(work: ContentWork, unitKey?: string): string[] {
    const keys: string[] = [];
    for (const [key, slot] of work.slots) {
      if (slot.inPass) continue;
      if (unitKey !== undefined ? key === unitKey : slot.manual === null && slot.status !== "pending")
        keys.push(key);
    }
    return keys;
  }

  /** Marks units pending again and tells the frames that already show them (except `skip`). */
  function reopen(work: ContentWork, keys: readonly string[], skip: ImageJob | null): void {
    for (const key of keys) {
      const slot = work.slots.get(key);
      if (slot === undefined) continue;
      slot.status = "pending";
      for (const job of work.jobs) {
        if (job !== skip)
          post(job, { type: "img:unit", imageKey: job.imageKey, unit: renderFor(job, work, slot) });
      }
    }
  }

  /**
   * Joins a job to the work of its bytes and replays what exists. Units still without an outcome get a pass;
   * untranslated / error units get an automatic one within the allowAutoPass budget; `force` re-sends everything not
   * edited by hand.
   */
  function attach(job: ImageJob, work: ContentWork, acquired: AcquiredImage | null, force: boolean): void {
    attachJob(job, work);
    work.lastUsedAt = clock.now();
    const seriesKey = keysOf(frameInfo(job))?.seriesKey ?? null;
    if (seriesKey !== null && seriesKey !== work.seriesKey) {
      work.seriesKey = seriesKey;
      const stored = work.record;
      if (stored !== null && stored.seriesKey !== seriesKey) {
        const record: ImageRecord = { ...stored, seriesKey };
        work.record = record;
        persist("image write", () => stores.images.put(record));
      }
    }
    // Retention keeps translations whose image is in use; the store writes at most once per hour per image.
    persist("image touch", () => stores.images.touch(work.contentKey, work.lastUsedAt));
    if (acquired !== null && work.source === null && work.decoded === null) work.source = acquired;
    if (work.phase === "ready" && !work.dirSet) {
      work.dir = dirFor(work, frameInfo(job), siteOf(job));
      work.dirSet = true;
    }
    if (work.phase === "ready" && !workActive(work) && (force || wantsTranslation(work))) {
      const now = clock.now();
      const keys = force
        ? retranslateKeys(work)
        : [...work.slots].filter(([, slot]) => autoCandidate(slot, now)).map(([key]) => key);
      reopen(work, keys, job);
    }
    replay(job);
    postTranscript(
      work,
      [...work.slots.values()].filter((slot) => displayStatus(slot) !== "pending"),
      job,
    );
    if (work.phase === "ready") {
      startPendingPass(work, force ? "manual" : "auto");
      maybeSettle(work);
    }
  }

  function failJob(job: ImageJob, info: ErrorInfo): void {
    const work = detachJob(job);
    job.phase = "failed";
    job.error = info;
    log
      .child({ frameKey: job.frameKey, imageKey: job.imageKey })
      .warn("image failed", { reason: info.message }, info.code);
    sendState(job);
    if (work !== null && work.jobs.size === 0) abandonWork(work);
  }

  function failWork(work: ContentWork, info: ErrorInfo): void {
    if (works.get(work.contentKey) === work) works.delete(work.contentKey);
    work.source = null;
    releaseImage(work);
    for (const job of [...work.jobs]) failJob(job, info);
  }

  function dropJob(job: ImageJob): void {
    job.gen += 1;
    job.dropped = true;
    job.cancelWait?.();
    job.cancelWait = null;
    jobs.remove(job);
    const work = detachJob(job);
    if (work !== null && work.jobs.size === 0) abandonWork(work);
  }

  /** Nobody shows the image any more: unsent packs go, in-flight ones finish and are still stored. */
  function abandonWork(work: ContentWork): void {
    const dropped = queue.drop((task) => entries.get(task)?.work === work);
    for (const task of dropped) {
      const entry = entries.get(task);
      entries.delete(task);
      if (entry === undefined) continue;
      work.packs.delete(entry);
      for (const key of entry.unitKeys) {
        const slot = work.slots.get(key);
        if (slot !== undefined) slot.inPass = false;
      }
    }
    maybeSettle(work);
  }

  /* ---------------------------------------------------------------- passes and packs */

  function startPendingPass(work: ContentWork, mode: PassMode): void {
    if (work.phase !== "ready" || work.jobs.size === 0) return;
    // Prefetch candidates are detected only; the frame asks again when the reader gets near them.
    if (mode === "auto" && !wantsTranslation(work)) return;
    const keys = [...work.slots].filter(([, slot]) => needsPass(slot)).map(([key]) => key);
    if (keys.length > 0) startPass(work, keys, mode);
  }

  /** Sends `keys` again (pending until their results arrive); returns how many units were queued. */
  function startPass(work: ContentWork, keys: readonly string[], mode: PassMode): number {
    const now = clock.now();
    const owned: string[] = [];
    for (const key of keys) {
      const slot = work.slots.get(key);
      if (slot === undefined || slot.inPass) continue;
      slot.status = "pending";
      slot.inPass = true;
      if (mode === "auto")
        slot.autoPasses = [...slot.autoPasses.filter((t) => now - t < AUTO_PASSES.windowMs), now];
      owned.push(key);
    }
    if (owned.length === 0) return 0;
    work.settled = false;
    work.error = null;
    work.preparing += 1;
    updateStates(work);
    flows += 1;
    void preparePass(work, owned).finally(() => {
      flows -= 1;
      work.preparing -= 1;
      maybeSettle(work);
      queue.pump();
    });
    return owned.length;
  }

  /** Units of an abandoned pass: pending again, for whoever attaches next. */
  function releaseKeys(work: ContentWork, keys: readonly string[]): void {
    for (const key of keys) {
      const slot = work.slots.get(key);
      if (slot !== undefined) slot.inPass = false;
    }
  }

  async function preparePass(work: ContentWork, keys: readonly string[]): Promise<void> {
    try {
      await ensureDecoded(work, false);
    } catch (error) {
      if (work.jobs.size === 0) {
        releaseKeys(work, keys);
        return;
      }
      work.error = toErrorInfo(error);
      for (const key of keys) deliverSynthetic(work, key, "error", false);
      return;
    }
    if (work.jobs.size === 0) {
      releaseKeys(work, keys);
      return;
    }
    enqueuePacks(work, keys);
  }

  function enqueuePacks(work: ContentWork, keys: readonly string[]): void {
    const lead = leadJob(work);
    if (lead === null || work.natural === null) {
      releaseKeys(work, keys);
      return;
    }
    const site = siteOf(lead);
    const lang: Lang | "auto" = work.lang ?? site.sourceLang;
    const wanted = new Set(keys);
    const units = toPackUnits(
      {
        contentKey: work.contentKey,
        size: work.natural,
        src: lead.submit.src,
        script: scriptForLang(lang),
        docOrder: lead.submit.pos.docOrder,
      },
      work.units.filter((unit) => wanted.has(unit.unitKey)),
    );
    const plan = batcher.plan(units, {
      boxBudget: boxBudgetNow(),
      urgentMax: workOnScreen(work) ? URGENT_PACK_MAX : null,
      layout: { profile: profileForModel(settings.current().api.model), dir: work.dir },
    });
    for (const unit of plan.skipped) deliverSynthetic(work, unit.unitKey, "ignored", false);
    for (const packUnits of plan.packs) {
      packSeq += 1;
      const task: QueueTask = {
        urgent: () => workOnScreen(work),
        rank: () => workRank(work),
        run: (lane) => runPack(entry, lane),
      };
      const entry: PackEntry = {
        id: `pk-${packSeq.toString(36)}`,
        work,
        units: packUnits,
        unitKeys: packUnits.map((unit) => unit.unitKey),
        frameKey: lead.frameKey,
        lang,
        docOrder: lead.submit.pos.docOrder,
        task,
        started: false,
      };
      entries.set(task, entry);
      work.packs.add(entry);
      queue.add(task);
    }
    parkBitmap(work);
    updateStates(work);
  }

  async function runPack(entry: PackEntry, lane: Lane): Promise<void> {
    const work = entry.work;
    entry.started = true;
    updateStates(work);
    const delivered = new Set<string>();
    let report: PackReport | null = null;
    let failure: ErrorInfo | null = null;
    const packLog = log.child({ batchId: entry.id });
    const scope = scopeOf(entry.frameKey);
    const positions = entry.units.map((unit) => unit.pos ?? 0);
    const firstPos = Math.min(...positions);
    try {
      const [decoded, context] = await Promise.all([
        ensureDecoded(work, true),
        scope === null
          ? Promise.resolve<PackMemory | null>(null)
          : memory.context(scope, { contentKey: work.contentKey, docOrder: entry.docOrder, pos: firstPos }),
      ]);
      startErase(work, decoded);
      report = await translator.translate(
        {
          packId: entry.id,
          frameKey: entry.frameKey,
          seriesKey: scope?.seriesKey ?? null,
          lang: context?.lang ?? entry.lang,
          dir: work.dir,
          units: entry.units,
          urgent: lane === "urgent" || workOnScreen(work),
          images: new Map([[work.contentKey, decoded]]),
          ...pageOf(entry.frameKey),
          ...(context === null ? {} : { memory: context }),
        },
        (result) => {
          try {
            onUnit(entry, result, delivered);
          } catch (error) {
            packLog.error("unit delivery failed", { error: String(error) });
          }
        },
      );
    } catch (error) {
      failure = toErrorInfo(error);
    }
    if (report !== null && report.error === null && report.totalMs > 0) {
      latency.observe(report.totalMs);
      for (const frameKey of frames.keys()) postHorizons(frameKey);
    }
    const learning = report?.learning;
    if (scope !== null && learning !== undefined) {
      void memory.learn(scope, { packId: entry.id, pos: Math.max(...positions), learning });
    }
    try {
      finishPack(entry, report, failure, delivered);
    } catch (error) {
      packLog.error("pack bookkeeping failed", { error: String(error) });
    }
  }

  function onUnit(entry: PackEntry, result: UnitResult, delivered: Set<string>): void {
    if (
      result.contentKey !== entry.work.contentKey ||
      !entry.unitKeys.includes(result.unitKey) ||
      delivered.has(result.unitKey)
    ) {
      log.debug("unexpected unit result ignored", { packId: entry.id, unitKey: result.unitKey });
      return;
    }
    delivered.add(result.unitKey);
    applyResult(entry.work, result, true);
  }

  /** Stores a final outcome and shows it everywhere the image is shown. */
  function applyResult(work: ContentWork, result: UnitResult, attempted: boolean): void {
    const slot = work.slots.get(result.unitKey);
    if (slot === undefined) return;
    slot.result = { ...result, translation: result.status === "ok" ? result.translation : "" };
    slot.status = result.status;
    slot.inPass = false;
    if (attempted) slot.attempts += 1;
    if (work.lang === null && result.lang !== null) work.lang = result.lang;
    putRecord(work, slot, "ai");
    postUnit(work, slot);
    updateStates(work);
  }

  function deliverSynthetic(
    work: ContentWork,
    unitKey: string,
    status: UnitOutcomeStatus,
    attempted: boolean,
  ): void {
    const prev = work.slots.get(unitKey)?.result ?? null;
    applyResult(
      work,
      {
        contentKey: work.contentKey,
        unitKey,
        status,
        type: status === "ignored" ? "ignore" : (prev?.type ?? "dialogue"),
        speaker: prev?.speaker ?? "",
        original: prev?.original ?? "",
        translation: "",
        lang: prev?.lang ?? work.lang,
        model: prev?.model ?? null,
      },
      attempted,
    );
  }

  /**
   * Record in the translation store's write protocol (store/translations.ts): an AI write (manual 0) never touches a
   * stored edit; a user write (manual 1) sets manualTranslation, or reverts to the AI text when manualTranslation is null.
   */
  function recordOf(work: ContentWork, slot: UnitSlot, writer: "ai" | "user"): TranslationRecord {
    const r = slot.result;
    const now = clock.now();
    const aiStatus: UnitStatus | null = slot.status === "pending" ? (r?.status ?? null) : slot.status;
    const user = writer === "user";
    return {
      contentKey: work.contentKey,
      unitKey: slot.geometry.unitKey,
      seriesKey: work.seriesKey,
      type: r?.type ?? "dialogue",
      speaker: r?.speaker ?? "",
      original: r?.original ?? "",
      translation: r?.status === "ok" ? r.translation : "",
      manualTranslation: user ? slot.manual : null,
      manual: user ? 1 : 0,
      status: user
        ? slot.manual !== null
          ? "manual"
          : (aiStatus ?? "manual")
        : (aiStatus ?? "untranslated"),
      lang: r?.lang ?? work.lang ?? "other",
      target: currentTarget(),
      model: r?.model ?? "",
      promptVersion: PROMPT_VERSION,
      attempts: slot.attempts,
      updatedAt: now,
      lastUsedAt: now,
    };
  }

  function putRecord(work: ContentWork, slot: UnitSlot, writer: "ai" | "user"): void {
    try {
      stores.translations.put(recordOf(work, slot, writer));
    } catch (error) {
      log.warn("translation write failed", { error: String(error) }, "store.io");
    }
  }

  function finishPack(
    entry: PackEntry,
    report: PackReport | null,
    failure: ErrorInfo | null,
    delivered: ReadonlySet<string>,
  ): void {
    const work = entry.work;
    entries.delete(entry.task);
    work.packs.delete(entry);
    const error = failure ?? report?.error ?? null;
    if (report?.lang != null) {
      work.lang = report.lang;
      if (work.record !== null && work.record.lang !== report.lang) {
        const record: ImageRecord = { ...work.record, lang: report.lang, lastUsedAt: clock.now() };
        work.record = record;
        persist("image write", () => stores.images.put(record));
      }
    }
    // The translator reports every unit once; anything it did not is closed here so no unit stays pending.
    for (const key of entry.unitKeys) {
      if (delivered.has(key)) continue;
      const status: UnitOutcomeStatus =
        error === null ? "untranslated" : error.code === "llm.refused" ? "refused" : "error";
      deliverSynthetic(work, key, status, true);
    }
    if (error === null) {
      stats.done += 1;
    } else {
      stats.failed += 1;
      work.error = error;
      if (error.code === "api.rate_limit") {
        queue.throttle(RATE_LIMIT_CONCURRENCY.value, RATE_LIMIT_CONCURRENCY.forMs);
      }
      if (error.code === "api.timeout") queue.throttle(TIMEOUT_CONCURRENCY.value, TIMEOUT_CONCURRENCY.forMs);
      log
        .child({ batchId: entry.id })
        .warn("pack failed", { reason: error.message, units: entry.unitKeys.length }, error.code);
    }
    // The API went away (unreachable, unauthorized) and the translator gave up: the failed units wait for health again,
    // within the automatic-pass budget (allowAutoPass, ≤ 2 per unit per 10 min).
    if (error !== null && ERRORS[error.code].retry === "health" && work.jobs.size > 0) {
      const now = clock.now();
      const again = entry.unitKeys.filter((key) => {
        const slot = work.slots.get(key);
        return (
          slot !== undefined &&
          slot.status === "error" &&
          slot.manual === null &&
          !slot.inPass &&
          allowAutoPass(slot.autoPasses, now)
        );
      });
      if (again.length > 0) {
        reopen(work, again, null);
        startPass(work, again, "auto");
      }
    }
    parkBitmap(work);
    maybeSettle(work);
  }

  /** Nothing outstanding: release the image and, once every unit has an outcome, send the final state + img:done. */
  function maybeSettle(work: ContentWork): void {
    if (work.phase !== "ready" || workActive(work) || work.decoding !== null) return;
    releaseImage(work);
    const open = [...work.slots.values()].some((slot) => displayStatus(slot) === "pending");
    if (open || work.settled) {
      updateStates(work);
      return;
    }
    work.settled = true;
    const gate = gateView();
    for (const job of work.jobs) {
      sendState(job, gate);
      postDone(job, work);
    }
    if (work.jobs.size > 0) {
      const counts = countStatuses(work);
      log.debug("image settled", {
        contentKey: work.contentKey.slice(0, 18),
        units: work.slots.size,
        ok: counts.ok ?? 0,
      });
    }
    works.trim(MAX_IDLE_WORKS);
  }

  /* ---------------------------------------------------------------- Pipeline API */

  function submit(frame: FrameSink, request: ImageSubmit): void {
    syncTarget();
    const frameKey = frame.info.frameKey;
    frames.set(frameKey, frame);
    const existing = jobs.get(frameKey, request.imageKey);
    if (existing !== undefined && !existing.stale && existing.submit.src === request.src) {
      // Idempotent: a resubmit (reconnect, BFCache restore) replays; a failed image starts over with the new submit.
      const force = request.force === true;
      const work = existing.work;
      if (existing.phase === "failed") {
        existing.submit = request;
        restartJob(existing, force);
      } else if (force && work !== null && work.phase === "ready" && !workActive(work)) {
        existing.submit = withoutBytes(request);
        const keys = retranslateKeys(work);
        reopen(work, keys, null);
        startPass(work, keys, "manual");
      } else {
        const promoted = existing.submit.prefetch === true && request.prefetch !== true;
        existing.submit = existing.phase === "queued" ? request : withoutBytes(request);
        replay(existing);
        if (promoted && work !== null) promote(work);
      }
      postHorizons(frameKey);
      queue.pump();
      return;
    }
    if (existing !== undefined) dropJob(existing);
    // A canvas src is a synthetic discovery key (page URL + "#ctv-canvas-…"): normalizing drops the fragment, so an
    // alias would map every canvas of the page (and every redraw) to the first canvas's content.
    const urlKey = request.element === "canvas" ? null : urlKeyFor(request.src);
    const job = jobs.create(frameKey, request.imageKey, request, urlKey);
    if (request.strip !== undefined) stripFrames.add(frameKey);
    sendState(job, gateView(), true);
    startJob(job, request.force === true);
    postHorizons(frameKey);
  }

  /** A prefetched image is wanted now (translate window, or loaded by the page): translate what was detected. */
  function promote(work: ContentWork): void {
    if (work.phase !== "ready" || workActive(work)) return;
    const now = clock.now();
    reopen(
      work,
      [...work.slots].filter(([, slot]) => autoCandidate(slot, now)).map(([key]) => key),
      null,
    );
    startPendingPass(work, "auto");
    maybeSettle(work);
  }

  function restartJob(job: ImageJob, force: boolean): void {
    job.gen += 1;
    job.cancelWait?.();
    job.cancelWait = null;
    const work = detachJob(job);
    if (work !== null && work.jobs.size === 0) abandonWork(work);
    job.phase = "queued";
    job.error = null;
    job.stale = false;
    job.submit = reacquireSubmit(job.submit);
    sendState(job);
    startJob(job, force);
  }

  function retry(frameKey: string, imageKey: string, unitKey?: string): void {
    const job = jobs.get(frameKey, imageKey);
    if (job === undefined) return;
    if (job.phase === "failed" || job.stale) {
      restartJob(job, false);
      return;
    }
    const work = job.work;
    if (work === null || work.phase !== "ready") return;
    const keys: string[] = [];
    for (const [key, slot] of work.slots) {
      if (slot.inPass || slot.manual !== null) continue;
      const failed = slot.status === "untranslated" || slot.status === "error";
      if (unitKey === undefined ? failed : key === unitKey && (failed || slot.status === "refused"))
        keys.push(key);
    }
    if (keys.length === 0) return;
    reopen(work, keys, null);
    startPass(work, keys, "manual");
  }

  function retranslate(scope: { tabId: number; contentKey?: string; unitKey?: string }): number {
    syncTarget();
    const targets = new Set<ContentWork>();
    for (const job of jobs.all()) {
      if (frameInfo(job)?.tabId !== scope.tabId) continue;
      if (scope.contentKey !== undefined && job.contentKey !== scope.contentKey) continue;
      if (job.phase === "failed" || job.stale) {
        if (scope.unitKey === undefined) restartJob(job, true);
        continue;
      }
      if (job.work !== null && job.work.phase === "ready") targets.add(job.work);
    }
    let queued = 0;
    for (const work of targets) {
      const keys = retranslateKeys(work, scope.unitKey);
      if (keys.length === 0) continue;
      reopen(work, keys, null);
      queued += startPass(work, keys, "manual");
    }
    return queued;
  }

  function workFor(contentKey: string): ContentWork | null {
    const live = liveWork(contentKey);
    if (live !== null) return live;
    for (const job of jobs.all())
      if (job.work !== null && job.work.contentKey === contentKey) return job.work;
    return null;
  }

  async function edit(
    target: { frameKey: string; imageKey: string } | { contentKey: string },
    unitKey: string,
    translation: string | null,
  ): Promise<void> {
    const contentKey =
      "contentKey" in target
        ? target.contentKey
        : (jobs.get(target.frameKey, target.imageKey)?.contentKey ?? null);
    if (contentKey === null) throw new CtvError("engine.internal", "no translated image to edit");
    const text = translation === null || translation.trim() === "" ? null : translation.trim();
    const work = workFor(contentKey);
    if (work !== null && work.phase === "ready") {
      const slot = work.slots.get(unitKey);
      if (slot === undefined) throw new CtvError("engine.internal", `unknown unit ${unitKey}`);
      slot.manual = text;
      putRecord(work, slot, "user");
      postUnit(work, slot);
      updateStates(work);
      await stores.translations.flush();
      return;
    }
    const [unitsRecord, records] = await Promise.all([
      stores.units.get(contentKey),
      stores.translations.forImage(contentKey),
    ]);
    const geometry = unitsRecord?.units.find((unit) => unit.unitKey === unitKey);
    if (geometry === undefined) throw new CtvError("engine.internal", `unknown unit ${unitKey}`);
    const offline = newWork(contentKey, clock.now());
    offline.seriesKey = records.find((record) => record.unitKey === unitKey)?.seriesKey ?? null;
    setUnits(
      offline,
      [geometry],
      records.filter((record) => record.unitKey === unitKey),
    );
    const slot = offline.slots.get(unitKey);
    if (slot === undefined) return;
    slot.manual = text;
    putRecord(offline, slot, "user");
    await stores.translations.flush();
  }

  function forget(frameKey: string, imageKeys: readonly string[]): void {
    for (const imageKey of imageKeys) {
      const job = jobs.get(frameKey, imageKey);
      if (job !== undefined) dropJob(job);
    }
    queue.pump();
  }

  function frameGone(frameKey: string): void {
    for (const job of jobs.ofFrame(frameKey)) dropJob(job);
    frames.delete(frameKey);
    horizonsSent.delete(frameKey);
    stripFrames.delete(frameKey);
    queue.pump();
  }

  function frameReplaced(frame: FrameSink): void {
    frames.set(frame.info.frameKey, frame);
    // A new port (a reloaded content script) starts from the default horizons.
    horizonsSent.delete(frame.info.frameKey);
    postHorizons(frame.info.frameKey);
    queue.pump();
  }

  function priority(frameKey: string, items: ReadonlyArray<{ imageKey: string; priority: number }>): void {
    for (const item of items) {
      const job = jobs.get(frameKey, item.imageKey);
      if (job !== undefined) job.submit = { ...job.submit, priority: item.priority };
    }
    postHorizons(frameKey);
    queue.pump();
  }

  function queueStatus(): EngineStatus["queue"] {
    const snap = queue.snapshot();
    const gate = gateState();
    const blocked = gate.open ? 0 : snap.queued + (gate.code === "privacy.consent" ? 0 : snap.running);
    return {
      queued: snap.queued,
      inFlight: snap.running,
      urgentInFlight: snap.urgentRunning,
      done: stats.done,
      failed: stats.failed,
      pausedBy: !gate.open && blocked > 0 ? gate.code : null,
      concurrency: snap.concurrency,
      boxBudget: boxBudgetNow(),
    };
  }

  /** The language translations are written in now: the setting, else the UI or browser language (as prompts use). */
  function currentTarget(): string {
    return promptTarget(settings.current()).code;
  }

  /** Which engine translates now (shared/offline/routing.ts translationSource of the records it writes). */
  function currentSourceKey(): string {
    const translate = settings.current().translate;
    return currentSource(translate.engine, translate.offlineModel);
  }

  let lastTarget: string | null = null;

  /**
   * A changed target language or engine makes the translations held in memory outdated: idle works are dropped
   * (their stored AI records are skipped on reload, see loadWork) and their images marked stale, so the next request
   * translates them again. Works in flight finish in the language and with the engine they started with.
   */
  function syncTarget(): void {
    const target = `${currentTarget()}|${currentSourceKey()}`;
    if (lastTarget === null || target === lastTarget) {
      lastTarget = target;
      return;
    }
    lastTarget = target;
    const dropped = works.clear(
      (work) => work.phase === "ready" && !workActive(work) && work.decoding === null,
    );
    for (const work of dropped) for (const job of work.jobs) job.stale = true;
    log.info("target language changed", { target, dropped: dropped.length });
  }

  function cacheCleared(): void {
    urlMemo.clear();
    bytes.clear();
    memory.cacheCleared();
    const dropped = works.clear(
      (work) => work.phase === "ready" && !workActive(work) && work.decoding === null,
    );
    for (const work of dropped) for (const job of work.jobs) job.stale = true;
  }

  return {
    submit,
    priority,
    forget,
    retry,
    retranslate,
    edit,
    frameGone,
    frameReplaced,
    queueStatus,
    idle: () => queue.idle() && flows === 0,
    cacheCleared,
    throttle: (value, forMs) => queue.throttle(value, forMs),
  };
}
