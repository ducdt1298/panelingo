import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  estimateGlyphPx,
  glyphPriorPx,
  glyphPxFromGray,
  orientationOf,
  otsuThreshold,
  unitOrientation,
} from "../../../src/shared/core/glyph.ts";
import type { Box } from "../../../src/shared/types.ts";

const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });

/** A grey image filled with `bg`, plus rectangles of `ink`. */
function image(w: number, h: number, bg: number, rects: Box[], ink: number): Uint8Array {
  const img = new Uint8Array(w * h).fill(bg);
  for (const r of rects) {
    for (let y = r.y1; y < r.y2; y++) img.fill(ink, y * w + r.x1, y * w + r.x2);
  }
  return img;
}

describe("orientation", () => {
  test("a box is vertical only when clearly taller than wide (h / w > 1.2)", () => {
    assert.equal(orientationOf(b(0, 0, 10, 30)), "v");
    assert.equal(orientationOf(b(0, 0, 30, 10)), "h");
    assert.equal(orientationOf(b(0, 0, 10, 12)), "h", "exactly 1.2 stays horizontal");
    assert.equal(orientationOf(b(0, 0, 10, 13)), "v");
    assert.equal(orientationOf(b(5, 0, 5, 40)), "h", "degenerate width");
    assert.equal(orientationOf(b(0, 0, 10, 13), 1.5), "h", "custom aspect");
  });

  test("a unit follows the area-weighted majority of its boxes", () => {
    const wideLine = b(0, 0, 100, 20); // 2000 px², horizontal
    const columns = [b(0, 0, 10, 30), b(20, 0, 30, 30)]; // 600 px², vertical
    assert.equal(unitOrientation([wideLine, ...columns]), "h");
    assert.equal(unitOrientation([b(0, 0, 30, 120), b(40, 0, 70, 100), wideLine]), "v");
    assert.equal(unitOrientation([]), "h");
  });

  test("allowVertical false forces horizontal (Korean webtoons, Latin)", () => {
    assert.equal(unitOrientation([b(0, 0, 30, 120)], { allowVertical: false }), "h");
  });
});

describe("estimateGlyphPx (geometry only)", () => {
  test("the prior is 3% of the short side", () => {
    assert.equal(glyphPriorPx({ w: 800, h: 12000 }), 24);
    assert.equal(glyphPriorPx({ w: 1200, h: 1800 }), 36);
  });

  test("without a prior every box is one line", () => {
    assert.equal(estimateGlyphPx([b(0, 0, 300, 32)], "h"), 32);
    assert.equal(estimateGlyphPx([b(0, 0, 30, 200)], "v"), 30);
  });

  test("with a prior a block's thickness snaps to a whole number of lines", () => {
    // Three lines of 25 px glyphs at pitch 1.3: 25 × 3.6 = 90 px.
    assert.equal(estimateGlyphPx([b(0, 0, 200, 90)], "h", { priorPx: 24 }), 25);
    // Four lines of 22 px: 22 × 4.9 = 107.8 px.
    assert.equal(estimateGlyphPx([b(0, 0, 160, 107.8)], "h", { priorPx: 24 }), 22);
    // A single line stays one line.
    assert.equal(estimateGlyphPx([b(0, 0, 300, 32)], "h", { priorPx: 24 }), 32);
    // Vertical columns use the width.
    assert.equal(estimateGlyphPx([b(0, 0, 90, 300)], "v", { priorPx: 24 }), 25);
  });

  test("a unit takes the median over its boxes", () => {
    assert.equal(estimateGlyphPx([b(0, 0, 100, 20), b(0, 30, 100, 52), b(0, 60, 100, 100)], "h"), 22);
    assert.equal(estimateGlyphPx([b(0, 0, 100, 20), b(0, 30, 100, 60)], "h"), 25);
  });

  test("results are clamped to [6, 400] and empty input gives the minimum", () => {
    assert.equal(estimateGlyphPx([b(0, 0, 50, 3)], "h"), 6);
    assert.equal(estimateGlyphPx([b(0, 0, 2000, 1000)], "h"), 400);
    assert.equal(estimateGlyphPx([], "h"), 6);
    assert.equal(estimateGlyphPx([b(0, 0, 50, 0)], "h"), 6, "zero-thickness boxes are skipped");
  });
});

describe("glyphPxFromGray (pixels)", () => {
  test("otsuThreshold splits a bimodal histogram between the modes", () => {
    const hist = new Array<number>(256).fill(0);
    hist[20] = 100;
    hist[220] = 300;
    const t = otsuThreshold(hist);
    assert.ok(t >= 20 && t < 220, `t = ${t}`);
    assert.equal(otsuThreshold(new Array<number>(256).fill(0)), 0);
  });

  test("three dark lines on white measure their height", () => {
    const lines = [b(20, 10, 180, 30), b(20, 40, 180, 60), b(20, 70, 180, 90)];
    const img = image(200, 100, 255, lines, 10);
    assert.equal(glyphPxFromGray(img, 200, 100, b(0, 0, 200, 100), "h"), 20);
  });

  test("light text on dark works the same (ink is the minority side)", () => {
    const lines = [b(20, 10, 180, 30), b(20, 40, 180, 60), b(20, 70, 180, 90)];
    const img = image(200, 100, 15, lines, 240);
    assert.equal(glyphPxFromGray(img, 200, 100, b(0, 0, 200, 100), "h"), 20);
  });

  test("vertical text uses the column profile", () => {
    const columns = [b(10, 20, 28, 180), b(40, 20, 58, 180), b(70, 20, 88, 180)];
    const img = image(100, 200, 255, columns, 0);
    assert.equal(glyphPxFromGray(img, 100, 200, b(0, 0, 100, 200), "v"), 18);
  });

  test("the 75th percentile ignores a thin furigana-like run", () => {
    const rows = [b(40, 5, 160, 11), b(40, 20, 160, 40), b(40, 50, 160, 70), b(40, 80, 160, 100)];
    const img = image(200, 200, 255, rows, 0);
    assert.equal(glyphPxFromGray(img, 200, 200, b(0, 0, 200, 200), "h"), 20);
  });

  test("ink is whichever side is the minority, so a mostly-ink box flips", () => {
    // 80% dark: the light gaps become the "ink" and the result tracks them, not the text.
    const img = image(100, 100, 0, [b(0, 30, 100, 40), b(0, 70, 100, 80)], 255);
    assert.equal(glyphPxFromGray(img, 100, 100, b(0, 0, 100, 100), "h"), 10);
  });

  test("runs separated by a 1-px gap merge", () => {
    const img = image(100, 50, 255, [b(10, 10, 90, 20), b(10, 21, 90, 31)], 0);
    assert.equal(glyphPxFromGray(img, 100, 50, b(0, 0, 100, 50), "h"), 21);
  });

  test("a flat box falls back to its short side; boxes are clipped to the image", () => {
    const flat = new Uint8Array(100 * 100).fill(200);
    assert.equal(glyphPxFromGray(flat, 100, 100, b(10, 10, 60, 40), "h"), 30);
    assert.equal(glyphPxFromGray(flat, 100, 100, b(90, 90, 300, 300), "h"), 10);
    assert.equal(glyphPxFromGray(flat, 100, 100, b(200, 200, 300, 300), "h"), 6, "empty after clipping");
    assert.throws(() => glyphPxFromGray(new Uint8Array(10), 100, 100, b(0, 0, 5, 5), "h"), RangeError);
  });
});
