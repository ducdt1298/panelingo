import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INTERIOR_DEFAULTS,
  balloonInterior,
  isFlatBoxInterior,
  solidPatch,
} from "../../../src/shared/core/bubble-interior.ts";
import type { ImageDataLike } from "../../../src/shared/gfx.ts";
import type { Box, RGB } from "../../../src/shared/types.ts";

const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });

function canvas(
  w: number,
  h: number,
  fill: RGB,
): ImageDataLike & { set(x: number, y: number, c: RGB): void } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([fill[0], fill[1], fill[2], 255], i * 4);
  return {
    width: w,
    height: h,
    data,
    set(x, y, c) {
      if (x >= 0 && y >= 0 && x < w && y < h) data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    },
  };
}

const PAGE: RGB = [230, 230, 230];
const WHITE: RGB = [255, 255, 255];
const INK: RGB = [20, 20, 20];

/** A box caption: frame of `thick` px at `frame`, filled `fill`, on a page. */
function boxCaption(frame: Box, thick: number, fill: RGB, page: RGB = PAGE) {
  const img = canvas(300, 200, page);
  for (let y = frame.y1; y < frame.y2; y++) {
    for (let x = frame.x1; x < frame.x2; x++) {
      const edge =
        x < frame.x1 + thick || x >= frame.x2 - thick || y < frame.y1 + thick || y >= frame.y2 - thick;
      img.set(x, y, edge ? INK : fill);
    }
  }
  return img;
}

/** An elliptical balloon with a `thick` px outline inside `box`. */
function ellipseBalloon(box: Box, thick: number, page: RGB = PAGE) {
  const img = canvas(400, 300, page);
  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  const a = (box.x2 - box.x1) / 2;
  const bb = (box.y2 - box.y1) / 2;
  for (let y = box.y1; y < box.y2; y++) {
    for (let x = box.x1; x < box.x2; x++) {
      const r = Math.hypot((x + 0.5 - cx) / a, (y + 0.5 - cy) / bb);
      if (r <= 1) img.set(x, y, r > 1 - thick / Math.min(a, bb) ? INK : WHITE);
    }
  }
  return img;
}

test("a box caption: every side snaps just inside the frame, and it is rect-like", () => {
  // Frame 40..260 × 50..110, 3 px thick; the detector's bubble box reaches 5 px past it.
  const img = boxCaption(b(40, 50, 260, 110), 3, [255, 248, 225]);
  const text = b(60, 64, 240, 96);
  const r = balloonInterior(img, { x: 0, y: 0 }, text, b(35, 45, 265, 115));
  assert.deepEqual(r.snapped, { left: true, top: true, right: true, bottom: true });
  // Interior begins 1 px (marginPx) after the last frame pixel.
  assert.deepEqual(r.box, b(43 + INTERIOR_DEFAULTS.marginPx, 53 + INTERIOR_DEFAULTS.marginPx, 256, 106));
  assert.deepEqual(r.fill, [255, 248, 225]);
  assert.equal(r.rectLike, true);
});

test("an elliptical balloon snaps to its outline but is not rect-like (its outline cuts the box corners)", () => {
  const box = b(50, 50, 350, 250);
  const img = ellipseBalloon(box, 4);
  const text = b(120, 115, 280, 185);
  const r = balloonInterior(img, { x: 0, y: 0 }, text, b(44, 44, 356, 256));
  assert.equal(r.snapped.left && r.snapped.right && r.snapped.top && r.snapped.bottom, true);
  assert.ok(r.box.x1 >= 54 && r.box.x1 <= 57, `left ${r.box.x1}`);
  assert.ok(r.box.x2 <= 346 && r.box.x2 >= 343, `right ${r.box.x2}`);
  assert.equal(r.rectLike, false);
  // Same result on a white page (the page colour beyond the outline must not matter).
  const onWhite = balloonInterior(ellipseBalloon(box, 4, WHITE), { x: 0, y: 0 }, text, b(44, 44, 356, 256));
  assert.equal(onWhite.rectLike, false);
});

test("a dark sign with a slightly darker frame is found too (strongDist is low enough)", () => {
  const img = boxCaption(b(20, 20, 200, 80), 3, [121, 85, 72], [200, 180, 160]);
  for (let x = 20; x < 200; x++) for (let k = 0; k < 3; k++) img.set(x, 20 + k, [74, 46, 37]);
  for (let x = 20; x < 200; x++) for (let k = 0; k < 3; k++) img.set(x, 77 + k, [74, 46, 37]);
  for (let y = 20; y < 80; y++) for (let k = 0; k < 3; k++) img.set(20 + k, y, [74, 46, 37]);
  for (let y = 20; y < 80; y++) for (let k = 0; k < 3; k++) img.set(197 + k, y, [74, 46, 37]);
  const r = balloonInterior(img, { x: 0, y: 0 }, b(40, 34, 180, 66), b(14, 14, 206, 86));
  assert.deepEqual(r.fill, [121, 85, 72]);
  assert.equal(r.snapped.top && r.snapped.bottom, true);
  assert.ok(r.box.y1 >= 23 && r.box.y2 <= 77);
});

test("no outline in reach: the bubble box is returned unchanged; the result always contains the text box", () => {
  const img = canvas(200, 120, WHITE);
  const bubble = b(10, 10, 190, 110);
  const r = balloonInterior(img, { x: 0, y: 0 }, b(40, 40, 160, 80), bubble);
  assert.deepEqual(r.box, bubble);
  assert.equal(r.rectLike, false);
  // Ink right next to the text box (inside the colour band) is never taken for the outline.
  const tight = boxCaption(b(30, 30, 170, 90), 2, WHITE);
  const text = b(33, 33, 167, 87);
  const t = balloonInterior(tight, { x: 0, y: 0 }, text, b(25, 25, 175, 95));
  assert.ok(t.box.x1 <= text.x1 && t.box.y1 <= text.y1 && t.box.x2 >= text.x2 && t.box.y2 >= text.y2);
});

test("crop origins are honoured (natural px in and out)", () => {
  const img = boxCaption(b(40, 50, 260, 110), 3, WHITE);
  const shifted = balloonInterior(
    img,
    { x: 1000, y: 2000 },
    b(1060, 2064, 1240, 2096),
    b(1035, 2045, 1265, 2115),
  );
  assert.deepEqual(shifted.box, b(1044, 2054, 1256, 2106));
  assert.deepEqual(
    balloonInterior(
      { width: 0, height: 0, data: new Uint8ClampedArray(0) },
      { x: 0, y: 0 },
      b(1, 1, 2, 2),
      b(0, 0, 3, 3),
    ).box,
    b(0, 0, 3, 3),
  );
});

test("isFlatBoxInterior: a flat caption whose text fills it; not for textured, unsnapped or elliptical interiors", () => {
  const fill: RGB = [255, 248, 225];
  const img = boxCaption(b(40, 50, 260, 110), 3, fill);
  const text = b(48, 58, 252, 102);
  // Glyph-like ink across the text box, 4-5 px from the frame on every side.
  for (let y = 60; y < 100; y += 6) for (let x = 50; x < 250; x++) if (x % 7 < 3) img.set(x, y, INK);
  const bubble = b(35, 45, 265, 115);
  const found = balloonInterior(img, { x: 0, y: 0 }, text, bubble);
  assert.equal(found.rectLike, true);
  assert.equal(isFlatBoxInterior(img, { x: 0, y: 0 }, found, text), true);

  // Screentone in the band between the frame and the text: not flat.
  const tone = boxCaption(b(40, 50, 260, 110), 3, fill);
  for (let y = 54; y < 106; y += 2) for (let x = 44; x < 256; x += 2) tone.set(x, y, [150, 150, 150]);
  const toneFound = { ...found, fill };
  assert.equal(isFlatBoxInterior(tone, { x: 0, y: 0 }, toneFound, text), false);

  // Sides that did not snap, a missing fill, or an elliptical balloon never qualify.
  assert.equal(
    isFlatBoxInterior(img, { x: 0, y: 0 }, { ...found, snapped: { ...found.snapped, top: false } }, text),
    false,
  );
  assert.equal(isFlatBoxInterior(img, { x: 0, y: 0 }, { ...found, fill: null }, text), false);
  assert.equal(isFlatBoxInterior(img, { x: 0, y: 0 }, { ...found, rectLike: false }, text), false);
});

test("solidPatch: an opaque patch of one colour", () => {
  const patch = solidPatch(3, 2, [10, 20, 30]);
  assert.equal(patch.width, 3);
  assert.equal(patch.height, 2);
  assert.deepEqual([...patch.data], Array.from({ length: 6 }, () => [10, 20, 30, 255]).flat());
});
