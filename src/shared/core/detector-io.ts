// Detector tensor I/O and the WebGPU canary check. PURE.
//
// The ogkalu RT-DETR export (detector-v4-s) takes `images` float32 [1, 3, 640, 640]: the slice stretched to 640×640
// without keeping its aspect ratio (as in training), planar RGB / 255; and `orig_target_sizes` int64 [1, 2] = [W, H]
// of the slice. The graph scales its boxes back to orig_target_sizes itself, so the outputs (`labels` int64 [1, 300],
// `boxes` float32 [1, 300, 4] xyxy, `scores` float32 [1, 300], sorted by score) are already in slice pixels: there is
// no letterbox to undo, only the slice offset (core/detections decodeDetectorOutput).
//
// The canary decides whether the fp32 WebGPU session can be trusted (otherwise the engine falls back to int8 on
// WASM): one run on assets/canary/canary-01.png is compared with detections recorded from the fp32 model on the WASM
// backend. Greedy one-to-one matching, same label, IoU ≥ 0.9; pass = recall ≥ 0.98, precision ≥ 0.95 and
// |count difference| ≤ 1, on boxes with score ≥ the reference scoreMin (0.30), decoded without clamping as
// recorded.

import type { Box, Size } from "../types.ts";
import type { DetectorOutput } from "./detections.ts";

/** Side of the square detector input. */
export const DETECTOR_INPUT = 640;
/** Input names of the ONNX graph. */
export const DETECTOR_INPUTS = { images: "images", sizes: "orig_target_sizes" } as const;
/** Output names of the ONNX graph. */
export const DETECTOR_OUTPUTS = ["labels", "boxes", "scores"] as const;

/** Float count of one planar RGB input of `side`² pixels. */
export function inputLength(side: number = DETECTOR_INPUT): number {
  return 3 * side * side;
}

/**
 * RGBA pixels (ImageData layout, not premultiplied) → planar RGB / 255 (NCHW without the batch axis). Pixels with
 * alpha < 255 are flattened onto white, like drawing the slice on a white canvas. Writes into `out` when given.
 */
export function rgbaToNchw(rgba: ArrayLike<number>, w: number, h: number, out?: Float32Array): Float32Array {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) {
    throw new RangeError(`rgbaToNchw: size must be positive integers, got ${w}×${h}`);
  }
  const plane = w * h;
  if (rgba.length < 4 * plane) throw new RangeError(`rgbaToNchw: ${rgba.length} values, need ${4 * plane}`);
  const dst = out ?? new Float32Array(3 * plane);
  if (dst.length !== 3 * plane)
    throw new RangeError(`rgbaToNchw: output holds ${dst.length}, need ${3 * plane}`);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    const a = rgba[p + 3] ?? 255;
    if (a >= 255) {
      dst[i] = r / 255;
      dst[plane + i] = g / 255;
      dst[2 * plane + i] = b / 255;
    } else {
      const white = 255 - a;
      dst[i] = (r * a + 255 * white) / 65025;
      dst[plane + i] = (g * a + 255 * white) / 65025;
      dst[2 * plane + i] = (b * a + 255 * white) / 65025;
    }
  }
  return dst;
}

/** `orig_target_sizes` of one slice: [W, H], width first. */
export function targetSizes(size: Size): BigInt64Array {
  if (!(Number.isInteger(size.w) && Number.isInteger(size.h) && size.w > 0 && size.h > 0)) {
    throw new RangeError(`targetSizes: size must be positive integers, got ${size.w}×${size.h}`);
  }
  return BigInt64Array.from([BigInt(size.w), BigInt(size.h)]);
}

/** Input px per slice px on each axis (the stretch keeps no aspect ratio). */
export function stretchFactors(slice: Size, side: number = DETECTOR_INPUT): { sx: number; sy: number } {
  return { sx: side / slice.w, sy: side / slice.h };
}

/** A box in detector-input px (the 640² square) → slice px. */
export function inputToSlice(b: Box, slice: Size, side: number = DETECTOR_INPUT): Box {
  const { sx, sy } = stretchFactors(slice, side);
  return { x1: b.x1 / sx, y1: b.y1 / sy, x2: b.x2 / sx, y2: b.y2 / sy };
}

/** A box in slice px → detector-input px. */
export function sliceToInput(b: Box, slice: Size, side: number = DETECTOR_INPUT): Box {
  const { sx, sy } = stretchFactors(slice, side);
  return { x1: b.x1 * sx, y1: b.y1 * sy, x2: b.x2 * sx, y2: b.y2 * sy };
}

/** What the engine reads from an ORT output tensor. */
export interface TensorLike {
  readonly data: unknown;
}

/**
 * The three output tensors of one run → owned copies (the caller disposes the tensors right after). Throws a
 * TypeError naming what is wrong when the outputs do not have the expected names, types or lengths.
 */
export function readDetectorOutputs(
  outputs: Readonly<Record<string, TensorLike | undefined>>,
): DetectorOutput {
  const labels = outputs[DETECTOR_OUTPUTS[0]]?.data;
  const boxes = outputs[DETECTOR_OUTPUTS[1]]?.data;
  const scores = outputs[DETECTOR_OUTPUTS[2]]?.data;
  if (
    !(labels instanceof BigInt64Array || labels instanceof Int32Array) ||
    !(boxes instanceof Float32Array) ||
    !(scores instanceof Float32Array)
  ) {
    throw new TypeError(`unexpected detector outputs: ${Object.keys(outputs).join(", ") || "none"}`);
  }
  if (labels.length !== scores.length || boxes.length !== 4 * scores.length) {
    throw new TypeError(
      `detector outputs disagree: ${labels.length} labels, ${boxes.length / 4} boxes, ${scores.length} scores`,
    );
  }
  return { labels: labels.slice(), boxes: boxes.slice(), scores: scores.slice() };
}

/** One output row as recorded in the canary reference: label id, score, xyxy in slice px (not clamped). */
export interface RawBox {
  label: number;
  score: number;
  box: [number, number, number, number];
}

/** Rows with score ≥ scoreMin, in output order, without clamping or other post-processing (the canary decode). */
export function decodeRawBoxes(out: DetectorOutput, scoreMin: number): RawBox[] {
  const n = Math.min(out.scores.length, out.labels.length, Math.floor(out.boxes.length / 4));
  const rows: RawBox[] = [];
  for (let i = 0; i < n; i++) {
    const score = out.scores[i] ?? Number.NaN;
    if (!(score >= scoreMin)) continue;
    rows.push({
      label: Number(out.labels[i]),
      score,
      box: [
        out.boxes[4 * i] ?? Number.NaN,
        out.boxes[4 * i + 1] ?? Number.NaN,
        out.boxes[4 * i + 2] ?? Number.NaN,
        out.boxes[4 * i + 3] ?? Number.NaN,
      ],
    });
  }
  return rows;
}

/** assets/canary/*.ref-*.json: the fp32 model's output on the WASM backend, the reference for WebGPU. */
export interface CanaryReference {
  /** Rows below this score were not recorded. */
  scoreMin: number;
  /** sha256 of the model the reference was recorded with, when known. */
  modelSha256: string | null;
  /** Natural size of the canary image, when recorded. */
  size: Size | null;
  detections: RawBox[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validates the canary reference JSON. Throws a TypeError when it is malformed. */
export function parseCanaryReference(json: unknown): CanaryReference {
  if (!isRecord(json) || !Array.isArray(json["detections"])) {
    throw new TypeError("canary reference: no detections array");
  }
  const detections = (json["detections"] as unknown[]).map((row, i): RawBox => {
    const box = isRecord(row) ? row["box"] : undefined;
    if (
      !isRecord(row) ||
      !Number.isInteger(row["label"]) ||
      !finite(row["score"]) ||
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every(finite)
    ) {
      throw new TypeError(`canary reference: malformed detection ${i}`);
    }
    const [x1, y1, x2, y2] = box as [number, number, number, number];
    return { label: row["label"] as number, score: row["score"], box: [x1, y1, x2, y2] };
  });
  const scoreMin = json["scoreMin"];
  const model = json["model"];
  const sha = isRecord(model) ? model["sha256"] : undefined;
  const input = json["input"];
  const w = isRecord(input) ? input["width"] : undefined;
  const h = isRecord(input) ? input["height"] : undefined;
  return {
    scoreMin: finite(scoreMin) ? scoreMin : 0.3,
    modelSha256: typeof sha === "string" ? sha : null,
    size: Number.isInteger(w) && Number.isInteger(h) ? { w: w as number, h: h as number } : null,
    detections,
  };
}

/** Canary pass rule: the WebGPU run must match the reference this closely. */
export const CANARY_RULE = { iouMin: 0.9, recallMin: 0.98, precisionMin: 0.95, countDiffMax: 1 } as const;

export interface CanaryMatch {
  matched: number;
  recall: number;
  precision: number;
  countDiff: number;
  meanIou: number;
}

function rowIou(a: RawBox["box"], b: RawBox["box"]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Greedy one-to-one matching of `test` rows against `reference` rows: each reference row in order
 * takes the unused test row of the same label with the highest IoU, if that IoU ≥ iouMin.
 */
export function matchDetections(
  test: readonly RawBox[],
  reference: readonly RawBox[],
  iouMin: number = CANARY_RULE.iouMin,
): CanaryMatch {
  const used = new Set<number>();
  let matched = 0;
  let iouSum = 0;
  for (const ref of reference) {
    let best = -1;
    let bestIou = 0;
    test.forEach((row, index) => {
      if (used.has(index) || row.label !== ref.label) return;
      const value = rowIou(row.box, ref.box);
      if (value > bestIou) {
        bestIou = value;
        best = index;
      }
    });
    if (best >= 0 && bestIou >= iouMin) {
      used.add(best);
      matched += 1;
      iouSum += bestIou;
    }
  }
  return {
    matched,
    recall: reference.length > 0 ? matched / reference.length : 1,
    precision: test.length > 0 ? matched / test.length : 1,
    countDiff: Math.abs(test.length - reference.length),
    meanIou: matched > 0 ? iouSum / matched : 0,
  };
}

export function canaryPasses(
  match: CanaryMatch,
  rule: { recallMin: number; precisionMin: number; countDiffMax: number } = CANARY_RULE,
): boolean {
  return (
    match.recall >= rule.recallMin &&
    match.precision >= rule.precisionMin &&
    match.countDiff <= rule.countDiffMax
  );
}
