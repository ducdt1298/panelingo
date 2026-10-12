// Opening the bubble popup without making painted units clickable. Painted units keep pointer-events: none, so page
// clicks pass through to the reader; capture-phase listeners on the window hit-test the painted units' rects instead:
// - Alt+click on a painted unit (settings.render.popupWithAltClick) opens the popup at once. Its pointerdown and
//   click are cancelled and stopped, so the page neither navigates nor downloads (Alt+click on a link downloads it
//   in Chrome).
// - A long press (LONG_PRESS_MS without moving more than LONG_PRESS_SLOP_PX) opens it too; the click that ends the
//   press, or the touch context menu, is cancelled the same way. A shorter press is an ordinary page click.
// - While the popup is open, a press anywhere outside it, or Escape, closes it.
// Presses on the overlay's own controls (popup, badge, buttons, notice) are never gestures.

import type { Box, RectCss, Size } from "../../shared/types.ts";

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 8;

export interface Point {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ geometry (pure) */

/**
 * A box in natural px → client px, through the client rect of the unit layer (natural W×H under the host's
 * translate + scale, so its client rect already holds every ancestor scale).
 */
export function naturalToClient(box: Box, layer: RectCss, natural: Size): Box {
  const sx = natural.w > 0 ? layer.width / natural.w : 0;
  const sy = natural.h > 0 ? layer.height / natural.h : 0;
  return {
    x1: layer.left + box.x1 * sx,
    y1: layer.top + box.y1 * sy,
    x2: layer.left + box.x2 * sx,
    y2: layer.top + box.y2 * sy,
  };
}

export function boxToRect(box: Box): RectCss {
  return { left: box.x1, top: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 };
}

export function containsPoint(box: Box, point: Point): boolean {
  return point.x >= box.x1 && point.x <= box.x2 && point.y >= box.y1 && point.y <= box.y2;
}

export interface HitCandidate<T> {
  target: T;
  /** Client px. */
  box: Box;
}

/** The candidate whose box contains the point; the smallest one where boxes overlap (the innermost unit). */
export function pickHit<T>(point: Point, candidates: Iterable<HitCandidate<T>>): HitCandidate<T> | null {
  let best: HitCandidate<T> | null = null;
  let bestArea = Infinity;
  for (const candidate of candidates) {
    const { box } = candidate;
    if (!(box.x2 > box.x1) || !(box.y2 > box.y1) || !containsPoint(box, point)) continue;
    const area = (box.x2 - box.x1) * (box.y2 - box.y1);
    if (area < bestArea) {
      best = candidate;
      bestArea = area;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ long press (pure state machine) */

export interface LongPressDeps<T> {
  /** Runs fn after ms; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  onFire(target: T): void;
  delayMs?: number;
  slopPx?: number;
}

export interface LongPress<T> {
  /** A press began on `target` (replaces any press in progress). */
  start(pointerId: number, x: number, y: number, target: T): void;
  /** Moving farther than the slop from where the press began cancels it. */
  move(pointerId: number, x: number, y: number): void;
  /** The pointer went up; true when this press had fired. */
  end(pointerId: number): boolean;
  /** Fires a pending press now (the touch context menu came first); true when it fired. */
  flush(): boolean;
  cancel(): void;
  /** A press is held and has not fired yet. */
  readonly pending: boolean;
}

interface Press<T> {
  id: number;
  x: number;
  y: number;
  target: T;
  fired: boolean;
  stop: () => void;
}

export function createLongPress<T>(deps: LongPressDeps<T>): LongPress<T> {
  const delay = deps.delayMs ?? LONG_PRESS_MS;
  const slop = deps.slopPx ?? LONG_PRESS_SLOP_PX;
  let press: Press<T> | null = null;

  const fire = (): void => {
    if (press === null || press.fired) return;
    press.fired = true;
    press.stop();
    deps.onFire(press.target);
  };

  const cancel = (): void => {
    press?.stop();
    press = null;
  };

  return {
    start(pointerId, x, y, target) {
      cancel();
      const current: Press<T> = { id: pointerId, x, y, target, fired: false, stop: () => undefined };
      press = current;
      current.stop = deps.setTimer(() => {
        if (press === current) fire();
      }, delay);
    },
    move(pointerId, x, y) {
      if (press === null || press.fired || press.id !== pointerId) return;
      if (Math.hypot(x - press.x, y - press.y) > slop) cancel();
    },
    end(pointerId) {
      if (press === null || press.id !== pointerId) return false;
      const fired = press.fired;
      cancel();
      return fired;
    },
    flush() {
      if (press === null || press.fired) return false;
      fire();
      return true;
    },
    cancel,
    get pending() {
      return press !== null && !press.fired;
    },
  };
}

/* ------------------------------------------------------------------ listeners */

/** The parts of a PointerEvent / MouseEvent / KeyboardEvent the listeners read (plain objects in tests). */
export interface GestureEvent {
  readonly type: string;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly button?: number;
  readonly pointerId?: number;
  readonly isPrimary?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly key?: string;
  /** The event path across shadow roots (closed roots show only their host). */
  composedPath?(): EventTarget[];
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

/** The window (a fake in tests: listeners receive GestureEvent-shaped objects). */
export interface GestureTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: EventListenerOptions): void;
}

export interface PopupGestureOptions<T> {
  /** The window: listeners run in its capture phase, before page listeners on the document or elements. */
  win: GestureTarget;
  /** settings.render.popupWithAltClick. */
  altClick: boolean;
  /** The painted unit under this client point, or null. */
  hitTest(x: number, y: number): T | null;
  onOpen(target: T): void;
  /** The event targets the overlay's own UI (popup, badge, buttons, notice). */
  isOwn(event: GestureEvent): boolean;
  /** The event targets the popup itself. */
  inPopup(event: GestureEvent): boolean;
  isOpen(): boolean;
  /** A press outside the popup, or Escape. */
  onDismiss(reason: "outside" | "escape"): void;
  setTimer(fn: () => void, ms: number): () => void;
  delayMs?: number;
  slopPx?: number;
}

export interface PopupGestures {
  destroy(): void;
}

const CAPTURE: AddEventListenerOptions = { capture: true };

function cancelEvent(event: GestureEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function modified(event: GestureEvent): boolean {
  return event.ctrlKey === true || event.metaKey === true || event.shiftKey === true;
}

export function createPopupGestures<T>(options: PopupGestureOptions<T>): PopupGestures {
  /** The current gesture opened the popup: its click (or touch context menu) must not reach the page. */
  let swallow = false;
  const press = createLongPress<T>({
    setTimer: (fn, ms) => options.setTimer(fn, ms),
    onFire: (target) => {
      swallow = true;
      options.onOpen(target);
    },
    ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
    ...(options.slopPx !== undefined ? { slopPx: options.slopPx } : {}),
  });

  const onPointerDown = (event: GestureEvent): void => {
    swallow = false;
    press.cancel();
    if (event.isPrimary === false) return;
    if (options.isOpen() && !options.inPopup(event)) options.onDismiss("outside");
    if (options.isOwn(event) || (event.button ?? 0) !== 0) return;
    const x = event.clientX ?? Number.NaN;
    const y = event.clientY ?? Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const alt = event.altKey === true;
    if (alt && !options.altClick) return;
    if (modified(event)) return;
    const hit = options.hitTest(x, y);
    if (hit === null) return;
    if (alt) {
      // No focus change, no text selection, no compatibility mousedown for the page; the click is cancelled below.
      cancelEvent(event);
      swallow = true;
      options.onOpen(hit);
      return;
    }
    press.start(event.pointerId ?? 0, x, y, hit);
  };

  const onPointerMove = (event: GestureEvent): void => {
    if (press.pending) press.move(event.pointerId ?? 0, event.clientX ?? 0, event.clientY ?? 0);
  };

  const onPointerUp = (event: GestureEvent): void => {
    press.end(event.pointerId ?? 0);
  };

  const onPointerCancel = (): void => {
    press.cancel();
  };

  const onClick = (event: GestureEvent): void => {
    if (!swallow) return;
    swallow = false;
    cancelEvent(event);
  };

  const onContextMenu = (event: GestureEvent): void => {
    // A touch long press brings the context menu, maybe before the timer: it opens the popup instead.
    if (press.pending) press.flush();
    if (swallow) cancelEvent(event);
  };

  const onKeyDown = (event: GestureEvent): void => {
    if (event.key !== "Escape" || !options.isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    options.onDismiss("escape");
  };

  const onBlur = (): void => {
    press.cancel();
  };

  const listeners: Array<[string, (event: GestureEvent) => void]> = [
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerCancel],
    ["click", onClick],
    ["auxclick", onClick],
    ["contextmenu", onContextMenu],
    ["keydown", onKeyDown],
    ["blur", onBlur],
  ];
  for (const [type, fn] of listeners) options.win.addEventListener(type, fn, CAPTURE);

  return {
    destroy() {
      press.cancel();
      for (const [type, fn] of listeners) options.win.removeEventListener(type, fn, CAPTURE);
    },
  };
}
