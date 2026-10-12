// Daily upload counter in kv "uploads.daily" (local day, reset at midnight).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServiceFactories } from "../../../src/engine/contracts.ts";
import { createUploads, localDay } from "../../../src/engine/uploads.ts";
import { createSettingsCache } from "../../../src/engine/settings-cache.ts";
import { captureLogger, ManualClock, memoryStores } from "./store/engine-fakes.ts";

function deps(clock: ManualClock, stores = memoryStores()) {
  return { clock, log: captureLogger().log, settings: createSettingsCache({ clock }), stores };
}

function nextMidnight(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

test("localDay formats the local calendar day", () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59).getTime()), "2026-01-05");
  assert.equal(localDay(new Date(2026, 11, 31, 0, 0).getTime()), "2026-12-31");
});

test("record() counts composites and bytes and persists them under the local day", async () => {
  const clock = new ManualClock();
  const d = deps(clock);
  const uploads = createUploads(d);
  assert.deepEqual(uploads.today(), { today: 0, bytesToday: 0 });
  uploads.record(1_200_000);
  uploads.record(800_000.4);
  uploads.record(Number.NaN);
  assert.deepEqual(uploads.today(), { today: 3, bytesToday: 2_000_000 });
  await uploads.settled();
  assert.deepEqual(await d.stores.kv.get("uploads.daily"), {
    day: localDay(clock.now()),
    composites: 3,
    bytes: 2_000_000,
  });

  // A restarted engine continues from the stored value, including uploads recorded before it was read.
  const again = createUploads(d);
  again.record(1);
  await again.settled();
  assert.deepEqual(again.today(), { today: 4, bytesToday: 2_000_001 });
  assert.equal((await d.stores.kv.get("uploads.daily"))?.composites, 4);
});

test("a new local day starts from zero, and yesterday's stored value is ignored", async () => {
  const clock = new ManualClock();
  const d = deps(clock);
  const uploads = createUploads(d);
  uploads.record(10);
  await uploads.settled();
  clock.t = nextMidnight(clock.now());
  assert.deepEqual(uploads.today(), { today: 0, bytesToday: 0 });
  uploads.record(5);
  await uploads.settled();
  assert.deepEqual(await d.stores.kv.get("uploads.daily"), {
    day: localDay(clock.now()),
    composites: 1,
    bytes: 5,
  });

  clock.t = nextMidnight(clock.now());
  const fresh = createUploads(d);
  await fresh.settled();
  assert.deepEqual(fresh.today(), { today: 0, bytesToday: 0 });
});

test("an unreadable or unwritable kv never breaks counting", async () => {
  const clock = new ManualClock();
  const { log, entries } = captureLogger();
  const stores = memoryStores();
  const broken = {
    ...stores,
    kv: { get: () => Promise.reject(new Error("read")), set: () => Promise.reject(new Error("write")) },
  };
  const uploads = createUploads({ clock, log, settings: createSettingsCache({ clock }), stores: broken });
  uploads.record(3);
  await uploads.settled();
  assert.deepEqual(uploads.today(), { today: 1, bytesToday: 3 });
  assert.ok(entries.some((entry) => entry.msg === "upload counter unreadable"));
  assert.ok(entries.some((entry) => entry.msg === "upload counter not saved"));
});

test("createUploads fits ServiceFactories.createUploads", () => {
  const factory: ServiceFactories["createUploads"] = createUploads;
  assert.equal(typeof factory, "function");
});
