// Slice plan for tall strips and wide spreads. PURE.
//
// The detector stretches every input to 640×640, so an image whose long side is more than `trigger` × its short
// side is cut along the long axis into overlapping slices of `ratio` × short side. Offsets are spread evenly: the
// first slice starts at 0, the last one ends exactly at the far edge, and consecutive slices overlap by at least
// max(overlapRatio × slice, minOverlapPx), capped at half a slice. Every parameter can be overridden; the defaults
// were chosen from a sweep of trigger {2.0, 2.5, 3.0, 3.5} × ratio {1.5, 2.0, 2.5, 3.0}, quiet rows on/off.
//
// Quiet rows (optional, the detector.quietRows setting, off by default): given per-row flags from the SmartStitch
// rule (every adjacent-pixel grey difference ≤ 25, see quietRowsFromGray), each slice edge moves onto a run of quiet
// rows within ±quietWindowFrac × slice of its even position. Only runs of at least quietMinRun rows qualify, because
// the gaps between text lines inside a borderless bubble are quiet too, but short. By default the longest qualifying
// run wins, then the nearest one; the edge lands as close to the run's middle as the constraints allow. A move is
// kept only if every guarantee still holds: overlap floor, slice length ≤ (1 + quietMaxGrowth) × nominal, strictly
// increasing starts and ends, first slice at 0 and last slice at the far edge.

import type { Size } from "../types.ts";

/** One detector input rectangle in natural px of the image. */
export interface Slice {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SliceAxis = "none" | "vertical" | "horizontal";

export interface SlicePlan {
  axis: SliceAxis;
  /** Nominal slice length along the axis (px); the long side when the image is not sliced. */
  sliceLen: number;
  /** Guaranteed minimum overlap between consecutive slices (px); 0 when the image is not sliced. */
  overlap: number;
  slices: Slice[];
  /** Number of slice edges placed on quiet runs. */
  quietEdges: number;
}

export interface SliceOptions {
  /** Slice when long side / short side > trigger. */
  trigger?: number;
  /** Nominal slice length = round(ratio × short side). */
  ratio?: number;
  /** Overlap floor = max(round(overlapRatio × slice), minOverlapPx), capped at half a slice. */
  overlapRatio?: number;
  minOverlapPx?: number;
  /** Quiet flags per row (1 = quiet) for tall images; length H. Missing rows count as not quiet. */
  rowQuiet?: ArrayLike<number>;
  /** Quiet flags per column for wide images; length W. */
  colQuiet?: ArrayLike<number>;
  /** Search window around each even edge, as a fraction of the nominal slice length. */
  quietWindowFrac?: number;
  /** Shortest run of quiet rows that may host an edge (default max(8, round(0.02 × short side))). */
  quietMinRun?: number;
  /** A slice may grow by at most this fraction of its nominal length when its edges move onto quiet runs. */
  quietMaxGrowth?: number;
  /** Which qualifying run wins: the longest (ties: nearest) or the nearest (ties: longest). */
  quietPick?: "longest" | "nearest";
}

export const SLICER_DEFAULTS = {
  trigger: 3.5,
  ratio: 3.0,
  overlapRatio: 0.2,
  minOverlapPx: 200,
  quietWindowFrac: 0.15,
  quietMaxGrowth: 0.15,
  quietMinRunPx: 8,
  quietMinRunFrac: 0.02,
  quietThreshold: 25,
  quietMarginFrac: 0.01,
} as const;

/** Default shortest quiet run: max(8, round(0.02 × short side)), i.e. 16 rows for an 800-px-wide strip. */
export function defaultQuietMinRun(shortSide: number): number {
  return Math.max(SLICER_DEFAULTS.quietMinRunPx, Math.round(SLICER_DEFAULTS.quietMinRunFrac * shortSide));
}

interface EvenPlan {
  vertical: boolean;
  long: number;
  short: number;
  sliceLen: number;
  overlap: number;
  starts: number[];
  ends: number[];
}

function positive(name: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0))
    throw new RangeError(`slicer: ${name} must be > 0, got ${value}`);
  return value;
}

function evenPlan(size: Size, opts: SliceOptions): EvenPlan | null {
  const { w, h } = size;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) {
    throw new RangeError(`slicer: size must be positive integers, got ${w}×${h}`);
  }
  const trigger = positive("trigger", opts.trigger ?? SLICER_DEFAULTS.trigger);
  const ratio = positive("ratio", opts.ratio ?? SLICER_DEFAULTS.ratio);
  const overlapRatio = opts.overlapRatio ?? SLICER_DEFAULTS.overlapRatio;
  const minOverlapPx = opts.minOverlapPx ?? SLICER_DEFAULTS.minOverlapPx;
  if (!(overlapRatio >= 0 && overlapRatio < 1)) throw new RangeError(`slicer: overlapRatio ${overlapRatio}`);
  if (!(minOverlapPx >= 0)) throw new RangeError(`slicer: minOverlapPx ${minOverlapPx}`);

  const vertical = h >= w;
  const long = vertical ? h : w;
  const short = vertical ? w : h;
  if (long / short <= trigger) return null;
  const sliceLen = Math.max(1, Math.round(ratio * short));
  if (sliceLen >= long) return null;
  const overlap = Math.min(
    Math.max(Math.round(sliceLen * overlapRatio), Math.round(minOverlapPx)),
    Math.floor(sliceLen / 2),
  );
  // Fewest slices whose even spread keeps the overlap floor: the step (long - slice) / (n - 1) is at most
  // slice - overlap, an integer, so rounding each offset never eats into the floor.
  const n = Math.ceil((long - overlap) / (sliceLen - overlap));
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.round((i * (long - sliceLen)) / (n - 1));
    starts.push(start);
    ends.push(start + sliceLen);
  }
  return { vertical, long, short, sliceLen, overlap, starts, ends };
}

/**
 * Plans the detector slices of an image of `size` natural px. Images at or below the trigger give one slice
 * covering the whole image (axis "none").
 */
export function planSlices(size: Size, opts: SliceOptions = {}): SlicePlan {
  const plan = evenPlan(size, opts);
  if (plan === null) {
    return {
      axis: "none",
      sliceLen: Math.max(size.w, size.h),
      overlap: 0,
      slices: [{ x: 0, y: 0, w: size.w, h: size.h }],
      quietEdges: 0,
    };
  }
  const quiet = plan.vertical ? opts.rowQuiet : opts.colQuiet;
  const quietEdges = quiet === undefined ? 0 : snapEdgesToQuietRuns(plan, quiet, opts);
  const slices = plan.starts.map((start, i): Slice => {
    const len = at(plan.ends, i) - start;
    return plan.vertical ? { x: 0, y: start, w: size.w, h: len } : { x: start, y: 0, w: len, h: size.h };
  });
  return {
    axis: plan.vertical ? "vertical" : "horizontal",
    sliceLen: plan.sliceLen,
    overlap: plan.overlap,
    slices,
    quietEdges,
  };
}

/**
 * Ranges along the sliced axis ([start, end) rows for tall images, columns for wide ones) where quiet flags can
 * change the plan. The engine only needs pixels there: fill rowQuiet inside these windows, leave 0 elsewhere.
 * Empty when the image is not sliced.
 */
export function sliceSearchWindows(
  size: Size,
  opts: SliceOptions = {},
): Array<{ start: number; end: number }> {
  const plan = evenPlan(size, opts);
  if (plan === null) return [];
  const win = Math.round((opts.quietWindowFrac ?? SLICER_DEFAULTS.quietWindowFrac) * plan.sliceLen);
  const pad = quietMinRunFor(plan, opts);
  const evens = [...plan.starts.slice(1), ...plan.ends.slice(0, -1)].sort((a, b) => a - b);
  const windows: Array<{ start: number; end: number }> = [];
  for (const even of evens) {
    const start = Math.max(0, even - win - pad);
    const end = Math.min(plan.long, even + win + pad + 1);
    const last = windows[windows.length - 1];
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  return windows;
}

function quietMinRunFor(plan: EvenPlan, opts: SliceOptions): number {
  return Math.max(2, Math.round(opts.quietMinRun ?? defaultQuietMinRun(plan.short)));
}

function at(values: readonly number[], i: number): number {
  const v = values[i];
  if (v === undefined) throw new RangeError(`slicer: index ${i} out of range`);
  return v;
}

/** Maximal runs [a, b) of quiet positions with b - a ≥ minRun. */
function quietRuns(quiet: ArrayLike<number>, long: number, minRun: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let y = 0; y <= long; y++) {
    const isQuiet = y < long && y < quiet.length && (quiet[y] ?? 0) !== 0;
    if (isQuiet && start < 0) start = y;
    else if (!isQuiet && start >= 0) {
      if (y - start >= minRun) runs.push([start, y]);
      start = -1;
    }
  }
  return runs;
}

/**
 * Best edge position inside [lo, hi] on a quiet run, or null. An edge at p separates rows p-1 and p, so it must sit
 * strictly inside a run, at least `pad` rows from its ends when the run is long enough.
 */
function pickCut(
  runs: ReadonlyArray<[number, number]>,
  lo: number,
  hi: number,
  even: number,
  padMax: number,
  pick: "longest" | "nearest",
): number | null {
  let best: { p: number; len: number; dist: number } | null = null;
  for (const [a, b] of runs) {
    if (b - 1 < lo || a + 1 > hi) continue;
    const len = b - a;
    const pad = Math.max(1, Math.min(Math.floor(len / 2), padMax));
    const from = Math.max(a + pad, lo);
    const to = Math.min(b - pad, hi);
    if (from > to) continue;
    const p = Math.min(Math.max(a + Math.floor(len / 2), from), to);
    const dist = Math.abs(p - even);
    const better =
      best === null ||
      (pick === "longest"
        ? len > best.len || (len === best.len && dist < best.dist)
        : dist < best.dist || (dist === best.dist && len > best.len));
    if (better) best = { p, len, dist };
  }
  return best === null ? null : best.p;
}

function snapEdgesToQuietRuns(plan: EvenPlan, quiet: ArrayLike<number>, opts: SliceOptions): number {
  const { long, sliceLen, overlap, starts, ends } = plan;
  const n = starts.length;
  const minRun = quietMinRunFor(plan, opts);
  const runs = quietRuns(quiet, long, minRun);
  if (runs.length === 0) return 0;
  const win = Math.round((opts.quietWindowFrac ?? SLICER_DEFAULTS.quietWindowFrac) * sliceLen);
  const maxLen = Math.round(sliceLen * (1 + (opts.quietMaxGrowth ?? SLICER_DEFAULTS.quietMaxGrowth)));
  const padMax = Math.max(1, Math.floor(minRun / 2));
  const pick = opts.quietPick ?? "longest";

  const edges: Array<{ kind: "start" | "end"; i: number; even: number }> = [];
  for (let i = 1; i < n; i++) edges.push({ kind: "start", i, even: at(starts, i) });
  for (let i = 0; i < n - 1; i++) edges.push({ kind: "end", i, even: at(ends, i) });
  edges.sort((p, q) => p.even - q.even || (p.kind === q.kind ? p.i - q.i : p.kind === "start" ? -1 : 1));

  let moved = 0;
  for (const { kind, i, even } of edges) {
    // Feasible interval for this edge, given every other edge where it is now (the plan stays valid after
    // each accepted move, so it is valid at the end).
    let lo = Math.max(even - win, 1);
    let hi = Math.min(even + win, long - 1);
    if (kind === "start") {
      lo = Math.max(lo, at(starts, i - 1) + 1, at(ends, i) - maxLen);
      hi = Math.min(hi, at(ends, i - 1) - overlap, at(ends, i) - 1);
      if (i + 1 < n) hi = Math.min(hi, at(starts, i + 1) - 1);
    } else {
      lo = Math.max(lo, at(starts, i + 1) + overlap, at(starts, i) + 1);
      if (i > 0) lo = Math.max(lo, at(ends, i - 1) + 1);
      hi = Math.min(hi, at(starts, i) + maxLen, at(ends, i + 1) - 1);
    }
    if (lo > hi) continue;
    const p = pickCut(runs, lo, hi, even, padMax, pick);
    if (p === null) continue;
    if (kind === "start") starts[i] = p;
    else ends[i] = p;
    moved++;
  }
  return moved;
}

function checkPlane(name: string, data: ArrayLike<number>, w: number, h: number, channels: number): void {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) {
    throw new RangeError(`${name}: size must be positive integers, got ${w}×${h}`);
  }
  if (data.length < w * h * channels) {
    throw new RangeError(`${name}: buffer holds ${data.length} values, need ${w * h * channels}`);
  }
}

/**
 * Quiet-row flags (SmartStitch rule, sensitivity 90): row y is quiet (1) when every horizontally adjacent grey
 * difference is ≤ threshold, ignoring marginFrac of the width at each side. `gray` is row-major, one byte per px.
 */
export function quietRowsFromGray(
  gray: ArrayLike<number>,
  w: number,
  h: number,
  threshold: number = SLICER_DEFAULTS.quietThreshold,
  marginFrac: number = SLICER_DEFAULTS.quietMarginFrac,
): Uint8Array {
  checkPlane("quietRowsFromGray", gray, w, h, 1);
  const out = new Uint8Array(h);
  const x0 = Math.max(1, Math.floor(w * marginFrac));
  const x1 = Math.min(w, Math.ceil(w * (1 - marginFrac)));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let quiet = 1;
    let prev = gray[row + x0 - 1] ?? 0;
    for (let x = x0; x < x1; x++) {
      const v = gray[row + x] ?? 0;
      if (Math.abs(v - prev) > threshold) {
        quiet = 0;
        break;
      }
      prev = v;
    }
    out[y] = quiet;
  }
  return out;
}

/** Column analogue of quietRowsFromGray, for wide spreads: column x is quiet when every vertical step is small. */
export function quietColsFromGray(
  gray: ArrayLike<number>,
  w: number,
  h: number,
  threshold: number = SLICER_DEFAULTS.quietThreshold,
  marginFrac: number = SLICER_DEFAULTS.quietMarginFrac,
): Uint8Array {
  checkPlane("quietColsFromGray", gray, w, h, 1);
  const out = new Uint8Array(w).fill(1);
  const y0 = Math.max(1, Math.floor(h * marginFrac));
  const y1 = Math.min(h, Math.ceil(h * (1 - marginFrac)));
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (out[x] === 1 && Math.abs((gray[row + x] ?? 0) - (gray[row - w + x] ?? 0)) > threshold) out[x] = 0;
    }
  }
  return out;
}

/**
 * RGBA (ImageData layout, not premultiplied) → grey `(77r + 150g + 29b) >> 8`. Transparent pixels are
 * flattened onto white first, like the detector input.
 */
export function grayFromRgba(rgba: ArrayLike<number>, w: number, h: number): Uint8Array {
  checkPlane("grayFromRgba", rgba, w, h, 4);
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const v = (77 * (rgba[p] ?? 0) + 150 * (rgba[p + 1] ?? 0) + 29 * (rgba[p + 2] ?? 0)) >> 8;
    const a = rgba[p + 3] ?? 255;
    out[i] = a >= 255 ? v : Math.round((v * a + 255 * (255 - a)) / 255);
  }
  return out;
}
