import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DB_NAME, STORE_NAMES, openCtvDb } from "../../../src/platform/db-schema.ts";
import { DB_VERSION } from "../../../src/shared/versions.ts";

test("version 1 creates all 12 stores with their keys and indexes", async () => {
  const db = await openCtvDb();
  try {
    assert.equal(db.name, DB_NAME);
    assert.equal(db.version, DB_VERSION);
    assert.deepEqual([...db.objectStoreNames].sort(), [...STORE_NAMES].sort());
    const tx = db.transaction([...STORE_NAMES], "readonly");
    const keyPaths = Object.fromEntries(STORE_NAMES.map((name) => [name, tx.objectStore(name).keyPath]));
    assert.deepEqual(keyPaths, {
      images: "contentKey",
      urls: "urlKey",
      units: "contentKey",
      translations: ["contentKey", "unitKey"],
      patches: ["contentKey", "unitKey"],
      pages: ["chapterKey", "contentKey"],
      chapters: "chapterKey",
      series: "seriesKey",
      glossary: ["seriesKey", "orig"],
      kv: "k",
      models: "file",
      logs: "seq",
    });
    assert.deepEqual([...tx.objectStore("translations").indexNames].sort(), [
      "byContent",
      "byLastUsed",
      "byManual",
      "bySeriesUpdated",
    ]);
    assert.deepEqual([...tx.objectStore("glossary").indexNames].sort(), ["bySeriesRecency", "bySeriesState"]);
    assert.equal(tx.objectStore("logs").autoIncrement, true);
    await tx.done;
  } finally {
    db.close();
  }
});

test("compound keys and indexes work for a translation round trip", async () => {
  const db = await openCtvDb();
  try {
    await db.put("translations", {
      contentKey: "s:abc",
      unitKey: "10.20.30.40",
      seriesKey: "https://comic.example|series-1",
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
    });
    const record = await db.get("translations", ["s:abc", "10.20.30.40"]);
    assert.equal(record?.translation, "Xin chào");
    const byContent = await db.getAllFromIndex("translations", "byContent", "s:abc");
    assert.equal(byContent.length, 1);
  } finally {
    db.close();
  }
});

test("reopening an existing version-1 database runs no upgrade", async () => {
  const first = await openCtvDb();
  first.close();
  let blocked = false;
  const second = await openCtvDb({ onBlocked: () => (blocked = true) });
  try {
    assert.equal(second.version, DB_VERSION);
    assert.equal(blocked, false);
  } finally {
    second.close();
  }
});
