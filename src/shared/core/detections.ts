// Detector output → detections → translation units. PURE.
//
// Pipeline (the engine owns inference, storage and pixels; this module is only the math):
//   per slice  decodeDetectorOutput(out, slice)  raw detections, score ≥ 0.15, image coords (stored raw, so units
//                                                 can be rebuilt without running the detector again)
//   on read    applyScoreMin(dets, 0.30)          per slice: scoreMin is applied when reading, never when storing
//              mergeAcrossSlices(parts, size)     per-class dedupe + union of boxes truncated at a shared slice edge
//              buildUnits(dets, size, {dir})      text merge, association, grouping, orientation, glyph, edgeSmall,
//                                                 reading order and unit keys
// Dedupe and merges run after scoreMin on purpose: a survivor keeps the higher score of a duplicate pair, so a
// low-score box must not get the chance to absorb a real one. mergeAcrossSlices is the only dedupe step (buildUnits
// does not dedupe), so an image that was not sliced goes through it too, as a single part.
//
// Parameters are comic-translate's (written by the detector's author) except assocContain, freeInBubbleContain,
// freeMerge and the unit-size filters, which are ours.

import { area, contain, hOverlap, height, iou, ios, union, unionAll, vOverlap, width } from "../geometry.ts";
import { unitKeyOf } from "../ids.ts";
import { DET_CLASSES } from "../types.ts";
import type { Box, DetClass, Detection, ReadingDir, Size, UnitGeometry } from "../types.ts";
import { GLYPH_DEFAULTS, estimateGlyphPx, glyphPriorPx, unitOrientation } from "./glyph.ts";
import type { Orientation } from "./glyph.ts";
import { readingOrder } from "./reading-order.ts";
import type { LeafSorter, PanelSegmenter } from "./reading-order.ts";
import type { Slice } from "./slicer.ts";

export const DET_DEFAULTS = {
  /** Raw detections are stored from this score. */
  scoreFloor: 0.15,
  /** Applied at read time (the detector.scoreMin setting), so changing it needs no new inference. */
  scoreMin: 0.3,
  /** Boxes with width or height ≤ this after clamping are dropped (comic-translate filter_and_fix_bboxes). */
  minSidePx: 5,
  /** One query emitted under both text labels: keep the higher score when IoU ≥ this. */
  doubleLabelIoU: 0.9,
  /** Per-class duplicates: IoS ≥ dupIoS or IoU ≥ dupIoU. */
  dupIoS: 0.85,
  dupIoU: 0.5,
  /** Cross-slice merge of truncated boxes (comic-translate ImageSlicer). */
  seam: {
    /** A box within this many px of an internal slice edge is truncated there. */
    edgePx: 3,
    /** Overlap across the slicing axis / narrower box must exceed this. */
    crossOverlapMin: 0.2,
    /** Gap along the axis < min(gapFracImage × image length, gapFracBox × taller box). */
    gapFracImage: 0.1,
    gapFracBox: 0.1,
    /** min(area) / max(area) must exceed this. */
    sizeRatioMin: 0.3,
    /** |Δx1| and |Δx2| < edgeShiftMax × wider box. */
    edgeShiftMax: 0.5,
    /** area(union) ≤ maxGrowth × larger area. */
    maxGrowth: 3,
  },
  /** Text boxes (both text classes) are unioned when one is ≥ 30% inside the other. */
  textMergeContain: 0.3,
  /** A text box belongs to the smallest bubble containing ≥ this fraction of it ... */
  assocContain: 0.6,
  /** ... or ≥ this fraction for text_free boxes. */
  freeInBubbleContain: 0.85,
  /** Loose text boxes group when cross overlap ≥ crossOverlap and gap ≤ gapGlyph × glyph. */
  freeMerge: { crossOverlap: 0.5, gapGlyph: 0.6 },
  /** Units smaller than this fraction of the reference area are dropped. */
  minUnitAreaFrac: 5e-5,
  /** edgeSmall: within edgeMarginFrac × short side of the border and smaller than edgeAreaFrac × reference area. */
  edgeMarginFrac: 0.03,
  edgeAreaFrac: 0.002,
  /** Unit.edge band: max(edgeTouchMinPx, edgeTouchFrac × H). */
  edgeTouchMinPx: 6,
  edgeTouchFrac: 0.01,
  /** Images with long / short above this are strips: edgeSmall only looks at the long sides. */
  stripAspect: 2.2,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Decoding

/** Output tensors of the ogkalu RT-DETR export for one tile (batch 1): labels [1,300], boxes [1,300,4], scores. */
export interface DetectorOutput {
  /** int64 from ORT (BigInt64Array); Int32Array or number[] are accepted for fixtures and tests. */
  labels: ArrayLike<bigint> | ArrayLike<number>;
  /** xyxy in px of orig_target_sizes = [tile.w, tile.h], not clamped. */
  boxes: ArrayLike<number>;
  /** Sigmoid scores, sorted descending. */
  scores: ArrayLike<number>;
}

export interface DecodeOptions {
  scoreFloor?: number;
  minSidePx?: number;
  doubleLabelIoU?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Raw detections of one tile in image coordinates: score ≥ scoreFloor, labels converted with Number(), boxes
 * clamped to the tile, boxes with a side ≤ 5 px dropped, then offset by the tile origin. The graph's TopK can emit
 * one query under two labels; when a text_bubble and a text_free box coincide (IoU ≥ 0.9) only the higher score
 * survives. Input order (score descending) is kept.
 */
export function decodeDetectorOutput(
  out: DetectorOutput,
  tile: Slice,
  opts: DecodeOptions = {},
): Detection[] {
  const floor = opts.scoreFloor ?? DET_DEFAULTS.scoreFloor;
  const minSide = opts.minSidePx ?? DET_DEFAULTS.minSidePx;
  const n = Math.min(out.scores.length, out.labels.length, Math.floor(out.boxes.length / 4));
  const dets: Detection[] = [];
  for (let i = 0; i < n; i++) {
    const score = out.scores[i] ?? Number.NaN;
    if (!(score >= floor)) continue;
    const cls = DET_CLASSES[Number(out.labels[i])];
    if (cls === undefined) continue;
    const ax = out.boxes[4 * i] ?? Number.NaN;
    const ay = out.boxes[4 * i + 1] ?? Number.NaN;
    const bx = out.boxes[4 * i + 2] ?? Number.NaN;
    const by = out.boxes[4 * i + 3] ?? Number.NaN;
    if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) continue;
    const x1 = clamp(Math.min(ax, bx), 0, tile.w);
    const x2 = clamp(Math.max(ax, bx), 0, tile.w);
    const y1 = clamp(Math.min(ay, by), 0, tile.h);
    const y2 = clamp(Math.max(ay, by), 0, tile.h);
    if (x2 - x1 <= minSide || y2 - y1 <= minSide) continue;
    dets.push({ cls, box: { x1: x1 + tile.x, y1: y1 + tile.y, x2: x2 + tile.x, y2: y2 + tile.y }, score });
  }
  return resolveDoubleLabels(dets, opts.doubleLabelIoU ?? DET_DEFAULTS.doubleLabelIoU);
}

function resolveDoubleLabels(dets: readonly Detection[], minIoU: number): Detection[] {
  const dropped = new Set<number>();
  for (const [i, a] of dets.entries()) {
    if (a.cls === "bubble" || dropped.has(i)) continue;
    for (const [j, b] of dets.entries()) {
      if (j <= i || b.cls === "bubble" || b.cls === a.cls || dropped.has(j)) continue;
      if (iou(a.box, b.box) < minIoU) continue;
      if (b.score > a.score) {
        dropped.add(i);
        break;
      }
      dropped.add(j);
    }
  }
  return dets.filter((_, i) => !dropped.has(i));
}

/** Read-time filter (scoreMin, default 0.30). */
export function applyScoreMin(
  dets: readonly Detection[],
  scoreMin: number = DET_DEFAULTS.scoreMin,
): Detection[] {
  return dets.filter((d) => d.score >= scoreMin);
}

// ---------------------------------------------------------------------------------------------------------------
// Dedupe and cross-slice merge

export interface DedupeOptions {
  dupIoS?: number;
  dupIoU?: number;
}

function isDuplicate(a: Box, b: Box, iosMin: number, iouMin: number): boolean {
  return ios(a, b) >= iosMin || iou(a, b) >= iouMin;
}

/**
 * Per-class dedupe: boxes are visited by area (largest first, then higher score); a box that duplicates a kept box
 * of its class (IoS ≥ 0.85 or IoU ≥ 0.5) is dropped and the kept box takes the higher score. Survivors keep the
 * input order.
 */
export function dedupeDetections(dets: readonly Detection[], opts: DedupeOptions = {}): Detection[] {
  const iosMin = opts.dupIoS ?? DET_DEFAULTS.dupIoS;
  const iouMin = opts.dupIoU ?? DET_DEFAULTS.dupIoU;
  const items = dets.map((d, seq) => ({ seq, det: { cls: d.cls, box: { ...d.box }, score: d.score } }));
  items.sort((a, b) => area(b.det.box) - area(a.det.box) || b.det.score - a.det.score || a.seq - b.seq);
  const kept: typeof items = [];
  for (const item of items) {
    const dup = kept.find(
      (k) => k.det.cls === item.det.cls && isDuplicate(k.det.box, item.det.box, iosMin, iouMin),
    );
    if (dup === undefined) kept.push(item);
    else dup.det.score = Math.max(dup.det.score, item.det.score);
  }
  return kept.sort((a, b) => a.seq - b.seq).map((k) => k.det);
}

export interface SliceDetections {
  slice: Slice;
  dets: readonly Detection[];
}

export interface MergeOptions extends DedupeOptions {
  edgePx?: number;
  crossOverlapMin?: number;
  gapFracImage?: number;
  gapFracBox?: number;
  sizeRatioMin?: number;
  edgeShiftMax?: number;
  maxGrowth?: number;
}

interface Piece {
  seq: number;
  cls: DetClass;
  box: Box;
  score: number;
  /** Range of slice ranks (along the axis) the piece comes from. */
  lo: number;
  hi: number;
  /** The slice edge that cuts the piece at its start (top/left) or its end (bottom/right); null when whole. */
  cutLow: Cut | null;
  cutHigh: Cut | null;
}

/** A slice edge cutting a piece: its position on the axis and the overlap [a, b) with the slice beyond it. */
interface Cut {
  at: number;
  a: number;
  b: number;
}

type Axis = "v" | "h";

function sliceAxis(slices: readonly Slice[], size: Size): Axis | null {
  if (slices.every((s) => s.x === 0 && s.w === size.w)) return "v";
  if (slices.every((s) => s.y === 0 && s.h === size.h)) return "h";
  return null;
}

function transpose(b: Box): Box {
  return { x1: b.y1, y1: b.x1, x2: b.y2, y2: b.x2 };
}

/**
 * Merges the detections of all slices of one image (comic-translate ImageSlicer rules). Per class, boxes
 * are visited by area, largest first, and compared with the boxes kept so far:
 * - seam merge (union): the two boxes come from adjacent slices, the one nearer the start of the axis is cut by
 *   its slice's far edge or the other by its slice's near edge, both slices see the same object inside their shared
 *   overlap (the two extents along the axis, clipped to the overlap, are non-empty and their intersection covers at
 *   least half of the longer one; a box that stops short of the cut line, starts beyond it or only grazes the
 *   overlap is a different object), and they line up: cross overlap > 0.2 of the narrower box, gap < min(0.1 ×
 *   image length, 0.1 × taller box), area ratio > 0.3, side edges within 0.5 × the wider box, union ≤ 3 × the
 *   larger area;
 * - dedupe: IoS ≥ 0.85 or IoU ≥ 0.5 collapses into the larger box.
 * A kept duplicate is preferred over a seam-only partner, and a duplicate that also passes the seam rule is unioned
 * (two fragments of one tall bubble cut at both edges of the overlap usually have IoU ≥ 0.5, and plain dedupe would
 * keep the larger fragment and lose the rest of the bubble).
 * The merged box takes the higher score. Repeats until no box grows. Slices must tile one axis (every slice spans
 * the full width, or every slice the full height); otherwise only dedupe applies.
 */
export function mergeAcrossSlices(
  parts: readonly SliceDetections[],
  size: Size,
  opts: MergeOptions = {},
): Detection[] {
  const axis = sliceAxis(
    parts.map((p) => p.slice),
    size,
  );
  const edgePx = opts.edgePx ?? DET_DEFAULTS.seam.edgePx;
  const span = axis === "h" ? size.w : size.h;
  // Slice extents along the axis, by rank (sorted by start).
  const extentOf = (s: Slice): [number, number] => (axis === "h" ? [s.x, s.x + s.w] : [s.y, s.y + s.h]);
  const byStart = parts
    .map((part, p) => ({ p, ext: extentOf(part.slice) }))
    .sort((a, b) => a.ext[0] - b.ext[0] || a.p - b.p);
  const ranks = new Map(byStart.map(({ p }, rank) => [p, rank]));

  const pieces: Piece[] = [];
  parts.forEach((part, p) => {
    const rank = ranks.get(p) ?? 0;
    const [s, e] = extentOf(part.slice);
    const prevEnd = byStart[rank - 1]?.ext[1] ?? s;
    const nextStart = byStart[rank + 1]?.ext[0] ?? e;
    for (const d of part.dets) {
      let cutLow: Cut | null = null;
      let cutHigh: Cut | null = null;
      if (axis !== null) {
        if (s > 0 && axisStart(d.box, axis) <= s + edgePx) cutLow = { at: s, a: s, b: prevEnd };
        if (e < span && axisEnd(d.box, axis) >= e - edgePx) cutHigh = { at: e, a: nextStart, b: e };
      }
      pieces.push({
        seq: pieces.length,
        cls: d.cls,
        box: { ...d.box },
        score: d.score,
        lo: rank,
        hi: rank,
        cutLow,
        cutHigh,
      });
    }
  });

  const merged: Piece[] = [];
  for (const cls of DET_CLASSES) {
    merged.push(
      ...mergeClass(
        pieces.filter((p) => p.cls === cls),
        axis,
        size,
        opts,
      ),
    );
  }
  return merged.sort((a, b) => a.seq - b.seq).map((p) => ({ cls: p.cls, box: p.box, score: p.score }));
}

function mergeClass(pieces: Piece[], axis: Axis | null, size: Size, opts: MergeOptions): Piece[] {
  const iosMin = opts.dupIoS ?? DET_DEFAULTS.dupIoS;
  const iouMin = opts.dupIoU ?? DET_DEFAULTS.dupIoU;
  let items = pieces;
  for (;;) {
    items.sort((a, b) => area(b.box) - area(a.box) || b.score - a.score || a.seq - b.seq);
    const kept: Piece[] = [];
    let grew = false;
    for (const d of items) {
      // A kept duplicate wins over a seam-only partner, so a fragment is never stitched onto a neighbouring object
      // while its own other half is in the list; a duplicate that also passes the seam rule is unioned, because two
      // fragments of one tall bubble cut at both edges of the overlap usually have IoU ≥ 0.5, and plain dedupe would
      // keep the larger fragment and lose the rest of the bubble.
      let target = kept.find((k) => isDuplicate(k.box, d.box, iosMin, iouMin));
      let seam = false;
      if (target !== undefined) seam = axis !== null && seamMergeable(target, d, axis, size, opts);
      else if (axis !== null) {
        target = kept.find((k) => seamMergeable(k, d, axis, size, opts));
        seam = target !== undefined;
      }
      if (target === undefined) {
        kept.push(d);
        continue;
      }
      if (seam && axis !== null) {
        const merged = union(target.box, d.box);
        if (area(merged) > area(target.box)) grew = true;
        // The union stays cut where the piece reaching furthest on each side was cut (start: smaller is further).
        const startT = -axisStart(target.box, axis);
        const startD = -axisStart(d.box, axis);
        const cutLow = unionCut(startT, target.cutLow, startD, d.cutLow);
        const cutHigh = unionCut(axisEnd(target.box, axis), target.cutHigh, axisEnd(d.box, axis), d.cutHigh);
        target.box = merged;
        target.cutLow = cutLow;
        target.cutHigh = cutHigh;
      }
      target.score = Math.max(target.score, d.score);
      target.lo = Math.min(target.lo, d.lo);
      target.hi = Math.max(target.hi, d.hi);
      target.seq = Math.min(target.seq, d.seq);
    }
    items = kept;
    if (!grew) return items;
  }
}

function axisCenter(b: Box, axis: Axis): number {
  return axis === "v" ? b.y1 + b.y2 : b.x1 + b.x2;
}

function axisStart(b: Box, axis: Axis): number {
  return axis === "v" ? b.y1 : b.x1;
}

function axisEnd(b: Box, axis: Axis): number {
  return axis === "v" ? b.y2 : b.x2;
}

/**
 * Cut of a union on one side: the cut of the piece that reaches further on that side (larger `reach`); on a tie a
 * whole side (null) wins, because that slice saw the object's edge.
 */
function unionCut(reachA: number, cutA: Cut | null, reachB: number, cutB: Cut | null): Cut | null {
  if (reachA !== reachB) return reachA > reachB ? cutA : cutB;
  return cutA === null || cutB === null ? null : cutA;
}

/**
 * Whether `first` and `last` (in axis order) can be one object continued across `cut`, an edge cutting `first` at
 * its end (side "high") or `last` at its start (side "low"). The slice beyond the cut overlaps it, so it sees the
 * same object inside the shared overlap [a, b): both extents clipped to the overlap must be non-empty (the partner
 * crosses the cut line) and nearly coincide (their intersection covers at least half of the longer one, so a
 * neighbour that only grazes the overlap does not qualify). Slices that only touch share no overlap to compare;
 * then both pieces must be cut on their facing sides.
 */
function continuesAcross(cut: Cut, first: Piece, last: Piece, axis: Axis, side: "high" | "low"): boolean {
  if (cut.b <= cut.a) return side === "high" ? last.cutLow !== null : first.cutHigh !== null;
  const f1 = Math.max(axisStart(first.box, axis), cut.a);
  const f2 = Math.min(axisEnd(first.box, axis), cut.b);
  const l1 = Math.max(axisStart(last.box, axis), cut.a);
  const l2 = Math.min(axisEnd(last.box, axis), cut.b);
  if (!(f2 > f1 && l2 > l1)) return false;
  return Math.min(f2, l2) - Math.max(f1, l1) >= 0.5 * Math.max(f2 - f1, l2 - l1);
}

function seamMergeable(a: Piece, b: Piece, axis: Axis, size: Size, opts: MergeOptions): boolean {
  if (a.lo === a.hi && b.lo === b.hi && a.lo === b.lo) return false; // same slice
  if (Math.max(a.lo, b.lo) > Math.min(a.hi, b.hi) + 1) return false; // not adjacent
  const aFirst = axisCenter(a.box, axis) <= axisCenter(b.box, axis);
  const first = aFirst ? a : b;
  const last = aFirst ? b : a;
  // A cut must face the partner, and both slices must see the same object around it.
  const continued =
    (first.cutHigh !== null && continuesAcross(first.cutHigh, first, last, axis, "high")) ||
    (last.cutLow !== null && continuesAcross(last.cutLow, first, last, axis, "low"));
  if (!continued) return false;

  // Work in a frame where the slicing axis is vertical.
  const U = axis === "v" ? first.box : transpose(first.box);
  const L = axis === "v" ? last.box : transpose(last.box);
  const span = axis === "v" ? size.h : size.w;
  const s = DET_DEFAULTS.seam;
  const areaU = area(U);
  const areaL = area(L);
  const maxArea = Math.max(areaU, areaL);
  const maxW = Math.max(width(U), width(L));
  const gap = Math.max(0, Math.max(U.y1, L.y1) - Math.min(U.y2, L.y2));
  const gapMax = Math.min(
    (opts.gapFracImage ?? s.gapFracImage) * span,
    (opts.gapFracBox ?? s.gapFracBox) * Math.max(height(U), height(L)),
  );
  const shiftMax = (opts.edgeShiftMax ?? s.edgeShiftMax) * maxW;
  return (
    hOverlap(U, L) > (opts.crossOverlapMin ?? s.crossOverlapMin) &&
    gap < gapMax &&
    maxArea > 0 &&
    Math.min(areaU, areaL) / maxArea > (opts.sizeRatioMin ?? s.sizeRatioMin) &&
    Math.abs(U.x1 - L.x1) < shiftMax &&
    Math.abs(U.x2 - L.x2) < shiftMax &&
    area(union(U, L)) <= (opts.maxGrowth ?? s.maxGrowth) * maxArea
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Units

/**
 * Unions text boxes (both text classes) when one is ≥ `containMin` inside the other, until stable; the result keeps
 * the class of the larger box and the higher score (comic-translate merge_overlapping_boxes). Its second rule,
 * "drop IoU ≥ 0.5 against an accepted box", never fires after this one: IoU ≥ 0.5 implies ≥ 2/3 containment.
 */
export function mergeTextBoxes(
  texts: readonly Detection[],
  containMin: number = DET_DEFAULTS.textMergeContain,
): Detection[] {
  let items = texts.map((d, seq) => ({ seq, cls: d.cls, box: { ...d.box }, score: d.score }));
  for (;;) {
    items.sort((a, b) => area(b.box) - area(a.box) || b.score - a.score || a.seq - b.seq);
    const kept: typeof items = [];
    let grew = false;
    for (const d of items) {
      const k = kept.find((k) => contain(d.box, k.box) >= containMin || contain(k.box, d.box) >= containMin);
      if (k === undefined) {
        kept.push(d);
        continue;
      }
      k.box = union(k.box, d.box);
      k.score = Math.max(k.score, d.score);
      k.seq = Math.min(k.seq, d.seq);
      grew = true;
    }
    items = kept;
    if (!grew) break;
  }
  return items.sort((a, b) => a.seq - b.seq).map(({ cls, box, score }) => ({ cls, box, score }));
}

export interface BuildUnitsOptions {
  /** Reading direction for the order (default "ltr"; see reading-order.chooseReadingDir). */
  dir?: ReadingDir;
  assocContain?: number;
  freeInBubbleContain?: number;
  textMergeContain?: number;
  freeMerge?: { crossOverlap?: number; gapGlyph?: number };
  minUnitAreaFrac?: number;
  edgeMarginFrac?: number;
  edgeAreaFrac?: number;
  verticalAspect?: number;
  /** False for scripts never set vertically (Korean webtoons, Latin): every unit is "h". */
  allowVertical?: boolean;
  /** Glyph estimator, e.g. a closure over page pixels (glyph.glyphPxFromGray); default: geometry-only. */
  glyph?: (texts: readonly Box[], orientation: Orientation) => number;
  /** Reading-order hooks for paged layouts (reading-order.ts orderHooksFor). */
  segmenter?: PanelSegmenter;
  leafSorter?: LeafSorter;
}

/** A unit as built from detections: the wire geometry plus engine-internal fields of `Unit`. */
export interface BuiltUnit extends UnitGeometry {
  /** Highest score among the unit's text boxes. */
  score: number;
  /** The unit box touches the top or bottom image edge (seam candidate; "bottom" wins when both). */
  edge: "top" | "bottom" | null;
}

/** The box a unit is keyed, ordered and fitted by. */
export function unitBox(u: Pick<UnitGeometry, "bubble" | "text">): Box {
  return u.bubble ?? u.text;
}

interface Draft {
  kind: "bubble" | "free";
  bubble: Box | null;
  texts: Detection[];
}

/**
 * Translation units of one image:
 * 1. Text boxes are merged (mergeTextBoxes).
 * 2. Each text box goes to the smallest bubble that contains ≥ 0.6 of its area (≥ 0.85 for text_free); ties go to
 *    the higher containment. A bubble with its text boxes is one unit; bubbles without text are dropped.
 * 3. Unassigned text boxes of either class are grouped transitively when two boxes have the same orientation and
 *    either (a) stack across lines: cross-axis overlap ≥ 0.5 of the narrower box and a gap between lines
 *    ≤ 0.6 × the smaller glyph size, or (b) continue the same line: overlap ≥ 0.5 on the other axis and a gap
 *    ≤ 0.6 × glyph. This joins webtoon narration split per line. A group is kind "bubble" (bubble null, the outline
 *    was missed) when text_bubble area dominates, else "free".
 * 4. Units whose box (bubble ?? text) is smaller than 5e-5 × the reference area are dropped. The reference area is
 *    short side × min(long side, 3 × short side), so tall strips do not inflate size thresholds.
 * 5. edgeSmall (page numbers, watermarks): box area < 0.002 × reference area and within 3% of the short side from
 *    the border. Strips (long / short > 2.2) only look at their long sides, where top and bottom units are seam
 *    candidates, not page furniture.
 * 6. Orientation: area-weighted majority of h / w > 1.2 boxes; glyphPx from `opts.glyph` or estimateGlyphPx with
 *    the image prior; order from reading-order (edgeSmall last); unitKey = unitKeyOf(bubble ?? text), with "~2",
 *    "~3" appended when two keys collide (assigned by geometry, so they do not depend on the reading direction).
 * Returns the units in reading order (order = index).
 */
export function buildUnits(
  dets: readonly Detection[],
  size: Size,
  opts: BuildUnitsOptions = {},
): BuiltUnit[] {
  const W = size.w;
  const H = size.h;
  const short = Math.min(W, H);
  const long = Math.max(W, H);
  const refArea = short * Math.min(long, 3 * short);
  const orientOpts = {
    verticalAspect: opts.verticalAspect ?? GLYPH_DEFAULTS.verticalAspect,
    allowVertical: opts.allowVertical ?? true,
  };
  const prior = glyphPriorPx(size);
  const geometryGlyph = (texts: readonly Box[], o: Orientation): number =>
    estimateGlyphPx(texts, o, { priorPx: prior });
  const glyphOf = (texts: readonly Box[], o: Orientation): number => {
    const custom = opts.glyph?.(texts, o);
    return custom !== undefined && Number.isFinite(custom) && custom > 0
      ? Math.round(custom)
      : geometryGlyph(texts, o);
  };

  const bubbles = dets.filter((d) => d.cls === "bubble");
  const texts = mergeTextBoxes(
    dets.filter((d) => d.cls !== "bubble"),
    opts.textMergeContain ?? DET_DEFAULTS.textMergeContain,
  );

  // Association: smallest bubble that contains enough of the text box.
  const assoc = opts.assocContain ?? DET_DEFAULTS.assocContain;
  const freeAssoc = opts.freeInBubbleContain ?? DET_DEFAULTS.freeInBubbleContain;
  const inBubble = new Map<number, Detection[]>();
  const loose: Detection[] = [];
  for (const t of texts) {
    const need = t.cls === "text_free" ? freeAssoc : assoc;
    let best = -1;
    let bestArea = Number.POSITIVE_INFINITY;
    let bestCover = -1;
    for (const [bi, b] of bubbles.entries()) {
      const cover = contain(t.box, b.box);
      if (cover < need) continue;
      const a = area(b.box);
      if (a < bestArea || (a === bestArea && cover > bestCover)) {
        best = bi;
        bestArea = a;
        bestCover = cover;
      }
    }
    if (best < 0) loose.push(t);
    else inBubble.set(best, [...(inBubble.get(best) ?? []), t]);
  }

  const drafts: Draft[] = [];
  for (const [bi, b] of bubbles.entries()) {
    const own = inBubble.get(bi);
    if (own !== undefined) drafts.push({ kind: "bubble", bubble: { ...b.box }, texts: own });
  }
  const crossMin = opts.freeMerge?.crossOverlap ?? DET_DEFAULTS.freeMerge.crossOverlap;
  const gapGlyph = opts.freeMerge?.gapGlyph ?? DET_DEFAULTS.freeMerge.gapGlyph;
  for (const group of groupLooseTexts(loose, orientOpts, glyphOf, crossMin, gapGlyph)) {
    let bubbleArea = 0;
    let freeArea = 0;
    for (const t of group) {
      if (t.cls === "text_free") freeArea += area(t.box);
      else bubbleArea += area(t.box);
    }
    drafts.push({ kind: bubbleArea > freeArea ? "bubble" : "free", bubble: null, texts: group });
  }

  const minArea = (opts.minUnitAreaFrac ?? DET_DEFAULTS.minUnitAreaFrac) * refArea;
  const smallArea = (opts.edgeAreaFrac ?? DET_DEFAULTS.edgeAreaFrac) * refArea;
  const margin = (opts.edgeMarginFrac ?? DET_DEFAULTS.edgeMarginFrac) * short;
  const touch = Math.max(DET_DEFAULTS.edgeTouchMinPx, DET_DEFAULTS.edgeTouchFrac * H);
  const built: Array<Omit<BuiltUnit, "unitKey" | "order">> = [];
  for (const d of drafts) {
    const orientation = unitOrientation(
      d.texts.map((t) => t.box),
      orientOpts,
    );
    const textBoxes = sortTextBoxes(
      d.texts.map((t) => ({ ...t.box })),
      orientation,
    );
    const text = unionAll(textBoxes);
    if (text === null) continue;
    const box = d.bubble ?? text;
    if (area(box) < minArea) continue;
    const unit: Omit<BuiltUnit, "unitKey" | "order"> = {
      kind: d.kind,
      bubble: d.bubble,
      text,
      texts: textBoxes,
      orientation,
      glyphPx: glyphOf(textBoxes, orientation),
      score: Math.max(...d.texts.map((t) => t.score)),
      edge: box.y2 >= H - touch ? "bottom" : box.y1 <= touch ? "top" : null,
    };
    if (area(box) < smallArea && borderDistance(box, size) <= margin) unit.edgeSmall = true;
    built.push(unit);
  }

  const order = readingOrder(
    built.map((u) => ({ box: unitBox(u), edgeSmall: u.edgeSmall === true })),
    {
      dir: opts.dir ?? "ltr",
      ...(opts.segmenter === undefined ? {} : { segmenter: opts.segmenter }),
      ...(opts.leafSorter === undefined ? {} : { leafSorter: opts.leafSorter }),
    },
  );
  const keys = unitKeys(built);
  return order.map((i, rank): BuiltUnit => {
    const u = built[i] as Omit<BuiltUnit, "unitKey" | "order">;
    return { unitKey: keys[i] ?? unitKeyOf(unitBox(u)), ...u, order: rank };
  });
}

function compareBoxes(a: Box, b: Box): number {
  return a.x1 - b.x1 || a.y1 - b.y1 || a.x2 - b.x2 || a.y2 - b.y2;
}

/**
 * unitKeyOf(bubble ?? text) per unit; keys that collide after quantization get "~2", "~3" in a geometric order
 * (exact unit box, then text box, then build order), never in reading order, so a key does not move to another unit
 * when the reading direction changes (e.g. after the first @lang line).
 */
function unitKeys(units: ReadonlyArray<Pick<UnitGeometry, "bubble" | "text">>): string[] {
  type Entry = { i: number; u: Pick<UnitGeometry, "bubble" | "text"> };
  const groups = new Map<string, Entry[]>();
  units.forEach((u, i) => {
    const base = unitKeyOf(unitBox(u));
    groups.set(base, [...(groups.get(base) ?? []), { i, u }]);
  });
  const keys: string[] = [];
  for (const [base, members] of groups) {
    members.sort(
      (a, b) => compareBoxes(unitBox(a.u), unitBox(b.u)) || compareBoxes(a.u.text, b.u.text) || a.i - b.i,
    );
    members.forEach(({ i }, rank) => (keys[i] = rank === 0 ? base : `${base}~${rank + 1}`));
  }
  return keys;
}

/** Distance from the box to the nearest image border that can hold page furniture. */
function borderDistance(b: Box, size: Size): number {
  const dx = Math.min(b.x1, size.w - b.x2);
  const dy = Math.min(b.y1, size.h - b.y2);
  if (size.h / size.w > DET_DEFAULTS.stripAspect) return dx;
  if (size.w / size.h > DET_DEFAULTS.stripAspect) return dy;
  return Math.min(dx, dy);
}

function sortTextBoxes(boxes: Box[], orientation: Orientation): Box[] {
  // Horizontal lines top to bottom; vertical columns right to left.
  return orientation === "h"
    ? boxes.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
    : boxes.sort((a, b) => b.x2 - a.x2 || a.y1 - b.y1);
}

function groupLooseTexts(
  texts: readonly Detection[],
  orientOpts: { verticalAspect: number; allowVertical: boolean },
  glyphOf: (texts: readonly Box[], o: Orientation) => number,
  crossMin: number,
  gapGlyph: number,
): Detection[][] {
  const info = texts.map((t) => {
    const o = unitOrientation([t.box], orientOpts);
    return { o, g: glyphOf([t.box], o) };
  });
  const parent = texts.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    for (let p = parent[root]; p !== undefined && p !== root; p = parent[root]) root = p;
    for (let k = i; k !== root;) {
      const next = parent[k] ?? root;
      parent[k] = root;
      k = next;
    }
    return root;
  };
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      const ia = info[i];
      const ib = info[j];
      if (a === undefined || b === undefined || ia === undefined || ib === undefined || ia.o !== ib.o)
        continue;
      if (!looseNeighbours(a.box, b.box, ia.o, Math.min(ia.g, ib.g), crossMin, gapGlyph)) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
    }
  }
  const groups = new Map<number, Detection[]>();
  texts.forEach((t, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), t]);
  });
  return [...groups.values()];
}

function looseNeighbours(
  a: Box,
  b: Box,
  o: Orientation,
  glyph: number,
  crossMin: number,
  gapGlyph: number,
): boolean {
  const gapY = Math.max(0, Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2));
  const gapX = Math.max(0, Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2));
  const maxGap = gapGlyph * glyph;
  // (a) next line / column; (b) same line / column, split by the detector.
  const stacked =
    o === "h" ? hOverlap(a, b) >= crossMin && gapY <= maxGap : vOverlap(a, b) >= crossMin && gapX <= maxGap;
  const inline =
    o === "h" ? vOverlap(a, b) >= crossMin && gapX <= maxGap : hOverlap(a, b) >= crossMin && gapY <= maxGap;
  return stacked || inline;
}
