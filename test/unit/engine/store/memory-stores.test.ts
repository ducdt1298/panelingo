// Series memory repositories on IndexedDB (fake-indexeddb): series, glossary, chapters and pages, including the
// one-transaction update() that keeps learning from overwriting what the user saved.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createSettingsCache } from "../../../../src/engine/settings-cache.ts";
import { openStores, type EngineStoresImpl } from "../../../../src/engine/store/db.ts";
import { newChapter, newSeriesProfile } from "../../../../src/shared/core/memory.ts";
import { CtvError } from "../../../../src/shared/errors.ts";
import type { GlossaryEntry, PageRecord } from "../../../../src/shared/records.ts";
import { captureLogger, ManualClock } from "./engine-fakes.ts";

let stores: EngineStoresImpl;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  const clock = new ManualClock();
  stores = await openStores({ clock, log: captureLogger().log, settings: createSettingsCache({ clock }) });
});

const ONE = "https://reader.example|one";
const TWO = "https://reader.example|two";

function entry(seriesKey: string, orig: string, state: GlossaryEntry["state"] = "candidate"): GlossaryEntry {
  return {
    seriesKey,
    orig,
    translation: `${orig}-t`,
    note: "",
    state,
    sightings: 1,
    packIds: ["p1"],
    alternatives: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

function page(chapterKey: string, contentKey: string, orderKey: number): PageRecord {
  return { chapterKey, contentKey, seriesKey: ONE, orderKey, urlPath: "/c", seenAt: 1 };
}

test("series: get, put, all and an atomic update that creates or changes the profile", async () => {
  assert.equal(await stores.series.get(ONE), undefined);
  const created = await stores.series.update(ONE, (existing) =>
    existing === undefined ? newSeriesProfile(ONE, "https://reader.example", "One", 5) : undefined,
  );
  assert.equal(created?.title, "One");
  const unchanged = await stores.series.update(ONE, () => undefined);
  assert.deepEqual(unchanged, created, "undefined leaves the record and returns it");
  const renamed = await stores.series.update(ONE, (existing) =>
    existing === undefined
      ? undefined
      : { ...existing, title: "Renamed", seriesKey: "https://other.example|x" },
  );
  assert.equal(renamed?.seriesKey, ONE, "the key cannot move");
  assert.equal((await stores.series.get(ONE))?.title, "Renamed");
  await stores.series.put(newSeriesProfile(TWO, "https://reader.example", "Two", 6));
  assert.deepEqual((await stores.series.all()).map((s) => s.seriesKey).sort(), [ONE, TWO]);
});

test("glossary: entries are per series; update writes, deletes and skips in one transaction", async () => {
  await stores.glossary.put(entry(ONE, "가"));
  await stores.glossary.put(entry(ONE, "나", "manual"));
  await stores.glossary.put(entry(TWO, "가"));
  // A series whose key is a prefix of another must not see the other's entries.
  await stores.glossary.put(entry(`${ONE}x`, "다"));
  assert.deepEqual(
    (await stores.glossary.forSeries(ONE)).map((e) => e.orig),
    ["가", "나"],
  );

  const changed = await stores.glossary.update(ONE, ["가", "나", "라", "마", "가"], (orig, existing) => {
    if (orig === "가") return null;
    if (orig === "나") return existing === undefined ? undefined : { ...existing, translation: "changed" };
    if (orig === "라") return { ...entry(ONE, "라"), seriesKey: TWO, orig: "moved?" };
    return null;
  });
  assert.equal(changed, 3, "delete 가, change 나, create 라; deleting a missing 마 is no change");
  const after = await stores.glossary.forSeries(ONE);
  assert.deepEqual(
    after.map((e) => [e.orig, e.translation, e.seriesKey]),
    [
      ["나", "changed", ONE],
      ["라", "라-t", ONE],
    ],
    "the key of an updated entry is the one asked for",
  );
  assert.equal((await stores.glossary.forSeries(TWO)).length, 1);

  await stores.glossary.delete(ONE, "나");
  assert.deepEqual(
    (await stores.glossary.forSeries(ONE)).map((e) => e.orig),
    ["라"],
  );
});

test("glossary: a failing change aborts the whole update", async () => {
  await stores.glossary.put(entry(ONE, "가"));
  await assert.rejects(
    stores.glossary.update(ONE, ["가", "나"], (orig) => {
      if (orig === "나") throw new Error("boom");
      return null;
    }),
    (error: unknown) => error instanceof CtvError && error.code === "store.io",
  );
  assert.equal((await stores.glossary.forSeries(ONE)).length, 1, "the delete of 가 was rolled back");
});

test("chapters: get, put and update keep the summary with its page position", async () => {
  const key = "https://reader.example/one/chapter-1";
  assert.equal(await stores.chapters.get(key), undefined);
  await stores.chapters.put(newChapter(key, ONE, key, "Chapter 1", 1));
  const next = await stores.chapters.update(key, (existing) =>
    existing === undefined ? undefined : { ...existing, summary: "So far…", summaryPos: 3_002 },
  );
  assert.deepEqual([next?.summary, next?.summaryPos], ["So far…", 3_002]);
  assert.equal((await stores.chapters.get(key))?.summary, "So far…");
  assert.equal(await stores.chapters.update("https://reader.example/none", () => undefined), undefined);
});

test("pages: forChapter lists one chapter's images in page order; a put moves an image", async () => {
  const one = "https://reader.example/one/chapter-1";
  const two = "https://reader.example/one/chapter-2";
  await stores.pages.put(page(one, "s:C", 3));
  await stores.pages.put(page(one, "s:A", 1));
  await stores.pages.put(page(two, "s:X", 0));
  await stores.pages.put(page(one, "s:B", 2));
  assert.deepEqual(
    (await stores.pages.forChapter(one)).map((p) => p.contentKey),
    ["s:A", "s:B", "s:C"],
  );
  await stores.pages.put(page(one, "s:A", 9));
  assert.deepEqual(
    (await stores.pages.forChapter(one)).map((p) => p.contentKey),
    ["s:B", "s:C", "s:A"],
  );
  assert.deepEqual(
    (await stores.pages.forChapter(two)).map((p) => p.contentKey),
    ["s:X"],
  );
  assert.deepEqual(await stores.pages.forChapter("https://reader.example/none"), []);
});
