// Set-of-Mark composite layout. PURE and deterministic: the same input always yields the same rectangles, so the
// packer may call it speculatively and layouts can be golden-tested.
//
// Full mode, for each profile canvas in order (2048×768 first, then 2048×1152 when the profile allows):
//  1. white canvas;
//  2. context area on the left, at most clamp(0.30·W, 320, 640) px wide and H − 2·pad tall: page thumbnails
//     (≤ 2) or webtoon bands (the rows of each image's numbered units ± 0.15·image width; ghosts never widen a
//     band), in 1 or 2 balanced columns with one common scale, never upscaled; for rtl the first column is on the
//     right; bands < 160 px wide fail;
//  3. a 4-px separator right after the thumbnails; every numbered mark gets a frame (text box + 3 px) in its
//     palette colour and a numbered badge OUTSIDE it: the best of 8 positions in the reading direction's order,
//     then rings of sliding positions. A badge never covers a text box or another badge, otherwise the layout
//     fails with reason "badges";
//  4. crop area right of the separator: crop i is its text box inflated by max(6, 0.3·glyph_i), scaled by
//     k_i·g with k_i = clamp(target/glyph_i, 0.35, 4) and the largest g ∈ [0.25, 1] (binary search, 10 steps)
//     at which every cell shelf-packs in reading order (retried sorted by height); each cell carries a 28-px
//     "#n" header strip and a 2-px border in the mark's colour;
//  5. ok = fits && every crop's effective glyph g·k_i·glyph_i reaches glyphMin[script_i] (a crop that cannot
//     reach it even at k = kMax only needs g = 1) && badges are clean.
// When no canvas works, the last attempt comes back with ok: false and a reason so the packer can split the pack.
// Crops-only mode (re-asks): no context and no marks; crops renumbered 1..k in reading order fill the canvas.
// The caller supplies each crop's script (core/model-profile.ts scriptForLang) and any profile with the fields of
// ModelProfileLike (core/model-profile.ts ModelProfile qualifies).

import { area, height, inflate, inter, width } from "../geometry.ts";
import type { Box, ReadingDir, Script, Size } from "../types.ts";

export const COMP = {
  pad: 8,
  sep: 4,
  gap: 8,
  headerH: 28,
  border: 2,
  contextFrac: 0.3,
  contextMinPx: 320,
  contextMaxPx: 640,
  minBandPx: 160,
  bandMarginFrac: 0.15,
  maxPagesPerPack: 2,
  kMin: 0.35,
  kMax: 4,
  gMin: 0.25,
  gIters: 10,
  badgeH: 28,
  palette: ["#D32F2F", "#1976D2", "#388E3C", "#7B1FA2", "#E65100", "#00796B", "#C2185B", "#5D4037"],
  // Drawing details shared by layout and render.
  paper: "#FFFFFF",
  ink: "#000000",
  /** Frame = text box inflated by this, stroked this wide. */
  frameInflate: 3,
  frameWidth: 3,
  /** Units of the other half of a split pack: thin grey frame, no badge. */
  ghostColor: "#9E9E9E",
  ghostWidth: 1,
  /** Free space between a frame and its badge. */
  badgeGap: 2,
  /** Rings of sliding badge positions tried after the 8 preferred ones (each half a badge farther out). */
  badgeRings: 4,
  /** Black + white outline drawn inside the badge box (4-px black stroke under a 2-px white one). */
  badgeOutline: 2,
  badgeTextStroke: 3,
  badgeFont: "bold 20px Arial, Helvetica, sans-serif",
  badgeFontPx: 20,
  badgePadX: 14,
  headerFont: "bold 22px Arial, Helvetica, sans-serif",
  headerFontPx: 22,
  headerPadX: 6,
  /** Conservative advance of a bold digit or '#' in em (Arial Bold digits measure 0.556 em). */
  digitEm: 0.6,
  /** Crop source = text box inflated by max(cropPadMin, cropPadGlyph·glyph). */
  cropPadMin: 6,
  cropPadGlyph: 0.3,
} as const;

export type CompositeMode = "full" | "crops-only";

/** One image (or seam canvas) shown in the context area. */
export interface Segment {
  /** Key passed to the renderer's source lookup. */
  imageId: string;
  /** "page": the whole region as a thumbnail. "band": a full-width band around this segment's marks. */
  kind: "page" | "band";
  /** Region that may be shown, in natural px of the image (normally the whole image). */
  src: Box;
  imgW: number;
  imgH: number;
}

/** A unit drawn in the context area. */
export interface Mark {
  /** Request label 1..N in reading order (ignored for ghosts). */
  n: number;
  /** Index into the segments. */
  segment: number;
  /** The unit's text box in natural px of the segment's image. */
  text: Box;
  /**
   * A unit of the other half of a split pack: 1-px grey frame, no badge, no crop. It never widens a band; outside
   * the band it is not drawn, across its edge it is cut to the visible part.
   */
  ghost?: true;
}

/** An enlarged crop of one unit for the crop area. */
export interface CropSpec {
  /** Request label; renumbered 1..k in crops-only mode. */
  n: number;
  /** Owner image of the unit. */
  imageId: string;
  /** The unit's text box in natural px of the crop source (the image, or the seam canvas when fromSeam is set). */
  text: Box;
  /** Natural size of the crop source; the inflated crop is clipped to it. */
  bounds: Size;
  /** Estimated glyph height in natural px. */
  glyphPx: number;
  script: Script;
  /** Seam canvas key: the crop is cut from this canvas instead of the image. */
  fromSeam?: string;
}

/** The part of the model profile (core/model-profile.ts) that the layout reads. */
export interface ModelProfileLike {
  /** Canvas sizes tried in order. */
  readonly canvas: ReadonlyArray<{ readonly W: number; readonly H: number }>;
  readonly glyphTarget: Readonly<Record<Script, number>>;
  readonly glyphMin: Readonly<Record<Script, number>>;
}

/**
 * Why a layout is not ok, in precedence order: no crops; more than 2 page thumbnails; bands narrower than 160 px;
 * crops do not fit even at g = 0.25; a crop's glyph stays below the floor; a badge cannot avoid text or badges.
 */
export type CompositeFailReason = "empty" | "too-many-pages" | "context" | "overflow" | "glyph" | "badges";

export interface ContextPlacement {
  segment: number;
  imageId: string;
  /** Region of the image drawn (natural px). */
  src: Box;
  /** Where it is drawn on the canvas. */
  dst: Box;
  /** Common thumbnail scale (≤ 1); dst is src·scale rounded down. */
  scale: number;
}

export interface MarkPlacement {
  n: number;
  segment: number;
  /** The text box on the canvas. */
  text: Box;
  frame: Box;
  badge: Box;
  color: string;
}

export interface GhostPlacement {
  segment: number;
  text: Box;
  frame: Box;
}

export interface CropPlacement {
  /** Label printed in the header ("#n"). */
  n: number;
  /** The caller's number (differs from n in crops-only mode). */
  orig: number;
  imageId: string;
  /** Source lookup key: the seam canvas when the spec had fromSeam, else imageId. */
  source: string;
  /** Crop rectangle in the source (natural px). */
  src: Box;
  /** Whole cell: header strip + border + image. */
  cell: Box;
  header: Box;
  /** Where the crop is drawn. */
  dst: Box;
  /** k·g. */
  scale: number;
  /** g·k·glyph: glyph height in the composite. */
  effGlyph: number;
  script: Script;
  color: string;
}

export interface CompositeLayout {
  W: number;
  H: number;
  mode: CompositeMode;
  dir: ReadingDir;
  ok: boolean;
  reason: CompositeFailReason | null;
  /** Index of the profile canvas used. */
  canvasIndex: number;
  /** Every crop cell lies inside the crop area. When false the cells are a best effort at g = gMin. */
  fits: boolean;
  /** Global crop scale in [gMin, 1]. */
  g: number;
  /** Smallest effective glyph over the crops (0 without crops). */
  minEffGlyph: number;
  separator: Box | null;
  cropArea: Box;
  context: ContextPlacement[];
  /** Numbered marks in increasing n. */
  marks: MarkPlacement[];
  ghosts: GhostPlacement[];
  /** Crops in increasing n. */
  crops: CropPlacement[];
}

const EPS = 1e-9;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function rect(x: number, y: number, w: number, h: number): Box {
  return { x1: x, y1: y, x2: x + w, y2: y + h };
}

/** Clamp a box into the region r (may become empty). */
function clipTo(b: Box, r: Box): Box {
  const x1 = clampNum(b.x1, r.x1, r.x2);
  const y1 = clampNum(b.y1, r.y1, r.y2);
  return { x1, y1, x2: clampNum(b.x2, x1, r.x2), y2: clampNum(b.y2, y1, r.y2) };
}

/** Round outward to whole pixels. */
function outward(b: Box): Box {
  return {
    x1: Math.floor(b.x1 + EPS),
    y1: Math.floor(b.y1 + EPS),
    x2: Math.ceil(b.x2 - EPS),
    y2: Math.ceil(b.y2 - EPS),
  };
}

function digitCount(n: number): number {
  return String(Math.max(0, Math.trunc(n))).length;
}

/** Badge width for label n: a circle for one digit, a pill beyond. */
export function badgeWidth(n: number): number {
  return Math.max(COMP.badgeH, Math.ceil(digitCount(n) * COMP.digitEm * COMP.badgeFontPx) + COMP.badgePadX);
}

/** Narrowest crop cell that still shows its "#n" header label. */
export function headerMinWidth(n: number): number {
  return Math.ceil((1 + digitCount(n)) * COMP.digitEm * COMP.headerFontPx) + 2 * COMP.headerPadX;
}

/** Frame, badge and header colour of label n (cycles through the 8-colour palette). */
export function paletteColor(n: number): string {
  const len = COMP.palette.length;
  return COMP.palette[(((Math.trunc(n) - 1) % len) + len) % len] ?? COMP.palette[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Context area

interface ContextItem {
  segment: number;
  seg: Segment;
  region: Box;
  w: number;
  h: number;
}

interface ContextResult {
  placements: ContextPlacement[];
  usedW: number;
  bandsOk: boolean;
}

function imageBounds(seg: Segment): Box {
  return outward(clipTo(seg.src, rect(0, 0, seg.imgW, seg.imgH)));
}

/**
 * Pages show their whole region. Bands show full-width rows from the first to the last numbered mark of the
 * segment ± 0.15·width (only the pack's own units count). Ghosts never widen a band: otherwise each half of a
 * split pack would keep the whole pack's band and a band too narrow for 160 px could never be split away. A band
 * without numbered marks spans its ghosts, or the whole region.
 */
function shownRegion(seg: Segment, index: number, marks: readonly Mark[]): Box {
  const bounds = imageBounds(seg);
  if (seg.kind === "page") return bounds;
  const own = marks.filter((m) => m.segment === index);
  const numbered = own.filter((m) => m.ghost !== true);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const m of numbered.length > 0 ? numbered : own) {
    minY = Math.min(minY, m.text.y1);
    maxY = Math.max(maxY, m.text.y2);
  }
  if (!(maxY > minY)) return bounds;
  const margin = COMP.bandMarginFrac * seg.imgW;
  const y1 = Math.max(bounds.y1, Math.floor(minY - margin));
  const y2 = Math.min(bounds.y2, Math.ceil(maxY + margin));
  return y2 > y1 ? { x1: bounds.x1, y1, x2: bounds.x2, y2 } : bounds;
}

function columnScale(column: readonly ContextItem[], colW: number, colH: number): number {
  let maxW = 0;
  let sumH = 0;
  for (const it of column) {
    maxW = Math.max(maxW, it.w);
    sumH += it.h;
  }
  return Math.min(colW / maxW, (colH - COMP.gap * (column.length - 1)) / sumH);
}

/** One column, or two contiguous columns split where the common scale is largest; ties keep one column. */
function planColumns(
  items: readonly ContextItem[],
  Wc: number,
  Hc: number,
): { columns: ContextItem[][]; s: number } {
  let best = { columns: [[...items]], s: Math.min(1, columnScale(items, Wc, Hc)) };
  const colW = (Wc - COMP.gap) / 2;
  for (let k = 1; k < items.length; k++) {
    const first = items.slice(0, k);
    const second = items.slice(k);
    const s = Math.min(1, columnScale(first, colW, Hc), columnScale(second, colW, Hc));
    if (s > best.s + EPS) best = { columns: [first, second], s };
  }
  return best;
}

function layoutContext(
  segs: readonly Segment[],
  marks: readonly Mark[],
  W: number,
  H: number,
  dir: ReadingDir,
): ContextResult {
  const Wc = Math.floor(clampNum(COMP.contextFrac * W, COMP.contextMinPx, COMP.contextMaxPx));
  const Hc = H - 2 * COMP.pad;
  const items: ContextItem[] = segs.map((seg, segment) => {
    const region = shownRegion(seg, segment, marks);
    return { segment, seg, region, w: width(region), h: height(region) };
  });
  const plan = planColumns(items, Wc, Hc);
  const s = Math.max(plan.s, 1e-3);
  const size = (v: number): number => Math.max(1, Math.floor(v * s + EPS));
  const colWidths = plan.columns.map((col) => col.reduce((m, it) => Math.max(m, size(it.w)), 1));
  const usedW = colWidths.reduce((a, b) => a + b, 0) + COMP.gap * (plan.columns.length - 1);

  const placements: ContextPlacement[] = [];
  let x = COMP.pad;
  plan.columns.forEach((col, c) => {
    const colW = colWidths[c] ?? 1;
    const colX = dir === "rtl" ? 2 * COMP.pad + usedW - x - colW : x;
    const colH = col.reduce((sum, it) => sum + size(it.h), 0) + COMP.gap * (col.length - 1);
    let y = COMP.pad + Math.max(0, Math.floor((Hc - colH) / 2));
    for (const it of col) {
      const w = size(it.w);
      const h = size(it.h);
      const dst = rect(colX + Math.floor((colW - w) / 2), y, w, h);
      placements.push({ segment: it.segment, imageId: it.seg.imageId, src: it.region, dst, scale: s });
      y += h + COMP.gap;
    }
    x += colW + COMP.gap;
  });
  placements.sort((a, b) => a.segment - b.segment);
  const bandsOk = items.every((it) => it.seg.kind !== "band" || it.w * s >= COMP.minBandPx - EPS);
  return { placements, usedW, bandsOk };
}

// ---------------------------------------------------------------------------------------------------------------
// Frames and badges

interface MappedMark {
  mark: Mark;
  place: ContextPlacement;
  text: Box;
  frame: Box;
}

interface BadgeCandidate {
  box: Box;
  cost: number;
}

/** A text box (natural px of the segment) on the canvas, rounded outward. */
function toCanvas(b: Box, p: ContextPlacement): Box {
  const sx = width(p.dst) / width(p.src);
  const sy = height(p.dst) / height(p.src);
  const c = clipTo(b, p.src);
  return outward({
    x1: p.dst.x1 + (c.x1 - p.src.x1) * sx,
    y1: p.dst.y1 + (c.y1 - p.src.y1) * sy,
    x2: p.dst.x1 + (c.x2 - p.src.x1) * sx,
    y2: p.dst.y1 + (c.y2 - p.src.y1) * sy,
  });
}

/** from..to inclusive in `step` increments. */
function sweep(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v < to; v += step) out.push(v);
  out.push(to);
  return out;
}

/**
 * Badge positions around frame F, cheapest first. Costs 0..7: rtl top-right, top-left, right-mid, left-mid,
 * bottom-right, bottom-left, top-centre, bottom-centre (mirrored for ltr). Then rings at increasing distance,
 * each sweeping the top edge, the side read first, the other side and the bottom edge.
 */
function badgeCandidates(F: Box, w: number, h: number, dir: ReadingDir): BadgeCandidate[] {
  const gap = COMP.badgeGap;
  const at = (x: number, y: number): Box => rect(Math.round(x), Math.round(y), w, h);
  const cx = (F.x1 + F.x2) / 2;
  const cy = (F.y1 + F.y2) / 2;
  const top = F.y1 - gap - h;
  const bottom = F.y2 + gap;
  const tl = at(F.x1, top);
  const tr = at(F.x2 - w, top);
  const lm = at(F.x1 - gap - w, cy - h / 2);
  const rm = at(F.x2 + gap, cy - h / 2);
  const bl = at(F.x1, bottom);
  const br = at(F.x2 - w, bottom);
  const tc = at(cx - w / 2, top);
  const bc = at(cx - w / 2, bottom);
  const primary = dir === "rtl" ? [tr, tl, rm, lm, br, bl, tc, bc] : [tl, tr, lm, rm, bl, br, tc, bc];
  const out: BadgeCandidate[] = primary.map((box, cost) => ({ box, cost }));

  const step = Math.max(2, Math.round(h / 2));
  for (let ring = 0; ring < COMP.badgeRings; ring++) {
    const R = inflate(F, gap + ring * step);
    const xs = sweep(R.x1 - w, R.x2, step);
    if (dir === "rtl") xs.reverse();
    const ys = sweep(R.y1 - h, R.y2, step);
    const nearX = dir === "rtl" ? R.x2 : R.x1 - w;
    const farX = dir === "rtl" ? R.x1 - w : R.x2;
    const boxes = [
      ...xs.map((x) => at(x, R.y1 - h)),
      ...ys.map((y) => at(nearX, y)),
      ...ys.map((y) => at(farX, y)),
      ...xs.map((x) => at(x, R.y2)),
    ];
    boxes.forEach((box, i) => out.push({ box, cost: primary.length + 100 * ring + Math.min(i, 99) }));
  }
  return out;
}

/** Move b inside r without resizing it; null when r is too small. */
function shiftInto(b: Box, r: Box): Box | null {
  const w = width(b);
  const h = height(b);
  if (w > width(r) || h > height(r)) return null;
  return rect(clampNum(b.x1, r.x1, r.x2 - w), clampNum(b.y1, r.y1, r.y2 - h), w, h);
}

function overlapSum(b: Box, others: readonly Box[]): number {
  let sum = 0;
  for (const o of others) sum += inter(b, o);
  return sum;
}

/**
 * Hard rules: inside `allowed`, no text box covered, no badge overlapped. Among those, the lowest score
 * 1000·(frame overlap px²) + 100·(px² outside the own thumbnail) + cost wins.
 */
function chooseBadge(
  frame: Box,
  own: Box,
  w: number,
  allowed: Box,
  texts: readonly Box[],
  frames: readonly Box[],
  badges: readonly Box[],
  dir: ReadingDir,
): { box: Box; clean: boolean } {
  let best: { box: Box; score: number } | null = null;
  let fallback: { box: Box; score: number } | null = null;
  for (const cand of badgeCandidates(frame, w, COMP.badgeH, dir)) {
    const b = shiftInto(cand.box, allowed);
    if (b === null) continue;
    const textHit = overlapSum(b, texts);
    const badgeHit = overlapSum(b, badges);
    const score = 1000 * overlapSum(b, frames) + 100 * (area(b) - inter(b, own)) + cand.cost;
    if (textHit === 0 && badgeHit === 0) {
      if (best === null || score < best.score) best = { box: b, score };
    } else {
      const worse = 1e9 * textHit + 1e6 * badgeHit + score;
      if (fallback === null || worse < fallback.score) fallback = { box: b, score: worse };
    }
  }
  if (best !== null) return { box: best.box, clean: true };
  return { box: fallback?.box ?? rect(allowed.x1, allowed.y1, w, COMP.badgeH), clean: false };
}

function placeMarks(
  marks: readonly Mark[],
  context: readonly ContextPlacement[],
  allowed: Box,
  dir: ReadingDir,
): { marks: MarkPlacement[]; ghosts: GhostPlacement[]; conflicts: number } {
  const mapped: MappedMark[] = [];
  for (const mark of marks) {
    const place = context[mark.segment];
    if (place === undefined) throw new RangeError(`composite: mark ${mark.n} has no segment ${mark.segment}`);
    // A ghost outside this half's band is not shown at all; one cut by the band edge keeps its visible part.
    // Numbered marks always intersect their region (validate).
    if (mark.ghost === true && inter(mark.text, place.src) <= 0) continue;
    const text = toCanvas(mark.text, place);
    mapped.push({ mark, place, text, frame: inflate(text, COMP.frameInflate) });
  }
  const texts = mapped.map((m) => m.text);
  const frames = mapped.map((m) => m.frame);
  const numbered = mapped.filter((m) => m.mark.ghost !== true).sort((a, b) => a.mark.n - b.mark.n);
  const badges: Box[] = [];
  const out: MarkPlacement[] = [];
  let conflicts = 0;
  for (const m of numbered) {
    const pick = chooseBadge(m.frame, m.place.dst, badgeWidth(m.mark.n), allowed, texts, frames, badges, dir);
    if (!pick.clean) conflicts++;
    badges.push(pick.box);
    out.push({
      n: m.mark.n,
      segment: m.mark.segment,
      text: m.text,
      frame: m.frame,
      badge: pick.box,
      color: paletteColor(m.mark.n),
    });
  }
  const ghosts = mapped
    .filter((m) => m.mark.ghost === true)
    .map((m) => ({ segment: m.mark.segment, text: m.text, frame: m.frame }));
  return { marks: out, ghosts, conflicts };
}

// ---------------------------------------------------------------------------------------------------------------
// Crop area

interface CropItem {
  n: number;
  orig: number;
  imageId: string;
  source: string;
  src: Box;
  w: number;
  h: number;
  k: number;
  glyph: number;
  /** Required effective glyph: glyphMin, or k·glyph when even g = 1 cannot reach glyphMin. */
  floor: number;
  script: Script;
  color: string;
}

interface CellPlan {
  cell: Box;
  header: Box;
  dst: Box;
}

function prepareCrops(crops: readonly CropSpec[], prof: ModelProfileLike, mode: CompositeMode): CropItem[] {
  return [...crops]
    .sort((a, b) => a.n - b.n)
    .map((c, i) => {
      const n = mode === "crops-only" ? i + 1 : c.n;
      const glyph = Math.max(1, c.glyphPx);
      const margin = Math.max(COMP.cropPadMin, COMP.cropPadGlyph * glyph);
      const src = outward(clipTo(inflate(c.text, margin), rect(0, 0, c.bounds.w, c.bounds.h)));
      if (area(src) <= 0) throw new RangeError(`composite: crop ${c.n} lies outside its source`);
      const k = clampNum(prof.glyphTarget[c.script] / glyph, COMP.kMin, COMP.kMax);
      return {
        n,
        orig: c.n,
        imageId: c.imageId,
        source: c.fromSeam ?? c.imageId,
        src,
        w: width(src),
        h: height(src),
        k,
        glyph,
        floor: Math.min(prof.glyphMin[c.script], k * glyph),
        script: c.script,
        color: paletteColor(n),
      };
    });
}

/** Cell at global scale g: image (k·g·w × k·g·h) + 2-px border + 28-px header, never narrower than its label. */
function cellSize(it: CropItem, g: number): { cw: number; ch: number; iw: number; ih: number } {
  const iw = Math.max(1, Math.round(it.k * g * it.w));
  const ih = Math.max(1, Math.round(it.k * g * it.h));
  return {
    iw,
    ih,
    cw: Math.max(iw + 2 * COMP.border, headerMinWidth(it.n)),
    ch: ih + 2 * COMP.border + COMP.headerH,
  };
}

/** Shelf packing: left to right, a new row when the next cell does not fit, rows `gap` apart. */
function shelfPack(
  order: readonly CropItem[],
  g: number,
  box: Box,
): { fits: boolean; cells: Map<CropItem, CellPlan> } {
  const cells = new Map<CropItem, CellPlan>();
  let fits = true;
  let x = box.x1;
  let y = box.y1;
  let rowH = 0;
  for (const it of order) {
    const { cw, ch, iw, ih } = cellSize(it, g);
    if (x > box.x1 && x + cw > box.x2) {
      y += rowH + COMP.gap;
      x = box.x1;
      rowH = 0;
    }
    if (x + cw > box.x2 || y + ch > box.y2) fits = false;
    const inner = cw - 2 * COMP.border;
    cells.set(it, {
      cell: rect(x, y, cw, ch),
      header: rect(x, y, cw, COMP.headerH),
      dst: rect(x + COMP.border + Math.floor((inner - iw) / 2), y + COMP.headerH + COMP.border, iw, ih),
    });
    x += cw + COMP.gap;
    rowH = Math.max(rowH, ch);
  }
  return { fits, cells };
}

/** Largest g in [gMin, 1] at which `order` fits (10 bisection steps), or null if it does not fit at gMin. */
function searchScale(order: readonly CropItem[], box: Box): number | null {
  if (shelfPack(order, 1, box).fits) return 1;
  if (!shelfPack(order, COMP.gMin, box).fits) return null;
  let lo: number = COMP.gMin;
  let hi = 1;
  for (let i = 0; i < COMP.gIters; i++) {
    const mid = (lo + hi) / 2;
    if (shelfPack(order, mid, box).fits) lo = mid;
    else hi = mid;
  }
  return lo;
}

function packCrops(
  items: readonly CropItem[],
  box: Box,
): { fits: boolean; g: number; cells: Map<CropItem, CellPlan> } {
  if (items.length === 0) return { fits: true, g: 1, cells: new Map() };
  let order: readonly CropItem[] = items;
  let g = searchScale(order, box);
  if (g === null) {
    // Next-fit decreasing height: tall cells share rows. Stable sort keeps reading order among equals.
    order = [...items].sort((a, b) => b.k * b.h - a.k * a.h);
    g = searchScale(order, box);
  }
  if (g === null) return { fits: false, g: COMP.gMin, cells: shelfPack(items, COMP.gMin, box).cells };
  return { fits: true, g, cells: shelfPack(order, g, box).cells };
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point

function finiteBox(b: Box): boolean {
  return Number.isFinite(b.x1) && Number.isFinite(b.y1) && Number.isFinite(b.x2) && Number.isFinite(b.y2);
}

function positive(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}

function validate(
  segs: readonly Segment[],
  marks: readonly Mark[],
  crops: readonly CropSpec[],
  prof: ModelProfileLike,
  mode: CompositeMode,
): void {
  if (prof.canvas.length === 0) throw new RangeError("composite: the profile lists no canvas size");
  for (const c of prof.canvas) {
    if (!Number.isInteger(c.W) || !Number.isInteger(c.H) || c.W <= 0 || c.H <= 0) {
      throw new RangeError(`composite: invalid canvas ${c.W}x${c.H}`);
    }
  }
  const cropNumbers = new Set<number>();
  for (const c of crops) {
    if (!Number.isInteger(c.n) || c.n < 1) throw new RangeError(`composite: crop number ${c.n} is not 1..N`);
    if (cropNumbers.has(c.n)) throw new RangeError(`composite: duplicate crop number ${c.n}`);
    cropNumbers.add(c.n);
    if (!Number.isFinite(c.glyphPx)) throw new RangeError(`composite: crop ${c.n} has no glyph size`);
    if (!finiteBox(c.text) || !positive(c.bounds.w) || !positive(c.bounds.h)) {
      throw new RangeError(`composite: crop ${c.n} has an invalid text box or source size`);
    }
    // A missing or NaN entry (e.g. a profile read from JSON) would turn every crop rectangle into NaN.
    if (!positive(prof.glyphTarget[c.script]) || !positive(prof.glyphMin[c.script])) {
      throw new RangeError(`composite: the profile has no glyph sizes for script ${c.script}`);
    }
  }
  if (mode === "crops-only") return;
  segs.forEach((s, i) => {
    if (!positive(s.imgW) || !positive(s.imgH) || !finiteBox(s.src) || area(imageBounds(s)) <= 0) {
      throw new RangeError(`composite: segment ${i} shows an empty region`);
    }
  });
  const markNumbers = new Set<number>();
  for (const m of marks) {
    const seg = Number.isInteger(m.segment) ? segs[m.segment] : undefined;
    if (seg === undefined) {
      throw new RangeError(`composite: mark ${m.n} refers to missing segment ${m.segment}`);
    }
    if (!finiteBox(m.text)) throw new RangeError(`composite: mark ${m.n} has an invalid text box`);
    if (m.ghost === true) continue;
    if (!Number.isInteger(m.n) || m.n < 1) throw new RangeError(`composite: mark number ${m.n} is not 1..N`);
    if (markNumbers.has(m.n)) throw new RangeError(`composite: duplicate mark number ${m.n}`);
    markNumbers.add(m.n);
    // Otherwise its frame would collapse onto the region's edge and its badge would point at nothing.
    if (inter(m.text, imageBounds(seg)) <= 0) {
      throw new RangeError(`composite: mark ${m.n} lies outside the region of segment ${m.segment}`);
    }
  }
}

function layoutOnCanvas(
  W: number,
  H: number,
  canvasIndex: number,
  segs: readonly Segment[],
  marks: readonly Mark[],
  items: readonly CropItem[],
  dir: ReadingDir,
  mode: CompositeMode,
): CompositeLayout {
  const pad = COMP.pad;
  let context: ContextPlacement[] = [];
  let separator: Box | null = null;
  let markOut: MarkPlacement[] = [];
  let ghosts: GhostPlacement[] = [];
  let conflicts = 0;
  let bandsOk = true;
  let cropArea: Box = { x1: pad, y1: pad, x2: W - pad, y2: H - pad };
  const full = mode === "full";

  if (full && segs.length > 0) {
    const ctx = layoutContext(segs, marks, W, H, dir);
    context = ctx.placements;
    bandsOk = ctx.bandsOk;
    const sepX = 2 * pad + ctx.usedW;
    separator = rect(sepX, 0, COMP.sep, H);
    cropArea = { x1: sepX + COMP.sep + COMP.gap, y1: pad, x2: W - pad, y2: H - pad };
    const placed = placeMarks(marks, context, { x1: 0, y1: 0, x2: sepX, y2: H }, dir);
    markOut = placed.marks;
    ghosts = placed.ghosts;
    conflicts = placed.conflicts;
  }

  const pack = packCrops(items, cropArea);
  const g = pack.g;
  const glyphOk = items.every((it) => g * it.k * it.glyph >= it.floor - EPS);
  const pages = full ? segs.filter((s) => s.kind === "page").length : 0;
  const failures: Array<[boolean, CompositeFailReason]> = [
    [items.length === 0, "empty"],
    [pages > COMP.maxPagesPerPack, "too-many-pages"],
    [!bandsOk, "context"],
    [!pack.fits, "overflow"],
    [!glyphOk, "glyph"],
    [conflicts > 0, "badges"],
  ];
  const reason = failures.find(([failed]) => failed)?.[1] ?? null;
  const none = rect(cropArea.x1, cropArea.y1, 0, 0);

  return {
    W,
    H,
    mode,
    dir,
    ok: reason === null,
    reason,
    canvasIndex,
    fits: pack.fits,
    g,
    minEffGlyph: items.reduce((m, it) => Math.min(m, g * it.k * it.glyph), items.length > 0 ? Infinity : 0),
    separator,
    cropArea,
    context,
    marks: markOut,
    ghosts,
    crops: items.map((it) => {
      const plan = pack.cells.get(it) ?? { cell: none, header: none, dst: none };
      return {
        n: it.n,
        orig: it.orig,
        imageId: it.imageId,
        source: it.source,
        src: it.src,
        ...plan,
        scale: it.k * g,
        effGlyph: g * it.k * it.glyph,
        script: it.script,
        color: it.color,
      };
    }),
  };
}

/**
 * Lays out one composite. `marks` and `segs` are ignored in crops-only mode. Throws RangeError on malformed input
 * (duplicate or non-positive numbers, a mark on a missing segment or outside its region, a crop outside its source,
 * no canvas sizes, no glyph sizes for a crop's script).
 */
export function layoutComposite(
  segs: readonly Segment[],
  marks: readonly Mark[],
  crops: readonly CropSpec[],
  prof: ModelProfileLike,
  dir: ReadingDir,
  mode: CompositeMode,
): CompositeLayout {
  validate(segs, marks, crops, prof, mode);
  const items = prepareCrops(crops, prof, mode);
  let last: CompositeLayout | null = null;
  for (const [i, c] of prof.canvas.entries()) {
    last = layoutOnCanvas(c.W, c.H, i, segs, marks, items, dir, mode);
    // A larger canvas cannot help an empty pack or too many pages.
    if (last.ok || last.reason === "empty" || last.reason === "too-many-pages") return last;
  }
  if (last === null) throw new RangeError("composite: the profile lists no canvas size");
  return last;
}
