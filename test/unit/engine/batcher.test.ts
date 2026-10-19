import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBatcher, planPacks, toPackUnits, type PackPlanner } from "../../../src/engine/batcher.ts";
import type { PackUnit } from "../../../src/engine/contracts.ts";
import { MODEL_PROFILES } from "../../../src/shared/core/model-profile.ts";
import { layoutPack } from "../../../src/shared/core/packing.ts";
import type { Box, UnitGeometry } from "../../../src/shared/types.ts";

const SIZE = { w: 2000, h: 3000 };

function geometry(
  i: number,
  opts: { w?: number; h?: number; glyph?: number; edgeSmall?: true } = {},
): UnitGeometry {
  const w = opts.w ?? 200;
  const h = opts.h ?? 100;
  const x1 = 50 + (i % 3) * 650;
  const y1 = 50 + Math.floor(i / 3) * 400;
  const text: Box = { x1, y1, x2: x1 + w, y2: y1 + h };
  const g: UnitGeometry = {
    unitKey: `u${i}`,
    kind: "bubble",
    bubble: null,
    text,
    texts: [text],
    orientation: "h",
    glyphPx: opts.glyph ?? 30,
    order: i,
  };
  if (opts.edgeSmall === true) g.edgeSmall = true;
  return g;
}

function units(count: number, opts: Parameters<typeof geometry>[1] = {}, from = 0): PackUnit[] {
  return toPackUnits(
    { contentKey: "s:img", size: SIZE, src: "https://cdn.example/1.jpg", script: "hangul" },
    Array.from({ length: count }, (_, i) => geometry(from + i, opts)),
  );
}

const keys = (packs: readonly PackUnit[][]): string[][] => packs.map((pack) => pack.map((u) => u.unitKey));

describe("planPacks (P1, one image)", () => {
  test("even packs of at most boxBudget units, in reading order, every unit exactly once", () => {
    const list = units(25);
    const plan = planPacks(list, { boxBudget: 20, urgentMax: null });
    assert.deepEqual(
      plan.packs.map((p) => p.length),
      [13, 12],
    );
    assert.deepEqual(plan.packs.flat(), list);
    assert.deepEqual(plan.skipped, []);
  });

  test("a single pack when everything fits the budget", () => {
    const plan = planPacks(units(7), { boxBudget: 20, urgentMax: null });
    assert.deepEqual(
      plan.packs.map((p) => p.length),
      [7],
    );
  });

  test("an on-screen head image sends its first units in a small urgent pack (D-037)", () => {
    const plan = planPacks(units(10), { boxBudget: 20, urgentMax: 4 });
    assert.deepEqual(keys(plan.packs), [
      ["u0", "u1", "u2", "u3"],
      ["u4", "u5", "u6", "u7", "u8", "u9"],
    ]);
    const few = planPacks(units(3), { boxBudget: 20, urgentMax: 4 });
    assert.deepEqual(
      few.packs.map((p) => p.length),
      [3],
    );
  });

  test("edgeSmall units ride along in packs of normal units and never start one", () => {
    const list = [...units(5), ...units(1, { edgeSmall: true }, 5)];
    const plan = planPacks(list, { boxBudget: 20, urgentMax: null });
    assert.deepEqual(keys(plan.packs), [["u0", "u1", "u2", "u3", "u4", "u5"]]);
    assert.deepEqual(plan.skipped, []);

    const only = planPacks(units(2, { edgeSmall: true }), { boxBudget: 20, urgentMax: null });
    assert.deepEqual(only.packs, []);
    assert.deepEqual(
      only.skipped.map((u) => u.unitKey),
      ["u0", "u1"],
    );
  });

  test("edgeSmall units without room are skipped instead of costing another request", () => {
    const list = [...units(4), ...units(2, { edgeSmall: true }, 4)];
    const plan = planPacks(list, { boxBudget: 4, urgentMax: null });
    assert.deepEqual(keys(plan.packs), [["u0", "u1", "u2", "u3"]]);
    assert.deepEqual(
      plan.skipped.map((u) => u.unitKey),
      ["u4", "u5"],
    );
    // The urgent head pack is capped too.
    const urgent = planPacks([...units(3), ...units(2, { edgeSmall: true }, 3)], {
      boxBudget: 20,
      urgentMax: 4,
    });
    assert.deepEqual(keys(urgent.packs), [["u0", "u1", "u2", "u3"]]);
    assert.deepEqual(
      urgent.skipped.map((u) => u.unitKey),
      ["u4"],
    );
  });

  test("with a layout policy every pack lays out on the model's canvas (core/packing shrinks it)", () => {
    const big = units(20, { w: 600, h: 300, glyph: 20 });
    const profile = MODEL_PROFILES.gpt5;
    assert.equal(layoutPack(big, profile, "ltr", "full").ok, false);
    const plan = planPacks(big, { boxBudget: 20, urgentMax: null, layout: { profile, dir: "ltr" } });
    assert.ok(plan.packs.length > 1);
    for (const pack of plan.packs) assert.equal(layoutPack(pack, profile, "ltr", "full").ok, true);
    assert.deepEqual(plan.packs.flat(), big);
    // Budget only: one pack that would not lay out.
    assert.equal(planPacks(big, { boxBudget: 20, urgentMax: null }).packs.length, 1);
  });

  test("an edgeSmall unit only joins a pack that still lays out", () => {
    const profile = MODEL_PROFILES.gpt5;
    const layout = { profile, dir: "ltr" as const };
    const list = [
      ...units(4, { w: 600, h: 300, glyph: 20 }),
      ...units(1, { w: 600, h: 300, glyph: 20, edgeSmall: true }, 4),
    ];
    const plan = planPacks(list, { boxBudget: 20, urgentMax: null, layout });
    for (const pack of plan.packs) assert.equal(layoutPack(pack, profile, "ltr", "full").ok, true);
    assert.equal(plan.packs.flat().length + plan.skipped.length, 5);
  });
});

describe("batcher seam and PackUnits", () => {
  test("createBatcher uses an injected planner (P2 cross-image packing plugs in here)", () => {
    const seen: number[] = [];
    const planner: PackPlanner = (list, policy) => {
      seen.push(list.length, policy.boxBudget);
      return { packs: [[...list]], skipped: [] };
    };
    const plan = createBatcher(planner).plan(units(3), { boxBudget: 9, urgentMax: null });
    assert.deepEqual(seen, [3, 9]);
    assert.equal(plan.packs.length, 1);
    assert.deepEqual(
      createBatcher()
        .plan(units(3), { boxBudget: 2, urgentMax: null })
        .packs.map((p) => p.length),
      [2, 1],
    );
  });

  test("toPackUnits sorts by reading order and fills every PackUnit field", () => {
    const shuffled = [geometry(2), geometry(0), geometry(1)];
    const list = toPackUnits(
      { contentKey: "s:k", size: { w: 800, h: 2560 }, src: "https://x/y.png", script: "cjk" },
      shuffled,
    );
    assert.deepEqual(
      list.map((u) => u.unitKey),
      ["u0", "u1", "u2"],
    );
    assert.deepEqual(list[0], {
      contentKey: "s:k",
      unitKey: "u0",
      geometry: geometry(0),
      imageSize: { w: 800, h: 2560 },
      script: "cjk",
      src: "https://x/y.png",
    });
  });
});
