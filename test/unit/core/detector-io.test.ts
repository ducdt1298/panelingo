import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  CANARY_RULE,
  DETECTOR_INPUT,
  DETECTOR_INPUTS,
  DETECTOR_OUTPUTS,
  canaryPasses,
  decodeRawBoxes,
  inputLength,
  inputToSlice,
  matchDetections,
  parseCanaryReference,
  readDetectorOutputs,
  rgbaToNchw,
  sliceToInput,
  stretchFactors,
  targetSizes,
} from "../../../src/shared/core/detector-io.ts";
import type { RawBox } from "../../../src/shared/core/detector-io.ts";

const CANARY_REF = new URL("../../../assets/canary/canary-01.ref-v4s-fp32-wasm.json", import.meta.url);

function outputs(
  rows: RawBox[],
  n = 300,
): { labels: BigInt64Array; boxes: Float32Array; scores: Float32Array } {
  const labels = new BigInt64Array(n);
  const boxes = new Float32Array(4 * n);
  const scores = new Float32Array(n);
  rows.forEach((r, i) => {
    labels[i] = BigInt(r.label);
    scores[i] = r.score;
    boxes.set(r.box, 4 * i);
  });
  return { labels, boxes, scores };
}

const row = (label: number, score: number, x1: number, y1: number, x2: number, y2: number): RawBox => ({
  label,
  score,
  box: [x1, y1, x2, y2],
});

describe("input tensor", () => {
  test("constants match the ONNX graph", () => {
    assert.equal(DETECTOR_INPUT, 640);
    assert.equal(inputLength(), 3 * 640 * 640);
    assert.deepEqual(DETECTOR_INPUTS, { images: "images", sizes: "orig_target_sizes" });
    assert.deepEqual(DETECTOR_OUTPUTS, ["labels", "boxes", "scores"]);
  });

  test("rgbaToNchw writes planar RGB / 255", () => {
    // 2×1: red, then (0, 128, 255).
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 128, 255, 255]);
    const out = rgbaToNchw(rgba, 2, 1);
    assert.deepEqual([...out], [1, 0, 0, 128 / 255, 0, 1].map(Math.fround));
  });

  test("transparent pixels are flattened onto white; the output buffer is reused", () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 51]);
    const out = new Float32Array(6).fill(-1);
    const result = rgbaToNchw(rgba, 2, 1, out);
    assert.equal(result, out);
    const grey = Math.fround((255 * 204) / 65025); // 20% black over white
    assert.deepEqual([...out], [1, grey, 1, grey, 1, grey]);
  });

  test("rgbaToNchw rejects bad sizes and short buffers", () => {
    assert.throws(() => rgbaToNchw(new Uint8ClampedArray(4), 0, 1), RangeError);
    assert.throws(() => rgbaToNchw(new Uint8ClampedArray(4), 2, 1), RangeError);
    assert.throws(() => rgbaToNchw(new Uint8ClampedArray(8), 2, 1, new Float32Array(5)), RangeError);
  });

  test("orig_target_sizes is int64 [W, H]", () => {
    assert.deepEqual([...targetSizes({ w: 800, h: 2400 })], [800n, 2400n]);
    assert.throws(() => targetSizes({ w: 800.5, h: 10 }), RangeError);
    assert.throws(() => targetSizes({ w: 0, h: 10 }), RangeError);
  });

  test("the stretch keeps no aspect ratio and maps boxes both ways", () => {
    const slice = { w: 800, h: 2400 };
    assert.deepEqual(stretchFactors(slice), { sx: 0.8, sy: 640 / 2400 });
    const box = { x1: 100, y1: 600, x2: 500, y2: 1200 };
    const input = sliceToInput(box, slice);
    assert.deepEqual(input, { x1: 80, y1: 160, x2: 400, y2: 320 });
    const back = inputToSlice(input, slice);
    for (const k of ["x1", "y1", "x2", "y2"] as const) assert.ok(Math.abs(back[k] - box[k]) < 1e-9);
  });
});

describe("outputs", () => {
  test("readDetectorOutputs copies the tensors' data", () => {
    const raw = outputs([row(0, 0.9, 1, 2, 3, 4)], 3);
    const read = readDetectorOutputs({
      labels: { data: raw.labels },
      boxes: { data: raw.boxes },
      scores: { data: raw.scores },
    });
    raw.scores[0] = 0;
    raw.boxes[0] = 99;
    assert.equal(read.scores[0], Math.fround(0.9));
    assert.equal(read.boxes[0], 1);
    assert.equal(read.labels.length, 3);
  });

  test("int32 labels are accepted (fixtures)", () => {
    const read = readDetectorOutputs({
      labels: { data: new Int32Array([2]) },
      boxes: { data: new Float32Array(4) },
      scores: { data: new Float32Array(1) },
    });
    assert.equal(read.labels[0], 2);
  });

  test("missing, mistyped or inconsistent outputs throw a TypeError", () => {
    const ok = outputs([], 2);
    assert.throws(() => readDetectorOutputs({ labels: { data: ok.labels }, boxes: { data: ok.boxes } }), {
      name: "TypeError",
      message: /labels, boxes/,
    });
    assert.throws(
      () =>
        readDetectorOutputs({
          labels: { data: [0n, 1n] },
          boxes: { data: ok.boxes },
          scores: { data: ok.scores },
        }),
      TypeError,
    );
    assert.throws(
      () =>
        readDetectorOutputs({
          labels: { data: ok.labels },
          boxes: { data: new Float32Array(4) },
          scores: { data: ok.scores },
        }),
      { name: "TypeError", message: /disagree/ },
    );
  });

  test("decodeRawBoxes keeps rows ≥ scoreMin in order, unclamped", () => {
    const out = outputs([
      row(0, 0.95, -4, 10, 900, 50),
      row(1, 0.3, 1, 2, 3, 4),
      row(2, 0.29, 5, 6, 7, 8),
      row(2, 0.5, 9, 10, 11, 12),
    ]);
    assert.deepEqual(decodeRawBoxes(out, 0.3), [
      row(0, Math.fround(0.95), -4, 10, 900, 50),
      row(1, Math.fround(0.3), 1, 2, 3, 4),
      row(2, Math.fround(0.5), 9, 10, 11, 12),
    ]);
  });
});

describe("canary", () => {
  const reference = parseCanaryReference(JSON.parse(readFileSync(CANARY_REF, "utf8")) as unknown);
  const refRows = reference.detections;

  test("the shipped reference parses (13 detections, scoreMin 0.30, fixed fp32 model)", () => {
    assert.equal(refRows.length, 13);
    assert.equal(reference.scoreMin, 0.3);
    assert.deepEqual(reference.size, { w: 800, h: 1200 });
    assert.equal(reference.modelSha256, "4a01e0bf9c265248f0eeb2f657789ddeaf9ac169d6566ddaf255a0e59afc44fa");
    assert.deepEqual(
      [0, 1, 2].map((label) => refRows.filter((r) => r.label === label).length),
      [6, 6, 1],
    );
  });

  test("malformed references are rejected; missing optional fields default", () => {
    assert.throws(() => parseCanaryReference(null), TypeError);
    assert.throws(() => parseCanaryReference({ detections: [{ label: 0, score: 1, box: [1, 2, 3] }] }), {
      message: /detection 0/,
    });
    assert.throws(() => parseCanaryReference({ detections: [{ label: 0.5, score: 1, box: [1, 2, 3, 4] }] }));
    assert.deepEqual(parseCanaryReference({ detections: [] }), {
      scoreMin: 0.3,
      modelSha256: null,
      size: null,
      detections: [],
    });
  });

  test("identical detections pass with IoU 1", () => {
    const match = matchDetections(refRows, refRows);
    assert.deepEqual(match, { matched: 13, recall: 1, precision: 1, countDiff: 0, meanIou: 1 });
    assert.equal(canaryPasses(match), true);
  });

  test("small shifts still match; a box below IoU 0.9 does not", () => {
    const shifted = refRows.map((r) => ({
      ...r,
      box: [r.box[0] + 1, r.box[1] + 1, r.box[2] + 1, r.box[3] + 1],
    }));
    assert.equal(matchDetections(shifted as RawBox[], refRows).matched, 13);
    const first = refRows[0] as RawBox;
    const moved = { ...first, box: [first.box[0] + 30, first.box[1], first.box[2] + 30, first.box[3]] };
    const match = matchDetections([moved as RawBox, ...refRows.slice(1)], refRows);
    assert.equal(match.matched, 12);
    assert.equal(canaryPasses(match), false, "recall 12/13 < 0.98");
  });

  test("labels must agree", () => {
    const relabelled = refRows.map((r, i) => (i === 0 ? { ...r, label: 2 } : r));
    assert.equal(matchDetections(relabelled, refRows).matched, 12);
  });

  test("one extra box breaks precision 0.95 at 13 references; a missing one breaks recall", () => {
    const extra = [...refRows, row(2, 0.4, 0, 0, 50, 50)];
    const withExtra = matchDetections(extra, refRows);
    assert.deepEqual([withExtra.matched, withExtra.countDiff], [13, 1]);
    assert.ok(withExtra.precision < CANARY_RULE.precisionMin);
    assert.equal(canaryPasses(withExtra), false);
    assert.equal(canaryPasses(matchDetections(refRows.slice(1), refRows)), false);
  });

  test("matching is one-to-one and greedy in reference order", () => {
    const a = row(0, 0.9, 0, 0, 100, 100);
    const b = row(0, 0.9, 1, 1, 101, 101);
    const match = matchDetections([a], [a, b]);
    assert.deepEqual([match.matched, match.recall, match.precision], [1, 0.5, 1]);
    assert.deepEqual(matchDetections([], []), {
      matched: 0,
      recall: 1,
      precision: 1,
      countDiff: 0,
      meanIou: 0,
    });
  });

  test("the pass rule needs all three conditions", () => {
    const base = { matched: 50, recall: 1, precision: 1, countDiff: 0, meanIou: 1 };
    assert.equal(canaryPasses(base), true);
    assert.equal(canaryPasses({ ...base, recall: 0.979 }), false);
    assert.equal(canaryPasses({ ...base, precision: 0.949 }), false);
    assert.equal(canaryPasses({ ...base, countDiff: 2 }), false);
    assert.equal(canaryPasses({ ...base, recall: 0.98, precision: 0.95, countDiff: 1 }), true);
  });
});
