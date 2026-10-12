// Erase patch for one translation unit, without inpainting. PURE and deterministic: typed arrays sized to the working
// window, no allocation per pixel, no randomness, fixed iteration order.
//
// computeErase() decides how a unit's original lettering is hidden:
// - "mask": a straight-alpha RGBA patch (the background model painted over the dilated glyph mask, plus a 1-px
//   feather at alpha 128). The engine encodes it as PNG; the content script draws it at `rect`.
// - "box": a translucent rounded plate (rgba(bg, 0.88) + backdrop blur) over `rect`, whenever a clean erase cannot
//   be guaranteed: screentone, art, ink running out of the erasable area, transparent pixels.
// - "none": nothing in the text box differs from the background; only the translation is drawn.
//
// Steps (boxes in natural px of the source image; `pixels` is a crop of it at `origin`, see eraseReadBox):
//  1. R = text box + pad, pad = max(4, round(6 % of its short side)). Erasable cells: the bubble box inset by 3 % per
//     side (the whole image for free text), minus the other units' text boxes. Any alpha < 250 → plate.
//  2. Background samples on a stride grid (≤ 4096; rows shifted by golden-ratio fractions of the stride so that a
//     periodic screentone cannot alias with it) in the band outside R: up to max(20, glyphPx) px out and inside the
//     bubble's inscribed ellipse scaled by 0.92, or a 10-px ring for free text. When less than 40 % of the ring
//     around R lies inside that ellipse (text filling a rect-like caption or chat box), samples and the ring of
//     steps 3-4 are taken inside the erasable rectangle instead.
//  3. bg = mode of a 15-bit colour histogram, refined to the per-channel median of the samples within ±1 bin of the
//     peak. Constant model: coverage (share of samples within 24) ≥ 0.80 and MAD ≤ 8. Plane model: per-channel least
//     squares on the samples within 48 of bg, refitted once without residuals > 3 × their median; median residual
//     ≤ 10 and coverage ≥ 0.73. When both pass, the lower median error on the 10-px ring around R wins (ties: the
//     constant). Neither passes → plate.
//  4. Flatness guard: ≥ 90 % of that ring within 24 of the model and a median ring error ≤ 6; screentone,
//     noise-like art and textured grounds fail it (a smooth patch there would show as a smudge). A ring of fewer
//     than minSamples pixels cannot be checked → plate.
//  5. d = max-channel distance to the model. Otsu on d over R gives t* and eta = σB²/σT²; t = clamp(t*, 28, 110).
//     Ink is d > t, so dark, light, coloured and outlined lettering all count. Components are 8-connected over the
//     window W = R grown by 4 + r + feather px, on the weak mask d > max(24, t/2) after a 3×3 closing (hysteresis: a
//     balloon outline that JPEG chroma subsampling weakened below t stays in one piece).
//  6. A component that touches W's cut border (bubble inset, other units, W's edge inside the image) continues
//     outside the erasable area and is never erased: this keeps balloon outlines, panel borders and art intact. If
//     it holds ink inside R it is lost ink, unless it looks like a balloon outline (≥ 50 % of its pixels on the
//     bubble rim ρ ≥ 0.94, a thin arc, a sparse long shape or a straight line), in which case only its ink inside
//     the text box counts. A component that is not cut but lies on the rim with no ink in the text box is a piece of
//     a broken outline and is kept. A kept component with no ink in the text box that lies mostly inside R could as
//     well be a glyph fragment the text box missed (the ends of caption lines are all "rim") → plate. The unit's own
//     ink in the text box beyond the erasable area (bubble inset) is lost ink too. The unit's own text box is never
//     cut by another unit's box. Any lost ink grows R by pad once (the pass that loses less ink is kept); then more
//     than 5 % of the ink or more than 0.01 × glyphPx² pixels (visible residue) → plate.
//  7. More than 6 components without ink in R per 1000 erasable pixels of W outside R (sparse screentone, grain,
//     stipple: the ring tests pass when only ~10 % of the ground is dots) → plate. Ink inside R < 0.3 % of R and
//     at most a leftover's worth of lost ink → none; > 45 % or eta < 0.55 → plate.
//  8. Patch: every other component, grown by 1 px, is protected. Erased components dilated by
//     r = clamp(round(0.1 × glyphPx), 2, 5) px get alpha 255, a 1-px ring around them 128; colour = the model.
//  9. Text colour = per-channel median of the eroded ink, or black/white when its WCAG contrast with bg is < 4.5.
//
// eraseUse() is the render policy: never erase or cover without a valid translation; SFX get a label unless
// "erase SFX" is on and the patch is a clean mask.

import { area, height, inflate, union, width } from "../geometry.ts";
import type { ImageDataLike } from "../gfx.ts";
import type { Box, LineType, RGB, Size, UnitStatus } from "../types.ts";
import { otsuThreshold } from "./glyph.ts";

export interface EraseParams {
  /** R = text box grown by max(padPx, round(padFrac × short side of the text box)). */
  padPx: number;
  padFrac: number;
  /** Ring outside R: free-text samples, model choice and the flatness guard. */
  ringPx: number;
  /** Bubble samples reach max(sampleReachPx, glyphPx) px beyond R ... */
  sampleReachPx: number;
  /** ... inside the bubble's inscribed ellipse scaled by this. */
  sampleEllipse: number;
  /**
   * Rect-like bubble (caption, chat box): less than this share of the ring around R lies inside the sample ellipse,
   * so samples and the flatness ring use the erasable rectangle instead.
   */
  ringShareMin: number;
  /** Erasable area: the bubble box inset by this fraction of its width / height on each side. */
  bubbleInset: number;
  maxSamples: number;
  /** Fewer background samples → plate. */
  minSamples: number;
  /** A pixel matches the background when its largest channel difference to the model is ≤ inlierTol. */
  inlierTol: number;
  constCoverage: number;
  constMad: number;
  /** Plane fit uses the samples within planeTol of bg. */
  planeTol: number;
  planeResid: number;
  planeCoverage: number;
  /** Flatness guard: share of ring pixels that must match the chosen model ... */
  ringCoverage: number;
  /** ... and the largest median ring error (a smooth patch on a textured ground shows as a smudge). */
  ringMedianMax: number;
  /**
   * Sparse texture (light screentone, grain, stipple) escapes both ring tests; it shows up as many small components
   * without ink in R. More than this many per 1000 erasable pixels of the window frame around R → plate.
   */
  speckleMax: number;
  otsuMin: number;
  otsuMax: number;
  /**
   * Hysteresis: components connect through pixels with d > max(inlierTol, round(weakFrac × t)), so a balloon outline
   * that JPEG chroma subsampling weakened below t in places stays one (cut) component; ink is counted at d > t.
   */
  weakFrac: number;
  etaMin: number;
  maskFracMin: number;
  maskFracMax: number;
  /** R grows by pad once when the lost ink is above this ... */
  regrowLostInk: number;
  /** ... and the result is a plate when it is still above this ... */
  lostInkMax: number;
  /**
   * ... or when more than lostInkGlyph × glyphPx² ink pixels would stay visible. Lost ink is never erased, so this is
   * the residue a mask may leave: 0.01 × glyphPx² is ~5 px at 22 px glyphs, the scale of the residual measured on
   * test pages (≤ 0.3 %; a unit has ~1000-3000 ink px); 0.05 let a whole period (~15-20 px) stay under the
   * translation.
   */
  lostInkGlyph: number;
  dilateFrac: number;
  dilateMin: number;
  dilateMax: number;
  /** Feather ring width (px) at alpha 128. */
  feather: number;
  /** Thin arc: density < outlineThin and bbox side > outlineSpan × the window side. */
  outlineThin: number;
  outlineSpan: number;
  /** Sparse long shape: density < outlineDensity and long side > max(outlineLongPx, outlineLongFrac × text side). */
  outlineDensity: number;
  outlineLongPx: number;
  outlineLongFrac: number;
  /** Rim: ≥ outlineRimShare of the pixels at normalised bubble-ellipse radius ≥ outlineRimRho. */
  outlineRimRho: number;
  outlineRimShare: number;
  /** Straight line: short side ≤ max(2, outlineLineGlyph × glyphPx) and long side ≥ max(span × window, 2 × glyphPx). */
  outlineLineGlyph: number;
  /** Any alpha below this in the read area → plate. */
  alphaMin: number;
  /** WCAG contrast the text colour needs against bg. */
  minContrast: number;
  /** Plate rect = text box grown by round(plateFrac × glyphPx). */
  plateFrac: number;
}

export const ERASE: Readonly<EraseParams> = Object.freeze({
  padPx: 4,
  padFrac: 0.06,
  ringPx: 10,
  sampleReachPx: 20,
  sampleEllipse: 0.92,
  ringShareMin: 0.4,
  bubbleInset: 0.03,
  maxSamples: 4096,
  minSamples: 48,
  inlierTol: 24,
  constCoverage: 0.8,
  constMad: 8,
  planeTol: 48,
  planeResid: 10,
  planeCoverage: 0.73,
  ringCoverage: 0.9,
  ringMedianMax: 6,
  speckleMax: 6,
  otsuMin: 28,
  otsuMax: 110,
  weakFrac: 0.5,
  etaMin: 0.55,
  maskFracMin: 0.003,
  maskFracMax: 0.45,
  regrowLostInk: 0,
  lostInkMax: 0.05,
  lostInkGlyph: 0.01,
  dilateFrac: 0.1,
  dilateMin: 2,
  dilateMax: 5,
  feather: 1,
  outlineThin: 0.15,
  outlineSpan: 0.6,
  outlineDensity: 0.08,
  outlineLongPx: 24,
  outlineLongFrac: 0.3,
  outlineRimRho: 0.94,
  outlineRimShare: 0.5,
  outlineLineGlyph: 0.3,
  alphaMin: 250,
  minContrast: 4.5,
  plateFrac: 0.15,
});

export interface EraseUnit {
  /** Union of the unit's text boxes (natural px). */
  text: Box;
  /** Bubble box, or null for free text. */
  bubble: Box | null;
  /** Estimated glyph height in px (sizes the dilation and the plate margin). */
  glyphPx: number;
  /**
   * The bubble is known to be elliptical (its outline was found on every side and its corners are not balloon colour,
   * bubble-interior.ts): sampling stays inside the ellipse even when text fills most of it, as tall vertical lines do.
   */
  elliptical?: boolean;
}

export interface EraseInput {
  /** RGBA crop of the source image: getImageData of eraseReadBox (or the whole image). */
  pixels: ImageDataLike;
  /** Natural-px position of the crop's top-left pixel. */
  origin: { readonly x: number; readonly y: number };
  /** Natural size of the whole image. */
  image: Size;
  unit: EraseUnit;
  /** Text boxes of the image's other units: never sampled, never erased. */
  others?: readonly Box[];
}

export type EraseKind = "mask" | "box" | "none";
export type EraseModel = "const" | "plane";
export type PlateReason =
  | "region" // the text box is empty, outside the image, or mostly outside the erasable area
  | "transparent" // alpha < alphaMin in the read area
  | "samples" // too few background samples, or no ring around R to check flatness on
  | "texture" // no background model, a ring around R that is not flat, or speckle (screentone, grain, art)
  | "lost-ink" // ink would stay visible: it continues beyond the erasable area, or a rim piece may be a glyph
  | "mask-frac" // ink covers more than maskFracMax of R
  | "eta"; // Otsu separability below etaMin

/** Diagnostics; -1 marks a value that was not computed because an earlier step decided. */
export interface EraseStats {
  pad: number;
  dilateR: number;
  /** Bubble text: share of the ring around R inside the sample ellipse (-1 for free text). */
  ringShare: number;
  /** Samples and ring taken in the erasable rectangle (rect-like bubble). */
  rectLike: boolean;
  samples: number;
  /** Share of samples matching the chosen model (the constant model when none passed). */
  coverage: number;
  /** Constant model: median |s − bg| of the inliers; plane: median residual. */
  spread: number;
  ringCoverage: number;
  /** Median and 90th percentile of the ring's largest-channel error against the chosen model. */
  ringMedian: number;
  ringP90: number;
  tOtsu: number;
  t: number;
  eta: number;
  /** Ink pixels inside R / erasable pixels of R. */
  frac: number;
  /** Share of the unit's ink that would stay visible, and the same in pixels (inkBeyond included). */
  lostInk: number;
  lostPx: number;
  /** Ink pixels of the text box outside the erasable area (beyond the bubble inset). */
  inkBeyond: number;
  /** Rim pieces mostly inside R with no ink in the text box (outline or missed glyph fragment) → plate. */
  ambiguous: number;
  /** Components without ink in R per 1000 erasable pixels of the window frame around R. */
  speckle: number;
  components: number;
  erased: number;
  outlines: number;
  /** Mask passes run (2 = R was grown by pad after lost ink) and whether the grown pass was kept. */
  rounds: number;
  grown: boolean;
}

export interface EraseMask {
  kind: "mask";
  /** Natural-px placement of `patch` (its tight alpha bounding box). */
  rect: Box;
  /** Background model at the centre of the text box. */
  bg: RGB;
  textColor: RGB;
  model: EraseModel;
  /** Straight-alpha RGBA, rect-sized; transparent pixels are 0,0,0,0. */
  patch: ImageDataLike;
  stats: EraseStats;
}

export interface ErasePlate {
  kind: "box";
  /**
   * Minimum plate area: the text box grown by round(plateFrac × glyphPx), joined with the bounding boxes (+ 1 px) of
   * the ink components found around it when the mask pass ran (ink the text box missed), clipped to the image.
   */
  rect: Box;
  /** Plate tint; null when unknown (white plate). */
  bg: RGB | null;
  textColor: RGB;
  reason: PlateReason;
  stats: EraseStats;
}

export interface EraseNone {
  kind: "none";
  /** The text box. */
  rect: Box;
  bg: RGB;
  textColor: RGB;
  stats: EraseStats;
}

export type EraseResult = EraseMask | ErasePlate | EraseNone;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

function meet(a: Box, b: Box): Box {
  return {
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
  };
}

function isEmpty(b: Box): boolean {
  return !(b.x2 > b.x1 && b.y2 > b.y1);
}

/** Smallest integer box containing b. */
function outerInt(b: Box): Box {
  return { x1: Math.floor(b.x1), y1: Math.floor(b.y1), x2: Math.ceil(b.x2), y2: Math.ceil(b.y2) };
}

/** Largest integer box inside b. */
function innerInt(b: Box): Box {
  return { x1: Math.ceil(b.x1), y1: Math.ceil(b.y1), x2: Math.floor(b.x2), y2: Math.floor(b.y2) };
}

function inBox(b: Box, x: number, y: number): boolean {
  return x >= b.x1 && x < b.x2 && y >= b.y1 && y < b.y2;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Lower median of `n` values counted in a histogram. */
function histMedian(hist: Uint32Array, n: number): number {
  const k = (n - 1) >> 1;
  let seen = 0;
  for (let v = 0; v < hist.length; v++) {
    seen += hist[v] ?? 0;
    if (seen > k) return v;
  }
  return hist.length - 1;
}

/** Residual quantised to an integer histogram bin 0..255. */
function q255(v: number): number {
  return v >= 255 ? 255 : Math.round(v);
}

/** Ellipse inscribed in a box and scaled by `scale`: inside when ((x−cx)·irx)² + ((y−cy)·iry)² ≤ 1. */
interface Ellipse {
  cx: number;
  cy: number;
  irx: number;
  iry: number;
}

function ellipseOf(b: Box, scale: number): Ellipse {
  return {
    cx: (b.x1 + b.x2) / 2,
    cy: (b.y1 + b.y2) / 2,
    irx: 2 / Math.max(1e-9, scale * width(b)),
    iry: 2 / Math.max(1e-9, scale * height(b)),
  };
}

/** Squared normalised radius of the centre of pixel (x, y). */
function rho2(e: Ellipse, x: number, y: number): number {
  const dx = (x + 0.5 - e.cx) * e.irx;
  const dy = (y + 0.5 - e.cy) * e.iry;
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------------------------------------------
// Colour contrast (WCAG 2.x)

function channelLinear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(c: RGB): number {
  return 0.2126 * channelLinear(c[0]) + 0.7152 * channelLinear(c[1]) + 0.0722 * channelLinear(c[2]);
}

/** WCAG contrast ratio, 1 (same) to 21 (black on white). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever contrasts more with `bg` (black on ties). */
export function readableOn(bg: RGB): RGB {
  return contrastRatio(BLACK, bg) >= contrastRatio(WHITE, bg) ? BLACK : WHITE;
}

function textColorFor(ink: RGB | null, bg: RGB, minContrast: number): RGB {
  return ink !== null && contrastRatio(ink, bg) >= minContrast ? ink : readableOn(bg);
}

// ---------------------------------------------------------------------------------------------------------------
// Pixel access and background samples

interface Pixels {
  data: Uint8ClampedArray;
  /** Crop width (row stride in pixels). */
  w: number;
  ox: number;
  oy: number;
}

/** Byte offset of natural pixel (x, y) in the crop. */
function at(px: Pixels, x: number, y: number): number {
  return ((y - px.oy) * px.w + (x - px.ox)) * 4;
}

interface Samples {
  n: number;
  x: Int32Array;
  y: Int32Array;
  /** Interleaved RGB. */
  rgb: Uint8Array;
}

/** Stride-grid samples of `outer` minus `inner`, inside `ellipse` (if any), outside every `excl` box. */
function collectSamples(
  px: Pixels,
  outer: Box,
  inner: Box,
  ellipse: Ellipse | null,
  excl: readonly Box[],
  max: number,
): Samples {
  const accept = (x: number, y: number): boolean => {
    if (inBox(inner, x, y)) return false;
    if (ellipse !== null && rho2(ellipse, x, y) > 1) return false;
    for (const b of excl) if (inBox(b, x, y)) return false;
    return true;
  };
  const w = width(outer);
  const h = height(outer);
  const empty: Samples = { n: 0, x: new Int32Array(0), y: new Int32Array(0), rgb: new Uint8Array(0) };
  if (w <= 0 || h <= 0 || max <= 0) return empty;
  // Rows are shifted by a golden-ratio fraction of the stride, so a periodic texture (screentone) cannot alias
  // with the grid and hide from the samples.
  const grid = (s: number, visit: (x: number, y: number) => void): void => {
    let row = 0;
    for (let y = outer.y1 + (s >> 1); y < outer.y2; y += s, row++) {
      const shift = ((s >> 1) + Math.floor(row * s * 0.6180339887)) % s;
      for (let x = outer.x1 + shift; x < outer.x2; x += s) if (accept(x, y)) visit(x, y);
    }
  };
  let stride = Math.max(1, Math.floor(Math.sqrt((w * h) / max)));
  let count = 0;
  for (;;) {
    count = 0;
    grid(stride, () => count++);
    if (count <= max) break;
    stride++;
  }
  if (count === 0) return empty;
  const out: Samples = {
    n: 0,
    x: new Int32Array(count),
    y: new Int32Array(count),
    rgb: new Uint8Array(count * 3),
  };
  grid(stride, (x, y) => {
    const k = at(px, x, y);
    const i = out.n++;
    out.x[i] = x;
    out.y[i] = y;
    out.rgb[i * 3] = px.data[k] ?? 0;
    out.rgb[i * 3 + 1] = px.data[k + 1] ?? 0;
    out.rgb[i * 3 + 2] = px.data[k + 2] ?? 0;
  });
  return out;
}

/** Mode of the 15-bit colour histogram, refined to the per-channel median of the samples within ±1 bin. */
function histogramMode(s: Samples): RGB {
  const hist = new Uint32Array(32768);
  for (let i = 0; i < s.n; i++) {
    const r = s.rgb[i * 3] ?? 0;
    const g = s.rgb[i * 3 + 1] ?? 0;
    const b = s.rgb[i * 3 + 2] ?? 0;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    hist[key] = (hist[key] ?? 0) + 1;
  }
  let best = 0;
  let bestKey = 0;
  for (let k = 0; k < hist.length; k++) {
    const c = hist[k] ?? 0;
    if (c > best) {
      best = c;
      bestKey = k;
    }
  }
  const pr = bestKey >> 10;
  const pg = (bestKey >> 5) & 31;
  const pb = bestKey & 31;
  const hr = new Uint32Array(256);
  const hg = new Uint32Array(256);
  const hb = new Uint32Array(256);
  let m = 0;
  for (let i = 0; i < s.n; i++) {
    const r = s.rgb[i * 3] ?? 0;
    const g = s.rgb[i * 3 + 1] ?? 0;
    const b = s.rgb[i * 3 + 2] ?? 0;
    if (Math.abs((r >> 3) - pr) > 1 || Math.abs((g >> 3) - pg) > 1 || Math.abs((b >> 3) - pb) > 1) continue;
    hr[r] = (hr[r] ?? 0) + 1;
    hg[g] = (hg[g] ?? 0) + 1;
    hb[b] = (hb[b] ?? 0) + 1;
    m++;
  }
  return [histMedian(hr, m), histMedian(hg, m), histMedian(hb, m)];
}

// ---------------------------------------------------------------------------------------------------------------
// Background models

/**
 * Per channel c: value = coef[c] + coef[3 + c]·nx + coef[6 + c]·ny with nx = (x + 0.5 − cx)·ihx and
 * ny = (y + 0.5 − cy)·ihy (natural px). The constant model has zero slopes.
 */
interface Model {
  kind: EraseModel;
  coef: Float64Array;
  cx: number;
  cy: number;
  ihx: number;
  ihy: number;
}

interface ModelFit {
  model: Model;
  coverage: number;
  spread: number;
  ok: boolean;
}

function constModel(bg: RGB): Model {
  return {
    kind: "const",
    coef: Float64Array.of(bg[0], bg[1], bg[2], 0, 0, 0, 0, 0, 0),
    cx: 0,
    cy: 0,
    ihx: 0,
    ihy: 0,
  };
}

function modelChannel(m: Model, c: number, x: number, y: number): number {
  const nx = (x + 0.5 - m.cx) * m.ihx;
  const ny = (y + 0.5 - m.cy) * m.ihy;
  return (m.coef[c] ?? 0) + (m.coef[3 + c] ?? 0) * nx + (m.coef[6 + c] ?? 0) * ny;
}

function modelRgb(m: Model, x: number, y: number): RGB {
  const v = (c: number): number => clamp(Math.round(modelChannel(m, c, x, y)), 0, 255);
  return [v(0), v(1), v(2)];
}

/** Largest channel difference between sample i and the model. */
function sampleResidual(s: Samples, i: number, m: Model): number {
  const x = s.x[i] ?? 0;
  const y = s.y[i] ?? 0;
  let worst = 0;
  for (let c = 0; c < 3; c++) {
    const d = Math.abs((s.rgb[i * 3 + c] ?? 0) - modelChannel(m, c, x, y));
    if (d > worst) worst = d;
  }
  return worst;
}

function evalConst(s: Samples, bg: RGB, p: EraseParams): ModelFit {
  const model = constModel(bg);
  const hist = new Uint32Array(256);
  let inliers = 0;
  for (let i = 0; i < s.n; i++) {
    const res = q255(sampleResidual(s, i, model));
    if (res <= p.inlierTol) {
      inliers++;
      hist[res] = (hist[res] ?? 0) + 1;
    }
  }
  const coverage = s.n > 0 ? inliers / s.n : 0;
  const spread = inliers > 0 ? histMedian(hist, inliers) : 255;
  return { model, coverage, spread, ok: coverage >= p.constCoverage && spread <= p.constMad };
}

/** Least-squares plane per channel on the selected samples; null when the samples are (nearly) collinear. */
function solvePlane(s: Samples, sel: Uint8Array, frame: Omit<Model, "kind" | "coef">): Float64Array | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  const sv = new Float64Array(3);
  const sxv = new Float64Array(3);
  const syv = new Float64Array(3);
  for (let i = 0; i < s.n; i++) {
    if (sel[i] !== 1) continue;
    const nx = ((s.x[i] ?? 0) + 0.5 - frame.cx) * frame.ihx;
    const ny = ((s.y[i] ?? 0) + 0.5 - frame.cy) * frame.ihy;
    n++;
    sx += nx;
    sy += ny;
    sxx += nx * nx;
    sxy += nx * ny;
    syy += ny * ny;
    for (let c = 0; c < 3; c++) {
      const v = s.rgb[i * 3 + c] ?? 0;
      sv[c] = (sv[c] ?? 0) + v;
      sxv[c] = (sxv[c] ?? 0) + v * nx;
      syv[c] = (syv[c] ?? 0) + v * ny;
    }
  }
  if (n < 3) return null;
  // Cramer's rule on [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]].
  const det = n * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
  if (!(Math.abs(det) > 1e-6 * n * n * n)) return null;
  const coef = new Float64Array(9);
  for (let c = 0; c < 3; c++) {
    const v = sv[c] ?? 0;
    const xv = sxv[c] ?? 0;
    const yv = syv[c] ?? 0;
    coef[c] = (v * (sxx * syy - sxy * sxy) - sx * (xv * syy - sxy * yv) + sy * (xv * sxy - sxx * yv)) / det;
    coef[3 + c] = (n * (xv * syy - sxy * yv) - v * (sx * syy - sxy * sy) + sy * (sx * yv - xv * sy)) / det;
    coef[6 + c] = (n * (sxx * yv - xv * sxy) - sx * (sx * yv - xv * sy) + v * (sx * sxy - sxx * sy)) / det;
  }
  return coef;
}

function medianResidual(s: Samples, sel: Uint8Array, m: Model): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < s.n; i++) {
    if (sel[i] !== 1) continue;
    const q = q255(sampleResidual(s, i, m));
    hist[q] = (hist[q] ?? 0) + 1;
    n++;
  }
  return n > 0 ? histMedian(hist, n) : 255;
}

function fitPlane(s: Samples, bg: RGB, p: EraseParams): ModelFit | null {
  if (s.n < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < s.n; i++) {
    const x = s.x[i] ?? 0;
    const y = s.y[i] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const frame = {
    cx: (minX + maxX + 1) / 2,
    cy: (minY + maxY + 1) / 2,
    ihx: 2 / Math.max(1, maxX + 1 - minX),
    ihy: 2 / Math.max(1, maxY + 1 - minY),
  };
  const flat = constModel(bg);
  const sel = new Uint8Array(s.n);
  let selected = 0;
  for (let i = 0; i < s.n; i++) {
    if (sampleResidual(s, i, flat) <= p.planeTol) {
      sel[i] = 1;
      selected++;
    }
  }
  if (selected < Math.max(3, p.minSamples >> 1)) return null;
  const first = solvePlane(s, sel, frame);
  if (first === null) return null;
  let model: Model = { kind: "plane", coef: first, ...frame };
  // One refit without the outliers of the first fit (> 3 × median residual, at least 3 levels).
  const cut = Math.max(3 * medianResidual(s, sel, model), 3);
  for (let i = 0; i < s.n; i++) if (sel[i] === 1 && sampleResidual(s, i, model) > cut) sel[i] = 0;
  const second = solvePlane(s, sel, frame);
  if (second !== null) model = { kind: "plane", coef: second, ...frame };
  const spread = medianResidual(s, sel, model);
  let inliers = 0;
  for (let i = 0; i < s.n; i++) if (sampleResidual(s, i, model) <= p.inlierTol) inliers++;
  const coverage = inliers / s.n;
  return { model, coverage, spread, ok: spread <= p.planeResid && coverage >= p.planeCoverage };
}

interface RingStats {
  n: number;
  /** Per model: median largest-channel error over the ring. */
  median: number[];
  /** Per model: 90th percentile of the largest-channel error over the ring. */
  p90: number[];
  /** Per model: share of ring pixels within inlierTol. */
  coverage: number[];
}

/** Nearest-rank quantile of `n` values counted in a histogram. */
function histQuantile(hist: Uint32Array, n: number, q: number): number {
  const k = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
  let seen = 0;
  for (let v = 0; v < hist.length; v++) {
    seen += hist[v] ?? 0;
    if (seen > k) return v;
  }
  return hist.length - 1;
}

/** Dense statistics of `outer` minus `inner` (inside `ellipse`, outside `excl`) against each model. */
function ringStats(
  px: Pixels,
  outer: Box,
  inner: Box,
  ellipse: Ellipse | null,
  excl: readonly Box[],
  models: readonly Model[],
  tol: number,
): RingStats {
  const hists = models.map(() => new Uint32Array(256));
  const within = models.map(() => 0);
  let n = 0;
  for (let y = outer.y1; y < outer.y2; y++) {
    for (let x = outer.x1; x < outer.x2; x++) {
      if (inBox(inner, x, y)) {
        x = inner.x2 - 1;
        continue;
      }
      if (ellipse !== null && rho2(ellipse, x, y) > 1) continue;
      let excluded = false;
      for (const b of excl) if (inBox(b, x, y)) excluded = true;
      if (excluded) continue;
      const k = at(px, x, y);
      n++;
      for (let mi = 0; mi < models.length; mi++) {
        const m = models[mi];
        const hist = hists[mi];
        if (m === undefined || hist === undefined) continue;
        let worst = 0;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs((px.data[k + c] ?? 0) - modelChannel(m, c, x, y));
          if (d > worst) worst = d;
        }
        const q = q255(worst);
        hist[q] = (hist[q] ?? 0) + 1;
        if (q <= tol) within[mi] = (within[mi] ?? 0) + 1;
      }
    }
  }
  return {
    n,
    median: hists.map((h) => (n > 0 ? histMedian(h, n) : 255)),
    p90: hists.map((h) => (n > 0 ? histQuantile(h, n, 0.9) : 255)),
    coverage: within.map((w) => (n > 0 ? w / n : 0)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Binary morphology on padded grids (1 = set)

/** 3×3 dilation by neighbour ORs (the radius-1 case of dilateSquare; src and dst may be the same array). */
function dilate3(src: Uint8Array, dst: Uint8Array, w: number, h: number, tmp: Uint8Array): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let prev = 0;
    let cur = src[row] ?? 0;
    for (let x = 0; x < w; x++) {
      const next = x + 1 < w ? (src[row + x + 1] ?? 0) : 0;
      tmp[row + x] = prev | cur | next;
      prev = cur;
      cur = next;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? row - w : row;
    const down = y + 1 < h ? row + w : row;
    for (let x = 0; x < w; x++)
      dst[row + x] = (tmp[up + x] ?? 0) | (tmp[row + x] ?? 0) | (tmp[down + x] ?? 0);
  }
}

/** Scratch buffers for the morphology of one window. */
interface Scratch {
  tmp: Uint8Array;
  /** Per-column running counts (length ≥ grid width). */
  col: Int32Array;
}

/**
 * Dilation with a (2r+1)² square (src and dst may be the same array). Separable running counts: rows first, then
 * a row-major sweep with per-column counts (no strided access). Cells beyond the grid count as unset.
 */
function dilateSquare(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number, s: Scratch): void {
  if (r <= 0) {
    if (dst !== src) dst.set(src);
    return;
  }
  if (r === 1) {
    dilate3(src, dst, w, h, s.tmp);
    return;
  }
  const { tmp, col } = s;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x < r && x < w; x++) count += src[row + x] ?? 0;
    for (let x = 0; x < w; x++) {
      if (x + r < w) count += src[row + x + r] ?? 0;
      tmp[row + x] = count > 0 ? 1 : 0;
      if (x - r >= 0) count -= src[row + x - r] ?? 0;
    }
  }
  col.fill(0, 0, w);
  for (let y = 0; y < r && y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) col[x] = (col[x] ?? 0) + (tmp[row + x] ?? 0);
  }
  for (let y = 0; y < h; y++) {
    if (y + r < h) {
      const add = (y + r) * w;
      for (let x = 0; x < w; x++) col[x] = (col[x] ?? 0) + (tmp[add + x] ?? 0);
    }
    const row = y * w;
    for (let x = 0; x < w; x++) dst[row + x] = (col[x] ?? 0) > 0 ? 1 : 0;
    if (y - r >= 0) {
      const sub = (y - r) * w;
      for (let x = 0; x < w; x++) col[x] = (col[x] ?? 0) - (tmp[sub + x] ?? 0);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Mask pass

/** Cell status on the padded window grid; 0 (the initial value) = outside the image, where ink cannot continue. */
const CUT = 1; // inside the image but not erasable (bubble inset, other units, beyond the window)
const ERASABLE = 2;

type CompRole = "erase" | "lost" | "outline" | "ambiguous" | "outside";

interface Comp {
  /** Pixels of the (weak, closed) component. */
  area: number;
  /** Bounding box on the padded grid (x1/y1 exclusive). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cut: boolean;
  /** Pixels (weak or ink) inside R. */
  inR: number;
  /** Ink pixels (d > t). */
  strong: number;
  /** Ink pixels inside R. */
  core: number;
  /** Ink pixels inside the text box. */
  inText: number;
  /** ... of which on the bubble rim: an outline crossing the corners of a box that fills an elliptical balloon. */
  inTextRim: number;
  /** Pixels on the bubble rim. */
  rim: number;
  role: CompRole;
}

interface Ctx {
  p: EraseParams;
  px: Pixels;
  image: Size;
  text: Box;
  glyphPx: number;
  erasable: Box;
  others: readonly Box[];
  rim: Ellipse | null;
  model: Model;
}

interface Pass {
  core: Box;
  win: Box;
  pw: number;
  ph: number;
  st: Uint8Array;
  /** Component id + 1 per cell of the closed mask, 0 elsewhere. */
  lab: Int32Array;
  comps: Comp[];
  /** Erasable pixels of R. */
  coreArea: number;
  tOtsu: number;
  t: number;
  eta: number;
  /** Ink pixels (erased + lost components) inside R. */
  inkCore: number;
  /** Components with no ink in R per 1000 erasable pixels of W outside R (screentone dots, sparkles, grain). */
  speckle: number;
  /** Ink pixels of erased components. */
  erasedInk: number;
  /**
   * Ink pixels that stay visible: lost and ambiguous components, the ink of outline-like ones inside the text box,
   * and inkBeyond.
   */
  lostInk: number;
  /** Ink pixels of the text box outside the erasable area (bubble inset), other units' boxes excepted. */
  inkBeyond: number;
  /** Rim pieces mostly inside R with no ink in the text box: outline or glyph fragment cannot be told apart. */
  ambiguous: number;
}

/** Between-class over total variance of the histogram split at t (values ≤ t form the first class). */
function separability(hist: Float64Array, t: number): number {
  let n = 0;
  let s = 0;
  let s2 = 0;
  let n0 = 0;
  let s0 = 0;
  for (let v = 0; v < 256; v++) {
    const c = hist[v] ?? 0;
    n += c;
    s += v * c;
    s2 += v * v * c;
    if (v <= t) {
      n0 += c;
      s0 += v * c;
    }
  }
  if (n === 0) return 0;
  const mu = s / n;
  const total = s2 / n - mu * mu;
  const n1 = n - n0;
  if (!(total > 1e-9) || n0 === 0 || n1 === 0) return 0;
  const diff = s0 / n0 - (s - s0) / n1;
  return ((n0 / n) * (n1 / n) * diff * diff) / total;
}

function onRim(c: Comp, ctx: Ctx): boolean {
  return ctx.rim !== null && c.rim >= ctx.p.outlineRimShare * c.area;
}

function isOutlineLike(c: Comp, ctx: Ctx, ww: number, wh: number): boolean {
  const { p } = ctx;
  if (onRim(c, ctx)) return true;
  const bw = c.x1 - c.x0;
  const bh = c.y1 - c.y0;
  const density = c.area / (bw * bh);
  const long = Math.max(bw, bh);
  const short = Math.min(bw, bh);
  if (density < p.outlineThin && (bw > p.outlineSpan * ww || bh > p.outlineSpan * wh)) return true;
  const textSide = Math.max(width(ctx.text), height(ctx.text));
  if (density < p.outlineDensity && long > Math.max(p.outlineLongPx, p.outlineLongFrac * textSide))
    return true;
  const span = p.outlineSpan * (bw >= bh ? ww : wh);
  return short <= Math.max(2, p.outlineLineGlyph * ctx.glyphPx) && long >= Math.max(span, 2 * ctx.glyphPx);
}

function runPass(ctx: Ctx, core: Box, win: Box): Pass {
  const { p, px, model } = ctx;
  const data = px.data;
  const ww = width(win);
  const wh = height(win);
  const pw = ww + 2;
  const ph = wh + 2;
  const n = pw * ph;
  const gx = win.x1 - 1; // natural x of padded column 0
  const gy = win.y1 - 1;

  // Cell status: 0 beyond the image, ERASABLE inside the erasable box (interior cells only), CUT elsewhere.
  const st = new Uint8Array(n);
  const ix0 = Math.max(0, -gx);
  const ix1 = Math.min(pw, ctx.image.w - gx);
  const ex0 = Math.max(1, ctx.erasable.x1 - gx);
  const ex1 = Math.min(pw - 1, ctx.erasable.x2 - gx);
  const ey0 = Math.max(1, ctx.erasable.y1 - gy);
  const ey1 = Math.min(ph - 1, ctx.erasable.y2 - gy);
  for (let j = Math.max(0, -gy); j < Math.min(ph, ctx.image.h - gy); j++) {
    const row = j * pw;
    if (ix1 > ix0) st.fill(CUT, row + ix0, row + ix1);
    if (j >= ey0 && j < ey1 && ex1 > ex0) st.fill(ERASABLE, row + ex0, row + ex1);
  }
  for (const o of ctx.others) {
    const b = meet(o, win);
    if (isEmpty(b)) continue;
    for (let y = b.y1; y < b.y2; y++) st.fill(CUT, (y - gy) * pw + (b.x1 - gx), (y - gy) * pw + (b.x2 - gx));
  }
  // The unit's own text box stays erasable where another unit's box overlaps it (duplicate or overlapping
  // detections); otherwise the ink there would be erased by neither unit and counted by none.
  const own = meet(meet(ctx.text, ctx.erasable), win);
  if (ctx.others.length > 0 && !isEmpty(own)) {
    for (let y = own.y1; y < own.y2; y++) {
      st.fill(ERASABLE, (y - gy) * pw + (own.x1 - gx), (y - gy) * pw + (own.x2 - gx));
    }
  }

  // Distance to the background model.
  const d = new Uint8Array(n);
  const coef = model.coef;
  const [c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0, c7 = 0, c8 = 0] = coef;
  let erasableArea = 0;
  for (let j = 1; j < ph - 1; j++) {
    const y = gy + j;
    const ny = (y + 0.5 - model.cy) * model.ihy;
    const r0 = c0 + c6 * ny;
    const g0 = c1 + c7 * ny;
    const b0 = c2 + c8 * ny;
    let s = ((y - px.oy) * px.w + (gx + 1 - px.ox)) * 4;
    for (let i = 1, k = j * pw + 1; i < pw - 1; i++, k++, s += 4) {
      if (st[k] !== ERASABLE) continue;
      erasableArea++;
      const nx = (gx + i + 0.5 - model.cx) * model.ihx;
      const dr = Math.abs((data[s] ?? 0) - (r0 + c3 * nx));
      const dg = Math.abs((data[s + 1] ?? 0) - (g0 + c4 * nx));
      const db = Math.abs((data[s + 2] ?? 0) - (b0 + c5 * nx));
      d[k] = q255(dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db);
    }
  }

  // Otsu over R.
  const ci0 = core.x1 - gx;
  const ci1 = core.x2 - gx;
  const cj0 = core.y1 - gy;
  const cj1 = core.y2 - gy;
  const hist = new Float64Array(256);
  let coreArea = 0;
  for (let j = cj0; j < cj1; j++) {
    for (let k = j * pw + ci0; k < j * pw + ci1; k++) {
      if (st[k] !== ERASABLE) continue;
      const v = d[k] ?? 0;
      hist[v] = (hist[v] ?? 0) + 1;
      coreArea++;
    }
  }
  const tOtsu = coreArea > 0 ? otsuThreshold(hist) : 255;
  const eta = separability(hist, tOtsu);
  const t = clamp(tOtsu, p.otsuMin, p.otsuMax);
  const tWeak = Math.min(t, Math.max(p.inlierTol, Math.round(p.weakFrac * t)));

  // The unit's ink beyond the erasable area (text-box cells outside the bubble inset; other units' boxes are
  // theirs) can be neither erased nor protected: it stays visible, so it is lost ink (the ink that a flat fill of the
  // balloon interior would miss).
  let inkBeyond = 0;
  const tb = meet(ctx.text, win);
  for (let y = tb.y1; y < tb.y2; y++) {
    const ny = (y + 0.5 - model.cy) * model.ihy;
    const r0 = c0 + c6 * ny;
    const g0 = c1 + c7 * ny;
    const b0 = c2 + c8 * ny;
    for (let x = tb.x1, k = (y - gy) * pw + (tb.x1 - gx); x < tb.x2; x++, k++) {
      if (st[k] !== CUT) continue;
      let theirs = false;
      for (const o of ctx.others) if (inBox(o, x, y)) theirs = true;
      if (theirs) continue;
      const s = at(px, x, y);
      const nx = (x + 0.5 - model.cx) * model.ihx;
      const dr = Math.abs((data[s] ?? 0) - (r0 + c3 * nx));
      const dg = Math.abs((data[s + 1] ?? 0) - (g0 + c4 * nx));
      const db = Math.abs((data[s + 2] ?? 0) - (b0 + c5 * nx));
      if (q255(dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db) > t) inkBeyond++;
    }
  }

  // Weak mask d > tWeak (connectivity), then a 3×3 closing (cells that are not erasable count as set for the
  // erosion). Ink is d > t.
  const m = new Uint8Array(n);
  for (let k = 0; k < n; k++) m[k] = st[k] === ERASABLE && (d[k] ?? 0) > tWeak ? 1 : 0;
  const scratch: Scratch = { tmp: new Uint8Array(n), col: new Int32Array(pw) };
  dilateSquare(m, m, pw, ph, 1, scratch);
  for (let k = 0; k < n; k++) m[k] = st[k] === ERASABLE && m[k] === 0 ? 1 : 0; // complement inside the erasable cells
  dilateSquare(m, m, pw, ph, 1, scratch);
  for (let k = 0; k < n; k++) m[k] = st[k] === ERASABLE && m[k] === 0 ? 1 : 0;

  // 8-connected components.
  const lab = new Int32Array(n);
  const stack = new Int32Array(n);
  const off = [-pw - 1, -pw, -pw + 1, -1, 1, pw - 1, pw, pw + 1];
  const ti0 = ctx.text.x1 - gx;
  const ti1 = ctx.text.x2 - gx;
  const tj0 = ctx.text.y1 - gy;
  const tj1 = ctx.text.y2 - gy;
  const rimRho2 = p.outlineRimRho * p.outlineRimRho;
  // Squared normalised rim distance, split per column and row: rho² = rimX[i] + rimY[j].
  const rimX = new Float64Array(pw);
  const rimY = new Float64Array(ph);
  const rim = ctx.rim;
  if (rim !== null) {
    for (let i = 0; i < pw; i++) rimX[i] = ((gx + i + 0.5 - rim.cx) * rim.irx) ** 2;
    for (let j = 0; j < ph; j++) rimY[j] = ((gy + j + 0.5 - rim.cy) * rim.iry) ** 2;
  }
  const comps: Comp[] = [];
  for (let j = 1; j < ph - 1; j++) {
    for (let start = j * pw + 1; start < j * pw + pw - 1; start++) {
      if (m[start] !== 1 || lab[start] !== 0) continue;
      const id = comps.length + 1;
      const c: Comp = {
        area: 0,
        x0: pw,
        y0: ph,
        x1: 0,
        y1: 0,
        cut: false,
        inR: 0,
        strong: 0,
        core: 0,
        inText: 0,
        inTextRim: 0,
        rim: 0,
        role: "outside",
      };
      let sp = 0;
      stack[sp++] = start;
      lab[start] = id;
      while (sp > 0) {
        const k = stack[--sp] ?? 0;
        const ci = k % pw;
        const cj = (k - ci) / pw;
        c.area++;
        if (ci < c.x0) c.x0 = ci;
        if (ci >= c.x1) c.x1 = ci + 1;
        if (cj < c.y0) c.y0 = cj;
        if (cj >= c.y1) c.y1 = cj + 1;
        const inCore = ci >= ci0 && ci < ci1 && cj >= cj0 && cj < cj1;
        if (inCore) c.inR++;
        if ((d[k] ?? 0) > t) {
          c.strong++;
          if (inCore) c.core++;
          if (ci >= ti0 && ci < ti1 && cj >= tj0 && cj < tj1) {
            c.inText++;
            if (rim !== null && (rimX[ci] ?? 0) + (rimY[cj] ?? 0) >= rimRho2) c.inTextRim++;
          }
        }
        if (rim !== null && (rimX[ci] ?? 0) + (rimY[cj] ?? 0) >= rimRho2) c.rim++;
        for (let o = 0; o < 8; o++) {
          const q = k + (off[o] ?? 0);
          if (st[q] === CUT) c.cut = true;
          else if (m[q] === 1 && lab[q] === 0) {
            lab[q] = id;
            stack[sp++] = q;
          }
        }
      }
      comps.push(c);
    }
  }

  // Roles and ink accounting (ink = d > t pixels).
  let inkCore = 0;
  let erasedInk = 0;
  let lostInk = inkBeyond;
  let outside = 0;
  let ambiguous = 0;
  for (const c of comps) {
    if (c.core === 0) {
      c.role = "outside";
      outside++;
    } else if (c.cut ? isOutlineLike(c, ctx, ww, wh) : c.inText === 0 && onRim(c, ctx)) {
      // Kept as balloon outline: cut and outline-like, or a piece of a broken (dashed, JPEG-weakened) outline on the
      // rim. With no ink in the text box but most of its pixels inside R it may as well be a glyph fragment that a
      // too-tight text box missed (a period at the end of a caption line, where every line end is "rim"): erasing it
      // may cut the outline and keeping it leaves ink behind, so neither is safe.
      c.role = c.inText === 0 && 2 * c.inR > c.area ? "ambiguous" : "outline";
    } else c.role = c.cut ? "lost" : "erase";
    if (c.role === "erase") {
      erasedInk += c.strong;
      inkCore += c.core;
    } else if (c.role === "lost" || c.role === "ambiguous") {
      lostInk += c.strong;
      inkCore += c.core;
      if (c.role === "ambiguous") ambiguous++;
    } else if (c.role === "outline") {
      // Outline ink inside the text box stays visible. On the rim of a real outline (a stroke longer than two glyphs)
      // it is the balloon's own line, not text: long lines fill an elliptical balloon and the box corners cross its
      // outline. A short piece on the rim (a period beside a caption edge) still counts.
      const stroke = Math.max(c.x1 - c.x0, c.y1 - c.y0) >= 2 * ctx.glyphPx;
      const kept = stroke ? c.inText - c.inTextRim : c.inText;
      lostInk += kept;
      inkCore += kept;
    }
  }
  const frameArea = erasableArea - coreArea;
  const speckle = frameArea > 0 ? (1000 * outside) / frameArea : 0;
  return {
    core,
    win,
    pw,
    ph,
    st,
    lab,
    comps,
    coreArea,
    tOtsu,
    t,
    eta,
    inkCore,
    speckle,
    erasedInk,
    lostInk,
    inkBeyond,
    ambiguous,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Patch

interface Patch {
  rect: Box;
  data: Uint8ClampedArray;
  ink: RGB | null;
}

function buildPatch(ctx: Ctx, pass: Pass, r: number): Patch | null {
  const { p, px, model } = ctx;
  const { pw, ph, st, lab, comps } = pass;
  const data = px.data;
  const n = pw * ph;
  const gx = pass.win.x1 - 1;
  const gy = pass.win.y1 - 1;
  const erasedId = new Uint8Array(comps.length + 1);
  for (let i = 0; i < comps.length; i++) if (comps[i]?.role === "erase") erasedId[i + 1] = 1;
  const erase = new Uint8Array(n);
  const keep = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const id = lab[k] ?? 0;
    if (id === 0) continue;
    if (erasedId[id] === 1) erase[k] = 1;
    else keep[k] = 1;
  }
  const scratch: Scratch = { tmp: new Uint8Array(n), col: new Int32Array(pw) };
  dilateSquare(keep, keep, pw, ph, 1, scratch); // protected: other components + 1 px
  const core = new Uint8Array(n);
  dilateSquare(erase, core, pw, ph, r, scratch);
  for (let k = 0; k < n; k++) core[k] = core[k] === 1 && st[k] === ERASABLE && keep[k] === 0 ? 1 : 0;
  const ring = new Uint8Array(n);
  dilateSquare(core, ring, pw, ph, Math.max(0, Math.round(p.feather)), scratch);
  let i0 = pw;
  let j0 = ph;
  let i1 = 0;
  let j1 = 0;
  for (let j = 0; j < ph; j++) {
    for (let i = 0, k = j * pw; i < pw; i++, k++) {
      ring[k] = ring[k] === 1 && core[k] === 0 && st[k] === ERASABLE && keep[k] === 0 ? 1 : 0;
      if (core[k] === 0 && ring[k] === 0) continue;
      if (i < i0) i0 = i;
      if (i >= i1) i1 = i + 1;
      if (j < j0) j0 = j;
      if (j >= j1) j1 = j + 1;
    }
  }
  if (i1 <= i0 || j1 <= j0) return null;

  const rw = i1 - i0;
  const rh = j1 - j0;
  const out = new Uint8ClampedArray(rw * rh * 4);
  const [c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0, c7 = 0, c8 = 0] = model.coef;
  for (let j = j0; j < j1; j++) {
    const ny = (gy + j + 0.5 - model.cy) * model.ihy;
    for (let i = i0, k = j * pw + i0, o = (j - j0) * rw * 4; i < i1; i++, k++, o += 4) {
      const alpha = core[k] === 1 ? 255 : ring[k] === 1 ? 128 : 0;
      if (alpha === 0) continue;
      const nx = (gx + i + 0.5 - model.cx) * model.ihx;
      out[o] = Math.round(c0 + c3 * nx + c6 * ny);
      out[o + 1] = Math.round(c1 + c4 * nx + c7 * ny);
      out[o + 2] = Math.round(c2 + c5 * nx + c8 * ny);
      out[o + 3] = alpha;
    }
  }

  // Ink colour: erased pixels whose 8 neighbours are erased too (falls back to all erased pixels).
  const hr = new Uint32Array(256);
  const hg = new Uint32Array(256);
  const hb = new Uint32Array(256);
  const off = [-pw - 1, -pw, -pw + 1, -1, 1, pw - 1, pw, pw + 1];
  const addInk = (inner: boolean): number => {
    let count = 0;
    for (let j = 1; j < ph - 1; j++) {
      let s = ((gy + j - px.oy) * px.w + (gx + 1 - px.ox)) * 4;
      for (let k = j * pw + 1; k < j * pw + pw - 1; k++, s += 4) {
        if (erase[k] !== 1) continue;
        if (inner) {
          let all = true;
          for (let o = 0; o < 8 && all; o++) all = erase[k + (off[o] ?? 0)] === 1;
          if (!all) continue;
        }
        const r0 = data[s] ?? 0;
        const g0 = data[s + 1] ?? 0;
        const b0 = data[s + 2] ?? 0;
        hr[r0] = (hr[r0] ?? 0) + 1;
        hg[g0] = (hg[g0] ?? 0) + 1;
        hb[b0] = (hb[b0] ?? 0) + 1;
        count++;
      }
    }
    return count;
  };
  let inkCount = addInk(true);
  if (inkCount < 8) {
    hr.fill(0);
    hg.fill(0);
    hb.fill(0);
    inkCount = addInk(false);
  }
  const ink: RGB | null =
    inkCount > 0 ? [histMedian(hr, inkCount), histMedian(hg, inkCount), histMedian(hb, inkCount)] : null;
  return { rect: { x1: gx + i0, y1: gy + j0, x2: gx + i1, y2: gy + j1 }, data: out, ink };
}

// ---------------------------------------------------------------------------------------------------------------
// Public API

interface Geometry {
  text: Box;
  glyphPx: number;
  pad: number;
  dilateR: number;
  /** W = R grown by this. */
  margin: number;
  /** Background samples reach this far beyond R. */
  reach: number;
}

function geometryOf(unit: EraseUnit, p: EraseParams): Geometry {
  const text = outerInt(unit.text);
  const short = Math.max(0, Math.min(width(text), height(text)));
  const glyphPx = Number.isFinite(unit.glyphPx) && unit.glyphPx > 0 ? unit.glyphPx : Math.max(1, short);
  const pad = Math.max(p.padPx, Math.round(p.padFrac * short));
  const dilateR = clamp(Math.round(p.dilateFrac * glyphPx), p.dilateMin, p.dilateMax);
  const margin = p.padPx + dilateR + Math.max(0, Math.round(p.feather));
  const reach = unit.bubble !== null ? Math.max(p.sampleReachPx, Math.round(glyphPx)) : p.ringPx;
  return { text, glyphPx, pad, dilateR, margin, reach };
}

/**
 * Natural-px box of the pixels computeErase reads: crop it once from the decoded image and pass it as `pixels`.
 * Zero-sized (x2 = x1, y2 = y1) when the text box lies outside the image: skip the crop (getImageData throws on
 * empty sizes) and pass a 0×0 crop, or use the plate directly.
 */
export function eraseReadBox(unit: EraseUnit, image: Size, opts: Partial<EraseParams> = {}): Box {
  const p: EraseParams = { ...ERASE, ...opts };
  const g = geometryOf(unit, p);
  const reach = Math.max(2 * g.pad + g.margin, g.pad + g.reach, g.pad + p.ringPx);
  const b = meet(inflate(g.text, reach), { x1: 0, y1: 0, x2: image.w, y2: image.h });
  if (!isEmpty(b)) return b;
  const x = clamp(b.x1, 0, image.w);
  const y = clamp(b.y1, 0, image.h);
  return { x1: x, y1: y, x2: x, y2: y };
}

function checkInput(input: EraseInput): void {
  const { pixels, origin, image } = input;
  if (!(Number.isInteger(image.w) && Number.isInteger(image.h) && image.w > 0 && image.h > 0)) {
    throw new RangeError(`erase: invalid image size ${image.w}×${image.h}`);
  }
  if (!(Number.isInteger(origin.x) && Number.isInteger(origin.y))) {
    throw new RangeError(`erase: origin must be integer, got ${origin.x},${origin.y}`);
  }
  if (!(
    Number.isInteger(pixels.width) &&
    Number.isInteger(pixels.height) &&
    pixels.width >= 0 &&
    pixels.height >= 0
  )) {
    throw new RangeError(`erase: invalid pixel size ${pixels.width}×${pixels.height}`);
  }
  if (pixels.data.length < pixels.width * pixels.height * 4) {
    throw new RangeError(`erase: pixel buffer too small for ${pixels.width}×${pixels.height}`);
  }
}

/** Decides and builds the erase for one unit (see the module comment). */
export function computeErase(input: EraseInput, opts: Partial<EraseParams> = {}): EraseResult {
  checkInput(input);
  const p: EraseParams = { ...ERASE, ...opts };
  const { pixels, origin, image, unit } = input;
  const g = geometryOf(unit, p);
  const { text, pad } = g;
  const imageBox: Box = { x1: 0, y1: 0, x2: image.w, y2: image.h };
  const avail = meet(imageBox, {
    x1: origin.x,
    y1: origin.y,
    x2: origin.x + pixels.width,
    y2: origin.y + pixels.height,
  });
  const px: Pixels = { data: pixels.data, w: pixels.width, ox: origin.x, oy: origin.y };
  const stats: EraseStats = {
    pad,
    dilateR: g.dilateR,
    ringShare: -1,
    rectLike: false,
    samples: 0,
    coverage: -1,
    spread: -1,
    ringCoverage: -1,
    ringMedian: -1,
    ringP90: -1,
    tOtsu: -1,
    t: -1,
    eta: -1,
    frac: -1,
    lostInk: -1,
    lostPx: -1,
    inkBeyond: -1,
    ambiguous: 0,
    speckle: -1,
    components: 0,
    erased: 0,
    outlines: 0,
    rounds: 0,
    grown: false,
  };
  const plateMargin = Math.round(p.plateFrac * g.glyphPx);
  let plateRect = meet(inflate(text, plateMargin), imageBox);
  const plate = (reason: PlateReason, bg: RGB | null): ErasePlate => ({
    kind: "box",
    rect: plateRect,
    bg,
    textColor: textColorFor(null, bg ?? WHITE, p.minContrast),
    reason,
    stats,
  });

  // 1. Regions.
  const textAvail = meet(text, avail);
  if (isEmpty(text) || isEmpty(textAvail)) return plate("region", null);
  let erasable = avail;
  let sampleEllipse: Ellipse | null = null;
  let rim: Ellipse | null = null;
  if (unit.bubble !== null) {
    const b = unit.bubble;
    const ix = p.bubbleInset * width(b);
    const iy = p.bubbleInset * height(b);
    erasable = meet(avail, innerInt({ x1: b.x1 + ix, y1: b.y1 + iy, x2: b.x2 - ix, y2: b.y2 - iy }));
    sampleEllipse = ellipseOf(b, p.sampleEllipse);
    rim = ellipseOf(b, 1);
  }
  if (area(meet(textAvail, erasable)) < 0.5 * area(textAvail)) return plate("region", null);
  const core1 = meet(inflate(text, pad), avail);
  const readBox = meet(eraseReadBox(unit, image, p), avail);
  for (let y = readBox.y1; y < readBox.y2; y++) {
    const end = at(px, readBox.x2, y);
    for (let k = at(px, readBox.x1, y) + 3; k < end; k += 4) {
      if ((px.data[k] ?? 0) < p.alphaMin) return plate("transparent", null);
    }
  }
  const others = (input.others ?? []).map(outerInt).filter((o) => !isEmpty(meet(o, readBox)));
  const excl = others.map((o) => inflate(o, pad));

  // 2. Sampling shape. Bubble text samples inside the 0.92 ellipse. When less than ringShareMin of the ring around
  // R lies inside it (text filling a rect-like narration or chat box), the model would only be checked on slivers
  // of the ring: sample and test flatness inside the erasable rectangle instead. An elliptical balloon taken for a
  // box fails the flatness tests there (its outline and the page beyond its corners fall into the ring) → plate.
  const ringOuter = meet(inflate(text, pad + p.ringPx), avail);
  let shape = sampleEllipse;
  let within = avail;
  if (shape !== null && unit.elliptical !== true) {
    const inShape = ringStats(px, ringOuter, core1, shape, excl, [], p.inlierTol).n;
    const inRect = ringStats(px, meet(ringOuter, erasable), core1, null, excl, [], p.inlierTol).n;
    stats.ringShare = inRect > 0 ? Math.round((1000 * inShape) / inRect) / 1000 : 0;
    if (inShape < p.ringShareMin * inRect) {
      shape = null;
      within = erasable;
      stats.rectLike = true;
    }
  }

  // 2-3. Background samples and model.
  const samples = collectSamples(
    px,
    meet(inflate(text, pad + g.reach), within),
    core1,
    shape,
    excl,
    p.maxSamples,
  );
  stats.samples = samples.n;
  if (samples.n < p.minSamples) return plate("samples", null);
  const bg0 = histogramMode(samples);
  const flat = evalConst(samples, bg0, p);
  const plane = fitPlane(samples, bg0, p);
  stats.coverage = flat.coverage;
  stats.spread = flat.spread;
  const candidates: ModelFit[] = [];
  if (flat.ok) candidates.push(flat);
  if (plane?.ok === true) candidates.push(plane);
  if (candidates.length === 0) return plate("texture", bg0);

  // 3-4. Model choice and flatness on the ring around R.
  const ring = ringStats(
    px,
    meet(ringOuter, within),
    core1,
    shape,
    excl,
    candidates.map((c) => c.model),
    p.inlierTol,
  );
  let pick = 0;
  if (candidates.length === 2 && ring.n > 0 && (ring.median[1] ?? 255) + 1 <= (ring.median[0] ?? 255))
    pick = 1;
  const chosen = candidates[pick] ?? flat;
  stats.coverage = chosen.coverage;
  stats.spread = chosen.spread;
  const centreX = Math.floor((text.x1 + text.x2) / 2);
  const centreY = Math.floor((text.y1 + text.y2) / 2);
  const bg = modelRgb(chosen.model, centreX, centreY);
  if (ring.n > 0) {
    stats.ringCoverage = ring.coverage[pick] ?? 0;
    stats.ringMedian = ring.median[pick] ?? 255;
    stats.ringP90 = ring.p90[pick] ?? 255;
  }
  // Without a ring (other units' boxes or the image edge all around R) flatness cannot be checked.
  if (ring.n < p.minSamples) return plate("samples", bg0);
  if (stats.ringCoverage < p.ringCoverage || stats.ringMedian > p.ringMedianMax) return plate("texture", bg0);

  // 5-6. Mask passes.
  const ctx: Ctx = { p, px, image, text, glyphPx: g.glyphPx, erasable, others, rim, model: chosen.model };
  let pass = runPass(ctx, core1, meet(inflate(core1, g.margin), avail));
  stats.rounds = 1;
  const lostOf = (ps: Pass): number => {
    const total = ps.erasedInk + ps.lostInk;
    return total > 0 ? ps.lostInk / total : 0;
  };
  if (lostOf(pass) > p.regrowLostInk) {
    // Grow R by pad once; keep whichever pass leaves less ink behind (the grown one may reach an outline or art).
    const core2 = meet(inflate(text, 2 * pad), avail);
    const grown = runPass(ctx, core2, meet(inflate(core2, g.margin), avail));
    stats.rounds = 2;
    if (grown.lostInk < pass.lostInk) {
      pass = grown;
      stats.grown = true;
    }
  }
  stats.tOtsu = pass.tOtsu;
  stats.t = pass.t;
  stats.eta = pass.eta;
  stats.frac = pass.coreArea > 0 ? pass.inkCore / pass.coreArea : 0;
  stats.lostInk = lostOf(pass);
  stats.lostPx = pass.lostInk;
  stats.inkBeyond = pass.inkBeyond;
  stats.ambiguous = pass.ambiguous;
  stats.speckle = Math.round(pass.speckle * 100) / 100;
  stats.components = pass.comps.length;
  stats.erased = pass.comps.filter((c) => c.role === "erase").length;
  stats.outlines = pass.comps.filter((c) => c.role === "outline").length;
  // A plate must also hide ink that the text box missed (a period beyond a too-tight box is what makes a rim piece
  // ambiguous): grow its minimum area over the components with ink in R, + 1 px. Outlines are art and stay out;
  // everything else lies inside W, at most pad + margin px beyond R.
  for (const c of pass.comps) {
    if (c.role !== "erase" && c.role !== "lost" && c.role !== "ambiguous") continue;
    const gx = pass.win.x1 - 1;
    const gy = pass.win.y1 - 1;
    const cb = { x1: gx + c.x0 - 1, y1: gy + c.y0 - 1, x2: gx + c.x1 + 1, y2: gy + c.y1 + 1 };
    plateRect = meet(union(plateRect, cb), imageBox);
  }

  // 7. Guards. "none" only when no more than a leftover's worth of ink stays visible anywhere in the text box.
  const lostCap = p.lostInkGlyph * g.glyphPx * g.glyphPx;
  if (stats.speckle > p.speckleMax) return plate("texture", bg0);
  if (stats.frac < p.maskFracMin && pass.ambiguous === 0 && stats.lostPx <= lostCap) {
    return { kind: "none", rect: text, bg, textColor: readableOn(bg), stats };
  }
  if (pass.ambiguous > 0 || stats.lostInk > p.lostInkMax || stats.lostPx > lostCap) {
    return plate("lost-ink", bg);
  }
  if (stats.frac > p.maskFracMax) return plate("mask-frac", bg);
  if (stats.eta < p.etaMin) return plate("eta", bg);

  // 8-9. Patch and text colour.
  const patch = buildPatch(ctx, pass, g.dilateR);
  if (patch === null) return { kind: "none", rect: text, bg, textColor: readableOn(bg), stats };
  return {
    kind: "mask",
    rect: patch.rect,
    bg,
    textColor: textColorFor(patch.ink, bg, p.minContrast),
    model: chosen.model.kind,
    patch: { width: width(patch.rect), height: height(patch.rect), data: patch.data },
    stats,
  };
}

/**
 * Source-over of a mask patch onto an opaque RGBA image whose top-left pixel is at `origin` (what the content
 * script's drawImage does). Pixels outside the image are skipped.
 */
export function compositePatch(
  target: ImageDataLike,
  origin: { x: number; y: number },
  result: EraseMask,
): void {
  const { patch, rect } = result;
  for (let j = 0; j < patch.height; j++) {
    const y = rect.y1 + j - origin.y;
    if (y < 0 || y >= target.height) continue;
    for (let i = 0; i < patch.width; i++) {
      const x = rect.x1 + i - origin.x;
      if (x < 0 || x >= target.width) continue;
      const s = (j * patch.width + i) * 4;
      const a = patch.data[s + 3] ?? 0;
      if (a === 0) continue;
      const t = (y * target.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = ((patch.data[s + c] ?? 0) * a + (target.data[t + c] ?? 0) * (255 - a)) / 255;
        target.data[t + c] = Math.round(v);
      }
    }
  }
}

/** What the renderer does with a unit's erase result. */
export type EraseUse =
  | "patch" // draw the mask patch, then the translation
  | "plate" // translucent rounded plate, then the translation
  | "text" // translation only (nothing to hide)
  | "label" // SFX: small label pill, original art untouched
  | "nothing"; // leave the original untouched (no valid translation, or type ignore)

/**
 * Render policy: only units with a valid translation (status ok or manual) are ever erased or covered; SFX keep the
 * art and get a label unless `eraseSfx` is on and the erase is a clean mask.
 */
export function eraseUse(type: LineType, status: UnitStatus, kind: EraseKind, eraseSfx = false): EraseUse {
  if (status !== "ok" && status !== "manual") return "nothing";
  if (type === "ignore") return "nothing";
  if (type === "sfx") return eraseSfx && kind === "mask" ? "patch" : "label";
  switch (kind) {
    case "mask":
      return "patch";
    case "box":
      return "plate";
    case "none":
      return "text";
  }
}
