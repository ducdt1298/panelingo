// Series memory service (src/engine/memory.ts) over the real IndexedDB stores (fake-indexeddb): pack context
// (profile, chapter, pages, glossary, history, summary) and learning (@term candidates, @sum, @lang votes).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { EngineStores, MemoryScope, PackLearning } from "../../../src/engine/contracts.ts";
import { createSeriesMemory } from "../../../src/engine/memory.ts";
import { createSettingsCache } from "../../../src/engine/settings-cache.ts";
import { openStores, type EngineStoresImpl } from "../../../src/engine/store/db.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { PageRecord, TranslationRecord } from "../../../src/shared/records.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/shared/settings.ts";
import type { LineType, LogEntry } from "../../../src/shared/types.ts";
import { captureLogger, ManualClock } from "./store/engine-fakes.ts";

const SCOPE: MemoryScope = {
  seriesKey: "https://reader.example|lone-hunter",
  chapterKey: "https://reader.example/manga/lone-hunter/chapter-12",
  siteKey: "https://reader.example",
  url: "https://reader.example/manga/lone-hunter/chapter-12",
  title: "Lone Hunter - Chapter 12 - Reader",
};

let clock: ManualClock;
let stores: EngineStoresImpl;
let settings: ReturnType<typeof createSettingsCache>;
let logs: LogEntry[];

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  clock = new ManualClock();
  settings = createSettingsCache({ clock });
  const captured = captureLogger();
  logs = captured.entries;
  stores = await openStores({ clock, log: captured.log, settings });
});

function memoryOver(over: EngineStores = stores): ReturnType<typeof createSeriesMemory> {
  return createSeriesMemory({ clock, log: captureLogger().log, settings, stores: over });
}

function withMemory(patch: Partial<Settings["memory"]>): void {
  const next = structuredClone(DEFAULT_SETTINGS);
  next.memory = { ...next.memory, ...patch };
  settings.apply(next, {});
}

/** Stores an image's units (in this order) and its translated lines. */
async function seedImage(
  contentKey: string,
  lines: ReadonlyArray<{ unitKey: string; translation: string; type?: LineType; manual?: string }>,
): Promise<void> {
  await stores.units.put({
    contentKey,
    detectorVersion: "v4s",
    unitsVersion: 1,
    backend: "wasm",
    slices: [],
    rawDetections: [],
    units: lines.map((line, order) => ({
      unitKey: line.unitKey,
      kind: "bubble",
      bubble: null,
      text: { x1: 0, y1: order * 10, x2: 10, y2: order * 10 + 5 },
      texts: [],
      orientation: "h",
      glyphPx: 20,
      order,
    })),
    createdAt: 1,
  });
  for (const line of lines) {
    const record: TranslationRecord = {
      contentKey,
      unitKey: line.unitKey,
      seriesKey: SCOPE.seriesKey,
      type: line.type ?? "dialogue",
      speaker: "",
      original: `o-${line.unitKey}`,
      translation: line.translation,
      manualTranslation: line.manual ?? null,
      manual: line.manual === undefined ? 0 : 1,
      status: line.manual === undefined ? (line.translation === "" ? "untranslated" : "ok") : "manual",
      lang: "ko",
      model: "m",
      promptVersion: 2,
      attempts: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    };
    stores.translations.put(record);
  }
}

function learning(patch: Partial<PackLearning> = {}): PackLearning {
  return { terms: [], addresses: [], summary: null, lang: null, ...patch };
}

test("the first context creates the series profile, the chapter and the page, with an empty memory", async () => {
  const memory = memoryOver();
  const context = await memory.context(SCOPE, { contentKey: "s:A", docOrder: 3, pos: 3_000 });
  assert.deepEqual(context, {
    lang: null,
    style: { genre: "", koNames: "romanized", keepJaHonorifics: false },
    glossary: [],
    pronouns: [],
    history: [],
    summary: null,
    askSummary: true,
  });
  const profile = await stores.series.get(SCOPE.seriesKey);
  assert.equal(profile?.title, "Lone Hunter", "titled after the page title without the chapter and site");
  assert.equal(profile?.siteKey, SCOPE.siteKey);
  const chapter = await stores.chapters.get(SCOPE.chapterKey);
  assert.deepEqual([chapter?.seriesKey, chapter?.url, chapter?.summaryPos], [SCOPE.seriesKey, SCOPE.url, -1]);
  assert.deepEqual(await stores.pages.forChapter(SCOPE.chapterKey), [
    {
      chapterKey: SCOPE.chapterKey,
      contentKey: "s:A",
      seriesKey: SCOPE.seriesKey,
      orderKey: 3,
      urlPath: "/manga/lone-hunter/chapter-12",
      seenAt: clock.now(),
    },
  ]);
});

test("history: earlier lines of the chapter in page order, then reading order, within historyMaxLines", async () => {
  const memory = memoryOver();
  await seedImage("s:A", [
    { unitKey: "a0", translation: "A zero" },
    { unitKey: "a1", translation: "BOOM", type: "sfx" },
    { unitKey: "a2", translation: "A two (AI)", manual: "A two (edited)" },
  ]);
  await seedImage("s:B", [
    { unitKey: "b0", translation: "B zero" },
    { unitKey: "b1", translation: "" },
    { unitKey: "b2", translation: "B two" },
  ]);
  await seedImage("s:other", [{ unitKey: "x0", translation: "Another chapter" }]);
  await memory.context(SCOPE, { contentKey: "s:A", docOrder: 1, pos: 1_000 });
  await memory.context(
    { ...SCOPE, chapterKey: "https://reader.example/other" },
    { contentKey: "s:other", docOrder: 0, pos: 0 },
  );
  // The second pack of image B starts at unit 2: its unit 0 is history, units 1-2 are not.
  const context = await memory.context(SCOPE, { contentKey: "s:B", docOrder: 2, pos: 2_002 });
  assert.deepEqual(
    context?.history.map((line) => [line.pos, line.original, line.translation]),
    [
      [1_000, "o-a0", "A zero"],
      [1_002, "o-a2", "A two (edited)"],
      [2_000, "o-b0", "B zero"],
    ],
  );
  withMemory({ historyMaxLines: 2 });
  const short = await memory.context(SCOPE, { contentKey: "s:B", docOrder: 2, pos: 2_002 });
  assert.deepEqual(
    short?.history.map((line) => line.translation),
    ["A two (edited)", "B zero"],
  );
  withMemory({ historyMaxLines: 0 });
  assert.deepEqual(
    (await memory.context(SCOPE, { contentKey: "s:B", docOrder: 2, pos: 2_002 }))?.history,
    [],
  );
});

test("glossary in the context: manual, confirmed, learned; never candidates; at most glossaryInPrompt", async () => {
  const memory = memoryOver();
  const put = (orig: string, state: "manual" | "confirmed" | "learned" | "candidate", lastSeenAt: number) =>
    stores.glossary.put({
      seriesKey: SCOPE.seriesKey,
      orig,
      translation: `${orig}!`,
      note: state === "manual" ? "user" : "",
      state,
      sightings: 1,
      packIds: [],
      alternatives: [],
      firstSeenAt: 1,
      lastSeenAt,
    });
  await put("learned", "learned", 9);
  await put("candidate", "candidate", 10);
  await put("manual", "manual", 1);
  await put("confirmed", "confirmed", 2);
  const context = await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 });
  assert.deepEqual(context?.glossary, [
    { original: "manual", translation: "manual!", note: "user", source: "manual" },
    { original: "confirmed", translation: "confirmed!", source: "confirmed" },
    { original: "learned", translation: "learned!", source: "learned" },
  ]);
  withMemory({ glossaryInPrompt: 2 });
  assert.deepEqual(
    (await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 }))?.glossary.map(
      (e) => e.original,
    ),
    ["manual", "confirmed"],
  );
});

test("learning: @term candidates become learned in a second pack; manual entries are never overwritten", async () => {
  const memory = memoryOver();
  await stores.glossary.put({
    seriesKey: SCOPE.seriesKey,
    orig: "한지호",
    translation: "Han Ji-ho",
    note: "user",
    state: "manual",
    sightings: 0,
    packIds: [],
    alternatives: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
  });
  const terms = [
    { original: "한지호", translation: "Han Jiho", note: "model" },
    { original: "헌터 협회", translation: "Hiệp hội Thợ săn", note: "tổ chức" },
  ];
  await memory.learn(SCOPE, { packId: "pk-1", pos: 1_005, learning: learning({ terms }) });
  // The same pack again (e.g. a ladder re-ask reported the terms twice) does not count twice.
  await memory.learn(SCOPE, { packId: "pk-1", pos: 1_005, learning: learning({ terms }) });
  let glossary = await stores.glossary.forSeries(SCOPE.seriesKey);
  assert.deepEqual(
    glossary.map((e) => [e.orig, e.state, e.translation, e.sightings]),
    [
      ["한지호", "manual", "Han Ji-ho", 1],
      ["헌터 협회", "candidate", "Hiệp hội Thợ săn", 1],
    ],
  );
  let context = await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 });
  assert.deepEqual(
    context?.glossary.map((e) => e.original),
    ["한지호"],
    "candidates are not sent",
  );

  await memory.learn(SCOPE, { packId: "pk-2", pos: 2_005, learning: learning({ terms }) });
  glossary = await stores.glossary.forSeries(SCOPE.seriesKey);
  assert.deepEqual(
    glossary.map((e) => [e.orig, e.state, e.translation]),
    [
      ["한지호", "manual", "Han Ji-ho"],
      ["헌터 협회", "learned", "Hiệp hội Thợ săn"],
    ],
  );
  context = await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 });
  assert.deepEqual(
    context?.glossary.map((e) => [e.original, e.source]),
    [
      ["한지호", "manual"],
      ["헌터 협회", "learned"],
    ],
  );
});

test("learning: @sum replaces the chapter summary only from a pack further down; @lang settles after 2 packs", async () => {
  const memory = memoryOver();
  await memory.learn(SCOPE, {
    packId: "pk-2",
    pos: 2_004,
    learning: learning({ summary: "Jiho enters the gate.", lang: "ko" }),
  });
  await memory.learn(SCOPE, {
    packId: "pk-1",
    pos: 1_009,
    learning: learning({ summary: "An older part.", lang: "ja" }),
  });
  let context = await memory.context(SCOPE, { contentKey: "s:C", docOrder: 3, pos: 3_000 });
  assert.equal(context?.summary, "Jiho enters the gate.");
  assert.equal(context?.lang, null, "1 ko, 1 ja: not settled");
  await memory.learn(SCOPE, {
    packId: "pk-3",
    pos: 3_004,
    learning: learning({ summary: "Jiho levels up.", lang: "ko" }),
  });
  context = await memory.context(SCOPE, { contentKey: "s:C", docOrder: 3, pos: 3_000 });
  assert.equal(context?.summary, "Jiho levels up.");
  assert.equal(context?.lang, "ko");
  assert.deepEqual((await stores.series.get(SCOPE.seriesKey))?.langVotes, { ko: 2, ja: 1 });
  assert.equal((await stores.chapters.get(SCOPE.chapterKey))?.summaryPos, 3_004);
});

test("a series with summaries off neither asks for nor keeps one", async () => {
  const memory = memoryOver();
  await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 });
  await stores.series.update(SCOPE.seriesKey, (existing) =>
    existing === undefined ? undefined : { ...existing, summaryEnabled: false },
  );
  await memory.learn(SCOPE, { packId: "pk-1", pos: 5, learning: learning({ summary: "Ignored." }) });
  const context = await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 });
  assert.equal(context?.askSummary, false);
  assert.equal(context?.summary, null);
  assert.equal((await stores.chapters.get(SCOPE.chapterKey))?.summary, "");
});

test("the profile's language, style and forms of address reach the context", async () => {
  const memory = memoryOver();
  await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 });
  const rule = { a: "Jiho", b: "Jiyu", aSelf: "anh", aToB: "em" };
  await stores.series.update(SCOPE.seriesKey, (existing) =>
    existing === undefined
      ? undefined
      : {
          ...existing,
          lang: "ko",
          style: { genre: "action", koNames: "han-viet", keepJaHonorifics: true },
          pronouns: [rule],
        },
  );
  const context = await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 });
  assert.equal(context?.lang, "ko");
  assert.deepEqual(context?.style, { genre: "action", koNames: "han-viet", keepJaHonorifics: true });
  assert.deepEqual(context?.pronouns, [rule]);
});

test("learning: @addr pairs are kept for the series and sent back; a reader's rule stays", async () => {
  const memory = memoryOver();
  const manual = { a: "Jiho", b: "Jiyu", aSelf: "anh", aToB: "em", source: "manual" as const };
  await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 });
  await stores.series.update(SCOPE.seriesKey, (existing) =>
    existing === undefined ? undefined : { ...existing, pronouns: [manual] },
  );
  await memory.learn(SCOPE, {
    packId: "pk-1",
    pos: 1_005,
    learning: learning({
      addresses: [
        { a: "Jiho", b: "Jiyu", aSelf: "tớ", aToB: "cậu" },
        { a: "Jiyu", b: "Jiho", aSelf: "em", aToB: "anh" },
      ],
    }),
  });
  let context = await memory.context(SCOPE, { contentKey: "s:B", docOrder: 1, pos: 2_000 });
  assert.deepEqual(context?.pronouns, [
    { a: "Jiyu", b: "Jiho", aSelf: "em", aToB: "anh" },
    { a: "Jiho", b: "Jiyu", aSelf: "anh", aToB: "em" },
  ]);
  // One later request that answers differently does not change the pair; a second one does.
  await memory.learn(SCOPE, {
    packId: "pk-2",
    pos: 2_005,
    learning: learning({ addresses: [{ a: "Jiyu", b: "Jiho", aSelf: "tớ", aToB: "cậu" }] }),
  });
  context = await memory.context(SCOPE, { contentKey: "s:B", docOrder: 1, pos: 2_000 });
  assert.equal(context?.pronouns[0]?.aSelf, "em");
  await memory.learn(SCOPE, {
    packId: "pk-3",
    pos: 3_005,
    learning: learning({ addresses: [{ a: "Jiyu", b: "Jiho", aSelf: "tớ", aToB: "cậu" }] }),
  });
  const profile = await stores.series.get(SCOPE.seriesKey);
  assert.deepEqual(
    profile?.pronouns.map((rule) => [rule.a, rule.aSelf, rule.aToB, rule.source]),
    [
      ["Jiho", "anh", "em", "manual"],
      ["Jiyu", "tớ", "cậu", "learned"],
    ],
  );
});

test("memory off, missing stores or a failing store: no context and no learning", async () => {
  withMemory({ enabled: false });
  const memory = memoryOver();
  assert.equal(await memory.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 }), null);
  await memory.learn(SCOPE, {
    packId: "pk-1",
    pos: 0,
    learning: learning({ lang: "ko", terms: [{ original: "a", translation: "b", note: "" }] }),
  });
  assert.equal(await stores.series.get(SCOPE.seriesKey), undefined);
  assert.deepEqual(await stores.glossary.forSeries(SCOPE.seriesKey), []);

  withMemory({ enabled: true });
  const { glossary: _glossary, ...bare } = stores;
  assert.equal(await memoryOver(bare).context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 }), null);

  const broken = {
    ...stores,
    series: {
      ...stores.series,
      get: () => Promise.reject(new CtvError("store.io", "disk gone")),
    },
  } as EngineStores;
  const captured = captureLogger();
  const failing = createSeriesMemory({ clock, log: captured.log, settings, stores: broken });
  assert.equal(await failing.context(SCOPE, { contentKey: "s:A", docOrder: 0, pos: 0 }), null);
  assert.ok(
    captured.entries.some((entry) => entry.code === "store.io" && /without context/u.test(entry.msg)),
  );
  // A failed learning step is logged and does not block the next one.
  await failing.learn(SCOPE, { packId: "pk-1", pos: 0, learning: learning({ summary: "x" }) });
  await failing.learn(SCOPE, { packId: "pk-2", pos: 1, learning: learning({ lang: "ko" }) });
  assert.ok(captured.entries.some((entry) => /learning failed/u.test(entry.msg)));
  assert.deepEqual((await stores.series.get(SCOPE.seriesKey))?.langVotes, { ko: 1 });
  assert.equal(logs.filter((entry) => entry.level === "error").length, 0);
});

test("a page is stored once per position; cacheCleared() forgets that it was", async () => {
  let puts = 0;
  const pages = {
    ...stores.pages,
    put: (record: PageRecord): Promise<void> => {
      puts += 1;
      return stores.pages.put(record);
    },
  };
  const counted = memoryOver({ ...stores, pages });
  await counted.context(SCOPE, { contentKey: "s:A", docOrder: 1, pos: 1_000 });
  await counted.context(SCOPE, { contentKey: "s:A", docOrder: 1, pos: 1_004 });
  assert.equal(puts, 1);
  await counted.context(SCOPE, { contentKey: "s:A", docOrder: 2, pos: 2_000 });
  assert.equal(puts, 2, "a new position is written");
  counted.cacheCleared();
  await counted.context(SCOPE, { contentKey: "s:A", docOrder: 2, pos: 2_000 });
  assert.equal(puts, 3);
  await counted.idle();
});
