// Store "logs": ring buffer batched every 1 s or 50 entries, pruned to the capacity (A.6, A.7).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { openCtvDb, type CtvDatabase } from "../../../../src/platform/db-schema.ts";
import { createLogStore, LOG_BATCH_MS, LOG_BATCH_SIZE, trimLogs } from "../../../../src/engine/store/logs.ts";
import type { LogEntry } from "../../../../src/shared/types.ts";
import { flushTurns, ManualClock } from "./engine-fakes.ts";

let db: CtvDatabase;
let clock: ManualClock;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  db = await openCtvDb();
  clock = new ManualClock();
});

function entry(i: number): LogEntry {
  return { t: 1_000 + i, level: "info", ctx: "engine", msg: `m${i}` };
}

test("entries are batched for 1 s, then written in order; recent() includes queued entries", async () => {
  const logs = createLogStore(db, { clock, capacity: () => 1_000 });
  for (let i = 0; i < 3; i += 1) logs.append(entry(i));
  assert.equal(logs.pending(), 3);
  assert.equal(await db.count("logs"), 0);
  assert.deepEqual(
    (await logs.recent(2)).map((e) => e.msg),
    ["m1", "m2"],
  );
  await clock.advance(LOG_BATCH_MS);
  await logs.flush();
  assert.equal(await db.count("logs"), 3);
  logs.append(entry(3));
  assert.deepEqual(
    (await logs.recent(10)).map((e) => e.msg),
    ["m0", "m1", "m2", "m3"],
  );
  assert.deepEqual(await logs.recent(0), []);
});

test(`${LOG_BATCH_SIZE} entries flush at once without waiting for the timer`, async () => {
  const logs = createLogStore(db, { clock, capacity: () => 1_000 });
  for (let i = 0; i < LOG_BATCH_SIZE; i += 1) logs.append(entry(i));
  await flushTurns(2);
  assert.equal(logs.pending(), 0);
  assert.equal(clock.pending(), 0, "the size trigger cancels the batch timer");
  await logs.flush();
  assert.equal(await db.count("logs"), LOG_BATCH_SIZE);
});

test("the ring keeps the newest `capacity` entries; trims run every trimEvery writes", async () => {
  const logs = createLogStore(db, { clock, capacity: () => 10, trimEvery: 20, batchSize: 1_000 });
  for (let i = 0; i < 15; i += 1) logs.append(entry(i));
  await logs.flush();
  assert.equal(await db.count("logs"), 15, "below trimEvery: no trim yet");
  for (let i = 15; i < 25; i += 1) logs.append(entry(i));
  await logs.flush();
  assert.equal(await db.count("logs"), 10);
  assert.deepEqual(
    (await logs.recent(100)).map((e) => e.msg),
    Array.from({ length: 10 }, (_, k) => `m${15 + k}`),
  );
  assert.equal(await trimLogs(db, 4), 6);
  assert.equal(await db.count("logs"), 4);
  assert.equal(await trimLogs(db, 4), 0);
});

test("a caller's seq never becomes the key; append never throws while the database is gone", async () => {
  const reports: string[] = [];
  const logs = createLogStore(db, { clock, capacity: () => 100, report: (m) => reports.push(m) });
  logs.append({ ...entry(1), seq: 7 } as LogEntry);
  logs.append({ ...entry(2), seq: 7 } as LogEntry);
  await logs.flush();
  assert.equal(await db.count("logs"), 2);
  db.close();
  logs.append(entry(3));
  await clock.advance(LOG_BATCH_MS);
  await assert.rejects(logs.flush().then(() => logs.recent(5)));
  assert.equal(reports.length, 1, "the timer's failed batch is reported, not thrown");
  assert.match(reports[0] ?? "", /log batch lost/);
});
