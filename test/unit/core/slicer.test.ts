import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SLICER_DEFAULTS,
  defaultQuietMinRun,
  grayFromRgba,
  planSlices,
  quietColsFromGray,
  quietRowsFromGray,
  sliceSearchWindows,
} from "../../../src/shared/core/slicer.ts";
import type { Slice, SliceOptions, SlicePlan } from "../../../src/shared/core/slicer.ts";
import type { Size } from "../../../src/shared/types.ts";

/** Checks every guarantee of a plan; returns the slice starts/ends along the axis. */
function assertPlanInvariants(plan: SlicePlan, size: Size, maxLen: number): void {
  const vertical = plan.axis === "vertical";
  const long = vertical ? size.h : size.w;
  const at = (s: Slice): [number, number] => (vertical ? [s.y, s.y + s.h] : [s.x, s.x + s.w]);
  assert.ok(plan.slices.length >= 2, "sliced plans have at least two slices");
  assert.equal(at(plan.slices[0] as Slice)[0], 0, "first slice starts at 0");
  assert.equal(at(plan.slices[plan.slices.length - 1] as Slice)[1], long, "last slice ends at the far edge");
  plan.slices.forEach((s, i) => {
    if (vertical) assert.deepEqual([s.x, s.w], [0, size.w], "full width");
    else assert.deepEqual([s.y, s.h], [0, size.h], "full height");
    const [a, b] = at(s);
    assert.ok(Number.isInteger(a) && Number.isInteger(b), "integer px");
    assert.ok(b - a <= maxLen, `slice ${i} length ${b - a} ≤ ${maxLen}`);
    const next = plan.slices[i + 1];
    if (next === undefined) return;
    const [c, d] = at(next);
    assert.ok(c > a && d > b, "starts and ends strictly increase");
    assert.ok(b - c >= plan.overlap, `overlap ${b - c} ≥ floor ${plan.overlap}`);
  });
}

function quietFlags(length: number, runs: Array<[number, number]>): Uint8Array {
  const flags = new Uint8Array(length);
  for (const [a, b] of runs) flags.fill(1, a, b);
  return flags;
}

const STRIP: Size = { w: 800, h: 7680 };
const EVEN_STRIP = [0, 1760, 3520, 5280];

describe("planSlices: even plan", () => {
  test("no slicing at or below the trigger", () => {
    for (const size of [
      { w: 800, h: 2800 },
      { w: 800, h: 1200 },
      { w: 2800, h: 800 },
      { w: 1, h: 1 },
    ]) {
      const plan = planSlices(size);
      assert.equal(plan.axis, "none");
      assert.deepEqual(plan.slices, [{ x: 0, y: 0, w: size.w, h: size.h }]);
      assert.equal(plan.overlap, 0);
      assert.equal(plan.quietEdges, 0);
    }
  });

  test("defaults: H/W > 3.5, slices 3.0·W, overlap max(20%, 200 px)", () => {
    const plan = planSlices({ w: 800, h: 2801 });
    assert.equal(plan.axis, "vertical");
    assert.equal(plan.sliceLen, 2400);
    assert.equal(plan.overlap, 480);
    assert.deepEqual(plan.slices, [
      { x: 0, y: 0, w: 800, h: 2400 },
      { x: 0, y: 401, w: 800, h: 2400 },
    ]);
  });

  test("an 800×7680 strip gives 4 evenly spread slices ending at H", () => {
    const plan = planSlices(STRIP);
    assert.deepEqual(
      plan.slices.map((s) => s.y),
      EVEN_STRIP,
    );
    assert.ok(plan.slices.every((s) => s.h === 2400));
    assertPlanInvariants(plan, STRIP, 2400);
  });

  test("the overlap floor is 200 px when 20% of the slice is smaller", () => {
    const plan = planSlices({ w: 300, h: 3000 });
    assert.equal(plan.sliceLen, 900);
    assert.equal(plan.overlap, 200);
    assertPlanInvariants(plan, { w: 300, h: 3000 }, 900);
  });

  test("the overlap floor never exceeds half a slice", () => {
    const plan = planSlices({ w: 100, h: 1000 }, { ratio: 1.5 });
    assert.equal(plan.sliceLen, 150);
    assert.equal(plan.overlap, 75);
    assertPlanInvariants(plan, { w: 100, h: 1000 }, 150);
  });

  test("invariants hold across the DET-02 sweep and minimal slice counts are used", () => {
    for (const trigger of [2.0, 2.5, 3.0, 3.5]) {
      for (const ratio of [1.5, 2.0, 2.5, 3.0]) {
        for (const w of [600, 690, 720, 800, 1080]) {
          for (const h of [
            Math.floor(trigger * w) + 1,
            4 * w,
            5000,
            7680,
            9000,
            12000,
            20000,
            30000,
            60000,
          ]) {
            const size = { w, h };
            const plan = planSlices(size, { trigger, ratio });
            if (h / w <= trigger || Math.round(ratio * w) >= h) {
              assert.equal(plan.axis, "none", `${w}×${h} t${trigger} r${ratio}`);
              continue;
            }
            assert.equal(plan.sliceLen, Math.round(ratio * w));
            assertPlanInvariants(plan, size, plan.sliceLen);
            const n = plan.slices.length;
            // One slice fewer could not cover the strip with the same overlap floor.
            assert.ok((n - 1) * (plan.sliceLen - plan.overlap) + plan.overlap < h, `${w}×${h} n=${n}`);
          }
        }
      }
    }
  });

  test("trigger and ratio are overridable (DET-02 sweep)", () => {
    const plan = planSlices({ w: 800, h: 2000 }, { trigger: 2.0, ratio: 1.5 });
    assert.equal(plan.sliceLen, 1200);
    assert.equal(plan.overlap, 240);
    assert.deepEqual(
      plan.slices.map((s) => [s.y, s.h]),
      [
        [0, 1200],
        [800, 1200],
      ],
    );
    assert.equal(planSlices({ w: 800, h: 2000 }).axis, "none", "default trigger 3.5 leaves it whole");
  });

  test("a larger overlap floor adds slices", () => {
    const plan = planSlices(STRIP, { minOverlapPx: 700 });
    assert.equal(plan.overlap, 700);
    assert.equal(plan.slices.length, 5);
    assertPlanInvariants(plan, STRIP, 2400);
  });

  test("a slice as long as the image means no slicing", () => {
    assert.equal(planSlices({ w: 800, h: 2500 }, { trigger: 2.0, ratio: 3.5 }).axis, "none");
  });

  test("wide spreads are sliced horizontally", () => {
    const size = { w: 3000, h: 700 };
    const plan = planSlices(size);
    assert.equal(plan.axis, "horizontal");
    assert.deepEqual(plan.slices, [
      { x: 0, y: 0, w: 2100, h: 700 },
      { x: 900, y: 0, w: 2100, h: 700 },
    ]);
    assertPlanInvariants(plan, size, 2100);
  });

  test("bad input throws RangeError", () => {
    assert.throws(() => planSlices({ w: 0, h: 100 }), RangeError);
    assert.throws(() => planSlices({ w: 10.5, h: 100 }), RangeError);
    assert.throws(() => planSlices(STRIP, { ratio: 0 }), RangeError);
    assert.throws(() => planSlices(STRIP, { trigger: Number.NaN }), RangeError);
    assert.throws(() => planSlices(STRIP, { overlapRatio: 1 }), RangeError);
    assert.throws(() => planSlices(STRIP, { minOverlapPx: -1 }), RangeError);
  });
});

describe("planSlices: quiet rows", () => {
  // 800×7680: slice 2400, floor 480, window ±360, max length 2760, shortest run 16.
  const maxLen = Math.round(2400 * (1 + SLICER_DEFAULTS.quietMaxGrowth));

  test("defaults for the quiet search", () => {
    assert.equal(defaultQuietMinRun(800), 16);
    assert.equal(defaultQuietMinRun(300), 8);
    assert.equal(maxLen, 2760);
  });

  test("an end edge moves to the middle of a nearby gutter", () => {
    const plan = planSlices(STRIP, { rowQuiet: quietFlags(STRIP.h, [[2540, 2580]]) });
    assert.equal(plan.quietEdges, 1);
    assert.deepEqual(
      plan.slices.map((s) => [s.y, s.y + s.h]),
      [
        [0, 2560],
        [1760, 4160],
        [3520, 5920],
        [5280, 7680],
      ],
    );
    assertPlanInvariants(plan, STRIP, maxLen);
  });

  test("a start edge moves too", () => {
    const plan = planSlices(STRIP, { rowQuiet: quietFlags(STRIP.h, [[1600, 1700]]) });
    assert.equal(plan.quietEdges, 1);
    assert.equal(plan.slices[1]?.y, 1650);
    assert.equal(plan.slices[1]?.h, 4160 - 1650);
    assertPlanInvariants(plan, STRIP, maxLen);
  });

  test("runs outside every search window are ignored", () => {
    const plan = planSlices(STRIP, { rowQuiet: quietFlags(STRIP.h, [[3000, 3100]]) });
    assert.equal(plan.quietEdges, 0);
    assert.deepEqual(plan, planSlices(STRIP));
  });

  test("a run that would shrink the overlap below the floor is ignored", () => {
    // Inside the start edge's ±360 window, but past end(0) − floor = 1920.
    const plan = planSlices(STRIP, { rowQuiet: quietFlags(STRIP.h, [[1950, 2000]]) });
    assert.equal(plan.quietEdges, 0);
    assert.deepEqual(plan, planSlices(STRIP));
  });

  test("slices never grow past the allowed growth", () => {
    const rowQuiet = quietFlags(STRIP.h, [[2540, 2580]]);
    assert.equal(planSlices(STRIP, { rowQuiet, quietMaxGrowth: 0 }).quietEdges, 0);
  });

  test("short quiet gaps (between text lines) do not qualify unless allowed", () => {
    const rowQuiet = quietFlags(STRIP.h, [[2500, 2510]]);
    assert.equal(planSlices(STRIP, { rowQuiet }).quietEdges, 0);
    const relaxed = planSlices(STRIP, { rowQuiet, quietMinRun: 8 });
    assert.equal(relaxed.quietEdges, 1);
    assert.equal(relaxed.slices[0]?.h, 2505);
  });

  test("the longest run wins by default, the nearest one on request", () => {
    const rowQuiet = quietFlags(STRIP.h, [
      [2380, 2400],
      [2600, 2700],
    ]);
    assert.equal(planSlices(STRIP, { rowQuiet }).slices[0]?.h, 2650);
    assert.equal(planSlices(STRIP, { rowQuiet, quietPick: "nearest" }).slices[0]?.h, 2390);
  });

  test("invariants hold for arbitrary quiet patterns", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const size = { w: 800, h: 20000 };
    let moved = 0;
    for (let round = 0; round < 50; round++) {
      const runs: Array<[number, number]> = [];
      for (let y = 0; y < size.h;) {
        const gap = Math.floor(random() * 400);
        const len = Math.floor(random() * 120);
        runs.push([y + gap, Math.min(size.h, y + gap + len)]);
        y += gap + len + 1;
      }
      const opts: SliceOptions = { rowQuiet: quietFlags(size.h, runs) };
      if (round % 2 === 1) opts.quietPick = "nearest";
      const plan = planSlices(size, opts);
      assertPlanInvariants(plan, size, maxLen);
      assert.equal(
        plan.slices.length,
        planSlices(size).slices.length,
        "quiet rows never change the slice count",
      );
      moved += plan.quietEdges;
    }
    assert.ok(moved > 50, `edges moved onto quiet runs: ${moved}`);
  });

  test("wide spreads use column flags; row flags are ignored for them", () => {
    const size = { w: 3000, h: 700 };
    const colQuiet = quietFlags(size.w, [[1000, 1040]]);
    const plan = planSlices(size, { colQuiet });
    assert.equal(plan.quietEdges, 1);
    assert.deepEqual(plan.slices[1], { x: 1020, y: 0, w: 1980, h: 700 });
    assertPlanInvariants(plan, size, Math.round(2100 * 1.15));
    assert.equal(planSlices(size, { rowQuiet: quietFlags(size.w, [[1000, 1040]]) }).quietEdges, 0);
  });

  test("sliceSearchWindows lists the rows worth reading, merged", () => {
    assert.deepEqual(sliceSearchWindows(STRIP), [
      { start: 1384, end: 2777 },
      { start: 3144, end: 4537 },
      { start: 4904, end: 6297 },
    ]);
    assert.deepEqual(sliceSearchWindows({ w: 800, h: 1600 }), []);
  });

  test("flags limited to the search windows give the same plan for runs inside them", () => {
    const full = quietFlags(STRIP.h, [
      [1600, 1700],
      [2540, 2580],
      [5000, 5100],
    ]);
    const windowed = new Uint8Array(STRIP.h);
    for (const { start, end } of sliceSearchWindows(STRIP)) windowed.set(full.subarray(start, end), start);
    assert.deepEqual(planSlices(STRIP, { rowQuiet: windowed }), planSlices(STRIP, { rowQuiet: full }));
  });
});

describe("quiet-row helpers", () => {
  test("quietRowsFromGray applies the SmartStitch rule with 1% margins", () => {
    const w = 400;
    const rows: Array<(x: number) => number> = [
      () => 255, // flat
      (x) => 255 - Math.floor(x / 2), // gentle gradient
      (x) => (x === 200 ? 0 : 255), // a thin line
      (x) => (x < 200 ? 230 : 255), // step of exactly 25
      (x) => (x < 200 ? 229 : 255), // step of 26
      (x) => (x < 2 ? 0 : 255), // ink only inside the left margin
      (x) => (x >= 398 ? 0 : 255), // ink only inside the right margin
      (x) => (x === 10 ? 0 : 255), // ink just inside the margin
    ];
    const gray = new Uint8Array(w * rows.length);
    rows.forEach((f, y) => {
      for (let x = 0; x < w; x++) gray[y * w + x] = f(x);
    });
    assert.deepEqual([...quietRowsFromGray(gray, w, rows.length)], [1, 1, 0, 1, 0, 1, 1, 0]);
    assert.deepEqual([...quietRowsFromGray(gray, w, rows.length, 30)], [1, 1, 0, 1, 1, 1, 1, 0]);
    assert.deepEqual([...quietRowsFromGray(gray, w, rows.length, 25, 0)], [1, 1, 0, 1, 0, 0, 0, 0]);
  });

  test("quietColsFromGray is the column analogue", () => {
    const w = 5;
    const h = 200;
    const gray = new Uint8Array(w * h).fill(255);
    gray[100 * w + 1] = 0; // column 1: a dot
    for (let y = 0; y < h; y++) gray[y * w + 2] = 255 - Math.floor(y / 2); // column 2: gradient
    gray[0 * w + 3] = 0; // column 3: dot in the top margin
    for (let y = 0; y < 50; y++) gray[y * w + 4] = 229; // column 4: step of 26
    assert.deepEqual([...quietColsFromGray(gray, w, h)], [1, 0, 1, 1, 0]);
  });

  test("grayFromRgba uses (77r + 150g + 29b) >> 8 and flattens alpha onto white", () => {
    const rgba = new Uint8ClampedArray([
      255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0,
      128,
    ]);
    assert.deepEqual([...grayFromRgba(rgba, 7, 1)], [255, 0, 76, 149, 28, 255, 127]);
  });

  test("helpers reject buffers that are too small and bad sizes", () => {
    assert.throws(() => quietRowsFromGray(new Uint8Array(10), 4, 4), RangeError);
    assert.throws(() => quietColsFromGray(new Uint8Array(10), 4, 4), RangeError);
    assert.throws(() => grayFromRgba(new Uint8Array(10), 2, 2), RangeError);
    assert.throws(() => quietRowsFromGray(new Uint8Array(10), 0, 4), RangeError);
    assert.throws(() => quietColsFromGray(new Uint8Array(10), 2.5, 2), RangeError);
  });
});
