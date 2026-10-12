// Raw detector boxes → translation units of one image. PURE.
//
// The geometry of an image is a function of (raw detections, slice plan, scoreMin, reading direction) only, so the
// engine rebuilds units from stored raw detections whenever scoreMin or the direction changes and gets exactly the
// units that detection produced (detection runs this same function on its own output):
//   raw                 score ≥ 0.15, every slice's boxes in image px, in slice order (what UnitsRecord stores)
//   → assignToSlices    each box back to a slice: one containing it, preferring one with an internal edge it touches
//                       (how a box clamped at a slice edge looks); the stored list does not say which slice produced
//                       a box, and for boxes inside an overlap this choice gives the same units as the true one
//   → applyScoreMin     per slice, at read time
//   → mergeAcrossSlices per-class dedupe + union of boxes truncated at a shared slice edge
//   → buildUnits        text merge, association, grouping, orientation, glyph, reading order, unit keys: the band
//                       sort for "ltr", the gutter cut + corner rule for "rtl" (reading-order.orderHooksFor)
//   → UnitGeometry[]    wire shape, order === index
//
// detectorVersion covers what changes geometry for the same bytes: model family, input preprocessing, the slicing
// parameters and the post-processing constants. Never the backend, the model sha or scoreMin: fp32 and int8 are one
// geometry family, scoreMin applies at read time, and stored geometry stays authoritative once translations
// reference it.

import { fnv1a32, UNIT_KEY_GRID } from "../ids.ts";
import type { SliceRecord } from "../records.ts";
import type { Box, Detection, ReadingDir, Size, UnitGeometry } from "../types.ts";
import { DET_DEFAULTS, applyScoreMin, buildUnits, mergeAcrossSlices } from "./detections.ts";
import type { BuiltUnit, SliceDetections } from "./detections.ts";
import { DETECTOR_INPUT } from "./detector-io.ts";
import { GLYPH_DEFAULTS } from "./glyph.ts";
import { orderHooksFor } from "./reading-order.ts";
import { SLICER_DEFAULTS, planSlices } from "./slicer.ts";
import type { Slice, SliceOptions, SlicePlan } from "./slicer.ts";

/** Model family of the shipped detector files (fp32 and int8 give the same geometry family). */
export const MODEL_FAMILY = "v4s";
/** How production stretches a slice to the input square (measured alongside the slicing defaults). */
export const SLICE_RESIZE = "bitmap-high";

/** Geometry-affecting slicing parameters: settings.detector, same fields as DetectOptions.slice. */
export interface GeometryParams {
  triggerRatio: number;
  heightRatio: number;
  overlap: number;
  overlapMinPx: number;
  quietRows: boolean;
}

export interface UnitsBuildOptions {
  scoreMin: number;
  dir: ReadingDir;
}

/** core/slicer options for the detector parameters. */
export function sliceOptionsOf(p: GeometryParams): SliceOptions {
  return {
    trigger: p.triggerRatio,
    ratio: p.heightRatio,
    overlapRatio: p.overlap,
    minOverlapPx: p.overlapMinPx,
  };
}

/** The even slice plan (no quiet rows) for an image of `size`. */
export function planDetectorSlices(size: Size, p: GeometryParams): SlicePlan {
  return planSlices(size, sliceOptionsOf(p));
}

function compact(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/** UnitsRecord.detectorVersion, e.g. "v4s:t3.5:r3:o0.2:m200:q0:1a2b3c4d". */
export function detectorVersionOf(p: GeometryParams): string {
  const { scoreMin: _readTime, ...rules } = DET_DEFAULTS;
  const constants = {
    input: DETECTOR_INPUT,
    resize: SLICE_RESIZE,
    rules,
    slicer: SLICER_DEFAULTS,
    glyph: GLYPH_DEFAULTS,
    grid: UNIT_KEY_GRID,
  };
  return [
    MODEL_FAMILY,
    `t${compact(p.triggerRatio)}`,
    `r${compact(p.heightRatio)}`,
    `o${compact(p.overlap)}`,
    `m${compact(p.overlapMinPx)}`,
    p.quietRows ? "q1" : "q0",
    fnv1a32(JSON.stringify(constants)),
  ].join(":");
}

/** UnitsRecord.slices: y1/y2 always; x1/x2 only when the slice does not span the full width. */
export function sliceRecordsOf(slices: readonly Slice[], size: Size): SliceRecord[] {
  return slices.map((s) => {
    const record: SliceRecord = { y1: s.y, y2: s.y + s.h };
    if (s.x !== 0 || s.w !== size.w) {
      record.x1 = s.x;
      record.x2 = s.x + s.w;
    }
    return record;
  });
}

export function slicesFromRecords(records: readonly SliceRecord[], size: Size): Slice[] {
  return records.map((r) => {
    const x1 = r.x1 ?? 0;
    const x2 = r.x2 ?? size.w;
    return { x: x1, y: r.y1, w: x2 - x1, h: r.y2 - r.y1 };
  });
}

/** Every slice's detections, in slice order, as stored (copies). */
export function flattenParts(parts: readonly SliceDetections[]): Detection[] {
  return parts.flatMap((p) => p.dets.map((d) => ({ cls: d.cls, box: { ...d.box }, score: d.score })));
}

const CONTAIN_EPS = 1e-6;

function containsBox(s: Slice, b: Box): boolean {
  return (
    b.x1 >= s.x - CONTAIN_EPS &&
    b.y1 >= s.y - CONTAIN_EPS &&
    b.x2 <= s.x + s.w + CONTAIN_EPS &&
    b.y2 <= s.y + s.h + CONTAIN_EPS
  );
}

function overlapArea(s: Slice, b: Box): number {
  const w = Math.min(s.x + s.w, b.x2) - Math.max(s.x, b.x1);
  const h = Math.min(s.y + s.h, b.y2) - Math.max(s.y, b.y1);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Slices tile the height ("v"), the width ("h"), or neither (then no edge counts as a cut). */
function tilingAxis(slices: readonly Slice[], size: Size): "v" | "h" | null {
  if (slices.every((s) => s.x === 0 && s.w === size.w)) return "v";
  if (slices.every((s) => s.y === 0 && s.h === size.h)) return "h";
  return null;
}

/** Same test as mergeAcrossSlices: the box lies within edgePx of an edge of `s` that is inside the image. */
function touchesInnerEdge(s: Slice, b: Box, axis: "v" | "h" | null, size: Size, edgePx: number): boolean {
  if (axis === "v")
    return (s.y > 0 && b.y1 <= s.y + edgePx) || (s.y + s.h < size.h && b.y2 >= s.y + s.h - edgePx);
  if (axis === "h")
    return (s.x > 0 && b.x1 <= s.x + edgePx) || (s.x + s.w < size.w && b.x2 >= s.x + s.w - edgePx);
  return false;
}

/**
 * Groups raw detections by the slice that most plausibly produced them: among the slices containing a box, the first
 * one where it touches an internal edge (a clamped, truncated box), else the first one; a box no slice contains goes
 * to the slice it overlaps most. Every slice gets a part (possibly empty), in the order of `slices`.
 */
export function assignToSlices(
  raw: readonly Detection[],
  slices: readonly Slice[],
  size: Size,
  edgePx: number = DET_DEFAULTS.seam.edgePx,
): SliceDetections[] {
  const parts = slices.map((slice) => ({ slice, dets: [] as Detection[] }));
  if (parts.length === 0) return parts;
  const axis = tilingAxis(slices, size);
  for (const d of raw) {
    let first = -1;
    let cut = -1;
    let best = 0;
    let bestOverlap = -1;
    slices.forEach((s, i) => {
      if (containsBox(s, d.box)) {
        if (first < 0) first = i;
        if (cut < 0 && touchesInnerEdge(s, d.box, axis, size, edgePx)) cut = i;
      }
      const o = overlapArea(s, d.box);
      if (o > bestOverlap) {
        bestOverlap = o;
        best = i;
      }
    });
    const target = cut >= 0 ? cut : first >= 0 ? first : best;
    parts[target]?.dets.push(d);
  }
  return parts;
}

/** The wire fields of a built unit (drops the engine-only score and edge). */
export function toUnitGeometry(u: BuiltUnit): UnitGeometry {
  const unit: UnitGeometry = {
    unitKey: u.unitKey,
    kind: u.kind,
    bubble: u.bubble === null ? null : { ...u.bubble },
    text: { ...u.text },
    texts: u.texts.map((t) => ({ ...t })),
    orientation: u.orientation,
    glyphPx: u.glyphPx,
    order: u.order,
  };
  if (u.edgeSmall === true) unit.edgeSmall = true;
  return unit;
}

/**
 * The canonical pipeline (module comment) with the engine-only fields: the best text score and the seam edge of each
 * unit. Reading order for opts.dir (rtl: gutter cut + corner rule), order === index.
 */
export function buildUnitsFromRaw(
  raw: readonly Detection[],
  slices: readonly Slice[],
  size: Size,
  opts: UnitsBuildOptions,
): BuiltUnit[] {
  const parts = assignToSlices(raw, slices, size).map((p) => ({
    slice: p.slice,
    dets: applyScoreMin(p.dets, opts.scoreMin),
  }));
  return buildUnits(mergeAcrossSlices(parts, size), size, { dir: opts.dir, ...orderHooksFor(opts.dir) });
}

/** The canonical pipeline in the wire shape (DetectionResult.units, img:units). */
export function buildUnitGeometry(
  raw: readonly Detection[],
  slices: readonly Slice[],
  size: Size,
  opts: UnitsBuildOptions,
): UnitGeometry[] {
  return buildUnitsFromRaw(raw, slices, size, opts).map(toUnitGeometry);
}
