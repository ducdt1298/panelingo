// Reading order of the translation units of one image. PURE.
//
// Band sort (the default): items are sorted by centre y; an item joins the current band when its vertical overlap
// with any member of that band is ≥ 0.5 of the shorter box (geometry.vOverlap); bands run top to bottom; inside a
// band items run by centre x, ascending for "ltr" and descending for "rtl". Equal keys keep the input order. Items
// flagged edgeSmall (probable page numbers and watermarks) come after all the others, band-sorted among themselves.
// Webtoon and manhua strips use "ltr", which reads them top-down.
//
// Panels: a PanelSegmenter splits the items into panels in reading order, and each panel is then ordered
// by a LeafSorter (band sort by default). For rtl manga pages (orderHooksFor("rtl")) the segmenter is gutterCut, a
// recursive XY-cut on the unit boxes (rows at horizontal gaps first, then panels at vertical gaps, right to left),
// and the leaf sorter is cornerSort, Magi's distance-to-the-top-right-corner rule. Malformed hook output falls back
// to the plain band sort, so order errors never break translation (ids are explicit).

import { center, height, unionAll, vOverlap, width } from "../geometry.ts";
import type { Box, Lang, ReadingDir, Size } from "../types.ts";

export interface OrderItem {
  /** The unit box: bubble ?? text. */
  box: Box;
  edgeSmall?: boolean;
}

/** Splits items into panels, in reading order; each panel lists item indices. Must partition 0..n-1. */
export type PanelSegmenter = (items: readonly OrderItem[], dir: ReadingDir) => number[][];
/** Orders the given item indices of one panel. Must return a permutation of `indices`. */
export type LeafSorter = (
  items: readonly OrderItem[],
  indices: readonly number[],
  dir: ReadingDir,
) => number[];

export interface ReadingOrderOptions {
  dir: ReadingDir;
  /** Minimum vertical overlap (fraction of the shorter box) to share a band. */
  bandOverlap?: number;
  segmenter?: PanelSegmenter;
  leafSorter?: LeafSorter;
}

export const ORDER_DEFAULTS = {
  bandOverlap: 0.5,
  /** Images with h / w above this are strips: read top-down, ltr. */
  stripAspect: 2.2,
  /** Median text-box h / w above this means vertical text: rtl. */
  verticalAspect: 1.2,
} as const;

/** Every item in one panel: the default (band sort of the whole image). */
export const singlePanel: PanelSegmenter = (items) => [items.map((_, i) => i)];

/** Band sort of `indices` (see the module comment). */
export function bandSort(
  items: readonly OrderItem[],
  indices: readonly number[],
  dir: ReadingDir,
  bandOverlap: number = ORDER_DEFAULTS.bandOverlap,
): number[] {
  const boxOf = (i: number): Box => {
    const item = items[i];
    if (item === undefined) throw new RangeError(`reading-order: no item ${i}`);
    return item.box;
  };
  const keys = new Map<number, { x: number; y: number }>();
  for (const i of indices) {
    const c = center(boxOf(i));
    keys.set(i, { x: dir === "rtl" ? -c.x : c.x, y: c.y });
  }
  const kx = (i: number): number => keys.get(i)?.x ?? 0;
  const ky = (i: number): number => keys.get(i)?.y ?? 0;

  const sorted = [...indices].sort((a, b) => ky(a) - ky(b) || kx(a) - kx(b) || a - b);
  const bands: number[][] = [];
  for (const i of sorted) {
    const band = bands[bands.length - 1];
    if (band !== undefined && band.some((j) => vOverlap(boxOf(i), boxOf(j)) >= bandOverlap)) band.push(i);
    else bands.push([i]);
  }
  return bands.flatMap((band) => band.sort((a, b) => kx(a) - kx(b) || ky(a) - ky(b) || a - b));
}

function isPermutation(candidate: readonly number[], expected: readonly number[]): boolean {
  if (candidate.length !== expected.length) return false;
  const want = new Set(expected);
  const seen = new Set<number>();
  for (const i of candidate) {
    if (!want.has(i) || seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

/** Item indices in reading order. */
export function readingOrder(items: readonly OrderItem[], opts: ReadingOrderOptions): number[] {
  const { dir } = opts;
  const bandOverlap = opts.bandOverlap ?? ORDER_DEFAULTS.bandOverlap;
  const band = (indices: readonly number[]): number[] => bandSort(items, indices, dir, bandOverlap);
  const leaf = (indices: readonly number[]): number[] => {
    if (opts.leafSorter === undefined) return band(indices);
    const sorted = opts.leafSorter(items, indices, dir);
    return isPermutation(sorted, indices) ? sorted : band(indices);
  };

  const normal: number[] = [];
  const small: number[] = [];
  items.forEach((item, i) => (item.edgeSmall === true ? small : normal).push(i));

  const sub = normal.map((i) => items[i] as OrderItem);
  let panels = (opts.segmenter ?? singlePanel)(sub, dir);
  if (!isPermutation(panels.flat(), [...sub.keys()])) panels = singlePanel(sub, dir);

  const out: number[] = [];
  for (const panel of panels) out.push(...leaf(panel.map((j) => normal[j] as number)));
  out.push(...band(small));
  return out;
}

/* ------------------------------------------------------------------ manga pages */

export const GUTTER_DEFAULTS = {
  /** A gap narrower than this (natural px) never separates panels: touching or nearly touching boxes. */
  minGapPx: 2,
  /** Nor one narrower than this fraction of the longer side of the items' extent. */
  minGapFrac: 0.004,
  /** Recursion depth; a deeper node is one panel for the leaf sorter. */
  maxDepth: 8,
} as const;

export interface GutterOptions {
  minGapPx?: number;
  minGapFrac?: number;
  maxDepth?: number;
}

function boxAt(items: readonly OrderItem[], i: number): Box {
  const item = items[i];
  if (item === undefined) throw new RangeError(`reading-order: no item ${i}`);
  return item.box;
}

/**
 * Groups `indices` into runs along one axis ("y": rows, "x": columns): items whose extents on that axis overlap or
 * lie less than `minGap` apart share a run. Runs come in ascending coordinate order. A gap between two runs is an
 * empty band across every item of the node, which is what a gutter looks like when only the unit boxes are known.
 */
export function axisRuns(
  items: readonly OrderItem[],
  indices: readonly number[],
  axis: "x" | "y",
  minGap: number,
): number[][] {
  const lo = (i: number): number => (axis === "x" ? boxAt(items, i).x1 : boxAt(items, i).y1);
  const hi = (i: number): number => (axis === "x" ? boxAt(items, i).x2 : boxAt(items, i).y2);
  const sorted = [...indices].sort((a, b) => lo(a) - lo(b) || hi(a) - hi(b) || a - b);
  const runs: number[][] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const i of sorted) {
    const run = runs[runs.length - 1];
    const gap = lo(i) - end;
    if (run !== undefined && !(gap > 0 && gap >= minGap)) {
      run.push(i);
      end = Math.max(end, hi(i));
    } else {
      runs.push([i]);
      end = hi(i);
    }
  }
  return runs;
}

/**
 * Recursive gutter cutting on the unit boxes (box-only XY-cut): a node is split at every horizontal gap
 * into rows, top to bottom (the same order as cutting the widest gap first, with less depth); a node without one is
 * split at its vertical gaps into panels, right to left for "rtl" and left to right for "ltr"; each part recurses.
 * A node with neither gap (or at maxDepth) is one panel, ordered by the leaf sorter.
 */
export function gutterCut(options: GutterOptions = {}): PanelSegmenter {
  const minGapPx = options.minGapPx ?? GUTTER_DEFAULTS.minGapPx;
  const minGapFrac = options.minGapFrac ?? GUTTER_DEFAULTS.minGapFrac;
  const maxDepth = options.maxDepth ?? GUTTER_DEFAULTS.maxDepth;
  return (items, dir) => {
    const extent = unionAll(items.map((item) => item.box));
    if (extent === null) return [];
    const minGap = Math.max(minGapPx, minGapFrac * Math.max(width(extent), height(extent)));
    const cut = (indices: number[], depth: number): number[][] => {
      if (indices.length <= 1 || depth >= maxDepth) return [indices];
      const rows = axisRuns(items, indices, "y", minGap);
      if (rows.length > 1) return rows.flatMap((row) => cut(row, depth + 1));
      const columns = axisRuns(items, indices, "x", minGap);
      if (columns.length > 1) {
        if (dir === "rtl") columns.reverse();
        return columns.flatMap((column) => cut(column, depth + 1));
      }
      return [indices];
    };
    return cut(
      items.map((_, i) => i),
      0,
    );
  };
}

/** Distance from a point to the nearest point of a box (0 inside or on it). */
function pointToBox(x: number, y: number, b: Box): number {
  const dx = Math.max(b.x1 - x, 0, x - b.x2);
  const dy = Math.max(b.y1 - y, 0, y - b.y2);
  return Math.hypot(dx, dy);
}

/**
 * Magi's corner rule inside one panel: the reference corner is (max x2, min y1) of the panel's items for "rtl"
 * ((min x1, min y1) for "ltr"); items run by their distance to it, ascending. Ties: the distance from the corner to
 * the item's own top-right (top-left) corner, then the input order.
 */
export const cornerSort: LeafSorter = (items, indices, dir) => {
  if (indices.length <= 1) return [...indices];
  const boxes = indices.map((i) => boxAt(items, i));
  const top = Math.min(...boxes.map((b) => b.y1));
  const side = dir === "rtl" ? Math.max(...boxes.map((b) => b.x2)) : Math.min(...boxes.map((b) => b.x1));
  const keys = new Map<number, { d: number; own: number }>();
  for (const i of indices) {
    const b = boxAt(items, i);
    keys.set(i, {
      d: pointToBox(side, top, b),
      own: Math.hypot((dir === "rtl" ? b.x2 : b.x1) - side, b.y1 - top),
    });
  }
  const key = (i: number): { d: number; own: number } => keys.get(i) ?? { d: 0, own: 0 };
  return [...indices].sort((a, b) => key(a).d - key(b).d || key(a).own - key(b).own || a - b);
};

const GUTTER_CUT: PanelSegmenter = gutterCut();

/**
 * Reading-order hooks for a direction: "rtl" (manga pages) gets the gutter cut and the corner rule; "ltr" keeps the
 * plain band sort (webtoon, manhua and western pages).
 */
export function orderHooksFor(dir: ReadingDir): Pick<ReadingOrderOptions, "segmenter" | "leafSorter"> {
  return dir === "rtl" ? { segmenter: GUTTER_CUT, leafSorter: cornerSort } : {};
}

export interface ReadingDirHints {
  size: Size;
  /** User choice for the series (SeriesProfile.readingDir; no series memory yet, so the engine never sets it). */
  series?: ReadingDir | "auto" | null;
  /** Site rule (site layout setting). */
  site?: ReadingDir | "auto" | null;
  /** Source language, from the series or the first @lang votes. */
  lang?: Lang | "auto" | null;
  /** Text boxes of the image, for the vertical-text heuristic. */
  textBoxes?: readonly Box[];
}

/**
 * Reading direction, by precedence: series → site → heuristic (strips read ltr top-down; mostly vertical
 * text reads rtl) → language (ja → rtl) → ltr.
 */
export function chooseReadingDir(hints: ReadingDirHints): ReadingDir {
  if (hints.series === "ltr" || hints.series === "rtl") return hints.series;
  if (hints.site === "ltr" || hints.site === "rtl") return hints.site;
  const { w, h } = hints.size;
  if (w > 0 && h / w > ORDER_DEFAULTS.stripAspect) return "ltr";
  const aspects = (hints.textBoxes ?? [])
    .filter((b) => width(b) > 0 && height(b) > 0)
    .map((b) => height(b) / width(b))
    .sort((a, b) => a - b);
  if (aspects.length > 0) {
    const mid = aspects.length >> 1;
    const med =
      aspects.length % 2 === 1 ? (aspects[mid] ?? 0) : ((aspects[mid - 1] ?? 0) + (aspects[mid] ?? 0)) / 2;
    if (med > ORDER_DEFAULTS.verticalAspect) return "rtl";
  }
  return hints.lang === "ja" ? "rtl" : "ltr";
}
