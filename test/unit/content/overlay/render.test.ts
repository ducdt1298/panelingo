import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BUBBLE_CLIP_INSET,
  BLACK,
  CAP_HEIGHT_EM,
  CAP_MATCH,
  HALO_CSS_PX,
  PAINTED_STATUSES,
  PLATE_ALPHA,
  SFX_LABEL,
  WHITE,
  contrastRatio,
  fontLimits,
  insideShape,
  labelRiseEm,
  matchFontPx,
  planUnit,
  readableText,
  relativeLuminance,
  sfxMode,
  shouldPaint,
  unitHitBox,
} from "../../../../src/content/overlay/render.ts";
import type { PlanOptions, UnitPlan } from "../../../../src/content/overlay/render.ts";
import { MALI_METRICS, PATRICK_HAND_METRICS, lineBox } from "../../../../src/shared/core/fit-text.ts";
import type { Measure } from "../../../../src/shared/core/fit-text.ts";
import type { Box, RGB, UnitGeometry, UnitRender, UnitStatus } from "../../../../src/shared/types.ts";

/** Fake font: every code point is 0.5 em wide. */
const fake: Measure = (s, px) => [...s].length * 0.5 * px;
const OPTS: PlanOptions = { minFontPx: 11, maxFontPx: 30 };
const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });
const REGION = b(100, 100, 400, 260);
const LONG = "Anh đã nói với em rồi mà sao em vẫn không chịu nghe lời anh vậy hả";

function unit(over: Partial<UnitRender> = {}): UnitRender {
  return {
    unitKey: "u1",
    type: "dialogue",
    speaker: "",
    original: "안녕하세요",
    translation: "Xin chào bạn nhé",
    status: "ok",
    fit: { region: REGION, shape: "ellipse", orientation: "h", glyphPx: 30 },
    erase: { kind: "box", rect: b(150, 140, 350, 220), bg: null, textColor: [0, 0, 0] },
    ...over,
  };
}

function mustPlan(u: UnitRender, scale = 1, options: PlanOptions = OPTS): UnitPlan {
  const plan = planUnit(u, scale, fake, options);
  assert.ok(plan !== null, "expected a plan");
  return plan;
}

const ALL_STATUSES: readonly UnitStatus[] = [
  "pending",
  "translating",
  "ok",
  "keep-original",
  "manual",
  "untranslated",
  "refused",
  "ignored",
  "error",
  "stale",
];

describe("status gating (never cover text without a valid translation)", () => {
  test("only ok and manual units are planned; every other status paints nothing at all", () => {
    for (const status of ALL_STATUSES) {
      const plan = planUnit(unit({ status }), 1, fake, OPTS);
      const painted = status === "ok" || status === "manual";
      assert.equal(plan !== null, painted, status);
      assert.equal(shouldPaint(unit({ status })), painted, status);
    }
    assert.deepEqual([...PAINTED_STATUSES].sort(), ["manual", "ok"]);
  });

  test("an empty or blank translation, or a line typed ignore, paints nothing even when ok", () => {
    for (const translation of ["", "   ", "\n\t "])
      assert.equal(planUnit(unit({ translation }), 1, fake, OPTS), null, JSON.stringify(translation));
    assert.equal(planUnit(unit({ type: "ignore" }), 1, fake, OPTS), null);
    assert.equal(planUnit(unit({ type: "ignore", status: "manual" }), 1, fake, OPTS), null);
  });

  test("a degenerate fit region paints nothing", () => {
    for (const region of [b(100, 100, 100, 200), b(100, 200, 300, 150), b(Number.NaN, 0, 10, 10)]) {
      assert.equal(
        planUnit(unit({ fit: { region, shape: "ellipse", orientation: "h", glyphPx: 20 } }), 1, fake, OPTS),
        null,
      );
    }
  });
});

describe("fitted text", () => {
  test("every line lies inside the engine's fit region (the balloon interior)", () => {
    const plan = mustPlan(unit());
    assert.equal(plan.kind, "text");
    assert.equal(plan.overflow, false);
    assert.equal(plan.step, 0);
    assert.equal(plan.haloPx, 0);
    assert.deepEqual(
      plan.lines.map((l) => l.text),
      ["Xin chào", "bạn nhé"],
    );
    for (const l of plan.lines) {
      assert.ok(l.x >= REGION.x1 && l.x + l.width <= REGION.x2, `${l.text} inside horizontally`);
      assert.ok(l.y >= REGION.y1 && l.y + plan.lineHeightPx <= REGION.y2, `${l.text} inside vertically`);
      assert.equal(l.width, fake(l.text, plan.fontPx));
    }
    assert.equal(plan.lineHeightPx, lineBox(plan.fontPx, PATRICK_HAND_METRICS).lineHeight);
  });

  test("the font size stays within the settings' CSS px range at the display scale", () => {
    for (const scale of [0.5, 0.9, 1, 1.6, 2]) {
      const plan = mustPlan(unit({ translation: "Ừ" }), scale);
      const css = plan.fontPx * scale;
      assert.ok(css >= 11 - 1e-9 && css <= 30 + 1e-9, `scale ${scale}: ${css} CSS px`);
    }
    // A long text in the same bubble shrinks, but never below the floor.
    const plan = mustPlan(unit({ translation: LONG }), 0.5);
    assert.ok(plan.fontPx * 0.5 >= 11 - 1e-9);
  });

  test("the translation matches the original lettering: capitals as tall as the measured glyph", () => {
    assert.equal(CAP_HEIGHT_EM, 0.66);
    assert.equal(matchFontPx(33, "latin"), 50, "Latin capitals: cap height = glyph height");
    assert.ok(Math.abs(matchFontPx(33, "hangul") - (33 * CAP_MATCH.hangul) / CAP_HEIGHT_EM) < 1e-9);
    // A short line in a roomy region reaches exactly the matched size (fitText only goes smaller).
    const roomy = b(0, 0, 800, 400);
    const latin = mustPlan(
      unit({
        translation: "Hola",
        fit: { region: roomy, shape: "rect", orientation: "h", glyphPx: 33, script: "latin" },
      }),
      1,
      { minFontPx: 11, maxFontPx: 120 },
    );
    assert.equal(latin.fontPx, 50);
    const hangul = mustPlan(
      unit({
        translation: "Hola",
        fit: { region: roomy, shape: "rect", orientation: "h", glyphPx: 33, script: "hangul" },
      }),
      1,
      { minFontPx: 11, maxFontPx: 120 },
    );
    assert.ok(hangul.fontPx < latin.fontPx, "Hangul glyphs fill the em square: smaller capitals match them");
  });

  test("fontLimits: CSS px divided by the scale, capped at the size that matches the original", () => {
    const m = (glyph: number): number => matchFontPx(glyph);
    assert.deepEqual(fontLimits(1, 30, 11, 60), { minPx: 11, maxPx: m(30) });
    assert.deepEqual(fontLimits(0.5, 30, 11, 60), { minPx: 22, maxPx: m(30) });
    assert.deepEqual(fontLimits(2, 30, 11, 30), { minPx: 5.5, maxPx: 15 }, "the CSS ceiling still applies");
    assert.deepEqual(
      fontLimits(1, 5, 11, 30),
      { minPx: 11, maxPx: 11 },
      "the cap never goes below the floor",
    );
    assert.deepEqual(fontLimits(1, 0, 11, 30), { minPx: 11, maxPx: 30 }, "unknown glyph: no cap");
    assert.deepEqual(fontLimits(0, 20, 11, 30), fontLimits(1, 20, 11, 30), "invalid scale counts as 1");
    assert.deepEqual(fontLimits(1, 20, 14, 12), { minPx: 14, maxPx: 14 }, "max below min collapses to min");
    assert.equal(fontLimits(1, 20, 11, 60, "latin").maxPx, 20 / CAP_HEIGHT_EM);
  });

  test("metrics and zoom pass through to the line model", () => {
    const plan = mustPlan(unit(), 1, { ...OPTS, metrics: MALI_METRICS, zoom: 1.25 });
    assert.equal(plan.lineHeightPx, lineBox(plan.fontPx, MALI_METRICS, 1.25).lineHeight);
  });

  test("orientation 'v' (tall CJK bubbles) still lays the Latin-script translation out horizontally inside the region", () => {
    const tall = b(300, 100, 380, 400);
    const plan = mustPlan(
      unit({ translation: LONG, fit: { region: tall, shape: "ellipse", orientation: "v", glyphPx: 26 } }),
    );
    assert.ok(plan.lines.length > 1);
    for (const l of plan.lines) assert.ok(l.x >= tall.x1 - 1e-9 && l.x + l.width <= tall.x2 + 1e-9);
  });

  test("planning is pure: frozen input, identical output", () => {
    const u = unit({ translation: LONG });
    Object.freeze(u.fit.region);
    Object.freeze(u.fit);
    Object.freeze(u.erase);
    Object.freeze(u);
    assert.deepEqual(planUnit(u, 0.8, fake, OPTS), planUnit(u, 0.8, fake, OPTS));
  });
});

describe("overflow", () => {
  const tiny = { region: b(0, 0, 60, 30), shape: "ellipse" as const, orientation: "h" as const, glyphPx: 20 };

  test("a text that cannot fit at the minimum size is cut with … and flagged", () => {
    const plan = mustPlan(unit({ translation: LONG, fit: tiny }));
    assert.equal(plan.overflow, true);
    assert.equal(plan.step, 4);
    assert.equal(plan.fontPx, 11);
    assert.ok(plan.lines.at(-1)?.text.endsWith("…"));
  });

  test("the same text in a roomy bubble fits again (overflow false)", () => {
    assert.equal(mustPlan(unit({ translation: LONG })).overflow, false);
  });

  test("step 3 grows past the region with a halo when the image bounds are known, avoiding the cut", () => {
    const small = {
      region: b(300, 300, 400, 360),
      shape: "ellipse" as const,
      orientation: "h" as const,
      glyphPx: 20,
    };
    const image = { w: 800, h: 1200 };
    const cut = mustPlan(unit({ translation: LONG, fit: small }), 1, { ...OPTS, image, grow: false });
    assert.equal(cut.overflow, true);
    assert.equal(cut.haloPx, 0);
    const grown = mustPlan(unit({ translation: LONG, fit: small }), 1.25, { ...OPTS, image, grow: true });
    assert.equal(grown.overflow, false);
    assert.equal(grown.step, 3);
    assert.equal(grown.haloPx, HALO_CSS_PX / 1.25, "2 CSS px");
    assert.equal(grown.lines.map((l) => l.text).join(" "), LONG);
  });

  test("step 3 keeps clear of other units' boxes", () => {
    const small = {
      region: b(300, 300, 400, 360),
      shape: "ellipse" as const,
      orientation: "h" as const,
      glyphPx: 20,
    };
    const neighbour = b(250, 250, 450, 295);
    const plan = mustPlan(unit({ translation: LONG, fit: small }), 1, {
      ...OPTS,
      image: { w: 800, h: 1200 },
      grow: true,
      obstacles: [neighbour],
    });
    for (const l of plan.lines) assert.ok(l.y >= neighbour.y2 - 1e-9, `${l.text} stays below the neighbour`);
  });
});

describe("colours", () => {
  test("luminance and contrast follow WCAG", () => {
    assert.equal(relativeLuminance(WHITE), 1);
    assert.equal(relativeLuminance(BLACK), 0);
    assert.equal(contrastRatio(BLACK, WHITE), 21);
    assert.equal(contrastRatio(WHITE, WHITE), 1);
  });

  test("the original text colour is kept when readable, else black or white", () => {
    const red: RGB = [200, 0, 0];
    assert.deepEqual(readableText(red, WHITE), red);
    assert.deepEqual(readableText(WHITE, WHITE), BLACK);
    assert.deepEqual(readableText(BLACK, [20, 20, 20]), WHITE);
    assert.deepEqual(readableText([250, 240, 0], [255, 255, 255]), BLACK);
  });

  test("the plate takes erase.bg (white without one) and the text stays readable on it", () => {
    assert.deepEqual(mustPlan(unit()).fill, WHITE);
    const yellow: RGB = [255, 230, 0];
    const onYellow = mustPlan(
      unit({ erase: { kind: "box", rect: REGION, bg: yellow, textColor: [255, 255, 255] } }),
    );
    assert.deepEqual(onYellow.fill, yellow);
    assert.deepEqual(onYellow.color, BLACK);
    assert.equal(onYellow.fillAlpha, PLATE_ALPHA);
    const dark: RGB = [30, 30, 40];
    assert.deepEqual(
      mustPlan(unit({ erase: { kind: "box", rect: REGION, bg: dark, textColor: BLACK } })).color,
      WHITE,
    );
    const broken = mustPlan(
      unit({ erase: { kind: "box", rect: REGION, bg: [300, 0, 0], textColor: [0, 0, 0] } }),
    );
    assert.deepEqual(broken.fill, WHITE, "an out-of-range colour falls back to white");
  });
});

describe("hiding the original: erase patch, plate over the text area, or nothing", () => {
  const geometry: UnitGeometry = {
    unitKey: "u1",
    kind: "bubble",
    bubble: b(80, 80, 420, 280),
    text: b(110, 105, 390, 255),
    texts: [b(110, 105, 390, 130), b(200, 170, 300, 190)],
    orientation: "h",
    glyphPx: 24,
    order: 0,
  };
  const png = new ArrayBuffer(8);

  test("a mask with its PNG is drawn as a patch: no plate at all, so the balloon outline stays visible", () => {
    const plan = mustPlan(
      unit({ erase: { kind: "mask", rect: b(150, 140, 350, 220), bg: WHITE, textColor: BLACK, png } }),
      1,
      { ...OPTS, geometry },
    );
    assert.deepEqual(plan.patch, { rect: b(150, 140, 350, 220), png });
    assert.equal(plan.plate, null);
    assert.equal(plan.plateClip, null);
  });

  test("a box result gets a plate over the original text area and the translation, clipped inside the balloon", () => {
    const plan = mustPlan(unit(), 1, { ...OPTS, image: { w: 800, h: 1200 }, geometry });
    assert.equal(plan.patch, null);
    assert.ok(plan.plate !== null);
    const erase = b(150, 140, 350, 220);
    assert.ok(plan.plate.box.x1 <= erase.x1 && plan.plate.box.x2 >= erase.x2, "covers the original text");
    assert.ok(plan.plate.box.y1 <= erase.y1 && plan.plate.box.y2 >= erase.y2);
    assert.equal(plan.plate.shape, "rect");
    const dx = (REGION.x2 - REGION.x1) * BUBBLE_CLIP_INSET;
    const dy = (REGION.y2 - REGION.y1) * BUBBLE_CLIP_INSET;
    assert.deepEqual(plan.plateClip, {
      box: b(REGION.x1 + dx, REGION.y1 + dy, REGION.x2 - dx, REGION.y2 - dy),
      shape: "ellipse",
    });
  });

  test("a mask whose PNG has not arrived yet falls back to the plate", () => {
    const plan = mustPlan(unit({ erase: { kind: "mask", rect: REGION, bg: WHITE, textColor: BLACK } }));
    assert.equal(plan.patch, null);
    assert.ok(plan.plate !== null);
  });

  test("erase none: nothing to hide, only the translation", () => {
    const plan = mustPlan(unit({ erase: { kind: "none", rect: REGION, bg: WHITE, textColor: BLACK } }));
    assert.equal(plan.patch, null);
    assert.equal(plan.plate, null);
  });

  test("free text (no balloon) gets an unclipped plate inside the image", () => {
    const free: UnitGeometry = { ...geometry, kind: "free", bubble: null };
    const rect = {
      region: b(10, 5, 200, 60),
      shape: "rect" as const,
      orientation: "h" as const,
      glyphPx: 20,
    };
    const plan = mustPlan(
      unit({ fit: rect, erase: { kind: "box", rect: b(0, 0, 50, 20), bg: null, textColor: BLACK } }),
      1,
      { ...OPTS, image: { w: 800, h: 1200 }, geometry: free },
    );
    assert.equal(plan.plateClip, null);
    assert.ok(plan.plate !== null && plan.plate.box.x1 >= 0 && plan.plate.box.y1 >= 0);
  });

  test("insideShape checks every corner against the ellipse or the rect", () => {
    const outer = b(0, 0, 200, 100);
    assert.equal(insideShape(b(80, 40, 120, 60), outer, "ellipse"), true);
    assert.equal(insideShape(b(10, 10, 190, 90), outer, "ellipse"), false);
    assert.equal(insideShape(b(10, 10, 190, 90), outer, "rect"), true);
    assert.equal(insideShape(b(-1, 10, 190, 90), outer, "rect"), false);
  });
});

describe("SFX labels (never a plate over the art)", () => {
  const image = { w: 800, h: 1200 };

  test("an SFX gets a translucent white pill at the unit's top-right, with no covers", () => {
    const plan = mustPlan(unit({ type: "sfx", translation: "Rầm!" }), 1, { ...OPTS, image });
    assert.equal(plan.kind, "label");
    assert.equal(plan.patch, null);
    assert.equal(plan.plateClip, null);
    assert.ok(plan.plate !== null);
    assert.equal(plan.fillAlpha, SFX_LABEL.alpha);
    assert.deepEqual(plan.fill, WHITE);
    const pill = plan.plate.box;
    assert.equal(pill.x2, REGION.x2);
    assert.equal(pill.y1, REGION.y1);
    assert.ok(Math.abs(plan.plate.radius - (pill.y2 - pill.y1) / 2) < 1e-9);
    assert.equal(plan.fontPx, 15, "half the original glyph height");
    for (const l of plan.lines) {
      assert.ok(
        l.x >= pill.x1 &&
          l.x + l.width <= pill.x2 &&
          l.y >= pill.y1 &&
          l.y + plan.lineHeightPx <= pill.y2 + 1e-9,
      );
    }
  });

  test("the pill stays inside the image at its edges", () => {
    const edge = {
      region: b(700, 0, 800, 80),
      shape: "rect" as const,
      orientation: "h" as const,
      glyphPx: 60,
    };
    const plan = mustPlan(unit({ type: "sfx", translation: "Bùm bùm bùm", fit: edge }), 1, {
      ...OPTS,
      image,
    });
    const margin = SFX_LABEL.marginCss;
    assert.ok(plan.plate !== null);
    assert.ok(plan.plate.box.x2 <= image.w - margin + 1e-9);
    assert.ok(plan.plate.box.y1 >= margin - 1e-9);
  });

  test("an SFX without a valid translation gets no label either", () => {
    assert.equal(planUnit(unit({ type: "sfx", status: "untranslated" }), 1, fake, { ...OPTS, image }), null);
  });
});

describe("lettering faces: cap height per face, the Patrick Hand path unchanged", () => {
  const roomy = b(0, 0, 800, 400);
  const fitAt = (glyphPx: number, script: "latin" | "hangul") => ({
    region: roomy,
    shape: "rect" as const,
    orientation: "h" as const,
    glyphPx,
    script,
  });

  test("without capHeightEm the plan is exactly the Patrick Hand plan", () => {
    for (const u of [unit(), unit({ translation: LONG }), unit({ type: "sfx", translation: "Rầm!" })]) {
      assert.deepEqual(
        planUnit(u, 0.8, fake, { ...OPTS, image: { w: 800, h: 1200 } }),
        planUnit(u, 0.8, fake, { ...OPTS, image: { w: 800, h: 1200 }, capHeightEm: CAP_HEIGHT_EM }),
      );
    }
  });

  test("a face with taller capitals letters smaller, so its capitals still match the glyph", () => {
    const options = { minFontPx: 11, maxFontPx: 120, metrics: MALI_METRICS };
    for (const script of ["latin", "hangul"] as const) {
      const comic = mustPlan(unit({ translation: "Hola", fit: fitAt(33, script) }), 1, options);
      const mali = mustPlan(unit({ translation: "Hola", fit: fitAt(33, script) }), 1, {
        ...options,
        capHeightEm: 0.73,
      });
      // fitText searches sizes in 0.25 px steps up to the matched size.
      for (const [plan, cap] of [
        [comic, CAP_HEIGHT_EM],
        [mali, 0.73],
      ] as const) {
        const want = matchFontPx(33, script, cap);
        assert.ok(
          plan.fontPx <= want + 1e-9 && plan.fontPx > want - 0.25,
          `${script} ${cap}: ${plan.fontPx}`,
        );
      }
      assert.ok(mali.fontPx < comic.fontPx, script);
      const caps = (plan: UnitPlan, cap: number): number => plan.fontPx * cap;
      assert.ok(
        Math.abs(caps(mali, 0.73) - caps(comic, CAP_HEIGHT_EM)) < 0.25 * 0.73,
        `${script}: same caps`,
      );
    }
  });
});

describe("SFX: label, erase in place, or untouched (render.sfxLabels, render.eraseSfx)", () => {
  const png = new ArrayBuffer(8);
  const image = { w: 800, h: 1200 };
  const mask = { kind: "mask" as const, rect: b(150, 140, 350, 220), bg: WHITE, textColor: BLACK, png };
  const sfx = (over: Partial<UnitRender> = {}): UnitRender =>
    unit({ type: "sfx", translation: "ẦM!", ...over });

  test("sfxMode: erase only with eraseSfx and a clean mask patch; else a label, or nothing without labels", () => {
    assert.equal(sfxMode(sfx({ erase: mask })), "label", "defaults: labels on, erase off");
    assert.equal(sfxMode(sfx({ erase: mask }), true), "erase");
    assert.equal(sfxMode(sfx({ erase: mask }), true, false), "erase");
    assert.equal(sfxMode(sfx({ erase: { ...mask, kind: "box" } }), true), "label", "never a plate over art");
    assert.equal(sfxMode(sfx({ erase: { ...mask, kind: "none" } }), true), "label");
    const noPng = sfx({ erase: { kind: "mask", rect: mask.rect, bg: WHITE, textColor: BLACK } });
    assert.equal(sfxMode(noPng, true), "label", "the patch has not arrived yet");
    assert.equal(sfxMode(noPng, true, false), "none");
    assert.equal(sfxMode(sfx({ erase: mask }), false, false), "none");
  });

  test("eraseSfx: the clean patch is drawn and the translation fitted in place, without any plate", () => {
    const plan = mustPlan(sfx({ erase: mask }), 1, { ...OPTS, image, eraseSfx: true });
    assert.equal(plan.kind, "text");
    assert.deepEqual(plan.patch, { rect: mask.rect, png });
    assert.equal(plan.plate, null);
    assert.equal(plan.plateClip, null);
    for (const l of plan.lines) assert.ok(l.x >= REGION.x1 - 1e-9 && l.x + l.width <= REGION.x2 + 1e-9);
  });

  test("sfxLabels off: an SFX that is not erased paints nothing; with labels it keeps its pill", () => {
    assert.equal(planUnit(sfx({ erase: mask }), 1, fake, { ...OPTS, image, sfxLabels: false }), null);
    const box = sfx({ erase: { ...mask, kind: "box" } });
    assert.equal(planUnit(box, 1, fake, { ...OPTS, image, eraseSfx: true, sfxLabels: false }), null);
    assert.equal(mustPlan(box, 1, { ...OPTS, image, eraseSfx: true }).kind, "label");
  });

  test("dialogue ignores both SFX settings", () => {
    const u = unit({ erase: mask });
    assert.deepEqual(
      planUnit(u, 1, fake, { ...OPTS, image }),
      planUnit(u, 1, fake, { ...OPTS, image, eraseSfx: true, sfxLabels: false }),
    );
  });
});

describe("hit box (Alt+click and long-press target)", () => {
  test("lettering in a balloon answers on the whole interior and everything drawn", () => {
    const plan = mustPlan(unit({ translation: LONG }), 1, { ...OPTS, image: { w: 800, h: 1200 } });
    const box = unitHitBox(plan, REGION);
    assert.ok(box !== null);
    assert.ok(box.x1 <= REGION.x1 && box.y1 <= REGION.y1 && box.x2 >= REGION.x2 && box.y2 >= REGION.y2);
    assert.ok(plan.plate !== null);
    assert.ok(box.x1 <= plan.plate.box.x1 && box.y2 >= plan.plate.box.y2, "covers the plate");
    for (const l of plan.lines) assert.ok(l.x >= box.x1 && l.x + l.width <= box.x2 && l.y >= box.y1);
  });

  test("an SFX label answers on its pill only, not on the art it labels", () => {
    const plan = mustPlan(unit({ type: "sfx", translation: "Rầm!" }), 1, {
      ...OPTS,
      image: { w: 800, h: 1200 },
    });
    assert.ok(plan.plate !== null);
    assert.deepEqual(unitHitBox(plan, REGION), plan.plate.box);
  });

  test("an invalid region adds nothing", () => {
    const plan = mustPlan(unit());
    assert.deepEqual(unitHitBox(plan, b(0, 0, 0, 0)), unitHitBox(plan, null));
    assert.ok(unitHitBox(plan, null) !== null, "the drawn plate and lines remain");
  });
});

describe("SFX label pill and tall marks", () => {
  const image = { w: 800, h: 1200 };
  const tall = { lineHeight: 1.5, ascent: 0.883, descent: 0.181, pixelSnap: true };

  test("labelRiseEm: how far the ink rises above the line box; 0 inside it or unknown", () => {
    assert.ok(Math.abs(labelRiseEm(tall, 1.390625) - (1.390625 - (0.883 + (1.5 - 1.064) / 2))) < 1e-12);
    assert.equal(labelRiseEm(PATRICK_HAND_METRICS, 1.015625), 0);
    assert.equal(labelRiseEm(MALI_METRICS, 1.109375), 0);
    assert.equal(labelRiseEm(tall, undefined), 0);
    assert.equal(labelRiseEm(tall, Number.NaN), 0);
  });

  test("the pill grows at the top by the rise; the lines keep their place relative to its bottom", () => {
    const u = unit({ type: "sfx", translation: "VÚT!" });
    const flat = mustPlan(u, 1, { ...OPTS, image, metrics: tall });
    const grown = mustPlan(u, 1, { ...OPTS, image, metrics: tall, inkAscentEm: 1.390625 });
    assert.ok(flat.plate !== null && grown.plate !== null);
    const rise = labelRiseEm(tall, 1.390625) * grown.fontPx;
    const height = (p: UnitPlan): number => (p.plate === null ? 0 : p.plate.box.y2 - p.plate.box.y1);
    assert.ok(Math.abs(height(grown) - height(flat) - rise) < 1e-9);
    const first = grown.lines[0];
    assert.ok(first !== undefined);
    const baseline = first.y + lineBox(grown.fontPx, tall).baseline;
    assert.ok(
      baseline - 1.390625 * grown.fontPx >= grown.plate.box.y1 - 1e-9,
      "the marks stay inside the pill",
    );
    assert.deepEqual(
      mustPlan(u, 1, { ...OPTS, image, inkAscentEm: 1.015625 }),
      mustPlan(u, 1, { ...OPTS, image }),
      "Patrick Hand: unchanged",
    );
  });
});

describe("vertical lettering (Japanese and Traditional Chinese in tategaki balloons)", () => {
  /** Fake CJK font: full-width characters 1 em, the rest 0.5 em. */
  const wide = (s: string, px: number): number =>
    [...s].reduce(
      (sum, ch) => sum + (/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}、。！]/u.test(ch) ? px : px / 2),
      0,
    );
  const tall = b(300, 100, 420, 460);
  const ja = unit({
    translation: "この地図、町の半分しか載ってないよ！",
    fit: { region: tall, shape: "ellipse", orientation: "v", glyphPx: 28, script: "cjk" },
    erase: {
      kind: "mask",
      rect: b(320, 140, 400, 420),
      bg: WHITE,
      textColor: BLACK,
      png: new ArrayBuffer(8),
    },
  });

  test("columns run top to bottom, right to left, inside the balloon; each knows its length", () => {
    const plan = planUnit(ja, 1, wide, {
      ...OPTS,
      maxFontPx: 60,
      vertical: true,
      image: { w: 800, h: 1200 },
    });
    assert.ok(plan !== null);
    assert.equal(plan.vertical, true);
    assert.ok(plan.lines.length >= 2);
    assert.equal(plan.lines.map((l) => l.text).join(""), ja.translation);
    for (const [i, col] of plan.lines.entries()) {
      assert.equal(col.width, plan.lineHeightPx, "a column box is one line-height wide");
      assert.ok(col.height !== undefined && col.height > 0);
      assert.ok(col.x >= tall.x1 - 1e-9 && col.x + col.width <= tall.x2 + 1e-9, `column ${i} x`);
      assert.ok(col.y >= tall.y1 - 1e-9 && col.y + (col.height ?? 0) <= tall.y2 + 1e-9, `column ${i} y`);
      // Typed explicitly: newer @types/node assertion signatures make the inference circular here.
      const next: (typeof plan.lines)[number] | undefined = plan.lines[i + 1];
      if (next !== undefined) assert.ok(next.x < col.x, "right to left");
    }
    assert.ok(plan.patch !== null, "the erase patch is drawn as usual");
    const hit = unitHitBox(plan, tall);
    assert.ok(hit !== null);
    for (const col of plan.lines) assert.ok(col.y + (col.height ?? 0) <= hit.y2 + 1e-9);
  });

  test("without vertical the same unit is laid out horizontally, exactly as before", () => {
    const flat = planUnit(ja, 1, wide, { ...OPTS, maxFontPx: 60 });
    const asked = planUnit(ja, 1, wide, { ...OPTS, maxFontPx: 60, vertical: false });
    assert.ok(flat !== null && asked !== null);
    assert.deepEqual(asked, flat);
    assert.equal("vertical" in flat, false);
    assert.ok(flat.lines.every((l) => l.height === undefined));
  });

  test("an SFX label stays a horizontal pill even when the unit is vertical", () => {
    const sfx = unit({
      type: "sfx",
      translation: "ドン！",
      fit: { ...ja.fit, region: b(500, 500, 600, 700) },
    });
    const plan = planUnit(sfx, 1, wide, { ...OPTS, vertical: true, image: { w: 800, h: 1200 } });
    assert.ok(plan !== null);
    assert.equal(plan.kind, "label");
    assert.equal("vertical" in plan, false);
  });

  test("CJK lettering is sized by ink height: Han ink as tall as the original glyph", () => {
    const roomy = unit({
      translation: "雨",
      fit: { region: b(0, 0, 800, 400), shape: "rect", orientation: "h", glyphPx: 30, script: "hangul" },
    });
    const match = { latin: 1.2, hangul: 1, cjk: 1 };
    const plan = planUnit(roomy, 1, wide, {
      minFontPx: 11,
      maxFontPx: 120,
      capHeightEm: 0.88,
      sizeMatch: match,
    });
    assert.ok(plan !== null);
    const want = matchFontPx(30, "hangul", 0.88, match);
    assert.ok(plan.fontPx <= want + 1e-9 && plan.fontPx > want - 0.25, `${plan.fontPx} vs ${want}`);
  });
});
