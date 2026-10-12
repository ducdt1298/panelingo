import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  crossesSeam,
  groupStrips,
  mapSeamBox,
  seamBand,
  seamCanvasPlan,
  seamIdOf,
  seamWindows,
  stripIdOf,
} from "../../../src/shared/core/strips.ts";
import type { StripImage } from "../../../src/shared/core/strips.ts";

const img = (key: string, top: number, height = 2000, left = 100, width = 800): StripImage => ({
  key,
  left,
  top,
  width,
  height,
});

const keysOf = (groups: ReturnType<typeof groupStrips>): string[][] =>
  groups.map((g) => g.members.map((m) => m.key));

describe("groupStrips", () => {
  test("images stacked with a 0 px gap form one strip", () => {
    const groups = groupStrips([img("a", 0), img("b", 2000), img("c", 4000)]);
    assert.deepEqual(keysOf(groups), [["a", "b", "c"]]);
    assert.equal(groups[0]?.stripId, stripIdOf("a"));
    assert.match(groups[0]?.stripId ?? "", /^strip-[0-9a-f]{8}$/);
  });

  test("a 4 px gap still touches, 5 px does not", () => {
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 2004), img("c", 4008)])), [["a", "b", "c"]]);
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 2004), img("c", 4009)])), [["a", "b"]]);
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 2005)])), []);
  });

  test("non-touching images (offset left edge, far apart) form no strip", () => {
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 2000, 2000, 103)])), []);
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 3000)])), []);
  });

  test("left and width match within ±2 px", () => {
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 2000, 2000, 102, 798)])), [["a", "b"]]);
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 2000, 2000, 100, 803)])), []);
  });

  test("tolerances compare consecutive images, so a slow drift stays one strip", () => {
    const drift = [img("a", 0, 2000, 100), img("b", 2000, 2000, 102), img("c", 4000, 2000, 104)];
    assert.deepEqual(keysOf(groupStrips(drift)), [["a", "b", "c"]]);
  });

  test("sub-pixel overlap and float noise are tolerated", () => {
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 1999)])), [["a", "b"]]);
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 1998)])), []);
    assert.deepEqual(keysOf(groupStrips([img("a", 0.1, 1999.7), img("b", 1999.8 + 4.0000000001)])), [
      ["a", "b"],
    ]);
  });

  test("several strips in DOM order; a broken rect splits them", () => {
    const list = [
      img("a", 0),
      img("b", 2000),
      img("x", 4500),
      img("c", 6000),
      img("d", 8000),
      { ...img("e", 10000), height: Number.NaN },
      img("f", 10000),
      img("g", 12000),
    ];
    assert.deepEqual(keysOf(groupStrips(list)), [
      ["a", "b"],
      ["c", "d"],
      ["f", "g"],
    ]);
  });

  test("minMembers 1 reports single images too", () => {
    assert.deepEqual(keysOf(groupStrips([img("a", 0), img("b", 3000)], { minMembers: 1 })), [["a"], ["b"]]);
  });
});

describe("seamWindows", () => {
  test("one window per shared edge, edgePx deep on each side", () => {
    const [group] = groupStrips([img("a", 0), img("b", 2000), img("c", 4004, 30)]);
    assert.ok(group);
    const windows = seamWindows(group);
    assert.equal(windows.length, 2);
    assert.deepEqual(windows[0], {
      seamId: seamIdOf("a", "b"),
      index: 0,
      upperKey: "a",
      lowerKey: "b",
      edge: 2000,
      gap: 0,
      upper: { y0: 1950, y1: 2000 },
      lower: { y0: 0, y1: 50 },
    });
    assert.equal(windows[1]?.gap, 4);
    assert.deepEqual(windows[1]?.lower, { y0: 0, y1: 30 }, "clipped to a short lower image");
    assert.notEqual(windows[0]?.seamId, windows[1]?.seamId);
  });

  test("natural-px windows when both images carry their natural size", () => {
    const group = {
      stripId: "s",
      members: [
        { ...img("a", 0, 1000), naturalWidth: 1600, naturalHeight: 2000 },
        { ...img("b", 1000, 20), naturalWidth: 1600, naturalHeight: 40 },
      ],
    };
    const [window] = seamWindows(group, 25);
    assert.deepEqual(window?.upper, { y0: 975, y1: 1000 });
    assert.deepEqual(window?.natural, { upper: { y0: 1950, y1: 2000 }, lower: { y0: 0, y1: 40 } });
    assert.equal(
      seamWindows({ stripId: "s", members: [img("a", 0), img("b", 2000)] })[0]?.natural,
      undefined,
    );
  });
});

describe("seam canvas (B.2.4)", () => {
  test("band = clamp(1.5 × tallest touching box, 0.5 W, 1.5 W)", () => {
    assert.equal(seamBand([100, 300], 800), 450);
    assert.equal(seamBand([], 800), 400);
    assert.equal(seamBand([1000], 800), 1200);
  });

  test("canvas layout: upper rows end at the seam line, lower rows are scaled to the upper width", () => {
    const plan = seamCanvasPlan({ w: 800, h: 2000 }, { w: 400, h: 1000 }, 450);
    assert.deepEqual(plan, {
      width: 800,
      height: 900,
      band: 450,
      s1: 2,
      upperRows: { y0: 1550, y1: 2000 },
      upperAt: 0,
      lowerRows: { y0: 0, y1: 225 },
    });
    const short = seamCanvasPlan({ w: 800, h: 300 }, { w: 800, h: 100 }, 450);
    assert.deepEqual(
      [short.upperRows, short.upperAt, short.lowerRows],
      [{ y0: 0, y1: 300 }, 150, { y0: 0, y1: 100 }],
    );
    assert.throws(() => seamCanvasPlan({ w: 0, h: 10 }, { w: 10, h: 10 }, 5), RangeError);
  });

  test("crossing units map back into both images", () => {
    const plan = seamCanvasPlan({ w: 800, h: 2000 }, { w: 400, h: 1000 }, 450);
    const crossing = { x1: 100, y1: 400, x2: 300, y2: 520 };
    assert.equal(crossesSeam(crossing, plan), true);
    assert.equal(crossesSeam({ x1: 0, y1: 0, x2: 10, y2: 440 }, plan), false);
    assert.deepEqual(mapSeamBox(crossing, plan, "upper"), { x1: 100, y1: 1950, x2: 300, y2: 2070 });
    assert.deepEqual(mapSeamBox(crossing, plan, "lower"), { x1: 50, y1: -25, x2: 150, y2: 35 });
  });

  test("mapping round trip for the upper image", () => {
    const plan = seamCanvasPlan({ w: 800, h: 2000 }, { w: 800, h: 2000 }, 600);
    const inUpper = { x1: 100, y1: 1900, x2: 300, y2: 1990 };
    const onCanvas = { ...inUpper, y1: inUpper.y1 - 1400, y2: inUpper.y2 - 1400 };
    assert.deepEqual(mapSeamBox(onCanvas, plan, "upper"), inUpper);
  });

  test("mapping round trip for the lower image, drawn scaled by s1 below the seam line", () => {
    for (const lowerW of [400, 1000]) {
      const plan = seamCanvasPlan({ w: 800, h: 2000 }, { w: lowerW, h: 1500 }, 500);
      const inLower = { x1: 40, y1: 10, x2: 360, y2: 120 };
      const onCanvas = {
        x1: inLower.x1 * plan.s1,
        y1: inLower.y1 * plan.s1 + plan.band,
        x2: inLower.x2 * plan.s1,
        y2: inLower.y2 * plan.s1 + plan.band,
      };
      const back = mapSeamBox(onCanvas, plan, "lower");
      for (const k of ["x1", "y1", "x2", "y2"] as const) {
        assert.ok(Math.abs(back[k] - inLower[k]) < 1e-9, `${lowerW}: ${k} ${back[k]} vs ${inLower[k]}`);
      }
    }
  });
});
