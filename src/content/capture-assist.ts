// Content side of the screen-capture fallback (ladder step 3, engine/capture.ts drives it).
//
// cap:prepare: refuse when the page is hidden ("hidden") or the image is not on screen ("not-visible": it never
// scrolls toward an image the reader cannot see); otherwise hide this image's overlay hosts only (opacity 0, so the
// badge and the lettering stay out of the picture), scroll the image into the capture window (the whole image when
// no tile is asked for, else the tile to the window start, on each axis the tile is a part of), wait two animation
// frames and answer cap:ready with the image's content box in top-level viewport CSS px, that viewport's size and
// devicePixelRatio. In a reader iframe, frame-chain.ts asks the parent frames where this frame sits (and to scroll it
// into view as well); cap:ready then also carries the clip, the part of the top viewport the frame shows through,
// and a frame whose parents do not answer is refused ("frame"). cap:done (or 15 s without a message) restores the
// overlay and every scroll position. A wheel, touch, key or pointer press during a session (here or in a parent
// frame) means the reader took over: cap:fail "moved" goes out at once, and the scroll positions are left where the
// reader put them.
// The controller retries a capture that could not run (off screen, interrupted) once the image is on screen and the
// reader has stopped scrolling (captureRetryWanted).

import type { Logger } from "../platform/log.ts";
import {
  intersectRects,
  tileDelta,
  tilePlacement,
  tileRect,
  viewRect,
  type Tile,
} from "../shared/core/capture.ts";
import type { ErrorInfo } from "../shared/errors.ts";
import type { CsToEngine, EngineToCsMap } from "../shared/protocol.ts";
import type { RectCss, Size } from "../shared/types.ts";
import { elementBox, restoreScroll, scrollElementBy, type ScrollMemo } from "./capture-scroll.ts";
import type { ImageElement } from "./contracts.ts";
import { frameWindow, toTop, topGeometry, type FrameChain, type FrameGeometry } from "./frame-chain.ts";

export { contentBox } from "./capture-scroll.ts";

/** A session that hears nothing from the engine for this long restores the page by itself. */
export const SESSION_EXPIRY_MS = 15_000;
/** Fallback when animation frames do not come (the page went to the background meanwhile). */
export const FRAMES_FALLBACK_MS = 250;
/** The reader must have stopped scrolling this long before a capture is retried. */
export const CAPTURE_QUIET_MS = 1_200;
/** Automatic capture retries per image. */
export const CAPTURE_RETRY_MAX = 5;

const INPUT_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

export type CaptureWindow = Pick<
  Window,
  | "innerWidth"
  | "innerHeight"
  | "devicePixelRatio"
  | "scrollX"
  | "scrollY"
  | "scrollTo"
  | "requestAnimationFrame"
  | "addEventListener"
  | "removeEventListener"
  | "getComputedStyle"
>;

/** The tile a cap:prepare names, completed with the image's full width when it has no columns. */
export function tileOf(band: EngineToCsMap["cap:prepare"]["band"], rect: RectCss): Tile | undefined {
  if (band === undefined) return undefined;
  return { top: band.top, height: band.height, left: band.left ?? 0, width: band.width ?? rect.width };
}

/** Scroll (CSS px) cap:prepare applies in this frame's viewport `view` for `band` of the image `rect`. */
export function prepareDelta(
  rect: RectCss,
  view: Size,
  band?: EngineToCsMap["cap:prepare"]["band"],
): { dx: number; dy: number } {
  return tileDelta(rect, viewRect(view), tileOf(band, rect));
}

/** A capture that could not run now and is worth retrying once the image is on screen and the page is still. */
export function captureRetryWanted(error: ErrorInfo | null | undefined): boolean {
  if (error?.code !== "image.capture_unavailable") return false;
  return error.detail === "offscreen" || error.detail === "interrupted" || error.detail === "timeout";
}

export interface CaptureAssistEnv {
  doc: Document;
  /** null (no window): every cap:prepare is declined. */
  win: CaptureWindow | null;
  timers: { setTimer(fn: () => void, ms: number): () => void };
  /** The tracked element of an imageKey (discovery). */
  elementOf(imageKey: string): ImageElement | null;
  post(message: CsToEngine): boolean;
  log: Logger;
  /** Where this frame sits in the tab; absent or isTop: the top frame (no chain needed). */
  chain?: FrameChain | null;
}

export interface CaptureAssist {
  prepare(message: EngineToCsMap["cap:prepare"]): void;
  done(message: EngineToCsMap["cap:done"]): void;
  /** A capture session is running (its scrolling is not the reader's). */
  readonly active: boolean;
  destroy(): void;
}

interface Session {
  readonly reqId: string;
  /** frame-chain session (iframes): the parents' scroll positions belong to it. */
  readonly token: string | null;
  readonly hidden: Array<{ host: HTMLElement; value: string; priority: string }>;
  readonly memo: ScrollMemo;
  interrupted: boolean;
  offInput: () => void;
  cancelExpiry: () => void;
}

type FailReason = "not-visible" | "hidden" | "moved" | "frame";

export function createCaptureAssist(env: CaptureAssistEnv): CaptureAssist {
  const { doc, win, timers, log } = env;
  const chain = env.chain !== undefined && env.chain !== null && !env.chain.isTop ? env.chain : null;
  const sessions = new Map<string, Session>();
  let destroyed = false;

  const post = (message: CsToEngine): void => {
    if (!env.post(message)) log.debug("capture message not sent", { type: message.type });
  };

  const offMoved =
    chain?.onMoved((token) => {
      for (const session of sessions.values()) {
        if (session.token !== token || session.interrupted) continue;
        session.interrupted = true;
        post({ type: "cap:fail", reqId: session.reqId, reason: "moved" });
      }
    }) ?? (() => undefined);

  /** This frame's visible area, in its own viewport coordinates. */
  const localView = (w: CaptureWindow): RectCss =>
    chain === null ? viewRect({ w: w.innerWidth, h: w.innerHeight }) : chain.localView();

  /** Where this frame sits in the tab (the top frame: right here). */
  function geometry(w: CaptureWindow, session?: string, reveal?: Tile & { rect: RectCss }) {
    if (chain === null) {
      return Promise.resolve<FrameGeometry | null>(
        topGeometry({ w: w.innerWidth, h: w.innerHeight }, w.devicePixelRatio),
      );
    }
    if (reveal === undefined || session === undefined)
      return chain.locate(session === undefined ? {} : { session });
    const place = tilePlacement(reveal.rect, reveal);
    return chain.locate({ session, reveal: { rect: tileRect(reveal.rect, reveal), x: place.x, y: place.y } });
  }

  function hideHosts(imageKey: string): Session["hidden"] {
    const hidden: Session["hidden"] = [];
    for (const host of doc.querySelectorAll<HTMLElement>("[data-ctv-host]")) {
      if (host.getAttribute("data-ctv-image") !== imageKey) continue;
      hidden.push({
        host,
        value: host.style.getPropertyValue("opacity"),
        priority: host.style.getPropertyPriority("opacity"),
      });
      host.style.setProperty("opacity", "0", "important");
    }
    return hidden;
  }

  function armExpiry(session: Session): void {
    session.cancelExpiry();
    session.cancelExpiry = timers.setTimer(() => {
      log.debug("capture session expired", { reqId: session.reqId });
      end(session.reqId);
    }, SESSION_EXPIRY_MS);
  }

  function start(w: CaptureWindow, reqId: string, imageKey: string, token: string | null): Session {
    const session: Session = {
      reqId,
      token,
      hidden: hideHosts(imageKey),
      memo: [],
      interrupted: false,
      offInput: () => undefined,
      cancelExpiry: () => undefined,
    };
    const onInput = (): void => {
      if (session.interrupted) return;
      session.interrupted = true;
      post({ type: "cap:fail", reqId, reason: "moved" });
    };
    for (const type of INPUT_EVENTS) w.addEventListener(type, onInput, { capture: true, passive: true });
    session.offInput = () => {
      for (const type of INPUT_EVENTS) w.removeEventListener(type, onInput, { capture: true });
    };
    sessions.set(reqId, session);
    return session;
  }

  function end(reqId: string): void {
    const session = sessions.get(reqId);
    if (session === undefined) return;
    sessions.delete(reqId);
    session.cancelExpiry();
    session.offInput();
    for (const { host, value, priority } of session.hidden) {
      if (value === "") host.style.removeProperty("opacity");
      else host.style.setProperty("opacity", value, priority);
    }
    if (session.token !== null) chain?.end(session.token);
    if (session.interrupted || win === null) return;
    restoreScroll(session.memo, win);
  }

  function twoFrames(w: CaptureWindow): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        cancel();
        resolve();
      };
      const cancel = timers.setTimer(finish, FRAMES_FALLBACK_MS);
      w.requestAnimationFrame(() => w.requestAnimationFrame(finish));
    });
  }

  async function prepare(message: EngineToCsMap["cap:prepare"]): Promise<void> {
    const { reqId, imageKey } = message;
    const fail = (reason: FailReason): void => {
      end(reqId);
      post({ type: "cap:fail", reqId, reason });
    };
    if (destroyed || win === null) return fail("not-visible");
    if (doc.visibilityState !== "visible") return fail("hidden");
    const el = env.elementOf(imageKey);
    if (el === null || !el.isConnected) return fail("not-visible");
    let session = sessions.get(reqId);
    if (session?.interrupted === true) return fail("moved");
    const live = (): boolean =>
      !destroyed && sessions.get(reqId) === session && session?.interrupted !== true;
    if (session === undefined) {
      const token = chain === null ? null : chain.newSession();
      const where = await geometry(win, token ?? undefined);
      if (where === null) return fail("frame");
      const window = frameWindow(where, localView(win));
      const shown = window === null ? null : intersectRects(toTop(elementBox(win, el), where), window);
      if (shown === null) return fail("not-visible");
      if (sessions.has(reqId) || destroyed) return;
      session = start(win, reqId, imageKey, token);
    }
    armExpiry(session);
    // This frame first, then (in an iframe) every parent brings the tile into its window.
    const before = elementBox(win, el);
    const tile = tileOf(message.band, before);
    const { dx, dy } = tileDelta(before, localView(win), tile);
    scrollElementBy(session.memo, win, doc, el, dx, dy);
    if (chain !== null && session.token !== null) {
      const after = elementBox(win, el);
      const revealed = await geometry(win, session.token, {
        ...(tile ?? { top: 0, height: after.height, left: 0, width: after.width }),
        rect: after,
      });
      if (!live()) return;
      if (revealed === null) return fail("frame");
    }
    await twoFrames(win);
    if (!live()) return;
    if (doc.visibilityState !== "visible") return fail("hidden");
    const where = await geometry(win, session.token ?? undefined);
    if (!live()) return;
    if (where === null) return fail("frame");
    const rect = toTop(elementBox(win, el), where);
    if (chain === null) {
      post({ type: "cap:ready", reqId, rect, viewport: where.viewport, dpr: where.dpr });
      return;
    }
    const clip = frameWindow(where, localView(win));
    if (clip === null) return fail("not-visible");
    post({ type: "cap:ready", reqId, rect, viewport: where.viewport, dpr: where.dpr, clip });
  }

  return {
    prepare(message) {
      prepare(message).catch((error: unknown) => {
        log.warn("cap:prepare failed", { error: String(error) });
        end(message.reqId);
        post({ type: "cap:fail", reqId: message.reqId, reason: "not-visible" });
      });
    },
    done(message) {
      end(message.reqId);
    },
    get active() {
      return sessions.size > 0;
    },
    destroy() {
      destroyed = true;
      offMoved();
      for (const reqId of [...sessions.keys()]) end(reqId);
    },
  };
}
