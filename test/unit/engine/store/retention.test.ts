// Retention (TTL of AI translations, orphan images, log ring) and en:cache-clear: user data is never deleted.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createSettingsCache } from "../../../../src/engine/settings-cache.ts";
import { openStores, type EngineStoresImpl } from "../../../../src/engine/store/db.ts";
import { clearCache, DAY_MS, runRetention } from "../../../../src/engine/store/retention.ts";
import type { GlossaryEntry, ImageRecord, TranslationRecord } from "../../../../src/shared/records.ts";
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from "../../../../src/shared/settings.ts";
import { captureLogger, ManualClock } from "./engine-fakes.ts";

let clock: ManualClock;
let stores: EngineStoresImpl;
let now: number;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  clock = new ManualClock();
  now = clock.now();
  stores = await openStores({ clock, log: captureLogger().log, settings: createSettingsCache({ clock }) });
});

const old = (): number => now - 40 * DAY_MS;
const recent = (): number => now - DAY_MS;

function image(contentKey: string, lastUsedAt: number, seriesKey: string | null = null): ImageRecord {
  return {
    contentKey,
    w: 800,
    h: 2_000,
    mime: "image/jpeg",
    byteLength: 1,
    source: "url",
    lowRes: false,
    lang: "ko",
    seriesKey,
    firstSeenAt: lastUsedAt,
    lastUsedAt,
  };
}

function translation(
  contentKey: string,
  unitKey: string,
  lastUsedAt: number,
  extra: Partial<TranslationRecord> = {},
): TranslationRecord {
  return {
    contentKey,
    unitKey,
    seriesKey: null,
    type: "dialogue",
    speaker: "",
    original: "원문",
    translation: "bản dịch",
    manualTranslation: null,
    manual: 0,
    status: "ok",
    lang: "ko",
    model: "m",
    promptVersion: 1,
    attempts: 1,
    updatedAt: lastUsedAt,
    lastUsedAt,
    ...extra,
  };
}

async function seedImage(
  contentKey: string,
  lastUsedAt: number,
  seriesKey: string | null = null,
): Promise<void> {
  const db = stores.db;
  await db.put("images", image(contentKey, lastUsedAt, seriesKey));
  await db.put("urls", { urlKey: `u:${contentKey}`, contentKey, lastSeenAt: lastUsedAt });
  await db.put("units", {
    contentKey,
    detectorVersion: "v4s",
    unitsVersion: 1,
    backend: "wasm",
    slices: [],
    rawDetections: [],
    units: [],
    createdAt: lastUsedAt,
  });
  await db.put("pages", {
    chapterKey: "ch",
    contentKey,
    seriesKey,
    orderKey: 1,
    urlPath: "/c",
    seenAt: lastUsedAt,
  });
  await db.put("patches", {
    contentKey,
    unitKey: "u1",
    eraseVersion: 1,
    kind: "box",
    glyphPx: 20,
    rect: { x1: 0, y1: 0, x2: 1, y2: 1 },
    bg: null,
    textColor: [0, 0, 0],
    png: new ArrayBuffer(4),
    bytes: 4,
    lastUsedAt,
  });
}

async function seedUserData(): Promise<void> {
  const db = stores.db;
  await db.put("series", {
    seriesKey: "https://x.example|s",
    siteKey: "https://x.example",
    title: "S",
    lang: "ko",
    langVotes: {},
    readingDir: "auto",
    style: { genre: "", koNames: "romanized", keepJaHonorifics: false },
    pronouns: [],
    summaryEnabled: false,
    notes: "",
    aliases: [],
    createdAt: old(),
    updatedAt: old(),
    lastReadAt: old(),
  });
  await db.put("glossary", {
    seriesKey: "https://x.example|s",
    orig: "철수",
    translation: "Cheol-su",
    note: "",
    state: "manual",
    sightings: 1,
    packIds: [],
    alternatives: [],
    firstSeenAt: old(),
    lastSeenAt: old(),
  });
  await db.put("chapters", {
    chapterKey: "ch",
    seriesKey: "https://x.example|s",
    url: "https://x.example/c",
    title: "C",
    summary: "",
    summaryPos: 0,
    lastReadAt: old(),
  });
}

function entry(
  orig: string,
  state: GlossaryEntry["state"],
  lastSeenAt: number,
  seriesKey = "https://x.example|s",
): GlossaryEntry {
  return {
    seriesKey,
    orig,
    translation: `${orig}-t`,
    note: "",
    state,
    sightings: 1,
    packIds: ["pk-1"],
    alternatives: [],
    firstSeenAt: lastSeenAt,
    lastSeenAt,
  };
}

function settingsWith(
  patch: Partial<Settings["cache"]>,
  logCapacity = DEFAULT_SETTINGS.debug.logCapacity,
): Settings {
  return migrateSettings({
    cache: { ...DEFAULT_SETTINGS.cache, ...patch },
    debug: { logLevel: "info", logCapacity },
  });
}

test("AI translations past the TTL go; manual edits, recently viewed images and user data stay", async () => {
  await seedImage("s:A", old());
  await seedImage("s:B", old());
  await seedImage("s:C", recent());
  await seedImage("s:D", old());
  await seedUserData();
  const db = stores.db;
  await db.put("translations", translation("s:A", "a1", old()));
  await db.put(
    "translations",
    translation("s:A", "a2", old(), { manual: 1, manualTranslation: "sửa tay", status: "manual" }),
  );
  await db.put("translations", translation("s:B", "b1", old()));
  await db.put("translations", translation("s:C", "c1", old()));
  await db.put("translations", translation("s:C", "c2", recent()));
  for (let i = 0; i < 130; i += 1) await db.add("logs", { t: i, level: "info", ctx: "engine", msg: `m${i}` });
  // Glossary: a stale candidate goes; learned entries and fresh candidates stay whatever their age.
  await db.put("glossary", entry("old-candidate", "candidate", old()));
  await db.put("glossary", entry("new-candidate", "candidate", recent()));
  await db.put("glossary", entry("old-learned", "learned", old()));

  const report = await runRetention({ stores, settings: settingsWith({ translationTtlDays: 30 }, 100), now });
  assert.deepEqual(report, {
    translations: 2,
    images: 2,
    urls: 2,
    units: 2,
    pages: 2,
    patches: 2,
    candidates: 1,
    logs: 30,
  });
  assert.deepEqual((await db.getAllKeys("translations")).map((key) => key.join("/")).sort(), [
    "s:A/a2",
    "s:C/c1",
    "s:C/c2",
  ]);
  assert.deepEqual((await db.getAllKeys("images")).sort(), ["s:A", "s:C"]);
  assert.deepEqual((await db.getAllKeys("units")).sort(), ["s:A", "s:C"]);
  assert.equal(await db.count("series"), 1);
  assert.deepEqual((await db.getAll("glossary")).map((e) => e.orig).sort(), [
    "new-candidate",
    "old-learned",
    "철수",
  ]);
  assert.equal(await db.count("chapters"), 1);
  assert.equal(await db.count("logs"), 100);
  assert.equal(await stores.kv.get("retention.lastRunAt"), now);
});

test("TTL 0 keeps every translation; queued writes are flushed before the run", async () => {
  await seedImage("s:A", old());
  stores.translations.put(translation("s:A", "a1", old()));
  const report = await runRetention({ stores, settings: settingsWith({ translationTtlDays: 0 }), now });
  assert.equal(report.translations, 0);
  assert.equal(report.images, 0);
  assert.equal(await stores.db.count("translations"), 1);

  const expired = await runRetention({ stores, settings: settingsWith({ translationTtlDays: 30 }), now });
  assert.equal(expired.translations, 1);
  assert.equal(expired.images, 1);
});

test("cache-clear all removes cached AI data and glossary candidates; keeps manual edits, series, entries in use and chapters", async () => {
  await seedImage("s:A", recent());
  await seedImage("s:B", recent());
  await seedUserData();
  const db = stores.db;
  await db.put("glossary", entry("candidate", "candidate", recent()));
  await db.put("glossary", entry("confirmed", "confirmed", recent()));
  await db.put("glossary", entry("learned", "learned", recent()));
  await db.put("translations", translation("s:A", "a1", recent()));
  await db.put(
    "translations",
    translation("s:A", "a2", recent(), { manual: 1, manualTranslation: "sửa", status: "manual" }),
  );
  stores.translations.put(translation("s:B", "b1", recent()));

  const deleted = await clearCache(stores, "all");
  assert.equal(deleted, 2 * 5 + 2 + 1, "5 derived records per image + 2 AI translations + 1 candidate");
  assert.deepEqual(
    (await db.getAllKeys("translations")).map((key) => key.join("/")),
    ["s:A/a2"],
  );
  for (const name of ["images", "urls", "units", "pages", "patches"] as const) {
    assert.equal(await db.count(name), 0, name);
  }
  assert.equal(await db.count("series"), 1);
  assert.deepEqual((await db.getAll("glossary")).map((e) => e.orig).sort(), ["confirmed", "learned", "철수"]);
  assert.equal(await db.count("chapters"), 1);
});

test("cache-clear by series or site only touches matching seriesKeys", async () => {
  const db = stores.db;
  await seedImage("s:A", recent(), "https://x.example|one");
  await seedImage("s:B", recent(), "https://x.example|two");
  await seedImage("s:C", recent(), "https://y.example|one");
  await db.put("translations", translation("s:A", "a1", recent(), { seriesKey: "https://x.example|one" }));
  await db.put("translations", translation("s:B", "b1", recent(), { seriesKey: "https://x.example|two" }));
  await db.put("translations", translation("s:C", "c1", recent(), { seriesKey: "https://y.example|one" }));

  await db.put("glossary", entry("c1", "candidate", recent(), "https://x.example|one"));
  await db.put("glossary", entry("m1", "manual", recent(), "https://x.example|one"));
  await db.put("glossary", entry("c2", "candidate", recent(), "https://x.example|two"));
  await db.put("glossary", entry("c3", "candidate", recent(), "https://y.example|one"));

  assert.equal(await clearCache(stores, "series", "https://x.example|one"), 1 + 5 + 1);
  assert.deepEqual((await db.getAllKeys("images")).sort(), ["s:B", "s:C"]);
  assert.equal(await clearCache(stores, "site", "https://x.example"), 1 + 5 + 1);
  assert.deepEqual(await db.getAllKeys("images"), ["s:C"]);
  assert.deepEqual((await db.getAll("glossary")).map((e) => e.orig).sort(), ["c3", "m1"]);
  assert.equal(await clearCache(stores, "series", "nothing"), 0);
  await assert.rejects(clearCache(stores, "site"), /key is required/);
});
