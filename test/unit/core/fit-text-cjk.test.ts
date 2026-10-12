// CJK lettering in fitText: break opportunities between Japanese and Chinese characters with the basic kinsoku rules,
// and vertical (vertical-rl) layout in the mirrored transposition of the region. Sentences are this project's own
// fixture lines (test/fixtures/sentences).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  VERTICAL_METRICS,
  cjkBreakBetween,
  columnsToPage,
  fitText,
  fitTextVertical,
  hasCjkBreaks,
  pageToColumns,
  splitCjkToken,
  verticalMeasure,
} from "../../../src/shared/core/fit-text.ts";
import type { FitOptions, FitResult, FontMetrics, Measure } from "../../../src/shared/core/fit-text.ts";
import type { Box } from "../../../src/shared/types.ts";

/** Fake CJK font: full-width characters 1 em, everything else 0.5 em. */
const WIDE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\u3000-\u303f\u30fc\uff01-\uff60]/u;
const fake: Measure = (s, px) => [...s].reduce((sum, ch) => sum + (WIDE.test(ch) ? 1 : 0.5) * px, 0);
const METRICS: FontMetrics = { lineHeight: 1.3, ascent: 0.88, descent: 0.12 };
const OPTS: FitOptions = { measure: fake, metrics: METRICS, minPx: 11, maxPx: 40 };
/** Vertical layouts take VERTICAL_METRICS by default. */
const VOPTS: FitOptions = { measure: fake, minPx: 11, maxPx: 40 };
const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });

const NO_START = /^[、。，！？」』）…ーっゃゅょァィゥェォッャュョ]/u;
const NO_END = /[「『（]$/u;

function joined(r: FitResult): string {
  return r.lines.map((l) => l.text).join("");
}

describe("CJK break opportunities (kinsoku)", () => {
  test("Japanese and Chinese break between characters; Korean and Latin only at spaces", () => {
    assert.equal(hasCjkBreaks("七時に駅の前で会おう。"), true);
    assert.equal(hasCjkBreaks("七点在车站门口见。"), true);
    assert.equal(hasCjkBreaks("안녕하세요"), false, "Korean is written with spaces");
    assert.equal(hasCjkBreaks("Xin chào"), false);
    assert.equal(cjkBreakBetween("時", "に"), true);
    assert.equal(cjkBreakBetween("O", "K"), false, "Latin runs stay whole");
    assert.equal(cjkBreakBetween("K", "だ"), true);
  });

  test("no line starts with closing marks, small kana or ー; none ends with an opening bracket", () => {
    for (const [a, c] of [
      ["う", "。"],
      ["前", "、"],
      ["よ", "！"],
      ["た", "」"],
      ["ち", "ょ"],
      ["コ", "ー"],
      ["ゃ", "っ"],
      ["地", "…"],
    ]) {
      assert.equal(cjkBreakBetween(a ?? "", c ?? ""), false, `${a}|${c}`);
    }
    for (const [a, c] of [
      ["「", "待"],
      ["（", "笑"],
    ]) {
      assert.equal(cjkBreakBetween(a ?? "", c ?? ""), false, `${a}|${c}`);
    }
    assert.equal(cjkBreakBetween("。", "雨"), true, "after a full stop");
  });

  test("splitCjkToken: pieces at every allowed break, joined with nothing", () => {
    assert.deepEqual(
      splitCjkToken("会おう。").map((p) => p.text),
      ["会", "お", "う。"],
    );
    assert.deepEqual(
      splitCjkToken("「ちょっと待って」").map((p) => p.text),
      ["「ちょっ", "と", "待っ", "て」"],
    );
    const pieces = splitCjkToken("「ちょっと待って」");
    assert.equal(pieces.map((p) => p.text).join(""), "「ちょっと待って」");
    assert.ok(
      pieces.every((p) => !NO_START.test(p.text) && !NO_END.test(p.text)),
      JSON.stringify(pieces),
    );
    assert.equal(pieces[0]?.join, "space");
    assert.ok(pieces.slice(1).every((p) => p.join === "cjk"));
    assert.deepEqual(
      splitCjkToken("OKだよ").map((p) => p.text),
      ["OK", "だ", "よ"],
    );
  });
});

describe("fitText with Japanese and Chinese", () => {
  test("lines break between characters, obey kinsoku and add no hyphens or spaces", () => {
    for (const text of [
      "この地図、町の半分しか載ってないよ！",
      "急いで、店があと十分で閉まるよ！",
      "这张地图只画了半个小镇！",
    ]) {
      const r = fitText(text, b(0, 0, 160, 120), { ...OPTS, shape: "ellipse" });
      assert.ok(r.lines.length >= 2, `${text}: ${r.lines.length} lines`);
      assert.equal(joined(r), text, "every character once, nothing added");
      assert.equal(r.hyphenated, false);
      assert.equal(r.overflow, false);
      for (const l of r.lines) {
        assert.ok(!NO_START.test(l.text), `${text}: line starts with "${l.text[0]}"`);
        assert.ok(!NO_END.test(l.text), `${text}: line ends with "${l.text.at(-1)}"`);
        assert.ok(l.width <= l.maxWidth + 1e-9);
      }
    }
  });

  test("a text that cannot fit is cut with … after its last whole piece, without a trailing comma", () => {
    const r = fitText("この地図、町の半分しか載ってないよ！", b(0, 0, 50, 30), { ...OPTS, shape: "rect" });
    assert.equal(r.overflow, true);
    const last = r.lines.at(-1)?.text ?? "";
    assert.ok(last.endsWith("…"), last);
    assert.ok(!last.includes("、…"), last);
  });

  test("Korean keeps its spaces as the only break opportunities", () => {
    const r = fitText("서둘러, 가게가 십 분 뒤에 닫아!", b(0, 0, 120, 200), { ...OPTS, shape: "rect" });
    for (const l of r.lines) assert.ok(!l.text.startsWith(" ") && !l.text.endsWith(" "));
    assert.equal(r.lines.map((l) => l.text).join(" "), "서둘러, 가게가 십 분 뒤에 닫아!");
  });
});

describe("vertical text (vertical-rl)", () => {
  test("verticalMeasure: 1 em per upright character, measured width for sideways runs", () => {
    const v = verticalMeasure(fake);
    assert.equal(v("日本語", 20), 60);
    assert.equal(v("ＯＫ！", 20), 60, "full-width forms stand upright");
    assert.equal(v("ABC日", 20), fake("ABC", 20) + 20);
    assert.equal(v("日ABC本", 10), 10 + fake("ABC", 10) + 10);
    assert.equal(v("", 10), 0);
  });

  test("the column transposition is mirrored and its own inverse", () => {
    const region = b(100, 50, 300, 450);
    const s = region.x1 + region.x2;
    assert.deepEqual(pageToColumns(region, s), b(50, 100, 450, 300));
    const box = b(260, 80, 290, 400);
    assert.deepEqual(columnsToPage(pageToColumns(box, s), s), box);
    // The right edge of the region is the top of the column space: the first column is the rightmost one.
    assert.equal(pageToColumns(b(290, 0, 300, 10), s).y1, region.x1);
  });

  test("columns run top to bottom, stack right to left and stay inside the balloon", () => {
    const region = b(200, 100, 330, 420);
    const text = "七時に駅の前で会おう。";
    const r = fitTextVertical(text, region, { ...VOPTS, shape: "ellipse" });
    assert.equal(r.vertical, true);
    assert.equal(r.overflow, false);
    assert.ok(r.lines.length >= 2, `${r.lines.length} columns`);
    assert.equal(joined(r), text);
    assert.equal(r.lineHeightPx, VERTICAL_METRICS.lineHeight * r.fontPx, "default metrics: 1.25 em columns");
    const v = verticalMeasure(fake);
    for (const [i, col] of r.lines.entries()) {
      assert.ok(col.x >= region.x1 - 1e-9 && col.x + r.lineHeightPx <= region.x2 + 1e-9, `column ${i} x`);
      assert.ok(col.y >= region.y1 - 1e-9 && col.y + col.width <= region.y2 + 1e-9, `column ${i} y`);
      assert.ok(
        Math.abs(col.width - v(col.text, r.fontPx)) < 1e-9,
        "a column's length is its vertical advance",
      );
      assert.ok(Math.abs(col.baseline - (col.x + r.lineHeightPx / 2)) < 1e-9);
      assert.ok(!NO_START.test(col.text), `column ${i} starts with "${col.text[0]}"`);
      const next = r.lines[i + 1];
      if (next !== undefined) assert.ok(next.x < col.x, "the next column is to the left");
    }
    assert.ok(r.lines.length * r.lineHeightPx <= region.x2 - region.x1 + 1e-9);
    assert.ok(r.bounds !== null);
    assert.ok(r.bounds.x1 >= region.x1 - 1e-9 && r.bounds.y2 <= region.y2 + 1e-9);
    assert.deepEqual(r.region, region, "the region comes back in page coordinates");
  });

  test("the overflow chain works in column space: grown regions and obstacles are transposed too", () => {
    const region = b(400, 400, 440, 470);
    const obstacle = b(300, 380, 395, 500);
    const r = fitTextVertical("この地図、町の半分しか載ってないよ！", region, {
      ...VOPTS,
      shape: "ellipse",
      chain: { bounds: b(0, 0, 1200, 1800), obstacles: [obstacle] },
    });
    assert.equal(r.vertical, true);
    assert.equal(r.step, 3);
    assert.equal(r.halo, true);
    for (const col of r.lines) assert.ok(col.x >= obstacle.x2 - 1e-9, "columns keep clear of the neighbour");
  });
});
