import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DET_DEFAULTS, mergeAcrossSlices } from "../../../src/shared/core/detections.ts";
import type { SliceDetections } from "../../../src/shared/core/detections.ts";
import { planSlices } from "../../../src/shared/core/slicer.ts";
import type { Slice } from "../../../src/shared/core/slicer.ts";
import {
  MODEL_FAMILY,
  assignToSlices,
  buildUnitGeometry,
  buildUnitsFromRaw,
  detectorVersionOf,
  flattenParts,
  planDetectorSlices,
  sliceOptionsOf,
  sliceRecordsOf,
  slicesFromRecords,
  toUnitGeometry,
} from "../../../src/shared/core/units-build.ts";
import type { GeometryParams } from "../../../src/shared/core/units-build.ts";
import { iou } from "../../../src/shared/geometry.ts";
import { unitKeyOf } from "../../../src/shared/ids.ts";
import type { Box, DetClass, Detection } from "../../../src/shared/types.ts";

const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });
const det = (cls: DetClass, box: Box, score = 0.9): Detection => ({ cls, box, score });

const PARAMS: GeometryParams = {
  triggerRatio: 3.5,
  heightRatio: 3,
  overlap: 0.2,
  overlapMinPx: 200,
  quietRows: false,
};

/** What each slice's detector reports for `truth`: the visible part of every box, clamped to the slice. */
function sliced(truth: readonly Detection[], slices: readonly Slice[]): SliceDetections[] {
  return slices.map((slice) => ({
    slice,
    dets: truth
      .map((d) => ({
        ...d,
        box: b(
          Math.max(d.box.x1, slice.x),
          Math.max(d.box.y1, slice.y),
          Math.min(d.box.x2, slice.x + slice.w),
          Math.min(d.box.y2, slice.y + slice.h),
        ),
      }))
      .filter((d) => d.box.x2 - d.box.x1 > 5 && d.box.y2 - d.box.y1 > 5),
  }));
}

describe("detectorVersion (D-012)", () => {
  test("names the model family and the slicing parameters, plus a hash of the post-processing constants", () => {
    const version = detectorVersionOf(PARAMS);
    assert.match(version, /^v4s:t3\.5:r3:o0\.2:m200:q0:[0-9a-f]{8}$/);
    assert.equal(MODEL_FAMILY, "v4s");
    assert.equal(detectorVersionOf({ ...PARAMS }), version, "stable");
  });

  test("changes with every geometry-affecting slicing parameter", () => {
    const version = detectorVersionOf(PARAMS);
    const variants: GeometryParams[] = [
      { ...PARAMS, triggerRatio: 3 },
      { ...PARAMS, heightRatio: 2.5 },
      { ...PARAMS, overlap: 0.25 },
      { ...PARAMS, overlapMinPx: 100 },
      { ...PARAMS, quietRows: true },
    ];
    const all = new Set([version, ...variants.map(detectorVersionOf)]);
    assert.equal(all.size, variants.length + 1);
  });

  test("slice options map the settings names onto core/slicer", () => {
    assert.deepEqual(sliceOptionsOf(PARAMS), {
      trigger: 3.5,
      ratio: 3,
      overlapRatio: 0.2,
      minOverlapPx: 200,
    });
    assert.deepEqual(planDetectorSlices({ w: 800, h: 7680 }, PARAMS), planSlices({ w: 800, h: 7680 }));
  });
});

describe("slice records", () => {
  test("vertical slices store y only; horizontal ones store x too; both round-trip", () => {
    const tall = { w: 800, h: 7680 };
    const vertical = planSlices(tall).slices;
    const records = sliceRecordsOf(vertical, tall);
    assert.deepEqual(records[1], { y1: 1760, y2: 4160 });
    assert.deepEqual(slicesFromRecords(records, tall), vertical);

    const wide = { w: 4000, h: 800 };
    const horizontal = planSlices(wide).slices;
    const wideRecords = sliceRecordsOf(horizontal, wide);
    assert.deepEqual(wideRecords[1], { y1: 0, y2: 800, x1: 1600, x2: 4000 });
    assert.deepEqual(slicesFromRecords(wideRecords, wide), horizontal);
  });

  test("an unsliced image is one record covering it", () => {
    const page = { w: 800, h: 1200 };
    assert.deepEqual(sliceRecordsOf(planSlices(page).slices, page), [{ y1: 0, y2: 1200 }]);
  });
});

describe("assignToSlices", () => {
  const strip = { w: 800, h: 7680 };
  // [0, 2400), [1760, 4160), [3520, 5920), [5280, 7680)
  const slices = planSlices(strip).slices;

  const partOf = (d: Detection): number => {
    const parts = assignToSlices([d], slices, strip);
    return parts.findIndex((p) => p.dets.length > 0);
  };

  test("a box contained in one slice goes there", () => {
    assert.equal(partOf(det("bubble", b(100, 100, 300, 300))), 0);
    assert.equal(partOf(det("bubble", b(100, 7000, 300, 7300))), 3);
  });

  test("inside an overlap, a box touching a slice's internal edge goes to that slice", () => {
    // Clamped at the bottom of slice 0 (cut at 2400) although slice 1 also contains it.
    assert.equal(partOf(det("bubble", b(100, 2000, 300, 2400))), 0);
    // Clamped at the top of slice 1 (cut at 1760) although slice 0 also contains it.
    assert.equal(partOf(det("bubble", b(100, 1760, 300, 2100))), 1);
    // Within the 3 px tolerance of the edge.
    assert.equal(partOf(det("bubble", b(100, 1763, 300, 2100))), 1);
  });

  test("a whole box inside an overlap goes to the first slice containing it", () => {
    assert.equal(partOf(det("bubble", b(100, 1900, 300, 2200))), 0);
  });

  test("a box no slice contains goes to the slice it overlaps most; every slice gets a part", () => {
    const parts = assignToSlices([det("bubble", b(100, 3000, 300, 4300))], slices, strip);
    assert.equal(parts.length, slices.length);
    assert.deepEqual(
      parts.map((p) => p.dets.length),
      [0, 1, 0, 0],
    );
    assert.deepEqual(assignToSlices([det("bubble", b(1, 1, 50, 50))], [], strip), []);
  });

  test("an unsliced image keeps everything in one part", () => {
    const page = { w: 800, h: 1200 };
    const parts = assignToSlices(
      [det("bubble", b(0, 0, 800, 1200)), det("text_free", b(5, 5, 50, 30))],
      [{ x: 0, y: 0, ...page }],
      page,
    );
    assert.equal(parts[0]?.dets.length, 2);
  });

  test("horizontal slicing uses the x edges", () => {
    const wide = { w: 4000, h: 800 };
    const cols = planSlices(wide).slices; // [0, 2400), [1600, 4000)
    const parts = assignToSlices([det("bubble", b(1600, 100, 2000, 300))], cols, wide);
    assert.deepEqual(
      parts.map((p) => p.dets.length),
      [0, 1],
    );
  });

  test("property: reassigning the stored boxes merges back into the true bubbles, like true membership", () => {
    const tall = { w: 800, h: 12000 };
    const tallSlices = planSlices(tall).slices;
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 60; round++) {
      const truth: Detection[] = [];
      let y = Math.floor(random() * 200);
      while (y < tall.h - 80) {
        const h = 60 + Math.floor(random() * (random() < 0.2 ? 1740 : 700));
        const w = Math.floor(720 * (0.5 + 0.5 * random()));
        const x = 40 + Math.floor(random() * (720 - w));
        const y2 = Math.min(tall.h, y + h);
        truth.push(det("bubble", b(x, y, x + w, y2), 0.3 + 0.7 * random()));
        y = y2 + 1 + Math.floor(random() * (random() < 0.5 ? 6 : 300));
      }
      const parts = sliced(truth, tallSlices);
      const reassigned = mergeAcrossSlices(assignToSlices(flattenParts(parts), tallSlices, tall), tall);
      assert.equal(reassigned.length, truth.length, `round ${round}`);
      for (const t of truth) {
        assert.ok(
          reassigned.some((m) => iou(m.box, t.box) >= 0.95),
          `round ${round}: ${JSON.stringify(t.box)} not recovered`,
        );
      }
    }
  });
});

describe("buildUnitGeometry", () => {
  const page = { w: 800, h: 1200 };
  const pageSlices = planSlices(page).slices;

  test("a page: score ≥ scoreMin, band order, order === index, keys from bubble ?? text", () => {
    const raw = [
      det("bubble", b(450, 100, 750, 300), 0.95),
      det("text_bubble", b(500, 150, 700, 250), 0.9),
      det("bubble", b(50, 110, 350, 310), 0.94),
      det("text_bubble", b(100, 160, 300, 260), 0.9),
      det("text_free", b(100, 800, 600, 850), 0.8),
      det("text_free", b(100, 1000, 600, 1050), 0.2), // below scoreMin
    ];
    const units = buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.3, dir: "ltr" });
    assert.deepEqual(
      units.map((u) => [u.kind, u.bubble ?? u.text, u.order]),
      [
        ["bubble", b(50, 110, 350, 310), 0],
        ["bubble", b(450, 100, 750, 300), 1],
        ["free", b(100, 800, 600, 850), 2],
      ],
    );
    for (const u of units) assert.equal(u.unitKey, unitKeyOf(u.bubble ?? u.text));
  });

  test("the result is the wire shape: no engine-only fields", () => {
    const raw = [det("bubble", b(50, 110, 350, 310)), det("text_bubble", b(100, 160, 300, 260))];
    const [unit] = buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.3, dir: "ltr" });
    assert.ok(unit !== undefined);
    assert.deepEqual(Object.keys(unit).sort(), [
      "bubble",
      "glyphPx",
      "kind",
      "order",
      "orientation",
      "text",
      "texts",
      "unitKey",
    ]);
  });

  test("scoreMin applies at read time: the same raw detections give more or fewer units", () => {
    const raw = [
      det("text_free", b(100, 100, 600, 150), 0.9),
      det("text_free", b(100, 600, 600, 650), 0.22),
      det("text_free", b(100, 1000, 600, 1050), 0.1),
    ];
    assert.equal(buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.3, dir: "ltr" }).length, 1);
    assert.equal(buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.2, dir: "ltr" }).length, 2);
    assert.equal(buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.1, dir: "ltr" }).length, 3);
  });

  test("the direction reorders units without moving keys", () => {
    const raw = [
      det("text_free", b(50, 100, 300, 150)),
      det("text_free", b(500, 100, 750, 150)),
      det("text_free", b(50, 600, 300, 650)),
    ];
    const ltr = buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.3, dir: "ltr" });
    const rtl = buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.3, dir: "rtl" });
    assert.deepEqual(
      ltr.map((u) => u.text.x1),
      [50, 500, 50],
    );
    assert.deepEqual(
      rtl.map((u) => u.text.x1),
      [500, 50, 50],
    );
    assert.deepEqual(new Set(ltr.map((u) => u.unitKey)), new Set(rtl.map((u) => u.unitKey)));
  });

  test("rtl pages use the gutter cut (P3-06): a tall right panel is read before the left panel", () => {
    const wide = { w: 1200, h: 1800 };
    const slices = planSlices(wide).slices;
    const raw = [
      det("bubble", b(100, 200, 300, 400)), // left panel, between the right panel's two bubbles
      det("text_bubble", b(150, 250, 250, 350)),
      det("bubble", b(800, 350, 1000, 500)), // right panel, bottom
      det("text_bubble", b(850, 380, 950, 470)),
      det("bubble", b(800, 100, 1000, 250)), // right panel, top
      det("text_bubble", b(850, 130, 950, 220)),
    ];
    const rtl = buildUnitGeometry(raw, slices, wide, { scoreMin: 0.3, dir: "rtl" });
    assert.deepEqual(
      rtl.map((u) => [u.bubble?.x1, u.bubble?.y1, u.order]),
      [
        [800, 100, 0],
        [800, 350, 1],
        [100, 200, 2],
      ],
    );
    const ltr = buildUnitGeometry(raw, slices, wide, { scoreMin: 0.3, dir: "ltr" });
    assert.deepEqual(
      ltr.map((u) => u.bubble?.y1),
      [100, 200, 350],
      "ltr keeps the band sort",
    );
  });

  test("the Japanese fixture's ground-truth boxes come out in its reading order (rtl)", () => {
    interface GtUnit {
      id: number;
      kind: "bubble" | "free";
      bubble: Box | null;
      texts: Box[];
    }
    const gt = JSON.parse(
      readFileSync(new URL("../../fixtures/generated/ja-p01.gt.json", import.meta.url), "utf8"),
    ) as { width: number; height: number; units: GtUnit[] };
    const size = { w: gt.width, h: gt.height };
    // Detector-like input, last unit first so the input order says nothing.
    const raw = [...gt.units]
      .reverse()
      .flatMap((u) => [
        ...(u.bubble === null ? [] : [det("bubble", u.bubble)]),
        ...u.texts.map((t) => det(u.kind === "bubble" ? "text_bubble" : "text_free", t)),
      ]);
    const units = buildUnitGeometry(raw, planSlices(size).slices, size, { scoreMin: 0.3, dir: "rtl" });
    const idOf = (unit: { bubble: Box | null; text: Box }): number =>
      gt.units.find((u) => iou(u.bubble ?? u.texts[0] ?? b(0, 0, 0, 0), unit.bubble ?? unit.text) >= 0.9)
        ?.id ?? -1;
    assert.deepEqual(
      units.map(idOf),
      gt.units.map((u) => u.id),
    );
  });

  test("page furniture keeps the edgeSmall flag and comes last", () => {
    const raw = [det("text_free", b(370, 1170, 430, 1195)), det("text_free", b(100, 100, 600, 150))];
    const units = buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.3, dir: "ltr" });
    assert.deepEqual(
      units.map((u) => u.edgeSmall === true),
      [false, true],
    );
  });

  test("a strip: a bubble cut by a slice overlap is one unit; a box seen whole twice is one unit", () => {
    const strip = { w: 800, h: 7680 };
    const slices = planSlices(strip).slices;
    const truth = [
      det("bubble", b(100, 1500, 500, 2700), 0.9), // crosses both edges of the first overlap [1760, 2400)
      det("text_bubble", b(150, 1900, 450, 2300), 0.85), // whole in both slices 0 and 1
      det("bubble", b(200, 5000, 600, 5400), 0.8),
      det("text_bubble", b(250, 5100, 550, 5300), 0.75),
      det("text_free", b(300, 7000, 500, 7040), 0.2), // kept raw, dropped on read
    ];
    const raw = flattenParts(sliced(truth, slices));
    assert.ok(raw.length > truth.length, "overlaps report boxes twice");
    const units = buildUnitGeometry(raw, slices, strip, { scoreMin: 0.3, dir: "ltr" });
    assert.deepEqual(
      units.map((u) => [u.bubble, u.texts.length, u.order]),
      [
        [b(100, 1500, 500, 2700), 1, 0],
        [b(200, 5000, 600, 5400), 1, 1],
      ],
    );
    assert.equal(new Set(units.map((u) => u.unitKey)).size, units.length);
  });

  test("buildUnitsFromRaw keeps the engine-only score and seam edge; the wire units are its projection", () => {
    const strip = { w: 800, h: 7680 };
    const slices = planSlices(strip).slices;
    const raw = flattenParts(
      sliced(
        [
          det("bubble", b(100, 7400, 500, 7680), 0.9), // touches the bottom edge: seam candidate
          det("text_bubble", b(150, 7450, 450, 7600), 0.7),
          det("text_free", b(100, 3000, 600, 3050), 0.8),
        ],
        slices,
      ),
    );
    const built = buildUnitsFromRaw(raw, slices, strip, { scoreMin: 0.3, dir: "ltr" });
    assert.deepEqual(
      built.map((u) => [u.kind, Math.fround(u.score), u.edge]),
      [
        ["free", Math.fround(0.8), null],
        ["bubble", Math.fround(0.7), "bottom"],
      ],
    );
    assert.deepEqual(
      built.map(toUnitGeometry),
      buildUnitGeometry(raw, slices, strip, { scoreMin: 0.3, dir: "ltr" }),
    );
  });

  test("toUnitGeometry copies boxes", () => {
    const raw = [det("bubble", b(50, 110, 350, 310)), det("text_bubble", b(100, 160, 300, 260))];
    const units = buildUnitGeometry(raw, pageSlices, page, { scoreMin: 0.3, dir: "ltr" });
    const [unit] = units;
    assert.ok(unit !== undefined);
    const copy = toUnitGeometry({ ...unit, score: 0.9, edge: null });
    copy.text.x1 = -1;
    assert.notEqual(unit.text.x1, -1);
  });

  test("the scoreMin default of the pipeline matches DET_DEFAULTS", () => {
    assert.equal(DET_DEFAULTS.scoreMin, 0.3);
    assert.equal(DET_DEFAULTS.scoreFloor, 0.15);
  });
});
