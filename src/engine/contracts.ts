// Engine-internal service boundaries (see docs/ARCHITECTURE.md for the engine's place in the extension).
// TYPES ONLY. Each service lives in its own module and exports the create*() factory named in ServiceFactories;
// runtime.ts (the composition root) wires the real factories and tests inject fakes. Services depend on each
// other only through these interfaces, never through each other's implementation modules.
//
// Factory → module: openStores store/db.ts · createSettingsCache settings-cache.ts · createHealth health-monitor.ts ·
// createAcquirer acquire.ts · createDecoder decode.ts · createGfx = createChromeGfx pixels.ts · createDetector
// detector.ts · createComposite composite.ts · createUploads uploads.ts · createTranslator translator.ts ·
// createPipeline pipeline.ts (which creates the series memory, memory.ts createSeriesMemory, unless one is injected) ·
// createOfflineTranslator offline/translator.ts (offline mode; runtime.ts routes packs to it or to createTranslator's).
// runtime.ts exports startRuntime(gate, factories); createSettingsCache is called by runtime.ts itself (it is not a
// ServiceFactories member). Factories may accept optional test injectables on top of the deps listed here (e.g.
// AcquirerOverrides {fetch, callSw}, DecoderOverrides {createImageBitmap, digest}).
//
// Error convention: services throw or reject CtvError (src/shared/errors.ts). The pipeline turns failures into
// img:state with ErrorInfo; nothing is silently dropped. No service ever aborts an in-flight API request (providers
// keep generating, and billing, after a client abort; only api-client's watchdogs abort); late results are still
// cached.

import type { CtvDatabase } from "../platform/db-schema.ts";
import type { Logger } from "../platform/log.ts";
import type { Clock } from "../shared/clock.ts";
import type { CompositeFailReason } from "../shared/core/composite-layout.ts";
import type { HealthReading } from "../shared/core/health.ts";
import type { Address, Term } from "../shared/core/id-accounting.ts";
import type { ModelProfile } from "../shared/core/model-profile.ts";
import type {
  HistoryLine,
  GlossaryEntry as PromptGlossaryEntry,
  StyleProfile,
} from "../shared/core/prompt.ts";
import type { CtvError, ErrorInfo } from "../shared/errors.ts";
import type { Gfx } from "../shared/gfx.ts";
import type { EngineToCs, EngineToUi, ImageSubmit, PageHints, ViewportInfo } from "../shared/protocol.ts";
import type {
  ImageRecord,
  KvKey,
  KvMap,
  ChapterRecord,
  GlossaryEntry,
  ModelIntegrityRecord,
  PageRecord,
  PatchRecord,
  SeriesRecord,
  SliceRecord,
  TranslationRecord,
  UnitsRecord,
} from "../shared/records.ts";
import type { OfflineFile } from "../shared/offline/catalog.ts";
import type { Settings, SiteSettings } from "../shared/settings.ts";
import type {
  Codec,
  Detection,
  EngineStatus,
  ImageState,
  Lang,
  LineType,
  LogEntry,
  OfflineStatus,
  PronounRule,
  ReadingDir,
  RGB,
  Box,
  Script,
  Size,
  UnitGeometry,
  UnitStatus,
} from "../shared/types.ts";

/* ------------------------------------------------------------------ time */

/** Injected time source (src/shared/clock.ts; production: systemClock); tests drive a manual clock. */
export type { Clock };

/* ------------------------------------------------------------------ settings (settings-cache.ts) */

export interface SettingsSource {
  current(): Settings;
  /** Site settings by siteKey (= origin); migrateSite(undefined) defaults when unknown. */
  site(siteKey: string): SiteSettings;
  sites(): Readonly<Record<string, SiteSettings>>;
  /** Applies en:settings / sw:get-settings and mirrors to kv "settings.mirror". */
  apply(settings: Settings, sites: Record<string, SiteSettings>): void;
  onChange(listener: (settings: Settings) => void): () => void;
}

/* ------------------------------------------------------------------ frames (ports.ts) */

/** One content-script frame on Port "engine". frameKey = `${tabId}:${frameId}:${documentId}`. */
export interface FrameInfo {
  readonly frameKey: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
  /** From port.sender.url; cs:page updates it for same-origin SPA navigations. */
  url: string;
  readonly origin: string;
  /** = origin. */
  readonly siteKey: string;
  mode: "auto" | "manual";
  codec: Codec;
  page: PageHints;
  viewport: ViewportInfo | null;
  /** Bumped when the frame reports visible; ties go to the most recently focused tab. */
  focusSeq: number;
}

/** How the pipeline talks to a frame. post() never throws and returns false when the frame is gone. */
export interface FrameSink {
  readonly info: FrameInfo;
  readonly connected: boolean;
  post(message: EngineToCs): boolean;
}

/** How the engine pushes to UI ports (popup, side panel). */
export interface UiBroadcast {
  post(message: EngineToUi, tabId?: number | null): void;
}

/* ------------------------------------------------------------------ stores (store/*.ts) */

export interface ImageStore {
  get(contentKey: string): Promise<ImageRecord | undefined>;
  put(record: ImageRecord): Promise<void>;
  touch(contentKey: string, at: number): Promise<void>;
  /** urlKey ("u:" + normalized URL) → contentKey. */
  alias(urlKey: string): Promise<string | undefined>;
  putAlias(urlKey: string, contentKey: string, at: number): Promise<void>;
}

export interface UnitStore {
  get(contentKey: string): Promise<UnitsRecord | undefined>;
  put(record: UnitsRecord): Promise<void>;
}

export interface TranslationStore {
  /** Every stored unit of one image, manual edits included. */
  forImage(contentKey: string): Promise<TranslationRecord[]>;
  /**
   * Queued write, flushed every 2 s; readers see queued writes. Write protocol:
   * - manual = 0 is an AI write: it refreshes the AI fields and keeps any stored manual edit (manualTranslation) on top;
   * - manual = 1 with manualTranslation = the text is a user edit;
   * - manual = 1 with manualTranslation = null reverts to the AI text (stored as manual = 0).
   */
  put(record: TranslationRecord): void;
  /** Writes everything queued; called before close and by tests. */
  flush(): Promise<void>;
}

export interface KvStore {
  get<K extends KvKey>(key: K): Promise<KvMap[K] | undefined>;
  set<K extends KvKey>(key: K, value: KvMap[K]): Promise<void>;
}

export interface LogStore {
  /** Ring buffer (settings.debug.logCapacity), batched every 1 s or 50 entries. */
  append(entry: LogEntry): void;
  flush(): Promise<void>;
  recent(limit: number): Promise<LogEntry[]>;
}

export interface PatchStore {
  /** Erase patches of one image; kept by LRU within settings.cache.patchCacheMb. */
  forImage(contentKey: string): Promise<PatchRecord[]>;
  put(record: PatchRecord): Promise<void>;
}

export interface ModelStore {
  get(file: string): Promise<ModelIntegrityRecord | undefined>;
  put(record: ModelIntegrityRecord): Promise<void>;
}

/* Series memory stores (series, glossary, chapters, pages). Optional, so test doubles can leave them out; without
   them the engine translates without series memory. Each update() is one read-modify-write transaction: the change
   function is synchronous and gets the stored record (or undefined); a throw aborts the whole transaction. */

export interface SeriesStore {
  get(seriesKey: string): Promise<SeriesRecord | undefined>;
  put(record: SeriesRecord): Promise<void>;
  all(): Promise<SeriesRecord[]>;
  /** change returns the record to store, or undefined to leave it; resolves to the stored record afterwards. */
  update(
    seriesKey: string,
    change: (existing: SeriesRecord | undefined) => SeriesRecord | undefined,
  ): Promise<SeriesRecord | undefined>;
}

export interface GlossaryStore {
  forSeries(seriesKey: string): Promise<GlossaryEntry[]>;
  put(entry: GlossaryEntry): Promise<void>;
  delete(seriesKey: string, orig: string): Promise<void>;
  /**
   * Entries of one series in one transaction: change(orig, stored) returns the entry to store (under the same orig),
   * null to delete it, or undefined to leave it. Resolves to the number of entries written or deleted.
   */
  update(
    seriesKey: string,
    origs: readonly string[],
    change: (orig: string, existing: GlossaryEntry | undefined) => GlossaryEntry | null | undefined,
  ): Promise<number>;
}

export interface ChapterStore {
  get(chapterKey: string): Promise<ChapterRecord | undefined>;
  put(record: ChapterRecord): Promise<void>;
  /** change returns the record to store, or undefined to leave it; resolves to the stored record afterwards. */
  update(
    chapterKey: string,
    change: (existing: ChapterRecord | undefined) => ChapterRecord | undefined,
  ): Promise<ChapterRecord | undefined>;
}

export interface PageStore {
  /** Pages of a chapter in page order. */
  forChapter(chapterKey: string): Promise<PageRecord[]>;
  put(record: PageRecord): Promise<void>;
}

export interface EngineStores {
  readonly db: CtvDatabase;
  readonly images: ImageStore;
  readonly units: UnitStore;
  readonly translations: TranslationStore;
  readonly kv: KvStore;
  readonly logs: LogStore;
  readonly models: ModelStore;
  readonly patches: PatchStore;
  readonly series?: SeriesStore;
  readonly glossary?: GlossaryStore;
  readonly chapters?: ChapterStore;
  readonly pages?: PageStore;
  /** Flushes queued writes and closes the connection. */
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ API health (health-monitor.ts) */

export interface ApiHealth {
  reading(): HealthReading;
  /** core/health isSendable(reading().readiness). */
  sendable(): boolean;
  /** Resolves once sendable (never rejects). The queue waits on it while paused. */
  whenSendable(): Promise<void>;
  /**
   * A classified request/fetch failure: pauses and switches the polling cadence. For pause-class codes
   * (api.unreachable, api.lna_blocked, api.unauthorized, api.config) sendable() is false as soon as report()
   * returns, so a caller that then awaits whenSendable() really waits.
   */
  report(error: ErrorInfo): void;
  /** Epoch ms of the last completed /models check (0 = never): EngineStatus.api.checkedAt. */
  checkedAt(): number;
  /** Work exists (poll on the busy cadence) or not (stop polling after 2 min idle). */
  setBusy(busy: boolean): void;
  refresh(): Promise<HealthReading>;
  onChange(listener: (reading: HealthReading) => void): () => void;
  stop(): void;
}

/* ------------------------------------------------------------------ acquisition (acquire.ts, decode.ts) */

export interface AcquiredImage {
  bytes: ArrayBuffer;
  /** Sniffed from magic bytes, never trusted from headers alone. */
  mime: string;
  source: ImageRecord["source"];
  /** Screen-resolution bytes from a screen capture (ladder step 3). */
  lowRes: boolean;
  /** Final URL after redirects; null for bytes from the content script or a capture. */
  url: string | null;
}

export interface AcquireContext {
  frame: FrameInfo;
  site: SiteSettings;
  settings: Settings;
}

/** Ladder step 3, the screen-capture fallback (capture.ts createCaptureAssist). */
export interface CaptureStep {
  /** Why a capture may not run now (image.capture_blocked / image.capture_unavailable), or null. */
  refusal(submit: ImageSubmit, ctx: AcquireContext): CtvError | null;
  /** The image as the reader sees it, cropped from screen captures: PNG bytes, source "capture", lowRes. */
  capture(submit: ImageSubmit, ctx: AcquireContext): Promise<AcquiredImage>;
}

export interface ImageAcquirer {
  /**
   * Ladder step 1 (bytes sent by the content script), step 2 (engine fetch: url-guard, sw:dnr-ensure Referer
   * rule, credentials policy, content-type and size caps, 30 s timeout, ≤ 2 concurrent per host) and step 3 (a
   * screen capture through the injected CaptureStep, for canvases and for images whose URLs all failed). Throws
   * CtvError image.url_blocked | image.http | image.not_image | image.too_large | dnr.failed |
   * image.capture_blocked | image.capture_unavailable (canvas or acquire "capture" submits without a capture step:
   * their src is synthetic and never fetched).
   * image.http carries status, retryable, detail ("network" | "timeout" without a status) and retryAfterMs (429, 503).
   */
  acquire(submit: ImageSubmit, ctx: AcquireContext): Promise<AcquiredImage>;
}

export interface DecodedImage {
  readonly contentKey: string;
  readonly size: Size;
  readonly bitmap: ImageBitmap;
  /** Closes the bitmap; idempotent. Release as soon as the image is no longer needed (memory caps). */
  release(): void;
}

export interface DecodeLimits {
  maxImageBytes: number;
  maxImagePixels: number;
}

export interface ImageDecoder {
  /** "s:" + lowercase sha256 hex of the bytes. */
  contentKeyOf(bytes: ArrayBuffer): Promise<string>;
  /** createImageBitmap with the byte/pixel guards. Throws image.too_large | image.decode. */
  decode(image: AcquiredImage, contentKey: string, limits: DecodeLimits): Promise<DecodedImage>;
}

/* ------------------------------------------------------------------ detection (detector.ts, tiling.ts, model-files.ts) */

export interface DetectOptions {
  scoreMin: number;
  slice: {
    triggerRatio: number;
    heightRatio: number;
    overlap: number;
    overlapMinPx: number;
    quietRows: boolean;
  };
  dir: ReadingDir;
}

export interface DetectionResult {
  backend: "webgpu" | "wasm";
  /** UnitsRecord.detectorVersion: geometry-affecting parameters only, so other changes keep cached geometry valid. */
  detectorVersion: string;
  slices: SliceRecord[];
  /** Every box with score ≥ 0.15, natural px of the whole image. */
  rawDetections: Detection[];
  /** Units built with scoreMin, in reading order (order === index). */
  units: UnitGeometry[];
  timings: { inferMs: number[]; totalMs: number };
}

export interface TextDetector {
  state(): EngineStatus["detector"];
  /**
   * One model run at a time (mutex around create and run). Lazily imports ORT, loads the model (byte and sha256
   * integrity), creates the WebGPU session with WASM-int8 fallback and runs the canary once per decision key.
   */
  detect(image: DecodedImage, options: DetectOptions): Promise<DetectionResult>;
  /**
   * Rebuilds units from stored raw detections (e.g. scoreMin changed) without running the model. Pass the stored
   * UnitsRecord.slices: with quietRows the slice plan depends on pixels and cannot be recomputed; without them the
   * even slice plan of options.slice is used.
   */
  unitsFrom(
    raw: readonly Detection[],
    size: Size,
    options: DetectOptions,
    slices?: readonly SliceRecord[],
  ): UnitGeometry[];
  /**
   * Loads ORT, the model and the session and runs the canary when one is due, without an image (a fresh WebGPU
   * profile needs seconds of shader compilation). Never rejects; failures surface in state().
   */
  warmup(): Promise<void>;
  /** Drops the session after detectorReleaseMin without detections (frees GPU and WASM memory while idle). */
  release(): Promise<void>;
}

/* ------------------------------------------------------------------ composite + translation (composite.ts, translator.ts) */

/** One unit inside a pack, in reading order. */
export interface PackUnit {
  contentKey: string;
  unitKey: string;
  geometry: UnitGeometry;
  /** Natural size of the unit's image. */
  imageSize: Size;
  script: Script;
  /** Absolute image URL or fixture path, used only for the x-ctv-test-units header in test builds. */
  src: string;
  /** Page position key (ids.pagePos: docOrder × 1000 + order): orders chapter history and summaries. */
  pos?: number;
}

export interface CompositeRequest {
  /** Reading order; mark n = index + 1. */
  units: readonly PackUnit[];
  mode: "full" | "crops-only";
  profile: ModelProfile;
  dir: ReadingDir;
  jpegQuality: number;
  /** Decoded images of every unit in the pack, by contentKey. */
  images: ReadonlyMap<string, DecodedImage>;
}

export interface CompositeOk {
  ok: true;
  jpeg: Uint8Array;
  /** "data:image/jpeg;base64,…" for the image_url part. */
  dataUrl: string;
  size: Size;
  /** n (1-based mark number) → unit. */
  marks: Array<{ n: number; contentKey: string; unitKey: string }>;
  /** base64(JSON [{n, src, box}]) for x-ctv-test-units (read by tools/mock-openai); only when __TEST__. */
  testUnits?: string;
}

export interface CompositeFail {
  ok: false;
  /** A layout failure, or "too-large": the JPEG is still over translate.requestBodyCapMb after the q0.80 re-encode. */
  reason: CompositeFailReason | "too-large";
}

export interface CompositeBuilder {
  build(request: CompositeRequest): Promise<CompositeOk | CompositeFail>;
}

/** Series context of one pack (memory.ts), already ordered and pre-trimmed; buildPrompt applies the final limits. */
export interface PackMemory {
  /** The series language when the profile names one (set by the user or settled by @lang votes). */
  lang: Lang | null;
  style: StyleProfile;
  /** Manual, then confirmed, then learned entries. */
  glossary: PromptGlossaryEntry[];
  pronouns: PronounRule[];
  /** Earlier lines of the chapter, oldest first (full requests only; crops-only re-asks send their neighbours). */
  history: HistoryLine[];
  summary: string | null;
  /** Ask full requests for an @sum line. */
  askSummary: boolean;
}

/** What the answers of one pack taught: @term lines, the last @sum of a full request, and the reported @lang. */
export interface PackLearning {
  terms: Term[];
  /** @addr lines: forms of address between characters (first report per pair wins). */
  addresses: Address[];
  summary: string | null;
  /** From an @lang line only (never the fallback language). */
  lang: Lang | null;
}

export interface TranslatePack {
  packId: string;
  frameKey: string;
  seriesKey: string | null;
  lang: Lang | "auto";
  dir: ReadingDir;
  /** ≤ boxBudget units of one frame and one chapter, never a split unit. */
  units: PackUnit[];
  /** Head unit on screen: urgent lane. */
  urgent: boolean;
  images: ReadonlyMap<string, DecodedImage>;
  /** URL and title of the page the pack comes from (series and chapter keys). */
  pageUrl?: string;
  pageTitle?: string;
  /** Series context for the prompt; absent when series memory is off or unavailable. */
  memory?: PackMemory;
}

/** Final per-unit outcome. Statuses outside this set never come out of the translator. */
export type UnitOutcomeStatus = Extract<
  UnitStatus,
  "ok" | "keep-original" | "untranslated" | "refused" | "ignored" | "error"
>;

export interface UnitResult {
  contentKey: string;
  unitKey: string;
  status: UnitOutcomeStatus;
  type: LineType;
  speaker: string;
  original: string;
  /** Empty unless status is "ok". */
  translation: string;
  lang: Lang | null;
  model: string | null;
}

export interface PackReport {
  packId: string;
  /** API requests sent for this pack (first pass + ladder + HTTP retries); target ≤ 5 per pass. */
  requests: number;
  /** unitKeys without an accepted line after the ladder: final status untranslated, error or refused, in pack order. */
  missing: string[];
  /** Set when the pack ended on an error (the units then carry status "error" or "refused"). */
  error: ErrorInfo | null;
  model: string | null;
  lang: Lang | null;
  /** Send → first accepted line of the first request, or null. */
  firstLineMs: number | null;
  totalMs: number;
  /** Composite bytes uploaded for this pack (privacy counter). */
  uploadedBytes: number;
  /** Series memory lines of the answers; absent when nothing was answered. */
  learning?: PackLearning;
}

export interface PackTranslator {
  /**
   * Composite → prompt → API → parser → id accounting → ladder (re-ask missing ids crops-only, then split ≤ 2
   * levels, then "untranslated"). Waits on ApiHealth.whenSendable() before each request. onUnit fires once per
   * unit, as soon as its line is accepted (streaming), and again never.
   */
  translate(pack: TranslatePack, onUnit: (result: UnitResult) => void): Promise<PackReport>;
}

/** The offline engine's PackTranslator (offline/translator.ts), with its status and an idle release. */
export interface OfflinePackTranslator extends PackTranslator {
  state(): OfflineStatus;
  /** Drops every loaded session (model files stay cached). */
  release(): Promise<void>;
}

/** Runs one task at a time in call order: the engine-wide lock around every ORT call (detector.ts createMutex). */
export type OrtLock = <T>(fn: () => Promise<T>) => Promise<T>;

/* ------------------------------------------------------------------ erase patches (erase.ts) */

export interface EraseOutput {
  kind: "mask" | "box" | "none";
  /** Natural px: the patch placement (mask), the plate area (box) or the text box (none). */
  rect: Box;
  bg: RGB | null;
  textColor: RGB;
  /** PNG of the mask patch; null for box / none. */
  png: ArrayBuffer | null;
  /** Glyph height measured from the pixels (falls back to the geometry estimate). */
  glyphPx: number;
  /** The balloon's interior (just inside its outline), or null for free text / no outline found. */
  interior: Box | null;
  /** The balloon is box-shaped (caption, sign): fit the translation in the rectangle, not the inscribed ellipse. */
  rectLike: boolean;
}

export interface Eraser {
  /**
   * Reads every unit's pixels synchronously (the bitmap must be open now; it may be released right after), then
   * computes the patches one unit per task so the engine never blocks for long.
   */
  start(image: DecodedImage, units: readonly UnitGeometry[]): Map<string, Promise<EraseOutput>>;
}

/* ------------------------------------------------------------------ privacy counter (uploads.ts) */

export interface UploadCounter {
  /** Records one sent composite in kv "uploads.daily" (local day). */
  record(bytes: number): void;
  today(): { today: number; bytesToday: number };
}

/* ------------------------------------------------------------------ series memory (memory.ts) */

/** Where a pack belongs: its page's series and chapter (src/shared/series-key.ts). */
export interface MemoryScope {
  seriesKey: string;
  chapterKey: string;
  siteKey: string;
  url: string;
  title: string;
}

export interface SeriesMemory {
  /**
   * Context for a pack about to be sent: creates the series and chapter records when missing, notes the image as a
   * page of the chapter, then reads glossary, history (lines before page position `pos`) and summary. Null when
   * memory is off or the stores are missing; a store failure also gives null (the pack goes without context).
   */
  context(
    scope: MemoryScope,
    pack: { contentKey: string; docOrder: number; pos: number },
  ): Promise<PackMemory | null>;
  /** Learns from a finished pack: @term candidates, the chapter summary, @lang votes. Queued; never rejects. */
  learn(scope: MemoryScope, pack: { packId: string; pos: number; learning: PackLearning }): Promise<void>;
  /** Resolves when everything queued by learn() is written. */
  idle(): Promise<void>;
  /** en:cache-clear ran (pages went with their images): forget which pages are stored. */
  cacheCleared(): void;
}

/* ------------------------------------------------------------------ pipeline (pipeline.ts over jobs/queue/batcher) */

export interface ImageProgress {
  state: ImageState;
  done: number;
  total: number;
}

export interface Pipeline {
  /**
   * Idempotent per (frameKey, imageKey); a cache hit answers with img:bulk without detection or upload. A submit with
   * force: true is an explicit re-translation: a new job that bypasses the translation cache.
   */
  submit(frame: FrameSink, submit: ImageSubmit): void;
  /**
   * New priorities for these images, then a re-rank of the queue. Urgency (FrameInfo.viewport.onScreen) and tab
   * ranking (page.visible, focusSeq) are read at dispatch, so handlers call priority(frameKey, []) after cs:viewport
   * and cs:visibility to apply them at once.
   */
  priority(frameKey: string, items: ReadonlyArray<{ imageKey: string; priority: number }>): void;
  /** Drops UNSENT work only; in-flight results are still cached. */
  forget(frameKey: string, imageKeys: readonly string[]): void;
  /**
   * img:retry from a frame: re-runs untranslated / error units (manual retries are never rate-limited). An image that
   * failed before it had units (e.g. image.http) restarts from acquisition.
   */
  retry(frameKey: string, imageKey: string, unitKey?: string): void;
  /** en:retranslate from the UI: a whole tab, one image or one unit; bypasses the cache. Returns units queued. */
  retranslate(scope: { tabId: number; contentKey?: string; unitKey?: string }): number;
  /**
   * unit:edit (by frame image) or en:edit-unit (by contentKey); vi null reverts to the AI text. Persists manualTranslation and
   * pushes img:unit to every frame showing that image (target ≤ 200 ms).
   */
  edit(
    target: { frameKey: string; imageKey: string } | { contentKey: string },
    unitKey: string,
    translation: string | null,
  ): Promise<void>;
  /** The frame's port closed and its 60 s grace ended (the grace lets a BFCache restore reattach). */
  frameGone(frameKey: string): void;
  /** The frame reconnected within the grace period with a new port. */
  frameReplaced(frame: FrameSink): void;
  queueStatus(): EngineStatus["queue"];
  /** No queued, running or in-flight work (gates the idle close of the offscreen document). */
  idle(): boolean;
  /** en:cache-clear ran: drop in-memory results so the next submit re-reads the stores. */
  cacheCleared(): void;
  /**
   * Caps requests in flight for a while (a 429 means 1 for 10 min, a watchdog timeout 1 for 5 min); the
   * runtime wires the translator's onConcurrencyCap here.
   */
  throttle(value: number, forMs: number): void;
}

/* ------------------------------------------------------------------ composition (runtime.ts) */

export interface CoreDeps {
  clock: Clock;
  log: Logger;
  settings: SettingsSource;
}

export interface ServiceFactories {
  openStores(deps: CoreDeps): Promise<EngineStores>;
  /** Platform Gfx for detector and composite: pixels.ts createChromeGfx (engine), tools/gfx-node.ts (Node). */
  createGfx(deps: CoreDeps): Gfx;
  createHealth(deps: CoreDeps): ApiHealth;
  createAcquirer(deps: CoreDeps & { capture?: CaptureStep }): ImageAcquirer;
  createDecoder(deps: CoreDeps): ImageDecoder;
  /** `exclusive`: the engine-wide ORT lock, shared with the offline engine (asyncify allows one call at a time). */
  createDetector(deps: CoreDeps & { stores: EngineStores; gfx: Gfx; exclusive?: OrtLock }): TextDetector;
  createComposite(deps: CoreDeps & { gfx: Gfx }): CompositeBuilder;
  createUploads(deps: CoreDeps & { stores: EngineStores }): UploadCounter;
  createTranslator(
    deps: CoreDeps & {
      health: ApiHealth;
      composite: CompositeBuilder;
      uploads: UploadCounter;
      /** A 429 or a watchdog timeout asks the whole queue to slow down (wired to Pipeline.throttle). */
      onConcurrencyCap?: (cap: { value: number; forMs: number }) => void;
    },
  ): PackTranslator;
  /**
   * The offline pack translator (settings.translate.engine "offline", experimental; offline/translator.ts). Optional:
   * without it, offline mode reports offline.run for every pack.
   */
  createOfflineTranslator?(
    deps: CoreDeps & {
      stores: EngineStores;
      gfx: Gfx;
      exclusive: OrtLock;
      /** The offline catalog of build-info.json. */
      catalog: () => Promise<readonly OfflineFile[]>;
      detectorBackend: () => "webgpu" | "wasm" | "none";
    },
  ): OfflinePackTranslator;
  createPipeline(
    deps: CoreDeps & {
      stores: EngineStores;
      health: ApiHealth;
      acquirer: ImageAcquirer;
      decoder: ImageDecoder;
      detector: TextDetector;
      translator: PackTranslator;
      ui: UiBroadcast;
      /** Erase patches; without it units are drawn on a plate over their text area. */
      eraser?: Eraser;
    },
  ): Pipeline;
}
