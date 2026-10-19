// Settings and per-site settings stored in chrome.storage.local (`settings`, `site:<origin>`), their defaults
// (docs/CONFIGURATION.md) and a pure migration that clamps everything to LIMITS and upgrades older layouts. PURE.

import type { Lang } from "./types.ts";
import { SETTINGS_VERSION } from "./versions.ts";

export interface Settings {
  schemaVersion: number;
  enabled: boolean;
  /** Any OpenAI-compatible chat completions endpoint with vision support. */
  api: {
    /** Base URL including the version path, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1. */
    baseUrl: string;
    /** Sent as "Authorization: Bearer <key>" when not empty (local servers usually need none). */
    apiKey: string;
    /** Model id sent with every request; it must accept image input. */
    model: string;
    /** Sampling temperature; null leaves the provider's default. */
    temperature: number | null;
    /** Normal lanes; one urgent lane for on-screen bubbles comes on top when urgentLane is on. */
    concurrency: number;
    urgentLane: boolean;
    /** Hard cap on requests in flight, including the urgent lane (Chrome: 6 connections per host). */
    maxInFlight: number;
    firstByteTimeoutMs: number;
    idleTimeoutMs: number;
    totalTimeoutMs: number;
    healthTimeoutMs: number;
  };
  engine: { idleCloseMin: number; detectorReleaseMin: number; portIdleMin: number };
  detector: {
    backend: "auto" | "webgpu" | "wasm";
    scoreMin: number;
    sliceTriggerRatio: number;
    sliceHeightRatio: number;
    sliceOverlap: number;
    sliceOverlapMinPx: number;
    quietRows: boolean;
  };
  /** Extension UI language: "auto" follows the browser, else a supported locale code (src/shared/i18n). */
  ui: { locale: string };
  translate: {
    /** Language to translate into: "auto" follows the UI language, else a supported target code. */
    targetLang: string;
    /** null = use the model profile's budget for the configured model. */
    boxBudget: number | null;
    /**
     * How long the text of one image waits for the next images of the page (still being detected) to share its
     * request, in ms; a request also leaves as soon as it is full or nothing else is on its way. 0 = send at once.
     */
    packWaitMs: number;
    /** Cap on the first request of an image on screen, so its balloons show sooner; 0 = no separate cap. */
    urgentPackMax: number;
    jpegQuality: number;
    requestBodyCapMb: number;
    promptCharCap: number;
    maxLadderRequestsPerPack: number;
    maxHttpRetriesPerRequest: number;
    maxAutoPassesPerUnitPer10Min: number;
    splitOnRefusal: boolean;
    /**
     * "api": the configured OpenAI-compatible vision model reads and translates. "offline" (experimental): on-device
     * OCR and machine translation models downloaded once from Hugging Face; no AI endpoint (docs/OFFLINE-MODE.md).
     */
    engine: "api" | "offline";
    /** Offline translation model: Opus-MT per language pair (pivot through English), or NLLB-200 600M (any pair). */
    offlineModel: "opus-mt" | "nllb-600m";
  };
  discovery: {
    minNaturalSide: number;
    minDisplayedSide: number;
    lookaheadMinScreens: number;
    lookaheadMaxScreens: number;
    lookaheadMaxScreensStrip: number;
    detectAheadMinScreens: number;
    detectAheadMaxScreens: number;
    detectMaxImages: number;
    secondsPerScreenDefault: number;
    fetchPerHostConcurrency: number;
    prefetchSpacingMs: number;
    scrollDebounceMs: number;
    mutationDebounceMs: number;
    stripGapPx: number;
    translateHiddenTabs: boolean;
  };
  render: {
    font: "patrick-hand" | "mali";
    eraseSfx: boolean;
    sfxLabels: boolean;
    minFontPx: number;
    maxFontPx: number;
    showDoneBadge: boolean;
    /** Hold this key to peek at the original; "" disables it. */
    peekKey: string;
    peekWithAlt: boolean;
    /** Alt+click on a translated balloon opens its popup (a long press always does). */
    popupWithAltClick: boolean;
    /**
     * "auto": translations into Japanese or Traditional Chinese are lettered top to bottom in vertical (tategaki)
     * balloons; "never": always horizontal.
     */
    verticalText: "auto" | "never";
  };
  /** Series memory: glossary, earlier lines of the chapter and a running summary in every prompt. */
  memory: {
    /** Off: no series context in prompts and nothing learned from the answers. */
    enabled: boolean;
    /** Glossary entries per prompt (manual first, then confirmed, then learned). */
    glossaryInPrompt: number;
    /** Distinct packs that must mention a model-suggested term before it becomes "learned". */
    termMinSightings: number;
    historyMaxLines: number;
    historyMaxTokens: number;
    summaryMaxWords: number;
  };
  cache: {
    translationTtlDays: number;
    patchCacheMb: number;
    contentPatchLruMb: number;
    encodedBytesLruMb: number;
    decodedBitmapsMax: number;
    decodedBitmapsMb: number;
  };
  privacy: {
    devFixtureHosts: string[];
    maxImageBytes: number;
    maxImagePixels: number;
    keepSentComposites: number;
    ackUploadNoticeAt: number | null;
  };
  debug: {
    logLevel: "debug" | "info" | "warn" | "error";
    logCapacity: number;
    /**
     * Development and test builds only: offline models are downloaded from <base>/<repo>/resolve/<revision>/<path>
     * instead of Hugging Face (a local mirror of .cache/offline-models). Empty = Hugging Face. Ignored in production.
     */
    offlineModelBaseUrl: string;
  };
}

export interface SiteSettings {
  enabled: boolean;
  /** auto = translate while scrolling; manual = only on request (hover button, menu, command). */
  mode: "auto" | "manual";
  includeSubdomains: boolean;
  credentials: "omit" | "include";
  /** auto: attempt 1 follows the page's referrer policy, attempt 2 sends the full page URL without Origin. */
  referer: "auto" | "page-url" | "origin";
  sourceLang: Lang | "auto";
  layout: "auto" | "webtoon" | "paged-rtl" | "paged-ltr";
  extraFrameOrigins: string[];
  /** Tier B discovery (automatic mode): detect lazy images below the view before the page loads them. */
  prefetchAhead: boolean;
  addedAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_VERSION,
  enabled: true,
  api: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.2,
    concurrency: 2,
    urgentLane: true,
    maxInFlight: 4,
    firstByteTimeoutMs: 180_000,
    idleTimeoutMs: 60_000,
    totalTimeoutMs: 600_000,
    healthTimeoutMs: 5_000,
  },
  ui: { locale: "auto" },
  engine: { idleCloseMin: 10, detectorReleaseMin: 5, portIdleMin: 5 },
  detector: {
    backend: "auto",
    scoreMin: 0.3,
    sliceTriggerRatio: 3.5,
    sliceHeightRatio: 3.0,
    sliceOverlap: 0.2,
    sliceOverlapMinPx: 200,
    quietRows: false,
  },
  translate: {
    targetLang: "auto",
    boxBudget: null,
    packWaitMs: 500,
    urgentPackMax: 8,
    jpegQuality: 0.9,
    requestBodyCapMb: 4,
    promptCharCap: 16_000,
    maxLadderRequestsPerPack: 4,
    maxHttpRetriesPerRequest: 2,
    maxAutoPassesPerUnitPer10Min: 2,
    splitOnRefusal: false,
    engine: "api",
    offlineModel: "opus-mt",
  },
  discovery: {
    minNaturalSide: 300,
    minDisplayedSide: 150,
    lookaheadMinScreens: 2,
    lookaheadMaxScreens: 10,
    lookaheadMaxScreensStrip: 15,
    detectAheadMinScreens: 10,
    detectAheadMaxScreens: 45,
    detectMaxImages: 25,
    secondsPerScreenDefault: 4,
    fetchPerHostConcurrency: 2,
    prefetchSpacingMs: 150,
    scrollDebounceMs: 250,
    mutationDebounceMs: 400,
    stripGapPx: 4,
    translateHiddenTabs: false,
  },
  render: {
    font: "patrick-hand",
    eraseSfx: false,
    sfxLabels: true,
    minFontPx: 11,
    maxFontPx: 64,
    showDoneBadge: false,
    peekKey: "Backquote",
    peekWithAlt: false,
    popupWithAltClick: true,
    verticalText: "auto",
  },
  memory: {
    enabled: true,
    glossaryInPrompt: 60,
    termMinSightings: 2,
    historyMaxLines: 20,
    historyMaxTokens: 700,
    summaryMaxWords: 60,
  },
  cache: {
    translationTtlDays: 30,
    patchCacheMb: 256,
    contentPatchLruMb: 64,
    encodedBytesLruMb: 96,
    decodedBitmapsMax: 3,
    decodedBitmapsMb: 320,
  },
  privacy: {
    devFixtureHosts: [],
    maxImageBytes: 32 * 1024 * 1024,
    maxImagePixels: 64_000_000,
    keepSentComposites: 0,
    ackUploadNoticeAt: null,
  },
  debug: { logLevel: "info", logCapacity: 5000, offlineModelBaseUrl: "" },
};

export const DEFAULT_SITE: Omit<SiteSettings, "addedAt"> = {
  enabled: false,
  mode: "auto",
  includeSubdomains: false,
  credentials: "omit",
  referer: "auto",
  sourceLang: "auto",
  layout: "auto",
  extraFrameOrigins: [],
  prefetchAhead: true,
};

/** Inclusive numeric ranges, keyed by "<section>.<field>". Values outside are clamped by migrateSettings. */
export const LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  "api.temperature": [0, 2],
  "api.concurrency": [1, 4],
  "api.maxInFlight": [1, 4],
  "api.firstByteTimeoutMs": [10_000, 900_000],
  "api.idleTimeoutMs": [10_000, 300_000],
  "api.totalTimeoutMs": [60_000, 1_200_000],
  "api.healthTimeoutMs": [500, 30_000],
  "engine.idleCloseMin": [2, 60],
  "engine.detectorReleaseMin": [1, 60],
  "engine.portIdleMin": [1, 30],
  "detector.scoreMin": [0.1, 0.9],
  "detector.sliceTriggerRatio": [1.5, 10],
  "detector.sliceHeightRatio": [1, 6],
  "detector.sliceOverlap": [0.05, 0.5],
  "detector.sliceOverlapMinPx": [0, 1000],
  "translate.boxBudget": [4, 20],
  "translate.packWaitMs": [0, 5_000],
  "translate.urgentPackMax": [0, 20],
  "translate.jpegQuality": [0.5, 1],
  "translate.requestBodyCapMb": [1, 40],
  "translate.promptCharCap": [2_000, 200_000],
  "translate.maxLadderRequestsPerPack": [0, 8],
  "translate.maxHttpRetriesPerRequest": [0, 5],
  "translate.maxAutoPassesPerUnitPer10Min": [0, 5],
  "discovery.minNaturalSide": [50, 2000],
  "discovery.minDisplayedSide": [50, 2000],
  "discovery.lookaheadMinScreens": [1, 10],
  "discovery.lookaheadMaxScreens": [2, 30],
  "discovery.lookaheadMaxScreensStrip": [2, 30],
  "discovery.detectAheadMinScreens": [2, 60],
  "discovery.detectAheadMaxScreens": [2, 120],
  "discovery.detectMaxImages": [1, 100],
  "discovery.secondsPerScreenDefault": [1, 30],
  "discovery.fetchPerHostConcurrency": [1, 6],
  "discovery.prefetchSpacingMs": [0, 5000],
  "discovery.scrollDebounceMs": [50, 2000],
  "discovery.mutationDebounceMs": [50, 5000],
  "discovery.stripGapPx": [0, 32],
  "render.minFontPx": [8, 16],
  "render.maxFontPx": [16, 120],
  "memory.glossaryInPrompt": [0, 200],
  "memory.termMinSightings": [1, 10],
  "memory.historyMaxLines": [0, 60],
  "memory.historyMaxTokens": [0, 4000],
  "memory.summaryMaxWords": [0, 200],
  "cache.translationTtlDays": [0, 3650],
  "cache.patchCacheMb": [16, 4096],
  "cache.contentPatchLruMb": [8, 512],
  "cache.encodedBytesLruMb": [16, 1024],
  "cache.decodedBitmapsMax": [1, 8],
  "cache.decodedBitmapsMb": [64, 2048],
  "privacy.maxImageBytes": [1024 * 1024, 128 * 1024 * 1024],
  "privacy.maxImagePixels": [1_000_000, 200_000_000],
  "privacy.keepSentComposites": [0, 100],
  "debug.logCapacity": [100, 100_000],
};

export const STORAGE_KEYS = {
  settings: "settings",
  sitePrefix: "site:",
} as const;

export function siteStorageKey(siteKey: string): string {
  return `${STORAGE_KEYS.sitePrefix}${siteKey}`;
}

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fresh copy of `value` when it is an array of strings, else null. */
function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/**
 * Deep-merges `raw` over `defaults`: keeps only keys the defaults know, keeps a raw value only when its type
 * matches the default's (null is accepted where the default is null or the field is nullable), clamps numbers to
 * LIMITS. Arrays are taken from raw when every element has the default element type (strings here).
 */
function mergeKnown(defaults: Plain, raw: unknown, path: string, nullable: ReadonlySet<string>): Plain {
  const source = isPlainObject(raw) ? raw : {};
  const out: Plain = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const keyPath = path === "" ? key : `${path}.${key}`;
    const value = source[key];
    if (isPlainObject(fallback)) {
      out[key] = mergeKnown(fallback, value, keyPath, nullable);
    } else if (Array.isArray(fallback)) {
      out[key] = stringArray(value) ?? stringArray(fallback) ?? [];
    } else if (value === null && (fallback === null || nullable.has(keyPath))) {
      out[key] = null;
    } else if (typeof value === "number" && (typeof fallback === "number" || nullable.has(keyPath))) {
      out[key] = Number.isFinite(value) ? clamp(keyPath, value) : fallback;
    } else if (value !== undefined && fallback !== null && typeof value === typeof fallback) {
      out[key] = value;
    } else {
      out[key] = fallback;
    }
  }
  return out;
}

function clamp(keyPath: string, value: number): number {
  const range = LIMITS[keyPath];
  if (range === undefined) return value;
  return Math.min(range[1], Math.max(range[0], value));
}

/** Fields whose default is a number but may also be stored as null, or whose default is null but hold numbers. */
const NULLABLE_SETTINGS: ReadonlySet<string> = new Set([
  "translate.boxBudget",
  "privacy.ackUploadNoticeAt",
  "api.temperature",
]);

/** A base URL with a version path: a bare origin (e.g. a local server) gets "/v1", the OpenAI convention. */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  try {
    const url = new URL(trimmed);
    if (url.pathname === "/" || url.pathname === "") return `${url.origin}/v1`;
    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Schema 1 kept the endpoint under the `adapter` key (a bare origin, without API key or model fields). Moves those
 * values to `api`; fields already under `api` win (a save may merge a partial `api` patch over a schema 1 value).
 */
function upgradeLayout(raw: unknown): unknown {
  if (!isPlainObject(raw) || !isPlainObject(raw["adapter"])) return raw;
  const legacy = raw["adapter"];
  const api: Plain = { ...legacy };
  delete api["sessionId"];
  if (typeof legacy["baseUrl"] === "string") api["baseUrl"] = normalizeBaseUrl(legacy["baseUrl"]);
  const current = raw["api"];
  const upgraded: Plain = { ...raw, api: isPlainObject(current) ? { ...api, ...current } : api };
  delete upgraded["adapter"];
  return upgraded;
}

/** Any stored value (or nothing) → valid Settings for the current schema version. */
export function migrateSettings(raw: unknown): Settings {
  const merged = mergeKnown(DEFAULT_SETTINGS as unknown as Plain, upgradeLayout(raw), "", NULLABLE_SETTINGS);
  merged["schemaVersion"] = SETTINGS_VERSION;
  const settings = merged as unknown as Settings;
  if (settings.discovery.lookaheadMaxScreens < settings.discovery.lookaheadMinScreens) {
    settings.discovery.lookaheadMaxScreens = settings.discovery.lookaheadMinScreens;
  }
  if (settings.discovery.detectAheadMaxScreens < settings.discovery.detectAheadMinScreens) {
    settings.discovery.detectAheadMaxScreens = settings.discovery.detectAheadMinScreens;
  }
  if (settings.render.maxFontPx < settings.render.minFontPx) {
    settings.render.maxFontPx = settings.render.minFontPx;
  }
  if (!["patrick-hand", "mali"].includes(settings.render.font)) {
    settings.render.font = DEFAULT_SETTINGS.render.font;
  }
  if (!["auto", "never"].includes(settings.render.verticalText)) {
    settings.render.verticalText = DEFAULT_SETTINGS.render.verticalText;
  }
  if (!["api", "offline"].includes(settings.translate.engine)) {
    settings.translate.engine = DEFAULT_SETTINGS.translate.engine;
  }
  if (!["opus-mt", "nllb-600m"].includes(settings.translate.offlineModel)) {
    settings.translate.offlineModel = DEFAULT_SETTINGS.translate.offlineModel;
  }
  settings.debug.offlineModelBaseUrl = offlineBaseUrl(settings.debug.offlineModelBaseUrl);
  settings.api.maxInFlight = Math.max(settings.api.maxInFlight, settings.api.concurrency);
  settings.api.baseUrl = normalizeBaseUrl(settings.api.baseUrl);
  return settings;
}

/** An http(s) base URL without a trailing slash, query or fragment; anything else becomes "" (Hugging Face). */
export function offlineBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return "";
    }
    if (url.search !== "" || url.hash !== "") return "";
    return trimmed;
  } catch {
    return "";
  }
}

/** Any stored per-site value → valid SiteSettings (addedAt defaults to `now`). */
export function migrateSite(raw: unknown, now: number): SiteSettings {
  const merged = mergeKnown(DEFAULT_SITE, raw, "site", new Set());
  const source = isPlainObject(raw) ? raw : {};
  const addedAt =
    typeof source["addedAt"] === "number" && Number.isFinite(source["addedAt"]) ? source["addedAt"] : now;
  const site = { ...merged, addedAt } as unknown as SiteSettings;
  if (!["auto", "manual"].includes(site.mode)) site.mode = DEFAULT_SITE.mode;
  if (!["omit", "include"].includes(site.credentials)) site.credentials = DEFAULT_SITE.credentials;
  if (!["auto", "page-url", "origin"].includes(site.referer)) site.referer = DEFAULT_SITE.referer;
  if (!["auto", "webtoon", "paged-rtl", "paged-ltr"].includes(site.layout)) site.layout = DEFAULT_SITE.layout;
  if (!["auto", "ja", "ko", "zh", "en", "es", "other"].includes(site.sourceLang))
    site.sourceLang = DEFAULT_SITE.sourceLang;
  return site;
}

/** Requests in flight allowed by the settings: normal lanes plus the urgent lane, never above the hard cap. */
export function inFlightCap(settings: Settings): number {
  return Math.min(settings.api.maxInFlight, settings.api.concurrency + (settings.api.urgentLane ? 1 : 0));
}
