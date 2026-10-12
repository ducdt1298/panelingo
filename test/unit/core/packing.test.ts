import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { layoutComposite } from "../../../src/shared/core/composite-layout.ts";
import { MODEL_PROFILES } from "../../../src/shared/core/model-profile.ts";
import {
  compositeInputs,
  isStripImage,
  layoutPack,
  packUnits,
  resolveBoxBudget,
  type PackingUnit,
} from "../../../src/shared/core/packing.ts";
import type { Box, Size } from "../../../src/shared/types.ts";

const GT_DIR = new URL("../../fixtures/generated/", import.meta.url);

interface Unit extends PackingUnit {
  id: string;
}

function bx(x1: number, y1: number, x2: number, y2: number): Box {
  return { x1, y1, x2, y2 };
}

function unit(id: string, contentKey: string, imageSize: Size, text: Box, glyphPx = 28): Unit {
  return { id, contentKey, imageSize, script: "hangul", geometry: { text, glyphPx } };
}

/** n small bubbles in a grid on a 1200×1800 page: always lays out. */
function pageUnits(n: number, contentKey = "s:page"): Unit[] {
  const size = { w: 1200, h: 1800 };
  return Array.from({ length: n }, (_, i) => {
    const x = 60 + (i % 4) * 280;
    const y = 60 + Math.floor(i / 4) * 160;
    return unit(`${contentKey}#${i + 1}`, contentKey, size, bx(x, y, x + 150, y + 60));
  });
}

function ids(packs: readonly Unit[][]): string[][] {
  return packs.map((pack) => pack.map((u) => u.id));
}

function sizes(packs: readonly Unit[][]): number[] {
  return packs.map((pack) => pack.length);
}

function gtUnits(stem: string): { size: Size; units: Unit[] } {
  const gt = JSON.parse(readFileSync(new URL(`${stem}.gt.json`, GT_DIR), "utf8")) as {
    width: number;
    height: number;
    units: Array<{ id: number; text: Box; glyphPx: number }>;
  };
  const size = { w: gt.width, h: gt.height };
  return {
    size,
    units: gt.units.map((u) => unit(`${stem}#${u.id}`, `s:${stem}`, size, u.text, u.glyphPx)),
  };
}

describe("resolveBoxBudget", () => {
  test("the model profile's budget unless the user set one, clamped to 4..20", () => {
    assert.equal(resolveBoxBudget(MODEL_PROFILES.gpt5.boxBudget, null), 20);
    assert.equal(resolveBoxBudget(MODEL_PROFILES.gpt4o.boxBudget, null), 12);
    assert.equal(resolveBoxBudget(MODEL_PROFILES.gpt5.boxBudget, 8), 8);
    assert.equal(resolveBoxBudget(12, undefined), 12);
    assert.equal(resolveBoxBudget(12, 2), 4);
    assert.equal(resolveBoxBudget(12, 64), 20);
    assert.equal(resolveBoxBudget(12, 9.7), 9);
    assert.equal(resolveBoxBudget(Number.NaN, null), 20);
  });
});

describe("isStripImage", () => {
  test("taller than 2.2 × the width (reading-order strip aspect)", () => {
    assert.equal(isStripImage({ w: 800, h: 2560 }), true);
    assert.equal(isStripImage({ w: 800, h: 7680 }), true);
    assert.equal(isStripImage({ w: 1200, h: 1800 }), false);
    assert.equal(isStripImage({ w: 800, h: 1760 }), false);
    assert.equal(isStripImage({ w: 0, h: 100 }), false);
  });
});

describe("compositeInputs", () => {
  test("full mode: n = index + 1, one segment per image in order of first use, bands for strips", () => {
    const page = { w: 1200, h: 1800 };
    const strip = { w: 800, h: 2560 };
    const units = [
      unit("a", "s:strip", strip, bx(100, 100, 300, 160), 24),
      unit("b", "s:page", page, bx(500, 400, 700, 470)),
      unit("c", "s:strip", strip, bx(100, 900, 300, 960)),
    ];
    const { segs, marks, crops } = compositeInputs(units, "full");
    assert.deepEqual(segs, [
      { imageId: "s:strip", kind: "band", src: bx(0, 0, 800, 2560), imgW: 800, imgH: 2560 },
      { imageId: "s:page", kind: "page", src: bx(0, 0, 1200, 1800), imgW: 1200, imgH: 1800 },
    ]);
    assert.deepEqual(
      marks.map((m) => [m.n, m.segment]),
      [
        [1, 0],
        [2, 1],
        [3, 0],
      ],
    );
    assert.deepEqual(marks[1]?.text, bx(500, 400, 700, 470));
    assert.deepEqual(crops[0], {
      n: 1,
      imageId: "s:strip",
      text: bx(100, 100, 300, 160),
      bounds: strip,
      glyphPx: 24,
      script: "hangul",
    });
    assert.deepEqual(
      crops.map((c) => c.n),
      [1, 2, 3],
    );
  });

  test("crops-only mode has crops renumbered 1..k and no context", () => {
    const { segs, marks, crops } = compositeInputs(pageUnits(3), "crops-only");
    assert.equal(segs.length, 0);
    assert.equal(marks.length, 0);
    assert.deepEqual(
      crops.map((c) => c.n),
      [1, 2, 3],
    );
  });

  test("inputs are copies: the layout never aliases the caller's boxes", () => {
    const units = pageUnits(1);
    const { marks, crops } = compositeInputs(units, "full");
    assert.notEqual(marks[0]?.text, units[0]?.geometry.text);
    assert.notEqual(crops[0]?.text, units[0]?.geometry.text);
  });

  test("layoutPack is layoutComposite over compositeInputs", () => {
    const units = pageUnits(5);
    const { segs, marks, crops } = compositeInputs(units, "full");
    const profile = MODEL_PROFILES.gpt5;
    assert.deepEqual(
      layoutPack(units, profile, "ltr", "full"),
      layoutComposite(segs, marks, crops, profile, "ltr", "full"),
    );
    assert.equal(layoutPack(units, profile, "ltr", "full").ok, true);
  });
});

describe("packUnits", () => {
  test("even packs within the box budget, in reading order, every unit exactly once", () => {
    assert.deepEqual(sizes(packUnits(pageUnits(20), { boxBudget: 20 })), [20]);
    assert.deepEqual(sizes(packUnits(pageUnits(21), { boxBudget: 20 })), [11, 10]);
    assert.deepEqual(sizes(packUnits(pageUnits(45), { boxBudget: 20 })), [15, 15, 15]);
    assert.deepEqual(sizes(packUnits(pageUnits(7), { boxBudget: 3 })), [3, 2, 2]);
    assert.deepEqual(sizes(packUnits(pageUnits(3), { boxBudget: 1 })), [1, 1, 1]);
    assert.deepEqual(packUnits([], { boxBudget: 20 }), []);
    const units = pageUnits(33);
    const packs = packUnits(units, { boxBudget: 12 });
    assert.deepEqual(
      packs.flat().map((u) => u.id),
      units.map((u) => u.id),
    );
    assert.ok(packs.every((pack) => pack.length <= 12));
  });

  test("a fractional or tiny budget still makes progress", () => {
    assert.deepEqual(sizes(packUnits(pageUnits(4), { boxBudget: 2.9 })), [2, 2]);
    assert.deepEqual(sizes(packUnits(pageUnits(2), { boxBudget: 0 })), [1, 1]);
  });

  test("maxImages (Phase 2): a pack never spans more images than allowed", () => {
    const units = [...pageUnits(2, "s:a"), ...pageUnits(2, "s:b"), ...pageUnits(2, "s:c")];
    const packs = packUnits(units, { boxBudget: 20, maxImages: 2 });
    assert.deepEqual(ids(packs), [
      ["s:a#1", "s:a#2", "s:b#1", "s:b#2"],
      ["s:c#1", "s:c#2"],
    ]);
  });

  test("layout policy: a webtoon strip is cut where its band would get narrower than 160 px", () => {
    const { units } = gtUnits("ko-strip01");
    const profile = MODEL_PROFILES.gpt5;
    assert.deepEqual(sizes(packUnits(units, { boxBudget: 20 })), [17]);
    assert.equal(layoutPack(units, profile, "ltr", "full").reason, "context");

    const packs = packUnits(units, { boxBudget: 20, layout: { profile, dir: "ltr" } });
    assert.deepEqual(sizes(packs), [9, 8]);
    for (const pack of packs) assert.equal(layoutPack(pack, profile, "ltr", "full").ok, true);
    assert.deepEqual(
      packs.flat().map((u) => u.id),
      units.map((u) => u.id),
    );
  });

  test("layout policy: a page that fits keeps the budget split; an image too big for one unit stays alone", () => {
    const { units } = gtUnits("ko-p01");
    const profile = MODEL_PROFILES.gpt5;
    assert.deepEqual(sizes(packUnits(units, { boxBudget: 20, layout: { profile, dir: "ltr" } })), [9]);

    // A caption box as big as a page cannot be laid out even alone: it is never dropped or merged.
    const size = { w: 1200, h: 6000 };
    const huge = unit("huge", "s:big", size, bx(0, 0, 1200, 5200), 12);
    const small = [
      unit("x", "s:big", size, bx(100, 5300, 300, 5360)),
      unit("y", "s:big", size, bx(500, 5500, 700, 5560)),
    ];
    assert.equal(layoutPack([huge], profile, "ltr", "full").ok, false);
    const packs = packUnits([huge, ...small], { boxBudget: 20, layout: { profile, dir: "ltr" } });
    assert.deepEqual(ids(packs), [["huge"], ["x", "y"]]);
  });

  test("layout policy: malformed geometry counts as not fitting instead of throwing", () => {
    const size = { w: 800, h: 1000 };
    const units = [
      unit("in", "s:m", size, bx(10, 10, 100, 60)),
      unit("out", "s:m", size, bx(900, 900, 950, 950)),
    ];
    const packs = packUnits(units, { boxBudget: 20, layout: { profile: MODEL_PROFILES.gpt5, dir: "ltr" } });
    assert.deepEqual(ids(packs), [["in"], ["out"]]);
  });
});
