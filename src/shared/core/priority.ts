// Reading-order priorities, the reader's speed and the content script's rate rules for the cs:viewport and
// img:priority messages. PURE.
//
// Priority scale (lower = sooner, in screens): on screen [0, 1) by position, below the viewport 1 + screens below,
// above it ABOVE_RANK + screens above. ImageSubmit.priority and img:priority use it, and so do the look-ahead
// horizons: the engine sizes them from the reader's speed and its translation latency (computeHorizons, sent as
// en:horizons) and the content script's tier-B discovery prefetches lazy images inside the detect horizon
// (horizonCut: within `screens` screens below the viewport and at most `maxImages` ahead), and lets the ones inside
// the translate window be translated.

/** Ranks every image above the viewport after every image on or below it. */
export const ABOVE_RANK = 1_000_000;

export interface Span {
  top: number;
  bottom: number;
}

export interface View {
  top: number;
  height: number;
}

/** Lower = sooner, in screens: on screen [0, 1) by position, below 1 + distance, above ABOVE_RANK + distance. */
export function imagePriority(span: Span, view: View): number {
  const height = Math.max(1, view.height);
  const viewBottom = view.top + height;
  let rank: number;
  if (span.bottom <= view.top) rank = ABOVE_RANK + (view.top - span.bottom) / height;
  else if (span.top >= viewBottom) rank = 1 + (span.top - viewBottom) / height;
  else rank = Math.max(0, (span.top - view.top) / height);
  return Math.round(rank * 1000) / 1000;
}

export type PriorityClass = "on-screen" | "below" | "above";

export function priorityClass(priority: number): PriorityClass {
  if (priority < 1) return "on-screen";
  return priority < ABOVE_RANK ? "below" : "above";
}

/* ------------------------------------------------------------------ reading speed (cs:viewport) */

export const SPEED = {
  /** EMA weight of a new sample. */
  alpha: 0.3,
  /** Downward progress (screens) that makes one sample, so tiny scroll nudges do not count alone. */
  minScreens: 0.5,
  /** A pause longer than this is not reading time. */
  idleGapMs: 30_000,
  minSecondsPerScreen: 0.5,
  maxSecondsPerScreen: 60,
} as const;

export interface SpeedEstimator {
  /** Feeds the scroll position at `now`; returns the current seconds-per-screen estimate. */
  sample(scrollY: number, innerHeight: number, now: number): number;
  readonly secondsPerScreen: number;
}

/** Reading speed (seconds per screen) as an EMA over downward progress; starts at `initial` (settings default). */
export function createSpeedEstimator(initial: number): SpeedEstimator {
  let ema = initial;
  let last: { y: number; t: number } | null = null;
  let screens = 0;
  let ms = 0;
  return {
    get secondsPerScreen() {
      return ema;
    },
    sample(scrollY, innerHeight, now) {
      const previous = last;
      last = { y: scrollY, t: now };
      if (previous === null || innerHeight <= 0) return ema;
      const dt = now - previous.t;
      const dy = scrollY - previous.y;
      if (dt > SPEED.idleGapMs || dt < 0) {
        screens = 0;
        ms = 0;
        return ema;
      }
      if (dy <= 0) return ema;
      screens += dy / innerHeight;
      ms += dt;
      if (screens >= SPEED.minScreens) {
        const seconds = ms / 1000 / screens;
        const clamped = Math.min(SPEED.maxSecondsPerScreen, Math.max(SPEED.minSecondsPerScreen, seconds));
        ema += SPEED.alpha * (clamped - ema);
        screens = 0;
        ms = 0;
      }
      return ema;
    },
  };
}

/** cs:viewport and img:priority: at most this many messages per second. */
export const VIEWPORT_MAX_PER_SECOND = 4;

/** cs:viewport: sent `debounceMs` after the triggering event and never more often than maxPerSecond. */
export function viewportDelay(
  now: number,
  lastSentAt: number | null,
  debounceMs: number,
  maxPerSecond = VIEWPORT_MAX_PER_SECOND,
): number {
  const minGap = 1000 / maxPerSecond;
  const sinceLast = lastSentAt === null ? Number.POSITIVE_INFINITY : now - lastSentAt;
  return Math.max(debounceMs, minGap - sinceLast);
}

/* ------------------------------------------------------------------ img:priority */

export interface PriorityItem {
  imageKey: string;
  priority: number;
}

export interface PrioritySample extends PriorityItem {
  /** What the engine last got for this image (submit or img:priority); null = never. */
  sent: number | null;
}

/**
 * img:priority after a viewport sample: nothing while the engine's order (by the values it last got) still matches
 * the reading order and no image changed class (on screen, below, above); otherwise every value that moved, so the
 * engine also gets fresh distances. Ties in the current values are not an order change.
 */
export function priorityUpdate(samples: readonly PrioritySample[]): PriorityItem[] {
  const changed = samples.filter((s) => s.sent !== s.priority);
  if (changed.length === 0) return [];
  const toItems = (): PriorityItem[] => changed.map((s) => ({ imageKey: s.imageKey, priority: s.priority }));
  for (const s of samples) {
    if (s.sent === null || priorityClass(s.sent) !== priorityClass(s.priority)) return toItems();
  }
  // Engine order (ties broken by the current value): any decrease of the current value along it is an inversion.
  const engineOrder = [...samples].sort((a, b) => (a.sent ?? 0) - (b.sent ?? 0) || a.priority - b.priority);
  for (let i = 1; i < engineOrder.length; i += 1) {
    const before = engineOrder[i - 1];
    const after = engineOrder[i];
    if (before !== undefined && after !== undefined && before.priority > after.priority) return toItems();
  }
  return [];
}

/* ------------------------------------------------------------------ detect horizon (en:horizons) */

export interface Horizon {
  /** Screens below the viewport. */
  screens: number;
  /** Images ahead of the reader (on screen and below), counted in reading order. */
  maxImages: number;
}

export interface HorizonLimits {
  detectAheadMinScreens: number;
  detectAheadMaxScreens: number;
  detectMaxImages: number;
}

/** Before the engine's first en:horizons: the minimum detect horizon of the settings. */
export function defaultHorizon(limits: HorizonLimits): Horizon {
  return { screens: limits.detectAheadMinScreens, maxImages: limits.detectMaxImages };
}

/** en:horizons → Horizon; values that are not finite fall back to the defaults, the rest is clamped. */
export function horizonFrom(
  message: { detectScreens: number; detectMaxImages: number },
  limits: HorizonLimits,
): Horizon {
  const fallback = defaultHorizon(limits);
  const screens = Number.isFinite(message.detectScreens) ? message.detectScreens : fallback.screens;
  const images = Number.isFinite(message.detectMaxImages) ? message.detectMaxImages : fallback.maxImages;
  return {
    screens: Math.min(Math.max(1, limits.detectAheadMaxScreens), Math.max(0, screens)),
    maxImages: Math.min(100, Math.max(0, Math.floor(images))),
  };
}

export interface HorizonItem {
  key: string;
  priority: number;
  /** A prefetch candidate (else an image already tracked, which only takes a place ahead). */
  candidate: boolean;
}

/**
 * Prefetch candidates inside the detect horizon. `items` are in DOM order (ties in priority keep it): every image on
 * screen or below takes a place ahead, and a candidate is in when it is at most `screens` screens below the viewport
 * and among the first `maxImages` places. Images above the viewport are never prefetched.
 */
export function horizonCut(items: readonly HorizonItem[], horizon: Horizon): string[] {
  const ahead = items.filter((item) => item.priority < ABOVE_RANK).sort((a, b) => a.priority - b.priority);
  const limit = 1 + horizon.screens;
  const keys: string[] = [];
  ahead.forEach((item, index) => {
    if (item.candidate && index < horizon.maxImages && item.priority <= limit) keys.push(item.key);
  });
  return keys;
}

/* ------------------------------------------------------------------ look-ahead horizons (engine) */

export interface HorizonSettings extends HorizonLimits {
  lookaheadMinScreens: number;
  lookaheadMaxScreens: number;
  lookaheadMaxScreensStrip: number;
}

export interface Horizons {
  /** Prefetched images this many screens below the viewport may be translated. */
  translateScreens: number;
  /** Lazy images this many screens below the viewport are prefetched and detected. */
  detectScreens: number;
  detectMaxImages: number;
}

export const LOOKAHEAD = {
  /** Translation latency assumed before the first request finished. */
  defaultLatencyMs: 12_000,
  /** EMA weight of a new latency sample. */
  latencyAlpha: 0.3,
  /** A translation should be ready this many latencies before the reader gets there. */
  translateSafety: 2,
  /** Detection should run this many seconds of reading ahead. */
  detectAheadSec: 60,
} as const;

function clampInt(value: number, low: number, high: number): number {
  const top = Math.max(low, high);
  return Math.min(top, Math.max(low, Math.ceil(value)));
}

/**
 * Horizons for a reader at `secondsPerScreen` with translations taking `latencyMs`: the translate window covers
 * translateSafety latencies of reading (lookaheadMin…Max screens, the Strip maximum for webtoon strips), the detect
 * horizon detectAheadSec of reading (detectAheadMin…Max screens, never shorter than the translate window).
 */
export function computeHorizons(input: {
  secondsPerScreen: number;
  latencyMs: number;
  strip: boolean;
  settings: HorizonSettings;
}): Horizons {
  const s = input.settings;
  const speed =
    Number.isFinite(input.secondsPerScreen) && input.secondsPerScreen > 0
      ? Math.min(SPEED.maxSecondsPerScreen, Math.max(SPEED.minSecondsPerScreen, input.secondsPerScreen))
      : 4;
  const latencySec =
    Number.isFinite(input.latencyMs) && input.latencyMs > 0
      ? input.latencyMs / 1000
      : LOOKAHEAD.defaultLatencyMs / 1000;
  const translateMax = input.strip ? s.lookaheadMaxScreensStrip : s.lookaheadMaxScreens;
  const translateScreens = clampInt(
    (LOOKAHEAD.translateSafety * latencySec) / speed,
    s.lookaheadMinScreens,
    translateMax,
  );
  const detectScreens = clampInt(
    LOOKAHEAD.detectAheadSec / speed,
    Math.max(s.detectAheadMinScreens, translateScreens),
    s.detectAheadMaxScreens,
  );
  return { translateScreens, detectScreens, detectMaxImages: Math.max(1, Math.floor(s.detectMaxImages)) };
}

/** Running estimate of the translation latency (ms) from finished requests. */
export interface LatencyEstimator {
  observe(ms: number): void;
  readonly ms: number;
}

export function createLatencyEstimator(initial: number = LOOKAHEAD.defaultLatencyMs): LatencyEstimator {
  let ema = initial;
  return {
    get ms() {
      return ema;
    },
    observe(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return;
      ema += LOOKAHEAD.latencyAlpha * (Math.min(ms, 600_000) - ema);
    },
  };
}

/** Is a prefetched image at `priority` inside the translate window? (Never once it is above the viewport.) */
export function inTranslateWindow(priority: number, translateScreens: number): boolean {
  return priority < ABOVE_RANK && priority <= 1 + Math.max(0, translateScreens);
}
