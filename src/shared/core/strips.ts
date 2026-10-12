// Touching-image strips and seam windows, for bubbles split across adjacent <img> elements. PURE.
//
// groupStrips runs on page rects (CSS px, e.g. getBoundingClientRect plus scroll offsets) in DOM order: consecutive
// images whose left edges and widths match within ±2 px and whose vertical gap is 0..4 px belong to one strip
// (a gap down to −1 px is accepted for sub-pixel rounding). Groups of one image are not strips.
// seamWindows lists, for every shared edge of a strip, the band of each image next to that edge (edgePx deep) where
// a unit is a seam candidate and re-detection across the edge is needed.
// seamBand, seamCanvasPlan, crossesSeam and mapSeamBox are the engine's seam math in natural px:
// the bottom band of the upper image and the top band of the lower one (scaled to the upper width) are stacked on
// one canvas, detected once, and the units that cross the seam line are mapped back into both images.

import type { Box, Size } from "../types.ts";
import { fnv1a32 } from "../ids.ts";

export interface StripImage {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Natural size when known; seamWindows then also reports the windows in natural px. */
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface StripGroup {
  stripId: string;
  /** Members top to bottom (input order). */
  members: StripImage[];
}

export interface StripOptions {
  leftTol?: number;
  widthTol?: number;
  maxGap?: number;
  minGap?: number;
  minMembers?: number;
}

export const STRIP_DEFAULTS = {
  leftTol: 2,
  widthTol: 2,
  maxGap: 4,
  minGap: -1,
  minMembers: 2,
  /** Depth of the seam-candidate band on each side of a shared edge. */
  edgePx: 50,
  /** Seam canvas band = clamp(1.5 × tallest touching box, 0.5 W, 1.5 W). */
  bandScale: 1.5,
  bandMinFrac: 0.5,
  bandMaxFrac: 1.5,
} as const;

/** Float noise allowance for CSS-px comparisons. */
const EPS = 1e-6;

function validRect(r: StripImage): boolean {
  return [r.left, r.top, r.width, r.height].every((v) => Number.isFinite(v)) && r.width > 0 && r.height >= 0;
}

/** Strip id: stable while the first member stays the first. */
export function stripIdOf(firstKey: string): string {
  return `strip-${fnv1a32(firstKey)}`;
}

/** Groups consecutive touching images (see the module comment). */
export function groupStrips(images: readonly StripImage[], opts: StripOptions = {}): StripGroup[] {
  const leftTol = (opts.leftTol ?? STRIP_DEFAULTS.leftTol) + EPS;
  const widthTol = (opts.widthTol ?? STRIP_DEFAULTS.widthTol) + EPS;
  const maxGap = (opts.maxGap ?? STRIP_DEFAULTS.maxGap) + EPS;
  const minGap = (opts.minGap ?? STRIP_DEFAULTS.minGap) - EPS;
  const minMembers = opts.minMembers ?? STRIP_DEFAULTS.minMembers;

  const groups: StripGroup[] = [];
  let current: StripImage[] = [];
  const flush = (): void => {
    const first = current[0];
    if (first !== undefined && current.length >= minMembers) {
      groups.push({ stripId: stripIdOf(first.key), members: current });
    }
    current = [];
  };
  for (const img of images) {
    if (!validRect(img)) {
      flush();
      continue;
    }
    const prev = current[current.length - 1];
    const gap = prev === undefined ? Number.NaN : img.top - (prev.top + prev.height);
    const touching =
      prev !== undefined &&
      Math.abs(img.left - prev.left) <= leftTol &&
      Math.abs(img.width - prev.width) <= widthTol &&
      gap >= minGap &&
      gap <= maxGap;
    if (!touching) flush();
    current.push(img);
  }
  flush();
  return groups;
}

export interface RowRange {
  /** First row (inclusive). */
  y0: number;
  /** End row (exclusive). */
  y1: number;
}

export interface SeamWindow {
  seamId: string;
  /** The seam lies between members[index] and members[index + 1]. */
  index: number;
  upperKey: string;
  lowerKey: string;
  /** Page coordinate of the upper image's bottom edge (input units). */
  edge: number;
  /** Lower top − upper bottom (input units). */
  gap: number;
  /** Rows next to the edge in each image's own coordinates (input units). */
  upper: RowRange;
  lower: RowRange;
  /** The same rows in natural px, when both images carry a natural size. */
  natural?: { upper: RowRange; lower: RowRange };
}

/** Seam id of the edge between two images. */
export function seamIdOf(upperKey: string, lowerKey: string): string {
  return `seam-${fnv1a32(`${upperKey}\n${lowerKey}`)}`;
}

/** Windows around every shared edge of a strip, edgePx deep on each side (clipped to the images). */
export function seamWindows(group: StripGroup, edgePx: number = STRIP_DEFAULTS.edgePx): SeamWindow[] {
  const out: SeamWindow[] = [];
  for (let i = 0; i + 1 < group.members.length; i++) {
    const up = group.members[i];
    const low = group.members[i + 1];
    if (up === undefined || low === undefined) continue;
    const edge = up.top + up.height;
    const upper = { y0: Math.max(0, up.height - edgePx), y1: up.height };
    const lower = { y0: 0, y1: Math.min(low.height, edgePx) };
    const window: SeamWindow = {
      seamId: seamIdOf(up.key, low.key),
      index: i,
      upperKey: up.key,
      lowerKey: low.key,
      edge,
      gap: low.top - edge,
      upper,
      lower,
    };
    const nu = up.naturalHeight;
    const nl = low.naturalHeight;
    if (nu !== undefined && nl !== undefined && up.height > 0 && low.height > 0) {
      window.natural = {
        upper: { y0: Math.max(0, Math.floor((upper.y0 * nu) / up.height)), y1: nu },
        lower: { y0: 0, y1: Math.min(nl, Math.ceil((lower.y1 * nl) / low.height)) },
      };
    }
    out.push(window);
  }
  return out;
}

/** Seam canvas band height (natural px of the upper image): clamp(1.5 × tallest touching box, 0.5 W, 1.5 W). */
export function seamBand(touchingHeights: readonly number[], upperWidth: number): number {
  const tallest = touchingHeights.reduce((m, h) => Math.max(m, h), 0);
  const lo = STRIP_DEFAULTS.bandMinFrac * upperWidth;
  const hi = STRIP_DEFAULTS.bandMaxFrac * upperWidth;
  return Math.round(Math.min(Math.max(STRIP_DEFAULTS.bandScale * tallest, lo), hi));
}

export interface SeamCanvasPlan {
  /** Canvas size: upper width × 2·band. */
  width: number;
  height: number;
  /** The seam line is at canvas y = band. */
  band: number;
  /** Scale of the lower image on the canvas: W_upper / W_lower. */
  s1: number;
  /** Rows of the upper image, drawn unscaled at canvas y = upperAt (ending at the seam line). */
  upperRows: RowRange;
  upperAt: number;
  /** Rows of the lower image, drawn scaled by s1 at canvas y = band. */
  lowerRows: RowRange;
}

/** Layout of the seam canvas for a band (natural px). */
export function seamCanvasPlan(upper: Size, lower: Size, band: number): SeamCanvasPlan {
  if (!(upper.w > 0 && upper.h > 0 && lower.w > 0 && lower.h > 0 && band > 0)) {
    throw new RangeError("seamCanvasPlan: sizes and band must be positive");
  }
  const s1 = upper.w / lower.w;
  const upperRows = { y0: Math.max(0, upper.h - band), y1: upper.h };
  const lowerRows = { y0: 0, y1: Math.min(lower.h, Math.round(band / s1)) };
  return {
    width: upper.w,
    height: 2 * band,
    band,
    s1,
    upperRows,
    upperAt: band - (upperRows.y1 - upperRows.y0),
    lowerRows,
  };
}

/** A seam-canvas box crosses the seam line (y1 < band < y2). */
export function crossesSeam(box: Box, plan: SeamCanvasPlan): boolean {
  return box.y1 < plan.band && plan.band < box.y2;
}

/**
 * Maps a seam-canvas box into the upper image, (x, y + H_upper − band), or into the lower image,
 * (x / s1, (y − band) / s1). The result is not clipped: a crossing unit extends past each image's edge.
 */
export function mapSeamBox(box: Box, plan: SeamCanvasPlan, part: "upper" | "lower"): Box {
  if (part === "upper") {
    const dy = plan.upperRows.y1 - plan.band;
    return { x1: box.x1, y1: box.y1 + dy, x2: box.x2, y2: box.y2 + dy };
  }
  return {
    x1: box.x1 / plan.s1,
    y1: (box.y1 - plan.band) / plan.s1,
    x2: box.x2 / plan.s1,
    y2: (box.y2 - plan.band) / plan.s1,
  };
}
