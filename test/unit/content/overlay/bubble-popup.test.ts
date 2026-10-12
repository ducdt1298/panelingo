// Bubble popup: placement next to the balloon inside the viewport, its title and status line (the DOM card itself is
// exercised by e2e/bubble-popup.e2e.ts).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  POPUP_GAP,
  POPUP_MARGIN,
  placePopup,
  popupTitle,
  statusLine,
} from "../../../../src/content/overlay/bubble-popup.ts";
import { EN } from "../../../../src/shared/i18n/en.ts";
import { msg, setLocale } from "../../../../src/shared/i18n/index.ts";
import type { RectCss } from "../../../../src/shared/types.ts";

const VIEW = { w: 1280, h: 800 };
const CARD = { w: 320, h: 220 };
const rect = (left: number, top: number, width: number, height: number): RectCss => ({
  left,
  top,
  width,
  height,
});

describe("placePopup", () => {
  test("to the right of the balloon, top-aligned, when there is room", () => {
    const spot = placePopup(rect(200, 100, 300, 150), CARD, VIEW);
    assert.deepEqual(spot, { left: 500 + POPUP_GAP, top: 100, side: "right" });
  });

  test("to the left when the right side is too narrow", () => {
    const spot = placePopup(rect(900, 300, 300, 150), CARD, VIEW);
    assert.deepEqual(spot, { left: 900 - POPUP_GAP - CARD.w, top: 300, side: "left" });
  });

  test("below, then above, a balloon as wide as the viewport, centred on it", () => {
    const below = placePopup(rect(20, 100, 1240, 200), CARD, VIEW);
    assert.equal(below.side, "below");
    assert.equal(below.top, 300 + POPUP_GAP);
    assert.equal(below.left, 20 + 620 - CARD.w / 2);
    const above = placePopup(rect(20, 450, 1240, 300), CARD, VIEW);
    assert.equal(above.side, "above");
    assert.equal(above.top, 450 - POPUP_GAP - CARD.h);
  });

  test("always inside the viewport: clamped by the margin, even when nothing fits", () => {
    const cases = [
      rect(200, 700, 300, 90), // near the bottom: top clamped up
      rect(200, -400, 300, 450), // scrolled half out at the top
      rect(0, 0, 1280, 800), // fills the viewport: best side, clamped
      rect(-50, 100, 40, 40), // off to the left
    ];
    for (const anchor of cases) {
      const spot = placePopup(anchor, CARD, VIEW);
      assert.ok(
        spot.left >= POPUP_MARGIN && spot.left + CARD.w <= VIEW.w - POPUP_MARGIN,
        JSON.stringify(anchor),
      );
      assert.ok(
        spot.top >= POPUP_MARGIN && spot.top + CARD.h <= VIEW.h - POPUP_MARGIN,
        JSON.stringify(anchor),
      );
    }
    const near = placePopup(rect(200, 700, 300, 90), CARD, VIEW);
    assert.equal(near.side, "right");
    assert.equal(near.top, VIEW.h - POPUP_MARGIN - CARD.h);
  });

  test("a card larger than the viewport sticks to the top-left margin", () => {
    const spot = placePopup(rect(100, 100, 50, 50), { w: 2000, h: 2000 }, VIEW);
    assert.equal(spot.left, POPUP_MARGIN);
    assert.equal(spot.top, POPUP_MARGIN);
  });
});

describe("texts", () => {
  afterEach(() => setLocale("en"));

  test("the title is the line type, then the speaker when named", () => {
    assert.equal(popupTitle("dialogue", "Minho"), `${EN.sidepanel.types.dialogue} · Minho`);
    assert.equal(popupTitle("narration", "  "), EN.sidepanel.types.narration);
    assert.equal(popupTitle("sfx", ""), "SFX");
    setLocale("vi");
    assert.equal(popupTitle("thought", "Jisoo"), `${msg().sidepanel.types.thought} · Jisoo`);
  });

  test("a painted unit has no status line; others name their status", () => {
    assert.equal(statusLine("ok"), "");
    assert.equal(statusLine("manual"), "");
    assert.equal(statusLine("pending"), EN.unitStatus.pending);
    assert.equal(statusLine("error"), EN.unitStatus.error);
  });

  test("every popup string exists in English", () => {
    for (const key of ["dialog", "copy", "editLabel", "shortened", "saved", "retranslating"] as const) {
      assert.ok(EN.bubble[key].length > 0, key);
    }
  });
});
