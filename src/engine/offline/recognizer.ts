// PaddleOCR text-line recognition for the offline engine: line images → text. Lines are sorted by width and run in
// batches padded to the widest line of the batch (PaddleOCR's own batching), then decoded with greedy CTC.

import type { ImageDataLike } from "../../shared/gfx.ts";
import {
  REC_HEIGHT,
  batchWidth,
  ctcDecode,
  recWidth,
  writeRecInput,
  type CtcResult,
} from "../../shared/offline/ocr.ts";
import type { OfflineOrt, OfflineSession } from "./ort.ts";
import type { RunSession } from "./seq2seq.ts";

export interface RecModel {
  session: OfflineSession;
  /** character_dict of the model's inference.yml. */
  dict: readonly string[];
}

/** Lines per recognizer run. */
export const REC_BATCH = 6;

export async function recognizeLines(
  ort: OfflineOrt,
  model: RecModel,
  run: RunSession,
  lines: readonly ImageDataLike[],
  batchSize: number = REC_BATCH,
): Promise<CtcResult[]> {
  const results: CtcResult[] = lines.map(() => ({ text: "", confidence: 0 }));
  const order = lines
    .map((line, index) => ({ index, width: recWidth(line.width, line.height) }))
    .sort((a, b) => a.width - b.width);
  const input = model.session.inputNames[0] ?? "x";
  for (let start = 0; start < order.length; start += batchSize) {
    const batch = order.slice(start, start + batchSize);
    const W = batchWidth(Math.max(...batch.map((item) => item.width)));
    const tensor = new Float32Array(batch.length * 3 * REC_HEIGHT * W);
    batch.forEach((item, n) => {
      const line = lines[item.index];
      if (line !== undefined) writeRecInput(line, tensor, n, W);
    });
    const out = await run(model.session, { [input]: ort.float32(tensor, [batch.length, 3, REC_HEIGHT, W]) });
    const output = out[model.session.outputNames[0] ?? ""] ?? Object.values(out)[0];
    if (output === undefined || !(output.data instanceof Float32Array) || output.dims.length !== 3) {
      throw new Error("recognizer: unexpected output");
    }
    const [n, steps, classes] = output.dims as [number, number, number];
    if (n !== batch.length || classes !== model.dict.length + 2) {
      throw new Error(
        `recognizer: output ${n}×${steps}×${classes} for ${batch.length} lines, dict ${model.dict.length}`,
      );
    }
    const data = output.data;
    batch.forEach((item, row) => {
      results[item.index] = ctcDecode(
        data.subarray(row * steps * classes, (row + 1) * steps * classes),
        steps,
        classes,
        model.dict,
      );
    });
    output.dispose?.();
  }
  return results;
}
