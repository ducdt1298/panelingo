// English UI catalog: the reference every other locale is checked against (src/shared/i18n/index.ts). PURE.
// Keys are grouped by surface; functions build strings with numbers or names. Other locales may leave keys out:
// missing keys fall back to this catalog.

import type { ErrorCode } from "../errors.ts";
import type {
  ApiReadiness,
  EnginePhase,
  EngineStatus,
  ImageState,
  OfflineStatus,
  UnitStatus,
} from "../types.ts";

export interface ErrorText {
  /** Short text for a badge or banner. */
  title: string;
  /** What the user can do about it (empty when nothing). */
  hint: string;
}

export interface ReadinessText {
  label: string;
  hint: string;
}

type DetectorStatus = EngineStatus["detector"];

const errors: Record<ErrorCode, ErrorText> = {
  "api.unreachable": {
    title: "Cannot reach the AI endpoint",
    hint: "Check the base URL in Options, and that the server (or your local model) is running.",
  },
  "api.lna_blocked": {
    title: "Chrome blocked the connection to your local AI server",
    hint: "Open the extension's site settings → Local network access → Allow.",
  },
  "api.unauthorized": {
    title: "The AI endpoint rejected the API key",
    hint: "Enter a valid API key in Options. Translation resumes automatically.",
  },
  "api.config": {
    title: "The AI endpoint or model is misconfigured",
    hint: "Check the base URL and choose a model that accepts images (vision) in Options.",
  },
  "api.rate_limit": {
    title: "The AI provider is rate limiting requests",
    hint: "The extension slows down and retries on its own.",
  },
  "api.upstream": { title: "AI server error, retrying", hint: "" },
  "api.context_length": { title: "Request too long, splitting it", hint: "" },
  "api.timeout": { title: "The AI took too long to answer", hint: "The extension retries once." },
  "api.truncated": { title: "The answer was cut off, continuing", hint: "" },
  "api.partial": { title: "The AI skipped some bubbles, asking again", hint: "" },
  "api.empty": { title: "Empty answer from the AI, retrying", hint: "" },
  "api.too_large": { title: "Image too large to send, shrinking it", hint: "" },
  "api.bad_request": { title: "The request was rejected (bug)", hint: "Export the debug log from Options." },
  "api.protocol": { title: "Unexpected answer format from the AI endpoint", hint: "" },
  "llm.refused": { title: "The AI refused to translate", hint: "The bubble keeps its original text." },
  "llm.missing": { title: "Not translated", hint: "Use “Translate again” to retry this bubble alone." },
  "llm.format": { title: "Malformed answer from the AI, retrying", hint: "" },
  "image.url_blocked": { title: "Image blocked for safety", hint: "" },
  "image.http": {
    title: "Could not load the image",
    hint: "If the site needs you to be signed in, turn on “Send cookies with image requests” in the popup.",
  },
  "image.not_image": { title: "Not an image file", hint: "" },
  "image.too_large": { title: "Image too large", hint: "" },
  "image.decode": { title: "Could not decode the image", hint: "" },
  "image.capture_unavailable": { title: "Scroll to the image to translate it", hint: "" },
  "image.capture_blocked": {
    title: "Only a screen capture can read this image",
    hint: "Turn translation on for this site and keep this tab in front, then retry.",
  },
  "detector.webgpu_unavailable": { title: "Detecting text on the CPU (slower)", hint: "" },
  "detector.canary_mismatch": { title: "The GPU gave inconsistent results, using the CPU", hint: "" },
  "detector.model_integrity": {
    title: "The text detection model is damaged",
    hint: "Reinstall the extension (developers: npm run fetch-models, then npm run build).",
  },
  "detector.init": { title: "Could not start text detection", hint: "Export the debug log from Options." },
  "detector.run": { title: "Text detection failed", hint: "" },
  "offline.pair_unsupported": {
    title: "This language pair is not available offline",
    hint: "Choose NLLB-200 as the offline model in Options, or another target language.",
  },
  "offline.download": {
    title: "Could not download the offline models",
    hint: "Check the connection to huggingface.co. Translation retries on its own.",
  },
  "offline.model_integrity": {
    title: "A downloaded offline model is damaged",
    hint: "Translate again to download it once more.",
  },
  "offline.run": { title: "The offline models failed", hint: "Export the debug log from Options." },
  "offline.out_of_memory": {
    title: "Not enough memory for the offline models",
    hint: "The translation models were restarted; the engine keeps running. Choose Opus-MT (much smaller) in Options, or close other tabs.",
  },
  "engine.unavailable": {
    title: "Could not start the translation engine",
    hint: "Reload the page, or turn the extension off and on again.",
  },
  "engine.closing": { title: "The engine is restarting", hint: "" },
  "engine.overloaded": { title: "The engine is busy", hint: "" },
  "engine.protocol": { title: "Extension version mismatch", hint: "Reload the page." },
  "engine.internal": { title: "Internal error", hint: "Export the debug log from Options." },
  "msg.too_large": { title: "Data too large, reloading by URL", hint: "" },
  "ctx.invalidated": {
    title: "The extension was just reloaded",
    hint: "Reload the page to keep translating.",
  },
  "dnr.failed": { title: "Could not set the image Referer", hint: "" },
  "store.io": { title: "Could not read or write the cache", hint: "" },
  "store.quota": { title: "The cache is full", hint: "Clear the cache in Options." },
  "site.disabled": { title: "Translation is off for this site", hint: "" },
  "privacy.consent": {
    title: "Sending images to the AI is not confirmed yet",
    hint: "Read the privacy notice and allow sending to start translating.",
  },
  cancelled: { title: "Cancelled", hint: "" },
};

const readiness: Record<ApiReadiness, ReadinessText> = {
  unknown: { label: "Checking the AI endpoint…", hint: "" },
  ready: { label: "AI endpoint ready", hint: "" },
  unauthorized: { label: "API key rejected", hint: errors["api.unauthorized"].hint },
  unreachable: { label: "AI endpoint unreachable", hint: errors["api.unreachable"].hint },
  lna_blocked: { label: "Chrome blocked the local AI server", hint: errors["api.lna_blocked"].hint },
  misconfigured: { label: "AI endpoint not configured", hint: errors["api.config"].hint },
};

const imageState: Record<ImageState, string> = {
  queued: "Queued",
  acquiring: "Loading image",
  detecting: "Finding text",
  waiting: "Waiting to translate",
  translating: "Translating",
  done: "Translated",
  "no-text": "No text",
  partial: "Partly translated",
  refused: "The AI refused",
  paused: "Paused",
  error: "Error",
  stale: "Outdated translation",
};

const unitStatus: Record<UnitStatus, string> = {
  pending: "Waiting",
  translating: "Translating",
  ok: "Translated",
  "keep-original": "Kept as is",
  manual: "Edited",
  untranslated: "Not translated",
  refused: "The AI refused",
  ignored: "Ignored",
  error: "Error",
  stale: "Outdated",
};

const enginePhase: Record<EnginePhase, string> = {
  booting: "Engine starting",
  ready: "Engine running",
  closing: "Engine stopping",
  failed: "Engine failed",
};

const detectorBackend: Record<DetectorStatus["backend"], string> = {
  webgpu: "GPU (WebGPU)",
  wasm: "CPU (WASM)",
  none: "not chosen yet",
};

const detectorState: Record<DetectorStatus["state"], string> = {
  unloaded: "not loaded",
  loading: "loading",
  ready: "ready",
  failed: "failed",
};

const detectorCanary: Record<DetectorStatus["canary"], string> = {
  pass: "GPU verified",
  fail: "the GPU gave inconsistent results, switched to the CPU",
  pending: "verifying the GPU",
  skipped: "",
};

const offlineState: Record<OfflineStatus["state"], string> = {
  idle: "Models load on first use",
  downloading: "Downloading models",
  loading: "Loading models",
  ready: "Ready",
  failed: "Failed",
};

export const EN = {
  errors,
  readiness,
  imageState,
  unitStatus,
  enginePhase,
  detectorBackend,
  detectorState,
  detectorCanary,
  offlineState,
  ui: {
    appName: "Panelingo",
    siteEnable: "Translate this site",
    siteDisable: "Stop translating this site",
    modeAuto: "Translate while scrolling",
    modeManual: "Translate on request only",
    translateVisible: "Translate visible images",
    /** Manual-mode hover button on an image that was never translated. */
    translateImage: "Translate",
    retranslate: "Translate again",
    showOriginal: "Show original",
    uploadsToday: (count: number, mb: number): string =>
      `Sent ${count} composite image${count === 1 ? "" : "s"} (${mb.toFixed(1)} MB) to the AI today`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `Translating ${done}/${total}`
        : `Translating ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} s`,
    privacyTitle: "Before images are sent to the AI",
    privacyBody:
      "To translate, the extension sends composite images of comic panels that contain text (only on sites you enable, " +
      "or when you ask) to the AI endpoint you configured. The AI provider may store what it receives under its own " +
      "terms. Make sure this is acceptable for you and for the content you read.",
    privacyAccept: "I understand, allow sending",
    privacyDecline: "Don't send",
  },
  bubble: {
    original: "Original",
    translation: "Translation",
    save: "Save",
    revert: "Use the AI translation",
    retranslate: "Translate again",
    close: "Close",
    dialog: "Translated bubble",
    copy: "Copy",
    editLabel: "Edit the translation",
    shortened: "The lettering was shortened to fit the bubble.",
    saved: "Saved.",
    retranslating: "Translating again…",
  },
  menu: {
    translateImage: "Translate this image",
    retranslateImage: "Translate this image again",
  },
  sidepanel: {
    title: "Panelingo – Transcript",
    heading: "Transcript",
    empty: "No translated lines on this tab yet.",
    emptyHint: "Open a comic page on a site you enabled. Lines appear here as they are translated.",
    refresh: "Refresh",
    copy: "Copy all",
    copied: "Copied to the clipboard.",
    page: (n: number): string => `Page ${n}`,
    jump: "Show",
    jumpHint: "Scroll the page to this bubble",
    edit: "Edit",
    save: "Save",
    cancel: "Cancel",
    retranslate: "Translate again",
    revert: "Undo edit",
    noTranslation: "No translation",
    notFound: "This bubble is no longer on the page.",
    failed: "That did not work. Try again.",
    types: {
      dialogue: "Dialogue",
      thought: "Thought",
      narration: "Narration",
      sign: "Sign",
      sfx: "SFX",
      ignore: "Ignored",
    },
    /** Transcript line whose translation misses the glossary rendering of a term in its original. */
    inconsistent: "Differs from the glossary",
    tabs: { transcript: "Transcript", glossary: "Glossary" },
    glossary: {
      noSeries: "Open a comic page to see the glossary of its series.",
      untitled: "Untitled series",
      states: {
        manual: "Your entries",
        confirmed: "Confirmed",
        learned: "Learned",
        candidate: "Suggestions",
      },
      hints: {
        manual: "Always used. The AI never changes them.",
        confirmed: "Suggestions you accepted. Always used.",
        learned: "Names and terms the AI used in several requests. Sent with every request.",
        candidate: "Noticed by the AI once. Not sent until confirmed or seen again.",
      },
      empty: "No entries yet. Names and terms appear here as the AI notices them, or add your own.",
      original: "Original text",
      translation: "Translation",
      note: "Note (optional)",
      add: "Add",
      delete: "Delete",
      confirm: "Confirm",
      seen: (count: number): string => `Seen ${count} time${count === 1 ? "" : "s"}`,
      incomplete: "Enter the original text and its translation.",
      profileHeading: "Series settings",
      sourceLang: "Source language",
      langAuto: "Detect automatically",
      langs: {
        ja: "Japanese",
        ko: "Korean",
        zh: "Chinese",
        en: "English",
        es: "Spanish",
        other: "Other",
      },
      koNames: "Korean names",
      koRomanized: "Romanized (Minjun)",
      koHanViet: "Sino-Vietnamese (for Vietnamese translations)",
      keepHonorifics: "Keep Japanese honorifics (-san, -kun)",
      summary: "Send a running story summary",
      saveProfile: "Save settings",
      saved: "Saved.",
      export: "Export",
      import: "Import",
      imported: (count: number): string => `Imported ${count} entr${count === 1 ? "y" : "ies"}.`,
      importFailed: "This file is not a Panelingo glossary.",
      address: {
        heading: "Forms of address",
        hint: "How each character refers to themself and to the one they talk to. The AI fills this in as you read and keeps it the same; your own rules are never changed.",
        speaker: "Speaker",
        listener: "Listener",
        self: "Refers to themself as",
        other: "Calls the listener",
        learned: "Learned by the AI",
        mine: "Yours",
        keep: "Keep",
        addHeading: "Add a form of address",
        incomplete: "Enter both names and at least one form of address.",
        full: "The list is full. Delete a rule first.",
        empty: "None yet. Pairs appear here as the AI meets them.",
      },
    },
  },
  debug: {
    heading: "Debug (dev/test builds only)",
  },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} days`;
  },
  popup: {
    siteToggle: "Translate on this site",
    fastMode: "Fast mode (less accurate)",
    progressDone: (count: number): string => `All done: ${count} image${count === 1 ? "" : "s"} on this page`,
    more: "More for this site",
    siteSettings: "All settings for this site",
    openTranscript: "Open the transcript",
    cookies: "Send cookies with image requests",
    cookiesHint:
      "For sites that only show images to signed-in readers. Cookies go to the image server only, never to the AI.",
    engineHeading: "Translation engine",
    siteHeading: "This site",
    checking: "Checking…",
    model: (model: string): string => `Model: ${model}`,
    endpoint: (url: string): string => `Endpoint: ${url}`,
    cause: (cause: string): string => `Details: ${cause}`,
    engineStopped: "The engine is idle; it starts when you translate.",
    engineUnreadable: "Could not read the engine status.",
    offlineHeading: "Offline mode (experimental)",
    offlineHint: "No AI endpoint is used: text recognition and translation run on this device.",
    offlineDownload: (doneMb: number, totalMb: number): string =>
      `Downloading ${Math.round(doneMb)} of ${Math.round(totalMb)} MB`,
    offlineModels: (models: string): string => `Models: ${models}`,
    detectorLine: (backend: string, state: string, canary: string): string =>
      `Text detection: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `Queue: ${queued} waiting · ${inFlight} sending · ${done} done · ${failed} failed`,
    pausedBy: (title: string): string => `Paused: ${title}`,
    siteUnsupported: "This page cannot be translated (http/https pages only).",
    modeLabel: "Mode",
    visibleSent: (count: number): string =>
      count > 0
        ? `Sent ${count} image${count === 1 ? "" : "s"} for translation.`
        : "No comic images visible.",
    visibleUnavailable: "The extension cannot run on this page.",
    retranslatePage: "Translate the page again",
    retranslateQueued: (count: number): string => `Queued ${count} bubble${count === 1 ? "" : "s"} again.`,
    actionFailed: (title: string): string => `Could not do that: ${title}`,
    privacyDetails: "See what is sent",
    options: "Options",
    setupHint: "Set up your AI endpoint (base URL, API key, model) in Options to start.",
    consentHint: "Click the Panelingo icon to read the privacy notice before turning translation on here.",
    build: (id: string): string => `Build ${id}`,
  },
  options: {
    tabs: {
      engine: {
        label: "Translation",
        intro:
          "What translates the comics: an AI model you connect, or the experimental offline models on this device.",
      },
      display: {
        label: "Language & display",
        intro: "The language you read in, the interface language, and how translations look on the page.",
      },
      sites: {
        label: "Sites",
        intro: "Sites where Panelingo translates. Turn a site on from the toolbar popup while you read it.",
      },
      privacy: {
        label: "Privacy & data",
        intro: "What is sent to the AI, what stays on this device, and how to back up your settings.",
      },
      advanced: {
        label: "Advanced",
        intro:
          "Fine-tuning for requests, text detection, finding images and caches. The defaults suit most uses; each change is saved when you leave the field.",
      },
    },
    controlsHeading: "Keys and clicks",
    speedHeading: "Speed",
    exportLog: "Export the debug log",
    exportFailed: "Could not export the debug log.",
    exportEmpty: "The debug log is empty.",
    title: "Options",
    apiHeading: "AI endpoint (OpenAI-compatible)",
    apiIntro:
      "Any service that speaks the OpenAI chat completions API and accepts images works: OpenAI, OpenRouter, Azure " +
      "OpenAI, Google Gemini (OpenAI mode), or a local server such as Ollama, LM Studio, vLLM or LiteLLM.",
    preset: "Preset",
    presetCustom: "Custom",
    baseUrl: "Base URL",
    baseUrlHint: "Including the version path, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1.",
    baseUrlInvalid: "Not a valid http(s) URL.",
    apiKey: "API key",
    apiKeyHint: "Stored in this browser profile only; leave empty for local servers that need none.",
    model: "Model",
    modelHint: "The model must accept image input (vision), e.g. gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl.",
    modelInvalid: "Enter a model id.",
    testConnection: "Test connection",
    testing: "Testing…",
    testOk: (detail: string): string => `Connected. ${detail}`,
    testFailed: (detail: string): string => `Failed: ${detail}`,
    concurrency: "Parallel translation requests",
    concurrencyHint: "Default 2; up to 4. Lower it if your provider rate-limits you.",
    concurrencyInvalid: "Choose a number from 1 to 4.",
    languageHeading: "Languages",
    uiLanguage: "Interface language",
    targetLanguage: "Translate into",
    languageAuto: "Same as the browser",
    save: "Save",
    saved: "Saved.",
    saveFailed: "Could not save.",
    sitesEmpty: "No sites yet. Open a comic page, click the extension icon and turn translation on for it.",
    siteEnabled: "On",
    siteMode: "Mode",
    siteRemove: "Remove",
    privacyHeading: "Privacy: what is sent to the AI",
    privacyPoints: [
      "For each translation the extension sends one JPEG composite to the AI endpoint you configured: thumbnails of " +
        "the images (or webtoon slices) that contain text, numbered boxes around each text area, and enlarged crops " +
        "of those areas.",
      "Text sent with it: formatting and language rules, the series glossary (up to 60 entries), up to 20 earlier " +
        "lines of the same chapter and a short summary.",
      "Never sent: images without text, the address of the page you read, cookies, your IP address or browser " +
        "headers (beyond what any request to your endpoint carries).",
      "The AI provider may keep what it receives according to its own terms. Treat everything sent as stored.",
      "Only sites you enable are translated while you scroll. Other pages are translated only when you ask (context " +
        "menu or shortcut), and the extension always asks before the first upload.",
      "The popup shows how many composites were sent today.",
      "On this device, translations, bubble positions and erase patches stay in the extension's IndexedDB; clear " +
        "them under Cache below.",
    ],
    privacyAcked: (when: string): string => `You confirmed the image-sending notice on ${when}.`,
    privacyNotAcked:
      "You have not confirmed the image-sending notice yet; the extension asks before the first upload.",
    cacheHeading: "Cache",
    cacheHint:
      "Delete every translation, bubble position and erase patch stored on this device. Reading again will translate " +
      "(and send images) again.",
    cacheClear: "Clear the whole cache",
    cacheConfirm: "Clear the whole cache? The next read will translate and send images again.",
    cacheCleared: (count: number): string => `Deleted ${count} record${count === 1 ? "" : "s"}.`,
    cacheFailed: (title: string): string => `Could not clear the cache: ${title}`,
    debugHeading: "Debug log",
    logLevel: "Log level",
    logLevels: {
      debug: "Verbose (debug)",
      info: "Info",
      warn: "Warnings",
      error: "Errors only",
    },
  },
  /** Options page: the Advanced section, the per-site editor and settings export/import. */
  optionsAdvanced: {
    search: "Search settings",
    modifiedOnly: "Only changed settings",
    matches: (count: number): string => `${count} setting${count === 1 ? "" : "s"}`,
    noMatch: "No setting matches your search.",
    defaultIs: (value: string): string => `Default: ${value}`,
    range: (min: string, max: string): string => `Allowed: ${min} to ${max}`,
    automatic: "automatic",
    on: "on",
    off: "off",
    reset: "Reset",
    resetLabel: (label: string): string => `Reset “${label}” to the default`,
    resetAll: "Reset all advanced settings",
    resetAllConfirm: "Reset every advanced setting to its default?",
    resetAllDone: "All advanced settings are back to their defaults.",
    notANumber: "Enter a number.",
    adjusted: (value: string): string => `Saved as ${value}, the nearest allowed value.`,
    badKey: "Use a key code such as Backquote or KeyH, or leave it empty.",
    verticalChoices: { auto: "Automatic", never: "Never" },
    groups: {
      api: "AI requests",
      translate: "Request contents",
      detector: "Text detection",
      engine: "Engine",
      discovery: "Finding images",
      render: "Lettering",
      memory: "Series memory",
      cache: "Cache",
      privacy: "Image limits",
      debug: "Debug log",
    },
    fields: {
      "api.temperature": {
        label: "Temperature",
        hint: "Lower keeps translations steady and close to the original; higher makes the wording more varied. Leave empty to use the provider's default.",
      },
      "api.urgentLane": {
        label: "Extra lane for images on screen",
        hint: "Adds one request lane reserved for the images you are looking at.",
      },
      "api.maxInFlight": {
        label: "Maximum requests at once",
        hint: "Hard cap, extra lane included. Never lower than the parallel translation requests.",
      },
      "api.firstByteTimeoutMs": {
        label: "Wait for the first response (seconds)",
        hint: "Give up when the endpoint sends nothing for this long.",
      },
      "api.idleTimeoutMs": {
        label: "Stalled answer timeout (seconds)",
        hint: "Give up when an answer stops streaming for this long.",
      },
      "api.totalTimeoutMs": {
        label: "Maximum request time (seconds)",
        hint: "Give up on any request after this long.",
      },
      "api.healthTimeoutMs": {
        label: "Connection check timeout (seconds)",
        hint: "Used by the endpoint check and by Test connection.",
      },
      "translate.boxBudget": {
        label: "Text areas per request",
        hint: "Leave empty to use the model's profile (12, 16 or 20).",
      },
      "translate.packWaitMs": {
        label: "Wait to group images (ms)",
        hint: "How long the text of one image waits for the next images of the page so they share one request. 0 sends each image at once.",
      },
      "translate.urgentPackMax": {
        label: "Balloons in the first on-screen request",
        hint: "The first request of an image on screen holds at most this many balloons, so they appear sooner. 0 = no separate limit.",
      },
      "translate.jpegQuality": {
        label: "JPEG quality",
        hint: "Quality of the composite image sent to the AI.",
      },
      "translate.requestBodyCapMb": {
        label: "Maximum request size (MB)",
        hint: "Larger composites are compressed more, then split.",
      },
      "translate.promptCharCap": {
        label: "Maximum prompt length (characters)",
        hint: "When a request is longer, the context is shortened first.",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "Extra requests to recover missed text",
        hint: "Asking again and splitting, when the AI skips text areas.",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "Retries after network errors",
        hint: "Per request, for temporary HTTP and network failures.",
      },
      "translate.engine": {
        label: "Translation engine",
        hint: "Offline mode is experimental: see Offline mode above.",
      },
      "translate.offlineModel": {
        label: "Offline translation model",
        hint: "Used in offline mode only.",
      },
      "translate.fastMode": {
        label: "Fast mode",
        hint: "Answers sooner and costs less: the AI writes only the translation (no speaker or transcription), gets no earlier lines and learns nothing new. Names, forms of address and lines that depend on context are less accurate.",
      },
      "translate.splitOnRefusal": {
        label: "Split refused requests",
        hint: "When the AI refuses, try the two halves separately instead of giving up.",
      },
      "detector.backend": {
        label: "Detection hardware",
        hint: "Automatic uses the GPU when it passes a self-test, otherwise the CPU.",
      },
      "detector.scoreMin": {
        label: "Minimum detection score",
        hint: "Lower values find more text, and more false positives.",
      },
      "detector.sliceTriggerRatio": {
        label: "Slice images longer than (ratio)",
        hint: "Images and webtoon strips whose long side exceeds this multiple of the short side are cut into slices.",
      },
      "detector.sliceHeightRatio": {
        label: "Slice length (× short side)",
        hint: "Length of each slice as a multiple of the image's short side.",
      },
      "detector.sliceOverlap": {
        label: "Slice overlap (fraction)",
        hint: "Overlap between neighboring slices, as a fraction of a slice.",
      },
      "detector.sliceOverlapMinPx": {
        label: "Minimum slice overlap (pixels)",
        hint: "Neighboring slices always share at least this many pixels.",
      },
      "detector.quietRows": {
        label: "Cut slices between text rows",
        hint: "Experimental: moves slice cuts to rows without ink.",
      },
      "engine.idleCloseMin": {
        label: "Close the idle engine after (minutes)",
        hint: "Frees memory when no page has used the engine for this long.",
      },
      "engine.detectorReleaseMin": {
        label: "Unload text detection after (minutes)",
        hint: "Releases the detection model when it has not run for this long.",
      },
      "engine.portIdleMin": {
        label: "Disconnect idle pages after (minutes)",
        hint: "A page lets go of the engine after this long without work.",
      },
      "discovery.minNaturalSide": {
        label: "Ignore images smaller than (pixels)",
        hint: "Real size of the short side. Skips icons, avatars and ads.",
      },
      "discovery.minDisplayedSide": {
        label: "Ignore images shown smaller than (pixels)",
        hint: "On-screen size of the short side.",
      },
      "discovery.secondsPerScreenDefault": {
        label: "Initial reading speed (seconds per screen)",
        hint: "Starting estimate until your reading speed is measured.",
      },
      "discovery.lookaheadMinScreens": {
        label: "Translation look-ahead, minimum (screens)",
        hint: "Images this many screens below the view are always translated before you get there.",
      },
      "discovery.lookaheadMaxScreens": {
        label: "Translation look-ahead, maximum (screens)",
        hint: "Upper limit when you read fast or the AI is slow.",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "Translation look-ahead on webtoon strips, maximum (screens)",
        hint: "Upper limit for long vertical strips.",
      },
      "discovery.detectAheadMinScreens": {
        label: "Detection look-ahead, minimum (screens)",
        hint: "Images the page has not loaded yet are detected this far ahead (nothing is uploaded).",
      },
      "discovery.detectAheadMaxScreens": {
        label: "Detection look-ahead, maximum (screens)",
        hint: "Upper limit for fast readers.",
      },
      "discovery.detectMaxImages": {
        label: "Images detected ahead, at most",
        hint: "Counts every image ahead of you, loaded or not.",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "Parallel image downloads per server",
        hint: "Image downloads at once from the same image server.",
      },
      "discovery.prefetchSpacingMs": {
        label: "Pause between image downloads (ms)",
        hint: "Minimum time between two downloads from the same server.",
      },
      "discovery.scrollDebounceMs": {
        label: "Scroll reaction delay (ms)",
        hint: "Wait this long after scrolling before reordering the work.",
      },
      "discovery.mutationDebounceMs": {
        label: "Page change reaction delay (ms)",
        hint: "Wait this long after the page changes (lazy loading, reader apps) before looking for new images.",
      },
      "discovery.stripGapPx": {
        label: "Maximum gap inside a webtoon strip (pixels)",
        hint: "Images closer than this form one continuous strip.",
      },
      "discovery.translateHiddenTabs": {
        label: "Translate in background tabs",
        hint: "Off: automatic mode waits until the tab has been shown.",
      },
      "render.font": {
        label: "Dialogue font",
        hint: "Font of the translated text in speech bubbles.",
      },
      "render.verticalText": {
        label: "Vertical lettering",
        hint: "Translations into Japanese or Traditional Chinese are lettered top to bottom in vertical balloons. Never keeps every translation horizontal.",
      },
      "render.minFontPx": {
        label: "Smallest text size (pixels)",
        hint: "Text that does not fit at this size is shortened with “…”.",
      },
      "render.maxFontPx": {
        label: "Largest text size (pixels)",
        hint: "The text also stays close to the size of the original lettering.",
      },
      "render.eraseSfx": {
        label: "Erase sound effects",
        hint: "Remove sound effects from the image instead of labeling them.",
      },
      "render.sfxLabels": {
        label: "Label sound effects",
        hint: "Show the translation of sound effects as small labels.",
      },
      "render.showDoneBadge": {
        label: "Mark translated images",
        hint: "Shows a small badge on every translated image.",
      },
      "render.peekKey": {
        label: "Hold to see the original (key code)",
        hint: "A key code such as Backquote or KeyH. Leave empty to turn it off.",
      },
      "render.peekWithAlt": {
        label: "Also show the original while Alt is held",
        hint: "Holding the Alt key alone also hides the translation.",
      },
      "render.popupWithAltClick": {
        label: "Alt+click opens the bubble popup",
        hint: "The popup shows the original and lets you edit the translation. A long press always opens it.",
      },
      "memory.enabled": {
        label: "Use series memory",
        hint: "Sends the glossary, earlier lines and a story summary with each request, and learns names from the answers.",
      },
      "memory.glossaryInPrompt": {
        label: "Glossary entries per request",
        hint: "Your entries first, then confirmed ones, then learned ones.",
      },
      "memory.termMinSightings": {
        label: "Sightings before a term is learned",
        hint: "Different requests that must name a term before it is sent.",
      },
      "memory.historyMaxLines": {
        label: "Earlier lines sent as context",
        hint: "Lines from the same chapter. 0 sends none.",
      },
      "memory.historyMaxTokens": {
        label: "Token budget for earlier lines",
        hint: "The oldest lines are dropped first.",
      },
      "memory.summaryMaxWords": {
        label: "Story summary length (words)",
        hint: "0 turns the running summary off.",
      },
      "memory.warmUp": {
        label: "Warm up a new series",
        hint: "While a series has no memory yet, its first request goes alone so the next pages reuse its names and forms of address. The first pages take a little longer.",
      },
      "cache.translationTtlDays": {
        label: "Keep unused translations for (days)",
        hint: "Your own edits never expire.",
      },
      "cache.encodedBytesLruMb": {
        label: "Downloaded image cache (MB)",
        hint: "Memory the engine uses to keep downloaded images.",
      },
      "privacy.maxImageBytes": {
        label: "Largest image file (MiB)",
        hint: "Bigger image files are skipped.",
      },
      "privacy.maxImagePixels": {
        label: "Largest image (megapixels)",
        hint: "Images with more pixels are skipped.",
      },
      "debug.logCapacity": {
        label: "Log entries kept",
        hint: "Size of the debug log the engine stores.",
      },
    },
    site: {
      settings: "Settings",
      settingsFor: (site: string): string => `Settings for ${site}`,
      layout: "Layout and reading direction",
      layouts: {
        auto: "Detect automatically",
        webtoon: "Webtoon (vertical strip)",
        "paged-rtl": "Pages, right to left (manga)",
        "paged-ltr": "Pages, left to right (comics)",
      },
      sourceLangHint:
        "Selects the language-specific instructions for the AI and how much text crops are enlarged.",
      referer: "Referer for image downloads",
      referers: {
        auto: "Automatic",
        "page-url": "Full page address",
        origin: "Site address only",
      },
      refererHint:
        "Automatic follows the page, then retries with the full page address if the image server refuses. " +
        "Change it only when images fail to load.",
      subdomains: "Also on subdomains",
      subdomainsHint: "Translate on every subdomain of this site with the same settings.",
      prefetch: "Prepare images ahead",
      prefetchHint:
        "Detect images below the view that the page has not loaded yet, so they are ready when you get there. Nothing is uploaded until they are close.",
      frames: "Reader frames from other sites",
      framesHint:
        "One origin per line, e.g. https://viewer.example.com, when the pages are shown inside a frame served " +
        "from another site.",
      framesInvalid: (lines: string): string => `Not an http(s) origin: ${lines}`,
    },
    transfer: {
      heading: "Back up and restore",
      hint:
        "Save your settings and site list to a JSON file, or load them from one. The privacy confirmation is " +
        "never exported.",
      includeKey: "Include the API key",
      includeKeyHint: "Leave this off before sharing the file: anyone could read the key in it.",
      export: "Export settings",
      import: "Import settings",
      importConfirm:
        "Replace your settings with the ones in the file? Sites in the file are added or updated.",
      notJson: "This file is not valid JSON.",
      notSettings: "This file is not a Panelingo settings export.",
      tooNew: "This file was made by a newer version of Panelingo.",
      imported: (settings: number, sites: number): string =>
        `Imported. Changed settings: ${settings}. Sites: ${sites}.`,
      keyImported: "The API key from the file was imported.",
      keyKept: "Your API key was kept (the file has none).",
    },
  },
  /** Options page: offline mode (experimental). */
  offline: {
    heading: "Offline mode (experimental)",
    intro:
      "Translate without any AI endpoint: open-source text recognition (PaddleOCR) and translation models run on " +
      "this device. Quality is clearly lower than with a vision model: no context between bubbles, no character " +
      "names, stylized lettering is often misread, and sound effects are left untranslated.",
    download:
      "The models are downloaded once from Hugging Face when first needed, checked, and kept on this device; after " +
      "that, translation needs no network. Sizes: text recognition 8 to 17 MB per language, Opus-MT about 115 MB " +
      "per language pair (twice that through English), NLLB-200 about 910 MB.",
    engine: "Translation engine",
    engineChoices: {
      api: "AI endpoint (OpenAI-compatible)",
      offline: "Offline on this device (experimental)",
    },
    model: "Offline translation model",
    modelChoices: {
      "opus-mt": "Opus-MT: small, one model per language pair",
      "nllb-600m": "NLLB-200 600M: every pair, large, non-commercial",
    },
    pairs:
      "Opus-MT translates Korean, Japanese, Chinese and Spanish into English, and English into Vietnamese, Spanish, " +
      "French, German, Italian and Indonesian; other pairs go through English. NLLB-200 translates between all the " +
      "languages listed here.",
    license:
      "Licences: PaddleOCR and most Opus-MT models Apache-2.0, two Opus-MT models CC-BY-4.0, NLLB-200 " +
      "CC-BY-NC-4.0 (non-commercial use only).",
    stored: (mb: number): string => `Downloaded models on this device: ${Math.round(mb)} MB`,
    deleteModels: "Delete the downloaded models",
    deleteConfirm: "Delete the downloaded offline models? They are downloaded again when needed.",
    deleted: "The downloaded models were deleted.",
  },
  manifest: {
    description:
      "Translate comics, manga and webtoons in place while you read, with any OpenAI-compatible AI.",
    commands: {
      "toggle-overlay": "Show or hide the translation overlay",
      "translate-visible": "Translate visible images",
      "toggle-site": "Turn automatic translation on or off for this site",
      "open-side-panel": "Open the transcript side panel",
    },
  },
};

export type Catalog = typeof EN;
