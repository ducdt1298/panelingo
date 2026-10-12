// Screen-capture fallback (ladder step 3) geometry and the capture rate limiter. PURE.
//
// The content script reports the image's content box in CSS px of the top-level viewport (a reader iframe adds its
// offset chain, content/frame-chain.ts) and, for an iframe, the clip: the part of the top viewport the frame shows
// through. The service worker captures the visible viewport as a PNG; the engine crops it to the image (device px).
// An image larger than the capture window (the viewport, or the clip) is captured in tiles and stitched into one
// picture of the whole image: rows and columns of TILE_RATIO of the window overlapping by OVERLAP of a tile (one row
// or one column when that side fits), each scrolled so its top-left lands WINDOW_START into the window, which keeps
// sticky headers and side bars out. The stitched image goes through the normal pipeline (one detection with
// slicing, one set of units), which is simpler and more robust than translating tile by tile.

import type { Clock } from "../clock.ts";
import type { RectCss, Size } from "../types.ts";

export const CAPTURE = {
  /** Chrome allows about 2 captureVisibleTab calls per second per window: keep this gap between captures. */
  minGapMs: 600,
  /** Tile side as a fraction of the capture window's side. */
  bandRatio: 0.7,
  /** Overlap of consecutive tiles, as a fraction of the tile side. */
  overlap: 0.2,
  /** Where a tile's top (left) is scrolled to, as a fraction of the window's height (width). */
  windowTop: 0.15,
  /** More tiles than this (an image of ~13 screens) is refused. */
  maxTiles: 24,
  /** Chrome's canvas side limit. */
  maxSide: 32_767,
  /** CSS px of slack when deciding that a rect is inside a window. */
  edgeTolerance: 1,
} as const;

/** Rows (or columns) of the image, CSS px from its top (left), that one capture covers. */
export interface Band {
  top: number;
  height: number;
}

/** The part of the image (CSS px from its top-left) one capture covers. */
export interface Tile {
  top: number;
  height: number;
  left: number;
  width: number;
}

/** Integer rectangle in pixels. */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The viewport as a rect at (0, 0). */
export function viewRect(viewport: Size): RectCss {
  return { left: 0, top: 0, width: viewport.w, height: viewport.h };
}

/** The intersection of two rects, or null when they do not overlap. */
export function intersectRects(a: RectCss, b: RectCss): RectCss | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Does any part of `rect` show in the viewport? */
export function intersectsViewport(rect: RectCss, viewport: Size): boolean {
  return rect.width > 0 && rect.height > 0 && intersectRects(rect, viewRect(viewport)) !== null;
}

/** Is all of `rect` inside `window` (± tolerance)? */
export function insideRect(rect: RectCss, window: RectCss, tolerance = CAPTURE.edgeTolerance): boolean {
  return (
    rect.left >= window.left - tolerance &&
    rect.top >= window.top - tolerance &&
    rect.left + rect.width <= window.left + window.width + tolerance &&
    rect.top + rect.height <= window.top + window.height + tolerance
  );
}

/** Is all of `rect` inside the viewport? */
export function fitsViewport(rect: RectCss, viewport: Size, tolerance = CAPTURE.edgeTolerance): boolean {
  return insideRect(rect, viewRect(viewport), tolerance);
}

/** The part of `rect` inside the viewport (CSS px), or null when nothing shows. */
export function visiblePart(rect: RectCss, viewport: Size): RectCss | null {
  return intersectRects(rect, viewRect(viewport));
}

/**
 * Bands that cover `imageSide` CSS px of an image in a window `windowSide` long: one band for a side that fits, else
 * bands of bandRatio × window overlapping by `overlap`, the last one aligned with the image's end.
 */
export function planBands(
  imageSide: number,
  windowSide: number,
  options: { bandRatio?: number; overlap?: number } = {},
): Band[] {
  if (!(imageSide > 0) || !(windowSide > 0)) return [];
  if (imageSide <= windowSide - 2 * CAPTURE.edgeTolerance) return [{ top: 0, height: imageSide }];
  const band = Math.max(1, Math.floor(windowSide * (options.bandRatio ?? CAPTURE.bandRatio)));
  const step = Math.max(1, Math.floor(band * (1 - (options.overlap ?? CAPTURE.overlap))));
  const bands: Band[] = [];
  for (let top = 0; ; top += step) {
    if (top + band >= imageSide) {
      bands.push({ top: Math.max(0, imageSide - band), height: Math.min(band, imageSide) });
      break;
    }
    bands.push({ top, height: band });
  }
  return bands;
}

/**
 * Tiles that cover an image `image` CSS px large in a capture window `window` large: rows × columns of planBands,
 * row by row (one tile, the whole image, when it fits).
 */
export function planTiles(image: Size, window: Size): Tile[] {
  const rows = planBands(image.h, window.h);
  const cols = planBands(image.w, window.w);
  return rows.flatMap((row) =>
    cols.map((col) => ({ top: row.top, height: row.height, left: col.top, width: col.height })),
  );
}

/** Minimal scroll (CSS px, positive = down) that brings rows [top, top + height) of the viewport fully in view. */
export function revealDelta(top: number, height: number, viewportHeight: number): number {
  if (top < 0) return top;
  const overflow = top + height - viewportHeight;
  return overflow > 0 ? Math.min(overflow, top) : 0;
}

/** Scroll (CSS px, positive = down) that puts `band` of an image whose top is at `imageTop` at the capture window. */
export function bandScrollDelta(imageTop: number, band: Band, viewportHeight: number): number {
  return imageTop + band.top - viewportHeight * CAPTURE.windowTop;
}

/** The part of the image (`rect`, CSS px) that `tile` names; the whole image without a tile. */
export function tileRect(rect: RectCss, tile: Tile | undefined): RectCss {
  if (tile === undefined) return rect;
  return { left: rect.left + tile.left, top: rect.top + tile.top, width: tile.width, height: tile.height };
}

function axisDelta(
  start: number,
  length: number,
  windowStart: number,
  windowLength: number,
  place: boolean,
): number {
  if (place) return start - (windowStart + windowLength * CAPTURE.windowTop);
  // A side longer than the window is left alone: its tiles are placed one by one.
  if (length > windowLength + CAPTURE.edgeTolerance) return 0;
  return revealDelta(start - windowStart, length, windowLength);
}

/**
 * Scroll (CSS px, positive = down / right) that brings `target` into `window` (same coordinates): on an axis with
 * `place` its start goes to the window start (windowTop into the window), otherwise it is revealed minimally when it
 * fits (and left alone when it does not).
 */
export function revealRectDelta(
  target: RectCss,
  window: RectCss,
  place: { x: boolean; y: boolean },
): { dx: number; dy: number } {
  return {
    dx: axisDelta(target.left, target.width, window.left, window.width, place.x),
    dy: axisDelta(target.top, target.height, window.top, window.height, place.y),
  };
}

/** Which axes of `tile` are a strict part of the image (they go to the window start rather than being revealed). */
export function tilePlacement(rect: RectCss, tile: Tile | undefined): { x: boolean; y: boolean } {
  if (tile === undefined) return { x: false, y: false };
  return { x: tile.width < rect.width - 0.5, y: tile.height < rect.height - 0.5 };
}

/**
 * Scroll (CSS px, positive = down / right) that brings `tile` of an image whose content box is `rect` into the capture
 * `window` (same coordinates): a tile smaller than the image along an axis goes to the window start on that axis,
 * otherwise (and without a tile) the image is revealed minimally.
 */
export function tileDelta(rect: RectCss, window: RectCss, tile?: Tile): { dx: number; dy: number } {
  return revealRectDelta(tileRect(rect, tile), window, tilePlacement(rect, tile));
}

/** Output scale (px per CSS px) and size of a capture of an image `css` CSS px large, `scale` device px per CSS px. */
export function captureOutput(
  css: Size,
  scale: number,
  maxPixels: number,
): { scale: number; w: number; h: number } {
  const w = Math.max(1, css.w);
  const h = Math.max(1, css.h);
  const s = Math.min(
    scale > 0 && Number.isFinite(scale) ? scale : 1,
    CAPTURE.maxSide / w,
    CAPTURE.maxSide / h,
    Math.sqrt(Math.max(1, maxPixels) / (w * h)),
  );
  return { scale: s, w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Device px per CSS px of a screenshot `shot` (px) of a viewport `viewport` (CSS px), per axis. */
export function shotScale(shot: Size, viewport: Size): { x: number; y: number } {
  return { x: shot.w / Math.max(1, viewport.w), y: shot.h / Math.max(1, viewport.h) };
}

/**
 * Where one capture goes: the source rectangle in the screenshot (device px) and the destination rectangle in the
 * output image (output px). `rect` is the image's content box in viewport CSS px at capture time, `tile` the part it
 * should contribute (the whole image when omitted); only what is inside the viewport and the `clip` (a reader
 * iframe's visible part) is used. Null when that part is empty.
 */
export function bandPlacement(input: {
  rect: RectCss;
  viewport: Size;
  shot: Size;
  outScale: number;
  tile?: Tile;
  clip?: RectCss;
}): { src: PxRect; dst: PxRect } | null {
  const { rect, viewport, shot, outScale } = input;
  const tile = input.tile ?? { top: 0, height: rect.height, left: 0, width: rect.width };
  const wanted: RectCss = {
    left: rect.left + tile.left,
    top: rect.top + tile.top,
    width: tile.width,
    height: tile.height,
  };
  const inView = visiblePart(wanted, viewport);
  const seen = inView === null || input.clip === undefined ? inView : intersectRects(inView, input.clip);
  if (seen === null) return null;
  const k = shotScale(shot, viewport);
  const sx = Math.max(0, Math.round(seen.left * k.x));
  const sy = Math.max(0, Math.round(seen.top * k.y));
  const sr = Math.min(shot.w, Math.round((seen.left + seen.width) * k.x));
  const sb = Math.min(shot.h, Math.round((seen.top + seen.height) * k.y));
  // Image-relative CSS px of what is seen, then output px.
  const ix = seen.left - rect.left;
  const iy = seen.top - rect.top;
  const dx = Math.round(ix * outScale);
  const dy = Math.round(iy * outScale);
  const dr = Math.round((ix + seen.width) * outScale);
  const db = Math.round((iy + seen.height) * outScale);
  if (sr <= sx || sb <= sy || dr <= dx || db <= dy) return null;
  return { src: { x: sx, y: sy, w: sr - sx, h: sb - sy }, dst: { x: dx, y: dy, w: dr - dx, h: db - dy } };
}

/* ------------------------------------------------------------------ rate limiter */

export interface CaptureThrottle {
  /**
   * Runs `job` once every earlier job of `key` has settled and at least `minGapMs` after the previous job of `key`
   * started (FIFO). Resolves or rejects with the job's outcome.
   */
  run<T>(key: string | number, job: () => Promise<T>): Promise<T>;
  /** Jobs of `key` queued or running. */
  pending(key: string | number): number;
}

interface Lane {
  lastStart: number;
  running: boolean;
  wake: (() => void) | null;
  queue: Array<() => void>;
}

export function createCaptureThrottle(clock: Clock, minGapMs: number = CAPTURE.minGapMs): CaptureThrottle {
  const lanes = new Map<string, Lane>();

  const pump = (id: string, lane: Lane): void => {
    if (lane.running || lane.wake !== null) return;
    const next = lane.queue[0];
    // The lane stays (one per window): its lastStart spaces the next capture.
    if (next === undefined) return;
    const wait = lane.lastStart + minGapMs - clock.now();
    if (wait > 0) {
      lane.wake = clock.setTimer(() => {
        lane.wake = null;
        pump(id, lane);
      }, wait);
      return;
    }
    lane.queue.shift();
    lane.running = true;
    lane.lastStart = clock.now();
    next();
  };

  return {
    run<T>(key: string | number, job: () => Promise<T>): Promise<T> {
      const id = String(key);
      let lane = lanes.get(id);
      if (lane === undefined) {
        lane = { lastStart: Number.NEGATIVE_INFINITY, running: false, wake: null, queue: [] };
        lanes.set(id, lane);
      }
      const owner = lane;
      return new Promise<T>((resolve, reject) => {
        owner.queue.push(() => {
          let started: Promise<T>;
          try {
            started = job();
          } catch (error) {
            started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
          started.then(resolve, reject).finally(() => {
            owner.running = false;
            pump(id, owner);
          });
        });
        pump(id, owner);
      });
    },
    pending(key) {
      const lane = lanes.get(String(key));
      return lane === undefined ? 0 : lane.queue.length + (lane.running ? 1 : 0);
    },
  };
}
