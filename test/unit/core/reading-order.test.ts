import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  axisRuns,
  bandSort,
  chooseReadingDir,
  cornerSort,
  GUTTER_DEFAULTS,
  gutterCut,
  orderHooksFor,
  readingOrder,
  singlePanel,
} from "../../../src/shared/core/reading-order.ts";
import type { OrderItem, PanelSegmenter } from "../../../src/shared/core/reading-order.ts";
import type { Box, ReadingDir } from "../../../src/shared/types.ts";

const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });
const items = (...boxes: Box[]): OrderItem[] => boxes.map((box) => ({ box }));

describe("band sort", () => {
  // Shuffled 2×2 grid: 0 = bottom-right, 1 = top-left, 2 = bottom-left, 3 = top-right.
  const grid = items(b(200, 200, 300, 300), b(0, 0, 100, 100), b(0, 200, 100, 300), b(200, 0, 300, 100));

  test("ltr: rows top to bottom, left to right", () => {
    assert.deepEqual(readingOrder(grid, { dir: "ltr" }), [1, 3, 2, 0]);
  });

  test("rtl: rows top to bottom, right to left", () => {
    assert.deepEqual(readingOrder(grid, { dir: "rtl" }), [3, 1, 0, 2]);
  });

  test("a vertical overlap of half the shorter box shares a band", () => {
    const pair = items(b(0, 0, 100, 100), b(200, 50, 300, 150));
    assert.deepEqual(readingOrder(pair, { dir: "ltr" }), [0, 1]);
    assert.deepEqual(readingOrder(pair, { dir: "rtl" }), [1, 0]);
  });

  test("less overlap starts a new band, whatever the x position", () => {
    // 0 is on the right but higher; 1 is on the left, 40% overlap.
    const pair = items(b(200, 0, 300, 100), b(0, 60, 100, 160));
    assert.deepEqual(readingOrder(pair, { dir: "ltr" }), [0, 1]);
    assert.deepEqual(readingOrder(pair, { dir: "ltr", bandOverlap: 0.3 }), [1, 0], "looser band threshold");
  });

  test("bands chain through overlapping members", () => {
    const three = items(b(0, 0, 100, 100), b(400, 50, 500, 150), b(200, 100, 300, 200));
    assert.deepEqual(readingOrder(three, { dir: "ltr" }), [0, 2, 1]);
  });

  test("webtoon zigzag conversation reads top-down", () => {
    const zigzag = items(b(400, 150, 700, 350), b(50, 300, 350, 500), b(50, 0, 350, 200));
    assert.deepEqual(readingOrder(zigzag, { dir: "ltr" }), [2, 0, 1]);
  });

  test("edgeSmall items come last, band-sorted among themselves", () => {
    const list: OrderItem[] = [
      { box: b(10, 10, 40, 30), edgeSmall: true }, // page number in the top corner
      { box: b(100, 100, 300, 200) },
      { box: b(760, 2000, 790, 2020), edgeSmall: true },
      { box: b(100, 400, 300, 500) },
    ];
    assert.deepEqual(readingOrder(list, { dir: "ltr" }), [1, 3, 0, 2]);
  });

  test("equal keys keep the input order", () => {
    const same = items(b(0, 0, 50, 50), b(0, 0, 50, 50), b(0, 0, 50, 50));
    assert.deepEqual(readingOrder(same, { dir: "ltr" }), [0, 1, 2]);
    assert.deepEqual(readingOrder(same, { dir: "rtl" }), [0, 1, 2]);
  });

  test("bandSort orders a subset of indices", () => {
    assert.deepEqual(bandSort(grid, [0, 2], "ltr"), [2, 0]);
    assert.deepEqual(bandSort(grid, [], "rtl"), []);
    assert.throws(() => bandSort(grid, [9], "ltr"), RangeError);
  });

  test("empty input", () => {
    assert.deepEqual(readingOrder([], { dir: "ltr" }), []);
  });
});

describe("Phase 3 hooks", () => {
  const four = items(b(0, 0, 100, 100), b(200, 0, 300, 100), b(0, 200, 100, 300), b(200, 200, 300, 300));

  test("singlePanel is the Phase 1 default", () => {
    assert.deepEqual(singlePanel(four, "ltr"), [[0, 1, 2, 3]]);
  });

  test("a segmenter orders panels, then each panel is band-sorted", () => {
    // Two columns, the right one first (rtl page): panels [1, 3] then [0, 2].
    const columns: PanelSegmenter = () => [
      [3, 1],
      [2, 0],
    ];
    assert.deepEqual(readingOrder(four, { dir: "rtl", segmenter: columns }), [1, 3, 0, 2]);
  });

  test("the segmenter only sees normal items; indices map back", () => {
    const list: OrderItem[] = [{ box: b(0, 0, 10, 10), edgeSmall: true }, ...four];
    const seen: number[] = [];
    const reversed: PanelSegmenter = (sub) => {
      seen.push(sub.length);
      return [[3], [2], [1], [0]];
    };
    assert.deepEqual(readingOrder(list, { dir: "ltr", segmenter: reversed }), [4, 3, 2, 1, 0]);
    assert.deepEqual(seen, [4]);
  });

  test("malformed segmenter or leaf output falls back to the band sort", () => {
    const missing: PanelSegmenter = () => [[0, 1]];
    const duplicated: PanelSegmenter = () => [
      [0, 1],
      [1, 2, 3],
    ];
    assert.deepEqual(readingOrder(four, { dir: "ltr", segmenter: missing }), [0, 1, 2, 3]);
    assert.deepEqual(readingOrder(four, { dir: "ltr", segmenter: duplicated }), [0, 1, 2, 3]);
    assert.deepEqual(readingOrder(four, { dir: "ltr", leafSorter: () => [0] }), [0, 1, 2, 3]);
  });

  test("a leaf sorter replaces the band sort inside panels", () => {
    const reverse = (_: readonly OrderItem[], indices: readonly number[]): number[] => [...indices].reverse();
    assert.deepEqual(readingOrder(four, { dir: "ltr", leafSorter: reverse }), [3, 2, 1, 0]);
  });
});

describe("chooseReadingDir", () => {
  const page = { w: 1200, h: 1800 };
  const strip = { w: 800, h: 3000 };
  const columns = [b(0, 0, 30, 200), b(50, 0, 80, 150), b(100, 0, 130, 180)];
  const lines = [b(0, 0, 300, 30), b(0, 50, 250, 80)];

  test("the series setting wins, then the site", () => {
    assert.equal(chooseReadingDir({ size: strip, series: "rtl" }), "rtl");
    assert.equal(chooseReadingDir({ size: page, series: "auto", site: "rtl" }), "rtl");
    assert.equal(chooseReadingDir({ size: page, series: "ltr", site: "rtl", lang: "ja" }), "ltr");
  });

  test("strips read ltr top-down even with vertical text or Japanese", () => {
    assert.equal(chooseReadingDir({ size: strip, textBoxes: columns, lang: "ja" }), "ltr");
  });

  test("pages with mostly vertical text read rtl", () => {
    assert.equal(chooseReadingDir({ size: page, textBoxes: columns }), "rtl");
    assert.equal(chooseReadingDir({ size: page, textBoxes: lines }), "ltr");
  });

  test("language decides last: ja → rtl, others → ltr", () => {
    assert.equal(chooseReadingDir({ size: page, textBoxes: lines, lang: "ja" }), "rtl");
    assert.equal(chooseReadingDir({ size: page, lang: "ko" }), "ltr");
    assert.equal(chooseReadingDir({ size: page }), "ltr");
  });
});

/** Kendall rank correlation between two orderings of the same ids: 1 = identical, -1 = reversed. */
function kendallTau(actual: readonly number[], truth: readonly number[]): number {
  assert.deepEqual(
    [...actual].sort((p, q) => p - q),
    [...truth].sort((p, q) => p - q),
    "same ids",
  );
  const rank = new Map(actual.map((id, i) => [id, i]));
  const at = (id: number | undefined): number => rank.get(id ?? -1) ?? -1;
  let score = 0;
  for (let i = 0; i < truth.length; i++) {
    for (let j = i + 1; j < truth.length; j++) score += at(truth[i]) < at(truth[j]) ? 1 : -1;
  }
  const pairs = (truth.length * (truth.length - 1)) / 2;
  return pairs === 0 ? 1 : score / pairs;
}

/** What units-build uses: the gutter cut + corner rule for rtl, the band sort for ltr. */
const manga = (list: readonly OrderItem[], dir: ReadingDir = "rtl"): number[] =>
  readingOrder(list, { dir, ...orderHooksFor(dir) });
/** The gutter cut + corner rule in either direction. */
const xyCut = (list: readonly OrderItem[], dir: ReadingDir): number[] =>
  readingOrder(list, { dir, segmenter: gutterCut(), leafSorter: cornerSort });

describe("P3-06 manga reading order (gutter cut + corner rule)", () => {
  interface GtUnit {
    id: number;
    bubble: Box | null;
    text: Box;
    edgeSmall?: boolean;
  }
  const gt = JSON.parse(
    readFileSync(new URL("../../fixtures/generated/ja-p01.gt.json", import.meta.url), "utf8"),
  ) as { layout: string; units: GtUnit[] };

  test("exit: Kendall tau ≥ 0.9 against the Japanese fixture's ground truth, whatever the input order", () => {
    assert.equal(gt.layout, "paged-rtl");
    const truth = gt.units.map((u) => u.id);
    const orders = [
      gt.units,
      [...gt.units].reverse(),
      gt.units.filter((_, i) => i % 2 === 1).concat(gt.units.filter((_, i) => i % 2 === 0)),
      [...gt.units.slice(4), ...gt.units.slice(0, 4)],
    ];
    for (const units of orders) {
      const list = units.map((u) => ({ box: u.bubble ?? u.text, edgeSmall: u.edgeSmall === true }));
      const ids = manga(list).map((i) => units[i]?.id ?? -1);
      const tau = kendallTau(ids, truth);
      assert.ok(tau >= 0.9, `tau ${tau.toFixed(3)} for ${ids.join(",")}`);
      assert.deepEqual(ids, truth, "the synthetic page is read exactly");
    }
  });

  test("Kendall tau helper", () => {
    assert.equal(kendallTau([1, 2, 3, 4], [1, 2, 3, 4]), 1);
    assert.equal(kendallTau([4, 3, 2, 1], [1, 2, 3, 4]), -1);
    assert.equal(kendallTau([2, 1, 3, 4], [1, 2, 3, 4]), 4 / 6);
  });

  test("tiers top to bottom, panels right to left, where the band sort zigzags across panels", () => {
    // One tier: a tall right panel with two stacked bubbles (0 above 1) and a left panel whose bubble (2) sits
    // between their heights. The band sort reads 0, 2, 1; the gutter between the panels keeps 0, 1 together.
    const tier = items(b(800, 100, 1000, 250), b(800, 350, 1000, 500), b(100, 200, 300, 400));
    assert.deepEqual(readingOrder(tier, { dir: "rtl" }), [0, 2, 1], "band sort");
    assert.deepEqual(manga(tier), [0, 1, 2]);
    assert.deepEqual(xyCut(tier, "ltr"), [2, 0, 1], "ltr reads the left panel first");
  });

  test("a right panel's bubble placed lower than the left one's still comes first", () => {
    const tier = items(b(100, 50, 300, 200), b(800, 150, 1000, 350));
    assert.deepEqual(readingOrder(tier, { dir: "rtl" }), [0, 1], "band sort: higher first");
    assert.deepEqual(manga(tier), [1, 0]);
  });

  test("a 2×2 page reads row by row, each row right to left", () => {
    const grid = items(
      b(100, 900, 300, 1100),
      b(800, 100, 1000, 300),
      b(800, 900, 1000, 1100),
      b(100, 120, 300, 320),
    );
    assert.deepEqual(manga(grid), [1, 3, 2, 0]);
    assert.deepEqual(xyCut(grid, "ltr"), [3, 1, 0, 2]);
  });

  test("edgeSmall items still come last", () => {
    const list: OrderItem[] = [
      { box: b(590, 1770, 610, 1785), edgeSmall: true },
      { box: b(100, 100, 300, 300) },
      { box: b(800, 100, 1000, 300) },
    ];
    assert.deepEqual(manga(list), [2, 1, 0]);
  });

  test("ltr keeps the Phase 1 band sort", () => {
    assert.deepEqual(orderHooksFor("ltr"), {});
    const hooks = orderHooksFor("rtl");
    assert.equal(typeof hooks.segmenter, "function");
    assert.equal(hooks.leafSorter, cornerSort);
  });
});

describe("gutterCut", () => {
  test("cuts rows at horizontal gaps first, then panels at vertical gaps (reversed for rtl), recursively", () => {
    const list = items(
      b(0, 0, 100, 100), // row 1, left
      b(500, 20, 600, 90), // row 1, right
      b(0, 300, 100, 400), // row 2, left column, top
      b(0, 500, 100, 600), // row 2, left column, bottom
      b(500, 300, 600, 600), // row 2, right column: spans both, so row 2 has no horizontal gap
    );
    assert.deepEqual(gutterCut()(list, "rtl"), [[1], [0], [4], [2], [3]]);
    assert.deepEqual(gutterCut()(list, "ltr"), [[0], [1], [2], [3], [4]]);
  });

  test("overlapping boxes stay in one panel; empty input has no panels", () => {
    const cluster = items(b(0, 0, 300, 300), b(250, 200, 700, 500));
    assert.deepEqual(gutterCut()(cluster, "rtl"), [[0, 1]]);
    assert.deepEqual(gutterCut()([], "rtl"), []);
  });

  test("gaps below the minimum do not cut; maxDepth stops the recursion", () => {
    const close = items(b(0, 0, 100, 100), b(0, 101, 100, 200));
    assert.deepEqual(gutterCut()(close, "rtl"), [[0, 1]], "1 px < minGapPx");
    assert.deepEqual(gutterCut({ minGapPx: 1 })(close, "rtl"), [[0], [1]]);
    const grid = items(b(0, 0, 100, 100), b(200, 0, 300, 100), b(0, 200, 100, 300), b(200, 200, 300, 300));
    assert.deepEqual(gutterCut({ maxDepth: 0 })(grid, "rtl"), [[0, 1, 2, 3]]);
    assert.deepEqual(gutterCut({ maxDepth: 1 })(grid, "rtl"), [
      [0, 1],
      [2, 3],
    ]);
    assert.equal(GUTTER_DEFAULTS.maxDepth, 8);
  });

  test("the minimum gap scales with the items' extent", () => {
    // Extent 10,000 px tall: 0.004 × 10,000 = 40 px; a 30-px gap does not cut, a 50-px gap does.
    const tall = items(b(0, 0, 100, 4000), b(0, 4030, 100, 7000), b(0, 7050, 100, 10000));
    assert.deepEqual(gutterCut()(tall, "rtl"), [[0, 1], [2]]);
  });

  test("axisRuns groups by extent along one axis", () => {
    const list = items(b(0, 0, 10, 10), b(5, 50, 20, 60), b(40, 0, 50, 10));
    assert.deepEqual(axisRuns(list, [0, 1, 2], "x", 2), [[0, 1], [2]]);
    assert.deepEqual(axisRuns(list, [2, 1, 0], "y", 2), [[0, 2], [1]]);
    assert.deepEqual(axisRuns(list, [], "y", 2), []);
    assert.throws(() => axisRuns(list, [7], "y", 2), RangeError);
  });

  test("property: the panels always partition the items", () => {
    let seed = 11;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round++) {
      const list: OrderItem[] = [];
      const n = Math.floor(random() * 25);
      for (let i = 0; i < n; i++) {
        const x = Math.floor(random() * 1100);
        const y = Math.floor(random() * 1700);
        list.push({ box: b(x, y, x + 10 + Math.floor(random() * 300), y + 10 + Math.floor(random() * 300)) });
      }
      for (const dir of ["rtl", "ltr"] as const) {
        const flat = gutterCut()(list, dir).flat();
        assert.deepEqual(
          [...flat].sort((p, q) => p - q),
          list.map((_, i) => i),
          `round ${round}`,
        );
        assert.equal(xyCut(list, dir).length, list.length);
      }
    }
  });
});

describe("cornerSort", () => {
  test("rtl: nearest to the panel's top-right corner first, where the band sort reads top-down", () => {
    // 0 is higher; 1 reaches the right edge. Their projections overlap both ways, so they share a panel.
    const cluster = items(b(0, 0, 300, 300), b(250, 200, 700, 500));
    assert.deepEqual(readingOrder(cluster, { dir: "rtl" }), [0, 1], "band sort");
    assert.deepEqual(cornerSort(cluster, [0, 1], "rtl"), [1, 0]);
    assert.deepEqual(manga(cluster), [1, 0]);
  });

  test("ltr mirrors the rule to the top-left corner", () => {
    const cluster = items(b(400, 0, 700, 300), b(0, 200, 450, 500));
    assert.deepEqual(cornerSort(cluster, [0, 1], "ltr"), [1, 0]);
    assert.deepEqual(cornerSort(cluster, [0, 1], "rtl"), [0, 1]);
  });

  test("ties: the item's own corner, then the input order", () => {
    // All touch the reference corner (distance 0); 1's own top-right corner is the corner itself.
    const cluster = items(b(0, 0, 450, 100), b(400, 0, 500, 300), b(0, 0, 450, 100));
    assert.deepEqual(cornerSort(cluster, [0, 1, 2], "rtl"), [1, 0, 2]);
    assert.deepEqual(cornerSort(cluster, [2], "rtl"), [2]);
    assert.deepEqual(cornerSort(cluster, [], "rtl"), []);
  });
});
