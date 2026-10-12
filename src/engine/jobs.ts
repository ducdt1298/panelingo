// Per-image jobs and the work they share. An ImageJob is one image of one frame, keyed by (frameKey, imageKey). A
// ContentWork holds what is keyed by contentKey (geometry, unit outcomes, the decoded image, unfinished packs) and is
// shared by every job showing the same bytes, so a second frame or tab attaches to the running work and receives the
// same results. Plain state and pure views; pipeline.ts runs the async steps.

import { ERRORS, type ErrorCode, type ErrorInfo } from "../shared/errors.ts";
import { clip, height, inflate, width } from "../shared/geometry.ts";
import type { ImageSubmit } from "../shared/protocol.ts";
import type { ImageRecord, TranslationRecord } from "../shared/records.ts";
import type {
  Box,
  Codec,
  ImageState,
  Lang,
  ReadingDir,
  Script,
  Size,
  UnitGeometry,
  UnitRender,
  UnitStatus,
} from "../shared/types.ts";
import { scriptForLang } from "../shared/core/model-profile.ts";
import { scriptStats } from "../shared/core/refusal.ts";
import { encodeBytes } from "../shared/wire.ts";
import type { AcquiredImage, DecodedImage, EraseOutput, UnitOutcomeStatus, UnitResult } from "./contracts.ts";

/* ------------------------------------------------------------------ units */

export interface UnitSlot {
  readonly geometry: UnitGeometry;
  /** AI outcome of the latest pass, or "pending" until it arrives. */
  status: "pending" | UnitOutcomeStatus;
  /** Latest AI result (from the translator or the store). */
  result: UnitResult | null;
  /** manualTranslation: shown instead of the AI text; manual edits always win. */
  manual: string | null;
  /** Owned by a pass that has not delivered it yet (preparing, queued or in flight). */
  inPass: boolean;
  /** Times the unit was sent (TranslationRecord.attempts). */
  attempts: number;
  /** Times of automatic passes, for retry-policy allowAutoPass (≤ 2 per unit per 10 min). */
  autoPasses: number[];
  /** Erase patch and measured glyph size, from the eraser or the patch store. */
  erase: EraseOutput | null;
  /** The eraser is already working on this unit. */
  eraseStarted: boolean;
}

export function newSlot(geometry: UnitGeometry): UnitSlot {
  return {
    geometry,
    status: "pending",
    result: null,
    manual: null,
    inPass: false,
    attempts: 0,
    autoPasses: [],
    erase: null,
    eraseStarted: false,
  };
}

/** What the frame shows for the unit. */
export function displayStatus(slot: UnitSlot): UnitStatus {
  return slot.manual !== null ? "manual" : slot.status;
}

/** Still waiting for a translation and not owned by any pass. */
export function needsPass(slot: UnitSlot): boolean {
  return displayStatus(slot) === "pending" && !slot.inPass;
}

function aiStatusOf(record: TranslationRecord): UnitOutcomeStatus | null {
  switch (record.status) {
    case "ok":
    case "keep-original":
    case "untranslated":
    case "refused":
    case "ignored":
    case "error":
      return record.status;
    case "manual":
      // The record keeps the AI text in `translation`; an empty one means the unit was edited before any translation.
      return record.translation !== "" ? "ok" : null;
    case "pending":
    case "translating":
    case "stale":
      return null;
  }
}

/** Slot for a stored unit; units without a usable record stay pending. */
export function slotFromRecord(
  contentKey: string,
  geometry: UnitGeometry,
  record: TranslationRecord | undefined,
): UnitSlot {
  const slot = newSlot(geometry);
  if (record === undefined) return slot;
  slot.attempts = record.attempts;
  slot.manual =
    record.manualTranslation !== null && record.manualTranslation.trim() !== ""
      ? record.manualTranslation
      : null;
  const status = aiStatusOf(record);
  if (status !== null) {
    slot.status = status;
    slot.result = {
      contentKey,
      unitKey: geometry.unitKey,
      status,
      type: record.type,
      speaker: record.speaker,
      original: record.original,
      translation: status === "ok" ? record.translation : "",
      lang: record.lang,
      model: record.model === "" ? null : record.model,
    };
    // The stored attempt counts as an automatic pass at its time (conservative after an engine restart).
    if (status === "untranslated" || status === "error") slot.autoPasses = [record.updatedAt];
  }
  return slot;
}

/** Plain copy with only the wire fields (detector objects may carry engine-only extras such as score). */
export function cleanGeometry(unit: UnitGeometry): UnitGeometry {
  const copy = (b: Box): Box => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
  const g: UnitGeometry = {
    unitKey: unit.unitKey,
    kind: unit.kind,
    bubble: unit.bubble === null ? null : copy(unit.bubble),
    text: copy(unit.text),
    texts: unit.texts.map(copy),
    orientation: unit.orientation,
    glyphPx: unit.glyphPx,
    order: unit.order,
  };
  if (unit.edgeSmall === true) g.edgeSmall = true;
  if (unit.seam !== undefined) g.seam = { seamId: unit.seam.seamId, part: unit.seam.part };
  return g;
}

/** Text in a bubble whose outline was missed is fitted in the text box grown by 15% of its short side. */
export const ORPHAN_BUBBLE_INFLATE = 0.15;
/** Free text is fitted in the text box grown by 10% of its short side. */
export const FREE_TEXT_INFLATE = 0.1;

/** Region the content script fits the translation into (natural px, clipped to the image). */
export function fitRegion(geometry: UnitGeometry, natural: Size | null): Box {
  if (geometry.bubble !== null) return { ...geometry.bubble };
  const ratio = geometry.kind === "bubble" ? ORPHAN_BUBBLE_INFLATE : FREE_TEXT_INFLATE;
  const grow = Math.max(2, Math.round(ratio * Math.min(width(geometry.text), height(geometry.text))));
  const region = inflate(geometry.text, grow);
  return natural === null ? region : clip(region, natural);
}

/** Script of the original lettering: from its recognised text, else the image language. */
export function scriptOf(original: string, lang: Lang | null): Script {
  const stats = scriptStats(original);
  if (stats.letters > 0) {
    if (stats.cjk >= stats.latin) return /[ᄀ-ᇿ㄰-㆏가-힯]/u.test(original) ? "hangul" : "cjk";
    return "latin";
  }
  return scriptForLang(lang);
}

/**
 * UnitRender for a slot. Only ok and manual carry text. With an erase patch the overlay draws the patch (original
 * glyphs painted over, balloon outline kept) and the text; a "box" result gets a plate over the text area only.
 */
export function unitRender(
  slot: UnitSlot,
  natural: Size | null,
  codec: Codec = "sc",
  lang: Lang | null = null,
): UnitRender {
  const g = slot.geometry;
  const status = displayStatus(slot);
  const r = slot.result;
  const vi = status === "manual" ? (slot.manual ?? "") : status === "ok" ? (r?.translation ?? "") : "";
  const erase = slot.erase;
  const painted = status === "ok" || status === "manual";
  const render: UnitRender = {
    unitKey: g.unitKey,
    type: r?.type ?? "dialogue",
    speaker: r?.speaker ?? "",
    original: r?.original ?? "",
    translation: vi,
    status,
    fit: {
      region: erase?.interior ?? fitRegion(g, natural),
      shape: g.kind === "bubble" && erase?.rectLike !== true ? "ellipse" : "rect",
      orientation: g.orientation,
      glyphPx: erase?.glyphPx ?? g.glyphPx,
      script: scriptOf(r?.original ?? "", r?.lang ?? lang),
    },
    erase:
      erase === null
        ? {
            kind: "box",
            rect: { x1: g.text.x1, y1: g.text.y1, x2: g.text.x2, y2: g.text.y2 },
            bg: null,
            textColor: [0, 0, 0],
          }
        : {
            kind: erase.kind,
            rect: { ...erase.rect },
            bg: erase.bg,
            textColor: erase.textColor,
            ...(erase.png === null || !painted ? {} : { png: encodeBytes(erase.png, codec) }),
          },
  };
  if (g.seam !== undefined) render.seam = { seamId: g.seam.seamId, part: g.seam.part };
  return render;
}

/* ------------------------------------------------------------------ work (per contentKey) */

/** A pack of one work that has not finished yet. */
export interface WorkPack {
  readonly unitKeys: readonly string[];
  /** Handed to the translator (in flight). */
  started: boolean;
}

export interface ContentWork {
  readonly contentKey: string;
  /** prep: decoding or detecting; ready: units known. A failed work is dropped from the table. */
  phase: "prep" | "ready";
  /** Decoded (natural) size; null until decoded or loaded. */
  natural: Size | null;
  /** In reading order. */
  units: UnitGeometry[];
  readonly slots: Map<string, UnitSlot>;
  lang: Lang | null;
  /** Reading direction used for detection and composites; decided once (dirSet), for stored works at first use. */
  dir: ReadingDir;
  dirSet: boolean;
  readonly jobs: Set<ImageJob>;
  /** Encoded bytes while a decode may still be needed. */
  source: AcquiredImage | null;
  decoded: DecodedImage | null;
  decoding: Promise<DecodedImage> | null;
  /** Packs not finished (queued or in flight). */
  readonly packs: Set<WorkPack>;
  /** Passes still waiting for the decoded image before their packs exist. */
  preparing: number;
  /** img:done went out for the latest pass. */
  settled: boolean;
  /** Last pack or pass failure; cleared when a pass starts. */
  error: ErrorInfo | null;
  record: ImageRecord | null;
  /** Series of the page that last showed the image (src/shared/series-key.ts); stamped on its stored records. */
  seriesKey: string | null;
  lastUsedAt: number;
}

export function newWork(contentKey: string, now: number): ContentWork {
  return {
    contentKey,
    phase: "prep",
    natural: null,
    units: [],
    slots: new Map(),
    lang: null,
    dir: "ltr",
    dirSet: false,
    jobs: new Set(),
    source: null,
    decoded: null,
    decoding: null,
    packs: new Set(),
    preparing: 0,
    settled: false,
    error: null,
    record: null,
    seriesKey: null,
    lastUsedAt: now,
  };
}

/** Sets the geometry (reading order; a repeated unitKey keeps its first unit); records resolve stored units. */
export function setUnits(
  work: ContentWork,
  units: readonly UnitGeometry[],
  records: readonly TranslationRecord[] = [],
): void {
  const byKey = new Map(records.map((r) => [r.unitKey, r]));
  work.units = [];
  work.slots.clear();
  for (const unit of [...units].map(cleanGeometry).sort((a, b) => a.order - b.order)) {
    if (work.slots.has(unit.unitKey)) continue;
    work.units.push(unit);
    work.slots.set(unit.unitKey, slotFromRecord(work.contentKey, unit, byKey.get(unit.unitKey)));
  }
  work.phase = "ready";
}

/** Something is outstanding: a pass preparing, or packs queued or in flight. */
export function workActive(work: ContentWork): boolean {
  return work.packs.size > 0 || work.preparing > 0;
}

export function progressOf(work: ContentWork): { done: number; total: number } {
  let done = 0;
  for (const slot of work.slots.values()) if (displayStatus(slot) !== "pending") done += 1;
  return { done, total: work.slots.size };
}

export function countStatuses(work: ContentWork): Partial<Record<UnitStatus, number>> {
  const counts: Partial<Record<UnitStatus, number>> = {};
  for (const slot of work.slots.values()) {
    const status = displayStatus(slot);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Image state once nothing is outstanding: done when every unit is translated, kept or ignored; refused or
 * error when nothing was translated and every unresolved unit was refused, or failed; partial otherwise.
 */
export function terminalState(counts: Partial<Record<UnitStatus, number>>, total: number): ImageState {
  if (total === 0) return "no-text";
  const n = (status: UnitStatus): number => counts[status] ?? 0;
  const good = n("ok") + n("manual");
  if (good + n("keep-original") + n("ignored") >= total) return "done";
  if (good === 0 && n("pending") === 0 && n("untranslated") === 0) {
    if (n("error") === 0 && n("refused") > 0) return "refused";
    if (n("refused") === 0 && n("error") > 0) return "error";
  }
  return "partial";
}

export function errorInfo(code: ErrorCode, message: string): ErrorInfo {
  return { code, message, retryable: ERRORS[code].retry !== "never" };
}

/** ErrorInfo that explains a terminal state on the badge; null for done and no-text. */
export function terminalError(
  state: ImageState,
  counts: Partial<Record<UnitStatus, number>>,
  last: ErrorInfo | null,
): ErrorInfo | null {
  const missing = errorInfo("llm.missing", "some units have no valid translation");
  if (state === "error") return last ?? missing;
  if (state === "refused") return errorInfo("llm.refused", "the model refused to translate");
  if (state !== "partial") return null;
  if ((counts.untranslated ?? 0) > 0 || (counts.pending ?? 0) > 0) return missing;
  if ((counts.error ?? 0) > 0) return last ?? missing;
  return errorInfo("llm.refused", "the model refused some units");
}

/* ------------------------------------------------------------------ jobs (per frame image) */

export type JobPhase = "queued" | "acquiring" | "attached" | "failed";

export interface ImageJob {
  readonly frameKey: string;
  readonly imageKey: string;
  /** Creation order: the last tie-break between equal priorities. */
  readonly seq: number;
  /** Latest submit; the image bytes are dropped once acquired. */
  submit: ImageSubmit;
  /** "u:" + normalized src, or null (data:, blob:, unparsable). */
  readonly urlKey: string | null;
  phase: JobPhase;
  work: ContentWork | null;
  /** Kept after detaching so edits can still find the image. */
  contentKey: string | null;
  error: ErrorInfo | null;
  /** Bumped on restart and drop: async steps started under an older value stop. */
  gen: number;
  dropped: boolean;
  /** cacheCleared() ran: the next submit runs the whole flow instead of replaying. */
  stale: boolean;
  /** Cancels a pending preparation-slot request. */
  cancelWait: (() => void) | null;
  /** Signature of the last img:state sent, to skip duplicates. */
  sent: string | null;
}

export function attachJob(job: ImageJob, work: ContentWork): void {
  if (job.work !== null && job.work !== work) detachJob(job);
  job.work = work;
  job.contentKey = work.contentKey;
  job.phase = "attached";
  job.error = null;
  work.jobs.add(job);
}

/** Leaves the work; returns it so the caller can tell whether anyone still shows the image. */
export function detachJob(job: ImageJob): ContentWork | null {
  const work = job.work;
  if (work === null) return null;
  work.jobs.delete(job);
  job.work = null;
  return work;
}

export interface GateView {
  /** Privacy notice not confirmed: nothing may be uploaded. */
  privacy: ErrorInfo | null;
  /** API not sendable, with a code to show (readiness "unknown" has none). */
  health: ErrorInfo | null;
}

export interface ImageView {
  state: ImageState;
  progress?: { done: number; total: number };
  error?: ErrorInfo;
}

/** What img:state should say for a job now. */
export function viewOf(job: ImageJob, gate: GateView): ImageView {
  switch (job.phase) {
    case "queued":
      return { state: "queued" };
    case "acquiring":
      return { state: "acquiring" };
    case "failed":
      return { state: "error", error: job.error ?? errorInfo("engine.internal", "image failed") };
    case "attached":
      break;
  }
  const work = job.work;
  if (work === null) return { state: "queued" };
  if (work.phase === "prep") return { state: "detecting" };
  const progress = progressOf(work);
  if (progress.total === 0) return { state: "no-text", progress };
  if (workActive(work)) {
    const sending = [...work.packs].some((pack) => pack.started);
    if (gate.privacy !== null && !sending) return { state: "paused", progress, error: gate.privacy };
    if (gate.health !== null) return { state: "paused", progress, error: gate.health };
    return { state: sending ? "translating" : "waiting", progress };
  }
  if (progress.done < progress.total) return { state: "waiting", progress };
  const counts = countStatuses(work);
  const state = terminalState(counts, progress.total);
  const error = terminalError(state, counts, work.error);
  return error === null ? { state, progress } : { state, progress, error };
}

export function viewSignature(view: ImageView): string {
  return [
    view.state,
    view.progress?.done ?? "",
    view.progress?.total ?? "",
    view.error?.code ?? "",
    view.error?.message ?? "",
  ].join("|");
}

/* ------------------------------------------------------------------ tables */

export interface JobTable {
  get(frameKey: string, imageKey: string): ImageJob | undefined;
  create(frameKey: string, imageKey: string, submit: ImageSubmit, urlKey: string | null): ImageJob;
  remove(job: ImageJob): void;
  ofFrame(frameKey: string): ImageJob[];
  all(): ImageJob[];
  readonly size: number;
}

export function createJobTable(): JobTable {
  const byKey = new Map<string, ImageJob>();
  const keyOf = (frameKey: string, imageKey: string): string => `${frameKey}\n${imageKey}`;
  let seq = 0;
  return {
    get: (frameKey, imageKey) => byKey.get(keyOf(frameKey, imageKey)),
    create(frameKey, imageKey, submit, urlKey) {
      seq += 1;
      const job: ImageJob = {
        frameKey,
        imageKey,
        seq,
        submit,
        urlKey,
        phase: "queued",
        work: null,
        contentKey: null,
        error: null,
        gen: 0,
        dropped: false,
        stale: false,
        cancelWait: null,
        sent: null,
      };
      byKey.set(keyOf(frameKey, imageKey), job);
      return job;
    },
    remove(job) {
      const key = keyOf(job.frameKey, job.imageKey);
      if (byKey.get(key) === job) byKey.delete(key);
    },
    ofFrame: (frameKey) => [...byKey.values()].filter((job) => job.frameKey === frameKey),
    all: () => [...byKey.values()],
    get size() {
      return byKey.size;
    },
  };
}

export interface WorkTable {
  get(contentKey: string): ContentWork | undefined;
  add(work: ContentWork): void;
  delete(contentKey: string): void;
  values(): ContentWork[];
  /** Forgets idle works (no job, nothing outstanding), least recently used first, until at most `keep` remain. */
  trim(keep: number): number;
  clear(match: (work: ContentWork) => boolean): ContentWork[];
  readonly size: number;
}

export function createWorkTable(): WorkTable {
  const byKey = new Map<string, ContentWork>();
  return {
    get: (contentKey) => byKey.get(contentKey),
    add(work) {
      byKey.set(work.contentKey, work);
    },
    delete(contentKey) {
      byKey.delete(contentKey);
    },
    values: () => [...byKey.values()],
    trim(keep) {
      if (byKey.size <= keep) return 0;
      const idle = [...byKey.values()]
        .filter(
          (work) =>
            work.phase === "ready" && work.jobs.size === 0 && !workActive(work) && work.decoding === null,
        )
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      let removed = 0;
      for (const work of idle) {
        if (byKey.size <= keep) break;
        byKey.delete(work.contentKey);
        removed += 1;
      }
      return removed;
    },
    clear(match) {
      const removed: ContentWork[] = [];
      for (const work of [...byKey.values()]) {
        if (!match(work)) continue;
        byKey.delete(work.contentKey);
        removed.push(work);
      }
      return removed;
    },
    get size() {
      return byKey.size;
    },
  };
}
