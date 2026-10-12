// Minute-scale settings (src/platform/time.ts): one owner for the engine (idle close, detector release) and the
// content script (port idle).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MINUTE_MS, minutesToMs } from "../../../src/platform/time.ts";

test("test builds scale minute settings to seconds (plan §7.2)", () => {
  assert.equal(MINUTE_MS, 1_000);
  assert.equal(minutesToMs(10), 10_000);
  assert.equal(minutesToMs(0.5), 500);
});
