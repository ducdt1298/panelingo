import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planSlices } from "../../../src/shared/core/slicer.ts";
import type { Box, Detection } from "../../../src/shared/types.ts";
import {
  cer,
  coveredFraction,
  detectorRecall,
  graphemes,
  greedyMatch,
  kendallTau,
  levenshtein,
  matchUnits,
  normalizeForCer,
  parseGtUnits,
  parseRecordLine,
  readingOrderTau,
  sliceCutHits,
  textScores,
  toBox,
  unionCoverArea,
} from "../../../tools/scoring/score-core.ts";
import type { GtUnitInput, SentUnit } from "../../../tools/scoring/score-core.ts";

const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });

describe("text metrics", () => {
  test("graphemes keep syllables and combining marks whole", () => {
    assert.deepEqual(graphemes("한국어 ế"), ["한", "국", "어", " ", "ế"]);
    assert.equal(graphemes("ế").length, 1);
  });

  test("normalisation drops spaces and punctuation and folds case", () => {
    assert.equal(normalizeForCer("Hello, World!"), "helloworld");
    assert.equal(normalizeForCer("朝の七時、駅で。"), "朝の七時駅で");
    assert.equal(normalizeForCer("ＡＢＣ"), "ａｂｃ");
    assert.equal(normalizeForCer("ＡＢＣ", { form: "NFKC" }), "abc");
    assert.equal(normalizeForCer("A b!", { stripSpace: false, stripPunct: false, caseFold: false }), "A b!");
  });

  test("levenshtein", () => {
    assert.equal(levenshtein([..."kitten"], [..."sitting"]), 3);
    assert.equal(levenshtein([], [..."abc"]), 3);
    assert.equal(levenshtein([..."abc"], []), 3);
    assert.equal(levenshtein([..."same"], [..."same"]), 0);
  });

  test("cer over normalised graphemes", () => {
    assert.equal(cer("abcd", "abcd"), 0);
    assert.equal(cer("abed", "abcd"), 0.25);
    assert.equal(cer("ABCD!", "abcd"), 0);
    assert.equal(cer("조르빅 상점", "조르빅 상점은"), 1 / 6);
    assert.equal(cer("가", "가"), 0, "NFC composes jamo");
    assert.equal(cer("", ""), 0);
    assert.equal(cer("x", ""), 1);
    assert.equal(cer("", "abc"), 1);
    assert.equal(cer("abcdef", "ab"), 2, "can exceed 1");
  });

  test("kendall tau", () => {
    assert.equal(kendallTau([1, 2, 3, 4], [1, 2, 3, 4]), 1);
    assert.equal(kendallTau([1, 2, 3, 4], [4, 3, 2, 1]), -1);
    assert.equal(kendallTau([1, 2, 3, 4], [2, 1, 3, 4]), 4 / 6);
    assert.equal(kendallTau([1, 2, 3, 9], [3, 2, 1, 8]), -1, "only common ids count");
    assert.equal(kendallTau([1], [1]), 1);
    assert.equal(kendallTau(["a", "a", "b"], ["a", "b"]), 1, "repeats are ignored");
  });
});

describe("box helpers", () => {
  test("toBox accepts objects and [x1, y1, x2, y2] arrays", () => {
    assert.deepEqual(toBox([1, 2, 3, 4]), b(1, 2, 3, 4));
    assert.deepEqual(toBox(b(1, 2, 3, 4)), b(1, 2, 3, 4));
    assert.throws(() => toBox([1, 2, 3]), RangeError);
  });

  test("coverage counts overlapping covers once", () => {
    const target = [b(0, 0, 10, 10)];
    assert.equal(coveredFraction(target, [b(0, 0, 6, 10), b(4, 0, 10, 10)]), 1);
    assert.equal(coveredFraction(target, [b(0, 0, 5, 10)]), 0.5);
    assert.equal(coveredFraction(target, [b(20, 20, 30, 30)]), 0);
    assert.equal(unionCoverArea([b(0, 0, 10, 10), b(5, 0, 15, 10)], null), 150);
    assert.equal(coveredFraction([b(0, 0, 0, 10)], [b(0, 0, 10, 10)]), 0, "empty target");
  });

  test("greedyMatch is one-to-one, best score first", () => {
    const scores = [
      [0.9, 0.8],
      [0.85, null],
    ];
    const pairs = greedyMatch(2, 2, (g, p) => scores[g]?.[p] ?? null);
    assert.deepEqual(pairs, [{ gt: 0, pred: 0, score: 0.9 }]);
  });
});

describe("output format", () => {
  test("well-formed records", () => {
    assert.deepEqual(parseRecordLine("#1|dialogue|cô gái|조르빅 상점|Tiệm Zorvik"), {
      kind: "item",
      n: 1,
      type: "dialogue",
      speaker: "cô gái",
      original: "조르빅 상점",
      translation: "Tiệm Zorvik",
    });
    assert.equal(parseRecordLine("  #12|sfx||쾅!|RẦM!  ")?.kind, "item");
    assert.deepEqual(parseRecordLine("#3|ignore|||"), {
      kind: "item",
      n: 3,
      type: "ignore",
      speaker: "",
      original: "",
      translation: "",
    });
    assert.deepEqual(parseRecordLine("#4|sign|a|b|c|d"), {
      kind: "item",
      n: 4,
      type: "sign",
      speaker: "a",
      original: "b",
      translation: "c|d",
    });
    assert.deepEqual(parseRecordLine("@lang|ko"), { kind: "lang", lang: "ko" });
    assert.deepEqual(parseRecordLine("@term|조르빅|Zorvik|tên tiệm"), {
      kind: "term",
      original: "조르빅",
      translation: "Zorvik",
      note: "tên tiệm",
    });
    assert.equal(parseRecordLine("@term|조르빅|Zorvik")?.kind, "term");
    assert.deepEqual(parseRecordLine("@sum|Hai người hẹn ở tiệm."), {
      kind: "sum",
      text: "Hai người hẹn ở tiệm.",
    });
  });

  test("anything else is not a record", () => {
    for (const line of [
      "```",
      "Here is the translation:",
      "- #1|dialogue|a|b|c",
      "#1|speech|a|b|c",
      "#1|dialogue|a|b",
      "#x|dialogue|a|b|c",
      "@lang|Korean",
      "@term||x|y",
      "@sum|",
    ]) {
      assert.equal(parseRecordLine(line), null, line);
    }
  });
});

describe("textScores", () => {
  const sent: SentUnit[] = [
    { n: 1, original: "조르빅 상점은 아홉 시에 문을 연다." },
    { n: 2, original: "우산을 두고 왔어!" },
    { n: 3, original: "벌써 다섯 번째야…" },
    { n: 4, original: "example.invalid", type: "ignore" },
  ];

  test("format, coverage, duplicates, extras and swapped lines", () => {
    const output = [
      "@lang|ko",
      "#1|dialogue|cô gái|조르빅 상점은 아홉 시에 문을 연다.|Tiệm Zorvik mở cửa lúc chín giờ.",
      "",
      "#3|thought||우산을 두고 왔어!|Mình để quên ô rồi!",
      "#2|dialogue||벌써 다섯 번째야…|Đã lần thứ năm rồi…",
      "#2|dialogue||lặp lại|lặp lại",
      "#9|dialogue||thêm|thêm",
      "#4|ignore|||",
      "Here you go!",
    ].join("\r\n");
    const s = textScores(output, sent);
    assert.equal(s.lines, 8);
    assert.equal(s.validLines, 7);
    assert.equal(s.formatCompliance, 7 / 8);
    assert.equal(s.lang, "ko");
    assert.deepEqual(s.returnedIds, [1, 3, 2, 9, 4]);
    assert.equal(s.idCoverage, 1);
    assert.deepEqual(s.missingIds, []);
    assert.deepEqual(s.extraIds, [9]);
    assert.deepEqual(s.duplicateIds, [2]);
    assert.equal(s.mapped, 4);
    assert.equal(s.mappedOk, 2);
    assert.equal(s.mappingAccuracy, 0.5);
    assert.deepEqual(s.swappedIds, [3, 2]);
    assert.deepEqual(
      s.perId.map((p) => [p.n, p.ok, p.bestN]),
      [
        [1, true, 1],
        [3, false, 2],
        [2, false, 3],
        [4, true, 4],
      ],
    );
    assert.ok(s.meanCer > 0.3);
  });

  test("small OCR slips still map; missing ids lower the coverage", () => {
    const output = "@lang|ko\n#1|dialogue||조르빅 상점은 아홉 시에 문을 연디|Tiệm Zorvik mở lúc chín giờ.\n";
    const s = textScores(output, sent);
    assert.equal(s.formatCompliance, 1);
    assert.equal(s.idCoverage, 1 / 4);
    assert.deepEqual(s.missingIds, [2, 3, 4]);
    assert.equal(s.mappingAccuracy, 1);
    assert.equal(s.perId[0]?.cer, 1 / 14);
  });

  test("the argmin rule flags a line that matches another unit better", () => {
    const close: SentUnit[] = [
      { n: 1, original: "가나다라마바" },
      { n: 2, original: "가나다라마사" },
    ];
    const output = "#1|dialogue||가나다라마사|x\n#2|dialogue||가나다라마사|y";
    assert.equal(textScores(output, close).mappingAccuracy, 0.5);
    assert.deepEqual(textScores(output, close).swappedIds, [1]);
    assert.equal(textScores(output, close, { requireArgmin: false }).mappingAccuracy, 1);
    assert.equal(textScores(output, close, { maxCer: 0.1, requireArgmin: false }).mappingAccuracy, 0.5);
  });

  test("empty replies", () => {
    const none = textScores("", sent);
    assert.equal(none.formatCompliance, 0);
    assert.equal(none.idCoverage, 0);
    assert.equal(none.mappingAccuracy, 0);
    const nothingSent = textScores("", []);
    assert.equal(nothingSent.idCoverage, 1);
    assert.equal(nothingSent.mappingAccuracy, 1);
  });
});

describe("matchUnits", () => {
  const gt: GtUnitInput[] = [
    { id: 1, kind: "bubble", bubble: [100, 100, 500, 400], text: [150, 150, 450, 350], order: 0 },
    { id: 2, kind: "free", bubble: null, text: b(600, 1000, 900, 1100), order: 1 },
    { id: 3, kind: "bubble", bubble: b(100, 1300, 400, 1600), text: b(150, 1350, 350, 1550), order: 2 },
  ];

  test("bubble IoU, text containment, the inside guard and one-to-one matching", () => {
    const predicted = [
      { bubble: b(105, 95, 505, 410), text: b(160, 160, 440, 340) },
      { bubble: null, text: b(590, 990, 910, 1110) },
      b(0, 0, 1200, 1800), // one huge box covers everything but claims nothing
      { bubble: null, text: b(1000, 100, 1100, 150) },
    ];
    const r = matchUnits(predicted, gt);
    assert.deepEqual(
      r.matches.map((m) => [m.gtId, m.predIndex, m.by]),
      [
        [2, 1, "text"],
        [1, 0, "bubble"],
      ],
    );
    assert.deepEqual(r.recallByClass, { bubble: 0.5, free: 1, all: 2 / 3 });
    assert.deepEqual(r.tally.all, { gt: 3, matched: 2, recall: 2 / 3 });
    assert.equal(r.precision, 0.5);
    assert.deepEqual(r.unmatched, { gt: [3], pred: [2, 3] });
  });

  test("bare boxes match by bubble IoU", () => {
    const r = matchUnits([b(110, 1310, 400, 1600)], gt);
    assert.deepEqual(
      r.matches.map((m) => [m.gtId, m.by]),
      [[3, "bubble"]],
    );
  });

  test("the text containment threshold is a rule", () => {
    const partial = [{ bubble: null, text: b(600, 1000, 810, 1100) }]; // covers 70% of the free text
    assert.equal(matchUnits(partial, gt).matches.length, 1);
    assert.equal(matchUnits(partial, gt, { textContain: 0.8 }).matches.length, 0);
  });

  test("two predictions for one unit: only the best counts", () => {
    const r = matchUnits([b(100, 100, 500, 400), b(120, 120, 480, 380)], gt);
    assert.deepEqual(
      r.matches.map((m) => m.predIndex),
      [0],
    );
    assert.equal(r.precision, 0.5);
  });

  test("empty inputs", () => {
    assert.equal(matchUnits([], []).precision, 1);
    assert.deepEqual(matchUnits([], gt).recallByClass, { bubble: 0, free: 0, all: 0 });
  });

  test("readingOrderTau compares the predicted order with the GT order", () => {
    const inOrder = [
      { bubble: b(100, 100, 500, 400), text: b(150, 150, 450, 350), order: 0 },
      { bubble: null, text: b(600, 1000, 900, 1100), order: 1 },
      { bubble: b(100, 1300, 400, 1600), text: b(150, 1350, 350, 1550), order: 2 },
    ];
    assert.deepEqual(readingOrderTau(inOrder, gt), { tau: 1, matched: 3 });
    const reversed = inOrder.map((u, i) => ({ ...u, order: 2 - i }));
    assert.deepEqual(readingOrderTau(reversed, gt), { tau: -1, matched: 3 });
    assert.equal(
      readingOrderTau(
        [...inOrder].reverse().map((u) => b(u.text.x1, u.text.y1, u.text.x2, u.text.y2)),
        gt,
      ).tau,
      -1,
    );
  });
});

describe("detectorRecall", () => {
  const gt: GtUnitInput[] = [
    { id: 1, kind: "bubble", bubble: b(100, 100, 500, 400), text: b(150, 150, 450, 350) },
    {
      id: 2,
      kind: "free",
      bubble: null,
      text: b(600, 1000, 900, 1090),
      texts: [b(600, 1000, 900, 1040), b(600, 1050, 900, 1090)],
    },
    { id: 3, kind: "bubble", bubble: b(100, 1300, 400, 1600), text: b(150, 1350, 350, 1550) },
  ];
  const dets: Detection[] = [
    { cls: "bubble", box: b(110, 110, 500, 400), score: 0.9 }, // IoU 0.94 with GT 1
    { cls: "bubble", box: b(250, 1300, 550, 1600), score: 0.8 }, // IoU 0.33 with GT 3: miss
    { cls: "bubble", box: b(800, 100, 900, 200), score: 0.5 }, // false positive
    { cls: "text_bubble", box: b(150, 150, 450, 350), score: 0.9 },
    { cls: "text_bubble", box: b(150, 1350, 350, 1480), score: 0.7 }, // IoU 0.65, covers 65%
    { cls: "text_free", box: b(600, 1000, 900, 1040), score: 0.6 }, // first narration line only
  ];

  test("per-class IoU matching against each unit's text box, pooled text and unit recall", () => {
    const s = detectorRecall(dets, gt);
    assert.deepEqual(
      [s.bubble.gt, s.bubble.pred, s.bubble.matched, s.bubble.recall, s.bubble.precision],
      [2, 3, 1, 0.5, 1 / 3],
    );
    assert.ok(Math.abs(s.bubble.meanIou - (390 * 290) / (400 * 300)) < 1e-12);
    assert.deepEqual([s.text_bubble.gt, s.text_bubble.matched, s.text_bubble.recall], [2, 2, 1]);
    // The first narration line overlaps the whole two-line block at IoU 40 / 90.
    assert.deepEqual([s.text_free.gt, s.text_free.matched, s.text_free.recall], [1, 1, 1]);
    assert.deepEqual(
      [s.text.gt, s.text.pred, s.text.matched, s.text.recall, s.text.precision],
      [3, 3, 3, 1, 1],
    );
    // Unit recall uses the line boxes: one of two narration lines is half the narration.
    assert.deepEqual(s.units, { gt: 3, found: 2, recall: 2 / 3 });
  });

  test('textGt "lines" matches every line box of the GT instead', () => {
    const s = detectorRecall(dets, gt, { textGt: "lines" });
    assert.deepEqual([s.text_bubble.gt, s.text_bubble.matched, s.text_bubble.recall], [2, 2, 1]);
    assert.deepEqual([s.text_free.gt, s.text_free.matched, s.text_free.recall], [2, 1, 0.5]);
    assert.deepEqual(
      [s.text.gt, s.text.pred, s.text.matched, s.text.recall, s.text.precision],
      [4, 3, 3, 0.75, 1],
    );
  });

  test("a block-level detection of a multi-line bubble is found (regression: per-line GT gave recall 0)", () => {
    // The generated fixtures write one `texts` box per rendered line; the detector boxes the whole block.
    const lines = [b(150, 150, 450, 180), b(150, 192, 450, 222), b(150, 234, 450, 264)];
    const threeLines: GtUnitInput[] = [
      { id: 1, kind: "bubble", bubble: b(100, 100, 500, 320), text: b(150, 150, 450, 264), texts: lines },
    ];
    const block: Detection[] = [
      { cls: "bubble", box: b(100, 100, 500, 320), score: 0.9 },
      { cls: "text_bubble", box: b(145, 145, 455, 270), score: 0.9 },
    ];
    const s = detectorRecall(block, threeLines);
    assert.deepEqual([s.text_bubble.gt, s.text_bubble.matched, s.text_bubble.recall], [1, 1, 1]);
    assert.equal(s.text.recall, 1);
    assert.equal(s.units.recall, 1);
    assert.equal(detectorRecall(block, threeLines, { textGt: "lines" }).text_bubble.recall, 0);
  });

  test("thresholds are options", () => {
    const strict = detectorRecall(dets, gt, { textIou: 0.7, unitContain: 0.5 });
    assert.equal(strict.text_bubble.matched, 1);
    assert.equal(strict.units.found, 3);
  });
});

describe("sliceCutHits", () => {
  test("counts slice edges that cut through boxes", () => {
    const plan = planSlices({ w: 800, h: 7680 }); // edges at 1760, 2400, 3520, 4160, 5280, 5920
    const boxes = [b(0, 1700, 100, 1800), b(0, 2300, 100, 2500), b(0, 100, 100, 200), b(0, 1700, 100, 2500)];
    assert.deepEqual(sliceCutHits(plan, boxes), { edges: 6, cutEdges: 2, hits: 4 });
    assert.deepEqual(sliceCutHits(planSlices({ w: 800, h: 1000 }), boxes), {
      edges: 0,
      cutEdges: 0,
      hits: 0,
    });
  });
});

describe("parseGtUnits", () => {
  test("reads the unit schema with array or object boxes", () => {
    const units = parseGtUnits({
      units: [
        {
          id: "u1",
          kind: "bubble",
          bubble: [100, 100, 500, 400],
          text: [150, 150, 450, 350],
          texts: [
            [150, 150, 450, 240],
            [150, 260, 450, 350],
          ],
          order: 2,
          type: "dialogue",
          original: "조르빅 상점",
        },
        {
          id: "u2",
          kind: "free",
          bubble: null,
          texts: [{ x1: 0, y1: 0, x2: 10, y2: 10 }],
          order: 1,
          lines: ["a", "b"],
        },
        { id: "broken" },
      ],
    });
    assert.equal(units.length, 2);
    assert.deepEqual(units[0], {
      id: "u1",
      kind: "bubble",
      bubble: b(100, 100, 500, 400),
      text: b(150, 150, 450, 350),
      texts: [b(150, 150, 450, 240), b(150, 260, 450, 350)],
      order: 2,
      type: "dialogue",
      original: "조르빅 상점",
    });
    assert.deepEqual(units[1], {
      id: "u2",
      kind: "free",
      bubble: null,
      text: b(0, 0, 10, 10),
      texts: [b(0, 0, 10, 10)],
      order: 1,
      original: "a b",
    });
  });

  test("reads the bubbles + texts fixture schema", () => {
    const units = parseGtUnits({
      schema: "comic-fixture/1",
      bubbles: [{ id: "b1", box: [100, 100, 500, 400] }],
      texts: [
        { id: 2, order: 2, bubbleId: "b1", type: "dialogue", text: "둘째 줄", inkBox: [150, 260, 450, 350] },
        { id: 1, order: 1, bubbleId: "b1", type: "dialogue", text: "첫째 줄", inkBox: [150, 150, 450, 240] },
        { id: 3, order: 0, bubbleId: null, type: "narration", text: "사흘 뒤", inkBox: [600, 50, 800, 90] },
      ],
    });
    assert.deepEqual(units, [
      {
        id: 3,
        kind: "free",
        bubble: null,
        text: b(600, 50, 800, 90),
        texts: [b(600, 50, 800, 90)],
        order: 0,
        type: "narration",
        original: "사흘 뒤",
      },
      {
        id: "b1",
        kind: "bubble",
        bubble: b(100, 100, 500, 400),
        text: b(150, 150, 450, 350),
        texts: [b(150, 150, 450, 240), b(150, 260, 450, 350)],
        order: 1,
        type: "dialogue",
        original: "첫째 줄 둘째 줄",
      },
    ]);
  });

  test("rejects documents without units", () => {
    assert.throws(() => parseGtUnits(null), TypeError);
    assert.throws(() => parseGtUnits({ pages: [] }), TypeError);
  });
});
