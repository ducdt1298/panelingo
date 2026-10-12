// Text orientation and glyph-size heuristics. PURE.
//
// glyphPx is the estimated glyph height in natural px (glyph width for vertical text). It sizes composite crops
// (target 30/32/22 px), the erase dilation and the text-fit ceiling, so erring small is safer than erring large:
// a small estimate only enlarges a crop, a large one can leave text unreadable for the AI.
//
// Two estimators:
// - estimateGlyphPx(boxes, orientation): geometry only (buildUnits has no pixels). Assumptions: glyphs are about
//   square; lines (columns for vertical text) repeat every linePitch = 1.3 glyphs, so a block of n lines is
//   g × (1.3n − 0.3) thick; the line count of each box is snapped to the nearest integer using a prior glyph size
//   (default 3% of the image's short side: 24 px on an 800-px-wide webtoon). Without a prior every box counts as a
//   single line. The unit's value is the median over its boxes, clamped to [6, 400].
// - glyphPxFromGray(gray, w, h, box, orientation): pixels. Otsu inside the box, the minority side is ink
//   (so dark-on-light and light-on-dark both work); row profile for horizontal text, column profile for vertical;
//   runs above 8% of the profile maximum, merging gaps shorter than 2 px; 75th percentile of run lengths (ignores
//   furigana and punctuation-only runs); fallback min(w, h); clamped to [6, 400].

import { area, height, width } from "../geometry.ts";
import type { Box, Size } from "../types.ts";

export type Orientation = "h" | "v";

export const GLYPH_DEFAULTS = {
  /** A box is vertical text when h / w > 1.2 (comic-translate's rule). */
  verticalAspect: 1.2,
  /** Line (or column) pitch in glyphs. */
  linePitch: 1.3,
  /** Prior glyph size as a fraction of the image's short side. */
  priorFrac: 0.03,
  minPx: 6,
  maxPx: 400,
  /** Pixel estimator: profile runs above this fraction of the maximum. */
  profileFrac: 0.08,
  /** Pixel estimator: runs separated by fewer rows than this are merged. */
  mergeGapPx: 2,
  /** Pixel estimator: percentile of run lengths. */
  percentile: 0.75,
} as const;

export interface OrientationOptions {
  verticalAspect?: number;
  /** False for scripts that are never set vertically (Korean webtoons, Latin): always "h". */
  allowVertical?: boolean;
}

/** "v" when the box is clearly taller than wide (h / w > verticalAspect). */
export function orientationOf(b: Box, verticalAspect: number = GLYPH_DEFAULTS.verticalAspect): Orientation {
  const w = width(b);
  return w > 0 && height(b) / w > verticalAspect ? "v" : "h";
}

/** Orientation of a unit: the area-weighted majority of its text boxes (ties and empty input give "h"). */
export function unitOrientation(boxes: readonly Box[], opts: OrientationOptions = {}): Orientation {
  if (opts.allowVertical === false) return "h";
  const aspect = opts.verticalAspect ?? GLYPH_DEFAULTS.verticalAspect;
  let vertical = 0;
  let horizontal = 0;
  for (const b of boxes) {
    if (orientationOf(b, aspect) === "v") vertical += area(b);
    else horizontal += area(b);
  }
  return vertical > horizontal ? "v" : "h";
}

/** Prior glyph size for an image: priorFrac × short side. */
export function glyphPriorPx(size: Size, frac: number = GLYPH_DEFAULTS.priorFrac): number {
  return frac * Math.min(size.w, size.h);
}

export interface GlyphEstimateOptions {
  /** Expected glyph size in px; enables line-count snapping (see glyphPriorPx). */
  priorPx?: number;
  linePitch?: number;
  minPx?: number;
  maxPx?: number;
}

function clampPx(v: number, minPx: number, maxPx: number): number {
  return Math.min(Math.max(Math.round(v), minPx), maxPx);
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const hi = s[mid] ?? 0;
  return s.length % 2 === 1 ? hi : ((s[mid - 1] ?? hi) + hi) / 2;
}

/** Geometry-only glyph size of a unit (see the module comment for the assumptions). */
export function estimateGlyphPx(
  textBoxes: readonly Box[],
  orientation: Orientation,
  opts: GlyphEstimateOptions = {},
): number {
  const pitch = opts.linePitch ?? GLYPH_DEFAULTS.linePitch;
  const minPx = opts.minPx ?? GLYPH_DEFAULTS.minPx;
  const maxPx = opts.maxPx ?? GLYPH_DEFAULTS.maxPx;
  const prior = opts.priorPx;
  const perBox: number[] = [];
  for (const b of textBoxes) {
    const thickness = orientation === "h" ? height(b) : width(b);
    if (!(thickness > 0)) continue;
    let lines = 1;
    if (prior !== undefined && prior > 0) {
      lines = Math.max(1, Math.round((thickness + (pitch - 1) * prior) / (pitch * prior)));
    }
    perBox.push(thickness / (pitch * lines - (pitch - 1)));
  }
  return perBox.length === 0 ? minPx : clampPx(median(perBox), minPx, maxPx);
}

/** Otsu threshold of a 256-bin histogram: values ≤ t form the dark class. */
export function otsuThreshold(hist: ArrayLike<number>): number {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    const c = hist[i] ?? 0;
    total += c;
    sum += i * c;
  }
  let weightDark = 0;
  let sumDark = 0;
  let best = -1;
  let threshold = 0;
  for (let t = 0; t < 256; t++) {
    const c = hist[t] ?? 0;
    weightDark += c;
    sumDark += t * c;
    const weightLight = total - weightDark;
    if (weightDark === 0) continue;
    if (weightLight === 0) break;
    const diff = sumDark / weightDark - (sum - sumDark) / weightLight;
    const between = weightDark * weightLight * diff * diff;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

export interface GlyphPixelOptions {
  profileFrac?: number;
  mergeGapPx?: number;
  percentile?: number;
  minPx?: number;
  maxPx?: number;
}

/**
 * Pixel-based glyph size inside `box` of a row-major grey image (one byte per px). Returns the fallback
 * min(box w, box h) when the box holds no two-tone content.
 */
export function glyphPxFromGray(
  gray: ArrayLike<number>,
  imgW: number,
  imgH: number,
  box: Box,
  orientation: Orientation,
  opts: GlyphPixelOptions = {},
): number {
  if (gray.length < imgW * imgH)
    throw new RangeError(`glyphPxFromGray: buffer too small for ${imgW}×${imgH}`);
  const minPx = opts.minPx ?? GLYPH_DEFAULTS.minPx;
  const maxPx = opts.maxPx ?? GLYPH_DEFAULTS.maxPx;
  const x0 = Math.max(0, Math.floor(box.x1));
  const x1 = Math.min(imgW, Math.ceil(box.x2));
  const y0 = Math.max(0, Math.floor(box.y1));
  const y1 = Math.min(imgH, Math.ceil(box.y2));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return minPx;
  const fallback = clampPx(Math.min(bw, bh), minPx, maxPx);

  const hist = new Float64Array(256);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (gray[y * imgW + x] ?? 0) & 255;
      hist[k] = (hist[k] ?? 0) + 1;
    }
  }
  const t = otsuThreshold(hist);
  let dark = 0;
  for (let i = 0; i <= t; i++) dark += hist[i] ?? 0;
  const light = bw * bh - dark;
  if (dark === 0 || light === 0) return fallback;
  const inkIsDark = dark <= light;

  const horizontal = orientation === "h";
  const profile = new Float64Array(horizontal ? bh : bw);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = gray[y * imgW + x] ?? 0;
      if (inkIsDark ? v <= t : v > t) {
        const k = horizontal ? y - y0 : x - x0;
        profile[k] = (profile[k] ?? 0) + 1;
      }
    }
  }
  let max = 0;
  for (const v of profile) max = Math.max(max, v);
  if (max === 0) return fallback;

  const cut = (opts.profileFrac ?? GLYPH_DEFAULTS.profileFrac) * max;
  const mergeGap = opts.mergeGapPx ?? GLYPH_DEFAULTS.mergeGapPx;
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= profile.length; i++) {
    const on = i < profile.length && (profile[i] ?? 0) > cut;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      const last = runs[runs.length - 1];
      if (last !== undefined && start - last[1] < mergeGap) last[1] = i;
      else runs.push([start, i]);
      start = -1;
    }
  }
  if (runs.length === 0) return fallback;
  // Nearest-rank percentile.
  const lengths = runs.map(([a, b]) => b - a).sort((a, b) => a - b);
  const p = opts.percentile ?? GLYPH_DEFAULTS.percentile;
  const rank = Math.min(lengths.length - 1, Math.max(0, Math.ceil(p * lengths.length) - 1));
  return clampPx(lengths[rank] ?? fallback, minPx, maxPx);
}
