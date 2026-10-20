// Typed messaging contract between content scripts, the service worker, the offscreen engine and the UI pages
// (overview in docs/ARCHITECTURE.md). PURE: types and constants only.
//
// Rules: onMessage listeners are plain (non-async) functions installed via onMessageFor(); replies are always
// Reply<T> and errors travel as ErrorInfo values; only the engine listens to onConnect (names "engine" and "ui");
// every postMessage goes through TypedPort.post(), which never throws; senders are checked against per-message
// allow-lists; payloads are wire-safe (shared/wire.ts) and size-limited; no blob:/data: URLs cross contexts, only
// bytes; PROTOCOL_VERSION travels on every envelope and hello.

import type { ErrorInfo } from "./errors.ts";
import type { GlossaryEntry } from "./records.ts";
import type { Settings, SiteSettings } from "./settings.ts";
import type {
  Bytes,
  Codec,
  EnginePhase,
  EngineStatus,
  GlossaryEdit,
  ImageState,
  Lang,
  LogEntry,
  PagePos,
  RectCss,
  SeriesProfile,
  Size,
  TabProgress,
  Transcript,
  TranscriptItem,
  UnitGeometry,
  UnitRender,
  UnitStatus,
} from "./types.ts";
import { PROTOCOL_VERSION } from "./versions.ts";

export { PROTOCOL_VERSION };
export const PORT_ENGINE = "engine";
export const PORT_UI = "ui";
/** Test-build header the engine sends so the mock server can answer from fixture ground truth. */
export const TEST_UNITS_HEADER = "x-ctv-test-units";

export type ReqId = string;
export type Empty = Record<never, never>;

/* ---- one-shot: runtime.sendMessage (sw, engine) and tabs.sendMessage (cs) ---- */
export type Target = "sw" | "engine" | "cs";

export interface Envelope<T extends Target, K extends string, P> {
  readonly target: T;
  readonly type: K;
  readonly v: number;
  readonly payload: P;
}

export type Reply<R> =
  { readonly ok: true; readonly data: R } | { readonly ok: false; readonly error: ErrorInfo };

/** [request payload, response data], handled ONLY by the service worker. */
export interface SwApi {
  "sw:ensure-engine": [{ reason: "cs" | "ui" | "menu" | "command"; force?: true }, { created: boolean }];
  "sw:engine-state": [Empty, { exists: boolean }];
  "sw:get-settings": [Empty, { settings: Settings; sites: Record<string, SiteSettings> }];
  "sw:site-set": [{ siteKey: string; patch: Partial<SiteSettings>; tabId?: number }, { registered: boolean }];
  "sw:inject": [{ tabId: number; frameId?: number }, { injected: boolean }];
  /** referer null = remove the header; removeOrigin drops Origin as well. */
  "sw:dnr-ensure": [{ host: string; referer: string | null; removeOrigin: boolean }, { ruleId: number }];
  "sw:capture": [
    { tabId: number; rect: RectCss; viewport: Size; codec: Codec },
    { png: Bytes; scale: number; visible: RectCss },
  ];
  /** idleSinceMs: epoch ms when the idle period began (a timestamp, not a duration). */
  "sw:engine-idle": [{ idleSinceMs: number }, { closing: boolean }];
  "sw:badge": [{ tabId: number | null; text: string; tone: "busy" | "warn" | "error" | "none" }, Empty];
  /** The user confirmed the privacy notice (popup or overlay): sets settings.privacy.ackUploadNoticeAt. */
  "sw:ack-privacy": [Empty, { at: number }];
  "sw:ping": [{ probe: Bytes }, { probe: Bytes }];
}

/** Handled ONLY by the offscreen engine. */
export interface EngineApi {
  "en:settings": [{ settings: Settings; sites: Record<string, SiteSettings> }, Empty];
  "en:prepare-close": [Empty, { ok: boolean }];
  "en:ping": [{ probe: Bytes }, { probe: Bytes; phase: EnginePhase }];
  "en:status": [{ tabId?: number }, EngineStatus];
  "en:transcript": [{ tabId: number }, Transcript];
  "en:tab-progress": [{ tabId: number }, TabProgress];
  /** vi null = revert to the AI text. */
  "en:edit-unit": [{ contentKey: string; unitKey: string; translation: string | null }, Empty];
  "en:retranslate": [{ tabId: number; contentKey?: string; unitKey?: string }, { queued: number }];
  /** The series profile (null until the series is first translated or edited) and every glossary entry. */
  "en:glossary-list": [{ seriesKey: string }, { series: SeriesProfile | null; entries: GlossaryEntry[] }];
  /** Saves manual entries (≤ 500 per call): they replace any learned rendering and the model never changes them. */
  "en:glossary-upsert": [{ seriesKey: string; entries: GlossaryEdit[] }, Empty];
  "en:glossary-delete": [{ seriesKey: string; origs: string[] }, Empty];
  /** Candidate or learned entries become confirmed. */
  "en:glossary-confirm": [{ seriesKey: string; origs: string[] }, Empty];
  /** Creates the profile when missing; only user-editable fields are applied (shared/core/memory.ts). */
  "en:series-update": [{ seriesKey: string; patch: Partial<SeriesProfile> }, Empty];
  "en:jump-to": [{ tabId: number; contentKey: string; unitKey: string }, { found: boolean }];
  "en:cache-clear": [{ scope: "all" | "site" | "series"; key?: string }, { deletedRecords: number }];
}

/** Handled ONLY by content scripts (sent by the SW with chrome.tabs.sendMessage). */
export interface CsApi {
  "cs:toggle-overlay": [Empty, { visible: boolean }];
  "cs:translate-visible": [Empty, { submitted: number }];
  "cs:translate-image": [{ srcUrl: string; force: boolean }, { found: boolean }];
  "cs:teardown": [{ reason: "site-disabled" | "superseded" }, Empty];
}

export type ApiFor<T extends Target> = T extends "sw" ? SwApi : T extends "engine" ? EngineApi : CsApi;
export type ReqOf<A, K extends keyof A> = A[K] extends [infer P, unknown] ? P : never;
export type ResOf<A, K extends keyof A> = A[K] extends [unknown, infer R] ? R : never;
export type EnvelopeOf<T extends Target> = {
  [K in keyof ApiFor<T> & string]: Envelope<T, K, ReqOf<ApiFor<T>, K>>;
}[keyof ApiFor<T> & string];

/* ---- Port "engine": content script <-> engine ---- */

export interface PageHints {
  title: string;
  layout: "auto" | "webtoon" | "paged-rtl" | "paged-ltr";
  visible: boolean;
  dpr: number;
}

export interface ImageSubmit {
  /** Opaque, unique per frame: `${elementSeq}.${srcGen}`. */
  imageKey: string;
  /**
   * Absolute currentSrc (urlKey alias + engine fetch), resolved against document.baseURI by the content script. For
   * element "canvas" it is a synthetic discovery key (page URL + "#ctv-canvas-…"): never fetched, never a urlKey alias.
   */
  src: string;
  /**
   * Alternative URLs (data-src, srcset, ...) tried in order when src fails, meant for lazy images not loaded yet;
   * absolute, already resolved against document.baseURI like src.
   */
  altSrcs?: string[];
  /** naturalWidth/Height; null for not-yet-loaded prefetch candidates (the engine gates after decoding). */
  natural: Size | null;
  /** CSS px. */
  displayed: Size;
  element: "img" | "canvas";
  /**
   * Lower = sooner, in screens: on screen [0, 1) by position, below the viewport 1 + screens below, above it
   * 1e6 + screens above (content/discovery.ts imagePriority). img:priority uses the same scale.
   */
  priority: number;
  pos: PagePos;
  /** Touching <img> group (same width, gap <= stripGapPx). */
  strip?: { stripId: string; index: number };
  acquire: "url" | "bytes" | "capture";
  /** Only when acquire === "bytes" (ladder step 1), at most the codec's hard limit. */
  bytes?: Bytes;
  mime?: string;
  source?: "cs-fetch" | "cs-canvas";
  /** img.referrerPolicy or the page's <meta name=referrer> (hint for the "auto" Referer policy). */
  refPolicy?: string;
  prefetch?: true;
  /** Bypass the translation cache (re-translate). */
  force?: true;
}

export interface ViewportInfo {
  scrollY: number;
  innerHeight: number;
  /** EMA of the reader's speed. */
  secondsPerScreen: number;
  /** imageKeys currently on screen. */
  onScreen: string[];
}

export interface CsToEngineMap {
  "cs:hello": { v: number; build: string; probe: Bytes; mode: "auto" | "manual"; page: PageHints };
  /** Only if the engine->cs probe failed. */
  "cs:codec": { codec: "b64" };
  /** SPA navigation; the engine enforces same origin as port.sender.url. */
  "cs:page": { url: string; title: string };
  "cs:visibility": { visible: boolean };
  /** Debounced to 250 ms and at most 4/s. */
  "cs:viewport": ViewportInfo;
  /** Only used when the hidden offscreen document is timer-throttled. */
  "cs:heartbeat": Empty;
  "img:submit": ImageSubmit;
  /** Batched, <= 4/s. */
  "img:priority": { items: Array<{ imageKey: string; priority: number }> };
  /** Drops UNSENT work only; in-flight results still get cached. */
  "img:forget": { imageKeys: string[] };
  "img:retry": { imageKey: string; unitKey?: string };
  "unit:edit": { imageKey: string; unitKey: string; translation: string | null };
  /** The bubble popup's "Translate again": this unit only, bypassing the cache (also when edited by hand). */
  "unit:retranslate": { imageKey: string; unitKey: string };
  "unit:overflow": { imageKey: string; unitKey: string; overflow: boolean };
  /**
   * The image's content box in CSS px of the top-level viewport after cap:prepare, with that viewport's size and
   * devicePixelRatio. clip: in a reader iframe, the part of the top viewport the frame shows through.
   */
  "cap:ready": { reqId: ReqId; rect: RectCss; viewport: Size; dpr: number; clip?: RectCss };
  /**
   * Also sent unprompted ("moved") when the reader scrolls or presses a key during a capture session. "frame": an
   * iframe could not learn its position in the tab (no answer from the parent frames).
   */
  "cap:fail": { reqId: ReqId; reason: "not-visible" | "hidden" | "timeout" | "moved" | "frame" };
  /** Batched every 2 s, <= 50 entries. */
  "cs:log": { entries: LogEntry[] };
}

export interface EngineToCsMap {
  "en:hello": {
    v: number;
    build: string;
    probe: Bytes;
    codec: Codec;
    frameKey: string;
    status: EngineStatus;
  };
  "en:status": { status: EngineStatus };
  "en:closing": Empty;
  "en:horizons": { translateScreens: number; detectScreens: number; detectMaxImages: number };
  "img:state": {
    imageKey: string;
    state: ImageState;
    progress?: { done: number; total: number };
    etaSec?: number;
    error?: ErrorInfo;
  };
  /** lowRes: the image was read from a screen capture (ladder step 3), at screen resolution. */
  "img:units": {
    imageKey: string;
    contentKey: string;
    natural: Size;
    units: UnitGeometry[];
    lang?: Lang;
    lowRes?: true;
  };
  /** Streamed, one per accepted line. */
  "img:unit": { imageKey: string; unit: UnitRender };
  /** Cache hit, <= the soft limit each. */
  "img:bulk": { imageKey: string; contentKey: string; natural: Size; units: UnitRender[] };
  "img:done": { imageKey: string; contentKey: string; counts: Partial<Record<UnitStatus, number>> };
  "img:scroll-to": { imageKey: string; unitKey: string };
  /**
   * Screen capture (ladder step 3): make the image capturable and answer cap:ready. Without `band` the image is
   * revealed in the capture window; `band` (a tile in CSS px of the image: rows, and columns when left/width are
   * set) is scrolled to the window start. Every cap:prepare of one reqId belongs to one session, ended by cap:done.
   */
  "cap:prepare": {
    reqId: ReqId;
    imageKey: string;
    band?: { top: number; height: number; left?: number; width?: number };
  };
  "cap:done": { reqId: ReqId };
}

/* ---- Port "ui": popup / side panel / options / debug <-> engine ---- */

export interface UiToEngineMap {
  "ui:hello": { v: number; probe: Bytes; view: "popup" | "sidepanel" | "options" | "debug" };
  /** null = global status only. */
  "ui:watch": { tabId: number | null };
}

export interface EngineToUiMap {
  "en:hello": { v: number; probe: Bytes; codec: Codec };
  "en:status": { status: EngineStatus };
  "tx:delta": { tabId: number; items: TranscriptItem[] };
  "tx:reset": { tabId: number };
}

export type PortMsg<M> = { [K in keyof M & string]: { readonly type: K } & M[K] }[keyof M & string];
export type CsToEngine = PortMsg<CsToEngineMap>;
export type EngineToCs = PortMsg<EngineToCsMap>;
export type UiToEngine = PortMsg<UiToEngineMap>;
export type EngineToUi = PortMsg<EngineToUiMap>;

/** Narrowing helper for envelopes arriving on runtime.onMessage. */
export function isEnvelope(value: unknown): value is Envelope<Target, string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { target?: unknown; type?: unknown; v?: unknown };
  return (
    (v.target === "sw" || v.target === "engine" || v.target === "cs") &&
    typeof v.type === "string" &&
    typeof v.v === "number"
  );
}

export function makeEnvelope<T extends Target, K extends keyof ApiFor<T> & string>(
  target: T,
  type: K,
  payload: ReqOf<ApiFor<T>, K>,
): Envelope<T, K, ReqOf<ApiFor<T>, K>> {
  return { target, type, v: PROTOCOL_VERSION, payload };
}
