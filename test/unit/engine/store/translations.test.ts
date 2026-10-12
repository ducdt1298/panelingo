// Store "translations": 2 s batching, read-your-writes, and "a manual edit always wins" (plan §5.12, §5.15).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createSettingsCache } from "../../../../src/engine/settings-cache.ts";
import { openStores, type EngineStoresImpl } from "../../../../src/engine/store/db.ts";
import { mergeTranslation, TRANSLATION_FLUSH_MS } from "../../../../src/engine/store/translations.ts";
import type { TranslationRecord } from "../../../../src/shared/records.ts";
import { captureLogger, ManualClock } from "./engine-fakes.ts";

function record(unitKey: string, extra: Partial<TranslationRecord> = {}): TranslationRecord {
  return {
    contentKey: "s:img",
    unitKey,
    seriesKey: null,
    type: "dialogue",
    speaker: "",
    original: "안녕",
    translation: "Xin chào",
    manualTranslation: null,
    manual: 0,
    status: "ok",
    lang: "ko",
    model: "azure-gpt-5.2",
    promptVersion: 1,
    attempts: 1,
    updatedAt: 1,
    lastUsedAt: 1,
    ...extra,
  };
}

let clock: ManualClock;
let stores: EngineStoresImpl;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  clock = new ManualClock();
  stores = await openStores({ clock, log: captureLogger().log, settings: createSettingsCache({ clock }) });
});

async function stored(unitKey: string): Promise<TranslationRecord | undefined> {
  return stores.db.get("translations", ["s:img", unitKey]);
}

test("merge rules: user edits win, AI writes keep an existing edit, a user revert returns to the AI text", () => {
  const ai = record("u1", { translation: "AI 1" });
  const edit = record("u1", {
    translation: "AI 1",
    manualTranslation: "Bản sửa",
    manual: 1,
    status: "manual",
  });
  assert.deepEqual(mergeTranslation(undefined, ai), ai);
  assert.deepEqual(mergeTranslation(ai, edit), edit);

  const lateAi = record("u1", { translation: "AI 2", attempts: 2, updatedAt: 5, lastUsedAt: 0 });
  const kept = mergeTranslation(edit, lateAi);
  assert.equal(kept.manualTranslation, "Bản sửa");
  assert.equal(kept.manual, 1);
  assert.equal(kept.status, "manual");
  assert.equal(kept.translation, "AI 2", "the AI text underneath is refreshed");
  assert.equal(kept.attempts, 2);
  assert.equal(kept.lastUsedAt, 1, "lastUsedAt never moves back");
  assert.deepEqual(mergeTranslation(kept, lateAi), kept, "idempotent");

  const revert = mergeTranslation(kept, { ...kept, manualTranslation: null, manual: 1 });
  assert.equal(revert.manual, 0);
  assert.equal(revert.manualTranslation, null);
  assert.equal(revert.status, "ok");
  assert.equal(revert.translation, "AI 2");
  const emptyRevert = mergeTranslation(kept, {
    ...kept,
    translation: "",
    manualTranslation: null,
    manual: 1,
  });
  assert.equal(emptyRevert.status, "untranslated");
  const aiReplace = mergeTranslation(ai, record("u1", { translation: "AI 3", status: "refused" }));
  assert.equal(aiReplace.status, "refused");
});

test("put() is batched for 2 s, reads see queued writes, flush() writes at once", async () => {
  stores.translations.put(record("u1"));
  stores.translations.put(record("u2", { translation: "Tạm biệt" }));
  assert.equal(stores.translations.pending(), 2);
  assert.equal(await stored("u1"), undefined, "nothing written yet");
  const seen = await stores.translations.forImage("s:img");
  assert.deepEqual(seen.map((r) => r.unitKey).sort(), ["u1", "u2"]);

  await clock.advance(TRANSLATION_FLUSH_MS - 1);
  assert.equal(await stored("u1"), undefined);
  await clock.advance(1);
  await stores.translations.flush();
  assert.equal((await stored("u1"))?.translation, "Xin chào");
  assert.equal((await stored("u2"))?.translation, "Tạm biệt");
  assert.equal(stores.translations.pending(), 0);
  assert.equal(clock.pending(), 0, "no timer left after the batch");

  stores.translations.put(record("u3"));
  await stores.translations.flush();
  assert.equal((await stored("u3"))?.translation, "Xin chào");
  assert.equal(clock.pending(), 0, "flush() cancels the batch timer");
});

test("a late AI result never overwrites a stored manual edit; a user revert does", async () => {
  stores.translations.put(record("u1", { translation: "AI 1" }));
  await stores.translations.flush();
  stores.translations.put(
    record("u1", { translation: "AI 1", manualTranslation: "Bản sửa tay", manual: 1, status: "manual" }),
  );
  await stores.translations.flush();
  stores.translations.put(record("u1", { translation: "AI 2", attempts: 2 }));
  await stores.translations.flush();
  const afterAi = await stored("u1");
  assert.ok(afterAi !== undefined);
  assert.equal(afterAi.manualTranslation, "Bản sửa tay");
  assert.equal(afterAi.manual, 1);
  assert.equal(afterAi.translation, "AI 2");
  const manualIndex = await stores.db.getAllFromIndex("translations", "byManual", 1);
  assert.equal(manualIndex.length, 1);

  stores.translations.put({ ...afterAi, manualTranslation: null, manual: 1 });
  await stores.translations.flush();
  const reverted = await stored("u1");
  assert.equal(reverted?.manual, 0);
  assert.equal(reverted?.manualTranslation, null);
  assert.equal(reverted?.translation, "AI 2");
});

test("one batch applies its writes in order, whatever their mix", async () => {
  stores.translations.put(record("u1", { translation: "AI 1" }));
  stores.translations.put(record("u1", { manualTranslation: "Sửa", manual: 1, status: "manual" }));
  stores.translations.put(record("u1", { translation: "AI late" }));
  stores.translations.put(record("u2", { manualTranslation: "Sửa 2", manual: 1, status: "manual" }));
  const preview = await stores.translations.forImage("s:img");
  const u1 = preview.find((r) => r.unitKey === "u1");
  assert.equal(u1?.manualTranslation, "Sửa");
  assert.equal(u1?.translation, "AI late");
  await stores.translations.flush();
  assert.equal((await stored("u1"))?.manualTranslation, "Sửa");
  assert.equal((await stored("u2"))?.manualTranslation, "Sửa 2");
  assert.deepEqual(
    (await stores.translations.forImage("s:img")).map((r) => r.unitKey).sort(),
    ["u1", "u2"],
    "after the flush the overlay is empty and nothing is duplicated",
  );
});

test("forImage only returns the requested image", async () => {
  stores.translations.put(record("u1"));
  stores.translations.put({ ...record("u9"), contentKey: "s:other" });
  await stores.translations.flush();
  stores.translations.put({ ...record("u8"), contentKey: "s:other" });
  assert.deepEqual((await stores.translations.forImage("s:other")).map((r) => r.unitKey).sort(), [
    "u8",
    "u9",
  ]);
  assert.deepEqual(
    (await stores.translations.forImage("s:img")).map((r) => r.unitKey),
    ["u1"],
  );
  await stores.close();
});
