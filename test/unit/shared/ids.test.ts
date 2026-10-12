import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  fnv1a32,
  frameKeyOf,
  isSeamUnitKey,
  newReqId,
  pagePos,
  seamStoreKey,
  seamUnitKey,
  toHex,
  unitKeyOf,
} from "../../../src/shared/ids.ts";

/** Independent reference: FNV-1a 32 over UTF-8 with BigInt arithmetic. */
function referenceFnv(text: string): string {
  let hash = 0x811c9dc5n;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x01000193n) & 0xffffffffn;
  }
  return hash.toString(16).padStart(8, "0");
}

describe("fnv1a32", () => {
  test("matches the published FNV-1a 32-bit vectors", () => {
    assert.equal(fnv1a32(""), "811c9dc5");
    assert.equal(fnv1a32("a"), "e40c292c");
    assert.equal(fnv1a32("foobar"), "bf9cf968");
  });

  test("hashes UTF-8 bytes and always returns 8 lowercase hex digits", () => {
    for (const text of ["오늘은 휴업", "明日の朝", "đã dịch xong", "x".repeat(1000), "\u0000"]) {
      const h = fnv1a32(text);
      assert.match(h, /^[0-9a-f]{8}$/);
      assert.equal(h, referenceFnv(text), text.slice(0, 10));
    }
  });
});

describe("unitKeyOf", () => {
  test("quantizes every coordinate by 4 px", () => {
    assert.equal(unitKeyOf({ x1: 10, y1: 20, x2: 101, y2: 202 }), "3:5:25:51");
    assert.equal(unitKeyOf({ x1: 0, y1: 0, x2: 3.9, y2: 1.9 }), "0:0:1:0");
  });

  test("is stable across re-runs and small jitter, distinct for other boxes", () => {
    const a = { x1: 120.2, y1: 340.7, x2: 300.1, y2: 410.4 };
    assert.equal(unitKeyOf(a), unitKeyOf({ ...a }));
    assert.equal(unitKeyOf(a), "30:85:75:103");
    assert.equal(unitKeyOf(a), unitKeyOf({ x1: 119.5, y1: 341, x2: 301, y2: 410.9 }));
    assert.notEqual(unitKeyOf(a), unitKeyOf({ ...a, y2: a.y2 + 8 }));
  });

  test("never prints negative zero", () => {
    assert.equal(unitKeyOf({ x1: -1, y1: -0.4, x2: 4, y2: 4 }), "0:0:1:1");
  });
});

describe("frame and seam keys", () => {
  test("frameKeyOf joins tab, frame and document", () => {
    assert.equal(frameKeyOf(12, 0, "8F3A"), "12:0:8F3A");
  });

  test("seamUnitKey keeps the first 16 chars of the lower contentKey", () => {
    const upper = `s:${"a".repeat(64)}`;
    const lower = `s:${"0123456789abcdef".repeat(4)}`;
    const key = seamUnitKey(upper, lower, "3:5:25:51");
    assert.equal(key, "seam:s:0123456789abcd:3:5:25:51");
    assert.equal(isSeamUnitKey(key), true);
    assert.equal(isSeamUnitKey("3:5:25:51"), false);
    assert.deepEqual(seamStoreKey(upper, lower, "3:5:25:51"), [upper, key]);
  });

  test("a different lower neighbour gives a different seam key", () => {
    const upper = `s:${"a".repeat(64)}`;
    assert.notEqual(
      seamUnitKey(upper, `s:${"b".repeat(64)}`, "1:1:2:2"),
      seamUnitKey(upper, `s:${"c".repeat(64)}`, "1:1:2:2"),
    );
  });
});

describe("pagePos", () => {
  test("is docOrder * 1000 + order", () => {
    assert.equal(pagePos(0, 0), 0);
    assert.equal(pagePos(3, 7), 3007);
  });

  test("orders every unit of an image before the next image", () => {
    assert.ok(pagePos(4, 999) < pagePos(5, 0));
    assert.equal(pagePos(4, 1500), 4999, "order is clamped to 999");
    assert.equal(pagePos(4, -3), 4000);
  });
});

describe("newReqId", () => {
  test("formats ctx-seq-rand and never repeats", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newReqId("cs", () => 0.5));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, /^cs-[0-9a-z]+-[0-9a-z]{7}$/);
    assert.match(newReqId("en"), /^en-[0-9a-z]+-[0-9a-z]{7}$/, "default random source");
  });
});

test("toHex: lowercase, two digits per byte, from a Uint8Array view or an ArrayBuffer", () => {
  assert.equal(toHex(new Uint8Array([0, 1, 15, 16, 171, 255])), "00010f10abff");
  assert.equal(toHex(new Uint8Array([222, 173, 190, 239]).buffer), "deadbeef");
  assert.equal(
    toHex(new Uint8Array([9, 8, 7, 6]).subarray(1, 3)),
    "0807",
    "only the view, not the whole buffer",
  );
  assert.equal(toHex(new ArrayBuffer(0)), "");
});
