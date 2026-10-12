// Bubble popup gestures: client ↔ natural geometry, picking the innermost painted unit, the long-press state machine,
// and the window capture listeners (Alt+click and long-press open the popup and cancel the page's click; ordinary
// clicks pass through; Escape and a press outside close it).
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  boxToRect,
  containsPoint,
  createLongPress,
  createPopupGestures,
  naturalToClient,
  pickHit,
} from "../../../../src/content/overlay/gestures.ts";
import type { GestureEvent, GestureTarget } from "../../../../src/content/overlay/gestures.ts";
import type { Box } from "../../../../src/shared/types.ts";

const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });

/** Timers driven by hand. */
class Timers {
  now = 0;
  readonly pending = new Set<{ at: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.now + ms, fn };
    this.pending.add(timer);
    return () => {
      this.pending.delete(timer);
    };
  };

  advance(ms: number): void {
    this.now += ms;
    for (const timer of [...this.pending].sort((x, y) => x.at - y.at)) {
      if (timer.at > this.now) continue;
      this.pending.delete(timer);
      timer.fn();
    }
  }
}

describe("geometry", () => {
  test("natural px → client px through the layer's client rect (scale and offset)", () => {
    const layer = { left: 100, top: -50, width: 600, height: 900 };
    assert.deepEqual(
      naturalToClient(b(0, 0, 1200, 1800), layer, { w: 1200, h: 1800 }),
      b(100, -50, 700, 850),
    );
    assert.deepEqual(
      naturalToClient(b(200, 300, 400, 600), layer, { w: 1200, h: 1800 }),
      b(200, 100, 300, 250),
    );
    assert.deepEqual(boxToRect(b(200, 100, 300, 250)), { left: 200, top: 100, width: 100, height: 150 });
    const degenerate = naturalToClient(b(10, 10, 20, 20), layer, { w: 0, h: 0 });
    assert.deepEqual(degenerate, b(100, -50, 100, -50), "no natural size: an empty box that nothing hits");
  });

  test("pickHit: the box under the point, the smallest one where boxes overlap", () => {
    const panel = { target: "panel", box: b(0, 0, 500, 500) };
    const caption = { target: "caption", box: b(100, 100, 200, 150) };
    const other = { target: "other", box: b(600, 0, 700, 100) };
    assert.equal(pickHit({ x: 150, y: 120 }, [panel, caption, other])?.target, "caption");
    assert.equal(pickHit({ x: 300, y: 300 }, [panel, caption, other])?.target, "panel");
    assert.equal(pickHit({ x: 550, y: 50 }, [panel, caption, other]), null);
    assert.equal(pickHit({ x: 5, y: 5 }, [{ target: "flat", box: b(0, 0, 10, 0) }]), null);
    assert.equal(containsPoint(b(0, 0, 10, 10), { x: 10, y: 10 }), true, "edges count");
  });
});

describe("long press", () => {
  let timers: Timers;
  let fired: string[];
  beforeEach(() => {
    timers = new Timers();
    fired = [];
  });
  const make = () => createLongPress<string>({ setTimer: timers.setTimer, onFire: (t) => fired.push(t) });

  test(`fires after ${LONG_PRESS_MS} ms held still; end() then reports it`, () => {
    const press = make();
    press.start(1, 100, 100, "u1");
    assert.equal(press.pending, true);
    timers.advance(LONG_PRESS_MS - 1);
    assert.deepEqual(fired, []);
    timers.advance(1);
    assert.deepEqual(fired, ["u1"]);
    assert.equal(press.pending, false);
    assert.equal(press.end(1), true);
  });

  test(`moving more than ${LONG_PRESS_SLOP_PX} px cancels; small jitter does not`, () => {
    const press = make();
    press.start(1, 100, 100, "u1");
    press.move(1, 105, 105); // 7.07 px
    timers.advance(LONG_PRESS_MS);
    assert.deepEqual(fired, ["u1"]);
    press.start(2, 100, 100, "u2");
    press.move(2, 100, 109);
    assert.equal(press.pending, false);
    timers.advance(LONG_PRESS_MS);
    assert.deepEqual(fired, ["u1"]);
  });

  test("releasing early is an ordinary click; other pointers do not interfere", () => {
    const press = make();
    press.start(1, 0, 0, "u1");
    press.move(9, 500, 500);
    assert.equal(press.end(9), false);
    assert.equal(press.pending, true, "another pointer's move or up leaves the press alone");
    timers.advance(100);
    assert.equal(press.end(1), false);
    timers.advance(LONG_PRESS_MS);
    assert.deepEqual(fired, []);
  });

  test("flush fires a pending press at once (touch context menu); a new press replaces the old one", () => {
    const press = make();
    press.start(1, 0, 0, "old");
    press.start(2, 0, 0, "new");
    timers.advance(LONG_PRESS_MS);
    assert.deepEqual(fired, ["new"]);
    press.start(3, 0, 0, "menu");
    assert.equal(press.flush(), true);
    assert.equal(press.flush(), false);
    timers.advance(LONG_PRESS_MS);
    assert.deepEqual(fired, ["new", "menu"]);
    press.cancel();
    assert.equal(press.pending, false);
  });
});

/* ------------------------------------------------------------------ listeners */

interface FakeEvent extends GestureEvent {
  prevented: boolean;
  stopped: boolean;
}

function event(type: string, init: Partial<GestureEvent> & { path?: EventTarget[] } = {}): FakeEvent {
  const e: FakeEvent = {
    type,
    clientX: 150,
    clientY: 120,
    button: 0,
    pointerId: 1,
    isPrimary: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
    prevented: false,
    stopped: false,
    composedPath: () => init.path ?? [],
    preventDefault() {
      e.prevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
    stopImmediatePropagation() {
      e.stopped = true;
    },
  };
  return e;
}

class FakeWindow implements GestureTarget {
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  readonly capture: boolean[] = [];

  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void {
    this.capture.push(options?.capture === true);
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }

  dispatch(e: FakeEvent): FakeEvent {
    for (const listener of this.listeners.get(e.type) ?? []) listener(e as unknown as Event);
    return e;
  }

  count(): number {
    return [...this.listeners.values()].reduce((n, list) => n + list.length, 0);
  }
}

const POPUP = { popup: true } as unknown as EventTarget;
const BADGE = { badge: true } as unknown as EventTarget;

function rig(options: { altClick?: boolean } = {}) {
  const win = new FakeWindow();
  const timers = new Timers();
  const opened: string[] = [];
  const dismissed: string[] = [];
  let open = false;
  const units = [{ target: "u1", box: b(100, 100, 200, 150) }];
  const gestures = createPopupGestures<string>({
    win,
    altClick: options.altClick ?? true,
    hitTest: (x, y) => pickHit({ x, y }, units)?.target ?? null,
    onOpen: (target) => {
      opened.push(target);
      open = true;
    },
    isOwn: (e) => {
      const path = e.composedPath?.() ?? [];
      return path.includes(POPUP) || path.includes(BADGE);
    },
    inPopup: (e) => (e.composedPath?.() ?? []).includes(POPUP),
    isOpen: () => open,
    onDismiss: (reason) => {
      dismissed.push(reason);
      open = false;
    },
    setTimer: timers.setTimer,
  });
  return { win, timers, opened, dismissed, gestures, setOpen: (v: boolean) => (open = v) };
}

describe("popup gestures", () => {
  test("listeners run in the window's capture phase and go away on destroy", () => {
    const r = rig();
    assert.ok(r.win.count() >= 6);
    assert.ok(r.win.capture.every(Boolean));
    r.gestures.destroy();
    assert.equal(r.win.count(), 0);
  });

  test("Alt+click on a painted unit opens the popup; the page sees neither the press nor the click", () => {
    const r = rig();
    const down = r.win.dispatch(event("pointerdown", { altKey: true }));
    assert.deepEqual(r.opened, ["u1"]);
    assert.ok(down.prevented && down.stopped, "no focus change, no selection, no page mousedown");
    r.win.dispatch(event("pointerup", { altKey: true }));
    const click = r.win.dispatch(event("click", { altKey: true }));
    assert.ok(click.prevented, "no navigation and no Alt+click download");
    assert.ok(click.stopped);
    const next = r.win.dispatch(event("click"));
    assert.equal(next.prevented, false, "only that one click is cancelled");
  });

  test("an ordinary click on a painted unit passes through to the page", () => {
    const r = rig();
    const down = r.win.dispatch(event("pointerdown"));
    r.timers.advance(120);
    r.win.dispatch(event("pointerup"));
    const click = r.win.dispatch(event("click"));
    assert.deepEqual(r.opened, []);
    assert.ok(!down.prevented && !down.stopped && !click.prevented && !click.stopped);
  });

  test("Alt+click elsewhere, with popupWithAltClick off, or with another modifier is the page's", () => {
    const off = rig({ altClick: false });
    const a = off.win.dispatch(event("pointerdown", { altKey: true }));
    off.timers.advance(LONG_PRESS_MS * 2);
    assert.deepEqual(off.opened, [], "Alt held: not a long press either");
    assert.equal(a.prevented, false);
    const r = rig();
    const outside = r.win.dispatch(event("pointerdown", { altKey: true, clientX: 500, clientY: 500 }));
    assert.equal(outside.prevented, false);
    for (const mod of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      const e = r.win.dispatch(event("pointerdown", { altKey: true, ...mod }));
      r.timers.advance(LONG_PRESS_MS);
      r.win.dispatch(event("pointerup"));
      assert.equal(e.prevented, false, JSON.stringify(mod));
    }
    assert.deepEqual(r.opened, []);
  });

  test("a long press opens the popup and swallows the click that ends it", () => {
    const r = rig();
    const down = r.win.dispatch(event("pointerdown"));
    assert.equal(down.prevented, false, "the press itself is left alone (scrolling, selection)");
    r.win.dispatch(event("pointermove", { clientX: 153, clientY: 124 }));
    r.timers.advance(LONG_PRESS_MS);
    assert.deepEqual(r.opened, ["u1"]);
    r.win.dispatch(event("pointerup"));
    const click = r.win.dispatch(event("click"));
    assert.ok(click.prevented && click.stopped);
  });

  test("a press that moves (a scroll or a drag) or is cancelled never opens", () => {
    const r = rig();
    r.win.dispatch(event("pointerdown"));
    r.win.dispatch(event("pointermove", { clientX: 150, clientY: 140 }));
    r.timers.advance(LONG_PRESS_MS);
    r.win.dispatch(event("pointerdown", { pointerId: 2 }));
    r.win.dispatch(event("pointercancel", { pointerId: 2 }));
    r.timers.advance(LONG_PRESS_MS);
    r.win.dispatch(event("pointerdown", { pointerId: 3 }));
    r.win.dispatch(event("blur"));
    r.timers.advance(LONG_PRESS_MS);
    assert.deepEqual(r.opened, []);
  });

  test("touch: the context menu of a long press opens the popup instead and is cancelled", () => {
    const r = rig();
    r.win.dispatch(event("pointerdown"));
    r.timers.advance(LONG_PRESS_MS - 50);
    const menu = r.win.dispatch(event("contextmenu"));
    assert.deepEqual(r.opened, ["u1"]);
    assert.ok(menu.prevented);
    r.timers.advance(100);
    assert.deepEqual(r.opened, ["u1"], "the timer does not fire twice");
    const right = rig();
    right.win.dispatch(event("pointerdown", { button: 2 }));
    const plain = right.win.dispatch(event("contextmenu"));
    assert.equal(plain.prevented, false, "a right click keeps its menu");
  });

  test("presses on the overlay's own controls, secondary pointers and other buttons are never gestures", () => {
    const r = rig();
    r.win.dispatch(event("pointerdown", { altKey: true, path: [BADGE] }));
    r.win.dispatch(event("pointerdown", { altKey: true, isPrimary: false }));
    r.win.dispatch(event("pointerdown", { altKey: true, button: 1 }));
    r.timers.advance(LONG_PRESS_MS);
    assert.deepEqual(r.opened, []);
  });

  test("a press outside the open popup closes it; inside it does not; Escape closes it", () => {
    const r = rig();
    r.setOpen(true);
    r.win.dispatch(event("pointerdown", { path: [POPUP] }));
    assert.deepEqual(r.dismissed, []);
    r.win.dispatch(event("pointerdown", { clientX: 900, clientY: 900 }));
    assert.deepEqual(r.dismissed, ["outside"]);
    const ignored = r.win.dispatch(event("keydown", { key: "Escape" }));
    assert.equal(ignored.prevented, false, "Escape is the page's while no popup is open");
    r.setOpen(true);
    const esc = r.win.dispatch(event("keydown", { key: "Escape" }));
    assert.deepEqual(r.dismissed, ["outside", "escape"]);
    assert.ok(esc.prevented);
    r.win.dispatch(event("keydown", { key: "a" }));
    assert.deepEqual(r.dismissed, ["outside", "escape"]);
  });

  test("Alt+click on another unit while the popup is open closes it and opens the new one", () => {
    const r = rig();
    r.setOpen(true);
    r.win.dispatch(event("pointerdown", { altKey: true }));
    assert.deepEqual(r.dismissed, ["outside"]);
    assert.deepEqual(r.opened, ["u1"]);
  });
});
