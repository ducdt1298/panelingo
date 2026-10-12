// en:* one-shots, Port "ui" messages, EngineStatus assembly and its throttled push.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleStatus,
  buildTranscript,
  createStatusPusher,
  createUiHandlers,
  handleUiMessage,
  STATUS_MIN_INTERVAL_MS,
  statusKey,
  type Lifecycle,
  type UiHandlerDeps,
} from "../../../src/engine/handlers-ui.ts";
import { createFrameRegistry, createUiRegistry, type FrameRegistry } from "../../../src/engine/ports.ts";
import { placeholderStatus, type EnginePort, type UiPort } from "../../../src/engine/ready-gate.ts";
import { createSettingsCache } from "../../../src/engine/settings-cache.ts";
import { openStores } from "../../../src/engine/store/db.ts";
import type { EngineStores } from "../../../src/engine/contracts.ts";
import type { Handlers } from "../../../src/platform/messaging.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { EngineApi, EngineToCs, EngineToUi, ReqOf, ResOf } from "../../../src/shared/protocol.ts";
import { learnTerm, type TermSighting } from "../../../src/shared/core/memory.ts";
import type { TranslationRecord } from "../../../src/shared/records.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import type { EngineStatus, GlossaryEdit } from "../../../src/shared/types.ts";
import { isProbe, makeProbe } from "../../../src/shared/wire.ts";
import {
  captureLogger,
  fakeDetector,
  fakeHealth,
  fakeUploads,
  ManualClock,
  memoryStores,
  recordingPipeline,
  type RecordingPipeline,
} from "./store/engine-fakes.ts";

const SENDER: chrome.runtime.MessageSender = { id: "x", url: "chrome-extension://x/ui/popup.html" };

async function call<K extends keyof EngineApi>(
  handlers: Handlers<EngineApi>,
  type: K,
  payload: ReqOf<EngineApi, K>,
): Promise<ResOf<EngineApi, K>> {
  const handler = handlers[type];
  assert.ok(handler !== undefined, type);
  return await handler(payload, SENDER);
}

function postingPort<M>(sent: M[]): EnginePort & UiPort {
  return {
    raw: {},
    codec: "sc",
    closed: false,
    post: (message: M) => {
      sent.push(message);
      return true;
    },
    on: () => () => undefined,
    request: () => Promise.reject(new Error("unused")),
    onClose: () => undefined,
    close: () => undefined,
  } as unknown as EnginePort & UiPort;
}

function framesWith(clock: ManualClock, sent: EngineToCs[]): FrameRegistry {
  const frames = createFrameRegistry({
    clock,
    log: captureLogger().log,
    events: { frameGone: () => undefined, frameReplaced: () => undefined },
  });
  const url = "https://reader.example/ch/1";
  const frame = frames.open({
    kind: "engine",
    port: postingPort(sent),
    sender: { id: "x", url, frameId: 0, documentId: "D" },
    frameKey: "7:0:D",
    tabId: 7,
    frameId: 0,
    documentId: "D",
    url,
    origin: "https://reader.example",
    hello: null,
  });
  // Page order: image "b" sits above image "a".
  frame.noteSubmit("a", { docOrder: 2, srcGen: 0, yTop: 4_000 });
  frame.noteSubmit("b", { docOrder: 1, srcGen: 0, yTop: 0 });
  frame.noteSubmit("pending", { docOrder: 3, srcGen: 0, yTop: 9_000 });
  frame.post({ type: "img:done", imageKey: "a", contentKey: "s:A", counts: {} });
  frame.post({ type: "img:bulk", imageKey: "b", contentKey: "s:B", natural: { w: 1, h: 1 }, units: [] });
  sent.length = 0;
  return frames;
}

function deps(
  over: Partial<UiHandlerDeps> = {},
): UiHandlerDeps & { pipeline: RecordingPipeline; lifecycle: Lifecycle & { closing: boolean } } {
  const clock = new ManualClock();
  const pipeline = recordingPipeline();
  const lifecycle = {
    closing: false,
    phase: () => (lifecycle.closing ? ("closing" as const) : ("ready" as const)),
    prepareClose: () => {
      lifecycle.closing = pipeline.idleValue;
      return lifecycle.closing;
    },
  };
  return {
    log: captureLogger().log,
    settings: createSettingsCache({ clock }),
    stores: memoryStores(),
    frames: framesWith(clock, []),
    status: () => placeholderStatus("ready"),
    ...over,
    pipeline,
    lifecycle,
  };
}

function translation(
  contentKey: string,
  unitKey: string,
  extra: Partial<TranslationRecord> = {},
): TranslationRecord {
  return {
    contentKey,
    unitKey,
    seriesKey: null,
    type: "dialogue",
    speaker: "",
    original: `orig ${unitKey}`,
    translation: `vi ${unitKey}`,
    manualTranslation: null,
    manual: 0,
    status: "ok",
    lang: "ko",
    model: "m",
    promptVersion: 1,
    attempts: 1,
    updatedAt: 1,
    lastUsedAt: 1,
    ...extra,
  };
}

test("assembleStatus: one snapshot from every service; /models pauses show in queue.pausedBy", () => {
  const health = fakeHealth("ready");
  const detector = fakeDetector();
  const pipeline = recordingPipeline();
  const sources = {
    phase: () => "ready" as const,
    health,
    checkedAt: () => 1234,
    detector,
    pipeline,
    uploads: fakeUploads(3, 4_000),
  };
  const status = assembleStatus(sources);
  assert.equal(status.phase, "ready");
  assert.equal(status.build, __BUILD_ID__);
  assert.deepEqual(status.api, {
    readiness: "ready",
    model: DEFAULT_SETTINGS.api.model,
    cause: null,
    checkedAt: 1234,
  });
  assert.deepEqual(status.queue, pipeline.queue);
  assert.deepEqual(status.uploads, { today: 3, bytesToday: 4_000 });
  assert.deepEqual(status.detector, detector.current);

  health.set("unreachable");
  assert.equal(assembleStatus(sources).queue.pausedBy, "api.unreachable");
  health.set("unauthorized");
  assert.equal(assembleStatus(sources).queue.pausedBy, "api.unauthorized");
  health.set("misconfigured");
  assert.equal(assembleStatus(sources).queue.pausedBy, "api.config");
  health.set("unreachable");
  pipeline.queue = { ...pipeline.queue, pausedBy: "api.rate_limit" };
  assert.equal(assembleStatus(sources).queue.pausedBy, "api.rate_limit", "the pipeline's own reason wins");

  const { log, entries } = captureLogger();
  const broken = assembleStatus({
    ...sources,
    log,
    pipeline: {
      ...pipeline,
      queueStatus: () => {
        throw new Error("bug");
      },
    },
  });
  assert.deepEqual(broken.queue, { ...placeholderStatus("ready").queue, pausedBy: "api.unreachable" });
  assert.ok(entries.some((entry) => entry.msg === "status source threw"));
});

test("status pushes are throttled to one per 250 ms and skipped when nothing changed", async () => {
  const clock = new ManualClock();
  let status: EngineStatus = placeholderStatus("ready");
  const published: EngineStatus[] = [];
  const pusher = createStatusPusher({ clock, compute: () => status, publish: (s) => published.push(s) });
  for (let i = 0; i < 10; i += 1) pusher.markDirty();
  await clock.advance(0);
  assert.equal(published.length, 1);
  status = { ...status, uploads: { today: 1, bytesToday: 1 } };
  pusher.markDirty();
  await clock.advance(STATUS_MIN_INTERVAL_MS - 1);
  assert.equal(published.length, 1, "within the window");
  await clock.advance(1);
  assert.equal(published.length, 2);
  status = { ...status, api: { ...status.api, checkedAt: 99 } };
  pusher.markDirty();
  await clock.advance(STATUS_MIN_INTERVAL_MS);
  assert.equal(published.length, 2, "a new check time alone is not a change");
  assert.equal(statusKey(status), statusKey({ ...status, api: { ...status.api, checkedAt: 1 } }));
  assert.notEqual(
    statusKey(status),
    statusKey({ ...status, api: { ...status.api, cause: "model not listed" } }),
    "a new cause is a change",
  );
  // ≤ 4 per second under a storm of changes.
  for (let i = 0; i < 40; i += 1) {
    status = { ...status, uploads: { today: 10 + i, bytesToday: 1 } };
    pusher.markDirty();
    await clock.advance(25);
  }
  assert.ok(published.length - 2 <= 4, `${published.length - 2} pushes in one second`);
  pusher.stop();
  pusher.markDirty();
  assert.equal(clock.pending(), 0);
});

test("en:settings, en:status, en:ping and en:prepare-close", async () => {
  const d = deps();
  const handlers = createUiHandlers(d);
  const next = structuredClone(DEFAULT_SETTINGS);
  next.api.concurrency = 1;
  assert.deepEqual(await call(handlers, "en:settings", { settings: next, sites: {} }), {});
  assert.equal(d.settings.current().api.concurrency, 1);
  assert.equal((await call(handlers, "en:status", {})).phase, "ready");
  const ping = await call(handlers, "en:ping", { probe: makeProbe() });
  assert.equal(isProbe(ping.probe), true);
  assert.equal(ping.phase, "ready");
  d.pipeline.idleValue = false;
  assert.deepEqual(await call(handlers, "en:prepare-close", {}), { ok: false });
  d.pipeline.idleValue = true;
  assert.deepEqual(await call(handlers, "en:prepare-close", {}), { ok: true });
  assert.equal((await call(handlers, "en:ping", { probe: makeProbe() })).phase, "closing");
});

test("en:edit-unit, en:retranslate and en:jump-to", async () => {
  const sent: EngineToCs[] = [];
  const clock = new ManualClock();
  const d = deps({ frames: framesWith(clock, sent) });
  const handlers = createUiHandlers(d);
  assert.deepEqual(
    await call(handlers, "en:edit-unit", { contentKey: "s:A", unitKey: "u1", translation: "Sửa" }),
    {},
  );
  assert.deepEqual(d.pipeline.calls.at(-1), {
    kind: "edit",
    target: { contentKey: "s:A" },
    unitKey: "u1",
    translation: "Sửa",
  });
  await assert.rejects(
    call(handlers, "en:edit-unit", { contentKey: "s:A", unitKey: "u1", translation: 4 as never }),
    (error: unknown) => error instanceof CtvError && error.code === "engine.protocol",
  );
  assert.deepEqual(await call(handlers, "en:retranslate", { tabId: 7, contentKey: "s:A" }), { queued: 3 });
  assert.deepEqual(d.pipeline.calls.at(-1), { kind: "retranslate", scope: { tabId: 7, contentKey: "s:A" } });

  assert.deepEqual(await call(handlers, "en:jump-to", { tabId: 7, contentKey: "s:B", unitKey: "u9" }), {
    found: true,
  });
  assert.deepEqual(sent, [{ type: "img:scroll-to", imageKey: "b", unitKey: "u9" }]);
  assert.deepEqual(await call(handlers, "en:jump-to", { tabId: 7, contentKey: "s:none", unitKey: "u" }), {
    found: false,
  });
  assert.deepEqual(await call(handlers, "en:jump-to", { tabId: 8, contentKey: "s:B", unitKey: "u" }), {
    found: false,
  });
});

const SERIES = "https://reader.example|lone-hunter";

function isProtocolError(error: unknown): boolean {
  return error instanceof CtvError && error.code === "engine.protocol";
}

function sighting(original: string, translation: string, packId: string, at: number): TermSighting {
  return { original, translation, note: "", packId, at };
}

test("glossary: upsert saves manual entries, confirm accepts suggestions, delete removes; the list ranks them", async () => {
  const clock = new ManualClock();
  const stores = memoryStores();
  const handlers = createUiHandlers(deps({ stores, clock }));
  // A learned entry and a model suggestion already exist.
  const learned = learnTerm(SERIES, undefined, sighting("한지호", "Han Jiho", "p1", 6), 1);
  const candidate = learnTerm(SERIES, undefined, sighting("헌터", "Thợ săn", "p1", 5), 2);
  assert.ok(learned !== null && candidate !== null);
  await stores.glossary.put(learned);
  await stores.glossary.put(candidate);

  assert.deepEqual(await call(handlers, "en:glossary-list", { seriesKey: SERIES }), {
    series: null,
    entries: [learned, candidate],
  });
  assert.deepEqual(
    await call(handlers, "en:glossary-upsert", {
      seriesKey: SERIES,
      entries: [
        { orig: "  한지호 ", translation: "Han Ji-ho", note: "MC" },
        { orig: "길드", translation: "Hội", note: "" },
      ],
    }),
    {},
  );
  const afterUpsert = await call(handlers, "en:glossary-list", { seriesKey: SERIES });
  assert.deepEqual(
    afterUpsert.entries.map((e) => [e.orig, e.state, e.translation, e.note, e.sightings]),
    [
      ["길드", "manual", "Hội", "", 0],
      ["한지호", "manual", "Han Ji-ho", "MC", 1],
      ["헌터", "candidate", "Thợ săn", "", 1],
    ],
    "manual first (most recent first); a manual edit keeps the sightings of the entry it replaces",
  );
  assert.equal(afterUpsert.entries[0]?.firstSeenAt, clock.now());

  await call(handlers, "en:glossary-confirm", { seriesKey: SERIES, origs: ["헌터", "길드", "unknown"] });
  assert.deepEqual(
    (await call(handlers, "en:glossary-list", { seriesKey: SERIES })).entries.map((e) => [e.orig, e.state]),
    [
      ["길드", "manual"],
      ["한지호", "manual"],
      ["헌터", "confirmed"],
    ],
    "confirming a manual or unknown entry changes nothing",
  );

  await call(handlers, "en:glossary-delete", { seriesKey: SERIES, origs: ["길드", "헌터"] });
  assert.deepEqual(
    (await call(handlers, "en:glossary-list", { seriesKey: SERIES })).entries.map((e) => e.orig),
    ["한지호"],
  );

  // An entry without a note is accepted (the note defaults to "").
  await call(handlers, "en:glossary-upsert", {
    seriesKey: SERIES,
    entries: [{ orig: "마나", translation: "mana" } as unknown as GlossaryEdit],
  });
  assert.equal(stores.data.glossary.get(`${SERIES}|마나`)?.note, "");

  const tooMany = Array.from({ length: 501 }, (_, i) => ({ orig: `o${i}`, translation: "t", note: "" }));
  const bad: Array<[keyof EngineApi, unknown]> = [
    ["en:glossary-list", { seriesKey: "not a series key" }],
    ["en:glossary-list", {}],
    ["en:glossary-upsert", { seriesKey: SERIES, entries: [{ orig: "", translation: "x", note: "" }] }],
    ["en:glossary-upsert", { seriesKey: SERIES, entries: [{ orig: "a", translation: "  ", note: "" }] }],
    ["en:glossary-upsert", { seriesKey: SERIES, entries: [{ orig: "a", translation: "b", note: 3 }] }],
    ["en:glossary-upsert", { seriesKey: SERIES, entries: "a" }],
    ["en:glossary-upsert", { seriesKey: SERIES, entries: tooMany }],
    ["en:glossary-delete", { seriesKey: SERIES, origs: [""] }],
    ["en:glossary-delete", { seriesKey: SERIES, origs: [4] }],
    ["en:glossary-confirm", { seriesKey: "ftp://x|y", origs: ["a"] }],
    ["en:series-update", { seriesKey: SERIES, patch: { lang: "klingon" } }],
    ["en:series-update", { seriesKey: SERIES, patch: "x" }],
  ];
  for (const [type, payload] of bad) {
    const handler = handlers[type] as (payload: unknown, sender: chrome.runtime.MessageSender) => unknown;
    await assert.rejects(
      Promise.resolve().then(() => handler(payload, SENDER)),
      isProtocolError,
      `${type} ${JSON.stringify(payload).slice(0, 80)}`,
    );
  }
});

test("en:series-update creates the profile on first use and applies only user fields", async () => {
  const clock = new ManualClock();
  const stores = memoryStores();
  const handlers = createUiHandlers(deps({ stores, clock }));
  await call(handlers, "en:series-update", {
    seriesKey: SERIES,
    patch: {
      title: "Lone Hunter",
      lang: "ko",
      style: { genre: "action", koNames: "han-viet", keepJaHonorifics: false },
      langVotes: { ja: 9 },
      createdAt: 1,
      seriesKey: "https://other.example|x",
    },
  });
  const created = (await call(handlers, "en:glossary-list", { seriesKey: SERIES })).series;
  assert.ok(created !== null);
  assert.equal(created.seriesKey, SERIES);
  assert.equal(created.siteKey, "https://reader.example");
  assert.equal(created.title, "Lone Hunter");
  assert.equal(created.lang, "ko");
  assert.deepEqual(created.style, { genre: "action", koNames: "han-viet", keepJaHonorifics: false });
  assert.deepEqual(created.langVotes, {}, "votes are not user data");
  assert.equal(created.createdAt, clock.now());

  clock.t += 1_000;
  await call(handlers, "en:series-update", { seriesKey: SERIES, patch: { summaryEnabled: false } });
  const updated = await stores.series.get(SERIES);
  assert.equal(updated?.summaryEnabled, false);
  assert.equal(updated?.lang, "ko", "untouched fields stay");
  assert.equal(updated?.updatedAt, clock.now());
});

test("without series memory stores the glossary is empty and edits fail with engine.internal", async () => {
  const { series: _series, glossary: _glossary, ...bare } = memoryStores();
  const handlers = createUiHandlers(deps({ stores: bare }));
  assert.deepEqual(await call(handlers, "en:glossary-list", { seriesKey: SERIES }), {
    series: null,
    entries: [],
  });
  const internal = (error: unknown): boolean => error instanceof CtvError && error.code === "engine.internal";
  await assert.rejects(
    call(handlers, "en:glossary-upsert", {
      seriesKey: SERIES,
      entries: [{ orig: "a", translation: "b", note: "" }],
    }),
    internal,
  );
  await assert.rejects(
    call(handlers, "en:series-update", { seriesKey: SERIES, patch: { lang: "ja" } }),
    internal,
  );
});

test("en:transcript lists stored lines of the tab's images in page order, then reading order", async () => {
  const clock = new ManualClock();
  const stores = memoryStores();
  const d = deps({ stores, frames: framesWith(clock, []) });
  await stores.units.put({
    contentKey: "s:A",
    detectorVersion: "v4s",
    unitsVersion: 1,
    backend: "wasm",
    slices: [],
    rawDetections: [],
    units: [
      {
        unitKey: "a2",
        kind: "bubble",
        bubble: null,
        text: { x1: 0, y1: 0, x2: 1, y2: 1 },
        texts: [],
        orientation: "h",
        glyphPx: 20,
        order: 0,
      },
      {
        unitKey: "a1",
        kind: "bubble",
        bubble: null,
        text: { x1: 0, y1: 0, x2: 1, y2: 1 },
        texts: [],
        orientation: "h",
        glyphPx: 20,
        order: 1,
      },
    ],
    createdAt: 1,
  });
  stores.translations.put(translation("s:A", "a1"));
  stores.translations.put(
    translation("s:A", "a2", { manual: 1, manualTranslation: "sửa tay", status: "manual" }),
  );
  stores.translations.put(translation("s:B", "b1"));
  const transcript = await call(createUiHandlers(d), "en:transcript", { tabId: 7 });
  assert.equal(transcript.tabId, 7);
  assert.deepEqual(
    transcript.items.map((item) => [
      item.pageOrder,
      item.contentKey,
      item.unitKey,
      item.order,
      item.translation,
      item.status,
    ]),
    [
      [0, "s:B", "b1", 0, "vi b1", "ok"],
      [1, "s:A", "a2", 0, "sửa tay", "manual"],
      [1, "s:A", "a1", 1, "vi a1", "ok"],
    ],
  );
  assert.equal(transcript.items[1]?.manual, true);
  // The tab's page (https://reader.example/ch/1, no title) names no series slug: the series is the whole site.
  assert.equal(transcript.seriesKey, "https://reader.example|");
  assert.equal(transcript.chapterKey, "https://reader.example/ch/1");
  assert.deepEqual(await buildTranscript(d, 99), { tabId: 99, seriesKey: null, chapterKey: null, items: [] });
});

test("en:transcript flags lines whose translation misses the glossary rendering of a term", async () => {
  const clock = new ManualClock();
  const stores = memoryStores();
  const d = deps({ stores, frames: framesWith(clock, []) });
  await stores.glossary.put({
    seriesKey: "https://reader.example|",
    orig: "민준",
    translation: "Minjun",
    note: "",
    state: "manual",
    sightings: 0,
    packIds: [],
    alternatives: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
  });
  stores.translations.put(
    translation("s:B", "b1", { original: "민준아, 가자!", translation: "Min-jun, đi thôi!" }),
  );
  stores.translations.put(translation("s:B", "b2", { original: "민준아!", translation: "minjun ơi!" }));
  stores.translations.put(translation("s:B", "b3", { original: "가자!", translation: "Đi thôi!" }));
  const transcript = await call(createUiHandlers(d), "en:transcript", { tabId: 7 });
  assert.deepEqual(
    transcript.items.map((item) => [item.unitKey, item.flags]),
    [
      ["b1", ["inconsistent"]],
      ["b2", []],
      ["b3", []],
    ],
  );
});

test("en:cache-clear clears the stores by scope, then tells the pipeline", async () => {
  globalThis.indexedDB = new IDBFactory();
  const clock = new ManualClock();
  const stores: EngineStores = await openStores({
    clock,
    log: captureLogger().log,
    settings: createSettingsCache({ clock }),
  });
  const d = deps({ stores });
  const handlers = createUiHandlers(d);
  stores.translations.put(translation("s:A", "a1"));
  stores.translations.put(
    translation("s:A", "a2", { manual: 1, manualTranslation: "giữ", status: "manual" }),
  );
  assert.deepEqual(await call(handlers, "en:cache-clear", { scope: "all" }), { deletedRecords: 1 });
  assert.deepEqual(d.pipeline.calls.at(-1), { kind: "cacheCleared" });
  assert.equal(await stores.db.count("translations"), 1);
  await assert.rejects(
    call(handlers, "en:cache-clear", { scope: "everything" as never }),
    (error: unknown) => error instanceof CtvError && error.code === "engine.protocol",
  );
  await stores.close();
});

test("Port ui: ui:hello answers en:hello with the codec; ui:watch subscribes and sends the status at once", () => {
  const ui = createUiRegistry({ log: captureLogger().log });
  const sent: EngineToUi[] = [];
  const client = ui.open({ kind: "ui", port: postingPort(sent), sender: SENDER, hello: null });
  const portDeps = { ui, status: () => placeholderStatus("ready"), log: captureLogger().log };
  handleUiMessage(client, { type: "ui:hello", v: 1, probe: makeProbe(), view: "sidepanel" }, portDeps);
  handleUiMessage(client, { type: "ui:watch", tabId: 7 }, portDeps);
  assert.equal(sent[0]?.type, "en:hello");
  assert.ok(sent[0]?.type === "en:hello" && sent[0].codec === "sc" && isProbe(sent[0].probe));
  assert.equal(sent[1]?.type, "en:status");
  assert.equal(client.watch, 7);
  handleUiMessage(client, { type: "ui:watch", tabId: Number.NaN }, portDeps);
  assert.equal(client.watch, null, "an invalid tab id watches the global status only");
});
