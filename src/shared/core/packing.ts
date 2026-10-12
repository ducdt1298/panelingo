// Request packing. PURE.
//
// The engine packs the units of one image. The functions also accept consecutive units of several images of one
// frame and chapter (the caller cuts at chapter and frame changes) for multi-image packs, which are not implemented
// yet. A pack keeps reading order, never splits a unit and holds at most `boxBudget` units; packs are as even as the
// budget allows (21 units at budget 20 give 11 + 10, not 20 + 1, because both cost one request and the smaller
// composite reads better).
// With a layout policy a pack must also lay out on the model's canvases (core/composite-layout, full mode). The layout
// is deterministic and cheap, so the packer runs it speculatively instead of estimating crop areas: crops too small
// for the glyph floor, webtoon bands narrower than 160 px and more than two page thumbnails all shrink the pack here,
// before anything is uploaded, rather than costing the translator a split. A shrunk pack ends on an image boundary
// when one lies between the even size and the largest size that fits.
// compositeInputs() is the single mapping from units to layout inputs, shared with the engine's composite builder.

import { LIMITS } from "../settings.ts";
import type { Box, ReadingDir, Script, Size } from "../types.ts";
import { layoutComposite } from "./composite-layout.ts";
import type {
  CompositeLayout,
  CompositeMode,
  CropSpec,
  Mark,
  ModelProfileLike,
  Segment,
} from "./composite-layout.ts";
import { ORDER_DEFAULTS } from "./reading-order.ts";

/** What packing and the composite layout read from a unit. The engine's PackUnit satisfies it. */
export interface PackingUnit {
  /** Owner image; one context segment per image. */
  contentKey: string;
  /** Text box and glyph size in natural px of the image. */
  geometry: { readonly text: Box; readonly glyphPx: number };
  /** Natural size of the image. */
  imageSize: Size;
  script: Script;
}

export interface CompositeInputs {
  segs: Segment[];
  marks: Mark[];
  crops: CropSpec[];
}

export interface PackPolicy {
  /** Units per pack (resolveBoxBudget). */
  boxBudget: number;
  /** Every pack must lay out in full mode on this profile's canvases (omit for budget-only packing). */
  layout?: { profile: ModelProfileLike; dir: ReadingDir };
  /** Max images per pack, for multi-image packs (not implemented yet; the engine never sets it). */
  maxImages?: number;
}

const [BUDGET_MIN, BUDGET_MAX] = LIMITS["translate.boxBudget"] ?? [4, 20];

/**
 * Units per request: the user's translate.boxBudget when set, else the model profile's (core/model-profile.ts),
 * clamped to the setting's range (4..20).
 */
export function resolveBoxBudget(profileBudget: number, override: number | null | undefined): number {
  const raw = override ?? profileBudget;
  const value = Number.isFinite(raw) ? Math.floor(raw) : BUDGET_MAX;
  return Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, value));
}

/** Webtoon strip (h / w above the reading-order strip aspect): its context is a band around the units. */
export function isStripImage(size: Size): boolean {
  return size.w > 0 && size.h / size.w > ORDER_DEFAULTS.stripAspect;
}

/**
 * Layout inputs of a pack, in the given (reading) order: mark and crop n = index + 1, one segment per image in
 * order of first use (a page thumbnail, or a band for strips). Crops-only mode has no segments and no marks.
 */
export function compositeInputs(units: readonly PackingUnit[], mode: CompositeMode): CompositeInputs {
  const segs: Segment[] = [];
  const marks: Mark[] = [];
  const crops: CropSpec[] = [];
  const segmentOf = new Map<string, number>();
  units.forEach((unit, index) => {
    const n = index + 1;
    const { w, h } = unit.imageSize;
    crops.push({
      n,
      imageId: unit.contentKey,
      text: { ...unit.geometry.text },
      bounds: { w, h },
      glyphPx: unit.geometry.glyphPx,
      script: unit.script,
    });
    if (mode === "crops-only") return;
    let segment = segmentOf.get(unit.contentKey);
    if (segment === undefined) {
      segment = segs.length;
      segmentOf.set(unit.contentKey, segment);
      segs.push({
        imageId: unit.contentKey,
        kind: isStripImage(unit.imageSize) ? "band" : "page",
        src: { x1: 0, y1: 0, x2: w, y2: h },
        imgW: w,
        imgH: h,
      });
    }
    marks.push({ n, segment, text: { ...unit.geometry.text } });
  });
  return { segs, marks, crops };
}

/** core/composite-layout for a pack (throws RangeError on malformed geometry, like layoutComposite). */
export function layoutPack(
  units: readonly PackingUnit[],
  profile: ModelProfileLike,
  dir: ReadingDir,
  mode: CompositeMode,
): CompositeLayout {
  const { segs, marks, crops } = compositeInputs(units, mode);
  return layoutComposite(segs, marks, crops, profile, dir, mode);
}

function imageCount(units: readonly PackingUnit[]): number {
  return new Set(units.map((unit) => unit.contentKey)).size;
}

/** A single unit always fits: it cannot be split, and the translator gives up on it if it cannot be composed. */
function fits(units: readonly PackingUnit[], policy: PackPolicy): boolean {
  if (units.length <= 1) return true;
  if (policy.maxImages !== undefined && imageCount(units) > Math.max(1, policy.maxImages)) return false;
  if (policy.layout === undefined) return true;
  try {
    return layoutPack(units, policy.layout.profile, policy.layout.dir, "full").ok;
  } catch {
    return false;
  }
}

/** Largest prefix length in 1..max of units[start..] that fits (fit shrinks monotonically as a pack grows). */
function largestFitting<T extends PackingUnit>(
  units: readonly T[],
  start: number,
  max: number,
  policy: PackPolicy,
): number {
  if (fits(units.slice(start, start + max), policy)) return max;
  let lo = 1;
  let hi = max - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(units.slice(start, start + mid), policy)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Pack size when only `fitting` units fit: the largest size in [even, fitting] that ends on an image boundary (each
 * image's context is then drawn once), else the even size, so a layout limit does not leave a runt pack behind.
 */
function shrunkSize<T extends PackingUnit>(
  units: readonly T[],
  start: number,
  fitting: number,
  policy: PackPolicy,
): number {
  const remaining = units.length - start;
  const even = Math.ceil(remaining / Math.ceil(remaining / fitting));
  for (let size = fitting; size >= even; size -= 1) {
    if (units[start + size - 1]?.contentKey !== units[start + size]?.contentKey) return size;
  }
  return fits(units.slice(start, start + even), policy) ? even : fitting;
}

/** Splits units (reading order) into even packs within the policy (see the module comment). */
export function packUnits<T extends PackingUnit>(units: readonly T[], policy: PackPolicy): T[][] {
  const budget = Math.max(1, Math.floor(policy.boxBudget));
  const packs: T[][] = [];
  let start = 0;
  while (start < units.length) {
    const remaining = units.length - start;
    let size = Math.ceil(remaining / Math.ceil(remaining / budget));
    const fitting = largestFitting(units, start, size, policy);
    if (fitting < size) size = shrunkSize(units, start, fitting, policy);
    packs.push(units.slice(start, start + size));
    start += size;
  }
  return packs;
}
