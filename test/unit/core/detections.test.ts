import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DET_DEFAULTS,
  applyScoreMin,
  buildUnits,
  decodeDetectorOutput,
  dedupeDetections,
  mergeAcrossSlices,
  mergeTextBoxes,
  unitBox,
} from "../../../src/shared/core/detections.ts";
import type { BuiltUnit, DetectorOutput, SliceDetections } from "../../../src/shared/core/detections.ts";
import { contain, iou } from "../../../src/shared/geometry.ts";
import { planSlices } from "../../../src/shared/core/slicer.ts";
import type { Slice } from "../../../src/shared/core/slicer.ts";
import { unitKeyOf } from "../../../src/shared/ids.ts";
import type { Box, DetClass, Detection } from "../../../src/shared/types.ts";

const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });
const det = (cls: DetClass, box: Box, score = 0.9): Detection => ({ cls, box, score });
const LABEL: Record<DetClass, number> = { bubble: 0, text_bubble: 1, text_free: 2 };

type Row = [label: number, score: number, x1: number, y1: number, x2: number, y2: number];

/** Fake ORT output: 300 queries, rows first, the rest zero (below every floor). */
function tensor(rows: Row[]): { labels: BigInt64Array; boxes: Float32Array; scores: Float32Array } {
  const labels = new BigInt64Array(300);
  const boxes = new Float32Array(300 * 4);
  const scores = new Float32Array(300);
  rows.forEach(([label, score, ...box], i) => {
    labels[i] = BigInt(label);
    scores[i] = score;
    boxes.set(box, 4 * i);
  });
  return { labels, boxes, scores };
}

/** Same rows in model output for a tile, from image-space detections. */
function tensorFor(dets: Detection[], tile: { x: number; y: number }): DetectorOutput {
  return tensor(
    dets.map((d): Row => [
      LABEL[d.cls],
      d.score,
      d.box.x1 - tile.x,
      d.box.y1 - tile.y,
      d.box.x2 - tile.x,
      d.box.y2 - tile.y,
    ]),
  );
}

const f32 = (v: number): number => Math.fround(v);

describe("decodeDetectorOutput", () => {
  const tile = { x: 0, y: 1000, w: 800, h: 2400 };
  const rows: Row[] = [
    [0, 0.95, 100, 200, 400, 500], // bubble
    [1, 0.9, 150, 250, 350, 450], // text_bubble
    [2, 0.6, 150, 250, 350, 450], // the same query again as text_free: dropped
    [2, 0.5, -20, 2380, 120, 2450], // needs clamping to the tile
    [0, 0.4, 790, 10, 830, 14], // 4 px tall after clamping: dropped
    [7, 0.35, 10, 10, 100, 100], // unknown label: dropped
    [1, 0.3, Number.NaN, 0, 10, 10], // broken box: dropped
    [0, 0.2, 600, 900, 500, 700], // corners swapped
    [1, 0.1, 10, 10, 100, 100], // below the 0.15 floor
  ];
  const expected: Detection[] = [
    { cls: "bubble", box: b(100, 1200, 400, 1500), score: f32(0.95) },
    { cls: "text_bubble", box: b(150, 1250, 350, 1450), score: f32(0.9) },
    { cls: "text_free", box: b(0, 3380, 120, 3400), score: f32(0.5) },
    { cls: "bubble", box: b(500, 1700, 600, 1900), score: f32(0.2) },
  ];

  test("thresholds, clamps, drops small boxes, maps to image coordinates", () => {
    assert.deepEqual(decodeDetectorOutput(tensor(rows), tile), expected);
  });

  test("labels may be BigInt64Array, Int32Array or number[]", () => {
    const t = tensor(rows);
    const asInt32 = { ...t, labels: Int32Array.from(t.labels, (v) => Number(v)) };
    const asNumbers = { ...t, labels: Array.from(t.labels, (v) => Number(v)) };
    assert.deepEqual(decodeDetectorOutput(asInt32, tile), expected);
    assert.deepEqual(decodeDetectorOutput(asNumbers, tile), expected);
  });

  test("a duplicated query keeps the label with the higher score", () => {
    const dup = tensor([
      [2, 0.7, 10, 10, 200, 60],
      [1, 0.65, 10, 10, 200, 60],
      [0, 0.6, 10, 10, 200, 60], // a bubble with the same box is a different object: kept
    ]);
    assert.deepEqual(
      decodeDetectorOutput(dup, { x: 0, y: 0, w: 800, h: 800 }).map((d) => d.cls),
      ["text_free", "bubble"],
    );
  });

  test("double labels resolve by score even when the rows are not sorted (fixtures)", () => {
    const unsorted = tensor([
      [1, 0.5, 10, 10, 200, 60],
      [2, 0.8, 10, 10, 200, 60],
      [1, 0.4, 300, 10, 500, 60],
    ]);
    assert.deepEqual(
      decodeDetectorOutput(unsorted, { x: 0, y: 0, w: 800, h: 800 }).map((d) => [d.cls, d.box.x1]),
      [
        ["text_free", 10],
        ["text_bubble", 300],
      ],
    );
  });

  test("boxes with a side of exactly 5 px are dropped, 6 px are kept", () => {
    const sides = tensor([
      [1, 0.9, 10, 10, 15, 100], // 5 wide
      [1, 0.9, 30, 10, 36, 100], // 6 wide
      [1, 0.9, 50, 10, 150, 15], // 5 tall
      [1, 0.9, 50, 30, 150, 36], // 6 tall
    ]);
    assert.deepEqual(
      decodeDetectorOutput(sides, { x: 0, y: 0, w: 800, h: 800 }).map((d) => d.box),
      [b(30, 10, 36, 100), b(50, 30, 150, 36)],
    );
  });

  test("the score floor is configurable; truncated tensors are read safely", () => {
    assert.equal(decodeDetectorOutput(tensor(rows), tile, { scoreFloor: 0.3 }).length, 3);
    const t = tensor(rows);
    const short = { ...t, boxes: t.boxes.subarray(0, 4 * 2 + 3) };
    assert.equal(decodeDetectorOutput(short, tile).length, 2);
  });
});

describe("applyScoreMin and dedupe", () => {
  test("applyScoreMin keeps scores ≥ 0.30", () => {
    const dets = [0.29, 0.3, 0.31].map((s) => det("bubble", b(0, 0, 10, 10), s));
    assert.deepEqual(
      applyScoreMin(dets).map((d) => d.score),
      [0.3, 0.31],
    );
    assert.equal(DET_DEFAULTS.scoreMin, 0.3);
  });

  test("per-class dedupe keeps the larger box with the higher score", () => {
    const dets = [
      det("bubble", b(0, 0, 100, 100), 0.6),
      det("bubble", b(10, 10, 105, 105), 0.9), // IoU 0.74
      det("text_bubble", b(0, 0, 200, 50), 0.5),
      det("text_bubble", b(20, 10, 180, 45), 0.8), // inside the first: IoS 1
      det("text_free", b(0, 0, 100, 100), 0.7), // other class, same box as the bubble: kept
      det("bubble", b(300, 0, 400, 100), 0.4), // apart: kept
    ];
    assert.deepEqual(dedupeDetections(dets), [
      det("bubble", b(0, 0, 100, 100), 0.9),
      det("text_bubble", b(0, 0, 200, 50), 0.8),
      det("text_free", b(0, 0, 100, 100), 0.7),
      det("bubble", b(300, 0, 400, 100), 0.4),
    ]);
  });

  test("IoS exactly 0.85 is a duplicate even at a low IoU; 0.80 is not", () => {
    const big = det("bubble", b(0, 0, 100, 100), 0.9);
    const at85 = det("bubble", b(-3, 0, 17, 100), 0.5); // 17 of 20 columns inside: IoS 0.85, IoU 0.17
    const at80 = det("bubble", b(-4, 0, 16, 100), 0.5); // IoS 0.80
    assert.deepEqual(dedupeDetections([big, at85]), [big]);
    assert.equal(dedupeDetections([big, at80]).length, 2);
  });

  test("boxes overlapping below both thresholds survive", () => {
    const dets = [det("bubble", b(0, 0, 100, 100)), det("bubble", b(60, 0, 160, 100))]; // IoU 0.25, IoS 0.4
    assert.equal(dedupeDetections(dets).length, 2);
  });

  test("inputs are not mutated", () => {
    const dets = [det("bubble", b(0, 0, 100, 100), 0.6), det("bubble", b(10, 10, 105, 105), 0.9)];
    dedupeDetections(dets);
    assert.equal(dets[0]?.score, 0.6);
  });
});

describe("mergeAcrossSlices", () => {
  const size = { w: 800, h: 4000 };
  const top = { x: 0, y: 0, w: 800, h: 2400 };
  const bottom = { x: 0, y: 1600, w: 800, h: 2400 };

  test("fragments cut at both edges of the overlap are unioned", () => {
    const merged = mergeAcrossSlices(
      [
        { slice: top, dets: [det("bubble", b(100, 1400, 500, 2400), 0.7)] },
        { slice: bottom, dets: [det("bubble", b(100, 1600, 500, 2700), 0.8)] },
      ],
      size,
    );
    assert.deepEqual(merged, [det("bubble", b(100, 1400, 500, 2700), 0.8)]);
  });

  test("a box whole in one slice absorbs its cut fragment from the other", () => {
    const merged = mergeAcrossSlices(
      [
        { slice: top, dets: [det("text_bubble", b(100, 1700, 500, 2400), 0.9)] },
        { slice: bottom, dets: [det("text_bubble", b(100, 1700, 500, 2600), 0.6)] },
      ],
      size,
    );
    assert.deepEqual(merged, [det("text_bubble", b(100, 1700, 500, 2600), 0.9)]);
  });

  test("cut boxes side by side (no horizontal overlap) are not merged", () => {
    const merged = mergeAcrossSlices(
      [
        { slice: top, dets: [det("bubble", b(50, 2300, 300, 2400))] },
        { slice: bottom, dets: [det("bubble", b(500, 1600, 750, 1800))] },
      ],
      size,
    );
    assert.equal(merged.length, 2);
  });

  test("boxes of the same slice are never seam-merged", () => {
    const merged = mergeAcrossSlices(
      [
        {
          slice: top,
          dets: [det("bubble", b(100, 2000, 500, 2200)), det("bubble", b(100, 2205, 500, 2400))],
        },
      ],
      size,
    );
    assert.equal(merged.length, 2);
  });

  test("whole boxes from adjacent slices are deduped, not merged", () => {
    const merged = mergeAcrossSlices(
      [
        {
          slice: top,
          dets: [det("bubble", b(100, 1000, 500, 1200)), det("bubble", b(100, 1650, 500, 1900))],
        },
        {
          slice: bottom,
          dets: [det("bubble", b(100, 1650, 500, 1900)), det("bubble", b(100, 1905, 500, 2100))],
        },
      ],
      size,
    );
    assert.deepEqual(
      merged.map((d) => d.box),
      [b(100, 1000, 500, 1200), b(100, 1650, 500, 1900), b(100, 1905, 500, 2100)],
    );
  });

  test("classes are merged separately", () => {
    const merged = mergeAcrossSlices(
      [
        { slice: top, dets: [det("bubble", b(100, 1400, 500, 2400))] },
        { slice: bottom, dets: [det("text_bubble", b(100, 1600, 500, 2700))] },
      ],
      size,
    );
    assert.equal(merged.length, 2);
  });

  test("horizontal slicing merges along x", () => {
    const wide = { w: 4000, h: 800 };
    const merged = mergeAcrossSlices(
      [
        { slice: { x: 0, y: 0, w: 2400, h: 800 }, dets: [det("bubble", b(1400, 100, 2400, 500))] },
        { slice: { x: 1600, y: 0, w: 2400, h: 800 }, dets: [det("bubble", b(1600, 100, 2700, 500))] },
      ],
      wide,
    );
    assert.deepEqual(
      merged.map((d) => d.box),
      [b(1400, 100, 2700, 500)],
    );
  });

  test("a single slice only dedupes", () => {
    const merged = mergeAcrossSlices(
      [
        {
          slice: { x: 0, y: 0, ...size },
          dets: [det("bubble", b(0, 0, 100, 100)), det("bubble", b(1, 1, 100, 100))],
        },
      ],
      size,
    );
    assert.equal(merged.length, 1);
  });

  test("slices that only touch: pieces cut on both facing sides are unioned, a whole neighbour is not", () => {
    const abutting = [
      { x: 0, y: 0, w: 800, h: 2000 },
      { x: 0, y: 2000, w: 800, h: 2000 },
    ];
    const cut = mergeAcrossSlices(
      [
        { slice: abutting[0] as Slice, dets: [det("bubble", b(100, 1800, 500, 2000))] },
        { slice: abutting[1] as Slice, dets: [det("bubble", b(100, 2000, 500, 2300))] },
      ],
      size,
    );
    assert.deepEqual(
      cut.map((d) => d.box),
      [b(100, 1800, 500, 2300)],
    );
    const apart = mergeAcrossSlices(
      [
        { slice: abutting[0] as Slice, dets: [det("bubble", b(100, 1800, 500, 2000))] },
        { slice: abutting[1] as Slice, dets: [det("bubble", b(100, 2010, 500, 2300))] },
      ],
      size,
    );
    assert.equal(apart.length, 2);
  });

  describe("stacked bubbles next to a slice edge (regression: two bubbles were stitched into one)", () => {
    // 800×7680 strip: slices [0, 2400), [1760, 4160), [3520, 5920), ...
    const strip = { w: 800, h: 7680 };
    const [s0, s1, s2] = planSlices(strip).slices as [Slice, Slice, Slice];

    test("a box cut by its slice's top edge is not stitched onto a bubble that ends above the cut", () => {
      const upper = det("bubble", b(100, 1550, 500, 1755)); // ends 5 px above slice 1
      const lowerWhole = det("bubble", b(100, 1758, 500, 1900)); // starts 2 px above slice 1
      const lowerCut = det("bubble", b(100, 1760, 500, 1900)); // slice 1 sees it cut at its top edge
      const both = mergeAcrossSlices(
        [
          { slice: s0, dets: [upper, lowerWhole] },
          { slice: s1, dets: [lowerCut] },
        ],
        strip,
      );
      assert.deepEqual(
        both.map((d) => d.box),
        [upper.box, lowerWhole.box],
      );
      // Even when slice 0 missed the lower bubble, the cut piece does not reach across 1760 to the upper one.
      const missed = mergeAcrossSlices(
        [
          { slice: s0, dets: [upper] },
          { slice: s1, dets: [lowerCut] },
        ],
        strip,
      );
      assert.deepEqual(
        missed.map((d) => d.box),
        [upper.box, lowerCut.box],
      );
    });

    test("a box cut by its slice's bottom edge is not stitched onto a bubble that starts below the cut", () => {
      const merged = mergeAcrossSlices(
        [
          { slice: s0, dets: [det("bubble", b(100, 2250, 500, 2400))] }, // cut at 2400
          {
            slice: s1,
            dets: [det("bubble", b(100, 2250, 500, 2398)), det("bubble", b(100, 2402, 500, 2600))],
          },
        ],
        strip,
      );
      assert.deepEqual(
        merged.map((d) => d.box),
        [b(100, 2250, 500, 2400), b(100, 2402, 500, 2600)],
      );
    });

    test("a bubble ending within the edge tolerance is not stitched onto one that only grazes the overlap", () => {
      // Found by the property test below: on an 800×12000 strip, slice [1920, 4320) sees A end 3 px above its bottom
      // edge (so A counts as cut) and only a 2 px sliver of B (dropped); slice [3840, 6240) sees both whole.
      const tall = { w: 800, h: 12000 };
      const [, t1, t2] = planSlices(tall).slices as [Slice, Slice, Slice];
      assert.deepEqual([t1.y, t1.y + t1.h, t2.y], [1920, 4320, 3840]);
      const a = b(159, 3602, 574, 4317);
      const bBox = b(201, 4318, 584, 5217);
      const merged = mergeAcrossSlices(
        [
          { slice: t1, dets: [det("bubble", a)] },
          { slice: t2, dets: [det("bubble", b(159, 3840, 574, 4317)), det("bubble", bBox)] },
        ],
        tall,
      );
      assert.deepEqual(
        merged.map((d) => d.box),
        [a, bBox],
      );
    });

    test("a bubble taller than one overlap is unioned across three slices", () => {
      const merged = mergeAcrossSlices(
        [
          { slice: s0, dets: [det("bubble", b(100, 1500, 500, 2400), 0.6)] },
          { slice: s1, dets: [det("bubble", b(100, 1760, 500, 4160), 0.9)] },
          { slice: s2, dets: [det("bubble", b(100, 3520, 500, 4500), 0.7)] },
        ],
        strip,
      );
      assert.deepEqual(merged, [det("bubble", b(100, 1500, 500, 4500), 0.9)]);
    });
  });

  describe("property: the slices of separate bubbles merge back into those bubbles", () => {
    const strip = { w: 800, h: 12000 };
    const { slices } = planSlices(strip);

    function lcg(seed: number): () => number {
      let s = seed;
      return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
      };
    }

    /** One or two columns of bubbles, 60-1800 px tall, often only 1-6 px apart. */
    function stackedBubbles(random: () => number): Box[] {
      const out: Box[] = [];
      const columns: Array<[number, number]> =
        random() < 0.5
          ? [[40, 760]]
          : [
              [30, 390],
              [410, 770],
            ];
      for (const [c1, c2] of columns) {
        let y = Math.floor(random() * 200);
        while (y < strip.h - 80) {
          const h = 60 + Math.floor(random() * (random() < 0.2 ? 1740 : 700));
          const w = Math.floor((c2 - c1) * (0.5 + 0.5 * random()));
          const x = c1 + Math.floor(random() * (c2 - c1 - w));
          const y2 = Math.min(strip.h, y + h);
          out.push(b(x, y, x + w, y2));
          y = y2 + 1 + Math.floor(random() * (random() < 0.5 ? 6 : 300));
        }
      }
      return out;
    }

    /** What each slice's detector reports: the visible part; edges inside the slice move by up to ±jitter px. */
    function sliced(truth: Box[], jitter: number, random: () => number): SliceDetections[] {
      const j = (): number => Math.round((random() * 2 - 1) * jitter);
      return slices.map((slice) => ({
        slice,
        dets: truth
          .map((t) => {
            const top = t.y1 >= slice.y ? t.y1 + j() : slice.y;
            const bottom = t.y2 <= slice.y + slice.h ? t.y2 + j() : slice.y + slice.h;
            const y1 = Math.max(slice.y, top);
            const y2 = Math.min(slice.y + slice.h, bottom);
            return det("bubble", b(t.x1 + j(), y1, t.x2 + j(), y2));
          })
          .filter((d) => d.box.y2 - d.box.y1 > 5),
      }));
    }

    test("exact boxes: every bubble comes back once (IoU ≥ 0.95), nothing else", () => {
      const random = lcg(1);
      for (let round = 0; round < 150; round++) {
        const truth = stackedBubbles(random);
        const merged = mergeAcrossSlices(sliced(truth, 0, random), strip).map((d) => d.box);
        assert.equal(merged.length, truth.length, `round ${round}`);
        const used = new Set<number>();
        for (const t of truth) {
          const hit = merged.findIndex((m, i) => !used.has(i) && iou(m, t) >= 0.95);
          assert.ok(hit >= 0, `round ${round}: bubble ${JSON.stringify(t)} not recovered`);
          used.add(hit);
        }
      }
    });

    test("jittered boxes: every bubble is recovered and no output spans two bubbles", () => {
      const random = lcg(2);
      for (let round = 0; round < 150; round++) {
        const truth = stackedBubbles(random);
        const merged = mergeAcrossSlices(sliced(truth, 4, random), strip).map((d) => d.box);
        for (const t of truth) {
          assert.ok(
            merged.some((m) => iou(m, t) >= 0.75),
            `round ${round}: ${JSON.stringify(t)}`,
          );
        }
        for (const m of merged) {
          const spanned = truth.filter((t) => contain(t, m) >= 0.5).length;
          assert.ok(spanned <= 1, `round ${round}: ${JSON.stringify(m)} spans ${spanned} bubbles`);
        }
      }
    });
  });

  test("tiles that do not split one axis (a grid) are only deduped", () => {
    // Fragments cut at x = 1000 and x = 600 (IoU 0.44, IoS 0.67: not duplicates).
    const left = { slice: { x: 0, y: 0, w: 1000, h: 1000 }, dets: [det("bubble", b(400, 400, 1000, 600))] };
    const right = {
      slice: { x: 600, y: 0, w: 1000, h: 1000 },
      dets: [det("bubble", b(600, 400, 1300, 600))],
    };
    const columns = mergeAcrossSlices([left, right], { w: 1600, h: 1000 });
    assert.deepEqual(
      columns.map((d) => d.box),
      [b(400, 400, 1300, 600)],
      "full-height tiles: seam merge along x",
    );
    const grid = mergeAcrossSlices([left, right, { slice: { x: 0, y: 600, w: 1000, h: 1000 }, dets: [] }], {
      w: 1600,
      h: 1600,
    });
    assert.equal(grid.length, 2);
  });
});

describe("buildUnits", () => {
  const page = { w: 1200, h: 1800 };

  test("a bubble with its text is one unit keyed by the bubble box", () => {
    const bubble = b(100, 100, 500, 400);
    const text = b(150, 150, 450, 350);
    const units = buildUnits([det("bubble", bubble, 0.95), det("text_bubble", text, 0.8)], page);
    const expected: BuiltUnit = {
      unitKey: unitKeyOf(bubble),
      kind: "bubble",
      bubble,
      text,
      texts: [text],
      orientation: "h",
      glyphPx: 32, // 200 px block snapped to 5 lines with the 36 px prior
      order: 0,
      score: 0.8,
      edge: null,
    };
    assert.deepEqual(units, [expected]);
    assert.deepEqual(unitBox(expected), bubble);
  });

  test("all text boxes of a bubble form one unit; overlapping text boxes are merged first", () => {
    const bubble = b(100, 100, 500, 450);
    const lines = [det("text_bubble", b(150, 260, 450, 350)), det("text_bubble", b(150, 150, 450, 240))];
    const [unit] = buildUnits([det("bubble", bubble), ...lines], page);
    assert.deepEqual(unit?.texts, [b(150, 150, 450, 240), b(150, 260, 450, 350)]);
    assert.deepEqual(unit?.text, b(150, 150, 450, 350));

    const overlapping = [
      det("text_bubble", b(150, 150, 450, 300)),
      det("text_bubble", b(300, 200, 470, 320)),
    ];
    assert.deepEqual(buildUnits([det("bubble", bubble), ...overlapping], page)[0]?.texts, [
      b(150, 150, 470, 320),
    ]);
  });

  test("text_bubble needs ≥ 0.6 of its area inside the bubble", () => {
    const bubble = det("bubble", b(300, 300, 500, 500));
    const inside = buildUnits([bubble, det("text_bubble", b(420, 350, 520, 450))], page); // 0.8 inside
    assert.equal(inside.length, 1);
    assert.equal(inside[0]?.bubble !== null, true);
    const outside = buildUnits([bubble, det("text_bubble", b(460, 350, 560, 450))], page); // 0.4 inside
    assert.equal(outside.length, 1, "the bubble without text is dropped");
    assert.equal(outside[0]?.bubble, null);
    assert.equal(outside[0]?.kind, "bubble", "orphan bubble text keeps kind bubble");
  });

  test("text_free needs ≥ 0.85 inside a bubble", () => {
    const bubble = det("bubble", b(300, 300, 500, 500));
    const in90 = buildUnits([bubble, det("text_free", b(410, 350, 510, 450))], page);
    assert.notEqual(in90[0]?.bubble, null);
    const in80 = buildUnits([bubble, det("text_free", b(420, 350, 520, 450))], page);
    assert.equal(in80[0]?.bubble, null);
    assert.equal(in80[0]?.kind, "free");
  });

  test("a text box goes to the smallest bubble that contains it", () => {
    const small = b(200, 200, 400, 400);
    const units = buildUnits(
      [det("bubble", b(100, 100, 700, 700)), det("bubble", small), det("text_bubble", b(250, 250, 350, 350))],
      page,
    );
    assert.equal(units.length, 1);
    assert.deepEqual(units[0]?.bubble, small);
  });

  test("free text lines close together become one unit", () => {
    const lines = [
      det("text_free", b(100, 1000, 500, 1030)),
      det("text_free", b(120, 1036, 480, 1066)),
      det("text_free", b(100, 1072, 400, 1102)),
      det("text_free", b(505, 1000, 600, 1030)), // continues line 1 after a 5 px gap
    ];
    const far = det("text_free", b(100, 1200, 500, 1230)); // 98 px below: own unit
    const aside = det("text_free", b(700, 1036, 1000, 1066)); // same rows, 220 px to the right: own unit
    const units = buildUnits([...lines, far, aside], page);
    assert.equal(units.length, 3);
    const narration = units.find((u) => u.texts.length === 4);
    assert.ok(narration);
    assert.equal(narration.kind, "free");
    assert.deepEqual(narration.text, b(100, 1000, 600, 1102));
    assert.equal(narration.glyphPx, 30);
  });

  test("grouping parameters are configurable", () => {
    const lines = [det("text_free", b(100, 1000, 500, 1030)), det("text_free", b(100, 1045, 500, 1075))]; // gap 15
    assert.equal(buildUnits(lines, page).length, 1);
    assert.equal(buildUnits(lines, page, { freeMerge: { gapGlyph: 0.3 } }).length, 2);
  });

  test("tall text boxes make a vertical unit, unless vertical text is disallowed", () => {
    const dets = [
      det("bubble", b(600, 200, 900, 700)),
      det("text_bubble", b(740, 250, 780, 550)),
      det("text_bubble", b(800, 250, 840, 600)),
    ];
    const [vertical] = buildUnits(dets, page);
    assert.equal(vertical?.orientation, "v");
    assert.deepEqual(
      vertical?.texts,
      [b(800, 250, 840, 600), b(740, 250, 780, 550)],
      "columns right to left",
    );
    assert.equal(vertical?.glyphPx, 40);
    assert.equal(buildUnits(dets, page, { allowVertical: false })[0]?.orientation, "h");
  });

  test("small boxes near the page border are edgeSmall and ordered last", () => {
    const pageNumber = det("text_free", b(1150, 1760, 1180, 1785));
    const center = det("text_free", b(600, 900, 630, 925));
    const dialogue = [det("bubble", b(300, 1500, 700, 1700)), det("text_bubble", b(350, 1550, 650, 1650))];
    const units = buildUnits([pageNumber, center, ...dialogue], page);
    assert.deepEqual(
      units.map((u) => [u.order, u.edgeSmall === true]),
      [
        [0, false],
        [1, false],
        [2, true],
      ],
    );
    assert.deepEqual(units[2]?.text, pageNumber.box);
    assert.equal(units[2]?.edge, "bottom");
    assert.equal("edgeSmall" in (units[0] as object), false, "the flag is absent, not false");
  });

  test("on strips only the long sides count for edgeSmall; top and bottom units are seam candidates", () => {
    const strip = { w: 800, h: 8000 };
    const units = buildUnits(
      [det("text_free", b(380, 5, 420, 30)), det("text_free", b(770, 4000, 795, 4020))],
      strip,
    );
    assert.deepEqual(
      units.map((u) => [u.text.y1, u.edgeSmall === true, u.edge]),
      [
        [5, false, "top"],
        [4000, true, null],
      ],
    );
  });

  test("units smaller than 5e-5 of the reference area are dropped", () => {
    assert.equal(buildUnits([det("text_free", b(600, 900, 609, 909))], page).length, 0);
    assert.equal(buildUnits([det("text_free", b(600, 900, 612, 912))], page).length, 1);
  });

  test("reading order follows the direction; keys come from bubble ?? text", () => {
    const left = b(100, 100, 400, 400);
    const right = b(600, 120, 900, 420);
    const dets = [
      det("bubble", right),
      det("text_bubble", b(650, 170, 850, 370)),
      det("bubble", left),
      det("text_bubble", b(150, 150, 350, 350)),
    ];
    const ltr = buildUnits(dets, page);
    assert.deepEqual(
      ltr.map((u) => [u.order, u.unitKey]),
      [
        [0, unitKeyOf(left)],
        [1, unitKeyOf(right)],
      ],
    );
    const rtl = buildUnits(dets, page, { dir: "rtl" });
    assert.deepEqual(
      rtl.map((u) => u.unitKey),
      [unitKeyOf(right), unitKeyOf(left)],
    );
    const free = buildUnits([det("text_free", b(100, 1000, 500, 1030))], page);
    assert.equal(free[0]?.unitKey, unitKeyOf(b(100, 1000, 500, 1030)));
  });

  test("colliding unit keys get a suffix", () => {
    const units = buildUnits(
      [
        det("bubble", b(100, 100, 300, 300)),
        det("bubble", b(101, 101, 301, 301)),
        det("text_bubble", b(100, 100, 160, 160)),
        det("text_bubble", b(240, 240, 301, 301)),
      ],
      page,
    );
    assert.deepEqual(
      units.map((u) => u.unitKey),
      ["25:25:75:75", "25:25:75:75~2"],
    );
  });

  test("a colliding key stays with its box when the reading direction flips (regression)", () => {
    // Same quantized key; ltr reads the left bubble first, rtl the right one.
    const dets = [
      det("bubble", b(101, 101, 301, 301)),
      det("bubble", b(100, 100, 300, 300)),
      det("text_bubble", b(100, 100, 160, 160)),
      det("text_bubble", b(240, 240, 301, 301)),
    ];
    const keyByX = (dir: "ltr" | "rtl"): Array<[number | undefined, string]> =>
      buildUnits(dets, page, { dir })
        .map((u): [number | undefined, string] => [u.bubble?.x1, u.unitKey])
        .sort((p, q) => (p[0] ?? 0) - (q[0] ?? 0));
    const expected: Array<[number, string]> = [
      [100, "25:25:75:75"],
      [101, "25:25:75:75~2"],
    ];
    assert.deepEqual(keyByX("ltr"), expected);
    assert.deepEqual(keyByX("rtl"), expected);
    assert.deepEqual(
      buildUnits(dets, page, { dir: "rtl" }).map((u) => u.bubble?.x1),
      [101, 100],
      "the reading order itself does flip",
    );
  });

  test("a glyph estimator can be injected; bad values fall back to geometry", () => {
    const dets = [det("text_free", b(100, 1000, 500, 1030))];
    assert.equal(buildUnits(dets, page, { glyph: () => 17.4 })[0]?.glyphPx, 17);
    assert.equal(buildUnits(dets, page, { glyph: () => Number.NaN })[0]?.glyphPx, 30);
  });

  test("the unit score is the best text score", () => {
    const units = buildUnits(
      [
        det("bubble", b(100, 100, 500, 450), 0.99),
        det("text_bubble", b(150, 150, 450, 240), 0.4),
        det("text_bubble", b(150, 260, 450, 350), 0.7),
      ],
      page,
    );
    assert.equal(units[0]?.score, 0.7);
  });

  test("mergeTextBoxes unions boxes ≥ 30% inside one another until stable", () => {
    const merged = mergeTextBoxes([
      det("text_free", b(0, 0, 100, 40), 0.5), // X
      det("text_bubble", b(150, 0, 240, 40), 0.9), // Z: apart from X at first
      det("text_free", b(60, 10, 190, 30), 0.6), // Y: 31% inside X; X ∪ Y then covers 44% of Z
      det("text_free", b(400, 0, 500, 40), 0.6),
      det("text_free", b(420, 60, 480, 100), 0.6), // touches nothing
    ]);
    assert.deepEqual(merged, [
      det("text_free", b(0, 0, 240, 40), 0.9),
      det("text_free", b(400, 0, 500, 40), 0.6),
      det("text_free", b(420, 60, 480, 100), 0.6),
    ]);
  });

  test("mergeTextBoxes leaves boxes overlapping less than 30% apart", () => {
    const boxes = [det("text_free", b(0, 0, 100, 40)), det("text_free", b(75, 0, 175, 40))]; // 25%
    assert.equal(mergeTextBoxes(boxes).length, 2);
    assert.equal(mergeTextBoxes(boxes, 0.2).length, 1);
  });
});

describe("pipeline on a sliced strip", () => {
  test("decode → scoreMin → merge → units yields one unit per bubble across the slice overlap", () => {
    const size = { w: 800, h: 7680 };
    const plan = planSlices(size);
    const truth: Detection[] = [
      det("bubble", b(100, 1500, 500, 2700), 0.9), // crosses both edges of the first overlap [1760, 2400)
      det("text_bubble", b(150, 1900, 450, 2300), 0.85),
      det("bubble", b(200, 5000, 600, 5400), 0.8),
      det("text_bubble", b(250, 5100, 550, 5300), 0.75),
      det("text_free", b(300, 7000, 500, 7040), 0.2), // below scoreMin: kept raw, dropped on read
    ];
    const raw = plan.slices.map((slice) => {
      // Each slice sees the part of every box inside it, as the detector would.
      const visible = truth
        .map((d) => ({
          ...d,
          box: b(d.box.x1, Math.max(d.box.y1, slice.y), d.box.x2, Math.min(d.box.y2, slice.y + slice.h)),
        }))
        .filter((d) => d.box.y2 - d.box.y1 > 5);
      return { slice, dets: decodeDetectorOutput(tensorFor(visible, slice), slice) };
    });
    assert.ok(
      raw.some((part) => part.dets.some((d) => d.score < 0.3)),
      "raw detections keep scores from 0.15",
    );
    const merged = mergeAcrossSlices(
      raw.map((part) => ({ slice: part.slice, dets: applyScoreMin(part.dets) })),
      size,
    );
    const units = buildUnits(merged, size);
    assert.deepEqual(
      units.map((u) => [u.bubble, u.texts.length]),
      [
        [b(100, 1500, 500, 2700), 1],
        [b(200, 5000, 600, 5400), 1],
      ],
    );
  });
});
