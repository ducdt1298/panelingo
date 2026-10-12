// Image discovery. Tier A: loaded <img> and <canvas> elements large enough to carry comic text, keyed
// `${elementSeq}.${srcGen}` (srcGen bumps when src/srcset change), on-screen tracking (IntersectionObserver),
// touching-image strips (core/strips), priorities (on screen, then below by distance, then above) and the cs:viewport
// sampler (≤ 4/s, EMA of seconds per screen). Decisions are pure functions; the DOM glue only measures elements and
// feeds them.
// Tier B (options.prefetch: auto mode on an enabled site with prefetchAhead): lazy <img> elements below the viewport
// that the page has not loaded yet, in the reading column, with a URL on a comic-image host (prefetch.ts), inside
// the detect horizon (en:horizons, core/priority.ts horizonCut). They are tracked like tier-A images but describe()
// gives natural null, prefetch true and the lazy URLs; when the page then loads the same URL the key stays and
// onLoaded() fires.

import { horizonCut, type Horizon, type HorizonItem } from "../shared/core/priority.ts";
import { groupStrips, type StripImage } from "../shared/core/strips.ts";
import type { ImageSubmit, ViewportInfo } from "../shared/protocol.ts";
import type { Settings } from "../shared/settings.ts";
import type { Size } from "../shared/types.ts";
import type { ImageElement, TrackedImage } from "./contracts.ts";
import { LAZY_ATTRS, hostOf, inReadingColumn, lazyUrls, srcsetUrls, type ColumnImage } from "./prefetch.ts";

export { srcsetUrls };

/* ------------------------------------------------------------------ pure decisions */

export interface CandidateMetrics {
  /** Natural (decoded) size; null while the element has no pixels yet. */
  natural: Size | null;
  /** CSS px. */
  displayed: Size;
}

export type CandidateLimits = Pick<Settings["discovery"], "minNaturalSide" | "minDisplayedSide">;

/** Tier A: natural short side ≥ minNaturalSide and displayed short side ≥ minDisplayedSide. */
export function isCandidate(metrics: CandidateMetrics, limits: CandidateLimits): boolean {
  if (metrics.natural === null) return false;
  const naturalShort = Math.min(metrics.natural.w, metrics.natural.h);
  const displayedShort = Math.min(metrics.displayed.w, metrics.displayed.h);
  return naturalShort >= limits.minNaturalSide && displayedShort >= limits.minDisplayedSide;
}

export function imageKeyOf(elementSeq: number, srcGen: number): string {
  return `${elementSeq}.${srcGen}`;
}

/** Ranks every image above the viewport after every image on or below it. */
export const ABOVE_RANK = 1_000_000;

/** Lower = sooner, in screens: on screen [0, 1) by position, below 1 + distance, above ABOVE_RANK + distance. */
export function imagePriority(
  span: { top: number; bottom: number },
  view: { top: number; height: number },
): number {
  const height = Math.max(1, view.height);
  const viewBottom = view.top + height;
  let rank: number;
  if (span.bottom <= view.top) rank = ABOVE_RANK + (view.top - span.bottom) / height;
  else if (span.top >= viewBottom) rank = 1 + (span.top - viewBottom) / height;
  else rank = Math.max(0, (span.top - view.top) / height);
  return Math.round(rank * 1000) / 1000;
}

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

/** cs:viewport: sent `debounceMs` after the triggering event and never more often than maxPerSecond. */
export function viewportDelay(
  now: number,
  lastSentAt: number | null,
  debounceMs: number,
  maxPerSecond = 4,
): number {
  const minGap = 1000 / maxPerSecond;
  const sinceLast = lastSentAt === null ? Number.POSITIVE_INFINITY : now - lastSentAt;
  return Math.max(debounceMs, minGap - sinceLast);
}

function absoluteUrl(url: string, base: string): string | null {
  if (url === "") return null;
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

/** cs:translate-image: does `target` (the menu's srcUrl) name this image's currentSrc, src or a srcset candidate? */
export function srcMatches(
  target: string,
  image: { currentSrc: string; src: string; srcsets: readonly string[] },
  base: string,
): boolean {
  const wanted = absoluteUrl(target, base);
  if (wanted === null) return false;
  const candidates = [image.currentSrc, image.src, ...image.srcsets.flatMap((set) => srcsetUrls(set))];
  return candidates.some((candidate) => absoluteUrl(candidate, base) === wanted);
}

/**
 * A canvas has no URL; the engine gets bytes from the content script. The pseudo URL changes with srcGen so a URL
 * alias can never map a redrawn canvas to an older picture.
 */
export function canvasSrc(pageUrl: string, elementSeq: number, srcGen: number): string {
  const hash = pageUrl.indexOf("#");
  const page = hash < 0 ? pageUrl : pageUrl.slice(0, hash);
  return `${page}#ctv-canvas-${elementSeq}.${srcGen}`;
}

/* ------------------------------------------------------------------ DOM glue */

/** ImageSubmit fields discovery knows (prefetch and altSrcs for tier B); the controller adds acquire/bytes. */
export type SubmitBase = Omit<ImageSubmit, "acquire" | "bytes" | "mime" | "source" | "force">;

export interface DiscoveryEvents {
  /** A new imageKey became a candidate (new element, or a new srcGen of a known one). */
  onCandidate(image: TrackedImage): void;
  /** That imageKey is gone: element removed, src changed, or no longer big enough. */
  onRemoved(imageKey: string): void;
  /** Throttled scroll/visibility sample (cs:viewport) with the current priority of every candidate. */
  onViewport(viewport: ViewportInfo, priorities: ReadonlyArray<{ imageKey: string; priority: number }>): void;
  /** The window was resized (overlays re-position). */
  onResize(): void;
  /** A tier-B image (tracked before it loaded) has now been loaded by the page; same imageKey. */
  onLoaded?(imageKey: string): void;
}

export interface DiscoveryOptions {
  /** Tier B: prefetch lazy images ahead of the reader. */
  prefetch: boolean;
}

export interface Discovery {
  start(): void;
  get(imageKey: string): TrackedImage | null;
  candidates(): TrackedImage[];
  /** Candidates that intersect the viewport. */
  onScreen(): TrackedImage[];
  priorityOf(imageKey: string): number;
  /** Fresh measurement of a candidate for img:submit; null when it is gone or has no pixels. */
  describe(imageKey: string): SubmitBase | null;
  /** cs:translate-image: the first loaded <img> whose currentSrc/src/srcset matches; tracked even when small. */
  findBySrc(srcUrl: string): TrackedImage | null;
  /** The detect horizon for tier B (en:horizons). */
  setHorizon(horizon: Horizon): void;
  destroy(): void;
}

export interface DiscoveryTimers {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

export interface DiscoveryEnv {
  doc: Document;
  win: Pick<Window, "scrollX" | "scrollY" | "innerHeight" | "addEventListener" | "removeEventListener">;
  timers: DiscoveryTimers;
  MutationObserver?: typeof MutationObserver;
  IntersectionObserver?: typeof IntersectionObserver;
}

interface Entry {
  readonly element: ImageElement;
  readonly seq: number;
  gen: number;
  /** Current imageKey while tracked, else null. */
  key: string | null;
  /** Tracked on an explicit request even below the size thresholds. */
  forced: boolean;
  onScreen: boolean;
  /** Tier B: the URLs it was prefetched from (first = src), kept while the element shows that picture. */
  lazy: string[] | null;
  /** Tier B and not loaded by the page yet. */
  waiting: boolean;
}

interface Placed {
  top: number;
  bottom: number;
}

interface Layout {
  order: Entry[];
  index: Map<Entry, number>;
  placed: Map<Entry, Placed>;
  strips: Map<Entry, { stripId: string; index: number }>;
}

/** Node.DOCUMENT_POSITION_FOLLOWING (no Node global in tests). */
const DOCUMENT_POSITION_FOLLOWING = 4;
const OWN_HOST_SELECTOR = "[data-ctv-host]";

function isImg(el: Element): el is HTMLImageElement {
  return el.localName === "img";
}

function asImageElement(node: unknown): ImageElement | null {
  if (typeof node !== "object" || node === null) return null;
  const el = node as Element;
  return el.localName === "img" || el.localName === "canvas" ? (el as ImageElement) : null;
}

function measure(el: ImageElement): CandidateMetrics {
  const rect = el.getBoundingClientRect();
  const displayed = { w: rect.width, h: rect.height };
  if (isImg(el)) {
    const loaded = el.complete && el.naturalWidth > 0 && el.naturalHeight > 0;
    return { natural: loaded ? { w: el.naturalWidth, h: el.naturalHeight } : null, displayed };
  }
  return { natural: el.width > 0 && el.height > 0 ? { w: el.width, h: el.height } : null, displayed };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function createDiscovery(
  env: DiscoveryEnv,
  settings: Settings["discovery"],
  events: DiscoveryEvents,
  options: DiscoveryOptions = { prefetch: false },
): Discovery {
  const { doc, win, timers } = env;
  const Mutation = env.MutationObserver ?? globalThis.MutationObserver;
  const Intersection = env.IntersectionObserver ?? globalThis.IntersectionObserver;
  const entries = new Map<ImageElement, Entry>();
  const byKey = new Map<string, Entry>();
  const speed = createSpeedEstimator(settings.secondsPerScreenDefault);
  const added = new Set<ImageElement>();
  let nextSeq = 1;
  let started = false;
  let destroyed = false;
  let removalsSeen = false;
  let rescanAll = false;
  let cachedLayout: Layout | null = null;
  let lastViewportAt: number | null = null;
  let cancelViewport: (() => void) | null = null;
  let cancelScan: (() => void) | null = null;
  let mutations: MutationObserver | null = null;
  let intersections: IntersectionObserver | null = null;
  let horizon: Horizon = { screens: settings.detectAheadMinScreens, maxImages: settings.detectMaxImages };

  function invalidateLayout(): void {
    cachedLayout = null;
  }

  function track(entry: Entry): void {
    entry.key = imageKeyOf(entry.seq, entry.gen);
    byKey.set(entry.key, entry);
    intersections?.observe(entry.element);
    invalidateLayout();
    events.onCandidate({ imageKey: entry.key, element: entry.element });
    scheduleViewport();
  }

  function untrack(entry: Entry): void {
    const key = entry.key;
    if (key === null) return;
    entry.key = null;
    entry.onScreen = false;
    entry.lazy = null;
    entry.waiting = false;
    byKey.delete(key);
    intersections?.unobserve(entry.element);
    invalidateLayout();
    events.onRemoved(key);
  }

  /** (Re)decides one element; `force` tracks it regardless of the size thresholds (explicit user request). */
  function evaluate(el: ImageElement, force = false): Entry | null {
    if (destroyed || !el.isConnected || el.closest(OWN_HOST_SELECTOR) !== null) return null;
    let entry = entries.get(el);
    const metrics = measure(el);
    // Tier B: still waiting for the page to load it.
    if (entry !== undefined && entry.waiting && entry.key !== null && metrics.natural === null) return entry;
    const wanted =
      metrics.natural !== null && (force || entry?.forced === true || isCandidate(metrics, settings));
    if (!wanted) {
      if (entry !== undefined) untrack(entry);
      return null;
    }
    if (entry === undefined) entry = newEntry(el);
    if (force) entry.forced = true;
    if (entry.key === null) {
      track(entry);
    } else if (entry.waiting) {
      entry.waiting = false;
      invalidateLayout();
      events.onLoaded?.(entry.key);
    }
    return entry;
  }

  function newEntry(el: ImageElement): Entry {
    const entry: Entry = {
      element: el,
      seq: nextSeq,
      gen: 0,
      key: null,
      forced: false,
      onScreen: false,
      lazy: null,
      waiting: false,
    };
    nextSeq += 1;
    entries.set(el, entry);
    return entry;
  }

  /** src/srcset (img) or width/height (canvas) changed: the old key ends, the new picture is a new key. */
  function sourceChanged(el: ImageElement): void {
    const entry = entries.get(el);
    const prefetched = entry?.lazy?.[0];
    if (entry?.key != null && prefetched !== undefined && isImg(el)) {
      // A lazy loader put the prefetched URL in: the same picture keeps its key.
      const image = { currentSrc: el.currentSrc, src: el.src, srcsets: srcsetsOf(el) };
      if (srcMatches(prefetched, image, doc.baseURI)) {
        evaluate(el);
        return;
      }
    }
    if (entry !== undefined) {
      entry.gen += 1;
      entry.forced = false;
      untrack(entry);
    }
    evaluate(el);
  }

  function onAttribute(target: Element, name: string | null): void {
    if (target.localName === "source") {
      const picture = target.parentElement;
      const img = picture?.localName === "picture" ? picture.querySelector("img") : null;
      if (img !== null) sourceChanged(img);
      return;
    }
    const el = asImageElement(target);
    if (el === null) return;
    const relevant = isImg(el) ? name === "src" || name === "srcset" : name === "width" || name === "height";
    if (relevant) sourceChanged(el);
  }

  function collect(node: Node): void {
    if (node.nodeType !== 1) return;
    const el = asImageElement(node);
    if (el !== null) added.add(el);
    for (const inner of (node as Element).querySelectorAll<ImageElement>("img, canvas")) added.add(inner);
  }

  function onMutations(records: MutationRecord[]): void {
    if (destroyed) return;
    for (const record of records) {
      if (record.type === "attributes") {
        onAttribute(record.target as Element, record.attributeName);
      } else if (record.type === "childList") {
        for (const node of record.addedNodes) collect(node);
        if (record.removedNodes.length > 0) removalsSeen = true;
      }
    }
    if (added.size > 0 || removalsSeen) scheduleScan();
  }

  function scheduleScan(): void {
    if (destroyed || cancelScan !== null) return;
    cancelScan = timers.setTimer(scan, settings.mutationDebounceMs);
  }

  function scan(): void {
    cancelScan = null;
    if (destroyed) return;
    if (removalsSeen) {
      removalsSeen = false;
      for (const entry of [...entries.values()]) {
        if (entry.element.isConnected) continue;
        untrack(entry);
        entries.delete(entry.element);
      }
    }
    const batch = rescanAll ? [...doc.querySelectorAll<ImageElement>("img, canvas")] : [...added];
    rescanAll = false;
    added.clear();
    for (const el of batch) evaluate(el);
    invalidateLayout();
    scheduleViewport();
  }

  function onIntersections(records: IntersectionObserverEntry[]): void {
    if (destroyed) return;
    let changed = false;
    for (const record of records) {
      const entry = entries.get(record.target as ImageElement);
      if (entry === undefined || entry.key === null || entry.onScreen === record.isIntersecting) continue;
      entry.onScreen = record.isIntersecting;
      changed = true;
    }
    if (changed) scheduleViewport();
  }

  const onLoad = (event: Event): void => {
    const el = asImageElement(event.target);
    if (el === null) return;
    // A loaded image may push everything below it: page positions are stale.
    invalidateLayout();
    evaluate(el);
  };

  const onScroll = (): void => scheduleViewport();

  const onResize = (): void => {
    rescanAll = true;
    invalidateLayout();
    scheduleScan();
    events.onResize();
  };

  /* ---- layout snapshot: DOM order, page rects, strips (stable under scrolling) ---- */

  function compareDocOrder(a: Entry, b: Entry): number {
    if (a.element === b.element) return 0;
    return (a.element.compareDocumentPosition(b.element) & DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1 : 1;
  }

  function layout(): Layout {
    if (cachedLayout !== null) return cachedLayout;
    const order = [...byKey.values()].sort(compareDocOrder);
    const index = new Map<Entry, number>();
    const placed = new Map<Entry, Placed>();
    const stripInput: StripImage[] = [];
    const scrollX = win.scrollX;
    const scrollY = win.scrollY;
    order.forEach((entry, i) => {
      index.set(entry, i);
      const rect = entry.element.getBoundingClientRect();
      const top = rect.top + scrollY;
      placed.set(entry, { top, bottom: top + rect.height });
      if (entry.key !== null && isImg(entry.element)) {
        stripInput.push({
          key: entry.key,
          left: rect.left + scrollX,
          top,
          width: rect.width,
          height: rect.height,
        });
      }
    });
    const strips = new Map<Entry, { stripId: string; index: number }>();
    for (const group of groupStrips(stripInput, { maxGap: settings.stripGapPx })) {
      group.members.forEach((member, i) => {
        const entry = byKey.get(member.key);
        if (entry !== undefined) strips.set(entry, { stripId: group.stripId, index: i });
      });
    }
    cachedLayout = { order, index, placed, strips };
    return cachedLayout;
  }

  function view(): { top: number; height: number } {
    return { top: win.scrollY, height: win.innerHeight };
  }

  function rankOf(entry: Entry, current: Layout): number {
    const span = current.placed.get(entry);
    return span === undefined ? ABOVE_RANK * 2 : imagePriority(span, view());
  }

  /* ---- cs:viewport ---- */

  function scheduleViewport(): void {
    if (!started || destroyed || cancelViewport !== null) return;
    const delay = viewportDelay(timers.now(), lastViewportAt, settings.scrollDebounceMs);
    cancelViewport = timers.setTimer(flushViewport, delay);
  }

  function flushViewport(): void {
    cancelViewport = null;
    if (destroyed) return;
    const now = timers.now();
    lastViewportAt = now;
    const scrollY = win.scrollY;
    const innerHeight = win.innerHeight;
    const secondsPerScreen = speed.sample(scrollY, innerHeight, now);
    // Fresh rects at most 4×/s: readers that scroll an inner container move images without window.scrollY.
    invalidateLayout();
    const current = layout();
    const onScreen: string[] = [];
    const priorities: Array<{ imageKey: string; priority: number }> = [];
    for (const entry of current.order) {
      if (entry.key === null) continue;
      if (entry.onScreen) onScreen.push(entry.key);
      priorities.push({ imageKey: entry.key, priority: rankOf(entry, current) });
    }
    events.onViewport(
      {
        scrollY: Math.round(scrollY),
        innerHeight: Math.round(innerHeight),
        secondsPerScreen: Math.round(secondsPerScreen * 100) / 100,
        onScreen,
      },
      priorities,
    );
    if (options.prefetch) scanLazy(current);
  }

  /* ---- tier B: lazy images ahead of the reader ---- */

  function lazyAttrsOf(img: HTMLImageElement): Parameters<typeof lazyUrls>[0] {
    return {
      src: img.getAttribute("src"),
      srcset: img.getAttribute("srcset"),
      lazy: LAZY_ATTRS.map((name) => img.getAttribute(name)),
    };
  }

  /** Lazy images below the viewport, in the reading column, inside the detect horizon: tracked as tier B. */
  function scanLazy(current: Layout): void {
    if (destroyed) return;
    const column: ColumnImage[] = [];
    const hosts = new Set<string>();
    const items: HorizonItem[] = [];
    for (const entry of current.order) {
      if (entry.key === null) continue;
      items.push({ key: entry.key, priority: rankOf(entry, current), candidate: false });
      if (entry.waiting || !isImg(entry.element)) continue;
      const rect = entry.element.getBoundingClientRect();
      column.push({ left: rect.left + win.scrollX, width: rect.width, parent: entry.element.parentElement });
      const host = hostOf(sourceOf(entry));
      if (host !== null) hosts.add(host);
    }
    if (column.length === 0 || hosts.size === 0) return;
    const v = view();
    const found = new Map<string, { img: HTMLImageElement; urls: string[] }>();
    for (const img of doc.querySelectorAll("img")) {
      if (entries.get(img)?.key != null || !img.isConnected || img.closest(OWN_HOST_SELECTOR) !== null)
        continue;
      if (measure(img).natural !== null) continue; // loaded: tier A decides
      const rect = img.getBoundingClientRect();
      if (Math.min(rect.width, rect.height) < settings.minDisplayedSide) continue;
      const top = rect.top + win.scrollY;
      if (top < v.top + v.height) continue; // the page loads what is on screen itself
      if (!inReadingColumn({ left: rect.left + win.scrollX, width: rect.width }, img.parentElement, column)) {
        continue;
      }
      const urls = lazyUrls(lazyAttrsOf(img), doc.baseURI, hosts);
      if (urls.length === 0) continue;
      const key = `lazy-${found.size}`;
      found.set(key, { img, urls });
      items.push({ key, priority: imagePriority({ top, bottom: top + rect.height }, v), candidate: true });
    }
    if (found.size === 0) return;
    for (const key of horizonCut(items, horizon)) {
      const hit = found.get(key);
      if (hit === undefined) continue;
      const entry = entries.get(hit.img) ?? newEntry(hit.img);
      entry.lazy = hit.urls;
      entry.waiting = true;
      track(entry);
    }
  }

  /* ---- describe ---- */

  function referrerPolicyOf(el: ImageElement): string {
    if (isImg(el) && el.referrerPolicy !== "") return el.referrerPolicy;
    const meta = doc.querySelector('meta[name="referrer" i]');
    return meta?.getAttribute("content")?.trim() ?? "";
  }

  function sourceOf(entry: Entry): string {
    const el = entry.element;
    if (isImg(el)) return el.currentSrc !== "" ? el.currentSrc : el.src;
    return canvasSrc(doc.URL, entry.seq, entry.gen);
  }

  function srcsetsOf(img: HTMLImageElement): string[] {
    const sets = [img.srcset];
    const picture = img.parentElement;
    if (picture?.localName === "picture") {
      for (const source of picture.querySelectorAll("source")) sets.push(source.srcset);
    }
    return sets.filter((set) => set !== "");
  }

  const discovery: Discovery = {
    start() {
      if (started || destroyed) return;
      started = true;
      intersections = new Intersection(onIntersections, { threshold: 0 });
      mutations = new Mutation(onMutations);
      mutations.observe(doc.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "width", "height"],
      });
      doc.addEventListener("load", onLoad, true);
      // Capture: scroll does not bubble, and some readers scroll an inner container instead of the window.
      doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
      win.addEventListener("resize", onResize, { passive: true });
      for (const el of doc.querySelectorAll<ImageElement>("img, canvas")) evaluate(el);
      scheduleViewport();
    },
    get(imageKey) {
      const entry = byKey.get(imageKey);
      return entry === undefined ? null : { imageKey, element: entry.element };
    },
    candidates() {
      return [...byKey].map(([imageKey, entry]) => ({ imageKey, element: entry.element }));
    },
    onScreen() {
      const visible: TrackedImage[] = [];
      for (const entry of layout().order) {
        if (entry.onScreen && entry.key !== null)
          visible.push({ imageKey: entry.key, element: entry.element });
      }
      return visible;
    },
    priorityOf(imageKey) {
      const entry = byKey.get(imageKey);
      return entry === undefined ? ABOVE_RANK * 2 : rankOf(entry, layout());
    },
    describe(imageKey) {
      const entry = byKey.get(imageKey);
      if (entry === undefined || !entry.element.isConnected) return null;
      const metrics = measure(entry.element);
      if (metrics.natural === null && !entry.waiting) return null;
      const current = layout();
      const rect = entry.element.getBoundingClientRect();
      const top = rect.top + win.scrollY;
      const lazy = entry.lazy;
      const base: SubmitBase = {
        imageKey,
        // Tier B keeps the prefetched URL once loaded: the engine's work for it is already there.
        src: lazy?.[0] ?? sourceOf(entry),
        natural: metrics.natural,
        displayed: { w: round1(metrics.displayed.w), h: round1(metrics.displayed.h) },
        element: isImg(entry.element) ? "img" : "canvas",
        priority: imagePriority({ top, bottom: top + rect.height }, view()),
        pos: {
          docOrder: current.index.get(entry) ?? current.order.length,
          srcGen: entry.gen,
          yTop: Math.round(top),
        },
      };
      const strip = current.strips.get(entry);
      if (strip !== undefined) base.strip = { stripId: strip.stripId, index: strip.index };
      const policy = referrerPolicyOf(entry.element);
      if (policy !== "") base.refPolicy = policy;
      if (lazy !== null) {
        const alt = lazy.slice(1);
        const shown = sourceOf(entry);
        if (!entry.waiting && shown !== "" && shown !== base.src && !alt.includes(shown)) alt.push(shown);
        if (alt.length > 0) base.altSrcs = alt;
      }
      if (entry.waiting) base.prefetch = true;
      return base;
    },
    findBySrc(srcUrl) {
      if (destroyed) return null;
      const base = doc.baseURI;
      for (const img of doc.querySelectorAll("img")) {
        if (
          !srcMatches(srcUrl, { currentSrc: img.currentSrc, src: img.src, srcsets: srcsetsOf(img) }, base)
        ) {
          continue;
        }
        const entry = evaluate(img, true);
        if (entry?.key != null) return { imageKey: entry.key, element: img };
      }
      return null;
    },
    setHorizon(next) {
      if (next.screens === horizon.screens && next.maxImages === horizon.maxImages) return;
      horizon = { screens: next.screens, maxImages: next.maxImages };
      scheduleViewport();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelViewport?.();
      cancelScan?.();
      cancelViewport = cancelScan = null;
      mutations?.disconnect();
      intersections?.disconnect();
      doc.removeEventListener("load", onLoad, true);
      doc.removeEventListener("scroll", onScroll, true);
      win.removeEventListener("resize", onResize);
      entries.clear();
      byKey.clear();
      added.clear();
      cachedLayout = null;
    },
  };
  return discovery;
}
