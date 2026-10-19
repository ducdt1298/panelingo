// Offline OCR core (PaddleOCR PP-OCRv5 text-line recognizers, docs/OFFLINE-MODE.md). PURE.
//
// The detector gives each unit text boxes (blocks of one or more lines). Each box is binarized (textMask: Otsu, the
// text class told from the background by its small connected components, thin frame lines and what reaches in from
// outside the box removed), its orientation checked against the ink (inferOrientation), split into lines
// (horizontal text) or columns (vertical text, right to left) with a projection profile, and every line is trimmed
// to its ink. A vertical column becomes a horizontal strip of its upright character cells (stackColumn): small kana
// and punctuation survive, which PaddleOCR's 90° rotation of tall crops (cropRgba with rotate) loses on manga. A line
// becomes the recognizer's input like PaddleOCR's RecResizeImg: height 48, width ≥ 320 (padded with zeros after
// normalization), BGR channels, (v / 255 - 0.5) / 0.5. The output is decoded greedily (CTC: best class per step,
// repeats collapsed, blanks dropped); class 0 is the blank, classes 1..n the dictionary of inference.yml, class n + 1
// a space.

import type { ImageDataLike } from "../gfx.ts";
import type { Box, Lang } from "../types.ts";

export const REC_HEIGHT = 48;
/** PaddleOCR's minimum recognizer width (image_shape [3, 48, 320]). */
export const REC_MIN_WIDTH = 320;
/** Longest line fed at once; wider lines are squeezed (the TRT profile in inference.yml stops at 3200). */
export const REC_MAX_WIDTH = 3200;
/** Widths are rounded up to this multiple, so a WebGPU session sees few distinct shapes. */
export const REC_WIDTH_STEP = 32;

/* ------------------------------------------------------------------ dictionary */

/** The `character_dict` list of a PaddleOCR inference.yml (PyYAML output: plain, '…' or "…" scalars). */
export function parseCharacterDict(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s*character_dict:\s*$/u.test(line));
  if (start < 0) throw new Error("inference.yml: no character_dict");
  const out: string[] = [];
  let indent: number | null = null;
  for (const line of lines.slice(start + 1)) {
    const match = /^(\s*)- (.*)$/u.exec(line);
    if (match === null) {
      if (line.trim() === "") continue;
      break;
    }
    const lead = match[1]?.length ?? 0;
    indent ??= lead;
    if (lead !== indent) break;
    out.push(yamlScalar(match[2] ?? ""));
  }
  if (out.length === 0) throw new Error("inference.yml: empty character_dict");
  return out;
}

function yamlScalar(raw: string): string {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    return raw.slice(1, -1).replace(/''/gu, "'");
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw
      .slice(1, -1)
      .replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gu, (_, esc: string) => {
        if (/^[xuU]/u.test(esc)) return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", " ": " ", "/": "/" };
        return simple[esc] ?? esc;
      });
  }
  return raw.trim();
}

/* ------------------------------------------------------------------ CTC */

export interface CtcResult {
  text: string;
  /** Mean probability of the kept characters (0 when none). */
  confidence: number;
}

/**
 * Greedy CTC decoding of one sequence: `probs` holds steps × classes scores (softmax output, row-major). Class 0 is
 * the blank, class i ≥ 1 is dict[i - 1], class dict.length + 1 a space.
 */
export function ctcDecode(
  probs: ArrayLike<number>,
  steps: number,
  classes: number,
  dict: readonly string[],
): CtcResult {
  let text = "";
  let sum = 0;
  let kept = 0;
  let previous = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    const row = t * classes;
    for (let c = 0; c < classes; c++) {
      const score = probs[row + c] ?? Number.NEGATIVE_INFINITY;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best !== 0 && best !== previous) {
      const char = best === dict.length + 1 ? " " : (dict[best - 1] ?? "");
      text += char;
      sum += bestScore;
      kept += 1;
    }
    previous = best;
  }
  return { text, confidence: kept === 0 ? 0 : sum / kept };
}

/* ------------------------------------------------------------------ binarization and segmentation */

export interface InkMask {
  width: number;
  height: number;
  /** 1 = ink. */
  ink: Uint8Array;
}

export function luminance(image: ImageDataLike): Uint8Array {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round(0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0));
  }
  return out;
}

/** Otsu's threshold of 8-bit values: pixels ≤ the result form the dark class. */
export function otsuThreshold(values: Uint8Array): number {
  const histogram = new Float64Array(256);
  for (const v of values) histogram[v] = (histogram[v] ?? 0) + 1;
  const total = values.length;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * (histogram[v] ?? 0);
  let sumDark = 0;
  let countDark = 0;
  let best = 0;
  let bestVariance = -1;
  for (let t = 0; t < 256; t++) {
    countDark += histogram[t] ?? 0;
    if (countDark === 0) continue;
    const countLight = total - countDark;
    if (countLight === 0) break;
    sumDark += t * (histogram[t] ?? 0);
    const meanDark = sumDark / countDark;
    const meanLight = (sumAll - sumDark) / countLight;
    const variance = countDark * countLight * (meanDark - meanLight) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/**
 * Removes ink that is not text: connected components that reach out of the detector's text box (`keep`, in crop
 * coordinates) unless they are glyph-sized marks next to it or mostly inside it, and specks (far smaller than any
 * punctuation mark) outside the box or away from the text's body. Balloon outlines, caption frames and
 * panel borders reach into the padded crop from outside, and their ink would bridge the gaps between lines.
 * `glyph` is the unit's glyph height.
 */
export function cleanMask(mask: InkMask, keep: Box, glyph: number): InkMask {
  const { width, height, ink } = mask;
  const out = new Uint8Array(ink);
  const seen = new Uint8Array(ink.length);
  const queue = new Int32Array(ink.length);
  const component: number[] = [];
  const tentative: number[][] = [];
  const body: Box = { x1: width, y1: height, x2: 0, y2: 0 };
  for (let start = 0; start < ink.length; start++) {
    if (ink[start] !== 1 || seen[start] === 1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    component.length = 0;
    let border = false;
    let x1 = width;
    let y1 = height;
    let x2 = -1;
    let y2 = -1;
    let inside = 0;
    while (head < tail) {
      const p = queue[head++] ?? 0;
      component.push(p);
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
      if (x >= keep.x1 && x < keep.x2 && y >= keep.y1 && y < keep.y2) inside += 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const q = ny * width + nx;
          if (ink[q] === 1 && seen[q] === 0) {
            seen[q] = 1;
            queue[tail++] = q;
          }
        }
      }
    }
    const speck = component.length < Math.max(4, (glyph * 0.08) ** 2);
    const fullyInside = inside === component.length;
    const glyphSized = x2 - x1 + 1 <= glyph * 1.3 && y2 - y1 + 1 <= glyph * 1.3;
    if (!speck && !border && fullyInside) {
      // The text's body: what lies wholly in the box.
      body.x1 = Math.min(body.x1, x1);
      body.y1 = Math.min(body.y1, y1);
      body.x2 = Math.max(body.x2, x2 + 1);
      body.y2 = Math.max(body.y2, y2 + 1);
      continue;
    }
    // Kept if they sit by the body: specks inside the box (the dot of a "!", "…"), glyph-sized marks next to it
    // (punctuation below a tight box) and glyphs cut by the crop's edge that lie mostly in the box.
    if ((speck && fullyInside) || (!speck && glyphSized && (!border || inside >= component.length * 0.5))) {
      tentative.push([...component]);
      continue;
    }
    for (const p of component) out[p] = 0;
  }
  const margin = Math.max(2, glyph * 0.25);
  for (const pixels of tentative) {
    const near = pixels.every((p) => {
      const x = p % width;
      const y = (p - x) / width;
      return x >= body.x1 - margin && x < body.x2 + margin && y >= body.y1 - margin && y < body.y2 + margin;
    });
    if (!near) for (const p of pixels) out[p] = 0;
  }
  return { width, height, ink: out };
}

/** Length of the horizontal (or vertical) run of ink each pixel belongs to (0 for background). */
function runLengths(mask: InkMask, horizontal: boolean): Uint32Array {
  const { width, height, ink } = mask;
  const out = new Uint32Array(ink.length);
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const at = (o: number, i: number): number => (horizontal ? o * width + i : i * width + o);
  for (let o = 0; o < outer; o++) {
    let start = -1;
    for (let i = 0; i <= inner; i++) {
      const on = i < inner && ink[at(o, i)] === 1;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        for (let k = start; k < i; k++) out[at(o, k)] = i - start;
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Erases thin straight lines: ink in a horizontal or vertical run longer than `maxRun` (or than 85% of the crop
 * across that axis) that is at most `maxThick` thick (caption frames, panel borders). No stroke of a glyph is that
 * long, and such rules would join lines and the glyphs next to them. Filled areas (a sign's board) are not thin.
 */
export function removeRules(mask: InkMask, maxRun: number, maxThick: number): InkMask {
  const { width, height, ink } = mask;
  const horizontal = runLengths(mask, true);
  const vertical = runLengths(mask, false);
  const limitH = Math.max(8, Math.round(Math.min(maxRun, width * 0.85)));
  const limitV = Math.max(8, Math.round(Math.min(maxRun, height * 0.85)));
  const thick = Math.max(2, Math.round(maxThick));
  const out = new Uint8Array(ink);
  for (let i = 0; i < ink.length; i++) {
    if (ink[i] !== 1) continue;
    const h = horizontal[i] ?? 0;
    const v = vertical[i] ?? 0;
    if ((h > limitH && v <= thick) || (v > limitV && h <= thick)) out[i] = 0;
  }
  return { width, height, ink: out };
}

/** Share of the class's pixels in its largest 8-connected component (1 for an empty class). */
export function largestShare(mask: InkMask): number {
  const { width, height, ink } = mask;
  const seen = new Uint8Array(ink.length);
  const queue = new Int32Array(ink.length);
  let total = 0;
  let largest = 0;
  for (let start = 0; start < ink.length; start++) {
    if (ink[start] !== 1 || seen[start] === 1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const p = queue[head++] ?? 0;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const q = ny * width + nx;
          if (ink[q] === 1 && seen[q] === 0) {
            seen[q] = 1;
            queue[tail++] = q;
          }
        }
      }
    }
    total += tail;
    if (tail > largest) largest = tail;
  }
  return total === 0 ? 1 : largest / total;
}

/**
 * The text of a crop as ink. Of the two Otsu classes (each without its thin rules, removeRules), the background is
 * one large connected region and the text many small glyphs, so the class whose largest component holds the smaller
 * share of its pixels is the text: dark text on a light balloon, light text on a dark sign. What reaches into the
 * crop from outside the text box is then removed (cleanMask). `keep` is the detector's text box in crop coordinates
 * and `glyph` the unit's glyph height.
 */
export function textMask(image: ImageDataLike, keep: Box, glyph: number): InkMask {
  return textInk(image, keep, glyph).mask;
}

/**
 * textMask, plus the crop with what the cleaning removed (outlines, frames, screentone) painted over in the
 * background colour (the mean of the non-text class), for the recognizer's line images.
 */
export function textInk(
  image: ImageDataLike,
  keep: Box,
  glyph: number,
): { mask: InkMask; image: ImageDataLike } {
  const { width, height } = image;
  const gray = luminance(image);
  const threshold = otsuThreshold(gray);
  const dark = new Uint8Array(width * height);
  const light = new Uint8Array(width * height);
  for (let i = 0; i < dark.length; i++) {
    const isDark = (gray[i] ?? 0) <= threshold;
    dark[i] = isDark ? 1 : 0;
    light[i] = isDark ? 0 : 1;
  }
  const darkMask = removeRules({ width, height, ink: dark }, glyph * 2.2, glyph * 0.2);
  const lightMask = removeRules({ width, height, ink: light }, glyph * 2.2, glyph * 0.2);
  const darkText = largestShare(darkMask) <= largestShare(lightMask);
  const mask = cleanMask(darkText ? darkMask : lightMask, keep, glyph);
  const textClass = darkText ? dark : light;
  const bg = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < textClass.length; i++) {
    if (textClass[i] === 1) continue;
    for (let c = 0; c < 3; c++) bg[c] = (bg[c] ?? 0) + (image.data[i * 4 + c] ?? 0);
    count += 1;
  }
  const fill = bg.map((sum) => (count === 0 ? 255 : Math.round(sum / count)));
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < textClass.length; i++) {
    if (textClass[i] !== 1 || mask.ink[i] === 1) continue;
    data[i * 4] = fill[0] ?? 255;
    data[i * 4 + 1] = fill[1] ?? 255;
    data[i * 4 + 2] = fill[2] ?? 255;
  }
  return { mask, image: { width, height, data } };
}

/** Gaps between consecutive spans. */
function gapsOf(spans: readonly Span[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < spans.length; i++) gaps.push((spans[i]?.start ?? 0) - (spans[i - 1]?.end ?? 0));
  return gaps.sort((a, b) => a - b);
}

function medianThickness(spans: readonly Span[]): number {
  const sizes = spans.map((span) => span.end - span.start).sort((a, b) => a - b);
  return sizes[Math.floor((sizes.length - 1) / 2)] ?? 0;
}

/**
 * Lines or columns, from the ink. With one run of ink across one axis, the block is either one line (the run is
 * about a glyph thick, its other axis holds the characters) or several lines whose characters merge in the other
 * profile (the run is many glyphs long). With several runs both ways, the axis with the wider gaps separates the
 * lines (leading and column gutters are wider than the space between characters). Falls back to `hint` (the
 * detector's guess) when the ink cannot tell.
 */
export function inferOrientation(mask: InkMask, hint: "h" | "v"): "h" | "v" {
  const options = { minInk: 1, minGap: 2, minRatio: 0.35 };
  const rows = profileSpans(inkProfile(mask, "h"), options);
  const columns = profileSpans(inkProfile(mask, "v"), options);
  if (rows.length === 0 || columns.length === 0) return hint;
  if (rows.length === 1 && columns.length === 1) return hint;
  if (rows.length === 1) {
    // One row of ink: a single horizontal line, unless it is several times taller than the columns are wide.
    const ratio = ((rows[0]?.end ?? 0) - (rows[0]?.start ?? 0)) / Math.max(1, medianThickness(columns));
    return ratio <= 1.6 ? "h" : ratio >= 3 ? "v" : hint;
  }
  if (columns.length === 1) {
    const ratio = ((columns[0]?.end ?? 0) - (columns[0]?.start ?? 0)) / Math.max(1, medianThickness(rows));
    return ratio <= 1.6 ? "v" : ratio >= 3 ? "h" : hint;
  }
  // Several runs both ways. Runs across the lines are one glyph thick; runs along them hold whole words when the
  // characters do not line up, so a set of runs more than twice as thick is the reading axis.
  const rowThickness = medianThickness(rows);
  const columnThickness = medianThickness(columns);
  if (columnThickness > rowThickness * 2) return "h";
  if (rowThickness > columnThickness * 2) return "v";
  // Characters aligned across lines (a CJK grid): the lines are the axis with fewer runs (a comic line holds more
  // characters than a balloon holds lines) unless the other axis has clearly wider gaps.
  const rowGap = gapsOf(rows)[Math.floor((rows.length - 1) / 2)] ?? 0;
  const columnGap = gapsOf(columns)[Math.floor((columns.length - 1) / 2)] ?? 0;
  const rowGapWider = rowGap > columnGap * 1.2;
  const columnGapWider = columnGap > rowGap * 1.2;
  if (rows.length < columns.length && !columnGapWider) return "h";
  if (columns.length < rows.length && !rowGapWider) return "v";
  if (rows.length === columns.length && rowGapWider) return "h";
  if (rows.length === columns.length && columnGapWider) return "v";
  return hint;
}

export interface Span {
  start: number;
  end: number;
}

/** Ink per row ("h": lines are stacked top to bottom) or per column ("v": columns side by side). */
export function inkProfile(mask: InkMask, orientation: "h" | "v"): Uint32Array {
  const { width, height, ink } = mask;
  const profile = new Uint32Array(orientation === "h" ? height : width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (ink[y * width + x] === 1) {
        const at = orientation === "h" ? y : x;
        profile[at] = (profile[at] ?? 0) + 1;
      }
    }
  }
  return profile;
}

/**
 * Runs of inked rows (or columns) of a profile: positions with at least `minInk` ink, gaps shorter than `minGap`
 * bridged, then runs thinner than `minRatio` × the thickest one merged into their nearest neighbour (accents,
 * dots of "…" and "!" above or below the body of a line).
 */
export function profileSpans(
  profile: ArrayLike<number>,
  options: { minInk: number; minGap: number; minRatio: number },
): Span[] {
  let spans: Span[] = [];
  let open = -1;
  for (let i = 0; i <= profile.length; i++) {
    const inked = i < profile.length && (profile[i] ?? 0) >= options.minInk;
    if (inked && open < 0) open = i;
    if (!inked && open >= 0) {
      spans.push({ start: open, end: i });
      open = -1;
    }
  }
  const bridged: Span[] = [];
  for (const span of spans) {
    const last = bridged[bridged.length - 1];
    if (last !== undefined && span.start - last.end < options.minGap) last.end = span.end;
    else bridged.push({ ...span });
  }
  spans = bridged;
  for (;;) {
    if (spans.length < 2) break;
    const thickest = Math.max(...spans.map((s) => s.end - s.start));
    const index = spans.findIndex((s) => s.end - s.start < options.minRatio * thickest);
    if (index < 0) break;
    const span = spans[index] as Span;
    const before = spans[index - 1];
    const after = spans[index + 1];
    const gapBefore = before === undefined ? Number.POSITIVE_INFINITY : span.start - before.end;
    const gapAfter = after === undefined ? Number.POSITIVE_INFINITY : after.start - span.end;
    if (gapBefore <= gapAfter && before !== undefined) before.end = span.end;
    else if (after !== undefined) after.start = span.start;
    spans.splice(index, 1);
  }
  return spans;
}

/** The ink's bounding box inside a band of the mask, or null when the band is empty. */
function inkBounds(mask: InkMask, band: Box): Box | null {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = -1;
  let y2 = -1;
  for (let y = band.y1; y < band.y2; y++) {
    for (let x = band.x1; x < band.x2; x++) {
      if (mask.ink[y * mask.width + x] !== 1) continue;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x + 1 > x2) x2 = x + 1;
      if (y + 1 > y2) y2 = y + 1;
    }
  }
  return x2 < 0 ? null : { x1, y1, x2, y2 };
}

/**
 * Lines (orientation "h", top to bottom) or columns ("v", right to left) of a binarized text box, as boxes in mask
 * coordinates trimmed to their ink and padded by a fraction of their thickness.
 */
export function segmentLines(mask: InkMask, orientation: "h" | "v"): Box[] {
  const along = orientation === "h" ? mask.width : mask.height;
  const profile = inkProfile(mask, orientation);
  const spans = profileSpans(profile, {
    minInk: Math.max(1, Math.round(along * 0.004)),
    minGap: 2,
    minRatio: 0.35,
  });
  const boxes: Box[] = [];
  for (const span of spans) {
    const band: Box =
      orientation === "h"
        ? { x1: 0, y1: span.start, x2: mask.width, y2: span.end }
        : { x1: span.start, y1: 0, x2: span.end, y2: mask.height };
    const bounds = inkBounds(mask, band);
    if (bounds === null) continue;
    const thickness = orientation === "h" ? bounds.y2 - bounds.y1 : bounds.x2 - bounds.x1;
    if (thickness < 3) continue;
    const pad = Math.max(2, Math.round(thickness * 0.15));
    boxes.push({
      x1: Math.max(0, bounds.x1 - pad),
      y1: Math.max(0, bounds.y1 - pad),
      x2: Math.min(mask.width, bounds.x2 + pad),
      y2: Math.min(mask.height, bounds.y2 + pad),
    });
  }
  return orientation === "v" ? boxes.reverse() : boxes;
}

/* ------------------------------------------------------------------ recognizer input */

/** A sub-rectangle of an RGBA image, rotated 90° counter-clockwise when `rotate` (vertical columns). */
export function cropRgba(image: ImageDataLike, box: Box, rotate: boolean): ImageDataLike {
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const outW = rotate ? h : w;
  const outH = rotate ? w : h;
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((box.y1 + y) * image.width + box.x1 + x) * 4;
      // Counter-clockwise: the column's top goes to the left, its right side to the top.
      const dx = rotate ? y : x;
      const dy = rotate ? w - 1 - x : y;
      const dst = (dy * outW + dx) * 4;
      data[dst] = image.data[src] ?? 0;
      data[dst + 1] = image.data[src + 1] ?? 0;
      data[dst + 2] = image.data[src + 2] ?? 0;
      data[dst + 3] = 255;
    }
  }
  return { width: outW, height: outH, data };
}

/** Runs taller than a character (two glyphs touching) cut at their thinnest row near the middle. */
function splitTall(runs: readonly Span[], profile: readonly number[], glyph: number): Span[] {
  const out: Span[] = [];
  const queue = [...runs];
  for (let run = queue.shift(); run !== undefined; run = queue.shift()) {
    if (run.end - run.start <= glyph * 1.6) {
      out.push(run);
      continue;
    }
    let cut = -1;
    let least = Number.POSITIVE_INFINITY;
    for (let y = run.start + Math.round(glyph * 0.6); y < run.end - Math.round(glyph * 0.3); y++) {
      if ((profile[y] ?? 0) < least) {
        least = profile[y] ?? 0;
        cut = y;
      }
    }
    if (cut <= run.start || cut >= run.end) {
      out.push(run);
      continue;
    }
    out.push({ start: run.start, end: cut });
    queue.unshift({ start: cut, end: run.end });
  }
  return out;
}

/**
 * A vertical column as a horizontal line of upright characters: the column's ink is cut into character cells along
 * its length (ink runs grouped up to about one glyph, so 二 or small kana stay whole) and the cells are laid side by
 * side on the column's background. Small kana and punctuation keep their size, which the rotated column loses.
 */
export function stackColumn(image: ImageDataLike, mask: InkMask, column: Box): ImageDataLike {
  const bounds = inkBounds(mask, column) ?? column;
  const glyph = Math.max(4, bounds.x2 - bounds.x1);
  const rows: number[] = [];
  for (let y = column.y1; y < column.y2; y++) {
    let count = 0;
    for (let x = column.x1; x < column.x2; x++) count += mask.ink[y * mask.width + x] ?? 0;
    rows.push(count);
  }
  const runs = splitTall(profileSpans(rows, { minInk: 1, minGap: 1, minRatio: 0 }), rows, glyph);
  const cells: Span[] = [];
  for (const run of runs) {
    const last = cells[cells.length - 1];
    if (last !== undefined && run.end - last.start <= glyph * 1.1) last.end = run.end;
    else cells.push({ ...run });
  }
  // Background: mean colour of the column's non-ink pixels.
  const bg = [0, 0, 0];
  let bgCount = 0;
  for (let y = column.y1; y < column.y2; y++) {
    for (let x = column.x1; x < column.x2; x++) {
      if (mask.ink[y * mask.width + x] === 1) continue;
      const p = (y * image.width + x) * 4;
      for (let c = 0; c < 3; c++) bg[c] = (bg[c] ?? 0) + (image.data[p + c] ?? 0);
      bgCount += 1;
    }
  }
  const fill = bg.map((sum) => (bgCount === 0 ? 255 : Math.round(sum / bgCount)));
  const side = Math.max(glyph + 4, Math.round(glyph * 1.25));
  const width = Math.max(1, cells.length) * side;
  const data = new Uint8ClampedArray(width * side * 4);
  for (let i = 0; i < width * side; i++) {
    data[i * 4] = fill[0] ?? 255;
    data[i * 4 + 1] = fill[1] ?? 255;
    data[i * 4 + 2] = fill[2] ?? 255;
    data[i * 4 + 3] = 255;
  }
  const cellW = column.x2 - column.x1;
  cells.forEach((cell, k) => {
    const h = Math.min(side, cell.end - cell.start);
    const w = Math.min(side, cellW);
    const offY = Math.floor((side - h) / 2);
    const offX = k * side + Math.floor((side - w) / 2);
    const srcX = column.x1 + Math.floor((cellW - w) / 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = ((column.y1 + cell.start + y) * image.width + srcX + x) * 4;
        const dst = ((offY + y) * width + offX + x) * 4;
        data[dst] = image.data[src] ?? 0;
        data[dst + 1] = image.data[src + 1] ?? 0;
        data[dst + 2] = image.data[src + 2] ?? 0;
      }
    }
  });
  return { width, height: side, data };
}

/**
 * Fixes what upright cells do to vertical-only glyphs: the vertical ellipsis reads as a colon at the end of a column,
 * and the vertical long-vowel mark as a bar between kana.
 */
export function fixVerticalText(text: string): string {
  return text
    .replace(/[:：︙⋮]+$/u, "…")
    .replace(
      /(?<=[\p{Script=Hiragana}\p{Script=Katakana}])[|｜lI1丨](?=[\p{Script=Hiragana}\p{Script=Katakana}]|$)/gu,
      "ー",
    );
}

/** Width a line gets at the recognizer's height (aspect kept), before padding. */
export function recWidth(width: number, height: number): number {
  return Math.min(REC_MAX_WIDTH, Math.max(1, Math.ceil((REC_HEIGHT * width) / Math.max(1, height))));
}

/** Tensor width for a batch whose widest line is `widest`: at least REC_MIN_WIDTH, a multiple of the step. */
export function batchWidth(widest: number): number {
  return Math.min(
    Math.ceil(REC_MAX_WIDTH / REC_WIDTH_STEP) * REC_WIDTH_STEP,
    Math.max(REC_MIN_WIDTH, Math.ceil(widest / REC_WIDTH_STEP) * REC_WIDTH_STEP),
  );
}

/**
 * Writes one line into a [N, 3, 48, W] tensor at batch index `n`: bilinear resize to 48 × recWidth, BGR, normalized
 * to [-1, 1]; the rest of the row stays 0 (PaddleOCR's padding).
 */
export function writeRecInput(line: ImageDataLike, tensor: Float32Array, n: number, width: number): void {
  const H = REC_HEIGHT;
  const plane = H * width;
  const base = n * 3 * plane;
  const outW = Math.min(width, recWidth(line.width, line.height));
  const sx = line.width / outW;
  const sy = line.height / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(line.height - 1, Math.floor(fy));
    const y1 = Math.min(line.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < outW; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(line.width - 1, Math.floor(fx));
      const x1 = Math.min(line.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p00 = line.data[(y0 * line.width + x0) * 4 + c] ?? 0;
        const p01 = line.data[(y0 * line.width + x1) * 4 + c] ?? 0;
        const p10 = line.data[(y1 * line.width + x0) * 4 + c] ?? 0;
        const p11 = line.data[(y1 * line.width + x1) * 4 + c] ?? 0;
        const v = (p00 * (1 - wx) + p01 * wx) * (1 - wy) + (p10 * (1 - wx) + p11 * wx) * wy;
        // RGBA channel c → BGR plane 2 - c.
        tensor[base + (2 - c) * plane + y * width + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  }
}

/* ------------------------------------------------------------------ text */

/** Scripts written without spaces between words: their lines are joined without a separator. */
export function joinsWithoutSpace(lang: Lang): boolean {
  return lang === "ja" || lang === "zh";
}

/** The recognized lines of one unit as one text: CJK lines joined directly, others with a space; hyphen breaks kept. */
export function joinLines(lines: readonly string[], lang: Lang): string {
  const parts = lines.map((line) => line.trim()).filter((line) => line !== "");
  if (joinsWithoutSpace(lang)) return parts.join("");
  return parts.reduce((text, line) => {
    if (text === "") return line;
    // "WON-" + "DERFUL" is one word broken by the letterer.
    if (/\p{L}-$/u.test(text) && /^\p{Ll}|^\p{Lu}{2}/u.test(line)) return text.slice(0, -1) + line;
    return `${text} ${line}`;
  }, "");
}

const HANGUL = /\p{Script=Hangul}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;

/** Character counts by script, for the language vote over a recognized sample. */
export function scriptCounts(text: string): { hangul: number; kana: number; han: number; latin: number } {
  const counts = { hangul: 0, kana: 0, han: 0, latin: 0 };
  for (const char of text) {
    if (HANGUL.test(char)) counts.hangul += 1;
    else if (KANA.test(char)) counts.kana += 1;
    else if (HAN.test(char)) counts.han += 1;
    else if (LATIN.test(char)) counts.latin += 1;
  }
  return counts;
}

const SPANISH_MARKS = /[¿¡ñÑáéíóúÁÉÍÓÚ]/u;
const SPANISH_WORDS =
  /\b(?:EL|LA|LOS|LAS|QUE|DE|DEL|EN|ES|ESTE|ESTA|UN|UNA|NO|SI|SÍ|POR|PARA|CON|ME|TE|SE|LO|YA|MUY|PERO|OTRA|VEZ|Y)\b/giu;
const ENGLISH_WORDS =
  /\b(?:THE|YOU|I|IS|ARE|TO|AND|OF|IN|IT|THIS|THAT|MY|WE|WHAT|DO|DON'T|I'M|IT'S|AT|FOR|ON|BE|WAIT|ONLY)\b/giu;

/** English or Spanish for Latin-script text: accents and inverted marks, else common function words. */
export function latinLanguage(text: string): "en" | "es" {
  if (SPANISH_MARKS.test(text)) return "es";
  const spanish = text.match(SPANISH_WORDS)?.length ?? 0;
  const english = text.match(ENGLISH_WORDS)?.length ?? 0;
  return spanish > english ? "es" : "en";
}

/**
 * Comic lettering is often all capitals, which translation models handle badly: such Latin text is turned into
 * sentence case ("WAIT, I FORGOT!" → "Wait, I forgot!"); text with lower-case letters is left as it is.
 */
export function sentenceCase(text: string): string {
  const letters = [...text].filter((char) => /\p{L}/u.test(char) && LATIN.test(char));
  if (letters.length < 2) return text;
  const upper = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase()).length;
  if (upper / letters.length < 0.8) return text;
  let out = "";
  let start = true;
  for (const char of text.toLowerCase()) {
    if (start && /\p{L}/u.test(char)) {
      out += char.toUpperCase();
      start = false;
    } else {
      out += char;
    }
    if (/[.!?¿¡…]/u.test(char)) start = true;
  }
  // The pronoun "I" and its contractions stay capitalized.
  return out.replace(/\bi\b(?=$|[\s'’.,!?…])/gu, "I");
}
