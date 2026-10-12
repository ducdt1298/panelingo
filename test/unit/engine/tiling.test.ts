import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DetectOptions } from "../../../src/engine/contracts.ts";
import {
  defaultTilePixels,
  detectSlices,
  gfxTilePixels,
  planImageSlices,
  quietFlags,
  runTiling,
} from "../../../src/engine/tiling.ts";
import type { TilePixels, TileRunner } from "../../../src/engine/tiling.ts";
import type { DetectorOutput } from "../../../src/shared/core/detections.ts";
import { planSlices } from "../../../src/shared/core/slicer.ts";
import type { Slice } from "../../../src/shared/core/slicer.ts";
import { buildUnitGeometry } from "../../../src/shared/core/units-build.ts";
import type { ImageDataLike } from "../../../src/shared/gfx.ts";
import { unitKeyOf } from "../../../src/shared/ids.ts";
import type { Box, DetClass, Detection, Size } from "../../../src/shared/types.ts";
import { nodeGfx } from "../../../tools/gfx-node.ts";

const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });
const det = (cls: DetClass, box: Box, score = 0.9): Detection => ({ cls, box, score });
const LABEL: Record<DetClass, number> = { bubble: 0, text_bubble: 1, text_free: 2 };

const OPTIONS: DetectOptions = {
  scoreMin: 0.3,
  slice: { triggerRatio: 3.5, heightRatio: 3, overlap: 0.2, overlapMinPx: 200, quietRows: false },
  dir: "ltr",
};

function image(w: number, h: number): ImageDataLike {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
}

/** Pixels that are never looked at, except for their size; records what was asked. */
class FakePixels implements TilePixels {
  readonly stretches: Array<{ rect: Slice; side: number; mode: string }> = [];
  readonly regions: Slice[] = [];
  fill: [number, number, number, number] = [255, 255, 255, 255];

  stretch(
    _source: object,
    rect: Slice,
    side: number,
    mode: "bitmap-high" | "draw-low",
  ): Promise<ImageDataLike> {
    this.stretches.push({ rect, side, mode });
    const data = new Uint8ClampedArray(side * side * 4);
    for (let i = 0; i < data.length; i += 4) data.set(this.fill, i);
    return Promise.resolve({ width: side, height: side, data });
  }

  region(_source: object, rect: Slice): Promise<ImageDataLike> {
    this.regions.push(rect);
    return Promise.resolve(image(rect.w, rect.h));
  }

  decode(): Promise<{ source: object; size: Size; close(): void }> {
    return Promise.reject(new Error("not used"));
  }
}

/** Model output for one slice: the part of every truth box the slice sees, in slice px (as the graph returns). */
function outputFor(truth: readonly Detection[], slice: Slice): DetectorOutput {
  const labels = new BigInt64Array(300);
  const boxes = new Float32Array(1200);
  const scores = new Float32Array(300);
  let n = 0;
  for (const d of [...truth].sort((p, q) => q.score - p.score)) {
    const x1 = Math.max(d.box.x1, slice.x) - slice.x;
    const y1 = Math.max(d.box.y1, slice.y) - slice.y;
    const x2 = Math.min(d.box.x2, slice.x + slice.w) - slice.x;
    const y2 = Math.min(d.box.y2, slice.y + slice.h) - slice.y;
    if (x2 - x1 <= 5 || y2 - y1 <= 5) continue;
    labels[n] = BigInt(LABEL[d.cls]);
    scores[n] = d.score;
    boxes.set([x1, y1, x2, y2], 4 * n);
    n++;
  }
  return { labels, boxes, scores };
}

/** A runner that answers slice k (in call order) from `truth`, recording targets and a few input values. */
function scriptedRun(truth: readonly Detection[], slices: readonly Slice[]) {
  const calls: Array<{ target: Size; head: number[] }> = [];
  const run: TileRunner = (input, target) => {
    const plane = 640 * 640;
    calls.push({ target, head: [input[0] ?? -1, input[plane] ?? -1, input[2 * plane] ?? -1] });
    const slice = slices[calls.length - 1];
    if (slice === undefined) return Promise.reject(new Error("unexpected run"));
    assert.deepEqual(target, { w: slice.w, h: slice.h }, "orig_target_sizes = the slice's own size");
    return Promise.resolve(outputFor(truth, slice));
  };
  return { run, calls };
}

let clock = 0;
const now = (): number => (clock += 5);

describe("runTiling on a tall strip", () => {
  const strip = { w: 800, h: 7680 };
  const slices = planSlices(strip).slices; // [0,2400) [1760,4160) [3520,5920) [5280,7680)
  const truth = [
    det("bubble", b(100, 1500, 500, 2700), 0.9), // crosses both edges of the overlap [1760, 2400)
    det("text_bubble", b(150, 1900, 450, 2300), 0.85), // whole inside that overlap: seen twice
    det("bubble", b(200, 5000, 600, 5400), 0.8), // crosses the edge at 5280
    det("text_bubble", b(250, 5100, 550, 5300), 0.75),
    det("text_free", b(300, 7000, 500, 7040), 0.2), // raw only
  ];

  test("one run per slice with orig_target_sizes [w, h]; raw boxes offset to image px", async () => {
    const pixels = new FakePixels();
    const { run, calls } = scriptedRun(truth, slices);
    const result = await runTiling({ source: {}, size: strip }, OPTIONS, { pixels, run, now });
    assert.equal(calls.length, 4);
    assert.deepEqual(
      pixels.stretches.map((s) => [s.rect, s.side, s.mode]),
      slices.map((s) => [s, 640, "bitmap-high"]),
    );
    assert.deepEqual(result.plan.slices, slices);
    assert.equal(result.inferMs.length, 4);
    assert.ok(result.inferMs.every((ms) => ms === 5));
    // Slice 1 sees the first bubble cut at its top edge (1760) and at its own text box; in image px.
    assert.ok(result.rawDetections.some((d) => d.cls === "bubble" && d.box.y1 === 1760 && d.box.y2 === 2700));
    assert.ok(result.rawDetections.some((d) => d.cls === "bubble" && d.box.y1 === 1500 && d.box.y2 === 2400));
    assert.ok(result.rawDetections.every((d) => d.score >= 0.15));
    assert.ok(
      result.rawDetections.some((d) => d.score < 0.3),
      "raw keeps scores from 0.15 (D-012)",
    );
  });

  test("units: one per bubble across slice edges, no duplicates, reading order, keys", async () => {
    const { run } = scriptedRun(truth, slices);
    const result = await runTiling({ source: {}, size: strip }, OPTIONS, {
      pixels: new FakePixels(),
      run,
      now,
    });
    assert.deepEqual(
      result.units.map((u) => [u.bubble, u.texts, u.order, u.unitKey]),
      [
        [b(100, 1500, 500, 2700), [b(150, 1900, 450, 2300)], 0, unitKeyOf(b(100, 1500, 500, 2700))],
        [b(200, 5000, 600, 5400), [b(250, 5100, 550, 5300)], 1, unitKeyOf(b(200, 5000, 600, 5400))],
      ],
    );
  });

  test("the units are exactly what units-build gives for the raw detections (unitsFrom reproduces them)", async () => {
    const { run } = scriptedRun(truth, slices);
    const result = await runTiling({ source: {}, size: strip }, OPTIONS, {
      pixels: new FakePixels(),
      run,
      now,
    });
    const stored = structuredClone(result.rawDetections);
    assert.deepEqual(buildUnitGeometry(stored, slices, strip, { scoreMin: 0.3, dir: "ltr" }), result.units);
    const lower = buildUnitGeometry(stored, slices, strip, { scoreMin: 0.15, dir: "ltr" });
    assert.equal(lower.length, 3, "a lower scoreMin brings the faint free text back without a model run");
  });

  test("the planar input comes from the stretched pixels", async () => {
    const pixels = new FakePixels();
    pixels.fill = [255, 0, 51, 255];
    const { run, calls } = scriptedRun([], slices);
    const buffer = new Float32Array(3 * 640 * 640);
    await detectSlices({ source: {}, size: strip }, slices, { pixels, run, now, input: buffer });
    assert.deepEqual(calls[0]?.head, [1, 0, Math.fround(0.2)]);
    assert.equal(buffer[0], 1, "the given buffer is reused");
  });

  test("pixels of the wrong size are rejected", async () => {
    const pixels = new FakePixels();
    pixels.stretch = () => Promise.resolve(image(320, 320));
    const { run } = scriptedRun([], slices);
    await assert.rejects(runTiling({ source: {}, size: strip }, OPTIONS, { pixels, run, now }), RangeError);
  });

  test("a failed run stops the image", async () => {
    let runs = 0;
    const run: TileRunner = () => {
      runs++;
      return runs === 2
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(outputFor([], slices[0] as Slice));
    };
    await assert.rejects(
      runTiling({ source: {}, size: strip }, OPTIONS, { pixels: new FakePixels(), run, now }),
      /boom/,
    );
    assert.equal(runs, 2);
  });
});

describe("runTiling on pages and spreads", () => {
  test("a page below the trigger is one slice covering it", async () => {
    const page = { w: 800, h: 1200 };
    const pixels = new FakePixels();
    const truth = [det("bubble", b(100, 100, 400, 300)), det("text_bubble", b(150, 150, 350, 250))];
    const slices = [{ x: 0, y: 0, w: 800, h: 1200 }];
    const { run, calls } = scriptedRun(truth, slices);
    const result = await runTiling({ source: {}, size: page }, OPTIONS, { pixels, run, now });
    assert.deepEqual(
      calls.map((c) => c.target),
      [page],
    );
    assert.deepEqual(result.plan.axis, "none");
    assert.deepEqual(
      result.units.map((u) => u.bubble),
      [b(100, 100, 400, 300)],
    );
  });

  test("a wide spread is sliced along x and merged back", async () => {
    const wide = { w: 4000, h: 800 };
    const slices = planSlices(wide).slices; // [0,2400) [1600,4000)
    const truth = [det("bubble", b(1400, 100, 2700, 500)), det("text_bubble", b(1500, 200, 2600, 400))];
    const { run, calls } = scriptedRun(truth, slices);
    const result = await runTiling({ source: {}, size: wide }, OPTIONS, {
      pixels: new FakePixels(),
      run,
      now,
    });
    assert.deepEqual(
      calls.map((c) => c.target),
      [
        { w: 2400, h: 800 },
        { w: 2400, h: 800 },
      ],
    );
    assert.deepEqual(
      result.units.map((u) => u.bubble),
      [b(1400, 100, 2700, 500)],
    );
  });
});

describe("quiet rows", () => {
  const strip = { w: 800, h: 7680 };

  test("off (v1 default): no pixels are read for the plan", async () => {
    const pixels = new FakePixels();
    const plan = await planImageSlices({ source: {}, size: strip }, OPTIONS.slice, pixels);
    assert.equal(pixels.regions.length, 0);
    assert.deepEqual(plan, planSlices(strip));
  });

  test("on: only the slicer's search windows are read, and edges move onto quiet runs", async () => {
    const pixels = new FakePixels();
    const params = { ...OPTIONS.slice, quietRows: true };
    const plan = await planImageSlices({ source: {}, size: strip }, params, pixels);
    assert.deepEqual(
      pixels.regions.map((r) => [r.x, r.y, r.w, r.y + r.h]),
      [
        [0, 1384, 800, 2777],
        [0, 3144, 800, 4537],
        [0, 4904, 800, 6297],
      ],
    );
    assert.ok(plan.quietEdges > 0, "a blank page is quiet everywhere");
    const flags = await quietFlags({ source: {}, size: strip }, params, new FakePixels());
    assert.ok("rowQuiet" in flags);
    assert.equal(flags.rowQuiet[0], 0, "rows outside the windows stay 0");
    assert.equal(flags.rowQuiet[2000], 1);
  });

  test("wide images use quiet columns", async () => {
    const flags = await quietFlags(
      { source: {}, size: { w: 4000, h: 800 } },
      OPTIONS.slice,
      new FakePixels(),
    );
    assert.ok("colQuiet" in flags);
    assert.equal(flags.colQuiet.length, 4000);
  });
});

describe("gfxTilePixels (Node canvas)", () => {
  /** 100×300 image: top half red, bottom half blue. */
  async function twoTone(): Promise<{ source: object; size: Size }> {
    const canvas = nodeGfx.createCanvas(100, 300);
    const ctx = canvas.getContext("2d");
    assert.ok(ctx !== null);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 100, 150);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(0, 150, 100, 150);
    const decoded = await gfxTilePixels(nodeGfx).decode(
      (await nodeGfx.encodePng(canvas)) as Uint8Array<ArrayBuffer>,
    );
    assert.deepEqual(decoded.size, { w: 100, h: 300 });
    decoded.close();
    return decoded;
  }

  const pixelAt = (data: ImageDataLike, x: number, y: number): number[] => {
    const p = 4 * (y * data.width + x);
    return [...data.data.slice(p, p + 4)];
  };

  test("stretch maps a slice onto the whole square (no letterbox)", async () => {
    const { source } = await twoTone();
    const pixels = gfxTilePixels(nodeGfx);
    const bottom = await pixels.stretch(source, { x: 0, y: 150, w: 100, h: 150 }, 64, "bitmap-high");
    assert.deepEqual([bottom.width, bottom.height], [64, 64]);
    assert.deepEqual(pixelAt(bottom, 0, 0), [0, 0, 255, 255]);
    assert.deepEqual(pixelAt(bottom, 63, 63), [0, 0, 255, 255]);
    const whole = await pixels.stretch(source, { x: 0, y: 0, w: 100, h: 300 }, 64, "draw-low");
    assert.deepEqual(pixelAt(whole, 10, 5), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(whole, 10, 58), [0, 0, 255, 255]);
  });

  test("region copies pixels 1:1", async () => {
    const { source } = await twoTone();
    const data = await gfxTilePixels(nodeGfx).region(source, { x: 0, y: 140, w: 100, h: 20 });
    assert.deepEqual([data.width, data.height], [100, 20]);
    assert.deepEqual(pixelAt(data, 50, 9), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(data, 50, 10), [0, 0, 255, 255]);
  });

  test("without OffscreenCanvas (Node) the default pixels use the Gfx", async () => {
    assert.equal(typeof globalThis.OffscreenCanvas, "undefined");
    const { source } = await twoTone();
    const data = await defaultTilePixels(nodeGfx).stretch(
      source,
      { x: 0, y: 0, w: 100, h: 150 },
      32,
      "bitmap-high",
    );
    assert.deepEqual(pixelAt(data, 16, 16), [255, 0, 0, 255]);
  });
});
