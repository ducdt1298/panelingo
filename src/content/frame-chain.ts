// Offset chain for screen captures in reader iframes (ladder step 3, capture-assist.ts drives it).
//
// A frame cannot see where it sits in the tab, so its content script asks its parent frame's content script with
// window.parent.postMessage({tag, kind: "rect?", nonce}): the parent finds the <iframe> whose contentWindow is the
// sender, measures that element's content box (border and padding excluded) in its own viewport, asks its own
// parent the same way up to the top frame, and answers with the child's viewport in top-level viewport CSS px, the
// clip (the part of the top viewport the child shows through: every iframe box on the way ∩ the top viewport), the
// top viewport's size and devicePixelRatio. With `reveal` (a rect in the child's viewport, per-axis placement), each
// parent first scrolls the iframe element so that rect lands in its own window, so a tall or wide image is captured
// tile by tile through every level; the scroll positions are restored on "end" (or after 15 s), and reader input in a
// parent during the session is passed down as "moved".
// Every message is checked: the namespace tag and kind, hex nonces and sessions, finite and bounded numbers; a request
// is answered only for a direct child frame (event.source is one of this document's iframe windows), a reply only
// when it comes from window.parent with a nonce this frame is waiting for. No answer within CHAIN_TIMEOUT_MS: the
// frame cannot be captured (cap:fail "frame"). Page scripts can see these messages and could send look-alikes; the
// worst they can do is make the extension crop the wrong part of what the reader already sees.

import type { Logger } from "../platform/log.ts";
import { intersectRects, revealRectDelta, viewRect } from "../shared/core/capture.ts";
import type { RectCss, Size } from "../shared/types.ts";
import {
  elementBox,
  restoreScroll,
  scrollElementBy,
  type ScrollMemo,
  type ScrollWindow,
} from "./capture-scroll.ts";

export const CHAIN_TAG = "ctv-frame-chain/1";
export const CHAIN_TIMEOUT_MS = 1_000;
/** A parent forgets (and restores) a child's capture session after this long without a request. */
export const CHAIN_SESSION_EXPIRY_MS = 15_000;

const TOKEN = /^[0-9a-f]{16,64}$/u;
const MAX_COORD = 10_000_000;
const MAX_VIEW = 100_000;
const INPUT_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** Where a frame's viewport sits in the tab. */
export interface FrameGeometry {
  /** The frame's viewport (its iframe's content box) in top-level viewport CSS px; the viewport itself at the top. */
  frame: RectCss;
  /** The part of the top-level viewport the frame shows through; null when it shows nowhere. */
  clip: RectCss | null;
  /** The top-level viewport (what captureVisibleTab captures), CSS px. */
  viewport: Size;
  dpr: number;
}

/** A rect in the requesting frame's viewport to bring into view; x / y: put its start at the window start. */
export interface RevealRequest {
  rect: RectCss;
  x: boolean;
  y: boolean;
}

interface Tagged {
  tag: typeof CHAIN_TAG;
}

export type ChainMessage =
  | (Tagged & { kind: "rect?"; nonce: string; session?: string; reveal?: RevealRequest })
  | (Tagged & { kind: "rect"; nonce: string; geometry: FrameGeometry | null })
  | (Tagged & { kind: "end"; session: string })
  | (Tagged & { kind: "moved"; session: string });

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

function tokenOf(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value : null;
}

function rectOf(value: unknown): RectCss | null {
  if (!isRecord(value)) return null;
  const { left, top, width, height } = value;
  return bounded(left, -MAX_COORD, MAX_COORD) &&
    bounded(top, -MAX_COORD, MAX_COORD) &&
    bounded(width, 0, MAX_COORD) &&
    bounded(height, 0, MAX_COORD)
    ? { left, top, width, height }
    : null;
}

function geometryOf(value: unknown): FrameGeometry | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const frame = rectOf(value.frame);
  const clip = value.clip === null ? null : rectOf(value.clip);
  const viewport = isRecord(value.viewport) ? value.viewport : null;
  if (frame === null || (clip === null && value.clip !== null) || viewport === null) return undefined;
  const { w, h } = viewport;
  if (!bounded(w, 1, MAX_VIEW) || !bounded(h, 1, MAX_VIEW) || !bounded(value.dpr, 0.01, 16)) return undefined;
  return { frame, clip, viewport: { w, h }, dpr: value.dpr };
}

/** A clean chain message, or null for anything else (other page messages, malformed or out-of-range values). */
export function parseChainMessage(data: unknown): ChainMessage | null {
  if (!isRecord(data) || data.tag !== CHAIN_TAG) return null;
  switch (data.kind) {
    case "rect?": {
      const nonce = tokenOf(data.nonce);
      if (nonce === null) return null;
      const message: ChainMessage = { tag: CHAIN_TAG, kind: "rect?", nonce };
      if (data.session !== undefined) {
        const session = tokenOf(data.session);
        if (session === null) return null;
        message.session = session;
      }
      if (data.reveal !== undefined) {
        const reveal = isRecord(data.reveal) ? data.reveal : null;
        const rect = reveal === null ? null : rectOf(reveal.rect);
        if (reveal === null || rect === null || message.session === undefined) return null;
        if (typeof reveal.x !== "boolean" || typeof reveal.y !== "boolean") return null;
        message.reveal = { rect, x: reveal.x, y: reveal.y };
      }
      return message;
    }
    case "rect": {
      const nonce = tokenOf(data.nonce);
      const geometry = geometryOf(data.geometry);
      return nonce === null || geometry === undefined
        ? null
        : { tag: CHAIN_TAG, kind: "rect", nonce, geometry };
    }
    case "end":
    case "moved": {
      const session = tokenOf(data.session);
      return session === null ? null : { tag: CHAIN_TAG, kind: data.kind, session };
    }
    default:
      return null;
  }
}

/** The top frame: its viewport at (0, 0), clipped by nothing but itself. */
export function topGeometry(viewport: Size, dpr: number): FrameGeometry {
  const view = viewRect(viewport);
  return { frame: view, clip: view, viewport: { ...viewport }, dpr: dpr > 0 ? dpr : 1 };
}

/** A child frame whose iframe content box is `box` in its parent's viewport, the parent being at `parent`. */
export function childGeometry(parent: FrameGeometry, box: RectCss): FrameGeometry {
  const frame: RectCss = {
    left: parent.frame.left + box.left,
    top: parent.frame.top + box.top,
    width: box.width,
    height: box.height,
  };
  return {
    frame,
    clip: parent.clip === null ? null : intersectRects(parent.clip, frame),
    viewport: { ...parent.viewport },
    dpr: parent.dpr,
  };
}

/** A rect of the frame's viewport in top-level viewport CSS px. */
export function toTop(rect: RectCss, geometry: FrameGeometry): RectCss {
  return {
    left: rect.left + geometry.frame.left,
    top: rect.top + geometry.frame.top,
    width: rect.width,
    height: rect.height,
  };
}

/** Where the frame can be captured: its clip ∩ its own visible area (`localView`, its viewport coordinates). */
export function frameWindow(geometry: FrameGeometry, localView: RectCss): RectCss | null {
  return geometry.clip === null ? null : intersectRects(geometry.clip, toTop(localView, geometry));
}

function shift(rect: RectCss, by: RectCss): RectCss {
  return { left: rect.left + by.left, top: rect.top + by.top, width: rect.width, height: rect.height };
}

export type ChainWindow = ScrollWindow &
  Pick<
    Window,
    "innerWidth" | "innerHeight" | "devicePixelRatio" | "addEventListener" | "removeEventListener" | "parent"
  >;

export interface FrameChainEnv {
  win: ChainWindow;
  doc: Document;
  timers: { setTimer(fn: () => void, ms: number): () => void };
  log: Logger;
  /** Random hex token (nonces and sessions); default crypto.getRandomValues. */
  token?: () => string;
  timeoutMs?: number;
}

export interface FrameChain {
  /** This frame is the top-level frame of the tab. */
  readonly isTop: boolean;
  /** A new session token for locate() / end(). */
  newSession(): string;
  /** This frame's visible area in its own viewport coordinates (scrollbars excluded). */
  localView(): RectCss;
  /**
   * Where this frame sits in the tab. With `reveal` (a rect of this frame's viewport), every ancestor first scrolls
   * it into its window. null: no answer from the parent frames in time.
   */
  locate(options?: { session?: string; reveal?: RevealRequest }): Promise<FrameGeometry | null>;
  /** The capture session is over: the ancestors put their scroll positions back. */
  end(session: string): void;
  /** Reader input in an ancestor frame during a session (the session ends as "moved"). */
  onMoved(listener: (session: string) => void): () => void;
  destroy(): void;
}

interface Hosted {
  readonly child: Window;
  readonly memo: ScrollMemo;
  interrupted: boolean;
  offInput: () => void;
  cancelExpiry: () => void;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createFrameChain(env: FrameChainEnv): FrameChain {
  const { win, doc, timers, log } = env;
  const timeoutMs = env.timeoutMs ?? CHAIN_TIMEOUT_MS;
  const makeToken = env.token ?? randomToken;
  const parent: Window | null = win.parent ?? null;
  const isTop = parent === null || (parent as unknown) === win;
  const pending = new Map<string, (geometry: FrameGeometry | null) => void>();
  const hosted = new Map<string, Hosted>();
  const moved = new Set<(session: string) => void>();
  let destroyed = false;

  const send = (target: Window | null, message: ChainMessage): void => {
    if (target === null) return;
    try {
      target.postMessage(message, "*");
    } catch (error) {
      log.debug("frame chain message not sent", { kind: message.kind, error: String(error) });
    }
  };

  const localView = (): RectCss => {
    const root = doc.documentElement;
    const w = root.clientWidth > 0 ? root.clientWidth : win.innerWidth;
    const h = root.clientHeight > 0 ? root.clientHeight : win.innerHeight;
    return { left: 0, top: 0, width: w, height: h };
  };

  const self = (): FrameGeometry =>
    topGeometry({ w: win.innerWidth, h: win.innerHeight }, win.devicePixelRatio);

  function childFrameOf(source: MessageEventSource | null): HTMLIFrameElement | null {
    if (source === null) return null;
    for (const el of doc.querySelectorAll<HTMLIFrameElement>("iframe, frame")) {
      if (el.contentWindow !== null && el.contentWindow === source) return el;
    }
    return null;
  }

  function locate(options: { session?: string; reveal?: RevealRequest } = {}): Promise<FrameGeometry | null> {
    if (isTop) return Promise.resolve(self());
    if (destroyed) return Promise.resolve(null);
    const nonce = makeToken();
    return new Promise((resolve) => {
      const cancel = timers.setTimer(() => {
        pending.delete(nonce);
        resolve(null);
      }, timeoutMs);
      pending.set(nonce, (geometry) => {
        cancel();
        pending.delete(nonce);
        resolve(geometry);
      });
      const message: ChainMessage = { tag: CHAIN_TAG, kind: "rect?", nonce };
      if (options.session !== undefined) message.session = options.session;
      if (options.reveal !== undefined && options.session !== undefined) message.reveal = options.reveal;
      send(parent, message);
    });
  }

  function endHosted(session: string): void {
    const entry = hosted.get(session);
    if (entry === undefined) return;
    hosted.delete(session);
    entry.cancelExpiry();
    entry.offInput();
    if (!entry.interrupted) restoreScroll(entry.memo, win);
    if (!isTop) send(parent, { tag: CHAIN_TAG, kind: "end", session });
  }

  function host(session: string, child: Window): Hosted {
    let entry = hosted.get(session);
    if (entry === undefined) {
      const created: Hosted = {
        child,
        memo: [],
        interrupted: false,
        offInput: () => undefined,
        cancelExpiry: () => undefined,
      };
      const onInput = (): void => {
        if (created.interrupted) return;
        created.interrupted = true;
        send(child, { tag: CHAIN_TAG, kind: "moved", session });
      };
      for (const type of INPUT_EVENTS) win.addEventListener(type, onInput, { capture: true, passive: true });
      created.offInput = () => {
        for (const type of INPUT_EVENTS) win.removeEventListener(type, onInput, { capture: true });
      };
      hosted.set(session, created);
      entry = created;
    }
    entry.cancelExpiry();
    entry.cancelExpiry = timers.setTimer(() => endHosted(session), CHAIN_SESSION_EXPIRY_MS);
    return entry;
  }

  /** A child frame asks where it is (and maybe to be scrolled into view). */
  async function serve(iframe: HTMLIFrameElement, child: Window, message: ChainMessage & { kind: "rect?" }) {
    let reveal: RevealRequest | undefined;
    if (message.reveal !== undefined && message.session !== undefined) {
      const entry = host(message.session, child);
      if (!entry.interrupted) {
        const target = shift(message.reveal.rect, elementBox(win, iframe));
        const { dx, dy } = revealRectDelta(target, localView(), message.reveal);
        scrollElementBy(entry.memo, win, doc, iframe, dx, dy);
      }
      reveal = { ...message.reveal, rect: shift(message.reveal.rect, elementBox(win, iframe)) };
    }
    const own = await locate(
      reveal === undefined || message.session === undefined ? {} : { session: message.session, reveal },
    );
    if (destroyed) return;
    const geometry = own === null ? null : childGeometry(own, elementBox(win, iframe));
    send(child, { tag: CHAIN_TAG, kind: "rect", nonce: message.nonce, geometry });
  }

  const onMessage = (event: MessageEvent): void => {
    if (destroyed) return;
    const message = parseChainMessage(event.data);
    if (message === null) return;
    switch (message.kind) {
      case "rect?": {
        const iframe = childFrameOf(event.source);
        // Only a direct child frame gets an answer.
        if (iframe === null || iframe.contentWindow === null) return;
        serve(iframe, iframe.contentWindow, message).catch((error: unknown) =>
          log.warn("frame chain request failed", { error: String(error) }),
        );
        return;
      }
      case "rect":
        if (isTop || event.source !== parent) return;
        pending.get(message.nonce)?.(message.geometry);
        return;
      case "end": {
        const entry = hosted.get(message.session);
        if (entry !== undefined && event.source === entry.child) endHosted(message.session);
        return;
      }
      case "moved": {
        if (isTop || event.source !== parent) return;
        for (const listener of [...moved]) listener(message.session);
        const entry = hosted.get(message.session);
        if (entry !== undefined && !entry.interrupted) {
          entry.interrupted = true;
          send(entry.child, message);
        }
        return;
      }
    }
  };
  win.addEventListener("message", onMessage);

  return {
    isTop,
    newSession: () => makeToken(),
    localView,
    locate,
    end(session) {
      if (!isTop) send(parent, { tag: CHAIN_TAG, kind: "end", session });
    },
    onMoved(listener) {
      moved.add(listener);
      return () => {
        moved.delete(listener);
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener("message", onMessage);
      for (const session of [...hosted.keys()]) endHosted(session);
      for (const resolve of [...pending.values()]) resolve(null);
      pending.clear();
      moved.clear();
    },
  };
}
