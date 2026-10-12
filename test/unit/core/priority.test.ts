// Look-ahead horizons (engine side), the latency estimate, the translate window and the detect horizon cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABOVE_RANK,
  LOOKAHEAD,
  computeHorizons,
  createLatencyEstimator,
  defaultHorizon,
  horizonCut,
  horizonFrom,
  imagePriority,
  inTranslateWindow,
} from "../../../src/shared/core/priority.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";

const D = DEFAULT_SETTINGS.discovery;

test("computeHorizons: defaults (4 s per screen, 12 s latency) give 6 translate and 15 detect screens", () => {
  assert.deepEqual(
    computeHorizons({
      secondsPerScreen: 4,
      latencyMs: LOOKAHEAD.defaultLatencyMs,
      strip: false,
      settings: D,
    }),
    { translateScreens: 6, detectScreens: 15, detectMaxImages: 25 },
  );
});

test("computeHorizons: fast readers look further, slow ones less, always within the settings' bounds", () => {
  const at = (secondsPerScreen: number, latencyMs: number, strip = false) =>
    computeHorizons({ secondsPerScreen, latencyMs, strip, settings: D });
  assert.equal(at(1, 12_000).translateScreens, D.lookaheadMaxScreens, "capped at lookaheadMaxScreens");
  assert.equal(at(1, 12_000, true).translateScreens, D.lookaheadMaxScreensStrip, "strips may look further");
  assert.equal(at(30, 1_000).translateScreens, D.lookaheadMinScreens, "never below lookaheadMinScreens");
  assert.equal(at(1, 12_000).detectScreens, D.detectAheadMaxScreens);
  assert.equal(at(30, 1_000).detectScreens, D.detectAheadMinScreens);
  const custom = { ...D, lookaheadMinScreens: 3, lookaheadMaxScreens: 30, detectAheadMinScreens: 2 };
  const h = computeHorizons({ secondsPerScreen: 1, latencyMs: 12_000, strip: false, settings: custom });
  assert.ok(h.detectScreens >= h.translateScreens, "detection always covers the translate window");
  const broken = computeHorizons({ secondsPerScreen: Number.NaN, latencyMs: -5, strip: false, settings: D });
  assert.deepEqual(broken, at(4, LOOKAHEAD.defaultLatencyMs), "unusable inputs fall back to the defaults");
  const pinned = { ...D, lookaheadMinScreens: 8, lookaheadMaxScreens: 8, lookaheadMaxScreensStrip: 8 };
  for (const speed of [0.5, 4, 60]) {
    assert.equal(
      computeHorizons({ secondsPerScreen: speed, latencyMs: 90_000, strip: true, settings: pinned })
        .translateScreens,
      8,
    );
  }
});

test("latency estimator: EMA of finished requests, ignores unusable samples", () => {
  const latency = createLatencyEstimator(10_000);
  latency.observe(0);
  latency.observe(Number.NaN);
  assert.equal(latency.ms, 10_000);
  latency.observe(2_000);
  assert.equal(latency.ms, 10_000 + LOOKAHEAD.latencyAlpha * (2_000 - 10_000));
  for (let i = 0; i < 50; i += 1) latency.observe(2_000);
  assert.ok(Math.abs(latency.ms - 2_000) < 1);
  assert.equal(createLatencyEstimator().ms, LOOKAHEAD.defaultLatencyMs);
});

test("inTranslateWindow: on screen and up to translateScreens below, never above the viewport", () => {
  assert.equal(inTranslateWindow(0.2, 2), true);
  assert.equal(inTranslateWindow(3, 2), true);
  assert.equal(inTranslateWindow(3.01, 2), false);
  assert.equal(inTranslateWindow(ABOVE_RANK + 0.5, 50), false);
  assert.equal(inTranslateWindow(1.5, -3), false, "a negative window is an empty one");
});

test("horizonFrom / defaultHorizon: clamp en:horizons, fall back on non-finite values", () => {
  assert.deepEqual(defaultHorizon(D), { screens: D.detectAheadMinScreens, maxImages: D.detectMaxImages });
  assert.deepEqual(horizonFrom({ detectScreens: 15, detectMaxImages: 25 }, D), {
    screens: 15,
    maxImages: 25,
  });
  assert.deepEqual(horizonFrom({ detectScreens: 999, detectMaxImages: 999 }, D), {
    screens: D.detectAheadMaxScreens,
    maxImages: 100,
  });
  assert.deepEqual(
    horizonFrom({ detectScreens: Number.NaN, detectMaxImages: Infinity }, D),
    defaultHorizon(D),
  );
});

test("horizonCut: candidates within the screens below and among the first maxImages places ahead", () => {
  const view = { top: 0, height: 1000 };
  const at = (top: number): number => imagePriority({ top, bottom: top + 900 }, view);
  const items = [
    { key: "above", priority: at(-2000), candidate: true },
    { key: "on", priority: at(100), candidate: false },
    { key: "c1", priority: at(1500), candidate: true },
    { key: "tracked", priority: at(2500), candidate: false },
    { key: "c2", priority: at(3500), candidate: true },
    { key: "far", priority: at(20_000), candidate: true },
  ];
  assert.deepEqual(horizonCut(items, { screens: 5, maxImages: 10 }), ["c1", "c2"]);
  assert.deepEqual(horizonCut(items, { screens: 50, maxImages: 10 }), ["c1", "c2", "far"]);
  assert.deepEqual(
    horizonCut(items, { screens: 50, maxImages: 3 }),
    ["c1"],
    "on, c1, tracked take the places",
  );
  assert.deepEqual(horizonCut(items, { screens: 0, maxImages: 10 }), [], "nothing below the viewport");
});
