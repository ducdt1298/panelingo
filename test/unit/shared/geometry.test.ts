import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  area,
  box,
  center,
  clip,
  contain,
  height,
  hOverlap,
  inflate,
  inter,
  iou,
  ios,
  scale,
  translate,
  union,
  unionAll,
  vOverlap,
  width,
} from "../../../src/shared/geometry.ts";

const A = box(0, 0, 10, 10);
const B = box(5, 5, 15, 15);
const FAR = box(100, 100, 110, 120);

describe("size", () => {
  test("box builds an exclusive-corner rectangle", () => {
    assert.deepEqual(box(1, 2, 3, 4), { x1: 1, y1: 2, x2: 3, y2: 4 });
  });

  test("width, height and area are clamped at zero for inverted boxes", () => {
    assert.equal(width(A), 10);
    assert.equal(height(FAR), 20);
    assert.equal(area(FAR), 200);
    const inverted = box(10, 10, 0, 5);
    assert.equal(width(inverted), 0);
    assert.equal(height(inverted), 0);
    assert.equal(area(inverted), 0);
  });

  test("center is the midpoint", () => {
    assert.deepEqual(center(box(0, 10, 20, 30)), { x: 10, y: 20 });
  });
});

describe("overlap measures", () => {
  test("inter is the overlap area, zero when boxes only touch or are apart", () => {
    assert.equal(inter(A, B), 25);
    assert.equal(inter(A, FAR), 0);
    assert.equal(inter(A, box(10, 0, 20, 10)), 0, "shared edge has no area");
  });

  test("iou: identical 1, partial 25/175, disjoint 0, degenerate 0", () => {
    assert.equal(iou(A, A), 1);
    assert.equal(iou(A, B), 25 / 175);
    assert.equal(iou(A, FAR), 0);
    assert.equal(iou(box(0, 0, 0, 0), box(0, 0, 0, 0)), 0);
  });

  test("ios is 1 when one box lies inside the other", () => {
    const inner = box(2, 2, 4, 4);
    assert.equal(ios(A, inner), 1);
    assert.equal(ios(inner, A), 1);
    assert.equal(ios(A, B), 25 / 100);
    assert.equal(ios(A, box(3, 3, 3, 9)), 0, "zero-area box");
  });

  test("contain is the share of the first box inside the second", () => {
    const wide = box(0, 0, 20, 10);
    assert.equal(contain(A, wide), 1);
    assert.equal(contain(wide, A), 0.5);
    assert.equal(contain(box(5, 5, 5, 5), A), 0, "empty inner box");
  });

  test("vOverlap and hOverlap are relative to the shorter / narrower box", () => {
    const tall = box(0, 0, 10, 100);
    const short = box(50, 40, 60, 60);
    assert.equal(vOverlap(tall, short), 1);
    assert.equal(vOverlap(box(0, 0, 10, 10), box(0, 5, 10, 25)), 0.5);
    assert.equal(vOverlap(A, FAR), 0);
    assert.equal(hOverlap(box(0, 0, 100, 10), box(40, 50, 60, 60)), 1);
    assert.equal(hOverlap(box(0, 0, 10, 10), box(8, 0, 18, 10)), 0.2);
    assert.equal(hOverlap(A, box(10, 0, 20, 10)), 0, "touching edges");
  });
});

describe("constructions", () => {
  test("union and unionAll", () => {
    assert.deepEqual(union(A, FAR), { x1: 0, y1: 0, x2: 110, y2: 120 });
    assert.equal(unionAll([]), null);
    assert.deepEqual(unionAll([B]), B);
    assert.deepEqual(unionAll([A, B, FAR]), { x1: 0, y1: 0, x2: 110, y2: 120 });
  });

  test("unionAll does not alias its input", () => {
    const only = box(1, 1, 2, 2);
    const u = unionAll([only]);
    assert.notEqual(u, only);
  });

  test("inflate grows or shrinks every side", () => {
    assert.deepEqual(inflate(A, 2), { x1: -2, y1: -2, x2: 12, y2: 12 });
    assert.deepEqual(inflate(A, -3), { x1: 3, y1: 3, x2: 7, y2: 7 });
  });

  test("clip keeps the box inside [0, w) × [0, h)", () => {
    assert.deepEqual(clip(box(-5, -5, 50, 8), { w: 20, h: 10 }), { x1: 0, y1: 0, x2: 20, y2: 8 });
    assert.deepEqual(clip(box(30, 30, 40, 40), { w: 20, h: 10 }), { x1: 20, y1: 10, x2: 20, y2: 10 });
  });

  test("translate and scale", () => {
    assert.deepEqual(translate(A, 5, -2), { x1: 5, y1: -2, x2: 15, y2: 8 });
    assert.deepEqual(scale(A, 2), { x1: 0, y1: 0, x2: 20, y2: 20 });
    assert.deepEqual(scale(B, 2, 0.5), { x1: 10, y1: 2.5, x2: 30, y2: 7.5 });
  });
});
