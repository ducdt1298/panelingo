// core/fit-text's Measure on canvas measureText: the font list and weight the overlay renders a face with (fonts.ts
// stacks, lettering.ts faces), at the size the line is laid out at, kerning on like the DOM lines (font-kerning:
// normal). fitText memoises per call; the small cache here spans calls (re-fits on resize).

import { COLLISION_LEADING, LINE_HEIGHT_PROBES, lineHeightFromInk } from "../shared/core/fit-text.ts";
import type { FontMetrics, Measure } from "../shared/core/fit-text.ts";

/** The parts of CanvasRenderingContext2D used here (a fake in Node tests). */
export interface TextContext {
  font: string;
  fontKerning: CanvasFontKerning;
  measureText(
    text: string,
  ): Pick<
    TextMetrics,
    | "width"
    | "actualBoundingBoxAscent"
    | "actualBoundingBoxDescent"
    | "fontBoundingBoxAscent"
    | "fontBoundingBoxDescent"
  >;
}

export const MEASURE_CACHE_SIZE = 4000;

/** Line metrics when even measuring the fallback font fails (roomy: Segoe UI / Comic Sans MS sized). */
export const FALLBACK_METRICS: Readonly<FontMetrics> = {
  lineHeight: 1.45,
  ascent: 1.1,
  descent: 0.3,
  pixelSnap: false,
};

/** The canvas `font` value; the DOM lines use the same weight, size and list. */
export function fontShorthand(px: number, family: string, weight = 400): string {
  return `${weight} ${px}px ${family}`;
}

/** A 2D context of a detached canvas in `doc`; its fonts are the document's (document.fonts). */
export function canvasContext(doc: Document): CanvasRenderingContext2D | null {
  return doc.createElement("canvas").getContext("2d");
}

/** Advance width of text set at px in `family`. Without a context: a crude 0.55 em per character. */
export function createMeasure(family: string, context: TextContext | null, weight = 400): Measure {
  if (context === null) return (text, px) => [...text].length * 0.55 * px;
  context.fontKerning = "normal";
  const cache = new Map<string, number>();
  let current = Number.NaN;
  return (text, px) => {
    const key = `${px}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (px !== current) {
      context.font = fontShorthand(px, family, weight);
      current = px;
    }
    const width = context.measureText(text).width;
    if (cache.size >= MEASURE_CACHE_SIZE) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    cache.set(key, width);
    return width;
  };
}

/**
 * Metrics of a font fitText has no constants for (the system fallback when a CTV family failed to load), measured
 * the way the Patrick Hand constants were: ascent/descent from the font box at 1000 px, line-height from the ink of
 * LINE_HEIGHT_PROBES (or `probes`: CJK lettering passes its own) at 100 px plus COLLISION_LEADING. The bundled faces
 * use the validated constants of lettering.ts.
 */
export function measureFontMetrics(
  family: string,
  context: TextContext | null,
  weight = 400,
  probes: { ascent: string; descent: string } = LINE_HEIGHT_PROBES,
): FontMetrics {
  if (context === null) return { ...FALLBACK_METRICS };
  context.fontKerning = "normal";
  context.font = fontShorthand(1000, family, weight);
  const box = context.measureText(probes.ascent);
  const ascent = box.fontBoundingBoxAscent / 1000;
  const descent = box.fontBoundingBoxDescent / 1000;
  context.font = fontShorthand(100, family, weight);
  const inkAscent = context.measureText(probes.ascent).actualBoundingBoxAscent / 100;
  const inkDescent = context.measureText(probes.descent).actualBoundingBoxDescent / 100;
  const sane = (v: number): boolean => Number.isFinite(v) && v >= 0 && v < 5;
  if (!sane(ascent) || !sane(descent) || ascent + descent <= 0 || !sane(inkAscent) || !sane(inkDescent)) {
    return { ...FALLBACK_METRICS };
  }
  return {
    lineHeight: lineHeightFromInk(inkAscent, inkDescent) + COLLISION_LEADING,
    ascent,
    descent,
    pixelSnap: true,
  };
}

/** The glyph whose ink ascent is the cap height, and the size it is measured at (as for CAP_HEIGHT_EM). */
export const CAP_PROBE = { text: "H", px: 100 } as const;

/**
 * Cap height in em of a font without a validated constant (a fallback font): the ink ascent of "H" at 100 px, the
 * way overlay/render.ts CAP_HEIGHT_EM and lettering.ts CAP_HEIGHTS were measured. Null without a context or when the
 * reading is implausible (outside 0.3-1.2 em).
 */
export function measureCapHeight(family: string, context: TextContext | null, weight = 400): number | null {
  if (context === null) return null;
  context.fontKerning = "normal";
  context.font = fontShorthand(CAP_PROBE.px, family, weight);
  const em = context.measureText(CAP_PROBE.text).actualBoundingBoxAscent / CAP_PROBE.px;
  return Number.isFinite(em) && em >= 0.3 && em <= 1.2 ? em : null;
}

/** The CJK glyph whose ink height sizes CJK lettering (a full square character). */
export const INK_PROBE = { text: "国", px: 100 } as const;

/**
 * Ink height in em of a CJK font: ascent + descent of "国" at 100 px (CJK lettering is matched to the original by
 * ink, not by cap height). Null without a context or when the reading is implausible (outside 0.5-1.3 em).
 */
export function measureInkHeight(family: string, context: TextContext | null, weight = 400): number | null {
  if (context === null) return null;
  context.fontKerning = "normal";
  context.font = fontShorthand(INK_PROBE.px, family, weight);
  const m = context.measureText(INK_PROBE.text);
  const em = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / INK_PROBE.px;
  return Number.isFinite(em) && em >= 0.5 && em <= 1.3 ? em : null;
}
