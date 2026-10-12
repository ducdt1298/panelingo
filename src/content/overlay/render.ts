// Unit painting. planUnit is pure: unit + display scale + measure → what to draw, in natural px; buildUnitNode turns
// a plan into DOM under the host's scaled layer.
//
// The original lettering is hidden by the engine's erase patch: the background model painted over exactly the glyph
// pixels, so balloon outlines, panel borders and art stay intact. Without a clean patch a translucent plate covers
// only the original text area (plus the fitted translation), clipped to the balloon's interior so it never paints
// over the outline. The translation is sized like the original lettering: its capitals match the measured glyph
// height (with the cap height of the face it is lettered in, content/lettering.ts), and fitText only goes smaller
// when the translation does not fit.
//
// A unit without a valid translation (status other than ok / manual, empty text, type "ignore") gets no plan at
// all: its original lettering stays visible and is never covered. SFX are never covered by a plate: they get a label
// (settings.render.sfxLabels), or with settings.render.eraseSfx a clean erase patch and the translation in place.

import { eraseUse } from "../../shared/core/erase-core.ts";
import {
  PATRICK_HAND_METRICS,
  VERTICAL_METRICS,
  fitText,
  fitTextVertical,
  normalizeText,
} from "../../shared/core/fit-text.ts";
import type {
  FitChain,
  FitOptions,
  FitShape,
  FitStep,
  FontMetrics,
  Measure,
} from "../../shared/core/fit-text.ts";
import { clip, inflate, union } from "../../shared/geometry.ts";
import type {
  Box,
  Bytes,
  RGB,
  Script,
  Size,
  UnitGeometry,
  UnitRender,
  UnitStatus,
} from "../../shared/types.ts";
import { decodeBytes } from "../../shared/wire.ts";
import { element, px } from "./dom.ts";

/** The only statuses that carry a translation to paint. */
export const PAINTED_STATUSES: ReadonlySet<UnitStatus> = new Set<UnitStatus>(["ok", "manual"]);

export function shouldPaint(unit: Pick<UnitRender, "status" | "type" | "translation">): boolean {
  return (
    PAINTED_STATUSES.has(unit.status) && unit.type !== "ignore" && normalizeText(unit.translation) !== ""
  );
}

/* ------------------------------------------------------------------ size */

/** Cap height of the overlay font in em: Patrick Hand 400 "H" ink ascent, measured with @napi-rs/canvas. */
export const CAP_HEIGHT_EM = 0.66;
/**
 * The translation's cap height as a share of the original glyph height. Latin lettering (mostly capitals) maps cap
 * height to cap height; a Hangul or Han glyph fills its em square, so capitals at 80 % of it read as the same size.
 */
export const CAP_MATCH: Readonly<Record<Script, number>> = { latin: 1, hangul: 0.8, cjk: 0.8 };

/**
 * Font size (natural px) whose capitals match original lettering of `glyphPx` natural px, for a face whose cap
 * height is `capHeightEm` (default Patrick Hand's). CJK lettering passes its ink height and CJK_INK_MATCH
 * (content/lettering.ts) as `match`: a Han character's ink is matched to the original glyph instead.
 */
export function matchFontPx(
  glyphPx: number,
  script: Script = "hangul",
  capHeightEm = CAP_HEIGHT_EM,
  match: Readonly<Record<Script, number>> = CAP_MATCH,
): number {
  const cap = capHeightEm > 0 && Number.isFinite(capHeightEm) ? capHeightEm : CAP_HEIGHT_EM;
  return (glyphPx * match[script]) / cap;
}

/**
 * fitText's size range in natural px for an image shown at `scale` CSS px per natural px. The ceiling is the size
 * that matches the original lettering (fitText only goes smaller when the translation does not fit), bounded by the
 * settings' CSS-px floor and ceiling divided by the scale.
 */
export function fontLimits(
  scale: number,
  glyphPx: number,
  minCssPx: number,
  maxCssPx: number,
  script?: Script,
  capHeightEm?: number,
  match?: Readonly<Record<Script, number>>,
): { minPx: number; maxPx: number } {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const minPx = Math.max(1, minCssPx) / s;
  const cap = Math.max(minPx, maxCssPx / s);
  const maxPx =
    glyphPx > 0 && Number.isFinite(glyphPx)
      ? Math.min(cap, Math.max(minPx, matchFontPx(glyphPx, script, capHeightEm, match)))
      : cap;
  return { minPx, maxPx };
}

/* ------------------------------------------------------------------ colours */

export const WHITE: RGB = [255, 255, 255];
export const BLACK: RGB = [0, 0, 0];
/** WCAG AA for text; below it the text colour flips to black or white. */
export const MIN_TEXT_CONTRAST = 4.5;

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(c: RGB): number {
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The original text colour when it reads on the background, else black or white, whichever contrasts more. */
export function readableText(text: RGB, background: RGB): RGB {
  if (contrastRatio(text, background) >= MIN_TEXT_CONTRAST) return text;
  return contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE;
}

function validRgb(c: RGB | null | undefined): RGB | null {
  if (c == null || c.length !== 3) return null;
  if (!c.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return null;
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
}

export function cssColor(c: RGB, alpha = 1): string {
  return alpha >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

/* ------------------------------------------------------------------ plan */

/**
 * A plate stays inside the balloon inset by this share per side, so it never paints over the outline. fit.region
 * is already the interior measured inside the outline (engine erase.ts), so a small inset is enough.
 */
export const BUBBLE_CLIP_INSET = 0.03;
/** The plate reaches this many em past the fitted text (it also covers the original text area). */
export const PLATE_PAD_EM = 0.25;
/** Plate opacity (a translucent plate, the art faintly visible). */
export const PLATE_ALPHA = 0.92;
/** Halo of text that fitText's step 3 moved past the region, in CSS px (text-shadow 0 0 2px, twice). */
export const HALO_CSS_PX = 2;
/** SFX label: a white pill at the unit's top-right; sizes in em of the label text or CSS px. */
export const SFX_LABEL = {
  /** Text size as a fraction of the original glyph height, within the font limits. */
  glyph: 0.5,
  alpha: 0.85,
  maxLines: 2,
  maxWidthCss: 240,
  marginCss: 4,
  padX: 0.45,
  padY: 0.12,
} as const;

export interface PlanLine {
  text: string;
  /** Left edge and top of the line box (a column's box when vertical), natural px. */
  x: number;
  y: number;
  width: number;
  /** Vertical plans only: the column's length (its box is lineHeightPx wide). */
  height?: number;
}

export interface UnitPlan {
  unitKey: string;
  /** "text": the translation over the erased original; "label": an SFX pill beside the original. */
  kind: "text" | "label";
  /** The engine's erase patch (PNG), drawn at rect before the text. */
  patch: { rect: Box; png: Bytes } | null;
  /** Plate over the original text area (no clean patch), or the SFX label pill. */
  plate: { box: Box; shape: FitShape; radius: number } | null;
  /** The plate is clipped to the balloon's interior; null = unclipped. */
  plateClip: { box: Box; shape: FitShape } | null;
  fill: RGB;
  fillAlpha: number;
  color: RGB;
  fontPx: number;
  lineHeightPx: number;
  lines: PlanLine[];
  /** Text-shadow radius in natural px, 0 = none. */
  haloPx: number;
  /** fitText cut the text with "…" (sent to the engine as unit:overflow). */
  overflow: boolean;
  step: FitStep;
  /** Lettered top to bottom in columns right to left (writing-mode: vertical-rl). */
  vertical?: true;
}

export interface PlanOptions {
  /** settings.render.minFontPx / maxFontPx, CSS px. */
  minFontPx: number;
  maxFontPx: number;
  /** Default PATRICK_HAND_METRICS. */
  metrics?: FontMetrics;
  /** Cap height in em of the face the unit is lettered in; default CAP_HEIGHT_EM (Patrick Hand). */
  capHeightEm?: number;
  /**
   * Ink of the face's tallest letters (stacked Vietnamese marks) above the baseline, in em. Where it rises above the
   * line box (Bangers), an SFX label pill grows at the top so the marks stay inside it. Default: no growth.
   */
  inkAscentEm?: number;
  /** settings.render.eraseSfx: an SFX with a clean erase patch is erased and lettered in place (default off). */
  eraseSfx?: boolean;
  /** settings.render.sfxLabels: other SFX get a label pill (default on); off leaves them untouched. */
  sfxLabels?: boolean;
  /** How the face's capitals (or CJK ink) relate to the original glyph height per script; default CAP_MATCH. */
  sizeMatch?: Readonly<Record<Script, number>>;
  /**
   * Letter the text vertically (vertical-rl columns, VERTICAL_METRICS): a Japanese or Traditional Chinese
   * translation in a vertical balloon. SFX labels stay horizontal.
   */
  vertical?: boolean;
  /** Layout zoom (window.devicePixelRatio) for the pixel-snapped line model. */
  zoom?: number;
  /** Natural size of the image: bounds for fitText's step 3 and for SFX labels. */
  image?: Size | null;
  /** Allow fitText's step 3 (grow past the region with a halo); off for seam units, laid out alike in two images. */
  grow?: boolean;
  /** Other units' boxes, kept clear by step 3. */
  obstacles?: readonly Box[];
  /** The unit's detected geometry (img:units): its text boxes and bubble. */
  geometry?: UnitGeometry | null;
}

function validBox(b: Box | null | undefined): b is Box {
  return (
    b != null &&
    Number.isFinite(b.x1) &&
    Number.isFinite(b.y1) &&
    Number.isFinite(b.x2) &&
    Number.isFinite(b.y2) &&
    b.x2 > b.x1 &&
    b.y2 > b.y1
  );
}

function insetBox(b: Box, fraction: number): Box {
  const dx = (b.x2 - b.x1) * fraction;
  const dy = (b.y2 - b.y1) * fraction;
  return { x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 - dx, y2: b.y2 - dy };
}

/** Every corner of `inner` lies in the shape inscribed in `outer` (½ px tolerance). */
export function insideShape(inner: Box, outer: Box, shape: FitShape): boolean {
  const tol = 0.5;
  if (shape === "rect") {
    return (
      inner.x1 >= outer.x1 - tol &&
      inner.y1 >= outer.y1 - tol &&
      inner.x2 <= outer.x2 + tol &&
      inner.y2 <= outer.y2 + tol
    );
  }
  const cx = (outer.x1 + outer.x2) / 2;
  const cy = (outer.y1 + outer.y2) / 2;
  const a = (outer.x2 - outer.x1) / 2 + tol;
  const b = (outer.y2 - outer.y1) / 2 + tol;
  for (const x of [inner.x1, inner.x2]) {
    for (const y of [inner.y1, inner.y2]) {
      if (((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 > 1) return false;
    }
  }
  return true;
}

interface Limits {
  minPx: number;
  maxPx: number;
}

/** How an SFX with a valid translation is shown. */
export type SfxMode = "erase" | "label" | "none";

/**
 * "erase" with render.eraseSfx when the engine produced a clean mask patch (never a plate over the art), else
 * "label" with render.sfxLabels, else "none" (the original stays untouched).
 */
export function sfxMode(
  unit: Pick<UnitRender, "type" | "status" | "erase">,
  eraseSfx = false,
  sfxLabels = true,
): SfxMode {
  const erase = unit.erase;
  if (
    eraseUse(unit.type, unit.status, erase.kind, eraseSfx) === "patch" &&
    erase.png !== undefined &&
    validBox(erase.rect)
  ) {
    return "erase";
  }
  return sfxLabels ? "label" : "none";
}

/**
 * What to paint for a unit shown at `scale` CSS px per natural px, or null when nothing may be painted. Never
 * throws on content; fitText's RangeErrors (invalid options) still propagate.
 */
export function planUnit(
  unit: UnitRender,
  scale: number,
  measure: Measure,
  options: PlanOptions,
): UnitPlan | null {
  if (!shouldPaint(unit) || !validBox(unit.fit.region)) return null;
  const sfx = unit.type === "sfx" ? sfxMode(unit, options.eraseSfx, options.sfxLabels) : null;
  if (sfx === "none") return null;
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  const limits = fontLimits(
    s,
    unit.fit.glyphPx,
    options.minFontPx,
    options.maxFontPx,
    unit.fit.script,
    options.capHeightEm,
    options.sizeMatch,
  );
  const vertical = options.vertical === true && sfx !== "label";
  const metrics = vertical ? VERTICAL_METRICS : (options.metrics ?? PATRICK_HAND_METRICS);
  const zoom = options.zoom;
  const fit: FitOptions = {
    measure,
    metrics,
    minPx: limits.minPx,
    maxPx: limits.maxPx,
    ...(zoom !== undefined && zoom > 0 && Number.isFinite(zoom) ? { zoom } : {}),
  };
  const image = options.image != null && options.image.w > 0 && options.image.h > 0 ? options.image : null;
  return sfx === "label"
    ? planLabel(unit, s, fit, limits, metrics, image, options.inkAscentEm)
    : planText(unit, s, fit, image, options, vertical);
}

function planText(
  unit: UnitRender,
  scale: number,
  fit: FitOptions,
  image: Size | null,
  options: PlanOptions,
  vertical: boolean,
): UnitPlan | null {
  const region = unit.fit.region;
  const shape = unit.fit.shape;
  const chain: FitChain =
    options.grow === true && image !== null
      ? { bounds: { x1: 0, y1: 0, x2: image.w, y2: image.h }, obstacles: options.obstacles ?? [] }
      : {};
  const r = (vertical ? fitTextVertical : fitText)(unit.translation, region, { ...fit, shape, chain });
  if (r.lines.length === 0) return null;
  const erase = unit.erase;
  const use = eraseUse(unit.type, unit.status, erase.kind, options.eraseSfx === true);
  const fill = validRgb(erase.bg) ?? WHITE;
  let patch: UnitPlan["patch"] = null;
  let plate: UnitPlan["plate"] = null;
  let plateClip: UnitPlan["plateClip"] = null;
  if (use === "patch" && erase.png !== undefined && validBox(erase.rect)) {
    patch = { rect: erase.rect, png: erase.png };
  } else if (use === "plate" || use === "patch") {
    // No clean patch (yet): cover the original text area and the translation, never the whole balloon.
    let box: Box | null = validBox(erase.rect) ? erase.rect : r.bounds;
    if (box === null) return null;
    if (r.bounds !== null) box = union(box, inflate(r.bounds, PLATE_PAD_EM * r.fontPx));
    if (image !== null) box = clip(box, image);
    const balloon = options.geometry?.bubble != null || shape === "ellipse" ? region : null;
    if (validBox(balloon)) plateClip = { box: insetBox(balloon, BUBBLE_CLIP_INSET), shape };
    const side = Math.min(box.x2 - box.x1, box.y2 - box.y1);
    plate = { box, shape: "rect", radius: Math.min(0.5 * r.fontPx, 0.3 * side) };
  }
  return {
    unitKey: unit.unitKey,
    kind: "text",
    patch,
    plate,
    plateClip,
    fill,
    fillAlpha: PLATE_ALPHA,
    color: readableText(validRgb(erase.textColor) ?? BLACK, fill),
    fontPx: r.fontPx,
    lineHeightPx: r.lineHeightPx,
    lines: r.lines.map((l) =>
      r.vertical === true
        ? { text: l.text, x: l.x, y: l.y, width: r.lineHeightPx, height: l.width }
        : { text: l.text, x: l.x, y: l.y, width: l.width },
    ),
    haloPx: r.halo ? HALO_CSS_PX / scale : 0,
    overflow: r.overflow,
    step: r.step,
    ...(r.vertical === true ? { vertical: true as const } : {}),
  };
}

/**
 * How far (em) the face's ink rises above the top of its line box: the baseline sits ascent + half the leading below
 * the top. 0 when the ink stays inside or is unknown.
 */
export function labelRiseEm(metrics: FontMetrics, inkAscentEm: number | undefined): number {
  if (inkAscentEm === undefined || !Number.isFinite(inkAscentEm)) return 0;
  const baseline = metrics.ascent + (metrics.lineHeight - metrics.ascent - metrics.descent) / 2;
  return Math.max(0, inkAscentEm - baseline);
}

function planLabel(
  unit: UnitRender,
  scale: number,
  fit: FitOptions,
  limits: Limits,
  metrics: FontMetrics,
  image: Size | null,
  inkAscentEm?: number,
): UnitPlan | null {
  const region = unit.fit.region;
  const glyph = unit.fit.glyphPx > 0 && Number.isFinite(unit.fit.glyphPx) ? unit.fit.glyphPx : 0;
  const target = Math.min(limits.maxPx, Math.max(limits.minPx, SFX_LABEL.glyph * glyph));
  const margin = SFX_LABEL.marginCss / scale;
  let maxWidth = Math.max(region.x2 - region.x1, SFX_LABEL.maxWidthCss / scale);
  if (image !== null) maxWidth = Math.min(maxWidth, image.w - 2 * margin);
  if (!(maxWidth > 0)) return null;
  // Room for maxLines lines at the target size (+2 px for the line-height's 1/64 px rounding).
  const frame: Box = { x1: 0, y1: 0, x2: maxWidth, y2: SFX_LABEL.maxLines * metrics.lineHeight * target + 2 };
  const r = fitText(unit.translation, frame, {
    ...fit,
    maxPx: target,
    shape: "rect",
    inset: 0,
    maxLines: SFX_LABEL.maxLines,
    chain: false,
  });
  const first = r.lines[0];
  if (first === undefined || r.bounds === null) return null;
  const padX = SFX_LABEL.padX * r.fontPx;
  const padY = SFX_LABEL.padY * r.fontPx;
  const padTop = padY + labelRiseEm(metrics, inkAscentEm) * r.fontPx;
  const w = r.bounds.x2 - r.bounds.x1 + 2 * padX;
  const h = r.lines.length * r.lineHeightPx + padTop + padY;
  let right = region.x2;
  let top = region.y1;
  if (image !== null) {
    right = Math.min(image.w - margin, Math.max(w + margin, right));
    top = Math.max(margin, Math.min(image.h - h - margin, top));
  }
  const pill: Box = { x1: right - w, y1: top, x2: right, y2: top + h };
  const dx = pill.x1 + padX - r.bounds.x1;
  const dy = pill.y1 + padTop - first.y;
  return {
    unitKey: unit.unitKey,
    kind: "label",
    patch: null,
    plate: { box: pill, shape: "rect", radius: h / 2 },
    plateClip: null,
    fill: WHITE,
    fillAlpha: SFX_LABEL.alpha,
    color: readableText(validRgb(unit.erase.textColor) ?? BLACK, WHITE),
    fontPx: r.fontPx,
    lineHeightPx: r.lineHeightPx,
    lines: r.lines.map((l) => ({ text: l.text, x: l.x + dx, y: l.y + dy, width: l.width })),
    haloPx: 0,
    overflow: r.overflow,
    step: r.step,
  };
}

/**
 * Where a painted unit answers Alt+click and long-press (natural px): everything it draws (patch, plate or pill,
 * lines) plus, for lettering in a balloon, the balloon's interior.
 */
export function unitHitBox(plan: UnitPlan, region: Box | null): Box | null {
  const boxes: Box[] = [];
  if (plan.kind === "text" && validBox(region)) boxes.push(region);
  if (plan.patch !== null && validBox(plan.patch.rect)) boxes.push(plan.patch.rect);
  if (plan.plate !== null && validBox(plan.plate.box)) boxes.push(plan.plate.box);
  for (const line of plan.lines) {
    const box = {
      x1: line.x,
      y1: line.y,
      x2: line.x + line.width,
      y2: line.y + (line.height ?? plan.lineHeightPx),
    };
    if (validBox(box)) boxes.push(box);
  }
  return boxes.reduce<Box | null>((acc, box) => (acc === null ? box : union(acc, box)), null);
}

/* ------------------------------------------------------------------ DOM */

function place(node: HTMLElement, b: Box, originX = 0, originY = 0): void {
  node.style.left = px(b.x1 - originX);
  node.style.top = px(b.y1 - originY);
  node.style.width = px(b.x2 - b.x1);
  node.style.height = px(b.y2 - b.y1);
}

/** Draws the patch PNG into its canvas (ImageBitmap: no URL, so page CSPs cannot block it). */
async function drawPatch(canvas: HTMLCanvasElement, png: Bytes): Promise<void> {
  const bitmap = await createImageBitmap(new Blob([decodeBytes(png)], { type: "image/png" }));
  try {
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
}

/**
 * The unit's DOM, in natural px: erase patch or plate, then one absolutely positioned line per fitted line
 * (white-space: pre and explicit widths, so the DOM never re-wraps what fitText measured; font size and line-height
 * unrounded so Chrome lays the lines out exactly as modelled). `face` (data-face) picks the lines' font family and
 * weight in the overlay sheet (styles.ts): the face the plan was measured with.
 */
export function buildUnitNode(
  doc: Document,
  plan: UnitPlan,
  onError?: (error: unknown) => void,
  face = "comic",
): HTMLDivElement {
  const node = element(doc, "div", "unit");
  node.setAttribute("data-unit", plan.unitKey);
  node.setAttribute("data-face", face);
  if (plan.vertical === true) node.setAttribute("data-vertical", "");
  node.setAttribute("data-kind", plan.kind);
  node.setAttribute("data-step", String(plan.step));
  if (plan.overflow) node.setAttribute("data-overflow", "");

  if (plan.patch !== null) {
    const { rect, png } = plan.patch;
    const canvas = element(doc, "canvas", "patch");
    canvas.width = Math.max(1, Math.round(rect.x2 - rect.x1));
    canvas.height = Math.max(1, Math.round(rect.y2 - rect.y1));
    place(canvas, rect);
    node.setAttribute("data-erase", "patch");
    node.append(canvas);
    drawPatch(canvas, png).catch((error: unknown) => onError?.(error));
  }

  if (plan.plate !== null) {
    let parent: HTMLElement = node;
    let ox = 0;
    let oy = 0;
    if (plan.plateClip !== null) {
      parent = element(
        doc,
        "div",
        plan.plateClip.shape === "ellipse" ? "plates clipped ellipse" : "plates clipped",
      );
      place(parent, plan.plateClip.box);
      node.append(parent);
      ox = plan.plateClip.box.x1;
      oy = plan.plateClip.box.y1;
    }
    const plate = element(doc, "div", plan.plate.shape === "ellipse" ? "plate ellipse" : "plate");
    place(plate, plan.plate.box, ox, oy);
    plate.style.backgroundColor = cssColor(plan.fill, plan.fillAlpha);
    if (plan.plate.shape === "rect" && plan.plate.radius > 0)
      plate.style.borderRadius = px(plan.plate.radius);
    if (plan.kind === "text") node.setAttribute("data-erase", "plate");
    parent.append(plate);
  }

  const color = cssColor(plan.color);
  const halo = plan.haloPx > 0 ? `0 0 ${px(plan.haloPx)} ${cssColor(plan.fill)}` : "";
  for (const line of plan.lines) {
    const div = element(doc, "div", "line");
    div.style.left = px(line.x);
    div.style.top = px(line.y);
    div.style.width = px(line.width);
    div.style.height = line.height === undefined ? `${plan.lineHeightPx}px` : px(line.height);
    div.style.fontSize = `${plan.fontPx}px`;
    div.style.lineHeight = `${plan.lineHeightPx}px`;
    div.style.color = color;
    if (halo !== "") div.style.textShadow = `${halo}, ${halo}`;
    div.textContent = line.text;
    node.append(div);
  }
  return node;
}
