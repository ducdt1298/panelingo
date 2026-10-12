// Tier-A discovery: pure decisions (candidate filter, priority, speed EMA, viewport rate, srcset matching) and the
// DOM glue against a minimal fake DOM (no jsdom here): keys, srcGen bumps, removal, on-screen, strips, describe.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrackedImage } from "../../../src/content/contracts.ts";
import {
  ABOVE_RANK,
  SPEED,
  canvasSrc,
  createDiscovery,
  createSpeedEstimator,
  imageKeyOf,
  imagePriority,
  isCandidate,
  srcMatches,
  srcsetUrls,
  viewportDelay,
  type Discovery,
  type DiscoveryEvents,
} from "../../../src/content/discovery.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import type { ViewportInfo } from "../../../src/shared/protocol.ts";

const LIMITS = { minNaturalSide: 300, minDisplayedSide: 150 };

/* ------------------------------------------------------------------ pure decisions */

test("isCandidate: natural short side ≥ 300 and displayed short side ≥ 150; no pixels → no", () => {
  assert.equal(isCandidate({ natural: { w: 800, h: 300 }, displayed: { w: 720, h: 150 } }, LIMITS), true);
  assert.equal(isCandidate({ natural: { w: 800, h: 299 }, displayed: { w: 720, h: 400 } }, LIMITS), false);
  assert.equal(isCandidate({ natural: { w: 800, h: 2400 }, displayed: { w: 149, h: 400 } }, LIMITS), false);
  assert.equal(isCandidate({ natural: null, displayed: { w: 720, h: 1000 } }, LIMITS), false);
  assert.equal(imageKeyOf(7, 2), "7.2");
});

test("imagePriority: on screen first (by position), then below by distance, then everything above", () => {
  const view = { top: 1000, height: 800 };
  const onTop = imagePriority({ top: 900, bottom: 1300 }, view);
  const onMid = imagePriority({ top: 1400, bottom: 2000 }, view);
  const belowNear = imagePriority({ top: 1800, bottom: 2600 }, view);
  const belowFar = imagePriority({ top: 4200, bottom: 5000 }, view);
  const aboveNear = imagePriority({ top: 100, bottom: 900 }, view);
  const aboveFar = imagePriority({ top: -3000, bottom: -2000 }, view);
  assert.equal(onTop, 0);
  assert.equal(onMid, 0.5);
  assert.equal(belowNear, 1);
  assert.equal(belowFar, 4);
  assert.equal(aboveNear, ABOVE_RANK + 0.125);
  const ranked = [aboveFar, belowFar, onMid, aboveNear, belowNear, onTop].sort((a, b) => a - b);
  assert.deepEqual(ranked, [onTop, onMid, belowNear, belowFar, aboveNear, aboveFar]);
});

test("speed EMA: follows downward progress, ignores nudges, back-scrolls and pauses, stays clamped", () => {
  const speed = createSpeedEstimator(4);
  assert.equal(speed.sample(0, 1000, 0), 4, "first sample only sets the origin");
  // 1 screen every 2 s.
  let y = 0;
  let t = 0;
  for (let i = 0; i < 20; i += 1) {
    y += 1000;
    t += 2000;
    speed.sample(y, 1000, t);
  }
  assert.ok(Math.abs(speed.secondsPerScreen - 2) < 0.01, String(speed.secondsPerScreen));
  const before = speed.secondsPerScreen;
  speed.sample(y + 100, 1000, t + 250);
  assert.equal(speed.secondsPerScreen, before, "0.1 screen is not a sample yet");
  speed.sample(y - 5000, 1000, t + 500);
  assert.equal(speed.secondsPerScreen, before, "scrolling back is not reading");
  speed.sample(y, 1000, t + 500 + SPEED.idleGapMs + 1);
  speed.sample(y + 1000, 1000, t + 500 + SPEED.idleGapMs + 1 + 1000);
  assert.ok(speed.secondsPerScreen < before, "the pause did not count as reading time");
  const slow = createSpeedEstimator(4);
  slow.sample(0, 1000, 0);
  slow.sample(1000, 1000, 29_000);
  assert.ok(slow.secondsPerScreen <= SPEED.maxSecondsPerScreen);
  const fast = createSpeedEstimator(1);
  fast.sample(0, 1000, 0);
  fast.sample(10_000, 1000, 100);
  assert.ok(fast.secondsPerScreen >= SPEED.minSecondsPerScreen);
});

test("viewportDelay: the debounce, and never more than 4 per second", () => {
  assert.equal(viewportDelay(1000, null, 250), 250);
  assert.equal(viewportDelay(1000, 900, 250), 250);
  assert.equal(viewportDelay(1000, 990, 50), 240, "a short debounce still keeps 250 ms between sends");
  assert.equal(viewportDelay(1000, 0, 50), 50);
});

test("srcsetUrls keeps commas inside URLs and drops descriptors", () => {
  assert.deepEqual(srcsetUrls("a.jpg 1x, b.jpg 2x"), ["a.jpg", "b.jpg"]);
  assert.deepEqual(srcsetUrls(" a.jpg, b.jpg,, c.jpg 800w "), ["a.jpg", "b.jpg", "c.jpg"]);
  assert.deepEqual(srcsetUrls("a.jpg,b.jpg"), ["a.jpg,b.jpg"], "HTML: a URL runs until whitespace");
  assert.deepEqual(srcsetUrls("data:image/png;base64,AAA= 1x, x.png 2x"), [
    "data:image/png;base64,AAA=",
    "x.png",
  ]);
  assert.deepEqual(srcsetUrls("img.php?w=1,2 1x (odd, descriptor), z.jpg"), ["img.php?w=1,2", "z.jpg"]);
  assert.deepEqual(srcsetUrls(""), []);
});

test("srcMatches compares absolute URLs of currentSrc, src and srcset candidates", () => {
  const base = "https://reader.example/ch-1/";
  const image = {
    currentSrc: "",
    src: "https://cdn.example/p1.jpg",
    srcsets: ["p1@2x.jpg 2x, /img/p1-big.jpg 1600w"],
  };
  assert.equal(srcMatches("https://cdn.example/p1.jpg", image, base), true);
  assert.equal(srcMatches("https://reader.example/ch-1/p1@2x.jpg", image, base), true);
  assert.equal(srcMatches("https://reader.example/img/p1-big.jpg", image, base), true);
  assert.equal(srcMatches("https://cdn.example/p2.jpg", image, base), false);
  assert.equal(srcMatches("", image, base), false);
  assert.equal(
    srcMatches(
      "https://cdn.example/x.webp",
      { currentSrc: "https://cdn.example/x.webp", src: "", srcsets: [] },
      base,
    ),
    true,
  );
});

test("canvasSrc: page URL without hash plus seq and srcGen", () => {
  assert.equal(canvasSrc("https://r.example/c/1#top", 3, 2), "https://r.example/c/1#ctv-canvas-3.2");
  assert.equal(canvasSrc("https://r.example/c/1", 1, 0), "https://r.example/c/1#ctv-canvas-1.0");
});

/* ------------------------------------------------------------------ fake DOM */

interface FakeWindow {
  scrollX: number;
  scrollY: number;
  innerHeight: number;
  listeners: Map<string, Set<() => void>>;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  fire(type: string): void;
}

function fakeWindow(): FakeWindow {
  const listeners = new Map<string, Set<() => void>>();
  return {
    scrollX: 0,
    scrollY: 0,
    innerHeight: 1000,
    listeners,
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
}

let orderSeq = 0;

class FakeEl {
  readonly nodeType = 1;
  readonly localName: string;
  readonly order: number;
  readonly win: FakeWindow;
  isConnected = true;
  /** Page coordinates (CSS px). */
  page = { left: 0, top: 0, width: 0, height: 0 };
  complete = true;
  naturalWidth = 0;
  naturalHeight = 0;
  currentSrc = "";
  src = "";
  srcset = "";
  referrerPolicy = "";
  width = 0;
  height = 0;
  parentElement: FakeEl | null = null;
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  id = "";

  constructor(localName: string, win: FakeWindow) {
    this.localName = localName;
    this.win = win;
    orderSeq += 1;
    this.order = orderSeq;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return {
      left: this.page.left - this.win.scrollX,
      top: this.page.top - this.win.scrollY,
      width: this.page.width,
      height: this.page.height,
    };
  }

  closest(): null {
    return null;
  }

  compareDocumentPosition(other: FakeEl): number {
    return this.order < other.order ? 4 : 2;
  }

  append(child: FakeEl): void {
    child.parentElement = this;
    this.children.push(child);
  }

  querySelectorAll(selector: string): FakeEl[] {
    const names = selector.split(",").map((part) => part.trim());
    const out: FakeEl[] = [];
    const walk = (el: FakeEl): void => {
      for (const child of el.children) {
        if (names.includes(child.localName)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
}

class FakeDoc {
  readonly URL = "https://reader.example/ch-1#top";
  readonly baseURI = "https://reader.example/ch-1";
  readonly root: FakeEl;
  readonly documentElement: FakeEl;
  readonly listeners = new Map<string, Set<(event: { target: unknown }) => void>>();

  constructor(win: FakeWindow) {
    this.root = new FakeEl("html", win);
    this.documentElement = this.root;
  }

  querySelectorAll(selector: string): FakeEl[] {
    return this.root.querySelectorAll(selector).filter((el) => el.isConnected);
  }

  querySelector(): null {
    return null;
  }

  addEventListener(type: string, fn: (event: { target: unknown }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (event: { target: unknown }) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  fire(type: string, target: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ target });
  }
}

class FakeMutationObserver {
  static last: FakeMutationObserver | null = null;
  readonly callback: (records: unknown[]) => void;
  disconnected = false;

  constructor(callback: (records: unknown[]) => void) {
    this.callback = callback;
    FakeMutationObserver.last = this;
  }

  observe(): void {
    this.disconnected = false;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  trigger(records: unknown[]): void {
    if (!this.disconnected) this.callback(records);
  }
}

class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | null = null;
  readonly callback: (entries: unknown[]) => void;
  readonly observed = new Set<unknown>();

  constructor(callback: (entries: unknown[]) => void) {
    this.callback = callback;
    FakeIntersectionObserver.last = this;
  }

  observe(el: unknown): void {
    this.observed.add(el);
  }

  unobserve(el: unknown): void {
    this.observed.delete(el);
  }

  disconnect(): void {
    this.observed.clear();
  }

  trigger(entries: Array<{ target: unknown; isIntersecting: boolean }>): void {
    this.callback(entries);
  }
}

class ManualTimers {
  #now = 0;
  readonly timers = new Map<number, { at: number; fn: () => void }>();
  #seq = 0;

  now(): number {
    return this.#now;
  }

  setTimer(fn: () => void, ms: number): () => void {
    this.#seq += 1;
    const id = this.#seq;
    this.timers.set(id, { at: this.#now + ms, fn });
    return () => {
      this.timers.delete(id);
    };
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = target;
  }
}

interface Harness {
  win: FakeWindow;
  doc: FakeDoc;
  timers: ManualTimers;
  discovery: Discovery;
  candidates: string[];
  removed: string[];
  viewports: Array<{ viewport: ViewportInfo; priorities: Array<{ imageKey: string; priority: number }> }>;
  resized: number;
  loaded: string[];
  /** A lazy <img> the page has not loaded: no pixels, URL in data-src (or `attrs`). */
  lazy(options: {
    top: number;
    height?: number;
    width?: number;
    left?: number;
    attrs?: Record<string, string>;
  }): FakeEl;
  img(options: {
    top: number;
    height?: number;
    width?: number;
    left?: number;
    natural?: [number, number];
  }): FakeEl;
  mutations(): FakeMutationObserver;
  intersections(): FakeIntersectionObserver;
}

function harness(options: { prefetch?: boolean } = {}): Harness {
  const win = fakeWindow();
  const doc = new FakeDoc(win);
  const timers = new ManualTimers();
  const h: Harness = {
    win,
    doc,
    timers,
    discovery: null as unknown as Discovery,
    candidates: [],
    removed: [],
    viewports: [],
    resized: 0,
    loaded: [],
    lazy({ top, height = 1200, width = 800, left = 100, attrs }) {
      const el = new FakeEl("img", win);
      el.page = { left, top, width, height };
      el.naturalWidth = 0;
      el.naturalHeight = 0;
      for (const [name, value] of Object.entries(
        attrs ?? { "data-src": `https://cdn.example/lazy-${el.order}.jpg` },
      )) {
        el.attrs.set(name, value);
      }
      doc.root.append(el);
      return el;
    },
    img({ top, height = 1200, width = 800, left = 100, natural = [800, 1200] }) {
      const el = new FakeEl("img", win);
      el.page = { left, top, width, height };
      el.naturalWidth = natural[0];
      el.naturalHeight = natural[1];
      el.src = `https://cdn.example/${el.order}.jpg`;
      el.currentSrc = el.src;
      doc.root.append(el);
      return el;
    },
    mutations() {
      assert.ok(FakeMutationObserver.last !== null);
      return FakeMutationObserver.last;
    },
    intersections() {
      assert.ok(FakeIntersectionObserver.last !== null);
      return FakeIntersectionObserver.last;
    },
  };
  const events: DiscoveryEvents = {
    onCandidate: (image: TrackedImage) => h.candidates.push(image.imageKey),
    onRemoved: (imageKey) => h.removed.push(imageKey),
    onViewport: (viewport, priorities) => h.viewports.push({ viewport, priorities: [...priorities] }),
    onResize: () => {
      h.resized += 1;
    },
    onLoaded: (imageKey) => h.loaded.push(imageKey),
  };
  h.discovery = createDiscovery(
    {
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      timers,
      MutationObserver: FakeMutationObserver as unknown as typeof MutationObserver,
      IntersectionObserver: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
    },
    DEFAULT_SETTINGS.discovery,
    events,
    { prefetch: options.prefetch === true },
  );
  return h;
}

/* ------------------------------------------------------------------ DOM glue */

test("start: loaded, big enough images and canvases become candidates in DOM order", () => {
  const h = harness();
  const a = h.img({ top: 0 });
  h.img({ top: 1300, natural: [800, 200] }); // natural short side too small
  h.img({ top: 1500, width: 100, height: 100 }); // displayed too small (thumbnail)
  const lazy = h.img({ top: 2000 });
  lazy.complete = false;
  const canvas = new FakeEl("canvas", h.win);
  canvas.page = { left: 100, top: 3500, width: 800, height: 1200 };
  canvas.width = 800;
  canvas.height = 1200;
  h.doc.root.append(canvas);

  h.discovery.start();
  assert.deepEqual(h.candidates, ["1.0", "2.0"]);
  assert.equal(h.discovery.get("1.0")?.element, a);
  assert.equal(h.intersections().observed.size, 2);

  lazy.complete = true;
  h.doc.fire("load", lazy);
  assert.deepEqual(h.candidates, ["1.0", "2.0", "3.0"], "a lazy image is a candidate once loaded");
  assert.deepEqual(
    h.discovery.candidates().map((image) => image.imageKey),
    ["1.0", "2.0", "3.0"],
  );
});

test("src/srcset changes bump srcGen: the old key is removed, the loaded picture gets a new key", () => {
  const h = harness();
  const a = h.img({ top: 0 });
  h.discovery.start();
  a.complete = false;
  a.src = "https://cdn.example/new.jpg";
  h.mutations().trigger([{ type: "attributes", target: a, attributeName: "src" }]);
  assert.deepEqual(h.removed, ["1.0"]);
  assert.deepEqual(h.candidates, ["1.0"], "not loaded yet");
  a.complete = true;
  h.doc.fire("load", a);
  assert.deepEqual(h.candidates, ["1.0", "1.1"]);

  h.mutations().trigger([{ type: "attributes", target: a, attributeName: "alt" }]);
  assert.deepEqual(h.removed, ["1.0"], "other attributes do not matter");

  const canvas = new FakeEl("canvas", h.win);
  canvas.page = { left: 0, top: 2000, width: 800, height: 800 };
  canvas.width = 800;
  canvas.height = 800;
  h.doc.root.append(canvas);
  h.mutations().trigger([{ type: "childList", addedNodes: [canvas], removedNodes: [] }]);
  h.timers.advance(DEFAULT_SETTINGS.discovery.mutationDebounceMs);
  assert.deepEqual(h.candidates, ["1.0", "1.1", "2.0"]);
  canvas.width = 900;
  h.mutations().trigger([{ type: "attributes", target: canvas, attributeName: "width" }]);
  assert.deepEqual(h.removed, ["1.0", "2.0"]);
  assert.deepEqual(h.candidates.at(-1), "2.1");
});

test("a <source> srcset change inside <picture> renews its <img>", () => {
  const h = harness();
  const picture = new FakeEl("picture", h.win);
  const source = new FakeEl("source", h.win);
  const img = new FakeEl("img", h.win);
  img.page = { left: 0, top: 0, width: 800, height: 1200 };
  img.naturalWidth = 800;
  img.naturalHeight = 1200;
  img.src = "https://cdn.example/a.jpg";
  picture.append(source);
  picture.append(img);
  h.doc.root.append(picture);
  h.discovery.start();
  assert.deepEqual(h.candidates, ["1.0"]);
  h.mutations().trigger([{ type: "attributes", target: source, attributeName: "srcset" }]);
  assert.deepEqual(h.removed, ["1.0"]);
  assert.deepEqual(h.candidates, ["1.0", "1.1"], "already decoded: renewed at once");
});

test("added and removed nodes are processed after the mutation debounce", () => {
  const h = harness();
  const a = h.img({ top: 0 });
  h.discovery.start();
  const wrapper = new FakeEl("div", h.win);
  const inner = new FakeEl("img", h.win);
  inner.page = { left: 100, top: 1300, width: 800, height: 1200 };
  inner.naturalWidth = 800;
  inner.naturalHeight = 1200;
  wrapper.append(inner);
  h.doc.root.append(wrapper);
  a.isConnected = false;
  h.mutations().trigger([{ type: "childList", addedNodes: [wrapper], removedNodes: [a] }]);
  assert.deepEqual(h.candidates, ["1.0"]);
  h.timers.advance(DEFAULT_SETTINGS.discovery.mutationDebounceMs - 1);
  assert.deepEqual(h.removed, []);
  h.timers.advance(1);
  assert.deepEqual(h.removed, ["1.0"]);
  assert.deepEqual(h.candidates, ["1.0", "2.0"]);
  assert.equal(h.discovery.get("1.0"), null);
});

test("viewport: on-screen keys and priorities, throttled to one sample per 250 ms", () => {
  const h = harness();
  h.img({ top: 0 }); // 1.0 on screen
  h.img({ top: 1200 }); // 2.0 just below
  h.img({ top: 4000 }); // 3.0 further below
  h.discovery.start();
  h.intersections().trigger([{ target: h.discovery.get("1.0")?.element, isIntersecting: true }]);
  h.timers.advance(250);
  assert.equal(h.viewports.length, 1);
  const first = h.viewports[0];
  assert.deepEqual(first?.viewport, {
    scrollY: 0,
    innerHeight: 1000,
    secondsPerScreen: 4,
    onScreen: ["1.0"],
  });
  assert.deepEqual(first?.priorities, [
    { imageKey: "1.0", priority: 0 },
    { imageKey: "2.0", priority: 1.2 },
    { imageKey: "3.0", priority: 4 },
  ]);
  assert.deepEqual(
    h.discovery.onScreen().map((image) => image.imageKey),
    ["1.0"],
  );

  // A burst of scroll events: at most one sample per 250 ms.
  for (let i = 1; i <= 10; i += 1) {
    h.win.scrollY = i * 150;
    h.doc.fire("scroll", h.doc);
    h.timers.advance(50);
  }
  h.timers.advance(250);
  assert.equal(h.viewports.length, 3, "500 ms of scrolling → 2 more samples");
  const last = h.viewports.at(-1);
  assert.equal(last?.viewport.scrollY, 1500);
  assert.deepEqual(
    last?.priorities.map((p) => p.priority),
    [ABOVE_RANK + 0.3, 0, 2.5],
    "1.0 scrolled past, 2.0 on screen, 3.0 1.5 screens below",
  );
  assert.equal(h.discovery.priorityOf("3.0"), 2.5);
});

test("readers that scroll an inner container: priorities follow fresh rects while window.scrollY stays 0", () => {
  const h = harness();
  const a = h.img({ top: 0 });
  const b = h.img({ top: 1200 });
  h.discovery.start();
  h.timers.advance(250);
  assert.deepEqual(
    h.viewports.at(-1)?.priorities.map((p) => p.priority),
    [0, 1.2],
  );
  // The container scrolled by 1500 px: the images moved up, the window did not scroll.
  a.page.top -= 1500;
  b.page.top -= 1500;
  const container = new FakeEl("div", h.win);
  h.doc.fire("scroll", container);
  h.timers.advance(250);
  const last = h.viewports.at(-1);
  assert.equal(last?.viewport.scrollY, 0);
  assert.deepEqual(
    last?.priorities.map((p) => p.priority),
    [ABOVE_RANK + 0.3, 0],
  );
});

test("describe: the ImageSubmit fields discovery owns, including strips of touching images", () => {
  const h = harness();
  const a = h.img({ top: 0, height: 1200 });
  const b = h.img({ top: 1203, height: 1200 }); // 3 px gap: same strip
  h.img({ top: 3000, height: 1200 }); // far below: not in the strip
  a.referrerPolicy = "no-referrer";
  b.currentSrc = "https://cdn.example/b@2x.jpg";
  h.win.scrollY = 600;
  h.discovery.start();
  const first = h.discovery.describe("1.0");
  assert.deepEqual(first, {
    imageKey: "1.0",
    src: a.src,
    natural: { w: 800, h: 1200 },
    displayed: { w: 800, h: 1200 },
    element: "img",
    priority: 0,
    pos: { docOrder: 0, srcGen: 0, yTop: 0 },
    strip: { stripId: first?.strip?.stripId ?? "", index: 0 },
    refPolicy: "no-referrer",
  });
  const second = h.discovery.describe("2.0");
  assert.equal(second?.src, "https://cdn.example/b@2x.jpg");
  assert.deepEqual(second?.strip, { stripId: first?.strip?.stripId ?? "?", index: 1 });
  assert.deepEqual(second?.pos, { docOrder: 1, srcGen: 0, yTop: 1203 });
  assert.equal("strip" in (h.discovery.describe("3.0") ?? {}), false);
  assert.equal(h.discovery.describe("9.9"), null);
});

test("findBySrc: matches srcset candidates and tracks a small image when explicitly asked", () => {
  const h = harness();
  const small = h.img({ top: 0, width: 120, height: 120, natural: [240, 240] });
  small.src = "https://cdn.example/s.jpg";
  small.currentSrc = small.src;
  small.srcset = "s-2x.jpg 2x";
  h.discovery.start();
  assert.deepEqual(h.candidates, []);
  const found = h.discovery.findBySrc("https://reader.example/s-2x.jpg");
  assert.equal(found?.imageKey, "1.0");
  assert.deepEqual(h.candidates, ["1.0"]);
  assert.equal(h.discovery.findBySrc("https://reader.example/s-2x.jpg")?.imageKey, "1.0", "same key again");
  assert.equal(h.discovery.findBySrc("https://cdn.example/none.jpg"), null);
  h.win.fire("resize");
  h.timers.advance(DEFAULT_SETTINGS.discovery.mutationDebounceMs);
  assert.deepEqual(h.removed, [], "a forced image survives a rescan");
  assert.equal(h.resized, 1);
});

test("destroy disconnects observers and listeners; nothing fires afterwards", () => {
  const h = harness();
  const a = h.img({ top: 0 });
  h.discovery.start();
  h.discovery.destroy();
  assert.equal(h.mutations().disconnected, true);
  assert.equal(h.intersections().observed.size, 0);
  assert.equal(h.doc.listeners.get("load")?.size ?? 0, 0);
  assert.equal(h.doc.listeners.get("scroll")?.size ?? 0, 0);
  assert.equal(h.win.listeners.get("resize")?.size ?? 0, 0);
  h.doc.fire("load", a);
  h.doc.fire("scroll", h.doc);
  h.timers.advance(10_000);
  assert.deepEqual(h.candidates, ["1.0"]);
  assert.equal(h.viewports.length, 0);
  assert.equal(h.discovery.findBySrc(a.src), null);
});

/* ------------------------------------------------------------------ tier B: lazy images ahead */

test("tier B: lazy images below the viewport, in the reading column, on a comic host, inside the detect horizon", () => {
  const h = harness({ prefetch: true });
  h.img({ top: 0 }); // loaded: the reading column and the host
  const near = h.lazy({
    top: 1200,
    attrs: { "data-src": "/lazy/2.jpg", srcset: "https://cdn.example/2@2x.jpg 2x" },
  });
  near.attrs.set("data-src", "https://cdn.example/2.jpg");
  const second = h.lazy({ top: 2400 });
  const far = h.lazy({ top: 9000 });
  h.lazy({ top: 3600, attrs: { "data-src": "https://ads.example/banner.jpg" } }); // another host
  h.lazy({ top: 4800, left: 500, width: 300 }); // not in the column
  h.lazy({ top: 6000, height: 100 }); // too small
  h.discovery.setHorizon({ screens: 3, maxImages: 25 });
  h.discovery.start();
  h.timers.advance(300);
  assert.deepEqual(
    h.candidates,
    ["1.0", "2.0", "3.0"],
    "priority 1.2 and 2.4 are inside 3 screens; 9 is not",
  );
  const base = h.discovery.describe("2.0");
  assert.deepEqual(
    {
      natural: base?.natural,
      prefetch: base?.prefetch,
      src: base?.src,
      altSrcs: base?.altSrcs,
      priority: base?.priority,
    },
    {
      natural: null,
      prefetch: true,
      src: "https://cdn.example/2.jpg",
      altSrcs: ["https://cdn.example/2@2x.jpg"],
      priority: 1.2,
    },
  );
  assert.equal(h.discovery.describe("3.0")?.src, `https://cdn.example/lazy-${second.order}.jpg`);
  assert.equal(h.discovery.describe("1.0")?.prefetch, undefined, "a loaded image is no prefetch");
  h.timers.advance(300);
  assert.ok(
    h.viewports.at(-1)?.priorities.some((p) => p.imageKey === "2.0"),
    "tier B images get priorities",
  );
  // A longer horizon brings the far one in; maxImages counts every image ahead.
  h.discovery.setHorizon({ screens: 50, maxImages: 25 });
  h.timers.advance(300);
  assert.deepEqual(h.candidates, ["1.0", "2.0", "3.0", "4.0"]);
  assert.equal(h.discovery.get("4.0")?.element, far);
});

test("tier B: off unless enabled, needs a loaded image, never above or on screen, and honours maxImages", () => {
  let h = harness();
  h.img({ top: 0 });
  h.lazy({ top: 1200 });
  h.discovery.start();
  h.timers.advance(300);
  assert.deepEqual(h.candidates, ["1.0"], "prefetch option off");

  h = harness({ prefetch: true });
  h.lazy({ top: 1200 });
  h.discovery.start();
  h.timers.advance(300);
  assert.deepEqual(h.candidates, [], "no loaded image: no column, no host");

  h = harness({ prefetch: true });
  h.img({ top: 3000 });
  h.lazy({ top: 0 }); // above after scrolling
  h.lazy({ top: 3600, height: 300 }); // on screen after scrolling (the page loads it itself)
  h.lazy({ top: 4200 });
  h.lazy({ top: 5400 });
  h.win.scrollY = 3000;
  h.discovery.setHorizon({ screens: 50, maxImages: 2 });
  h.discovery.start();
  h.timers.advance(300);
  assert.deepEqual(h.candidates, ["1.0", "2.0"], "only the first image below: the loaded one takes a place");
  assert.equal(h.discovery.describe("2.0")?.pos.yTop, 4200);
});

test("tier B: the page loading the prefetched URL keeps the key and fires onLoaded; another URL is a new picture", () => {
  const h = harness({ prefetch: true });
  h.img({ top: 0 });
  const lazy = h.lazy({ top: 1200, attrs: { "data-src": "https://cdn.example/p2.jpg" } });
  const other = h.lazy({ top: 2400, attrs: { "data-src": "https://cdn.example/p3.jpg" } });
  h.discovery.setHorizon({ screens: 5, maxImages: 25 });
  h.discovery.start();
  h.timers.advance(300);
  assert.deepEqual(h.candidates, ["1.0", "2.0", "3.0"]);
  // A lazy loader copies data-src into src: same picture, still loading.
  lazy.src = "https://cdn.example/p2.jpg";
  h.mutations().trigger([{ type: "attributes", target: lazy, attributeName: "src" }]);
  h.doc.fire("load", lazy); // a load event before the pixels: still waiting
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.loaded, []);
  lazy.naturalWidth = 800;
  lazy.naturalHeight = 1200;
  lazy.currentSrc = "https://cdn.example/p2.jpg";
  h.doc.fire("load", lazy);
  assert.deepEqual(h.loaded, ["2.0"]);
  assert.deepEqual(h.candidates, ["1.0", "2.0", "3.0"], "no new key");
  const loaded = h.discovery.describe("2.0");
  assert.equal(loaded?.prefetch, undefined);
  assert.deepEqual(loaded?.natural, { w: 800, h: 1200 });
  assert.equal(loaded?.src, "https://cdn.example/p2.jpg");
  // Something else put into the second one: the prefetched picture is gone.
  other.src = "https://cdn.example/elsewhere.jpg";
  h.mutations().trigger([{ type: "attributes", target: other, attributeName: "src" }]);
  assert.deepEqual(h.removed, ["3.0"]);
});
