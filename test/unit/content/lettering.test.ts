// Lettering faces: which font letters which line type, the validated line metrics and cap heights (re-measured here
// on the bundled woff2 files with @napi-rs/canvas), and the size match: in every face, a translation set at
// matchFontPx has capitals exactly as tall as the original glyphs.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { FONT_FAMILIES } from "../../../src/content/fonts.ts";
import {
  BANGERS_METRICS,
  CAP_HEIGHTS,
  CJK_FONT_STACKS,
  CJK_INK_MATCH,
  FACES,
  MALI_BOLD_METRICS,
  cjkFaceKey,
  cjkFaces,
  cjkTargetOf,
  faceFor,
  facesOf,
  familiesInUse,
  letterVertically,
} from "../../../src/content/lettering.ts";
import type { FaceKey } from "../../../src/content/lettering.ts";
import { CAP_PROBE } from "../../../src/content/measure.ts";
import { CAP_HEIGHT_EM, fontLimits, matchFontPx } from "../../../src/content/overlay/render.ts";
import {
  COLLISION_LEADING,
  MALI_METRICS,
  PATRICK_HAND_METRICS,
  lineHeightFromInk,
} from "../../../src/shared/core/fit-text.ts";
import type { LineType, Script } from "../../../src/shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FONTSOURCE = path.join(ROOT, "node_modules", "@fontsource");

describe("face per line type", () => {
  test("dialogue and thoughts follow render.font; captions Mali, signs Mali bold, SFX Bangers", () => {
    const table: Array<[LineType, "patrick-hand" | "mali", FaceKey]> = [
      ["dialogue", "patrick-hand", "comic"],
      ["thought", "patrick-hand", "comic"],
      ["dialogue", "mali", "round"],
      ["thought", "mali", "round"],
      ["narration", "patrick-hand", "round"],
      ["narration", "mali", "round"],
      ["sign", "patrick-hand", "round-bold"],
      ["sign", "mali", "round-bold"],
      ["sfx", "patrick-hand", "sfx"],
      ["sfx", "mali", "sfx"],
    ];
    for (const [type, font, face] of table) assert.equal(faceFor(type, font), face, `${type} / ${font}`);
    assert.equal(faceFor("dialogue"), "comic", "Patrick Hand by default");
  });

  test("faces map to their families and weights; families group their faces", () => {
    assert.deepEqual(
      Object.values(FACES).map((f) => [f.key, f.family, f.weight]),
      [
        ["comic", "comic", 400],
        ["round", "round", 400],
        ["round-bold", "round", 700],
        ["sfx", "sfx", 400],
      ],
    );
    assert.deepEqual(
      facesOf("round").map((f) => f.key),
      ["round", "round-bold"],
    );
    assert.deepEqual(
      facesOf("comic").map((f) => f.key),
      ["comic"],
    );
    for (const face of Object.values(FACES)) {
      const weights = FONT_FAMILIES[face.family].files.map((file) => Number(file.weight));
      assert.ok(weights.includes(face.weight), `${face.key}: its family ships weight ${face.weight}`);
    }
  });
});

describe("families loaded with the first units", () => {
  test("every family the settings can letter in, and only those", () => {
    assert.deepEqual(familiesInUse("patrick-hand", true), ["comic", "round", "sfx"]);
    assert.deepEqual(familiesInUse("mali", true), ["round", "sfx"], "no Patrick Hand with Mali dialogue");
    assert.deepEqual(
      familiesInUse("patrick-hand", false),
      ["comic", "round"],
      "no Bangers when SFX stay untouched",
    );
    assert.deepEqual(familiesInUse("mali", false), ["round"]);
  });
});

describe("validated constants", () => {
  test("Patrick Hand keeps its metrics and its 0.66 em cap height (the path the user verified)", () => {
    assert.equal(FACES.comic.metrics, PATRICK_HAND_METRICS);
    assert.equal(FACES.comic.capHeightEm, CAP_HEIGHT_EM);
    assert.equal(CAP_HEIGHTS.patrickHand, 0.66);
    assert.equal(FACES.round.metrics, MALI_METRICS);
  });

  test("Mali bold and Bangers line metrics = Chrome 154 ink measurements + collision leading", () => {
    // Ink at 1000 px in Chrome 154: Mali 700 1171.875 + 265.625, Bangers 1390.625 + 203.125 (both clamp to 1.45).
    assert.ok(Math.abs(MALI_BOLD_METRICS.lineHeight - (1.45 + COLLISION_LEADING)) < 1e-9);
    assert.ok(Math.abs(BANGERS_METRICS.lineHeight - (1.45 + COLLISION_LEADING)) < 1e-9);
    assert.equal(lineHeightFromInk(1.171875, 0.265625), 1.45);
    assert.deepEqual([MALI_BOLD_METRICS.ascent, MALI_BOLD_METRICS.descent], [1.05, 0.25]);
    assert.deepEqual([BANGERS_METRICS.ascent, BANGERS_METRICS.descent], [0.883, 0.181]);
    for (const face of Object.values(FACES)) {
      assert.equal(face.metrics.pixelSnap, true, face.key);
      assert.ok(face.metrics.lineHeight >= face.metrics.ascent + face.metrics.descent, face.key);
    }
  });

  test("every cap height matches the bundled font's 'H' ink ascent at 100 px", () => {
    const files: Record<FaceKey, [file: string, weight: number]> = {
      comic: ["patrick-hand/files/patrick-hand-latin-400-normal.woff2", 400],
      round: ["mali/files/mali-latin-400-normal.woff2", 400],
      "round-bold": ["mali/files/mali-latin-700-normal.woff2", 700],
      sfx: ["bangers/files/bangers-latin-400-normal.woff2", 400],
    };
    const ctx = createCanvas(8, 8).getContext("2d");
    for (const [key, [file, weight]] of Object.entries(files) as Array<[FaceKey, [string, number]]>) {
      const alias = `CTV Test ${key}`;
      assert.ok(GlobalFonts.registerFromPath(path.join(FONTSOURCE, file), alias) !== null, file);
      ctx.font = `${weight} ${CAP_PROBE.px}px "${alias}"`;
      const measured = ctx.measureText(CAP_PROBE.text).actualBoundingBoxAscent / CAP_PROBE.px;
      // Two rasterizers on a 1 px grid at 100 px: within 0.015 em.
      assert.ok(
        Math.abs(measured - FACES[key].capHeightEm) <= 0.015,
        `${key}: measured ${measured}, constant ${FACES[key].capHeightEm}`,
      );
    }
  });
});

describe("size match per face", () => {
  test("at matchFontPx, a face's capitals are exactly as tall as the original glyph", () => {
    const scripts: Script[] = ["latin", "hangul", "cjk"];
    for (const face of Object.values(FACES)) {
      for (const script of scripts) {
        for (const glyph of [12, 29, 93]) {
          const px = matchFontPx(glyph, script, face.capHeightEm);
          const caps = px * face.capHeightEm;
          const want = glyph * (script === "latin" ? 1 : 0.8);
          assert.ok(Math.abs(caps - want) < 1e-9, `${face.key} ${script} ${glyph}: caps ${caps} px`);
        }
      }
    }
  });

  test("taller capitals letter smaller: Mali and Bangers sizes are below Patrick Hand's for the same glyph", () => {
    const comic = matchFontPx(30, "hangul", FACES.comic.capHeightEm);
    assert.equal(comic, matchFontPx(30, "hangul"), "the default is Patrick Hand");
    for (const key of ["round", "round-bold", "sfx"] as const) {
      const px = matchFontPx(30, "hangul", FACES[key].capHeightEm);
      assert.ok(px < comic, key);
      assert.ok(px > comic * 0.85, `${key} stays close`);
    }
    // fontLimits uses the face's cap height for its ceiling.
    assert.equal(fontLimits(1, 30, 11, 120, "latin", FACES.round.capHeightEm).maxPx, 30 / 0.73);
    assert.equal(fontLimits(1, 30, 11, 120, "latin").maxPx, 30 / CAP_HEIGHT_EM);
  });

  test("an invalid cap height falls back to Patrick Hand's", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(matchFontPx(20, "latin", bad), 20 / CAP_HEIGHT_EM, String(bad));
    }
  });
});

describe("CJK targets: system fonts, ink-height size match, vertical lettering", () => {
  test("only Japanese, Chinese and Korean targets are lettered with CJK fonts", () => {
    assert.deepEqual(["ja", "zh-cn", "zh-tw", "ko", "vi", "en", "zh"].map(cjkTargetOf), [
      "ja",
      "zh-cn",
      "zh-tw",
      "ko",
      null,
      null,
      null,
    ]);
  });

  test("a font list per target, with its own glyph forms first and a generic family last", () => {
    assert.ok(CJK_FONT_STACKS.ja.startsWith('"Yu Gothic UI"'));
    assert.ok(
      CJK_FONT_STACKS["zh-cn"].includes('"Microsoft YaHei"') && CJK_FONT_STACKS["zh-cn"].includes("SC"),
    );
    assert.ok(
      CJK_FONT_STACKS["zh-tw"].includes('"Microsoft JhengHei"') && CJK_FONT_STACKS["zh-tw"].includes("TC"),
    );
    assert.ok(CJK_FONT_STACKS.ko.startsWith('"Malgun Gothic"'));
    for (const stack of Object.values(CJK_FONT_STACKS)) assert.ok(stack.endsWith("sans-serif"), stack);
    const faces = cjkFaces();
    assert.equal(faces.length, 8);
    assert.deepEqual(
      faces.slice(0, 2).map((f) => [f.key, f.weight]),
      [
        ["cjk-ja", 400],
        ["cjk-ja-bold", 700],
      ],
    );
  });

  test("signs and sound effects bold, other lines regular", () => {
    assert.equal(cjkFaceKey("ja", "dialogue"), "cjk-ja");
    assert.equal(cjkFaceKey("zh-tw", "narration"), "cjk-zh-tw");
    assert.equal(cjkFaceKey("ko", "sign"), "cjk-ko-bold");
    assert.equal(cjkFaceKey("zh-cn", "sfx"), "cjk-zh-cn-bold");
  });

  test("CJK ink matches Hangul and Han glyphs one to one and Latin capitals at 1.2", () => {
    assert.deepEqual(CJK_INK_MATCH, { latin: 1.2, hangul: 1, cjk: 1 });
    const inkEm = 0.88;
    const px = matchFontPx(30, "hangul", inkEm, CJK_INK_MATCH);
    assert.ok(Math.abs(px * inkEm - 30) < 1e-9, "the Han ink is as tall as the Hangul glyph");
    assert.ok(Math.abs(matchFontPx(30, "latin", inkEm, CJK_INK_MATCH) * inkEm - 36) < 1e-9);
  });

  test("vertical only for Japanese and Traditional Chinese, in vertical balloons, with verticalText auto", () => {
    assert.equal(letterVertically("ja", "auto", "v"), true);
    assert.equal(letterVertically("zh-tw", "auto", "v"), true);
    assert.equal(letterVertically("ja", "auto", "h"), false, "horizontal balloons stay horizontal");
    assert.equal(letterVertically("ja", "never", "v"), false);
    assert.equal(
      letterVertically("zh-cn", "auto", "v"),
      false,
      "Simplified Chinese is lettered horizontally",
    );
    assert.equal(letterVertically("ko", "auto", "v"), false);
    assert.equal(letterVertically("en", "auto", "v"), false, "Latin targets keep today's behaviour");
    assert.equal(letterVertically("vi", "auto", "v"), false);
  });
});
