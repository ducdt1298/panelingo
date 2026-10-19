// Offline OCR core (src/shared/offline/ocr.ts) on synthetic images: the character dictionary of inference.yml, greedy
// CTC decoding, binarization and cleaning (frames, outlines, polarity), orientation, line and column segmentation,
// the recognizer input and the text helpers.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ImageDataLike } from "../../../src/shared/gfx.ts";
import {
  REC_HEIGHT,
  REC_MIN_WIDTH,
  batchWidth,
  cleanMask,
  cropRgba,
  ctcDecode,
  fixVerticalText,
  inferOrientation,
  joinLines,
  largestShare,
  latinLanguage,
  parseCharacterDict,
  profileSpans,
  recWidth,
  removeRules,
  scriptCounts,
  segmentLines,
  sentenceCase,
  stackColumn,
  textMask,
  writeRecInput,
  type InkMask,
} from "../../../src/shared/offline/ocr.ts";
import type { Box } from "../../../src/shared/types.ts";

type RGB = readonly [number, number, number];

/** A width × height image filled with `bg`, then the given boxes painted in their colours. */
function image(
  width: number,
  height: number,
  bg: RGB,
  boxes: ReadonlyArray<{ box: Box; color: RGB }>,
): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([bg[0], bg[1], bg[2], 255], i * 4);
  for (const { box, color } of boxes) {
    for (let y = box.y1; y < box.y2; y++) {
      for (let x = box.x1; x < box.x2; x++)
        data.set([color[0], color[1], color[2], 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const BLACK: RGB = [10, 10, 10];
const WHITE: RGB = [250, 250, 250];

/** "Glyphs": squares of side g with a gap, laid out in lines (h) or columns (v, first column on the right). */
function textBlock(
  lines: number,
  perLine: number,
  orientation: "h" | "v",
  options: { g?: number; gap?: number; leading?: number; margin?: number } = {},
): { boxes: Array<{ box: Box; color: RGB }>; width: number; height: number } {
  const g = options.g ?? 20;
  const gap = options.gap ?? 3;
  const leading = options.leading ?? 12;
  const margin = options.margin ?? 12;
  const boxes: Array<{ box: Box; color: RGB }> = [];
  for (let l = 0; l < lines; l++) {
    for (let c = 0; c < perLine; c++) {
      const along = margin + c * (g + gap);
      const across = margin + l * (g + leading);
      const box =
        orientation === "h"
          ? { x1: along, y1: across, x2: along + g, y2: across + g }
          : { x1: across, y1: along, x2: across + g, y2: along + g };
      boxes.push({ box, color: BLACK });
    }
  }
  const lineExtent = margin * 2 + perLine * (g + gap) - gap;
  const stackExtent = margin * 2 + lines * (g + leading) - leading;
  return orientation === "h"
    ? { boxes, width: lineExtent, height: stackExtent }
    : {
        boxes: boxes.map(({ box, color }) => ({
          // Mirror horizontally: vertical text starts with the rightmost column.
          box: { x1: stackExtent - box.x2, y1: box.y1, x2: stackExtent - box.x1, y2: box.y2 },
          color,
        })),
        width: stackExtent,
        height: lineExtent,
      };
}

function maskOf(ink: number[][]): InkMask {
  const height = ink.length;
  const width = ink[0]?.length ?? 0;
  return { width, height, ink: Uint8Array.from(ink.flat()) };
}

const inside = (img: ImageDataLike, margin = 4): Box => ({
  x1: margin,
  y1: margin,
  x2: img.width - margin,
  y2: img.height - margin,
});

describe("character dictionary (inference.yml)", () => {
  test("PyYAML scalars: plain, single-quoted with '' and double-quoted escapes; stops at the list's end", () => {
    const yaml = [
      "PreProcess:",
      "  transform_ops:",
      "  - DecodeImage: {}",
      "PostProcess:",
      "  name: CTCLabelDecode",
      "  character_dict:",
      "  - '0'",
      "  - A",
      "  - ''''",
      '  - "\\""',
      '  - "\\u00E9"',
      "  - 가",
      "Other: 1",
    ].join("\n");
    assert.deepEqual(parseCharacterDict(yaml), ["0", "A", "'", '"', "é", "가"]);
    assert.throws(() => parseCharacterDict("Global: {}\n"), /no character_dict/u);
  });
});

describe("CTC greedy decoding", () => {
  const dict = ["a", "b", "c"];
  /** One-hot rows (blank = 0, a..c = 1..3, space = 4) with probability p. */
  const rows = (classes: number[], p = 0.9): Float32Array => {
    const out = new Float32Array(classes.length * 5).fill((1 - p) / 4);
    classes.forEach((c, t) => (out[t * 5 + c] = p));
    return out;
  };

  test("best class per step, repeats collapsed, blanks dropped, the last class is a space", () => {
    const result = ctcDecode(rows([1, 1, 0, 1, 2, 2, 4, 3, 0]), 9, 5, dict);
    assert.equal(result.text, "aab c");
    assert.ok(Math.abs(result.confidence - 0.9) < 1e-6);
  });

  test("nothing but blanks is empty text with confidence 0", () => {
    assert.deepEqual(ctcDecode(rows([0, 0, 0]), 3, 5, dict), { text: "", confidence: 0 });
  });
});

describe("spans of a profile", () => {
  test("small gaps are bridged; thin runs (accents, dots) join their nearest neighbour", () => {
    const profile = [0, 5, 5, 5, 0, 5, 5, 5, 5, 5, 0, 0, 0, 0, 1, 0, 0, 6, 6, 6, 6, 6, 0];
    const spans = profileSpans(profile, { minInk: 1, minGap: 2, minRatio: 0.35 });
    assert.deepEqual(spans, [
      { start: 1, end: 10 },
      { start: 14, end: 22 },
    ]);
  });
});

describe("binarization and cleaning", () => {
  test("dark text on a light balloon and light text on a dark sign both give the glyphs as ink", () => {
    const block = textBlock(2, 4, "h");
    const dark = image(block.width, block.height, WHITE, block.boxes);
    const light = image(
      block.width,
      block.height,
      [30, 90, 40],
      block.boxes.map(({ box }) => ({ box, color: WHITE })),
    );
    for (const img of [dark, light]) {
      const mask = textMask(img, inside(img), 20);
      const inked = mask.ink.reduce((sum, v) => sum + v, 0);
      assert.equal(inked, 8 * 20 * 20, "exactly the glyph pixels");
    }
  });

  test("a caption frame is removed (rules), so lines stay apart", () => {
    const block = textBlock(2, 4, "h");
    const w = block.width;
    const h = block.height;
    const frame = [
      { box: { x1: 0, y1: 0, x2: w, y2: 2 }, color: BLACK },
      { box: { x1: 0, y1: h - 2, x2: w, y2: h }, color: BLACK },
      { box: { x1: 0, y1: 0, x2: 2, y2: h }, color: BLACK },
      { box: { x1: w - 2, y1: 0, x2: w, y2: h }, color: BLACK },
    ];
    const img = image(w, h, WHITE, [...frame, ...block.boxes]);
    const mask = textMask(img, inside(img, 8), 20);
    assert.equal(segmentLines(mask, "h").length, 2);
  });

  test("removeRules keeps glyph strokes and filled areas, erases long thin lines", () => {
    const rows = Array.from({ length: 20 }, (_, y) =>
      Array.from({ length: 60 }, (_, x) => (y === 3 || (x >= 10 && x < 14 && y >= 6 && y < 16) ? 1 : 0)),
    );
    const out = removeRules(maskOf(rows), 30, 3);
    assert.equal(out.ink[3 * 60 + 30], 0, "the rule");
    assert.equal(out.ink[10 * 60 + 11], 1, "the stroke");
    const block = maskOf(Array.from({ length: 20 }, () => Array.from({ length: 60 }, () => 1)));
    assert.equal(
      removeRules(block, 30, 3).ink.reduce((s, v) => s + v, 0),
      1200,
      "a filled area is not a rule",
    );
  });

  test("cleanMask drops what reaches in from outside the text box, keeps glyphs and marks by the text", () => {
    const rows = Array.from({ length: 30 }, (_, y) =>
      Array.from({ length: 70 }, (_, x) => {
        const arc = x < 12 && y === Math.max(0, 11 - x); // an outline arc in the corner
        const glyph = (x >= 20 && x < 30 && y >= 6 && y < 16) || (x >= 52 && x < 58 && y >= 6 && y < 16);
        const grazing = x >= 38 && x < 48 && y >= 4 && y < 14; // one row above the box
        const dot = x >= 32 && x < 34 && y >= 17 && y < 19; // a "!" dot just below the box, by the text
        const screentone = x >= 64 && x < 66 && y >= 26 && y < 28; // a speck in the far corner
        return arc || glyph || grazing || dot || screentone ? 1 : 0;
      }),
    );
    const cleaned = cleanMask(maskOf(rows), { x1: 5, y1: 5, x2: 60, y2: 17 }, 10);
    const at = (x: number, y: number): number => cleaned.ink[y * 70 + x] ?? -1;
    assert.equal(at(11, 0), 0, "arc gone");
    assert.equal(at(25, 10), 1, "glyph kept");
    assert.equal(at(43, 4), 1, "grazing glyph kept whole");
    assert.equal(at(32, 18), 1, "the dot by the text stays");
    assert.equal(at(64, 26), 0, "the speck away from the text goes");
  });

  test("largestShare: one region is 1, scattered glyphs are small", () => {
    assert.equal(largestShare(maskOf([[1, 1, 1]])), 1);
    assert.equal(largestShare(maskOf([[1, 0, 1, 0, 1, 0, 1]])), 0.25);
  });
});

describe("orientation and segmentation", () => {
  test("lines top to bottom, columns right to left, each trimmed to its ink", () => {
    const h = textBlock(3, 5, "h");
    const hMask = textMask(
      image(h.width, h.height, WHITE, h.boxes),
      inside(image(h.width, h.height, WHITE, [])),
      20,
    );
    const lines = segmentLines(hMask, "h");
    assert.equal(lines.length, 3);
    assert.ok((lines[0]?.y1 ?? 99) < (lines[1]?.y1 ?? 0), "top first");
    const v = textBlock(3, 4, "v");
    const vImg = image(v.width, v.height, WHITE, v.boxes);
    const columns = segmentLines(textMask(vImg, inside(vImg), 20), "v");
    assert.equal(columns.length, 3);
    assert.ok((columns[0]?.x1 ?? 0) > (columns[1]?.x1 ?? 99), "rightmost first");
  });

  test("inferOrientation reads the layout from the ink and keeps the hint when it cannot tell", () => {
    const cases: Array<[number, number, "h" | "v"]> = [
      [3, 5, "h"],
      [1, 6, "h"],
      [3, 4, "v"],
      [1, 4, "v"],
    ];
    for (const [lines, per, orientation] of cases) {
      const block = textBlock(lines, per, orientation);
      const img = image(block.width, block.height, WHITE, block.boxes);
      const mask = textMask(img, inside(img), 20);
      const wrong = orientation === "h" ? "v" : "h";
      assert.equal(inferOrientation(mask, wrong), orientation, `${lines}×${per} ${orientation}`);
    }
    const single = textBlock(1, 1, "h");
    const img = image(single.width, single.height, WHITE, single.boxes);
    assert.equal(inferOrientation(textMask(img, inside(img), 20), "v"), "v");
  });

  test("stackColumn lays a column's characters side by side, small marks included", () => {
    const v = textBlock(1, 4, "v");
    const img = image(v.width, v.height, WHITE, v.boxes);
    const mask = textMask(img, inside(img), 20);
    const [column] = segmentLines(mask, "v");
    assert.ok(column !== undefined);
    const strip = stackColumn(img, mask, column);
    assert.ok(strip.width > strip.height * 3, `${strip.width}×${strip.height}`);
    assert.equal(strip.data.length, strip.width * strip.height * 4);
  });

  test("cropRgba rotates counter-clockwise: the column's top goes to the left", () => {
    const img = image(2, 3, WHITE, [{ box: { x1: 0, y1: 0, x2: 2, y2: 1 }, color: BLACK }]);
    const rotated = cropRgba(img, { x1: 0, y1: 0, x2: 2, y2: 3 }, true);
    assert.deepEqual([rotated.width, rotated.height], [3, 2]);
    assert.equal(rotated.data[0], 10, "top-left is the old top row");
    assert.equal(rotated.data[(1 * 3 + 2) * 4], 250);
  });
});

describe("recognizer input", () => {
  test("height 48, width ≥ 320 in steps of 32; BGR, normalized to [-1, 1], zero padding", () => {
    assert.equal(recWidth(100, 24), 200);
    assert.equal(batchWidth(200), REC_MIN_WIDTH);
    assert.equal(batchWidth(401), 416);
    const line = image(10, 5, [255, 0, 0], []);
    const W = batchWidth(recWidth(10, 5));
    const tensor = new Float32Array(3 * REC_HEIGHT * W);
    writeRecInput(line, tensor, 0, W);
    const plane = REC_HEIGHT * W;
    assert.equal(tensor[2 * plane], 1, "red is the third (R of BGR) plane");
    assert.equal(tensor[0], -1, "blue plane");
    assert.equal(tensor[W - 1], 0, "padding");
  });
});

describe("text helpers", () => {
  test("joinLines: CJK without spaces, others with spaces; letterer hyphens rejoined", () => {
    assert.equal(joinLines(["七時に駅の前", "で会おう。"], "ja"), "七時に駅の前で会おう。");
    assert.equal(joinLines(["일곱 시에 역", "앞에서 보자."], "ko"), "일곱 시에 역 앞에서 보자.");
    assert.equal(joinLines(["WON-", "DERFUL DAY", ""], "en"), "WONDERFUL DAY");
    assert.equal(joinLines(["SEE YOU", "AT SEVEN."], "en"), "SEE YOU AT SEVEN.");
  });

  test("sentenceCase for all-capital lettering only", () => {
    assert.equal(sentenceCase("WAIT, I FORGOT MY WALLET!"), "Wait, I forgot my wallet!");
    assert.equal(
      sentenceCase("¿Y SI ESPERO A QUE DEJE DE LLOVER...?"),
      "¿Y si espero a que deje de llover...?",
    );
    assert.equal(sentenceCase("I'M HERE. YOU TOO?"), "I'm here. You too?");
    assert.equal(sentenceCase("Already mixed Case"), "Already mixed Case");
    assert.equal(sentenceCase("다음 날"), "다음 날");
  });

  test("script counts and the English / Spanish vote", () => {
    assert.deepEqual(scriptCounts("この地図、町"), { hangul: 0, kana: 2, han: 3, latin: 0 });
    assert.deepEqual(scriptCounts("다음 A"), { hangul: 2, kana: 0, han: 0, latin: 1 });
    assert.equal(latinLanguage("NOS VEMOS A LAS SIETE FRENTE A LA ESTACIÓN."), "es");
    assert.equal(latinLanguage("THIS MAP ONLY SHOWS HALF THE TOWN!"), "en");
    assert.equal(latinLanguage("HOY CERRADO, LA TIENDA"), "es");
  });

  test("fixVerticalText: the vertical ellipsis and the long-vowel bar", () => {
    assert.equal(fixVerticalText("うかな："), "うかな…");
    assert.equal(fixVerticalText("ラ|メン"), "ラーメン");
    assert.equal(fixVerticalText("七時"), "七時");
  });
});
