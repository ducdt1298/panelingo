// Minimal ONNX (protobuf) rewriter: drops GraphProto.value_info entries, which are optional shape hints.
//
// Why: detector-v4-s.onnx (fp32, HF commit 5084e7d2) declares value_info for linear_28/43/58 as rank 1
// ([1200*N]) while the MatMul actually produces rank 2, so onnxruntime 1.30 refuses to create a session
// ("[ShapeInferenceError] Mismatch between number of inferred and declared dimensions. inferred=2 declared=1").
// Removing the hints lets ORT infer every shape itself; weights and nodes are copied byte for byte.
//
// Field numbers (onnx.proto3): ModelProto.graph = 7; GraphProto.value_info = 13.

const MODEL_GRAPH = 7;
const GRAPH_VALUE_INFO = 13;
const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

interface RawField {
  field: number;
  wire: number;
  /** Byte range of the whole field (key + length prefix + payload). */
  start: number;
  end: number;
  /** Byte range of the payload (for length-delimited fields). */
  payloadStart: number;
  payloadEnd: number;
}

function readVarint(bytes: Uint8Array, pos: number): [value: number, next: number] {
  let value = 0;
  let multiplier = 1;
  let p = pos;
  for (;;) {
    if (p >= bytes.length) throw new Error(`truncated varint at ${pos}`);
    const byte = bytes[p]!;
    p += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return [value, p];
    multiplier *= 128;
    if (multiplier > 2 ** 63) throw new Error(`varint too long at ${pos}`);
  }
}

function writeVarint(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Uint8Array.from(out);
}

function scanFields(bytes: Uint8Array, start: number, end: number): RawField[] {
  const fields: RawField[] = [];
  let pos = start;
  while (pos < end) {
    const fieldStart = pos;
    const [key, afterKey] = readVarint(bytes, pos);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let payloadStart = afterKey;
    let payloadEnd: number;
    if (wire === WIRE_VARINT) {
      payloadEnd = readVarint(bytes, afterKey)[1];
    } else if (wire === WIRE_LEN) {
      const [length, afterLength] = readVarint(bytes, afterKey);
      payloadStart = afterLength;
      payloadEnd = afterLength + length;
    } else if (wire === WIRE_I64) {
      payloadEnd = afterKey + 8;
    } else if (wire === WIRE_I32) {
      payloadEnd = afterKey + 4;
    } else {
      throw new Error(`unsupported wire type ${wire} at ${fieldStart}`);
    }
    if (payloadEnd > end) throw new Error(`field ${field} overruns its message at ${fieldStart}`);
    fields.push({ field, wire, start: fieldStart, end: payloadEnd, payloadStart, payloadEnd });
    pos = payloadEnd;
  }
  return fields;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface StripResult {
  bytes: Uint8Array;
  removedValueInfo: number;
}

/** Returns a copy of the model without any graph value_info entries. */
export function stripValueInfo(model: Uint8Array): StripResult {
  const top = scanFields(model, 0, model.length);
  const graphFields = top.filter((f) => f.field === MODEL_GRAPH && f.wire === WIRE_LEN);
  if (graphFields.length !== 1) {
    throw new Error(`expected exactly one ModelProto.graph, found ${graphFields.length}`);
  }
  const graph = graphFields[0]!;
  const inner = scanFields(model, graph.payloadStart, graph.payloadEnd);
  const kept = inner.filter((f) => f.field !== GRAPH_VALUE_INFO);
  const graphPayload = concat(kept.map((f) => model.subarray(f.start, f.end)));
  const graphField = concat([
    writeVarint(MODEL_GRAPH * 8 + WIRE_LEN),
    writeVarint(graphPayload.length),
    graphPayload,
  ]);

  const parts: Uint8Array[] = [];
  for (const field of top) {
    parts.push(field === graph ? graphField : model.subarray(field.start, field.end));
  }
  return { bytes: concat(parts), removedValueInfo: inner.length - kept.length };
}

/** Counts of GraphProto fields by number, for diagnostics and tests. */
export function graphFieldCounts(model: Uint8Array): Record<number, number> {
  const graph = scanFields(model, 0, model.length).find(
    (f) => f.field === MODEL_GRAPH && f.wire === WIRE_LEN,
  );
  if (graph === undefined) throw new Error("model has no graph");
  const counts: Record<number, number> = {};
  for (const field of scanFields(model, graph.payloadStart, graph.payloadEnd)) {
    counts[field.field] = (counts[field.field] ?? 0) + 1;
  }
  return counts;
}
