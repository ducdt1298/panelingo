import assert from "node:assert/strict";
import { test } from "node:test";
import { COMIC_FONT_STACK, ROUND_FONT_STACK } from "../../../src/content/fonts.ts";
import {
  CAP_PROBE,
  FALLBACK_METRICS,
  MEASURE_CACHE_SIZE,
  createMeasure,
  fontShorthand,
  INK_PROBE,
  measureCapHeight,
  measureFontMetrics,
  measureInkHeight,
} from "../../../src/content/measure.ts";
import type { TextContext } from "../../../src/content/measure.ts";
import {
  COLLISION_LEADING,
  LINE_HEIGHT_PROBES,
  lineHeightFromInk,
} from "../../../src/shared/core/fit-text.ts";

interface Fake {
  ctx: TextContext;
  measured: string[];
  fonts: string[];
}

/** Canvas stand-in: 0.5 em per code point at the px in ctx.font; ink and font boxes in em × px. */
function fakeContext(em = { ascent: 1.042, descent: 0.312, inkAscent: 1.0156, inkDescent: 0.3125 }): Fake {
  const measured: string[] = [];
  const fonts: string[] = [];
  let font = "10px sans-serif";
  const ctx: TextContext = {
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
      fonts.push(value);
    },
    fontKerning: "auto",
    measureText(text: string) {
      measured.push(text);
      const px = Number(/ (\d+(?:\.\d+)?)px /.exec(font)?.[1] ?? "10");
      return {
        width: [...text].length * 0.5 * px,
        actualBoundingBoxAscent: em.inkAscent * px,
        actualBoundingBoxDescent: em.inkDescent * px,
        fontBoundingBoxAscent: em.ascent * px,
        fontBoundingBoxDescent: em.descent * px,
      };
    },
  };
  return { ctx, measured, fonts };
}

test("measures with the overlay's font list at the requested size, kerning on", () => {
  const f = fakeContext();
  const measure = createMeasure(COMIC_FONT_STACK, f.ctx);
  assert.equal(f.ctx.fontKerning, "normal");
  assert.equal(measure("Xin chào", 12.25), 8 * 0.5 * 12.25);
  assert.deepEqual(f.fonts, [`400 12.25px ${COMIC_FONT_STACK}`]);
  assert.equal(fontShorthand(20, '"A"'), '400 20px "A"');
});

test("widths are cached per (size, text); the font is set only when the size changes", () => {
  const f = fakeContext();
  const measure = createMeasure(COMIC_FONT_STACK, f.ctx);
  measure("anh", 20);
  measure("em", 20);
  measure("anh", 20);
  measure("anh", 21);
  measure("em", 20);
  assert.deepEqual(f.measured, ["anh", "em", "anh"]);
  assert.equal(f.fonts.length, 2);
});

test("the cache is bounded: the oldest entry goes first", () => {
  const f = fakeContext();
  const measure = createMeasure(COMIC_FONT_STACK, f.ctx);
  for (let i = 0; i <= MEASURE_CACHE_SIZE; i++) measure(`t${i}`, 10);
  const before = f.measured.length;
  measure(`t${MEASURE_CACHE_SIZE}`, 10);
  assert.equal(f.measured.length, before, "newest still cached");
  measure("t0", 10);
  assert.equal(f.measured.length, before + 1, "oldest evicted");
});

test("without a canvas context a crude 0.55 em per character keeps fitText working", () => {
  const measure = createMeasure(COMIC_FONT_STACK, null);
  assert.equal(measure("abcd", 10), 22);
});

test("fallback-font metrics are measured like RND-02: font box at 1000 px, ink line-height at 100 px", () => {
  const f = fakeContext({ ascent: 1.1, descent: 0.29, inkAscent: 1.05, inkDescent: 0.28 });
  const m = measureFontMetrics(COMIC_FONT_STACK, f.ctx);
  assert.ok(Math.abs(m.ascent - 1.1) < 1e-12);
  assert.ok(Math.abs(m.descent - 0.29) < 1e-12);
  assert.equal(m.pixelSnap, true);
  assert.ok(Math.abs(m.lineHeight - (lineHeightFromInk(1.05, 0.28) + COLLISION_LEADING)) < 1e-12);
  assert.deepEqual(f.fonts, [`400 1000px ${COMIC_FONT_STACK}`, `400 100px ${COMIC_FONT_STACK}`]);
  assert.deepEqual(f.measured, [
    LINE_HEIGHT_PROBES.ascent,
    LINE_HEIGHT_PROBES.ascent,
    LINE_HEIGHT_PROBES.descent,
  ]);
});

test("unusable measurements fall back to roomy constants", () => {
  assert.deepEqual(measureFontMetrics(COMIC_FONT_STACK, null), FALLBACK_METRICS);
  const broken = fakeContext({ ascent: Number.NaN, descent: 0.3, inkAscent: 1, inkDescent: 0.3 });
  assert.deepEqual(measureFontMetrics(COMIC_FONT_STACK, broken.ctx), FALLBACK_METRICS);
  const zero = fakeContext({ ascent: 0, descent: 0, inkAscent: 0, inkDescent: 0 });
  assert.deepEqual(measureFontMetrics(COMIC_FONT_STACK, zero.ctx), FALLBACK_METRICS);
});

test("a bold face is measured at its weight, like the DOM lines it is drawn with", () => {
  const f = fakeContext();
  const measure = createMeasure(ROUND_FONT_STACK, f.ctx, 700);
  measure("BIỂN BÁO", 18);
  assert.deepEqual(f.fonts, [`700 18px ${ROUND_FONT_STACK}`]);
  assert.equal(fontShorthand(20, '"A"', 700), '700 20px "A"');
  const metrics = fakeContext();
  measureFontMetrics(ROUND_FONT_STACK, metrics.ctx, 700);
  assert.deepEqual(metrics.fonts, [`700 1000px ${ROUND_FONT_STACK}`, `700 100px ${ROUND_FONT_STACK}`]);
});

test("the cap height of a fallback font is the ink ascent of 'H' at 100 px", () => {
  const f = fakeContext({ ascent: 1.1, descent: 0.3, inkAscent: 0.72, inkDescent: 0.2 });
  assert.ok(Math.abs((measureCapHeight(COMIC_FONT_STACK, f.ctx) ?? 0) - 0.72) < 1e-12);
  assert.deepEqual(f.fonts, [`400 ${CAP_PROBE.px}px ${COMIC_FONT_STACK}`]);
  assert.deepEqual(f.measured, [CAP_PROBE.text]);
  assert.equal(f.ctx.fontKerning, "normal");
  const bold = fakeContext({ ascent: 1, descent: 0.3, inkAscent: 0.7, inkDescent: 0.2 });
  measureCapHeight(ROUND_FONT_STACK, bold.ctx, 700);
  assert.deepEqual(bold.fonts, [`700 100px ${ROUND_FONT_STACK}`]);
});

test("no context or an implausible cap height → null (the face's constant is kept)", () => {
  assert.equal(measureCapHeight(COMIC_FONT_STACK, null), null);
  for (const inkAscent of [0, 0.1, 1.5, Number.NaN]) {
    const f = fakeContext({ ascent: 1, descent: 0.3, inkAscent, inkDescent: 0.2 });
    assert.equal(measureCapHeight(COMIC_FONT_STACK, f.ctx), null, String(inkAscent));
  }
});

test("CJK lettering: line metrics from its own probes, size from the ink height of 国", () => {
  const f = fakeContext({ ascent: 1.16, descent: 0.29, inkAscent: 0.88, inkDescent: 0.12 });
  const probes = { ascent: "国鬱", descent: "国」" };
  const m = measureFontMetrics('"Yu Gothic UI", sans-serif', f.ctx, 400, probes);
  assert.deepEqual(f.measured, ["国鬱", "国鬱", "国」"]);
  assert.ok(Math.abs(m.lineHeight - (lineHeightFromInk(0.88, 0.12) + COLLISION_LEADING)) < 1e-12);
  const ink = fakeContext({ ascent: 1, descent: 0.3, inkAscent: 0.8, inkDescent: 0.1 });
  assert.ok(Math.abs((measureInkHeight("x", ink.ctx, 700) ?? 0) - 0.9) < 1e-12);
  assert.deepEqual(ink.fonts, [`700 ${INK_PROBE.px}px x`]);
  assert.deepEqual(ink.measured, [INK_PROBE.text]);
  assert.equal(measureInkHeight("x", null), null);
  const flat = fakeContext({ ascent: 1, descent: 0.3, inkAscent: 0.1, inkDescent: 0.1 });
  assert.equal(measureInkHeight("x", flat.ctx), null, "an implausible reading");
});
