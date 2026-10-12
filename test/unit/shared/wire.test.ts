import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WIRE_HARD_LIMIT,
  WIRE_HARD_LIMIT_B64,
  codecFromProbe,
  decodeBytes,
  encodeBytes,
  estimateWireBytes,
  fromBase64,
  hardLimitFor,
  isBytes,
  isProbe,
  isWireSafe,
  makeProbe,
  toBase64,
} from "../../../src/shared/wire.ts";

test("probe survives only as the exact ArrayBuffer", () => {
  assert.equal(isProbe(makeProbe()), true);
  assert.equal(isProbe({}), false, "JSON turns an ArrayBuffer into {}");
  assert.equal(isProbe(new Uint8Array([0xc7, 0x7e, 0x01])), false, "a view is not the buffer");
  assert.equal(isProbe(new Uint8Array([1, 2, 3]).buffer), false);
  assert.equal(codecFromProbe(makeProbe()), "sc");
  assert.equal(codecFromProbe({}), "b64");
});

test("base64 matches Node's encoder for every length 0..64 and random bytes", () => {
  for (let length = 0; length <= 64; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + length * 13) % 256);
    const expected = Buffer.from(bytes).toString("base64");
    assert.equal(toBase64(bytes), expected, `length ${length}`);
    assert.deepEqual(Array.from(fromBase64(expected)), Array.from(bytes), `decode length ${length}`);
  }
});

test("fromBase64 rejects invalid input", () => {
  assert.throws(() => fromBase64("abcde"), /length/);
  assert.throws(() => fromBase64("ab*d"), /invalid base64 character/);
});

test("encodeBytes / decodeBytes round trip under both codecs", () => {
  const buffer = Uint8Array.from([0, 1, 2, 250, 255]).buffer;
  const sc = encodeBytes(buffer, "sc");
  assert.equal(sc, buffer);
  const b64 = encodeBytes(buffer, "b64");
  assert.deepEqual(b64, { b64: "AAEC+v8=" });
  assert.deepEqual(Array.from(new Uint8Array(decodeBytes(b64))), [0, 1, 2, 250, 255]);
  assert.equal(decodeBytes(sc), buffer);
  assert.equal(isBytes(sc), true);
  assert.equal(isBytes(b64), true);
  assert.equal(isBytes({ b64: "x", extra: 1 }), false);
});

test("wire-safe = JSON values plus ArrayBuffer", () => {
  assert.deepEqual(isWireSafe({ a: [1, "x", true, null, { b: new ArrayBuffer(2) }] }), { ok: true });
  assert.deepEqual(isWireSafe({ a: undefined }), { ok: false, path: "$.a", why: "undefined" });
  assert.deepEqual(isWireSafe({ m: new Map() }), { ok: false, path: "$.m", why: "[object Map]" });
  assert.deepEqual(isWireSafe([1, 2n]), { ok: false, path: "$[1]", why: "bigint" });
  assert.deepEqual(isWireSafe({ d: new Date(0) }), { ok: false, path: "$.d", why: "[object Date]" });
  assert.deepEqual(isWireSafe({ n: Number.NaN }), { ok: false, path: "$.n", why: "non-finite number" });
  assert.deepEqual(isWireSafe({ u: new Uint8Array(2) }), {
    ok: false,
    path: "$.u",
    why: "[object Uint8Array]",
  });
});

test("estimateWireBytes counts binary payloads (x4/3 under base64)", () => {
  const msg = { type: "img:unit", png: new ArrayBuffer(3000) };
  const sc = estimateWireBytes(msg, "sc");
  const b64 = estimateWireBytes(msg, "b64");
  assert.ok(sc >= 3000 && sc < 3100, String(sc));
  assert.ok(b64 >= 4000 && b64 < 4100, String(b64));
  assert.equal(hardLimitFor("sc"), WIRE_HARD_LIMIT);
  assert.equal(hardLimitFor("b64"), WIRE_HARD_LIMIT_B64);
});
