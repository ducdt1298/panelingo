// Canonical domain types shared by every context.
// PURE: types only, no runtime code.

import type { ErrorCode } from "./errors.ts";

/** Wire codec negotiated per channel: structured clone or base64 fallback. */
export type Codec = "sc" | "b64";
/** Binary payload on the wire: an ArrayBuffer under structured clone, base64 otherwise. */
export type Bytes = ArrayBuffer | { readonly b64: string };

export type Lang = "ja" | "ko" | "zh" | "en" | "es" | "other";
/** Glyph family used to size crops in the composite. */
export type Script = "hangul" | "cjk" | "latin";
export type LineType = "dialogue" | "thought" | "narration" | "sign" | "sfx" | "ignore";
export type ReadingDir = "ltr" | "rtl";

/** Axis-aligned box in NATURAL pixels of the source image (x2/y2 exclusive). */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface Size {
  w: number;
  h: number;
}
/** Viewport rectangle in CSS pixels. */
export interface RectCss {
  left: number;
  top: number;
  width: number;
  height: number;
}
export type RGB = readonly [number, number, number];

/** Detector classes of ogkalu/comic-text-and-bubble-detector (label ids 0, 1, 2). */
export type DetClass = "bubble" | "text_bubble" | "text_free";
export const DET_CLASSES: readonly DetClass[] = ["bubble", "text_bubble", "text_free"];

/** One detector output box after post-processing, in natural px of the whole image. */
export interface Detection {
  cls: DetClass;
  box: Box;
  score: number;
}

/** Position of an image in the page, used to order history and packs. */
export interface PagePos {
  docOrder: number;
  srcGen: number;
  yTop: number;
}

/** A translation unit: one bubble with all of its text boxes, or one merged group of free text. */
export interface UnitGeometry {
  /** Quantized-box key, stable across re-runs (see ids.unitKeyOf). */
  unitKey: string;
  kind: "bubble" | "free";
  /** The bubble outline, or null for free text. */
  bubble: Box | null;
  /** Union of the unit's text boxes. */
  text: Box;
  texts: Box[];
  orientation: "h" | "v";
  /** Estimated glyph height in natural px. */
  glyphPx: number;
  /** Reading order within the image (0-based). */
  order: number;
  /** Probable page number or watermark (ordered last). */
  edgeSmall?: true;
  seam?: { seamId: string; part: "upper" | "lower" };
}

/** Engine-internal unit (never on the wire). */
export interface Unit extends UnitGeometry {
  imageKey: string;
  score: number;
  /** Global page-order key: pagePos(docOrder, order) = docOrder * 1000 + order. */
  pos: number;
  /** Set when the unit touches the top/bottom edge of its image (seam candidate). */
  edge: "top" | "bottom" | null;
  lowPriority?: true;
}

/** Per-unit status on the wire. Engine-only phases (detected/held/packed) never cross contexts. */
export type UnitStatus =
  | "pending"
  | "translating"
  | "ok"
  | "keep-original"
  | "manual"
  | "untranslated"
  | "refused"
  | "ignored"
  | "error"
  | "stale";

export interface UnitRender {
  unitKey: string;
  type: LineType;
  speaker: string;
  original: string;
  translation: string;
  status: UnitStatus;
  /** Content script runs fitText inside this region. */
  /** script: the original lettering's script, so the translation matches its visual size (cap height vs glyph). */
  fit: { region: Box; shape: "ellipse" | "rect"; orientation: "h" | "v"; glyphPx: number; script?: Script };
  erase: { kind: "mask" | "box" | "none"; rect: Box; bg: RGB | null; textColor: RGB; png?: Bytes };
  seam?: { seamId: string; part: "upper" | "lower" };
}

export type ImageState =
  | "queued"
  | "acquiring"
  | "detecting"
  | "waiting"
  | "translating"
  | "done"
  | "no-text"
  | "partial"
  | "refused"
  | "paused"
  | "error"
  | "stale";

/** State of the configured OpenAI-compatible endpoint (GET {baseUrl}/models). */
export type ApiReadiness =
  "unknown" | "ready" | "unauthorized" | "unreachable" | "lna_blocked" | "misconfigured";

export type EnginePhase = "booting" | "ready" | "closing" | "failed";

/** The offline engine (experimental, settings.translate.engine "offline"): on-device OCR and translation models. */
export interface OfflineStatus {
  /** idle: nothing loaded yet · downloading: model files are coming · loading: sessions start · ready · failed. */
  state: "idle" | "downloading" | "loading" | "ready" | "failed";
  /** settings.translate.offlineModel. */
  model: "opus-mt" | "nllb-600m";
  /** Model ids loaded or being loaded, e.g. ["ocr-korean", "opus-mt-ko-en"]. */
  active: string[];
  /** Bytes of the download in progress, or null. */
  download: { done: number; total: number } | null;
  /** Code of the last failure while state is "failed". */
  error: ErrorCode | null;
  /**
   * Size of the WebAssembly heaps in bytes (they only grow; 0 when not started): the engine's ORT instance (detector
   * and recognizers) and the translation worker's (docs/OFFLINE-MODE.md, "Memory").
   */
  heap?: { engine: number; translation: number };
}

export interface EngineStatus {
  phase: EnginePhase;
  build: string;
  api: {
    readiness: ApiReadiness;
    /** The configured model id. */
    model: string | null;
    /** Why the endpoint is not ready (or a warning such as the model not being listed). */
    cause: string | null;
    checkedAt: number;
  };
  detector: {
    backend: "webgpu" | "wasm" | "none";
    state: "unloaded" | "loading" | "ready" | "failed";
    canary: "pass" | "fail" | "pending" | "skipped";
  };
  queue: {
    queued: number;
    inFlight: number;
    urgentInFlight: number;
    done: number;
    failed: number;
    pausedBy: ErrorCode | null;
    concurrency: number;
    boxBudget: number;
  };
  uploads: { today: number; bytesToday: number };
  /** settings.translate.engine; absent from engines that predate offline mode. */
  engine?: "api" | "offline";
  /** The offline engine's state (offline mode only). */
  offline?: OfflineStatus;
}

export interface TranscriptItem {
  contentKey: string;
  unitKey: string;
  pageOrder: number;
  order: number;
  type: LineType;
  speaker: string;
  original: string;
  translation: string;
  status: UnitStatus;
  manual: boolean;
  flags: Array<"inconsistent" | "suspect-merge" | "overflow">;
}

export interface Transcript {
  tabId: number;
  seriesKey: string | null;
  chapterKey: string | null;
  items: TranscriptItem[];
}

export interface GlossaryEdit {
  orig: string;
  translation: string;
  note: string;
}

export interface PronounRule {
  a: string;
  b: string;
  /** How A refers to themself when talking to B. */
  aSelf: string;
  /** How A addresses B. */
  aToB: string;
}

export interface SeriesProfile {
  seriesKey: string;
  siteKey: string;
  title: string;
  lang: Lang | "auto";
  langVotes: Partial<Record<Lang, number>>;
  readingDir: "auto" | ReadingDir;
  style: { genre: string; koNames: "romanized" | "han-viet"; keepJaHonorifics: boolean };
  pronouns: PronounRule[];
  summaryEnabled: boolean;
  notes: string;
  /** Other series keys merged into this one (mirror domains). */
  aliases: string[];
  createdAt: number;
  updatedAt: number;
  lastReadAt: number;
}

export interface LogEntry {
  t: number;
  level: "debug" | "info" | "warn" | "error";
  ctx: "sw" | "engine" | "cs" | "popup" | "sidepanel" | "options" | "debug";
  code?: string;
  msg: string;
  data?: Record<string, string | number | boolean | null>;
  frameKey?: string;
  imageKey?: string;
  batchId?: string;
}
