// tools/offline-eval scoring: chrF, the reference lookup through the parallel sentence files, and the pairing of
// ground-truth units with engine units (OCR CER, undetected units, translations vs references).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chrF,
  lineKey,
  markdownTable,
  scoreUnits,
  sentenceId,
  type EngineUnit,
  type GroundTruthUnit,
} from "../../../tools/offline-eval/metrics.ts";

test("chrF: 100 for a match (case and spaces ignored), 0 for nothing in common, partial in between", () => {
  assert.equal(chrF("See you at seven.", "SEE YOU AT SEVEN."), 100);
  assert.equal(chrF("xyz", "abc"), 0);
  assert.equal(chrF("", "abc"), 0);
  assert.equal(chrF("", ""), 100);
  const partial = chrF("See you at seven.", "SEE YOU IN FRONT OF THE STATION AT SEVEN.");
  assert.ok(partial > 20 && partial < 80, String(partial));
  assert.ok(chrF("The next morning.", "THE NEXT MORNING") > chrF("Next morning.", "THE NEXT MORNING"));
});

test("sentence ids match ground-truth originals whose lines were joined with spaces", () => {
  const lines = [
    { id: "d01", text: "七時に駅の前で会おう。" },
    { id: "d02", text: "この地図、町の半分しか載ってないよ！" },
  ];
  assert.equal(sentenceId("七時に駅の前 で会おう。", lines), "d01");
  assert.equal(sentenceId("unknown", lines), null);
  assert.equal(lineKey(" ａ b "), "ab");
});

test("scoreUnits pairs units by geometry: CER, undetected units at CER 1, chrF of ok translations", () => {
  const gt: GroundTruthUnit[] = [
    {
      id: 1,
      kind: "bubble",
      type: "dialogue",
      bubble: { x1: 0, y1: 0, x2: 100, y2: 60 },
      text: { x1: 10, y1: 10, x2: 90, y2: 50 },
      original: "다음 날 아침",
      vi: "Sáng hôm sau",
    },
    {
      id: 2,
      kind: "free",
      type: "sfx",
      bubble: null,
      text: { x1: 300, y1: 300, x2: 360, y2: 360 },
      original: "쾅!",
      vi: "ẦM!",
    },
    {
      id: 3,
      kind: "free",
      type: "ignore",
      bubble: null,
      text: { x1: 500, y1: 500, x2: 520, y2: 510 },
      original: "12",
      vi: null,
    },
  ];
  const engine: EngineUnit[] = [
    {
      geometry: {
        unitKey: "a",
        bubble: { x1: 1, y1: 1, x2: 99, y2: 59 },
        text: { x1: 12, y1: 12, x2: 88, y2: 48 },
        order: 0,
      },
      status: "ok",
      type: "dialogue",
      original: "다음 날 아칩",
      translation: "Sáng hôm sau",
      model: "offline:nllb-200-distilled-600m",
    },
  ];
  const rows = scoreUnits(gt, engine, (unit) => unit.vi);
  assert.equal(rows.length, 2, "page numbers are not scored");
  assert.equal(rows[0]?.ocr, "다음 날 아칩");
  assert.ok(Math.abs((rows[0]?.cer ?? 0) - 1 / 5) < 1e-9, String(rows[0]?.cer));
  assert.equal(rows[0]?.chrF, 100);
  assert.deepEqual([rows[1]?.ocr, rows[1]?.cer, rows[1]?.chrF], [null, 1, null]);
});

test("markdownTable escapes pipes", () => {
  assert.equal(markdownTable(["a", "b"], [["x|y", "z"]]), "| a | b |\n| --- | --- |\n| x\\|y | z |");
});
