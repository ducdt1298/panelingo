// Engine side of the screen-capture fallback (ladder step 3): for images neither the content script nor the engine
// can read (tainted canvases, revoked blob: URLs, CDNs that refuse the engine).
//
// Allowed only for opted-in sites (a reader iframe counts when an enabled site lists its origin in
// extraFrameOrigins), in a visible tab, for an image on screen; otherwise it throws image.capture_blocked (the image
// stays in its error state with that message) or image.capture_unavailable "offscreen" (the content script retries
// once the image is on screen). One session per tab at a time:
//   cap:prepare → the frame hides that image's overlay, brings the image into view (an iframe through its parent
//   frames), waits two frames → cap:ready {rect, viewport, dpr, clip} in top-level viewport CSS px → sw:capture (the
//   viewport as PNG) → crop to the image rect ∩ clip in device px.
// An image larger than the capture window (the viewport ∩ clip) is captured in overlapping tiles (shared/core/
// capture.ts planTiles: rows for a tall image, columns for a wide one, a grid for both), each tile scrolled to the
// window start by its own cap:prepare, and stitched into one picture; cap:done restores the overlay and the scroll
// positions. A cap:fail "moved" (the reader scrolled or pressed a key) at any point abandons the session. The
// screenshot never leaves this module: only the cropped image is returned, marked lowRes.

import type { Logger } from "../platform/log.ts";
import {
  CAPTURE,
  bandPlacement,
  captureOutput,
  insideRect,
  intersectRects,
  planTiles,
  tileRect,
  viewRect,
  type Tile,
} from "../shared/core/capture.ts";
import { CtvError, errorMessage } from "../shared/errors.ts";
import type { Gfx, LoadedImage } from "../shared/gfx.ts";
import type { CsToEngineMap, EngineToCs, ImageSubmit, ReqOf, ResOf, SwApi } from "../shared/protocol.ts";
import type { Codec, RectCss, Size } from "../shared/types.ts";
import { decodeBytes } from "../shared/wire.ts";
import type { AcquireContext, AcquiredImage, CaptureStep, Clock, FrameInfo } from "./contracts.ts";

/** cap:prepare → cap:ready: two animation frames plus a scroll; generous for a busy page. */
export const READY_TIMEOUT_MS = 5_000;
/** sw:capture may wait behind other captures of the window (600 ms each). */
export const SW_CAPTURE_TIMEOUT_MS = 20_000;

export type CaptureReply =
  | ({ readonly type: "cap:ready" } & CsToEngineMap["cap:ready"])
  | ({ readonly type: "cap:fail" } & CsToEngineMap["cap:fail"]);

export type SwCaptureCall = (
  type: "sw:capture",
  payload: ReqOf<SwApi, "sw:capture">,
) => Promise<ResOf<SwApi, "sw:capture">>;

export interface CaptureDeps {
  clock: Clock;
  log: Logger;
  gfx: Gfx;
  /** Posts to a frame's current port; false when it is gone. */
  post(frameKey: string, message: EngineToCs): boolean;
  callSw: SwCaptureCall;
  /** Codec of the engine ↔ service worker channel. */
  swCodec(): Codec;
  /**
   * Is capturing allowed for this frame's page? Default: its own site record is enabled. The runtime also accepts a
   * reader iframe whose origin an enabled site lists in extraFrameOrigins.
   */
  siteEnabled?(frame: FrameInfo, ctx: AcquireContext): boolean;
  readyTimeoutMs?: number;
}

export interface CaptureAssist extends CaptureStep {
  /** cap:ready / cap:fail from a frame (already validated). */
  receive(frameKey: string, reply: CaptureReply): void;
  /** The frame is gone: its sessions fail. */
  frameGone(frameKey: string): void;
}

interface Ready {
  rect: RectCss;
  viewport: Size;
  dpr: number;
  clip?: RectCss;
}

interface Session {
  readonly reqId: string;
  readonly frameKey: string;
  waiter: { resolve(ready: Ready): void; reject(error: CtvError): void } | null;
  /** A cap:fail arrived (possibly unprompted): every later step stops with it. */
  failed: CtvError | null;
}

export function blockedError(detail: string, message: string): CtvError {
  return new CtvError("image.capture_blocked", message, { detail });
}

export function unavailableError(detail: string, message: string): CtvError {
  return new CtvError("image.capture_unavailable", message, { detail, retryable: true });
}

/** cap:fail reason → the error the image shows. */
export function failError(reason: CsToEngineMap["cap:fail"]["reason"]): CtvError {
  switch (reason) {
    case "hidden":
      return blockedError("hidden", "the page is hidden");
    case "not-visible":
      return unavailableError("offscreen", "the image is not on screen");
    case "moved":
      return unavailableError("interrupted", "the reader scrolled during the capture");
    case "timeout":
      return unavailableError("timeout", "the page did not get ready for the capture");
    case "frame":
      return blockedError("frame", "the frame could not find its position in the tab");
  }
}

/** Why a capture may not run for this frame now; null when it may. `enabled`: the frame's page is opted in. */
export function captureRefusal(
  submit: ImageSubmit,
  ctx: AcquireContext,
  enabled: boolean = ctx.site.enabled === true,
): CtvError | null {
  if (!enabled) return blockedError("site", "screen capture is only used on enabled sites");
  if (!ctx.frame.page.visible) return blockedError("hidden", "the tab is not visible");
  const onScreen = ctx.frame.viewport?.onScreen;
  if (onScreen !== undefined && !onScreen.includes(submit.imageKey)) {
    return unavailableError("offscreen", "the image is not on screen");
  }
  return null;
}

/** Where the image can be captured: the viewport, or the part of it a reader iframe shows through. */
export function captureWindow(ready: { viewport: Size; clip?: RectCss }): RectCss | null {
  const view = viewRect(ready.viewport);
  return ready.clip === undefined ? view : intersectRects(view, ready.clip);
}

/** A cap:fail (possibly unprompted, e.g. the reader scrolled) ends the session at the next step. */
function abortIfFailed(session: Session): void {
  if (session.failed !== null) throw session.failed;
}

function closeImage(image: LoadedImage): void {
  const closable = image as { close?: () => void };
  if (typeof closable.close === "function") closable.close();
}

export function createCaptureAssist(deps: CaptureDeps): CaptureAssist {
  const { clock, log, gfx } = deps;
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const enabledFor = (ctx: AcquireContext): boolean =>
    deps.siteEnabled === undefined ? ctx.site.enabled === true : deps.siteEnabled(ctx.frame, ctx);
  const sessions = new Map<string, Session>();
  /** One session per tab: each scrolls the page and hides an overlay. */
  const tabLocks = new Map<number, Promise<void>>();
  let seq = 0;

  async function withTabLock<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    const previous = tabLocks.get(tabId) ?? Promise.resolve();
    let release = (): void => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => mine);
    tabLocks.set(tabId, chained);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (tabLocks.get(tabId) === chained) tabLocks.delete(tabId);
    }
  }

  function prepare(session: Session, imageKey: string, tile?: Tile): Promise<Ready> {
    if (session.failed !== null) return Promise.reject(session.failed);
    return new Promise<Ready>((resolve, reject) => {
      const cancel = clock.setTimer(() => {
        session.waiter = null;
        reject(unavailableError("timeout", "the page did not answer cap:prepare"));
      }, readyTimeoutMs);
      session.waiter = {
        resolve: (ready) => {
          cancel();
          session.waiter = null;
          resolve(ready);
        },
        reject: (error) => {
          cancel();
          session.waiter = null;
          reject(error);
        },
      };
      const message: EngineToCs =
        tile === undefined
          ? { type: "cap:prepare", reqId: session.reqId, imageKey }
          : {
              type: "cap:prepare",
              reqId: session.reqId,
              imageKey,
              band: { top: tile.top, height: tile.height, left: tile.left, width: tile.width },
            };
      if (!deps.post(session.frameKey, message)) {
        session.waiter.reject(unavailableError("timeout", "the frame is not connected"));
      }
    });
  }

  async function shoot(
    tabId: number,
    ready: Ready,
  ): Promise<{ image: LoadedImage; shot: Size; scale: number }> {
    let reply: ResOf<SwApi, "sw:capture">;
    try {
      reply = await deps.callSw("sw:capture", {
        tabId,
        rect: ready.rect,
        viewport: ready.viewport,
        codec: deps.swCodec(),
      });
    } catch (error) {
      if (error instanceof CtvError) throw error;
      throw unavailableError("sw", `sw:capture failed: ${errorMessage(error)}`);
    }
    const bytes = new Uint8Array(decodeBytes(reply.png));
    let image: LoadedImage;
    try {
      image = await gfx.loadImage(bytes);
    } catch (error) {
      throw new CtvError("image.decode", "the screen capture could not be decoded", {
        cause: error,
        detail: errorMessage(error),
      });
    }
    return { image, shot: { w: image.width, h: image.height }, scale: reply.scale };
  }

  /** The capture window of a cap:ready, when the image (or the tile asked for) shows in it. */
  function checkRect(ready: Ready, tile?: Tile): RectCss {
    if (!(ready.rect.width >= 1 && ready.rect.height >= 1)) {
      throw unavailableError("offscreen", "the image has no size on screen");
    }
    const window = captureWindow(ready);
    if (window === null || intersectRects(tileRect(ready.rect, tile), window) === null) {
      throw unavailableError("offscreen", "the image is not on screen");
    }
    return window;
  }

  async function run(session: Session, submit: ImageSubmit, ctx: AcquireContext): Promise<AcquiredImage> {
    const tabId = ctx.frame.tabId;
    const first = await prepare(session, submit.imageKey);
    const window = checkRect(first);
    const css: Size = { w: first.rect.width, h: first.rect.height };
    const tiles = insideRect(first.rect, window)
      ? null
      : planTiles(css, { w: window.width, h: window.height });
    if (tiles !== null && tiles.length > CAPTURE.maxTiles) {
      throw new CtvError("image.too_large", `the image needs ${tiles.length} screen captures`, {
        detail: "capture-tiles",
      });
    }
    const steps: Array<{ tile: Tile | undefined }> =
      tiles === null ? [{ tile: undefined }] : tiles.map((tile) => ({ tile }));
    let canvas: ReturnType<Gfx["createCanvas"]> | null = null;
    let outScale = 1;
    for (const [index, step] of steps.entries()) {
      const ready =
        index === 0 && step.tile === undefined ? first : await prepare(session, submit.imageKey, step.tile);
      const clip = checkRect(ready, step.tile);
      if (Math.abs(ready.rect.width - css.w) > 1 || Math.abs(ready.rect.height - css.h) > 1) {
        throw unavailableError("interrupted", "the image changed size during the capture");
      }
      const { image, shot, scale } = await shoot(tabId, ready);
      try {
        abortIfFailed(session);
        if (canvas === null) {
          const out = captureOutput(css, scale, ctx.settings.privacy.maxImagePixels);
          outScale = out.scale;
          canvas = gfx.createCanvas(out.w, out.h);
          if (Math.abs(scale - ready.dpr) > 0.05) {
            log.debug("capture scale differs from devicePixelRatio", { scale, dpr: ready.dpr });
          }
        }
        const placement = bandPlacement({
          rect: ready.rect,
          viewport: ready.viewport,
          shot,
          outScale,
          clip,
          ...(step.tile === undefined ? {} : { tile: step.tile }),
        });
        if (placement === null) throw unavailableError("offscreen", "the tile is not on screen");
        const g = canvas.getContext("2d");
        if (g === null) throw new CtvError("engine.internal", "no 2D context for the capture");
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = "high";
        const { src, dst } = placement;
        g.drawImage(image, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
      } finally {
        closeImage(image);
      }
    }
    abortIfFailed(session);
    if (canvas === null) throw new CtvError("engine.internal", "capture produced nothing");
    const png = await gfx.encodePng(canvas);
    abortIfFailed(session);
    const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    log.info("image read from a screen capture", {
      imageKey: submit.imageKey,
      tiles: steps.length,
      frame: ctx.frame.frameId,
      w: canvas.width,
      h: canvas.height,
    });
    return { bytes, mime: "image/png", source: "capture", lowRes: true, url: null };
  }

  return {
    refusal: (submit, ctx) => captureRefusal(submit, ctx, enabledFor(ctx)),
    async capture(submit, ctx) {
      const refusal = captureRefusal(submit, ctx, enabledFor(ctx));
      if (refusal !== null) throw refusal;
      return withTabLock(ctx.frame.tabId, async () => {
        seq += 1;
        const session: Session = {
          reqId: `cap-${seq.toString(36)}-${Math.floor(clock.now()).toString(36)}`,
          frameKey: ctx.frame.frameKey,
          waiter: null,
          failed: null,
        };
        sessions.set(session.reqId, session);
        try {
          return await run(session, submit, ctx);
        } finally {
          sessions.delete(session.reqId);
          deps.post(session.frameKey, { type: "cap:done", reqId: session.reqId });
        }
      });
    },
    receive(frameKey, reply) {
      const session = sessions.get(reply.reqId);
      if (session === undefined || session.frameKey !== frameKey) {
        log.debug("capture reply for no session", { frameKey, type: reply.type });
        return;
      }
      if (reply.type === "cap:fail") {
        const error = failError(reply.reason);
        session.failed ??= error;
        session.waiter?.reject(error);
        return;
      }
      const ready: Ready = { rect: reply.rect, viewport: reply.viewport, dpr: reply.dpr };
      if (reply.clip !== undefined) ready.clip = reply.clip;
      session.waiter?.resolve(ready);
    },
    frameGone(frameKey) {
      for (const session of sessions.values()) {
        if (session.frameKey !== frameKey) continue;
        const error = unavailableError("timeout", "the frame went away during the capture");
        session.failed ??= error;
        session.waiter?.reject(error);
      }
    },
  };
}
