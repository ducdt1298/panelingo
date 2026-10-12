// Vietnamese text fitting. PURE and deterministic: the caller injects measure(text, px) (canvas measureText with the
// very font the DOM renders with, after document.fonts has loaded it; a fake in Node tests) and the font's metrics.
// Coordinates are natural px of the image; the overlay scales them with a CSS transform.
//
// 1. Normalise: NFC, every breakable white-space run becomes one space (no-break spaces stay inside their token).
// 2. Tokenise at spaces, so a Vietnamese syllable is never split. A token made only of closing punctuation
//    glues to the previous token ("sao ?" → "sao?"), one made only of opening punctuation to the next ("“ Anh" →
//    "“Anh"); a lone ASCII quote opens or closes by parity; a closing token at the very start stays with the next
//    token, space kept ("… thôi" is one unbreakable token). A token with more than 9 letters (never a syllable: a
//    Vietnamese syllable has at most 7) may also break after its own hyphens or slashes ("tài-khoản-bí-mật-").
//    Japanese and Chinese are written without spaces: a token holding Han, kana or full-width punctuation may break
//    between any two characters next to one of them (no hyphen), except before characters that may not start a line
//    (closing brackets, 、。！？…, small kana, ー) and after characters that may not end one (opening brackets): the
//    basic kinsoku rules. Runs of Latin letters and digits inside such a token stay whole; Korean breaks at spaces.
// 3. Line geometry for n lines at px: line box L = lineHeight·px; the block n·L is centred in the region. Each
//    line's ink band is the font's content area, exactly the box Range.getClientRects() reports in the DOM:
//    (ascent + descent)·px centred in its line box (CSS half-leading), or with metrics.pixelSnap Chrome's own
//    rounding: ascent and descent rounded to whole px, L to 1/64 px, the content area
//    floor((L − ascent − descent)/2) px below the line top (Blink LayoutNG CalculateLeadingSpace). The target is the
//    ellipse (or rect) inscribed in the region inset by `inset` per side: a = w(1 − 2·inset)/2, b = h(1 − 2·inset)/2.
//    Line i may be 2a·sqrt(1 − (dy/b)²)·safety wide, dy = the band edge farthest from the centre (rect: 2a·safety).
//    Infeasible when n·L > 2b or a band reaches b. Chrome rounds on the DEVICE pixel grid: at a layout zoom ≠ 1
//    (Windows display scaling, browser zoom: window.devicePixelRatio) it lays the line out at px·zoom, so the
//    pixelSnap model takes `zoom` (measured: a CSS-px model is up to 1 px off at 125% and 150%).
// 4. Line breaks: DP over the break opportunities for exactly n non-empty lines, minimising Σ(1 − W/width)² (squared
//    relative slack: a balanced, balloon-shaped block) subject to W ≤ width. O(n·T·k), k = tokens per line.
// 5. Size: the largest px on the grid {minPx} ∪ {k·stepPx : minPx < k·stepPx ≤ maxPx} (and below the height cap)
//    that has a layout, by binary search; at that px the fewest lines win. Feasibility is monotone in px for the
//    continuous line model (smaller text only gains room); with pixelSnap the whole-px rounding of ascent, descent
//    and half-leading can leave a feasible size just above an infeasible one, which the search may miss (stress
//    run: 0.4% of fits, ≤ 0.5 px smaller than the best grid size; the result always fits).
// 6. Overflow chain when nothing fits at minPx (shrink to the minimum size first, cut with "…" only as the last
//    resort), every step at minPx unless chain.fullSearch: (1) loosen the inset in the same shape: an ellipse to
//    inset 0 (the whole fit region, which the engine keeps 7% inside the bubble), a rect to 0.04; ellipse → rect
//    only with chain.ellipseToRect (measured: 22/22 such fits left the region's ellipse, by 15-43 px); (2) break tokens
//    with more than 9 letters between letters too (Intl.Segmenter graphemes, at least 2 letters per side) with a
//    "-" at the line end: only names, SFX and the like, never a syllable; (3) only when `chain.bounds` is given:
//    grow the region 15% per side (30% sideways for tall narrow regions), kept clear of `chain.obstacles` (other
//    units) and clipped to the bounds; rect; halo; (4) in the loosest frame of the asked shape (cut text has no
//    reason to leave the bubble too): as many lines as fit, filled greedily, the last one ending in "…"; overflow =
//    true; the full text stays readable in the transcript (a bubble popup is not implemented yet).
//
// 7. Vertical text (fitTextVertical: writing-mode vertical-rl, text-orientation mixed): the same layout in a mirrored
//    transposition of the region, lines becoming columns that run top to bottom and stack right to left. A column's
//    length is the sum of vertical advances: 1 em per upright character (CJK, full-width forms), the measured width
//    of sideways runs (Latin letters, digits); columns × line-height must fit the region's width.
//
// Also here: relayout/harmonise (page harmonisation; horizontal results only), fontSizeLimits (11 CSS px floor,
// 30 CSS px and 1.15 × glyph ceiling) and lineHeightFromInk (line-height from measured ink).

import { area, height, inter, width } from "../geometry.ts";
import type { Box } from "../types.ts";

export type FitShape = "ellipse" | "rect";
/** Overflow-chain step that produced a result: 0 as asked, 1 looser inset, 2 letter breaks, 3 grown, 4 ellipsis. */
export type FitStep = 0 | 1 | 2 | 3 | 4;
/** Advance width in px of `text` set at `fontPx` in the font the DOM uses. Must grow with fontPx. */
export type Measure = (text: string, fontPx: number) => number;

/** Font metrics in em (multiples of the font size). */
export interface FontMetrics {
  /** CSS line-height as a multiple of the font size. */
  lineHeight: number;
  /**
   * Ascent and descent as CSS lays out lines: canvas fontBoundingBoxAscent / fontBoundingBoxDescent ÷ px, measured
   * at a large size (1000 px) because Chrome reports them rounded to whole px.
   */
  ascent: number;
  descent: number;
  /**
   * Reproduce Chrome's line layout exactly (set it for text rendered in Chrome's DOM). Chrome lays a line out in
   * device px (CSS px × the layout zoom, see FitOptions.zoom): ascent and descent rounded to whole device px, the
   * line-height to 1/64 device px, the content area floor(half-leading) device px below the line top. Without it
   * the content area of a line can sit up to 1.5 px higher than modelled.
   */
  pixelSnap?: boolean;
}

/** One line box at a font size (CSS px): height, where the content area starts in it, its height, the ascent. */
interface LineBox {
  lh: number;
  off: number;
  band: number;
  ascent: number;
}

/**
 * The font size Chrome takes ascent and descent from at a layout zoom: px·zoom in float32, cut to 1/100 px (its
 * font cache keys sizes by ⌊size·100⌋). Checked on Chrome 154: its line boxes match it at zoom 0.5-2 on the
 * 0.25 px grid, and at 5200 of 5201 off-grid sizes per font (the miss errs large, which is safe); the exact size
 * misses 37 (Patrick Hand) and 16 (Mali) of them by a device px.
 */
function metricSize(px: number, zoom: number): number {
  return Math.floor(Math.fround(Math.fround(Math.fround(px) * Math.fround(zoom)) * 100)) / 100;
}

function lineBoxAt(px: number, m: FontMetrics, zoom = 1): LineBox {
  if (m.pixelSnap === true) {
    // The CSS line-height the overlay sets (FitResult.lineHeightPx) sits on the 1/64 px grid; Chrome converts it to
    // device px (LayoutUnit: nearest 1/64) and lays the line out at px·zoom with whole-px ascent and descent.
    const lh = Math.round(m.lineHeight * px * 64) / 64;
    const lhDevice = Math.round(lh * zoom * 64) / 64;
    const size = metricSize(px, zoom);
    const ascent = Math.round(m.ascent * size);
    const band = ascent + Math.round(m.descent * size);
    // LayoutUnit arithmetic: (L − height) / 2 truncates to 1/64 px, then floors to a whole device px.
    const half = Math.trunc(Math.round((lhDevice - band) * 64) / 2) / 64;
    return { lh, off: Math.floor(half) / zoom, band: band / zoom, ascent: ascent / zoom };
  }
  const lh = m.lineHeight * px;
  const band = (m.ascent + m.descent) * px;
  return { lh, off: (lh - band) / 2, band, ascent: m.ascent * px };
}

/** fitText's model of one rendered line at px (CSS px, relative to the top of the line's box). */
export interface LineBoxModel {
  /** Line box height: the CSS line-height to render with (FitResult.lineHeightPx). */
  lineHeight: number;
  /** Content area (what Range.getClientRects() reports): top and height. */
  contentTop: number;
  contentHeight: number;
  baseline: number;
}

/** The line box fitText assumes at px for these metrics and layout zoom (FitOptions.zoom). */
export function lineBox(px: number, metrics: FontMetrics, zoom = 1): LineBoxModel {
  if (!(zoom > 0) || !Number.isFinite(zoom))
    throw new RangeError("lineBox: zoom must be a finite number > 0");
  const b = lineBoxAt(px, metrics, zoom);
  return { lineHeight: b.lh, contentTop: b.off, contentHeight: b.band, baseline: b.off + b.ascent };
}

/** Added to lineHeightFromInk: at the bare ink line-height, descenders touch stacked marks below. */
export const COLLISION_LEADING = 0.05;

/**
 * Patrick Hand 400 (@fontsource 5.3.0, latin + vietnamese) as Chrome 154 lays it out: ascent/descent
 * 1.042/0.312 em; line-height = lineHeightFromInk(1.0156, 0.3125) = 1.378, + COLLISION_LEADING.
 */
export const PATRICK_HAND_METRICS: Readonly<FontMetrics> = {
  lineHeight: 1.428,
  ascent: 1.042,
  descent: 0.312,
  pixelSnap: true,
};

/** Mali 400 (@fontsource 5.3.0) the same way: 1.05/0.25 em, lineHeightFromInk(1.1094, 0.2656) = 1.425 + 0.05. */
export const MALI_METRICS: Readonly<FontMetrics> = {
  lineHeight: 1.475,
  ascent: 1.05,
  descent: 0.25,
  pixelSnap: true,
};

export const FIT_DEFAULTS = {
  shape: "ellipse",
  minPx: 11,
  maxPx: 40,
  inset: 0.07,
  safety: 0.97,
  stepPx: 0.25,
  maxLines: 14,
  ellipsis: "…",
  hyphen: "-",
  /** Tokens with more letters (graphemes holding a letter or digit) than this may be broken in step 2. */
  longTokenGraphemes: 9,
  /** Step 1 inset of an ellipse region (0 = the whole fit region, which the engine keeps inside the bubble). */
  ellipseInset: 0,
  /** Step 1 inset of a rect region, and the inset of step 3's grown rect. */
  rectInset: 0.04,
  /** Step 3 growth per side as a fraction of the region size; sideways growth for tall narrow regions. */
  grow: 0.15,
  growTall: 0.3,
  /** A region is tall and narrow when h > tallAspect × w. */
  tallAspect: 1.5,
} as const;

/** Overflow chain steps 1-3 (step 4, the ellipsis, always runs last). */
export interface FitChain {
  /** Step 1 for an ellipse: the same ellipse with this smaller inset; null skips. Default 0. */
  ellipseInset?: number | null;
  /** Step 1 for a rect: the same rect with this smaller inset; null skips. Also step 3's inset. Default 0.04. */
  rectInset?: number | null;
  /**
   * Alternative step 1 for an ellipse: a rect with rectInset instead of the looser ellipse. Its corners can leave
   * an elliptical bubble (measured with fullSearch: 22/22 fits at line-height 1.378 and 21/21 at 1.428
   * put a line corner 15-43 px, horizontally, outside the region's ellipse). Default false.
   */
  ellipseToRect?: boolean;
  /** Step 2: break tokens longer than longTokenGraphemes letters. Default true. */
  breakLongTokens?: boolean;
  /** Step 3 runs only with bounds: the image (or seam canvas) the grown region is clipped to. */
  bounds?: Box;
  /** Other units' boxes: the grown region never reaches into them. */
  obstacles?: readonly Box[];
  grow?: number;
  growTall?: number;
  tallAspect?: number;
  /**
   * Steps 1-3 search sizes up to maxPx like step 0. Default false: they stay at minPx, so the size is continuous
   * where step 0 gives up (more text never comes out larger) and a fallback block is as small as possible.
   */
  fullSearch?: boolean;
}

export interface FitOptions {
  measure: Measure;
  shape?: FitShape;
  /** Default PATRICK_HAND_METRICS. */
  metrics?: FontMetrics;
  /**
   * Layout zoom, device px per CSS px where the lines are laid out: window.devicePixelRatio (display scaling ×
   * browser zoom) times any CSS zoom on the overlay's ancestors. Only metrics.pixelSnap uses it: Chrome rounds line
   * boxes on the device-pixel grid. CSS transforms (the overlay's natural → rendered scale) do not count. Default 1.
   */
  zoom?: number;
  minPx?: number;
  maxPx?: number;
  /** Inset per side of the target ellipse/rect inside the region, as a fraction of the region size. */
  inset?: number;
  /** Lines may use this fraction of their chord (absorbs canvas-vs-DOM measuring differences). */
  safety?: number;
  stepPx?: number;
  maxLines?: number;
  ellipsis?: string;
  hyphen?: string;
  longTokenGraphemes?: number;
  /** Overflow chain steps 1-3; false goes straight from step 0 to the ellipsis. */
  chain?: FitChain | false;
}

export interface FitLine {
  text: string;
  /** Advance width of the whole line at fontPx. */
  width: number;
  /** Width this line may use: its chord × safety. */
  maxWidth: number;
  /** Left edge of the centred line and top of its line box. */
  x: number;
  y: number;
  /** Alphabetic baseline (CSS half-leading; Chrome's rounding with pixelSnap). */
  baseline: number;
}

export interface FitResult {
  /** The normalised text (NFC, single spaces), complete even when `overflow` cut the lines. */
  text: string;
  fontPx: number;
  lineHeightPx: number;
  /** Target shape, region (grown by step 3) and inset the lines were laid out in. */
  shape: FitShape;
  region: Box;
  inset: number;
  lines: FitLine[];
  /** Union of the line boxes; null without lines. */
  bounds: Box | null;
  step: FitStep;
  /** The text was cut and its last line ends with the ellipsis. */
  overflow: boolean;
  /** The text may leave the bubble (step 3 grew the region): draw a halo. */
  halo: boolean;
  /** A line break falls inside a long token (after its own hyphen or slash, or a step-2 letter break). */
  hyphenated: boolean;
  /**
   * fitTextVertical: the lines are columns, right to left. A column's x, y are the left and top of its box, which
   * is lineHeightPx wide; its width is its length (top to bottom) and its baseline the column's centre x.
   */
  vertical?: true;
}

/** Ellipse (or rect) a block is laid out in, for lineWidths. */
export interface LineFrame {
  /** Semi-axes of the target (after the inset). */
  a: number;
  b: number;
  shape: FitShape;
  safety: number;
  metrics: FontMetrics;
  /** Layout zoom for metrics.pixelSnap (FitOptions.zoom); default 1. */
  zoom?: number;
}

/** How a piece attaches to the previous one: a breakable space, a break after the token's own hyphen or slash,
 * a break inside a word that adds a hyphen at the line end, or a break between CJK characters (nothing added). */
export type PieceJoin = "space" | "break" | "hyphen" | "cjk";
export interface TokenPiece {
  text: string;
  join: PieceJoin;
}

const EPS = 1e-9;
/** Every white-space run except no-break spaces (U+00A0, U+2007, U+202F). */
const BREAKABLE_SPACE = /[^\S\u00A0\u2007\u202F]+/gu;
const CLOSE = /^[\p{Pe}\p{Pf}!?.,;:…%‰」』、。！？~]+$/u;
const OPEN = /^[\p{Ps}\p{Pi}「『¡¿]+$/u;
const QUOTES = /^"+$/u;
const LETTER = /[\p{L}\p{N}]/u;
/** A long token may break after these (no hyphen added). */
const OWN_BREAK = /^[-\u2010\u2013/_]$/u;
/** Dropped before the ellipsis. */
const TAIL_PUNCT = /[\s,;:.…\-\u2010\u2013\u2014、。，]+$/u;
/** Characters written without spaces: a line may break next to them (Han, kana, CJK and full-width punctuation). */
const CJK_BREAKABLE =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Bopomofo}\u3000-\u303f\u30fb\u30fc\uff01-\uff60\uffe0-\uffe6]/u;
/** Kinsoku: never at the start of a line (closing brackets and quotes, sentence marks, small kana, ー, 々). */
const NO_LINE_START =
  /[\p{Pe}\p{Pf}、。，．・：；？！ー…‥々〻ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ\u31f0-\u31ff.,:;!?%‰]/u;
/** Kinsoku: never at the end of a line (opening brackets and quotes). */
const NO_LINE_END = /[\p{Ps}\p{Pi}¡¿]/u;

/** NFC, one space per breakable white-space run, trimmed. */
export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(BREAKABLE_SPACE, " ").trim();
}

/** Break units: space-separated tokens with punctuation glued (see the header). */
export function tokenize(text: string): string[] {
  const s = normalizeText(text);
  if (s === "") return [];
  const out: string[] = [];
  let pre = "";
  let quotes = 0;
  for (const t of s.split(" ")) {
    const quoteOnly = QUOTES.test(t);
    const closer = quoteOnly ? quotes % 2 === 1 : CLOSE.test(t);
    const opener = quoteOnly ? quotes % 2 === 0 : OPEN.test(t);
    quotes += t.split('"').length - 1;
    const last = out.length - 1;
    if (closer && last >= 0 && pre === "") {
      out[last] = (out[last] ?? "") + t;
    } else if (opener) {
      pre += t;
    } else if (closer && last < 0) {
      pre += `${t} `;
    } else {
      out.push(pre + t);
      pre = "";
    }
  }
  if (pre !== "") {
    const tail = pre.trimEnd();
    const last = out.length - 1;
    if (last >= 0) out[last] = (out[last] ?? "") + tail;
    else out.push(tail);
  }
  return out;
}

let segmenter: Intl.Segmenter | null = null;

/** User-perceived characters (a letter with all of its marks is one). */
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter("vi", { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/**
 * Break opportunities inside a token with more than `maxLetters` letters: after its own hyphens, dashes or slashes
 * ("break"; used from step 0, no syllable is split), and with `letterBreaks` (step 2) inside a part that is still
 * too long, between two letters with at least 2 letters on each side ("hyphen"). Tokens of ≤ maxLetters letters
 * (every Vietnamese syllable) come back whole. The first piece has join "space".
 */
export function splitLongToken(
  token: string,
  maxLetters: number = FIT_DEFAULTS.longTokenGraphemes,
  letterBreaks = true,
): TokenPiece[] {
  const gs = graphemes(token);
  const letter = gs.map((g) => LETTER.test(g));
  const countLetters = (from: number, to: number): number => {
    let c = 0;
    for (let k = from; k < to; k++) if (letter[k] === true) c++;
    return c;
  };
  if (countLetters(0, gs.length) <= maxLetters) return [{ text: token, join: "space" }];
  const pieces: TokenPiece[] = [];
  let start = 0;
  let join: PieceJoin = "space";
  const flush = (end: number): void => {
    const total = countLetters(start, end);
    let cut = start;
    if (letterBreaks && total > maxLetters) {
      let before = 0;
      for (let k = start + 1; k < end; k++) {
        if (letter[k - 1] === true) before++;
        if (letter[k - 1] === true && letter[k] === true && before >= 2 && total - before >= 2) {
          pieces.push({ text: gs.slice(cut, k).join(""), join: cut === start ? join : "hyphen" });
          cut = k;
        }
      }
    }
    pieces.push({ text: gs.slice(cut, end).join(""), join: cut === start ? join : "hyphen" });
    join = "break";
    start = end;
  };
  for (let k = 0; k < gs.length - 1; k++) {
    if (OWN_BREAK.test(gs[k] ?? "")) flush(k + 1);
  }
  if (start < gs.length) flush(gs.length);
  return pieces;
}

/** The token holds Japanese or Chinese text (Han, kana, CJK punctuation): it breaks between characters. */
export function hasCjkBreaks(token: string): boolean {
  return CJK_BREAKABLE.test(token);
}

/** A line may break between graphemes a and b (CJK text, see the header). */
export function cjkBreakBetween(a: string, b: string): boolean {
  if (!CJK_BREAKABLE.test(a) && !CJK_BREAKABLE.test(b)) return false;
  return !NO_LINE_START.test(b) && !NO_LINE_END.test(a);
}

/** A CJK token split at every allowed break (join "cjk"); the first piece has join "space". */
export function splitCjkToken(token: string): TokenPiece[] {
  const gs = graphemes(token);
  const pieces: TokenPiece[] = [];
  let start = 0;
  for (let k = 1; k < gs.length; k++) {
    if (!cjkBreakBetween(gs[k - 1] ?? "", gs[k] ?? "")) continue;
    pieces.push({ text: gs.slice(start, k).join(""), join: start === 0 ? "space" : "cjk" });
    start = k;
  }
  pieces.push({ text: gs.slice(start).join(""), join: start === 0 ? "space" : "cjk" });
  return pieces;
}

/**
 * Widths of the n lines of a block set at px, top to bottom, or null when the block does not fit vertically.
 * Ellipse: each line's ink band (its content area, see FontMetrics) must stay inside, so lines get narrower
 * towards the top and bottom. Rect: every line gets 2a·safety.
 */
export function lineWidths(n: number, px: number, f: LineFrame): number[] | null {
  const zoom = f.zoom ?? 1;
  if (!(n >= 1) || !(px > 0) || !(f.a > 0) || !(f.b > 0) || !(zoom > 0) || !Number.isFinite(zoom))
    return null;
  const { lh, off, band } = lineBoxAt(px, f.metrics, zoom);
  const blockH = n * lh;
  if (blockH > 2 * f.b * (1 + EPS)) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const top = -blockH / 2 + i * lh + off;
    const dy = Math.max(Math.abs(top), Math.abs(top + band));
    if (f.shape === "rect") {
      if (dy > f.b * (1 + EPS)) return null;
      out.push(2 * f.a * f.safety);
    } else {
      if (dy >= f.b) return null;
      out.push(2 * f.a * Math.sqrt(1 - (dy / f.b) ** 2) * f.safety);
    }
  }
  return out;
}

/** Piece widths at one px with prefix sums: width(i, j) of pieces i..j-1 set on one line. */
interface Sized {
  count: number;
  /** prefix[k] = Σ_{m<k} (piece m + the space before it). */
  prefix: Float64Array;
  /** Space width before piece m (join "space", m ≥ 1). */
  space: Float64Array;
  /** Hyphen width added when a line ends right before piece m (join "hyphen"). */
  hyphen: Float64Array;
  widest: number;
}

type Meter = (text: string, px: number) => number;

function makeMeter(measure: Measure): Meter {
  const memo = new Map<number, Map<string, number>>();
  return (text, px) => {
    let byText = memo.get(px);
    if (byText === undefined) {
      byText = new Map();
      memo.set(px, byText);
    }
    let w = byText.get(text);
    if (w === undefined) {
      w = measure(text, px);
      byText.set(text, w);
    }
    return w;
  };
}

function sizeAt(pieces: readonly TokenPiece[], px: number, meter: Meter, hyphen: string): Sized {
  const count = pieces.length;
  const prefix = new Float64Array(count + 1);
  const space = new Float64Array(count + 1);
  const hyph = new Float64Array(count + 1);
  const spaceW = meter(" ", px);
  const hyphenW = meter(hyphen, px);
  let acc = 0;
  let widest = 0;
  pieces.forEach((p, m) => {
    const w = meter(p.text, px);
    widest = Math.max(widest, w);
    if (m > 0 && p.join === "space") space[m] = spaceW;
    if (m > 0 && p.join === "hyphen") hyph[m] = hyphenW;
    acc += w + (space[m] ?? 0);
    prefix[m + 1] = acc;
  });
  return { count, prefix, space, hyphen: hyph, widest };
}

/** Width of pieces i..j-1 on one line without a trailing hyphen; never decreases as i decreases or j grows. */
function baseWidth(z: Sized, i: number, j: number): number {
  return (z.prefix[j] ?? 0) - (z.prefix[i] ?? 0) - (z.space[i] ?? 0);
}

function lineWidth(z: Sized, i: number, j: number): number {
  return baseWidth(z, i, j) + (j < z.count ? (z.hyphen[j] ?? 0) : 0);
}

/** Line ends (exclusive piece index per line) of the balanced layout on exactly widths.length lines, or null. */
function balance(z: Sized, widths: readonly number[]): number[] | null {
  const n = widths.length;
  const count = z.count;
  if (count < n || n === 0) return null;
  const stride = count + 1;
  const cost = new Float64Array((n + 1) * stride).fill(Infinity);
  const from = new Int32Array((n + 1) * stride).fill(-1);
  cost[0] = 0;
  for (let l = 1; l <= n; l++) {
    const limit = widths[l - 1] ?? 0;
    for (let j = l; j <= count - (n - l); j++) {
      let best = Infinity;
      let arg = -1;
      for (let i = j - 1; i >= l - 1; i--) {
        const w = lineWidth(z, i, j);
        if (w > limit) break;
        const prev = cost[(l - 1) * stride + i] ?? Infinity;
        if (prev === Infinity) continue;
        const slack = 1 - w / limit;
        const c = prev + slack * slack;
        if (c < best) {
          best = c;
          arg = i;
        }
      }
      cost[l * stride + j] = best;
      from[l * stride + j] = arg;
    }
  }
  if ((cost[n * stride + count] ?? Infinity) === Infinity) return null;
  const ends = new Array<number>(n).fill(0);
  let j = count;
  for (let l = n; l >= 1; l--) {
    ends[l - 1] = j;
    j = from[l * stride + j] ?? -1;
  }
  return ends;
}

/**
 * Balanced line breaks for plain tokens (widths tw, one space of width sw between neighbours) on exactly
 * widths.length lines: [start, end, width] per line (end exclusive), or null when no layout fits.
 */
export function breakBalanced(
  tw: readonly number[],
  sw: number,
  widths: readonly number[],
): Array<[number, number, number]> | null {
  const count = tw.length;
  const prefix = new Float64Array(count + 1);
  const space = new Float64Array(count + 1);
  let acc = 0;
  tw.forEach((w, m) => {
    if (m > 0) space[m] = sw;
    acc += w + (space[m] ?? 0);
    prefix[m + 1] = acc;
  });
  const z: Sized = {
    count,
    prefix,
    space,
    hyphen: new Float64Array(count + 1),
    widest: Math.max(0, ...tw),
  };
  const ends = balance(z, widths);
  if (ends === null) return null;
  let start = 0;
  return ends.map((end) => {
    const line: [number, number, number] = [start, end, lineWidth(z, start, end)];
    start = end;
    return line;
  });
}

interface ResolvedChain {
  ellipseInset: number | null;
  rectInset: number | null;
  ellipseToRect: boolean;
  breakLongTokens: boolean;
  bounds: Box | null;
  obstacles: readonly Box[];
  grow: number;
  growTall: number;
  tallAspect: number;
  fullSearch: boolean;
}

interface Resolved {
  measure: Measure;
  shape: FitShape;
  metrics: FontMetrics;
  zoom: number;
  bandEm: number;
  minPx: number;
  maxPx: number;
  inset: number;
  safety: number;
  stepPx: number;
  maxLines: number;
  ellipsis: string;
  hyphen: string;
  longTokenGraphemes: number;
  chain: ResolvedChain | null;
}

function resolve(opts: FitOptions): Resolved {
  const metrics = opts.metrics ?? PATRICK_HAND_METRICS;
  const bandEm = metrics.ascent + metrics.descent;
  const minPx = opts.minPx ?? FIT_DEFAULTS.minPx;
  const stepPx = opts.stepPx ?? FIT_DEFAULTS.stepPx;
  if (!(minPx > 0) || !(stepPx > 0)) throw new RangeError("fitText: minPx and stepPx must be > 0");
  if (!(metrics.lineHeight > 0) || !(bandEm > 0)) {
    throw new RangeError("fitText: lineHeight and ascent + descent must be > 0");
  }
  const zoom = opts.zoom ?? 1;
  if (!(zoom > 0) || !Number.isFinite(zoom))
    throw new RangeError("fitText: zoom must be a finite number > 0");
  const c = opts.chain;
  return {
    measure: opts.measure,
    shape: opts.shape ?? FIT_DEFAULTS.shape,
    metrics,
    zoom,
    bandEm,
    minPx,
    maxPx: Math.max(minPx, opts.maxPx ?? FIT_DEFAULTS.maxPx),
    inset: opts.inset ?? FIT_DEFAULTS.inset,
    safety: opts.safety ?? FIT_DEFAULTS.safety,
    stepPx,
    maxLines: Math.max(1, Math.floor(opts.maxLines ?? FIT_DEFAULTS.maxLines)),
    ellipsis: opts.ellipsis ?? FIT_DEFAULTS.ellipsis,
    hyphen: opts.hyphen ?? FIT_DEFAULTS.hyphen,
    longTokenGraphemes: opts.longTokenGraphemes ?? FIT_DEFAULTS.longTokenGraphemes,
    chain:
      c === false
        ? null
        : {
            ellipseInset: c?.ellipseInset === undefined ? FIT_DEFAULTS.ellipseInset : c.ellipseInset,
            rectInset: c?.rectInset === undefined ? FIT_DEFAULTS.rectInset : c.rectInset,
            ellipseToRect: c?.ellipseToRect ?? false,
            breakLongTokens: c?.breakLongTokens ?? true,
            bounds: c?.bounds ?? null,
            obstacles: c?.obstacles ?? [],
            grow: c?.grow ?? FIT_DEFAULTS.grow,
            growTall: c?.growTall ?? FIT_DEFAULTS.growTall,
            tallAspect: c?.tallAspect ?? FIT_DEFAULTS.tallAspect,
            fullSearch: c?.fullSearch ?? false,
          },
  };
}

interface Frame {
  region: Box;
  shape: FitShape;
  inset: number;
  grown: boolean;
  cx: number;
  cy: number;
  a: number;
  b: number;
}

function frameOf(region: Box, shape: FitShape, inset: number, grown: boolean): Frame {
  return {
    region,
    shape,
    inset,
    grown,
    cx: (region.x1 + region.x2) / 2,
    cy: (region.y1 + region.y2) / 2,
    a: (width(region) * (1 - 2 * inset)) / 2,
    b: (height(region) * (1 - 2 * inset)) / 2,
  };
}

function lineFrame(frame: Frame, o: Resolved): LineFrame {
  return { a: frame.a, b: frame.b, shape: frame.shape, safety: o.safety, metrics: o.metrics, zoom: o.zoom };
}

interface Layout {
  px: number;
  frame: Frame;
  pieces: readonly TokenPiece[];
  widths: number[];
  ends: number[];
}

/** The layout with the fewest lines at px, or null. */
function layoutAt(
  pieces: readonly TokenPiece[],
  px: number,
  frame: Frame,
  o: Resolved,
  meter: Meter,
): Layout | null {
  const count = pieces.length;
  const widest = 2 * frame.a * o.safety;
  if (count === 0 || !(widest > 0)) return null;
  const z = sizeAt(pieces, px, meter, o.hyphen);
  if (z.widest > widest) return null;
  const lf = lineFrame(frame, o);
  const spaceW = meter(" ", px);
  // n lines drop at most n − 1 spaces, so n ≥ (total + space) / (widest + space).
  const first = Math.max(1, Math.ceil((lineWidth(z, 0, count) + spaceW) / (widest + spaceW) - EPS));
  for (let n = first; n <= Math.min(o.maxLines, count); n++) {
    const widths = lineWidths(n, px, lf);
    if (widths === null) return null;
    const ends = balance(z, widths);
    if (ends !== null) return { px, frame, pieces, widths, ends };
  }
  return null;
}

/** Largest grid px ≤ maxPx with a layout (binary search), or null when even minPx fails. */
function searchSize(
  pieces: readonly TokenPiece[],
  frame: Frame,
  maxPx: number,
  o: Resolved,
  meter: Meter,
): Layout | null {
  // No single line fits above this size (+2 device px of slack: pixel-snapped boxes round, and Chrome's metric size
  // is cut to 1/100 px); lineWidths decides exactly, a loose cap only costs a search step.
  const cap = (2 * frame.b + 2 / Math.min(1, o.zoom)) / Math.max(o.metrics.lineHeight, o.bandEm);
  const top = Math.min(maxPx, cap);
  const k0 = Math.floor(o.minPx / o.stepPx + EPS) + 1;
  const kTop = Math.floor(top / o.stepPx + EPS);
  const count = 1 + Math.max(0, kTop - k0 + 1);
  const pxAt = (i: number): number => (i === 0 ? o.minPx : (k0 + i - 1) * o.stepPx);
  const fit = (i: number): Layout | null => layoutAt(pieces, pxAt(i), frame, o, meter);
  let best = fit(0);
  if (best === null || count === 1) return best;
  let lo = 0;
  let hi = count - 1;
  const atTop = fit(hi);
  if (atTop !== null) return atTop;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    const r = fit(mid);
    if (r !== null) {
      best = r;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function lineText(pieces: readonly TokenPiece[], i: number, j: number, hyphen: string | null): string {
  let s = "";
  for (let k = i; k < j; k++) {
    const p = pieces[k];
    if (p === undefined) break;
    if (k > i && p.join === "space") s += " ";
    s += p.text;
  }
  if (hyphen !== null && pieces[j]?.join === "hyphen") s += hyphen;
  return s;
}

function boundsOf(lines: readonly FitLine[], lineHeightPx: number): Box | null {
  let b: Box | null = null;
  for (const l of lines) {
    const box = { x1: l.x, y1: l.y, x2: l.x + l.width, y2: l.y + lineHeightPx };
    b =
      b === null
        ? box
        : {
            x1: Math.min(b.x1, box.x1),
            y1: Math.min(b.y1, box.y1),
            x2: Math.max(b.x2, box.x2),
            y2: Math.max(b.y2, box.y2),
          };
  }
  return b;
}

interface Placed {
  text: string;
  /** Line slot in the block (0 = top). */
  slot: number;
  maxWidth: number;
}

function assemble(
  text: string,
  px: number,
  frame: Frame,
  slots: number,
  placed: readonly Placed[],
  step: FitStep,
  flags: { overflow: boolean; hyphenated: boolean },
  o: Resolved,
  meter: Meter,
): FitResult {
  const box = lineBoxAt(px, o.metrics, o.zoom);
  const lh = box.lh;
  const top = frame.cy - (slots * lh) / 2;
  const baseline = box.off + box.ascent;
  const lines = placed.map((p): FitLine => {
    const w = meter(p.text, px);
    const y = top + p.slot * lh;
    return { text: p.text, width: w, maxWidth: p.maxWidth, x: frame.cx - w / 2, y, baseline: y + baseline };
  });
  return {
    text,
    fontPx: px,
    lineHeightPx: lh,
    shape: frame.shape,
    region: frame.region,
    inset: frame.inset,
    lines,
    bounds: boundsOf(lines, lh),
    step,
    overflow: flags.overflow,
    halo: frame.grown,
    hyphenated: flags.hyphenated,
  };
}

function fromLayout(layout: Layout, text: string, step: FitStep, o: Resolved, meter: Meter): FitResult {
  const { pieces, ends, widths } = layout;
  let start = 0;
  let hyphenated = false;
  const placed = ends.map((end, slot): Placed => {
    if (end < pieces.length && wordBreak(pieces[end]?.join)) hyphenated = true;
    const p = { text: lineText(pieces, start, end, o.hyphen), slot, maxWidth: widths[slot] ?? 0 };
    start = end;
    return p;
  });
  return assemble(
    text,
    layout.px,
    layout.frame,
    ends.length,
    placed,
    step,
    { overflow: false, hyphenated },
    o,
    meter,
  );
}

/** The longest start of pieces i..j-1 (then of piece i's graphemes) that fits `limit` with the ellipsis. */
function withEllipsis(
  pieces: readonly TokenPiece[],
  i: number,
  j: number,
  limit: number,
  px: number,
  o: Resolved,
  meter: Meter,
): string {
  const close = (s: string): string => s.replace(TAIL_PUNCT, "") + o.ellipsis;
  for (let k = j; k > i; k--) {
    const s = close(lineText(pieces, i, k, null));
    if (meter(s, px) <= limit) return s;
  }
  const gs = graphemes(pieces[i]?.text ?? "");
  for (let k = gs.length - 1; k > 0; k--) {
    const s = close(gs.slice(0, k).join(""));
    if (meter(s, px) <= limit) return s;
  }
  return meter(o.ellipsis, px) <= limit ? o.ellipsis : "";
}

/** Step 4: minPx, as many lines as fit, filled greedily; the last one ends with the ellipsis when text is left. */
function ellipsize(
  pieces: readonly TokenPiece[],
  frame: Frame,
  text: string,
  o: Resolved,
  meter: Meter,
): FitResult {
  const px = o.minPx;
  const lf = lineFrame(frame, o);
  let widths: number[] | null = null;
  for (let n = 1; n <= o.maxLines; n++) {
    const w = lineWidths(n, px, lf);
    if (w === null) break;
    widths = w;
  }
  // Not even one line fits vertically: one centred line anyway.
  widths ??= [Math.max(0, 2 * frame.a * o.safety)];
  const z = sizeAt(pieces, px, meter, o.hyphen);
  const count = pieces.length;
  const placed: Placed[] = [];
  let overflow = false;
  let hyphenated = false;
  let i = 0;
  for (let slot = 0; slot < widths.length && i < count; slot++) {
    const limit = widths[slot] ?? 0;
    let j = i;
    for (let k = i + 1; k <= count; k++) {
      if (baseWidth(z, i, k) > limit) break;
      if (lineWidth(z, i, k) <= limit) j = k;
    }
    if (j === count) {
      placed.push({ text: lineText(pieces, i, j, o.hyphen), slot, maxWidth: limit });
      i = j;
    } else if (slot < widths.length - 1) {
      // Nothing fits on a narrow line: leave it empty and try the next one.
      if (j === i) continue;
      if (wordBreak(pieces[j]?.join)) hyphenated = true;
      placed.push({ text: lineText(pieces, i, j, o.hyphen), slot, maxWidth: limit });
      i = j;
    } else {
      const s = withEllipsis(pieces, i, j, limit, px, o, meter);
      if (s !== "") placed.push({ text: s, slot, maxWidth: limit });
      overflow = true;
      i = count;
    }
  }
  if (i < count) overflow = true;
  return assemble(text, px, frame, widths.length, placed, 4, { overflow, hyphenated }, o, meter);
}

/** A break that splits a word (after its own hyphen or slash, or with an added hyphen), not a space or CJK break. */
function wordBreak(join: PieceJoin | undefined): boolean {
  return join === "break" || join === "hyphen";
}

/**
 * Tokens as pieces: CJK tokens split between characters; long tokens after their own separators, and between
 * letters with letterBreaks.
 */
function piecesOf(tokens: readonly string[], maxLetters: number, letterBreaks: boolean): TokenPiece[] {
  return tokens.flatMap((t) =>
    hasCjkBreaks(t) ? splitCjkToken(t) : splitLongToken(t, maxLetters, letterBreaks),
  );
}

/** Step 3 region: grown per side, kept clear of obstacles (never smaller than the region), clipped to bounds. */
function grownRegion(region: Box, c: ResolvedChain): Box {
  const w = width(region);
  const h = height(region);
  const gx = (h > c.tallAspect * w ? c.growTall : c.grow) * w;
  const gy = c.grow * h;
  let g: Box = { x1: region.x1 - gx, y1: region.y1 - gy, x2: region.x2 + gx, y2: region.y2 + gy };
  for (const ob of c.obstacles) {
    if (inter(ob, g) <= 0 || inter(ob, region) > 0) continue;
    const cuts: Box[] = [];
    if (ob.x2 <= region.x1) cuts.push({ ...g, x1: Math.max(g.x1, ob.x2) });
    if (ob.x1 >= region.x2) cuts.push({ ...g, x2: Math.min(g.x2, ob.x1) });
    if (ob.y2 <= region.y1) cuts.push({ ...g, y1: Math.max(g.y1, ob.y2) });
    if (ob.y1 >= region.y2) cuts.push({ ...g, y2: Math.min(g.y2, ob.y1) });
    let best: Box | null = null;
    for (const cut of cuts) if (best === null || area(cut) > area(best)) best = cut;
    if (best !== null) g = best;
  }
  const b = c.bounds;
  if (b === null) return g;
  return {
    x1: Math.min(region.x1, Math.max(g.x1, b.x1)),
    y1: Math.min(region.y1, Math.max(g.y1, b.y1)),
    x2: Math.max(region.x2, Math.min(g.x2, b.x2)),
    y2: Math.max(region.y2, Math.min(g.y2, b.y2)),
  };
}

function emptyResult(text: string, frame: Frame): FitResult {
  return {
    text,
    fontPx: 0,
    lineHeightPx: 0,
    shape: frame.shape,
    region: frame.region,
    inset: frame.inset,
    lines: [],
    bounds: null,
    step: 0,
    overflow: false,
    halo: false,
    hyphenated: false,
  };
}

/** Fits `text` into `region` (natural px), running the overflow chain when needed. Never throws on content. */
export function fitText(text: string, region: Box, opts: FitOptions): FitResult {
  const o = resolve(opts);
  const meter = makeMeter(o.measure);
  const norm = normalizeText(text);
  const tokens = tokenize(norm);
  const asked = frameOf(region, o.shape, o.inset, false);
  if (tokens.length === 0) return emptyResult(norm, asked);
  let frame = asked;
  let pieces = piecesOf(tokens, o.longTokenGraphemes, false);
  const c = o.chain;
  const attempt = (step: FitStep): FitResult | null => {
    const maxPx = step === 0 || c?.fullSearch === true ? o.maxPx : o.minPx;
    const layout = searchSize(pieces, frame, maxPx, o, meter);
    return layout === null ? null : fromLayout(layout, norm, step, o, meter);
  };
  const first = attempt(0);
  if (first !== null) return first;
  // Step 4 uses the loosest frame of the asked shape: once the text is cut it has no reason to leave the bubble.
  let loosest = asked;
  if (c !== null) {
    const loose = looserFrame(region, asked, c);
    if (loose !== null) {
      frame = loose;
      if (loose.shape === asked.shape) loosest = loose;
      const r = attempt(1);
      if (r !== null) return r;
    }
    if (c.breakLongTokens) {
      const broken = piecesOf(tokens, o.longTokenGraphemes, true);
      if (broken.length > pieces.length) {
        pieces = broken;
        const r = attempt(2);
        if (r !== null) return r;
      }
    }
    if (c.bounds !== null) {
      frame = frameOf(grownRegion(region, c), "rect", c.rectInset ?? o.inset, true);
      const r = attempt(3);
      if (r !== null) return r;
    }
  }
  return ellipsize(pieces, loosest, norm, o, meter);
}

/** Step 1 frame: the asked shape with a smaller inset (a rect with ellipseToRect); null when not looser. */
function looserFrame(region: Box, asked: Frame, c: ResolvedChain): Frame | null {
  if (asked.shape === "ellipse" && c.ellipseToRect) {
    return c.rectInset === null ? null : frameOf(region, "rect", c.rectInset, false);
  }
  const inset = asked.shape === "ellipse" ? c.ellipseInset : c.rectInset;
  return inset !== null && inset < asked.inset ? frameOf(region, asked.shape, inset, false) : null;
}

/** Lays `text` out at exactly fontPx in the requested shape (no size search, no chain); null when it does not fit. */
export function layoutText(text: string, region: Box, fontPx: number, opts: FitOptions): FitResult | null {
  const o = resolve(opts);
  const meter = makeMeter(o.measure);
  const norm = normalizeText(text);
  const tokens = tokenize(norm);
  const frame = frameOf(region, o.shape, o.inset, false);
  if (tokens.length === 0) return emptyResult(norm, frame);
  const layout = layoutAt(piecesOf(tokens, o.longTokenGraphemes, false), fontPx, frame, o, meter);
  return layout === null ? null : fromLayout(layout, norm, 0, o, meter);
}

/** Re-lays a result out at fontPx in the same region, shape and inset (and broken tokens after step 2), or null. */
export function relayout(result: FitResult, fontPx: number, opts: FitOptions): FitResult | null {
  const o = resolve(opts);
  const meter = makeMeter(o.measure);
  const tokens = tokenize(result.text);
  if (tokens.length === 0) return null;
  const letterBreaks = result.step >= 2 && o.chain !== null && o.chain.breakLongTokens;
  const pieces = piecesOf(tokens, o.longTokenGraphemes, letterBreaks);
  const frame = frameOf(result.region, result.shape, result.inset, result.halo);
  const layout = layoutAt(pieces, fontPx, frame, o, meter);
  const step: FitStep = result.step === 4 ? 0 : result.step;
  return layout === null ? null : fromLayout(layout, result.text, step, o, meter);
}

/* ------------------------------------------------------------------ vertical text */

/**
 * Columns of upright CJK text (vertical-rl): the em box centred in its column (ascent = descent = 0.5 em, the
 * central baseline), columns 1.25 em apart. Chrome's vertical line boxes are not pixel-snapped like horizontal ones.
 */
export const VERTICAL_METRICS: Readonly<FontMetrics> = {
  lineHeight: 1.25,
  ascent: 0.5,
  descent: 0.5,
  pixelSnap: false,
};

/** Upright in vertical-rl with text-orientation: mixed (1 em advance): CJK scripts and full-width forms. */
const UPRIGHT =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Bopomofo}\u3000-\u303f\u30fb\u30fc\ufe10-\ufe4f\uff01-\uff60\uffe0-\uffe6]/u;

/**
 * Advance of `text` down a vertical-rl column (text-orientation: mixed): 1 em per upright character, plus the
 * measured width of each sideways run (Latin letters, digits and other characters, set rotated).
 */
export function verticalMeasure(measure: Measure): Measure {
  return (text, px) => {
    let total = 0;
    let run = "";
    for (const ch of text) {
      if (!UPRIGHT.test(ch)) {
        run += ch;
        continue;
      }
      if (run !== "") total += measure(run, px);
      run = "";
      total += px;
    }
    return run === "" ? total : total + measure(run, px);
  };
}

/**
 * The mirrored transposition that turns columns into lines: x → y and y → s − x, s = x1 + x2 of the region, so
 * lines laid out top to bottom become columns right to left. Its own inverse is columnsToPage.
 */
export function pageToColumns(b: Box, s: number): Box {
  return { x1: b.y1, y1: s - b.x2, x2: b.y2, y2: s - b.x1 };
}

export function columnsToPage(b: Box, s: number): Box {
  return { x1: s - b.y2, y1: b.x1, x2: s - b.y1, y2: b.x2 };
}

/**
 * Fits `text` as vertical-rl columns into `region`: fitText (sizes, kinsoku breaks, overflow chain) in the
 * transposed region with vertical advances, then mapped back (see FitResult.vertical). Default metrics
 * VERTICAL_METRICS.
 */
export function fitTextVertical(text: string, region: Box, opts: FitOptions): FitResult {
  const s = region.x1 + region.x2;
  let chain: FitChain | false | undefined = opts.chain;
  if (chain !== undefined && chain !== false) {
    const { bounds, obstacles, ...rest } = chain;
    chain = { ...rest };
    if (bounds !== undefined) chain.bounds = pageToColumns(bounds, s);
    if (obstacles !== undefined) chain.obstacles = obstacles.map((b) => pageToColumns(b, s));
  }
  const inColumns = fitText(text, pageToColumns(region, s), {
    ...opts,
    measure: verticalMeasure(opts.measure),
    metrics: opts.metrics ?? VERTICAL_METRICS,
    ...(chain === undefined ? {} : { chain }),
  });
  const lh = inColumns.lineHeightPx;
  const lines = inColumns.lines.map((l): FitLine => {
    const box = columnsToPage({ x1: l.x, y1: l.y, x2: l.x + l.width, y2: l.y + lh }, s);
    return {
      text: l.text,
      width: l.width,
      maxWidth: l.maxWidth,
      x: box.x1,
      y: box.y1,
      baseline: (box.x1 + box.x2) / 2,
    };
  });
  return {
    ...inColumns,
    region: columnsToPage(inColumns.region, s),
    lines,
    bounds: inColumns.bounds === null ? null : columnsToPage(inColumns.bounds, s),
    vertical: true,
  };
}

export const HARMONISE = {
  /** basePx = this percentile (nearest rank) of the basis units' sizes. */
  percentile: 0.4,
  /** Units at or above floor × basePx are capped at cap × basePx. */
  floor: 0.85,
  cap: 1.1,
} as const;

export interface HarmoniseItem {
  result: FitResult;
  /** Dialogue or thought: counts toward the base size. */
  basis: boolean;
}

/**
 * Page harmonisation, run once per image when its units are final: basePx = 40th percentile of the
 * basis units' fontPx; every unit at ≥ 0.85·basePx is re-laid out at min(fontPx, 1.1·basePx), keeping the old
 * result when that fails. Units with overflow or without lines are left alone. Returns results in input order.
 */
export function harmonise(items: readonly HarmoniseItem[], opts: FitOptions): FitResult[] {
  const sizes = items
    .filter((it) => it.basis && it.result.lines.length > 0 && !it.result.overflow)
    .map((it) => it.result.fontPx)
    .sort((p, q) => p - q);
  if (sizes.length === 0) return items.map((it) => it.result);
  const basePx = sizes[Math.max(0, Math.ceil(HARMONISE.percentile * sizes.length) - 1)] ?? 0;
  return items.map(({ result }) => {
    if (result.overflow || result.lines.length === 0 || result.fontPx < HARMONISE.floor * basePx) {
      return result;
    }
    const target = Math.min(result.fontPx, HARMONISE.cap * basePx);
    return target < result.fontPx ? (relayout(result, target, opts) ?? result) : result;
  });
}

export const SIZE_POLICY = {
  /** Never smaller than this on screen. */
  minCssPx: 11,
  maxCssPx: 30,
  /** Never larger than this × the original lettering. */
  glyphFactor: 1.15,
} as const;

/** minPx/maxPx in natural px for an image shown at `scale` = rendered / natural width. */
export function fontSizeLimits(scale: number, glyphPx: number | null): { minPx: number; maxPx: number } {
  const s = scale > 0 ? scale : 1;
  const minPx = SIZE_POLICY.minCssPx / s;
  const cap = SIZE_POLICY.maxCssPx / s;
  const maxPx =
    glyphPx !== null && glyphPx > 0 ? Math.min(cap, Math.max(minPx, SIZE_POLICY.glyphFactor * glyphPx)) : cap;
  return { minPx, maxPx };
}

/** Strings whose ink extents set the line-height. */
export const LINE_HEIGHT_PROBES = {
  ascent: "ẤẦẨẪẬẮẰẲẴẶẾỀỂỄỆỐỒỔỖỘỚỜỞỠỢỨỪỬỮỰ",
  descent: "gjpqyậệịọụỵ",
} as const;

/**
 * Line-height from ink measured at 100 px and divided by 100: clamp(ascent of LINE_HEIGHT_PROBES.ascent +
 * descent of LINE_HEIGHT_PROBES.descent + 0.05, 1.25, 1.45), plus 0.05 for upper-case lettering.
 */
export function lineHeightFromInk(inkAscentEm: number, inkDescentEm: number, uppercase = false): number {
  const lh = Math.min(1.45, Math.max(1.25, inkAscentEm + inkDescentEm + 0.05));
  return uppercase ? lh + 0.05 : lh;
}
