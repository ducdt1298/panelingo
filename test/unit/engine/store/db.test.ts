// openStores (P1-04: all 12 stores) and the small repositories: kv, models, images + url aliases, units.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ServiceFactories } from "../../../../src/engine/contracts.ts";
import { createSettingsCache } from "../../../../src/engine/settings-cache.ts";
import { openStores, type EngineStoresImpl } from "../../../../src/engine/store/db.ts";
import { createImageStore, TOUCH_MIN_INTERVAL_MS } from "../../../../src/engine/store/images.ts";
import { storeError } from "../../../../src/engine/store/io.ts";
import { STORE_NAMES } from "../../../../src/platform/db-schema.ts";
import { CtvError } from "../../../../src/shared/errors.ts";
import type { ImageRecord } from "../../../../src/shared/records.ts";
import { DEFAULT_SETTINGS } from "../../../../src/shared/settings.ts";
import { captureLogger, ManualClock } from "./engine-fakes.ts";

let clock: ManualClock;
let stores: EngineStoresImpl;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  clock = new ManualClock();
  stores = await openStores({ clock, log: captureLogger().log, settings: createSettingsCache({ clock }) });
});

function image(contentKey: string, lastUsedAt: number): ImageRecord {
  return {
    contentKey,
    w: 800,
    h: 7_680,
    mime: "image/webp",
    byteLength: 123,
    source: "url",
    lowRes: false,
    lang: null,
    seriesKey: null,
    firstSeenAt: lastUsedAt,
    lastUsedAt,
  };
}

test("openStores creates all 12 stores of DB version 1", () => {
  assert.deepEqual([...stores.db.objectStoreNames].sort(), [...STORE_NAMES].sort());
  assert.equal(stores.db.version, 1);
});

test("kv and models round-trip typed values", async () => {
  assert.equal(await stores.kv.get("retention.lastRunAt"), undefined);
  await stores.kv.set("retention.lastRunAt", 42);
  await stores.kv.set("uploads.daily", { day: "2026-10-10", composites: 3, bytes: 9 });
  await stores.kv.set("settings.mirror", { settings: DEFAULT_SETTINGS, sites: {}, at: 5 });
  assert.equal(await stores.kv.get("retention.lastRunAt"), 42);
  assert.deepEqual(await stores.kv.get("uploads.daily"), { day: "2026-10-10", composites: 3, bytes: 9 });
  assert.deepEqual((await stores.kv.get("settings.mirror"))?.settings.api, DEFAULT_SETTINGS.api);
  const model = {
    file: "detector-v4-s.fixed.onnx",
    sha256: "4a01",
    bytes: 41_361_666,
    verifiedForBuild: "b1",
    ok: true,
    verifiedAt: 1,
  };
  await stores.models.put(model);
  assert.deepEqual(await stores.models.get(model.file), model);
  assert.equal(await stores.models.get("missing"), undefined);
});

test("images: records, url aliases and units", async () => {
  await stores.images.put(image("s:aa", 10));
  assert.equal((await stores.images.get("s:aa"))?.h, 7_680);
  await stores.images.putAlias("u:https://cdn.example/1.webp", "s:aa", 11);
  assert.equal(await stores.images.alias("u:https://cdn.example/1.webp"), "s:aa");
  assert.equal(await stores.images.alias("u:nope"), undefined);
  await stores.units.put({
    contentKey: "s:aa",
    detectorVersion: "v4s",
    unitsVersion: 1,
    backend: "webgpu",
    slices: [{ y1: 0, y2: 2_400 }],
    rawDetections: [],
    units: [],
    createdAt: 1,
  });
  assert.equal((await stores.units.get("s:aa"))?.backend, "webgpu");
});

test("touch() writes lastUsedAt at most once per hour per image", async () => {
  const db = stores.db;
  const images = createImageStore(db);
  await db.put("images", image("s:bb", 0));
  await images.touch("s:bb", 30 * 60_000);
  assert.equal((await db.get("images", "s:bb"))?.lastUsedAt, 0, "younger than an hour: no write");
  await images.touch("s:bb", 90 * 60_000);
  assert.equal((await db.get("images", "s:bb"))?.lastUsedAt, 90 * 60_000);
  await images.touch("s:bb", 90 * 60_000 + TOUCH_MIN_INTERVAL_MS - 1);
  assert.equal((await db.get("images", "s:bb"))?.lastUsedAt, 90 * 60_000);
  await images.touch("s:bb", 90 * 60_000 + TOUCH_MIN_INTERVAL_MS);
  assert.equal((await db.get("images", "s:bb"))?.lastUsedAt, 90 * 60_000 + TOUCH_MIN_INTERVAL_MS);
  await images.touch("s:none", 1);
});

test("close() flushes queued translations and logs, then the database is closed", async () => {
  stores.translations.put({
    contentKey: "s:cc",
    unitKey: "1:2:3:4",
    seriesKey: null,
    type: "dialogue",
    speaker: "",
    original: "a",
    translation: "b",
    manualTranslation: null,
    manual: 0,
    status: "ok",
    lang: "ko",
    model: "m",
    promptVersion: 1,
    attempts: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  });
  stores.logs.append({ t: 1, level: "warn", ctx: "engine", msg: "bye" });
  const db = stores.db;
  await stores.close();
  await stores.close();
  const reopened = await openStores({
    clock,
    log: captureLogger().log,
    settings: createSettingsCache({ clock }),
  });
  assert.equal(await reopened.db.count("translations"), 1);
  assert.equal(await reopened.db.count("logs"), 1);
  await assert.rejects(
    db.get("kv", "x"),
    (error: unknown) => error instanceof Error,
    "the old connection is closed",
  );
  await assert.rejects(stores.kv.get("retention.lastRunAt"), (error: unknown) => {
    assert.ok(error instanceof CtvError);
    assert.equal(error.code, "store.io");
    return true;
  });
  await reopened.close();
});

test("storeError maps quota errors to store.quota and passes CtvErrors through", () => {
  const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
  assert.equal(storeError(quota, "x").code, "store.quota");
  assert.equal(storeError(new Error("boom"), "x").code, "store.io");
  assert.equal(storeError("text", "op").message, "op: text");
  const ctv = new CtvError("engine.internal", "kept");
  assert.equal(storeError(ctv, "x"), ctv);
});

test("openStores fits ServiceFactories.openStores", () => {
  const factory: ServiceFactories["openStores"] = openStores;
  assert.equal(typeof factory, "function");
});
