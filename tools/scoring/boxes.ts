// Box helpers for scoring: tolerant box input, exact union coverage and greedy one-to-one matching.

import { inter } from "../../src/shared/geometry.ts";
import type { Box } from "../../src/shared/types.ts";

/** A Box, or an `[x1, y1, x2, y2]` array as written by the fixture generator. */
export type BoxLike = Box | readonly number[];

export function toBox(b: BoxLike): Box {
  if ("x1" in b) return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
  const [x1, y1, x2, y2] = b;
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    throw new RangeError(`toBox: expected [x1, y1, x2, y2], got ${b.length} numbers`);
  }
  return { x1, y1, x2, y2 };
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function containsPoint(b: Box, x: number, y: number): boolean {
  return x > b.x1 && x < b.x2 && y > b.y1 && y < b.y2;
}

/**
 * Exact area of (∪ targets) ∩ (∪ covers) by coordinate compression; with `covers` null, the area of ∪ targets.
 * Fine for the handful of boxes of one unit.
 */
export function unionCoverArea(targets: readonly Box[], covers: readonly Box[] | null): number {
  const relevant = covers === null ? null : covers.filter((c) => targets.some((t) => inter(t, c) > 0));
  if (relevant !== null && relevant.length === 0) return 0;
  const all = [...targets, ...(relevant ?? [])];
  const xs = uniqueSorted(all.flatMap((b) => [b.x1, b.x2]));
  const ys = uniqueSorted(all.flatMap((b) => [b.y1, b.y2]));
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i] ?? 0;
    const xb = xs[i + 1] ?? 0;
    const cx = (xa + xb) / 2;
    for (let j = 0; j + 1 < ys.length; j++) {
      const ya = ys[j] ?? 0;
      const yb = ys[j + 1] ?? 0;
      const cy = (ya + yb) / 2;
      if (!targets.some((b) => containsPoint(b, cx, cy))) continue;
      if (relevant !== null && !relevant.some((b) => containsPoint(b, cx, cy))) continue;
      total += (xb - xa) * (yb - ya);
    }
  }
  return total;
}

/** Fraction of the area of ∪ targets covered by ∪ covers (0 when the targets have no area). */
export function coveredFraction(targets: readonly Box[], covers: readonly Box[]): number {
  const whole = unionCoverArea(targets, null);
  return whole > 0 ? unionCoverArea(targets, covers) / whole : 0;
}

export interface MatchPair {
  gt: number;
  pred: number;
  score: number;
}

/**
 * Greedy one-to-one matching: every (gt, pred) pair with a non-null score, best score first (ties by gt then pred
 * index), each side used at most once.
 */
export function greedyMatch(
  nGt: number,
  nPred: number,
  scoreOf: (gt: number, pred: number) => number | null,
): MatchPair[] {
  const pairs: MatchPair[] = [];
  for (let gt = 0; gt < nGt; gt++) {
    for (let pred = 0; pred < nPred; pred++) {
      const score = scoreOf(gt, pred);
      if (score !== null) pairs.push({ gt, pred, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.gt - b.gt || a.pred - b.pred);
  const usedGt = new Set<number>();
  const usedPred = new Set<number>();
  const out: MatchPair[] = [];
  for (const pair of pairs) {
    if (usedGt.has(pair.gt) || usedPred.has(pair.pred)) continue;
    usedGt.add(pair.gt);
    usedPred.add(pair.pred);
    out.push(pair);
  }
  return out;
}

/** Ratio with an explicit value for an empty denominator. */
export function ratio(num: number, den: number, empty = 1): number {
  return den > 0 ? num / den : empty;
}
