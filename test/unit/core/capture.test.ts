// Screen-capture geometry (bands and 2-D tiles, scroll deltas, crops and clips, stitch placement, output size) and
// the capture throttle.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTURE,
  bandPlacement,
  bandScrollDelta,
  captureOutput,
  createCaptureThrottle,
  fitsViewport,
  insideRect,
  intersectRects,
  intersectsViewport,
  planBands,
  planTiles,
  revealDelta,
  revealRectDelta,
  shotScale,
  tileDelta,
  tilePlacement,
  tileRect,
  viewRect,
  visiblePart,
} from "../../../src/shared/core/capture.ts";
import type { Clock } from "../../../src/shared/clock.ts";

const VIEW = { w: 1280, h: 900 };

test("viewport predicates: intersects, inside a window, fits, visible part, intersection", () => {
  const rect = { left: 40, top: -100, width: 1200, height: 1800 };
  assert.equal(intersectsViewport(rect, VIEW), true);
  assert.equal(intersectsViewport({ ...rect, top: 900 }, VIEW), false, "starts at the bottom edge");
  assert.equal(intersectsViewport({ ...rect, top: -1800 }, VIEW), false, "ends at the top edge");
  assert.equal(intersectsViewport({ ...rect, width: 0 }, VIEW), false);
  const band = { left: 40, top: 100, width: 1200, height: 600 };
  assert.equal(insideRect(band, viewRect(VIEW)), true);
  assert.equal(insideRect({ ...band, left: 81.5 }, viewRect(VIEW)), false, "1 px of tolerance only");
  assert.equal(insideRect({ ...band, left: 80.5 }, viewRect(VIEW)), true);
  assert.equal(insideRect(band, { left: 100, top: 50, width: 400, height: 400 }), false);
  assert.deepEqual(
    intersectRects(
      { left: 0, top: 0, width: 100, height: 100 },
      { left: 50, top: 80, width: 100, height: 100 },
    ),
    {
      left: 50,
      top: 80,
      width: 50,
      height: 20,
    },
  );
  assert.equal(
    intersectRects({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 5, height: 5 }),
    null,
  );
  assert.equal(fitsViewport(rect, VIEW), false);
  assert.equal(fitsViewport({ left: 0, top: 0.5, width: 1280, height: 900 }, VIEW), true);
  assert.deepEqual(visiblePart(rect, VIEW), { left: 40, top: 0, width: 1200, height: 900 });
  assert.equal(visiblePart({ ...rect, top: 950 }, VIEW), null);
});

test("planBands: one band when it fits, else 70% bands overlapping by 20% with the last one at the bottom", () => {
  assert.deepEqual(planBands(800, 900), [{ top: 0, height: 800 }]);
  assert.deepEqual(planBands(0, 900), []);
  assert.deepEqual(planBands(500, 0), []);
  const bands = planBands(1800, 900);
  assert.deepEqual(bands, [
    { top: 0, height: 630 },
    { top: 504, height: 630 },
    { top: 1008, height: 630 },
    { top: 1170, height: 630 },
  ]);
  for (const tall of [899, 1000, 2000, 5432, 20_000]) {
    const plan = planBands(tall, 900);
    assert.equal(plan[0]?.top, 0);
    const last = plan.at(-1);
    assert.equal((last?.top ?? 0) + (last?.height ?? 0), tall, `${tall}: the last band reaches the bottom`);
    for (let i = 1; i < plan.length; i += 1) {
      const prev = plan[i - 1];
      const band = plan[i];
      if (prev === undefined || band === undefined) continue;
      const overlap = prev.top + prev.height - band.top;
      assert.ok(overlap >= Math.floor(band.height * CAPTURE.overlap) - 1, `${tall}: overlap ${overlap}`);
      assert.ok(band.top > prev.top, "bands move down");
    }
  }
  assert.equal(planBands(20_000, 900).length > CAPTURE.maxTiles, true, "a very tall image exceeds maxTiles");
});

test("scroll deltas: reveal a fitting image minimally; put a band at the capture window", () => {
  assert.equal(revealDelta(100, 500, 900), 0, "already in view");
  assert.equal(revealDelta(-120, 500, 900), -120, "scroll up by what is cut at the top");
  assert.equal(revealDelta(600, 500, 900), 200, "scroll down by what is cut at the bottom");
  assert.equal(revealDelta(300, 1200, 900), 300, "taller than the viewport: never past its top");
  assert.equal(bandScrollDelta(40, { top: 0, height: 630 }, 900), 40 - 135);
  assert.equal(bandScrollDelta(-400, { top: 504, height: 630 }, 900), -400 + 504 - 135);
});

test("planTiles: one tile when it fits, rows for a tall image, columns for a wide one, a grid for both", () => {
  assert.deepEqual(planTiles({ w: 600, h: 400 }, { w: 1280, h: 900 }), [
    { top: 0, height: 400, left: 0, width: 600 },
  ]);
  const wide = planTiles({ w: 1200, h: 800 }, { w: 800, h: 900 });
  assert.deepEqual(
    wide,
    [0, 448, 640].map((left) => ({ top: 0, height: 800, left, width: 560 })),
    "columns of 70% of the window, the last aligned with the right edge",
  );
  const grid = planTiles({ w: 1200, h: 1800 }, { w: 800, h: 900 });
  assert.equal(grid.length, 4 * 3);
  assert.deepEqual(grid.slice(0, 4), [
    { top: 0, height: 630, left: 0, width: 560 },
    { top: 0, height: 630, left: 448, width: 560 },
    { top: 0, height: 630, left: 640, width: 560 },
    { top: 504, height: 630, left: 0, width: 560 },
  ]);
  // Every image pixel is covered.
  for (const [image, window] of [
    [
      { w: 1200, h: 1800 },
      { w: 800, h: 900 },
    ],
    [
      { w: 3000, h: 700 },
      { w: 1000, h: 800 },
    ],
    [
      { w: 777, h: 4321 },
      { w: 500, h: 333 },
    ],
  ] as const) {
    const tiles = planTiles(image, window);
    for (const [x, y] of [
      [0, 0],
      [image.w - 1, image.h - 1],
      [Math.floor(image.w / 2), Math.floor(image.h / 3)],
      [image.w - 1, 0],
    ] as const) {
      assert.ok(
        tiles.some((t) => x >= t.left && x < t.left + t.width && y >= t.top && y < t.top + t.height),
        `${JSON.stringify(image)}: (${x}, ${y}) covered`,
      );
    }
  }
  assert.deepEqual(planTiles({ w: 0, h: 100 }, { w: 800, h: 900 }), []);
});

test("tile scroll deltas: a strict part goes to the window start on its axis, a fitting side is revealed minimally", () => {
  const window = { left: 0, top: 0, width: 800, height: 900 };
  const wide = { left: 100, top: 50, width: 1200, height: 800 };
  const tile = { top: 0, height: 800, left: 448, width: 560 };
  assert.deepEqual(tilePlacement(wide, tile), { x: true, y: false });
  assert.deepEqual(tilePlacement(wide, undefined), { x: false, y: false });
  assert.deepEqual(tileRect(wide, tile), { left: 548, top: 50, width: 560, height: 800 });
  assert.deepEqual(tileDelta(wide, window, tile), { dx: 548 - 120, dy: 0 });
  assert.deepEqual(tileDelta({ ...wide, top: 300 }, window, tile), { dx: 548 - 120, dy: 200 });
  assert.deepEqual(
    tileDelta(wide, window),
    { dx: 0, dy: 0 },
    "wider than the window: left alone until tiled",
  );
  const fits = { left: -50, top: 600, width: 500, height: 400 };
  assert.deepEqual(tileDelta(fits, window), { dx: -50, dy: 100 });
  // A window that is a clip somewhere in the viewport (a reader iframe).
  const clip = { left: 200, top: 100, width: 400, height: 300 };
  assert.deepEqual(
    revealRectDelta({ left: 250, top: 380, width: 100, height: 100 }, clip, { x: false, y: false }),
    {
      dx: 0,
      dy: 80,
    },
  );
  assert.deepEqual(
    revealRectDelta({ left: 250, top: 380, width: 100, height: 100 }, clip, { x: true, y: true }),
    {
      dx: 250 - (200 + 60),
      dy: 380 - (100 + 45),
    },
  );
});

test("captureOutput: device scale, capped by the canvas side limit and the pixel budget", () => {
  assert.deepEqual(captureOutput({ w: 1200, h: 1800 }, 1, 64_000_000), { scale: 1, w: 1200, h: 1800 });
  assert.deepEqual(captureOutput({ w: 600, h: 900 }, 2, 64_000_000), { scale: 2, w: 1200, h: 1800 });
  const tall = captureOutput({ w: 800, h: 20_000 }, 2, 64_000_000);
  assert.ok(tall.h <= CAPTURE.maxSide && tall.scale < 2, JSON.stringify(tall));
  const budget = captureOutput({ w: 2000, h: 2000 }, 2, 1_000_000);
  assert.ok(budget.w * budget.h <= 1_000_000 * 1.01, JSON.stringify(budget));
  assert.equal(captureOutput({ w: 100, h: 100 }, Number.NaN, 1e6).scale, 1, "a broken scale falls back to 1");
  assert.deepEqual(shotScale({ w: 2560, h: 1800 }, VIEW), { x: 2, y: 2 });
});

test("bandPlacement: device-pixel source and output-pixel destination, clipped to the viewport", () => {
  const rect = { left: 40, top: 53, width: 1200, height: 800 };
  const whole = bandPlacement({ rect, viewport: VIEW, shot: { w: 1280, h: 900 }, outScale: 1 });
  assert.deepEqual(whole, {
    src: { x: 40, y: 53, w: 1200, h: 800 },
    dst: { x: 0, y: 0, w: 1200, h: 800 },
  });
  const hiDpi = bandPlacement({ rect, viewport: VIEW, shot: { w: 2560, h: 1800 }, outScale: 2 });
  assert.deepEqual(hiDpi, {
    src: { x: 80, y: 106, w: 2400, h: 1600 },
    dst: { x: 0, y: 0, w: 2400, h: 1600 },
  });
  // A tall image scrolled so that band 2 (rows 504…1134) sits at the capture window (y = 135).
  const tall = { left: 40, top: 135 - 504, width: 1200, height: 1800 };
  const band = bandPlacement({
    rect: tall,
    viewport: VIEW,
    shot: { w: 1280, h: 900 },
    outScale: 1,
    tile: { top: 504, height: 630, left: 0, width: 1200 },
  });
  assert.deepEqual(band, {
    src: { x: 40, y: 135, w: 1200, h: 630 },
    dst: { x: 0, y: 504, w: 1200, h: 630 },
  });
  // The last band runs past the viewport bottom: only what is seen is used.
  const cut = bandPlacement({
    rect: { ...tall, top: 500 - 1170 },
    viewport: VIEW,
    shot: { w: 1280, h: 900 },
    outScale: 1,
    tile: { top: 1170, height: 630, left: 0, width: 1200 },
  });
  assert.deepEqual(cut?.dst, { x: 0, y: 1170, w: 1200, h: 400 });
  // A column of a wide image (columns 448…1008 of the image scrolled to x = 120).
  const column = bandPlacement({
    rect: { left: 120 - 448, top: 50, width: 1200, height: 800 },
    viewport: { w: 800, h: 900 },
    shot: { w: 800, h: 900 },
    outScale: 1,
    tile: { top: 0, height: 800, left: 448, width: 560 },
  });
  assert.deepEqual(column, { src: { x: 120, y: 50, w: 560, h: 800 }, dst: { x: 448, y: 0, w: 560, h: 800 } });
  // In a reader iframe only what shows through its clip is used.
  const clipped = bandPlacement({
    rect: { left: 100, top: 100, width: 600, height: 600 },
    viewport: VIEW,
    shot: { w: 1280, h: 900 },
    outScale: 1,
    clip: { left: 150, top: 200, width: 1000, height: 300 },
  });
  assert.deepEqual(clipped, {
    src: { x: 150, y: 200, w: 550, h: 300 },
    dst: { x: 50, y: 100, w: 550, h: 300 },
  });
  assert.equal(
    bandPlacement({
      rect: { ...rect, top: 950 },
      viewport: VIEW,
      shot: { w: 1280, h: 900 },
      outScale: 1,
    }),
    null,
  );
});

class ManualClock implements Clock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      this.t = due.at;
      due.fn();
    }
    this.t = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test("throttle: FIFO per key, starts ≥ minGap apart, also for captures that come one after another", async () => {
  const clock = new ManualClock();
  const throttle = createCaptureThrottle(clock, 600);
  const starts: Array<[string, number]> = [];
  const job = (label: string) => (): Promise<string> => {
    starts.push([label, clock.now()]);
    return Promise.resolve(label);
  };
  const results = Promise.all([
    throttle.run(1, job("a")),
    throttle.run(1, job("b")),
    throttle.run(2, job("x")),
  ]);
  await clock.advance(0);
  assert.equal(throttle.pending(1), 1, "b waits for the gap");
  await clock.advance(600);
  assert.deepEqual(await results, ["a", "b", "x"]);
  assert.deepEqual(starts, [
    ["a", 0],
    ["x", 0],
    ["b", 600],
  ]);
  // The lane keeps its last start: a capture asked for later (queue empty meanwhile) still waits for the gap.
  await clock.advance(100);
  const later = throttle.run(1, job("c"));
  await clock.advance(0);
  assert.equal(starts.length, 3, "700 ms after a, 100 ms after b: c must wait");
  await clock.advance(500);
  assert.equal(await later, "c");
  assert.deepEqual(starts.at(-1), ["c", 1200]);
  assert.equal(throttle.pending(1), 0);
});

test("throttle: a failing job rejects its caller only and the next one still runs", async () => {
  const clock = new ManualClock();
  const throttle = createCaptureThrottle(clock, 600);
  const failing = throttle.run("w", () => Promise.reject(new Error("quota")));
  const thrown = throttle.run("w", () => {
    throw new Error("sync");
  });
  const next = throttle.run("w", () => Promise.resolve(7));
  await assert.rejects(failing, /quota/);
  await clock.advance(600);
  await assert.rejects(thrown, /sync/);
  await clock.advance(600);
  assert.equal(await next, 7);
});
