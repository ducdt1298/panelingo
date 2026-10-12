// Box arithmetic on natural-pixel boxes (x2/y2 exclusive). PURE.

import type { Box, Size } from "./types.ts";

export function box(x1: number, y1: number, x2: number, y2: number): Box {
  return { x1, y1, x2, y2 };
}

export function width(b: Box): number {
  return Math.max(0, b.x2 - b.x1);
}

export function height(b: Box): number {
  return Math.max(0, b.y2 - b.y1);
}

export function area(b: Box): number {
  return width(b) * height(b);
}

export function center(b: Box): { x: number; y: number } {
  return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
}

/** Intersection area of two boxes. */
export function inter(a: Box, b: Box): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Intersection over union. */
export function iou(a: Box, b: Box): number {
  const i = inter(a, b);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

/** Intersection over the smaller box (IoS): 1 when one box lies inside the other. */
export function ios(a: Box, b: Box): number {
  const smaller = Math.min(area(a), area(b));
  return smaller > 0 ? inter(a, b) / smaller : 0;
}

/** Fraction of `inner` covered by `outer` (containment of inner in outer). */
export function contain(inner: Box, outer: Box): number {
  const a = area(inner);
  return a > 0 ? inter(inner, outer) / a : 0;
}

export function union(a: Box, b: Box): Box {
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  };
}

export function unionAll(boxes: readonly Box[]): Box | null {
  let acc: Box | null = null;
  for (const b of boxes) {
    acc = acc === null ? { ...b } : union(acc, b);
  }
  return acc;
}

/** Grow (or shrink, with a negative amount) every side by `d` pixels. */
export function inflate(b: Box, d: number): Box {
  return { x1: b.x1 - d, y1: b.y1 - d, x2: b.x2 + d, y2: b.y2 + d };
}

/** Clip a box to the image bounds [0, w) × [0, h). */
export function clip(b: Box, size: Size): Box {
  return {
    x1: Math.min(Math.max(b.x1, 0), size.w),
    y1: Math.min(Math.max(b.y1, 0), size.h),
    x2: Math.min(Math.max(b.x2, 0), size.w),
    y2: Math.min(Math.max(b.y2, 0), size.h),
  };
}

export function translate(b: Box, dx: number, dy: number): Box {
  return { x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 + dx, y2: b.y2 + dy };
}

export function scale(b: Box, sx: number, sy: number = sx): Box {
  return { x1: b.x1 * sx, y1: b.y1 * sy, x2: b.x2 * sx, y2: b.y2 * sy };
}

/** Vertical overlap of two boxes as a fraction of the shorter one (0..1). */
export function vOverlap(a: Box, b: Box): number {
  const o = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  const shorter = Math.min(height(a), height(b));
  return o > 0 && shorter > 0 ? o / shorter : 0;
}

/** Horizontal overlap of two boxes as a fraction of the narrower one (0..1). */
export function hOverlap(a: Box, b: Box): number {
  const o = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const narrower = Math.min(width(a), width(b));
  return o > 0 && narrower > 0 ? o / narrower : 0;
}
