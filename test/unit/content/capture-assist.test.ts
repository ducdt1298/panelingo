// Content side of the screen capture: refusals, hiding only that image's overlay, scrolling the image (or a tile) into
// the capture window, two animation frames, cap:ready geometry, restoring overlay and scroll, reader interruptions,
// and reader iframes (the offset chain: top-viewport geometry, clip, reveal through the parents, "frame" refusals).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRAMES_FALLBACK_MS,
  SESSION_EXPIRY_MS,
  captureRetryWanted,
  contentBox,
  createCaptureAssist,
  prepareDelta,
  type CaptureAssist,
  type CaptureWindow,
} from "../../../src/content/capture-assist.ts";
import type { ImageElement } from "../../../src/content/contracts.ts";
import type { FrameChain, FrameGeometry, RevealRequest } from "../../../src/content/frame-chain.ts";
import { createLogger } from "../../../src/platform/log.ts";
import type { CsToEngine } from "../../../src/shared/protocol.ts";

const NO_BOX = {
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
};

test("contentBox, prepareDelta and captureRetryWanted", () => {
  assert.deepEqual(
    contentBox(
      { left: 10, top: 20, width: 300, height: 200 },
      {
        ...NO_BOX,
        borderLeftWidth: "2px",
        paddingLeft: "3px",
        paddingTop: "4.5px",
        borderBottomWidth: "1px",
      },
    ),
    { left: 15, top: 24.5, width: 295, height: 194.5 },
  );
  const view = { w: 1280, h: 900 };
  assert.deepEqual(prepareDelta({ left: 0, top: 600, width: 800, height: 500 }, view, undefined), {
    dx: 0,
    dy: 200,
  });
  assert.deepEqual(
    prepareDelta({ left: 0, top: -50, width: 800, height: 1800 }, view, undefined),
    { dx: 0, dy: 0 },
    "tall: the tiles do it",
  );
  assert.deepEqual(
    prepareDelta({ left: 0, top: -50, width: 800, height: 1800 }, view, { top: 504, height: 630 }),
    { dx: 0, dy: 319 },
  );
  assert.deepEqual(
    prepareDelta({ left: 30, top: 10, width: 2000, height: 500 }, view, {
      top: 0,
      height: 500,
      left: 700,
      width: 896,
    }),
    { dx: 30 + 700 - 192, dy: 0 },
    "a column of a wide image goes to 15% of the width",
  );
  const unavailable = (detail: string) => ({
    code: "image.capture_unavailable" as const,
    message: "",
    retryable: true,
    detail,
  });
  assert.equal(captureRetryWanted(unavailable("offscreen")), true);
  assert.equal(captureRetryWanted(unavailable("interrupted")), true);
  assert.equal(captureRetryWanted(unavailable("timeout")), true);
  assert.equal(captureRetryWanted(unavailable("quota")), false);
  assert.equal(
    captureRetryWanted({ code: "image.capture_blocked", message: "", retryable: false, detail: "hidden" }),
    false,
  );
  assert.equal(captureRetryWanted(null), false);
});

/* ------------------------------------------------------------------ fake DOM */

class FakeStyle {
  readonly props = new Map<string, { value: string; priority: string }>();
  getPropertyValue(name: string): string {
    return this.props.get(name)?.value ?? "";
  }
  getPropertyPriority(name: string): string {
    return this.props.get(name)?.priority ?? "";
  }
  setProperty(name: string, value: string, priority = ""): void {
    this.props.set(name, { value, priority });
  }
  removeProperty(name: string): void {
    this.props.delete(name);
  }
}

class FakeNode {
  parentElement: FakeNode | null = null;
  isConnected = true;
  overflowY = "visible";
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  clientHeight = 0;
  readonly scrolls: number[] = [];
  readonly style = new FakeStyle();
  readonly attrs = new Map<string, string>();
  /** Page box (CSS px) at scroll 0. */
  box = { left: 0, top: 0, width: 0, height: 0 };
  readonly win: FakeWin;
  readonly localName: string;
  constructor(win: FakeWin, localName = "div") {
    this.win = win;
    this.localName = localName;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  scrollTo(options: { top: number; left: number }): void {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    this.scrollTop = Math.min(max, Math.max(0, options.top));
    this.scrolls.push(this.scrollTop);
  }
  /** Scroll offset of every scrolling ancestor. */
  private ancestorsScroll(): number {
    let sum = 0;
    for (let node = this.parentElement; node !== null; node = node.parentElement) sum += node.scrollTop;
    return sum;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return {
      left: this.box.left - this.win.scrollX,
      top: this.box.top - this.win.scrollY - this.ancestorsScroll(),
      width: this.box.width,
      height: this.box.height,
    };
  }
}

class FakeWin {
  innerWidth = 1280;
  innerHeight = 900;
  devicePixelRatio = 1;
  scrollX = 0;
  scrollY = 0;
  readonly scrolls: number[] = [];
  readonly scrollsX: number[] = [];
  readonly frames: Array<() => void> = [];
  readonly listeners = new Map<string, Set<() => void>>();
  rafWorks = true;
  scrollTo(options: { top: number; left: number }): void {
    if (options.top !== this.scrollY) {
      this.scrollY = Math.max(0, options.top);
      this.scrolls.push(this.scrollY);
    }
    if (options.left !== this.scrollX) {
      this.scrollX = Math.max(0, options.left);
      this.scrollsX.push(this.scrollX);
    }
  }
  requestAnimationFrame(cb: () => void): number {
    if (this.rafWorks) this.frames.push(cb);
    return 1;
  }
  /** Runs the queued animation frames (and the ones they queue). */
  async paint(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      for (const cb of this.frames.splice(0)) cb();
      await Promise.resolve();
    }
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  getComputedStyle(el: FakeNode): typeof NO_BOX & { overflowY: string } {
    return { ...NO_BOX, overflowY: el.overflowY };
  }
}

class ManualTimers {
  now = 0;
  readonly timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.now + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms: number): void {
    this.now += ms;
    for (const timer of this.timers) {
      if (timer.live && timer.at <= this.now) {
        timer.live = false;
        timer.fn();
      }
    }
  }
}

interface Rig {
  win: FakeWin;
  doc: { visibilityState: string };
  timers: ManualTimers;
  image: FakeNode;
  host: FakeNode;
  otherHost: FakeNode;
  posts: CsToEngine[];
  assist: CaptureAssist;
}

function rig(options: { win?: boolean; nested?: boolean; chain?: FrameChain } = {}): Rig {
  const win = new FakeWin();
  const root = new FakeNode(win, "html");
  const body = new FakeNode(win, "body");
  body.parentElement = root;
  const image = new FakeNode(win, "canvas");
  image.box = { left: 40, top: 700, width: 1200, height: 800 };
  if (options.nested === true) {
    const scroller = new FakeNode(win);
    scroller.parentElement = body;
    scroller.overflowY = "auto";
    scroller.scrollHeight = 5000;
    scroller.clientHeight = 900;
    image.parentElement = scroller;
  } else {
    image.parentElement = body;
  }
  const host = new FakeNode(win);
  host.attrs.set("data-ctv-host", "o1");
  host.attrs.set("data-ctv-image", "1.0");
  host.style.setProperty("opacity", "0.9");
  const otherHost = new FakeNode(win);
  otherHost.attrs.set("data-ctv-host", "o1");
  otherHost.attrs.set("data-ctv-image", "2.0");
  const doc = {
    visibilityState: "visible",
    documentElement: root,
    body,
    querySelectorAll: (selector: string) => (selector === "[data-ctv-host]" ? [host, otherHost] : []),
  };
  const timers = new ManualTimers();
  const posts: CsToEngine[] = [];
  const assist = createCaptureAssist({
    doc: doc as unknown as Document,
    win: options.win === false ? null : (win as unknown as CaptureWindow),
    timers,
    elementOf: (imageKey) => (imageKey === "1.0" ? (image as unknown as ImageElement) : null),
    post: (message) => {
      posts.push(message);
      return true;
    },
    log: createLogger("cs", { minLevel: "error", sinks: [] }),
    ...(options.chain === undefined ? {} : { chain: options.chain }),
  });
  return { win, doc, timers, image, host, otherHost, posts, assist };
}

async function turns(n = 20): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

test("refusals: hidden page, no window, unknown element, an image the reader cannot see (never scrolled to)", async () => {
  let r = rig();
  r.doc.visibilityState = "hidden";
  r.assist.prepare({ reqId: "a", imageKey: "1.0" });
  assert.deepEqual(r.posts, [{ type: "cap:fail", reqId: "a", reason: "hidden" }]);
  r = rig({ win: false });
  r.assist.prepare({ reqId: "b", imageKey: "1.0" });
  assert.deepEqual(r.posts, [{ type: "cap:fail", reqId: "b", reason: "not-visible" }]);
  r = rig();
  r.assist.prepare({ reqId: "c", imageKey: "9.9" });
  assert.deepEqual(r.posts, [{ type: "cap:fail", reqId: "c", reason: "not-visible" }]);
  r = rig();
  r.image.box.top = 2000;
  r.assist.prepare({ reqId: "d", imageKey: "1.0" });
  await turns();
  assert.deepEqual(r.posts, [{ type: "cap:fail", reqId: "d", reason: "not-visible" }]);
  assert.deepEqual(r.win.scrolls, [], "no scrolling toward it");
  assert.equal(r.host.style.getPropertyValue("opacity"), "0.9", "its overlay untouched");
  assert.equal(r.assist.active, false);
});

test("a fitting image half in view: overlay of that image hidden, scrolled in, two frames, cap:ready; done restores", async () => {
  const r = rig();
  r.assist.prepare({ reqId: "s1", imageKey: "1.0" });
  await turns();
  assert.equal(r.host.style.getPropertyValue("opacity"), "0");
  assert.equal(r.host.style.getPropertyPriority("opacity"), "important");
  assert.equal(r.otherHost.style.getPropertyValue("opacity"), "", "other images keep their overlay");
  assert.deepEqual(r.win.scrolls, [600], "700 + 800 - 900: the bottom comes into view");
  assert.equal(r.assist.active, true);
  assert.deepEqual(r.posts, [], "waits for two animation frames");
  await r.win.paint();
  assert.deepEqual(r.posts, [
    {
      type: "cap:ready",
      reqId: "s1",
      rect: { left: 40, top: 100, width: 1200, height: 800 },
      viewport: { w: 1280, h: 900 },
      dpr: 1,
    },
  ]);
  r.assist.done({ reqId: "s1" });
  assert.equal(r.host.style.getPropertyValue("opacity"), "0.9", "the overlay is back with its own value");
  assert.deepEqual(r.win.scrolls, [600, 0], "and the reader's scroll position");
  assert.equal(r.assist.active, false);
});

test("bands of a tall image are scrolled to the capture window, inside a scrolling container when there is one", async () => {
  const r = rig({ nested: true });
  r.image.box = { left: 40, top: 100, width: 1200, height: 1800 };
  r.assist.prepare({ reqId: "s2", imageKey: "1.0" });
  await r.win.paint();
  assert.equal(r.posts.at(-1)?.type, "cap:ready");
  r.assist.prepare({ reqId: "s2", imageKey: "1.0", band: { top: 504, height: 630 } });
  await r.win.paint();
  const ready = r.posts.at(-1);
  assert.ok(ready?.type === "cap:ready");
  assert.equal(ready.rect.top + 504, 135, "the band starts 15% below the viewport top");
  const scroller = r.image.parentElement;
  assert.deepEqual(scroller?.scrolls, [469], "the container scrolled, not the window");
  assert.deepEqual(r.win.scrolls, []);
  r.assist.done({ reqId: "s2" });
  assert.deepEqual(scroller?.scrolls, [469, 0]);
});

test("the reader scrolls or presses a key: cap:fail moved at once, and the scroll position is theirs", async () => {
  const r = rig();
  r.assist.prepare({ reqId: "s3", imageKey: "1.0" });
  await turns();
  await r.win.paint();
  r.win.fire("wheel");
  r.win.fire("keydown");
  assert.deepEqual(
    r.posts.filter((m) => m.type === "cap:fail"),
    [{ type: "cap:fail", reqId: "s3", reason: "moved" }],
    "once",
  );
  r.assist.prepare({ reqId: "s3", imageKey: "1.0", band: { top: 0, height: 630 } });
  assert.deepEqual(r.posts.at(-1), { type: "cap:fail", reqId: "s3", reason: "moved" });
  r.assist.done({ reqId: "s3" });
  assert.deepEqual(r.win.scrolls, [600], "not scrolled back");
  assert.equal(r.host.style.getPropertyValue("opacity"), "0.9");
  assert.equal(r.win.listeners.get("wheel")?.size ?? 0, 0, "listeners removed");
});

test("no animation frames: the fallback timer answers; no word from the engine: the session expires", async () => {
  const r = rig();
  r.win.rafWorks = false;
  r.image.box.top = 100;
  r.assist.prepare({ reqId: "s4", imageKey: "1.0" });
  await r.win.paint();
  assert.equal(r.posts.length, 0);
  r.timers.advance(FRAMES_FALLBACK_MS);
  await r.win.paint();
  assert.equal(r.posts.at(-1)?.type, "cap:ready");
  r.timers.advance(SESSION_EXPIRY_MS);
  assert.equal(r.assist.active, false);
  assert.equal(r.host.style.getPropertyValue("opacity"), "0.9");
  const s = rig();
  s.image.box.top = 100;
  s.assist.prepare({ reqId: "s5", imageKey: "1.0" });
  s.assist.destroy();
  assert.equal(s.host.style.getPropertyValue("opacity"), "0.9", "teardown restores too");
  await s.win.paint();
  assert.deepEqual(s.posts, [], "a destroyed assist answers nothing more");
});

test("a wide image: a column tile scrolls the window sideways to 15% of its width", async () => {
  const r = rig();
  r.win.innerWidth = 800;
  r.image.box = { left: 40, top: 100, width: 1200, height: 600 };
  r.assist.prepare({ reqId: "w1", imageKey: "1.0" });
  await turns();
  await r.win.paint();
  assert.deepEqual(r.win.scrollsX, [], "wider than the window: no sideways move before the tiles");
  r.assist.prepare({ reqId: "w1", imageKey: "1.0", band: { top: 0, height: 600, left: 448, width: 560 } });
  await turns();
  await r.win.paint();
  const ready = r.posts.at(-1);
  assert.ok(ready?.type === "cap:ready");
  assert.equal(ready.rect.left + 448, 120, "the column starts at 15% of 800");
  assert.deepEqual(r.win.scrollsX, [40 + 448 - 120]);
  r.assist.done({ reqId: "w1" });
  assert.deepEqual(r.win.scrollsX, [368, 0], "scrolled back");
});

/* ------------------------------------------------------------------ reader iframes */

class FakeChain implements FrameChain {
  readonly isTop = false;
  geometry: FrameGeometry | null = {
    frame: { left: 100, top: 50, width: 1000, height: 700 },
    clip: { left: 100, top: 50, width: 1000, height: 600 },
    viewport: { w: 1280, h: 900 },
    dpr: 2,
  };
  readonly calls: Array<{ session?: string; reveal?: RevealRequest }> = [];
  readonly ended: string[] = [];
  readonly listeners = new Set<(session: string) => void>();
  newSession(): string {
    return "ab".repeat(8);
  }
  localView() {
    return { left: 0, top: 0, width: 1000, height: 700 };
  }
  locate(options: { session?: string; reveal?: RevealRequest } = {}): Promise<FrameGeometry | null> {
    this.calls.push(options);
    return Promise.resolve(this.geometry);
  }
  end(session: string): void {
    this.ended.push(session);
  }
  onMoved(listener: (session: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  destroy(): void {}
}

test("in a reader iframe: top-viewport rect and clip from the chain; the parents reveal the image; done ends the chain session", async () => {
  const chain = new FakeChain();
  const r = rig({ chain });
  r.image.box = { left: 40, top: 500, width: 600, height: 400 };
  r.assist.prepare({ reqId: "f1", imageKey: "1.0" });
  await turns();
  assert.equal(r.host.style.getPropertyValue("opacity"), "0");
  assert.deepEqual(r.win.scrolls, [200], "the frame's own document first: 500 + 400 - 700");
  await r.win.paint();
  await turns();
  assert.deepEqual(chain.calls[1], {
    session: "ab".repeat(8),
    reveal: { rect: { left: 40, top: 300, width: 600, height: 400 }, x: false, y: false },
  });
  assert.deepEqual(r.posts.at(-1), {
    type: "cap:ready",
    reqId: "f1",
    rect: { left: 140, top: 350, width: 600, height: 400 },
    viewport: { w: 1280, h: 900 },
    dpr: 2,
    clip: { left: 100, top: 50, width: 1000, height: 600 },
  });
  // A tile of it: the parents are asked to put that tile at their window start.
  r.assist.prepare({ reqId: "f1", imageKey: "1.0", band: { top: 100, height: 200 } });
  await turns();
  await r.win.paint();
  await turns();
  const reveal = chain.calls.filter((call) => call.reveal !== undefined).at(-1)?.reveal;
  assert.deepEqual([reveal?.x, reveal?.y, reveal?.rect.height], [false, true, 200]);
  r.assist.done({ reqId: "f1" });
  assert.deepEqual(chain.ended, ["ab".repeat(8)]);
  assert.equal(r.win.scrolls.at(-1), 0, "own scroll position restored");
});

test("in a reader iframe: no answer from the parents is a 'frame' refusal; an image outside the clip is not scrolled to", async () => {
  const chain = new FakeChain();
  chain.geometry = null;
  let r = rig({ chain });
  r.image.box.top = 100;
  r.assist.prepare({ reqId: "f2", imageKey: "1.0" });
  await turns();
  assert.deepEqual(r.posts, [{ type: "cap:fail", reqId: "f2", reason: "frame" }]);
  const hidden = new FakeChain();
  hidden.geometry = {
    ...(new FakeChain().geometry as FrameGeometry),
    clip: { left: 100, top: 50, width: 1000, height: 100 },
  };
  r = rig({ chain: hidden });
  r.image.box.top = 300; // below the 100 px the frame shows
  r.assist.prepare({ reqId: "f3", imageKey: "1.0" });
  await turns();
  assert.deepEqual(r.posts, [{ type: "cap:fail", reqId: "f3", reason: "not-visible" }]);
  assert.deepEqual(r.win.scrolls, []);
});

test("in a reader iframe: reader input in a parent frame ends the session as 'moved'", async () => {
  const chain = new FakeChain();
  const r = rig({ chain });
  r.image.box.top = 100;
  r.assist.prepare({ reqId: "f4", imageKey: "1.0" });
  await turns();
  await r.win.paint();
  await turns();
  for (const listener of chain.listeners) listener("cd".repeat(8)); // another session
  for (const listener of chain.listeners) listener("ab".repeat(8));
  assert.deepEqual(
    r.posts.filter((m) => m.type === "cap:fail"),
    [{ type: "cap:fail", reqId: "f4", reason: "moved" }],
  );
  r.assist.destroy();
  assert.equal(chain.listeners.size, 0);
});
