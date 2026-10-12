import assert from "node:assert/strict";
import { test } from "node:test";
import { graphFieldCounts, stripValueInfo } from "../../../scripts/lib/onnx-strip.ts";

// Tiny protobuf encoder for building synthetic ONNX-shaped messages.
function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}
const lenField = (field: number, payload: number[]): number[] => [
  ...varint(field * 8 + 2),
  ...varint(payload.length),
  ...payload,
];
const varintField = (field: number, value: number): number[] => [...varint(field * 8), ...varint(value)];
const text = (s: string): number[] => [...new TextEncoder().encode(s)];
const filler = (n: number, seed: number): number[] =>
  Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);

function model(graphParts: number[][]): Uint8Array {
  return Uint8Array.from([
    ...varintField(1, 8), // ir_version
    ...lenField(8, [...varintField(2, 18)]), // opset_import { version: 18 }
    ...lenField(7, graphParts.flat()), // graph
    ...lenField(2, text("pytorch")), // producer_name after the graph
  ]);
}

const node = lenField(1, [...lenField(3, text("node_Conv_0")), ...filler(40, 1)]);
const initializer = lenField(5, filler(300, 7)); // > 127 bytes: multi-byte length prefix
const output = lenField(12, lenField(1, text("scores")));
const valueInfoA = lenField(13, [...lenField(1, text("linear_28")), ...filler(20, 3)]);
const valueInfoB = lenField(13, [...lenField(1, text("relu")), ...filler(200, 5)]);

test("removes every value_info entry and keeps all other graph fields byte for byte", () => {
  const input = model([node, valueInfoA, initializer, valueInfoB, output]);
  const { bytes, removedValueInfo } = stripValueInfo(input);
  assert.equal(removedValueInfo, 2);
  assert.deepEqual(bytes, model([node, initializer, output]));
  assert.deepEqual(graphFieldCounts(input), { 1: 1, 5: 1, 12: 1, 13: 2 });
  assert.deepEqual(graphFieldCounts(bytes), { 1: 1, 5: 1, 12: 1 });
});

test("is a no-op (byte identical) when there is no value_info", () => {
  const input = model([node, initializer, output]);
  const { bytes, removedValueInfo } = stripValueInfo(input);
  assert.equal(removedValueInfo, 0);
  assert.deepEqual(bytes, input);
});

test("re-encodes a graph whose length shrinks across a varint boundary", () => {
  // 200-byte graph payload (2-byte length) shrinking to < 128 bytes (1-byte length).
  const small = lenField(1, filler(30, 9));
  const big = lenField(13, filler(170, 2));
  const { bytes } = stripValueInfo(model([small, big]));
  assert.deepEqual(bytes, model([small]));
});

test("rejects input without a graph", () => {
  assert.throws(() => stripValueInfo(Uint8Array.from(varintField(1, 8))), /exactly one ModelProto.graph/);
});

test("rejects truncated messages", () => {
  const input = model([node, valueInfoA]);
  assert.throws(() => stripValueInfo(input.subarray(0, input.length - 5)), /overruns|truncated/);
});
