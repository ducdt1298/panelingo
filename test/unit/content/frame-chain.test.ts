// Offset chain for captures in reader iframes: message validation, geometry composition, nested frames answering
// through postMessage (content boxes, clips, reveal scrolling and its restore), and what is ignored (look-alike
// messages from other windows, wrong nonces, late answers).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAIN_SESSION_EXPIRY_MS,
  CHAIN_TAG,
  CHAIN_TIMEOUT_MS,
  childGeometry,
  createFrameChain,
  frameWindow,
  parseChainMessage,
  toTop,
  topGeometry,
  type FrameChain,
} from "../../../src/content/frame-chain.ts";
import { createLogger } from "../../../src/platform/log.ts";

const NONCE = "0123456789abcdef";
const SESSION = "fedcba9876543210";

test("parseChainMessage: only well-formed, bounded messages of the namespace", () => {
  assert.deepEqual(parseChainMessage({ tag: CHAIN_TAG, kind: "rect?", nonce: NONCE }), {
    tag: CHAIN_TAG,
    kind: "rect?",
    nonce: NONCE,
  });
  const reveal = { rect: { left: 1, top: -2, width: 3, height: 4 }, x: true, y: false };
  assert.deepEqual(
    parseChainMessage({ tag: CHAIN_TAG, kind: "rect?", nonce: NONCE, session: SESSION, reveal }),
    {
      tag: CHAIN_TAG,
      kind: "rect?",
      nonce: NONCE,
      session: SESSION,
      reveal,
    },
  );
  const geometry = {
    frame: { left: 0, top: 0, width: 10, height: 10 },
    clip: null,
    viewport: { w: 800, h: 600 },
    dpr: 1.5,
  };
  assert.deepEqual(parseChainMessage({ tag: CHAIN_TAG, kind: "rect", nonce: NONCE, geometry })?.kind, "rect");
  assert.deepEqual(parseChainMessage({ tag: CHAIN_TAG, kind: "rect", nonce: NONCE, geometry: null }), {
    tag: CHAIN_TAG,
    kind: "rect",
    nonce: NONCE,
    geometry: null,
  });
  assert.deepEqual(parseChainMessage({ tag: CHAIN_TAG, kind: "moved", session: SESSION }), {
    tag: CHAIN_TAG,
    kind: "moved",
    session: SESSION,
  });
  const bad: unknown[] = [
    null,
    "text",
    { tag: "other", kind: "rect?", nonce: NONCE },
    { tag: CHAIN_TAG, kind: "rect?", nonce: "short" },
    { tag: CHAIN_TAG, kind: "rect?", nonce: NONCE.toUpperCase() },
    { tag: CHAIN_TAG, kind: "rect?", nonce: NONCE, reveal },
    { tag: CHAIN_TAG, kind: "rect?", nonce: NONCE, session: SESSION, reveal: { ...reveal, x: 1 } },
    {
      tag: CHAIN_TAG,
      kind: "rect?",
      nonce: NONCE,
      session: SESSION,
      reveal: { ...reveal, rect: { left: Number.NaN, top: 0, width: 1, height: 1 } },
    },
    { tag: CHAIN_TAG, kind: "rect", nonce: NONCE, geometry: { ...geometry, dpr: 99 } },
    { tag: CHAIN_TAG, kind: "rect", nonce: NONCE, geometry: { ...geometry, viewport: { w: 0, h: 600 } } },
    {
      tag: CHAIN_TAG,
      kind: "rect",
      nonce: NONCE,
      geometry: { ...geometry, frame: { left: 1e9, top: 0, width: 1, height: 1 } },
    },
    { tag: CHAIN_TAG, kind: "rect", nonce: NONCE, geometry: { ...geometry, clip: { left: 0 } } },
    { tag: CHAIN_TAG, kind: "end" },
    { tag: CHAIN_TAG, kind: "launch", session: SESSION },
  ];
  for (const value of bad) assert.equal(parseChainMessage(value), null, JSON.stringify(value));
});

test("geometry: a child's viewport and clip in top-level px, through two levels", () => {
  const top = topGeometry({ w: 1280, h: 900 }, 2);
  assert.deepEqual(top.frame, { left: 0, top: 0, width: 1280, height: 900 });
  const middle = childGeometry(top, { left: 100, top: 700, width: 800, height: 600 });
  assert.deepEqual(middle.frame, { left: 100, top: 700, width: 800, height: 600 });
  assert.deepEqual(middle.clip, { left: 100, top: 700, width: 800, height: 200 }, "the top viewport cuts it");
  const leaf = childGeometry(middle, { left: 50, top: -100, width: 400, height: 500 });
  assert.deepEqual(leaf.frame, { left: 150, top: 600, width: 400, height: 500 });
  assert.deepEqual(leaf.clip, { left: 150, top: 700, width: 400, height: 200 });
  assert.deepEqual(toTop({ left: 10, top: 20, width: 5, height: 6 }, leaf), {
    left: 160,
    top: 620,
    width: 5,
    height: 6,
  });
  assert.deepEqual(frameWindow(leaf, { left: 0, top: 0, width: 385, height: 500 }), {
    left: 150,
    top: 700,
    width: 385,
    height: 200,
  });
  const gone = childGeometry(middle, { left: 0, top: 900, width: 100, height: 100 });
  assert.equal(gone.clip, null);
  assert.equal(frameWindow(gone, { left: 0, top: 0, width: 100, height: 100 }), null);
  assert.equal(topGeometry({ w: 10, h: 10 }, 0).dpr, 1);
});

/* ------------------------------------------------------------------ fake frames */

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

class Timers {
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

const NO_BOX = {
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  overflowX: "visible",
  overflowY: "visible",
};

class FakeIframe {
  readonly localName = "iframe";
  contentWindow: object | null = null;
  readonly parentElement: object;
  readonly frame: Frame;
  /** Border box in the frame's document (CSS px at scroll 0). */
  box: Box;
  border = 0;
  constructor(frame: Frame, box: Box) {
    this.frame = frame;
    this.box = box;
    this.parentElement = frame.body;
  }
  getBoundingClientRect(): Box {
    return {
      left: this.box.left - this.frame.win.scrollX,
      top: this.box.top - this.frame.win.scrollY,
      width: this.box.width,
      height: this.box.height,
    };
  }
}

class Frame {
  readonly name: string;
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly iframes: FakeIframe[] = [];
  readonly body = { parentElement: null as object | null };
  readonly root = { clientWidth: 0, clientHeight: 0 };
  readonly scrolls: number[] = [];
  readonly win: {
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
    parent: object;
    scrollTo(options: { top: number; left: number }): void;
    getComputedStyle(el: unknown): typeof NO_BOX;
    addEventListener(type: string, fn: (event: unknown) => void): void;
    removeEventListener(type: string, fn: (event: unknown) => void): void;
  };
  readonly doc: { documentElement: object; body: object; querySelectorAll(selector: string): FakeIframe[] };
  chain: FrameChain | null = null;

  constructor(name: string, view: { w: number; h: number }) {
    this.name = name;
    this.body.parentElement = this.root;
    this.root.clientWidth = view.w;
    this.root.clientHeight = view.h;
    const listeners = this.listeners;
    const scrolls = this.scrolls;
    const win = {
      innerWidth: view.w,
      innerHeight: view.h,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
      parent: {} as object,
      scrollTo(options: { top: number; left: number }) {
        win.scrollY = options.top;
        win.scrollX = options.left;
        scrolls.push(options.top);
      },
      getComputedStyle: (el: unknown) =>
        el instanceof FakeIframe && el.border > 0
          ? { ...NO_BOX, borderTopWidth: `${el.border}px`, borderLeftWidth: `${el.border}px` }
          : NO_BOX,
      addEventListener(type: string, fn: (event: unknown) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener(type: string, fn: (event: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
    };
    win.parent = win;
    this.win = win;
    this.doc = {
      documentElement: this.root,
      body: this.body,
      querySelectorAll: (selector: string) => (selector === "iframe, frame" ? this.iframes : []),
    };
  }

  deliver(data: unknown, source: object): void {
    const copy = structuredClone(data);
    setImmediate(() => {
      for (const fn of [...(this.listeners.get("message") ?? [])]) fn({ data: copy, source });
    });
  }

  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({});
  }
}

/** Each side sees its own identity for the other, like WindowProxy objects across frames. */
function link(parent: Frame, child: Frame, box: Box): FakeIframe {
  const childSeenByParent = { postMessage: (data: unknown) => child.deliver(data, parentSeenByChild) };
  const parentSeenByChild = { postMessage: (data: unknown) => parent.deliver(data, childSeenByParent) };
  child.win.parent = parentSeenByChild;
  const el = new FakeIframe(parent, box);
  el.contentWindow = childSeenByParent;
  parent.iframes.push(el);
  return el;
}

let tokens = 0;

function start(frame: Frame, timers: Timers): FrameChain {
  frame.chain = createFrameChain({
    win: frame.win as unknown as Window,
    doc: frame.doc as unknown as Document,
    timers,
    log: createLogger("cs", { minLevel: "error", sinks: [] }),
    token: () => (++tokens).toString(16).padStart(16, "0"),
  });
  return frame.chain;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface World {
  timers: Timers;
  top: Frame;
  middle: Frame;
  leaf: Frame;
  middleEl: FakeIframe;
  leafEl: FakeIframe;
}

/** A reader page (1280×900) with a cross-origin frame (800×600, 2 px border) holding another frame (400×300). */
function world(): World {
  const timers = new Timers();
  const top = new Frame("top", { w: 1280, h: 900 });
  const middle = new Frame("middle", { w: 800, h: 600 });
  const leaf = new Frame("leaf", { w: 400, h: 300 });
  const middleEl = link(top, middle, { left: 100, top: 200, width: 804, height: 604 });
  middleEl.border = 2;
  const leafEl = link(middle, leaf, { left: 50, top: 60, width: 400, height: 300 });
  for (const frame of [top, middle, leaf]) start(frame, timers);
  return { timers, top, middle, leaf, middleEl, leafEl };
}

test("a nested frame learns where it sits: each parent adds its iframe's content box and clips it", async () => {
  const w = world();
  assert.equal(w.top.chain?.isTop, true);
  assert.equal(w.leaf.chain?.isTop, false);
  const pending = w.leaf.chain?.locate();
  await settle();
  const geometry = await pending;
  assert.deepEqual(geometry, {
    frame: { left: 152, top: 262, width: 400, height: 300 },
    clip: { left: 152, top: 262, width: 400, height: 300 },
    viewport: { w: 1280, h: 900 },
    dpr: 1,
  });
  w.top.win.scrollY = 500; // the reader page scrolled: the frame is cut by the top viewport
  const later = w.leaf.chain?.locate();
  await settle();
  assert.deepEqual((await later)?.clip, { left: 152, top: 0, width: 400, height: 62 });
  assert.deepEqual(await w.top.chain?.locate(), topGeometry({ w: 1280, h: 900 }, 1));
});

test("reveal: every parent scrolls the frame so the rect lands in its window; end puts them back", async () => {
  const w = world();
  // A rect near the bottom of the leaf's viewport, which itself is far down the reader page.
  w.middleEl.box = { left: 100, top: 1500, width: 804, height: 604 };
  const reveal = { rect: { left: 10, top: 250, width: 100, height: 40 }, x: false, y: true };
  const pending = w.leaf.chain?.locate({ session: SESSION, reveal });
  await settle();
  const geometry = await pending;
  // In the middle frame the rect is at 60 + 250 = 310: put at 15% of 600 = 90 → scroll 220.
  assert.deepEqual(w.middle.scrolls, [220]);
  // In the top frame it is then at 1502 + 90 = 1592: put at 15% of 900 = 135 → scroll 1457.
  assert.deepEqual(w.top.scrolls, [1457]);
  const rectTop = toTop(reveal.rect, geometry ?? topGeometry({ w: 1, h: 1 }, 1)).top;
  assert.equal(rectTop, 135, "the rect is at the window start of the top viewport");
  w.leaf.chain?.end(SESSION);
  await settle();
  assert.deepEqual(w.middle.scrolls, [220, 0]);
  assert.deepEqual(w.top.scrolls, [1457, 0]);
});

test("reader input in a parent during a session reaches the frame as 'moved'; its scroll stays", async () => {
  const w = world();
  const moved: string[] = [];
  w.leaf.chain?.onMoved((session) => moved.push(session));
  w.middleEl.box = { left: 100, top: 1500, width: 804, height: 604 };
  const pending = w.leaf.chain?.locate({
    session: SESSION,
    reveal: { rect: { left: 0, top: 0, width: 50, height: 50 }, x: false, y: false },
  });
  await settle();
  await pending;
  w.top.fire("wheel");
  await settle();
  assert.deepEqual(moved, [SESSION]);
  const scrolled = w.top.win.scrollY;
  w.leaf.chain?.end(SESSION);
  await settle();
  assert.equal(w.top.win.scrollY, scrolled, "the reader's scroll position is kept");
});

test("look-alike messages are ignored: a request from a window that is not a child, answers that are not awaited", async () => {
  const w = world();
  // A page script in the top frame posts a request: the top frame never answers itself.
  const answers: unknown[] = [];
  w.top.win.addEventListener("message", (event) => answers.push((event as { data: unknown }).data));
  w.top.deliver({ tag: CHAIN_TAG, kind: "rect?", nonce: NONCE }, w.top.win);
  await settle();
  assert.equal(answers.filter((a) => (a as { kind?: string }).kind === "rect").length, 0);
  // A forged answer to the leaf: from its own window (not its parent), and with a nonce it never sent.
  const pending = w.leaf.chain?.locate();
  const forged = {
    tag: CHAIN_TAG,
    kind: "rect",
    nonce: "00000000000000ff",
    geometry: topGeometry({ w: 10, h: 10 }, 1),
  };
  w.leaf.deliver(forged, w.leaf.win);
  w.leaf.deliver({ ...forged, nonce: (tokens + 1).toString(16).padStart(16, "0") }, w.leaf.win);
  await settle();
  const real = await pending;
  assert.equal(real?.viewport.w, 1280, "only the real parent's answer counts");
});

test("no parent content script: the frame gives up after the timeout; destroy answers pending calls and restores", async () => {
  const timers = new Timers();
  const parent = new Frame("parent", { w: 1280, h: 900 });
  const orphan = new Frame("orphan", { w: 400, h: 300 });
  link(parent, orphan, { left: 0, top: 0, width: 400, height: 300 });
  const chain = start(orphan, timers); // the parent runs no chain
  const pending = chain.locate();
  await settle();
  timers.advance(CHAIN_TIMEOUT_MS);
  assert.equal(await pending, null);
  const again = chain.locate();
  chain.destroy();
  assert.equal(await again, null);
  assert.equal(await chain.locate(), null);

  const w = world();
  w.middleEl.box = { left: 100, top: 1500, width: 804, height: 604 };
  const revealed = w.leaf.chain?.locate({
    session: SESSION,
    reveal: { rect: { left: 0, top: 0, width: 50, height: 50 }, x: false, y: false },
  });
  await settle();
  await revealed;
  assert.ok(w.top.win.scrollY > 0);
  w.timers.advance(CHAIN_SESSION_EXPIRY_MS);
  assert.equal(w.top.win.scrollY, 0, "a session nobody ends is put back after the expiry");
});
