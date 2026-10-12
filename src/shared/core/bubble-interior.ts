// Balloon interior from pixels. The detector's bubble box often reaches a few px past the balloon
// outline (and includes the outline itself). erase-core samples the background and decides what is erasable inside
// that box, and the overlay fits the translation into it, so a box that is too big lets the outline (or the page
// beyond it) leak into the background model and puts text on the outline. This finds the outline by scanning out
// from the text box along a few scanlines per side and returns the box just inside it. PURE.
//
// Steps: the balloon colour is the per-channel median of a thin band just outside the text box; on each side, three
// scanlines through the middle of the text box walk outward from just past that band (glyph ink that pokes out of a
// tight text box is never taken for the outline) until a pixel differs from that
// colour by more than `strongDist` (the outline, whatever its colour); the side moves to that pixel when at least
// two scanlines agree (the outermost hit). Sides without a hit keep the detector's edge. The result always contains
// the text box and never grows past the bubble box.

import type { ImageDataLike } from "../gfx.ts";
import type { Box, RGB } from "../types.ts";

export interface InteriorOptions {
  /** Max-channel distance from the balloon colour that counts as outline. */
  strongDist: number;
  /** Band just outside the text box that gives the balloon colour (px). */
  bandPx: number;
  /** Scanline positions across the text box, as fractions of its extent. */
  scanFracs: readonly number[];
  /** Scanlines that must find the outline before a side moves. */
  minHits: number;
  /** Gap left between the interior and the outline (px). */
  marginPx: number;
}

export const INTERIOR_DEFAULTS: Readonly<InteriorOptions> = Object.freeze({
  strongDist: 40,
  bandPx: 3,
  scanFracs: Object.freeze([0.35, 0.5, 0.65]),
  minHits: 2,
  marginPx: 1,
});

export interface Interior {
  box: Box;
  /** Balloon colour the scan compared against, or null when it could not be measured. */
  fill: RGB | null;
  /** Sides that moved to an outline. */
  snapped: { left: boolean; top: boolean; right: boolean; bottom: boolean };
  /**
   * The interior's corners are balloon colour too: a box-shaped caption or sign, where the translation can use the
   * whole rectangle instead of the inscribed ellipse.
   */
  rectLike: boolean;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? (values[mid] ?? 0) : ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
}

/**
 * The box just inside the balloon outline. `pixels` is an RGBA crop whose top-left pixel is at `origin` (natural
 * px); `text` and `bubble` are natural-px boxes. Without an outline in reach the bubble box is returned unchanged.
 */
export function balloonInterior(
  pixels: ImageDataLike,
  origin: { readonly x: number; readonly y: number },
  text: Box,
  bubble: Box,
  options: Partial<InteriorOptions> = {},
): Interior {
  const o: InteriorOptions = { ...INTERIOR_DEFAULTS, ...options };
  const same: Interior = {
    box: { ...bubble },
    fill: null,
    snapped: { left: false, top: false, right: false, bottom: false },
    rectLike: false,
  };
  const w = pixels.width;
  const h = pixels.height;
  if (w === 0 || h === 0) return same;
  const inCrop = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  const idx = (x: number, y: number): number => (y * w + x) * 4;

  // Crop coordinates of the text box (whole pixels, inclusive-exclusive).
  const tx1 = Math.floor(text.x1 - origin.x);
  const ty1 = Math.floor(text.y1 - origin.y);
  const tx2 = Math.ceil(text.x2 - origin.x);
  const ty2 = Math.ceil(text.y2 - origin.y);
  const bx1 = Math.ceil(bubble.x1 - origin.x);
  const by1 = Math.ceil(bubble.y1 - origin.y);
  const bx2 = Math.floor(bubble.x2 - origin.x);
  const by2 = Math.floor(bubble.y2 - origin.y);
  if (tx2 <= tx1 || ty2 <= ty1) return same;

  // 1. Balloon colour: the band just outside the text box, inside the bubble box and the crop.
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = ty1 - o.bandPx; y < ty2 + o.bandPx; y++) {
    for (let x = tx1 - o.bandPx; x < tx2 + o.bandPx; x++) {
      if (x >= tx1 && x < tx2 && y >= ty1 && y < ty2) continue;
      if (!inCrop(x, y) || x < bx1 || x >= bx2 || y < by1 || y >= by2) continue;
      const k = idx(x, y);
      rs.push(pixels.data[k] ?? 0);
      gs.push(pixels.data[k + 1] ?? 0);
      bs.push(pixels.data[k + 2] ?? 0);
    }
  }
  if (rs.length < 8) return same;
  const fill: RGB = [Math.round(median(rs)), Math.round(median(gs)), Math.round(median(bs))];
  const strong = (x: number, y: number): boolean => {
    const k = idx(x, y);
    return (
      Math.max(
        Math.abs((pixels.data[k] ?? 0) - fill[0]),
        Math.abs((pixels.data[k + 1] ?? 0) - fill[1]),
        Math.abs((pixels.data[k + 2] ?? 0) - fill[2]),
      ) > o.strongDist
    );
  };

  // 2. Walk outward from the text box on scanlines through its middle; the first strong pixel is the outline.
  const across = (lo: number, hi: number): number[] => o.scanFracs.map((f) => Math.round(lo + f * (hi - lo)));
  // The outermost hit: off-centre scanlines meet an elliptical outline closer in, the interior box is its extent.
  const hit = (positions: number[], outward: 1 | -1): number | null =>
    positions.length >= o.minHits ? (outward < 0 ? Math.min(...positions) : Math.max(...positions)) : null;
  const scan = (
    start: number,
    stop: number,
    step: number,
    at: (t: number) => [number, number],
  ): number | null => {
    for (let t = start; step > 0 ? t < stop : t > stop; t += step) {
      const [x, y] = at(t);
      if (!inCrop(x, y)) return null;
      if (strong(x, y)) return t;
    }
    return null;
  };
  const left: number[] = [];
  const right: number[] = [];
  for (const y of across(ty1, ty2 - 1)) {
    const l = scan(tx1 - 1 - o.bandPx, bx1 - 1, -1, (t) => [t, y]);
    if (l !== null) left.push(l);
    const r = scan(tx2 + o.bandPx, bx2, 1, (t) => [t, y]);
    if (r !== null) right.push(r);
  }
  const top: number[] = [];
  const bottom: number[] = [];
  for (const x of across(tx1, tx2 - 1)) {
    const t = scan(ty1 - 1 - o.bandPx, by1 - 1, -1, (s) => [x, s]);
    if (t !== null) top.push(t);
    const b = scan(ty2 + o.bandPx, by2, 1, (s) => [x, s]);
    if (b !== null) bottom.push(b);
  }

  // 3. Move the sides that found the outline (never inside the text box, never past the bubble box).
  const box: Box = { ...bubble };
  const snapped = { left: false, top: false, right: false, bottom: false };
  const l = hit(left, -1);
  if (l !== null) {
    box.x1 = Math.min(text.x1, Math.max(bubble.x1, origin.x + l + 1 + o.marginPx));
    snapped.left = true;
  }
  const r = hit(right, 1);
  if (r !== null) {
    box.x2 = Math.max(text.x2, Math.min(bubble.x2, origin.x + r - o.marginPx));
    snapped.right = true;
  }
  const t = hit(top, -1);
  if (t !== null) {
    box.y1 = Math.min(text.y1, Math.max(bubble.y1, origin.y + t + 1 + o.marginPx));
    snapped.top = true;
  }
  const b = hit(bottom, 1);
  if (b !== null) {
    box.y2 = Math.max(text.y2, Math.min(bubble.y2, origin.y + b - o.marginPx));
    snapped.bottom = true;
  }
  // 4. Box-shaped balloon: walking diagonally from each text-box corner to the matching interior corner never
  // crosses the outline (an elliptical balloon's outline cuts every corner of its bounding box, whatever the page
  // colour beyond it).
  let rectLike = false;
  if (snapped.left && snapped.right && snapped.top && snapped.bottom) {
    const inset = 1 + o.marginPx;
    const clearPath = (fx: number, fy: number, tx: number, ty: number): boolean => {
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(tx - fx), Math.abs(ty - fy))));
      for (let i = 0; i <= steps; i++) {
        const x = Math.round(fx + ((tx - fx) * i) / steps - origin.x);
        const y = Math.round(fy + ((ty - fy) * i) / steps - origin.y);
        if (!inCrop(x, y) || strong(x, y)) return false;
      }
      return true;
    };
    const corners: Array<[number, number, number, number]> = [
      [text.x1, text.y1, box.x1 + inset, box.y1 + inset],
      [text.x2 - 1, text.y1, box.x2 - 1 - inset, box.y1 + inset],
      [text.x1, text.y2 - 1, box.x1 + inset, box.y2 - 1 - inset],
      [text.x2 - 1, text.y2 - 1, box.x2 - 1 - inset, box.y2 - 1 - inset],
    ];
    // Start just outside the text box corner so glyph ink in the corner does not count.
    const pad = o.bandPx;
    let clear = 0;
    for (const [fx, fy, tx, ty] of corners) {
      const sx = fx + Math.sign(tx - fx) * pad;
      const sy = fy + Math.sign(ty - fy) * pad;
      if (clearPath(sx, sy, tx, ty)) clear += 1;
    }
    rectLike = clear >= 3;
  }
  return { box, fill, snapped, rectLike };
}

export interface FlatFillOptions {
  /** Max-channel distance from the balloon colour that still counts as that colour. */
  tolerance: number;
  /** Share of the sampled band that must be balloon colour. */
  minShare: number;
  /** Fewest band pixels worth deciding on. */
  minSamples: number;
}

export const FLAT_FILL_DEFAULTS: Readonly<FlatFillOptions> = Object.freeze({
  tolerance: 24,
  minShare: 0.85,
  minSamples: 24,
});

/**
 * True when a box-shaped balloon (all four sides snapped to its outline, rect-like) has a flat interior: the band
 * between the interior edges and the text box is balloon colour. Text that fills a caption leaves erase-core no
 * background ring to check, yet the outline scan already proved the box: filling the whole interior with the
 * balloon colour erases the lettering and keeps the frame.
 */
export function isFlatBoxInterior(
  pixels: ImageDataLike,
  origin: { readonly x: number; readonly y: number },
  interior: Interior,
  text: Box,
  opts: Partial<FlatFillOptions> = {},
): boolean {
  const o: FlatFillOptions = { ...FLAT_FILL_DEFAULTS, ...opts };
  const { snapped, fill, box } = interior;
  if (!interior.rectLike || fill === null) return false;
  if (!(snapped.left && snapped.top && snapped.right && snapped.bottom)) return false;
  let samples = 0;
  let flat = 0;
  const x1 = Math.ceil(box.x1);
  const y1 = Math.ceil(box.y1);
  const x2 = Math.floor(box.x2);
  const y2 = Math.floor(box.y2);
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      // The band only: pixels inside the text box are glyphs or the counters between them.
      if (x >= text.x1 - 1 && x < text.x2 + 1 && y >= text.y1 - 1 && y < text.y2 + 1) continue;
      const cx = x - origin.x;
      const cy = y - origin.y;
      if (cx < 0 || cy < 0 || cx >= pixels.width || cy >= pixels.height) continue;
      const k = (cy * pixels.width + cx) * 4;
      const d = Math.max(
        Math.abs((pixels.data[k] ?? 0) - fill[0]),
        Math.abs((pixels.data[k + 1] ?? 0) - fill[1]),
        Math.abs((pixels.data[k + 2] ?? 0) - fill[2]),
      );
      samples += 1;
      if (d <= o.tolerance) flat += 1;
    }
  }
  return samples >= o.minSamples && flat >= o.minShare * samples;
}

/** An opaque RGBA patch of one colour (the flat-fill erase of a box-shaped balloon). */
export function solidPatch(width: number, height: number, color: RGB): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let k = 0; k < data.length; k += 4) {
    data[k] = color[0];
    data[k + 1] = color[1];
    data[k + 2] = color[2];
    data[k + 3] = 255;
  }
  return { width, height, data };
}
