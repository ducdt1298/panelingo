// IndexedDB record types for database `ctv`.
// The engine is the only writer; UI pages read. Keys: see src/platform/db-schema.ts. PURE: types only.

import type { Settings, SiteSettings } from "./settings.ts";
import type {
  Box,
  Detection,
  Lang,
  LineType,
  LogEntry,
  RGB,
  SeriesProfile,
  UnitGeometry,
  UnitStatus,
} from "./types.ts";

/** One record per distinct image bytes. contentKey = "s:" + sha256 hex. */
export interface ImageRecord {
  contentKey: string;
  w: number;
  h: number;
  mime: string;
  byteLength: number;
  source: "url" | "bytes" | "capture";
  lowRes: boolean;
  lang: Lang | null;
  seriesKey: string | null;
  firstSeenAt: number;
  lastUsedAt: number;
}

/** urlKey = "u:" + normalizeUrl(src); looked up before fetching (CDN tokens stripped). */
export interface UrlAliasRecord {
  urlKey: string;
  contentKey: string;
  lastSeenAt: number;
}

/** A slice of a tall image that the detector ran on (natural px). */
export interface SliceRecord {
  y1: number;
  y2: number;
  x1?: number;
  x2?: number;
}

/**
 * Detector geometry for one image. Once any translation references it, it is authoritative (translations are
 * keyed by its unit keys):
 * detectorVersion covers only geometry-affecting parameters (model family "v4s", slicing, dedupe/merge rules),
 * never the backend, the model sha or scoreMin. Raw detections are kept from score 0.15 and scoreMin is applied
 * when units are rebuilt.
 */
export interface UnitsRecord {
  contentKey: string;
  detectorVersion: string;
  unitsVersion: number;
  backend: "webgpu" | "wasm";
  slices: SliceRecord[];
  rawDetections: Detection[];
  units: UnitGeometry[];
  createdAt: number;
}

export interface TranslationRecord {
  contentKey: string;
  /** For seam units: "seam:" + 16 chars of the lower image's contentKey + ":" + unitKey. */
  unitKey: string;
  seriesKey: string | null;
  type: LineType;
  speaker: string;
  original: string;
  translation: string;
  manualTranslation: string | null;
  /** Booleans cannot be IndexedDB keys: 0/1 for the byManual index. */
  manual: 0 | 1;
  status: UnitStatus;
  lang: Lang;
  /**
   * Target language code the AI translation is written in (languages.ts). Records written before targets were
   * recorded have none and stay valid; an AI translation into another target is not reused.
   */
  target?: string;
  model: string;
  promptVersion: number;
  attempts: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface PatchRecord {
  contentKey: string;
  unitKey: string;
  eraseVersion: number;
  /** "none": nothing to hide (only the translation is drawn); png is then empty. */
  kind: "mask" | "box" | "none";
  rect: Box;
  bg: RGB | null;
  textColor: RGB;
  /** Glyph height measured from the pixels (sizes the translation like the original lettering). */
  glyphPx: number;
  /** Balloon interior just inside the outline (where the translation is fitted), or null. */
  interior?: Box | null;
  /** Box-shaped balloon (EraseOutput.rectLike). */
  rectLike?: boolean;
  png: ArrayBuffer;
  bytes: number;
  lastUsedAt: number;
}

/** History index ordered by page position within a chapter (prior-art L11). */
export interface PageRecord {
  chapterKey: string;
  contentKey: string;
  seriesKey: string | null;
  orderKey: number;
  urlPath: string;
  seenAt: number;
}

export interface ChapterRecord {
  chapterKey: string;
  seriesKey: string | null;
  url: string;
  title: string;
  summary: string;
  /** Page position of the pack that produced the summary (newer packs only replace it). */
  summaryPos: number;
  lastReadAt: number;
}

export interface GlossaryEntry {
  seriesKey: string;
  orig: string;
  translation: string;
  note: string;
  state: "manual" | "confirmed" | "learned" | "candidate";
  sightings: number;
  /** Last 10 pack ids that mentioned the term (counts distinct packs). */
  packIds: string[];
  alternatives: Array<{ translation: string; count: number }>;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ModelIntegrityRecord {
  file: string;
  sha256: string;
  bytes: number;
  verifiedForBuild: string;
  ok: boolean;
  verifiedAt: number;
}

export interface DetectorDecision {
  backend: "webgpu" | "wasm";
  canary: "pass" | "fail" | "skipped";
  ort: string;
  modelSha: string;
  chromeMajor: number;
  gpu: string | null;
  at: number;
}

export interface KvMap {
  "settings.mirror": { settings: Settings; sites: Record<string, SiteSettings>; at: number };
  /** Re-run the canary only when any field changes. */
  "detector.decision": DetectorDecision;
  /** Last request durations for the latency model (lookahead). */
  "latency.samples": {
    samples: Array<{ n: number; firstLineMs: number; doneMs: number; model: string; at: number }>;
  };
  "patches.totalBytes": number;
  "uploads.daily": { day: string; composites: number; bytes: number };
  "retention.lastRunAt": number;
  /** Only if privacy.keepSentComposites > 0. */
  "sent.composites": Array<{ at: number; jpeg: ArrayBuffer; units: number }>;
}

export type KvKey = keyof KvMap;
export type KvRecord = { [K in KvKey]: { k: K; v: KvMap[K] } }[KvKey];
export type LogRecord = LogEntry & { seq?: number };

export type SeriesRecord = SeriesProfile;
