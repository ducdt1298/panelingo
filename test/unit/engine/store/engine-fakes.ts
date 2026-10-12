// Shared fakes for the engine-core tests: a manual clock, in-memory stores, recording services, fake factories and
// FakeBrowser helpers that boot the engine the way src/engine/main.ts does (A.5 L1).

import type { CtvDatabase } from "../../../../src/platform/db-schema.ts";
import { createLogger, type Logger } from "../../../../src/platform/log.ts";
import { onMessageFor } from "../../../../src/platform/messaging.ts";
import type {
  ApiHealth,
  ChapterStore,
  Clock,
  EngineStores,
  FrameSink,
  GlossaryStore,
  ImageStore,
  KvStore,
  LogStore,
  ModelStore,
  PageStore,
  PatchStore,
  Pipeline,
  SeriesStore,
  ServiceFactories,
  TextDetector,
  TranslationStore,
  UnitStore,
  UploadCounter,
} from "../../../../src/engine/contracts.ts";
import { createReadyGate, type ReadyGate } from "../../../../src/engine/ready-gate.ts";
import { mergeTranslation } from "../../../../src/engine/store/translations.ts";
import { INITIAL_HEALTH, isSendable, type HealthReading } from "../../../../src/shared/core/health.ts";
import type { ErrorInfo } from "../../../../src/shared/errors.ts";
import type { Gfx } from "../../../../src/shared/gfx.ts";
import { PROTOCOL_VERSION, type CsToEngineMap, type ImageSubmit } from "../../../../src/shared/protocol.ts";
import type {
  ChapterRecord,
  GlossaryEntry,
  ImageRecord,
  KvKey,
  KvMap,
  ModelIntegrityRecord,
  PageRecord,
  PatchRecord,
  SeriesRecord,
  TranslationRecord,
  UnitsRecord,
} from "../../../../src/shared/records.ts";
import { DEFAULT_SETTINGS, type Settings, type SiteSettings } from "../../../../src/shared/settings.ts";
import type { ApiReadiness, EngineStatus, LogEntry } from "../../../../src/shared/types.ts";
import { makeProbe } from "../../../../src/shared/wire.ts";
import {
  FakeBrowser,
  type FakeBrowserOptions,
  type FakeContext,
  type FakePort,
} from "../../../support/chrome-fake.ts";

/* ------------------------------------------------------------------ time */

export async function flushTurns(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
  live: boolean;
}

/** Deterministic Clock: timers fire only when the test advances time. */
export class ManualClock implements Clock {
  t: number;
  #seq = 0;
  readonly #timers: Timer[] = [];

  constructor(start = Date.UTC(2026, 9, 10, 9, 0, 0)) {
    this.t = start;
  }

  readonly now = (): number => this.t;

  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer: Timer = { at: this.t + Math.max(0, ms), seq: this.#seq, fn, live: true };
    this.#seq += 1;
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  /** Live timers. */
  pending(): number {
    return this.#timers.filter((timer) => timer.live).length;
  }

  /** Due time of the next live timer, or null. */
  nextAt(): number | null {
    const next = this.#next(Number.POSITIVE_INFINITY);
    return next === undefined ? null : next.at;
  }

  #next(limit: number): Timer | undefined {
    return this.#timers
      .filter((timer) => timer.live && timer.at <= limit)
      .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
  }

  /** Moves time forward, firing due timers in order and letting promise chains run in between. */
  async advance(ms: number, turns = 10): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await flushTurns(turns);
      const due = this.#next(target);
      if (due === undefined) break;
      this.t = due.at;
      due.live = false;
      due.fn();
    }
    this.t = target;
    await flushTurns(turns);
  }
}

/* ------------------------------------------------------------------ logging */

export function captureLogger(): { log: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    log: createLogger("engine", { minLevel: "debug", sinks: [(entry) => entries.push(entry)] }),
    entries,
  };
}

/* ------------------------------------------------------------------ stores */

export interface MemoryStores extends EngineStores {
  readonly data: {
    images: Map<string, ImageRecord>;
    aliases: Map<string, string>;
    units: Map<string, UnitsRecord>;
    translations: Map<string, TranslationRecord>;
    kv: Map<string, unknown>;
    logs: LogEntry[];
    models: Map<string, ModelIntegrityRecord>;
    patches: Map<string, PatchRecord>;
    series: Map<string, SeriesRecord>;
    /** Keyed `${seriesKey}|${orig}`. */
    glossary: Map<string, GlossaryEntry>;
    chapters: Map<string, ChapterRecord>;
    /** Keyed `${chapterKey}|${contentKey}`. */
    pages: Map<string, PageRecord>;
  };
  readonly series: SeriesStore;
  readonly glossary: GlossaryStore;
  readonly chapters: ChapterStore;
  readonly pages: PageStore;
  closed: boolean;
}

/** EngineStores without IndexedDB (db is a dummy: only the real store/* code touches it). */
export function memoryStores(): MemoryStores {
  const data: MemoryStores["data"] = {
    images: new Map(),
    aliases: new Map(),
    units: new Map(),
    translations: new Map(),
    kv: new Map(),
    logs: [],
    models: new Map(),
    patches: new Map(),
    series: new Map(),
    glossary: new Map(),
    chapters: new Map(),
    pages: new Map(),
  };
  const images: ImageStore = {
    get: (contentKey) => Promise.resolve(data.images.get(contentKey)),
    put: (record) => {
      data.images.set(record.contentKey, record);
      return Promise.resolve();
    },
    touch: (contentKey, at) => {
      const record = data.images.get(contentKey);
      if (record !== undefined) data.images.set(contentKey, { ...record, lastUsedAt: at });
      return Promise.resolve();
    },
    alias: (urlKey) => Promise.resolve(data.aliases.get(urlKey)),
    putAlias: (urlKey, contentKey) => {
      data.aliases.set(urlKey, contentKey);
      return Promise.resolve();
    },
  };
  const units: UnitStore = {
    get: (contentKey) => Promise.resolve(data.units.get(contentKey)),
    put: (record) => {
      data.units.set(record.contentKey, record);
      return Promise.resolve();
    },
  };
  const key = (record: Pick<TranslationRecord, "contentKey" | "unitKey">): string =>
    `${record.contentKey}|${record.unitKey}`;
  const translations: TranslationStore = {
    forImage: (contentKey) =>
      Promise.resolve([...data.translations.values()].filter((record) => record.contentKey === contentKey)),
    put: (record) => {
      data.translations.set(key(record), mergeTranslation(data.translations.get(key(record)), record));
    },
    flush: () => Promise.resolve(),
  };
  const kv: KvStore = {
    get: <K extends KvKey>(name: K) => Promise.resolve(data.kv.get(name) as KvMap[K] | undefined),
    set: (name, value) => {
      data.kv.set(name, structuredClone(value));
      return Promise.resolve();
    },
  };
  const logs: LogStore = {
    append: (entry) => {
      data.logs.push(entry);
    },
    flush: () => Promise.resolve(),
    recent: (limit) => Promise.resolve(data.logs.slice(-limit)),
  };
  const models: ModelStore = {
    get: (file) => Promise.resolve(data.models.get(file)),
    put: (record) => {
      data.models.set(record.file, record);
      return Promise.resolve();
    },
  };
  const patches: PatchStore = {
    forImage: (contentKey) =>
      Promise.resolve([...data.patches.values()].filter((record) => record.contentKey === contentKey)),
    put: (record) => {
      data.patches.set(`${record.contentKey}|${record.unitKey}`, record);
      return Promise.resolve();
    },
  };
  // Series memory stores with the semantics of the IndexedDB ones (records are copied in and out).
  const series: SeriesStore = {
    get: (seriesKey) => Promise.resolve(structuredClone(data.series.get(seriesKey))),
    put: (record) => {
      data.series.set(record.seriesKey, structuredClone(record));
      return Promise.resolve();
    },
    all: () => Promise.resolve([...data.series.values()].map((record) => structuredClone(record))),
    update: (seriesKey, change) => {
      const next = change(structuredClone(data.series.get(seriesKey)));
      if (next !== undefined) data.series.set(seriesKey, structuredClone({ ...next, seriesKey }));
      return Promise.resolve(structuredClone(data.series.get(seriesKey)));
    },
  };
  const glossaryKey = (seriesKey: string, orig: string): string => `${seriesKey}|${orig}`;
  const glossary: GlossaryStore = {
    forSeries: (seriesKey) =>
      Promise.resolve(
        [...data.glossary.values()]
          .filter((entry) => entry.seriesKey === seriesKey)
          .sort((a, b) => (a.orig < b.orig ? -1 : a.orig > b.orig ? 1 : 0))
          .map((entry) => structuredClone(entry)),
      ),
    put: (entry) => {
      data.glossary.set(glossaryKey(entry.seriesKey, entry.orig), structuredClone(entry));
      return Promise.resolve();
    },
    delete: (seriesKey, orig) => {
      data.glossary.delete(glossaryKey(seriesKey, orig));
      return Promise.resolve();
    },
    update: (seriesKey, origs, change) => {
      let changed = 0;
      for (const orig of new Set(origs)) {
        const key = glossaryKey(seriesKey, orig);
        const existing = data.glossary.get(key);
        const next = change(orig, structuredClone(existing));
        if (next === undefined || (next === null && existing === undefined)) continue;
        if (next === null) data.glossary.delete(key);
        else data.glossary.set(key, structuredClone({ ...next, seriesKey, orig }));
        changed += 1;
      }
      return Promise.resolve(changed);
    },
  };
  const chapters: ChapterStore = {
    get: (chapterKey) => Promise.resolve(structuredClone(data.chapters.get(chapterKey))),
    put: (record) => {
      data.chapters.set(record.chapterKey, structuredClone(record));
      return Promise.resolve();
    },
    update: (chapterKey, change) => {
      const next = change(structuredClone(data.chapters.get(chapterKey)));
      if (next !== undefined) data.chapters.set(chapterKey, structuredClone({ ...next, chapterKey }));
      return Promise.resolve(structuredClone(data.chapters.get(chapterKey)));
    },
  };
  const pages: PageStore = {
    forChapter: (chapterKey) =>
      Promise.resolve(
        [...data.pages.values()]
          .filter((page) => page.chapterKey === chapterKey)
          .sort((a, b) => a.orderKey - b.orderKey)
          .map((page) => structuredClone(page)),
      ),
    put: (record) => {
      data.pages.set(`${record.chapterKey}|${record.contentKey}`, structuredClone(record));
      return Promise.resolve();
    },
  };
  const stores: MemoryStores = {
    db: {} as unknown as CtvDatabase,
    images,
    units,
    translations,
    kv,
    logs,
    models,
    patches,
    series,
    glossary,
    chapters,
    pages,
    data,
    closed: false,
    close: () => {
      stores.closed = true;
      return Promise.resolve();
    },
  };
  return stores;
}

/* ------------------------------------------------------------------ services */

export interface FakeHealth extends ApiHealth {
  set(readiness: ApiReadiness, model?: string | null): void;
  readonly busy: boolean[];
  readonly reports: ErrorInfo[];
  refreshes: number;
  stopped: boolean;
  /** What checkedAt() answers (epoch ms of the last /models check; 0 = never). */
  checkedAtValue: number;
}

export function fakeHealth(readiness: ApiReadiness = "ready"): FakeHealth {
  let reading: HealthReading = { ...INITIAL_HEALTH, readiness, model: DEFAULT_SETTINGS.api.model };
  const listeners = new Set<(reading: HealthReading) => void>();
  const waiters: Array<() => void> = [];
  const health: FakeHealth = {
    busy: [],
    reports: [],
    refreshes: 0,
    checkedAtValue: 0,
    stopped: false,
    set: (next, model) => {
      reading = { ...reading, readiness: next, model: model === undefined ? reading.model : model };
      for (const listener of [...listeners]) listener(reading);
      if (isSendable(next)) for (const resolve of waiters.splice(0)) resolve();
    },
    reading: () => reading,
    sendable: () => isSendable(reading.readiness),
    whenSendable: () =>
      isSendable(reading.readiness) ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)),
    report: (error) => {
      health.reports.push(error);
    },
    checkedAt: () => health.checkedAtValue,
    setBusy: (busy) => {
      health.busy.push(busy);
    },
    refresh: () => {
      health.refreshes += 1;
      return Promise.resolve(reading);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: () => {
      health.stopped = true;
    },
  };
  return health;
}

export interface FakeDetector extends TextDetector {
  state: TextDetector["state"];
  current: ReturnType<TextDetector["state"]>;
  releases: number;
  warmups: number;
}

export function fakeDetector(): FakeDetector {
  const detector: FakeDetector = {
    current: { backend: "none", state: "unloaded", canary: "pending" },
    releases: 0,
    warmups: 0,
    state: () => detector.current,
    detect: () => Promise.reject(new Error("fake detector: no detection")),
    unitsFrom: () => [],
    warmup: () => {
      detector.warmups += 1;
      return Promise.resolve();
    },
    release: () => {
      detector.releases += 1;
      detector.current = { ...detector.current, state: "unloaded" };
      return Promise.resolve();
    },
  };
  return detector;
}

export function fakeUploads(today = 0, bytesToday = 0): UploadCounter {
  return { record: () => undefined, today: () => ({ today, bytesToday }) };
}

export type PipelineCall =
  | { kind: "submit"; frameKey: string; submit: ImageSubmit }
  | { kind: "priority"; frameKey: string; items: Array<{ imageKey: string; priority: number }> }
  | { kind: "forget"; frameKey: string; imageKeys: string[] }
  | { kind: "retry"; frameKey: string; imageKey: string; unitKey: string | undefined }
  | { kind: "retranslate"; scope: { tabId: number; contentKey?: string; unitKey?: string } }
  | {
      kind: "edit";
      target: { frameKey: string; imageKey: string } | { contentKey: string };
      unitKey: string;
      translation: string | null;
    }
  | { kind: "frameGone"; frameKey: string }
  | { kind: "frameReplaced"; frameKey: string }
  | { kind: "cacheCleared" }
  | { kind: "throttle"; value: number; forMs: number };

export interface RecordingPipeline extends Pipeline {
  readonly calls: PipelineCall[];
  /** The FrameSink of every submit, in order. */
  readonly sinks: FrameSink[];
  idleValue: boolean;
  queue: EngineStatus["queue"];
  retranslated: number;
}

export function recordingPipeline(): RecordingPipeline {
  const pipeline: RecordingPipeline = {
    calls: [],
    sinks: [],
    idleValue: true,
    retranslated: 3,
    queue: {
      queued: 0,
      inFlight: 0,
      urgentInFlight: 0,
      done: 0,
      failed: 0,
      pausedBy: null,
      concurrency: 2,
      boxBudget: 20,
    },
    submit: (frame, submit) => {
      pipeline.sinks.push(frame);
      pipeline.calls.push({ kind: "submit", frameKey: frame.info.frameKey, submit });
    },
    priority: (frameKey, items) => {
      pipeline.calls.push({ kind: "priority", frameKey, items: [...items] });
    },
    forget: (frameKey, imageKeys) => {
      pipeline.calls.push({ kind: "forget", frameKey, imageKeys: [...imageKeys] });
    },
    retry: (frameKey, imageKey, unitKey) => {
      pipeline.calls.push({ kind: "retry", frameKey, imageKey, unitKey });
    },
    retranslate: (scope) => {
      pipeline.calls.push({ kind: "retranslate", scope });
      return pipeline.retranslated;
    },
    edit: (target, unitKey, translation) => {
      pipeline.calls.push({ kind: "edit", target, unitKey, translation });
      return Promise.resolve();
    },
    frameGone: (frameKey) => {
      pipeline.calls.push({ kind: "frameGone", frameKey });
    },
    frameReplaced: (frame) => {
      pipeline.calls.push({ kind: "frameReplaced", frameKey: frame.info.frameKey });
    },
    queueStatus: () => ({ ...pipeline.queue }),
    idle: () => pipeline.idleValue,
    cacheCleared: () => {
      pipeline.calls.push({ kind: "cacheCleared" });
    },
    throttle: (value, forMs) => {
      pipeline.calls.push({ kind: "throttle", value, forMs });
    },
  };
  return pipeline;
}

export function unusedGfx(): Gfx {
  const fail = (): never => {
    throw new Error("fake gfx: not used by engine-core tests");
  };
  return { createCanvas: fail, encodeJpeg: fail, encodePng: fail, loadImage: fail };
}

export interface FakeServices {
  stores: EngineStores;
  health: FakeHealth;
  detector: FakeDetector;
  pipeline: RecordingPipeline;
  /** Factory calls in order. */
  order: string[];
}

/** Factories whose services are recording fakes; `openStores` defaults to in-memory stores. */
export function fakeFactories(options: { stores?: () => Promise<EngineStores>; openFails?: Error } = {}): {
  factories: ServiceFactories;
  services: FakeServices;
} {
  const services: FakeServices = {
    stores: memoryStores(),
    health: fakeHealth(),
    detector: fakeDetector(),
    pipeline: recordingPipeline(),
    order: [],
  };
  const factories: ServiceFactories = {
    openStores: async () => {
      services.order.push("openStores");
      if (options.openFails !== undefined) throw options.openFails;
      if (options.stores !== undefined) services.stores = await options.stores();
      return services.stores;
    },
    createHealth: () => {
      services.order.push("createHealth");
      return services.health;
    },
    createAcquirer: () => {
      services.order.push("createAcquirer");
      return { acquire: () => Promise.reject(new Error("fake acquirer")) };
    },
    createDecoder: () => {
      services.order.push("createDecoder");
      return {
        contentKeyOf: () => Promise.resolve("s:0"),
        decode: () => Promise.reject(new Error("fake decoder")),
      };
    },
    createDetector: () => {
      services.order.push("createDetector");
      return services.detector;
    },
    createComposite: () => {
      services.order.push("createComposite");
      return { build: () => Promise.resolve({ ok: false as const, reason: "empty" as const }) };
    },
    createUploads: () => {
      services.order.push("createUploads");
      return fakeUploads(2, 1_500_000);
    },
    createTranslator: () => {
      services.order.push("createTranslator");
      return { translate: () => Promise.reject(new Error("fake translator")) };
    },
    createPipeline: () => {
      services.order.push("createPipeline");
      return services.pipeline;
    },
    createGfx: () => {
      services.order.push("createGfx");
      return unusedGfx();
    },
  };
  return { factories, services };
}

/* ------------------------------------------------------------------ browser */

export interface SwStub {
  settings: Settings;
  sites: Record<string, SiteSettings>;
  /** sw:get-settings answers (false: the SW has no handler for it). */
  answerSettings: boolean;
  idleCalls: number[];
  idleReply: boolean;
  pings: number;
}

/** A FakeBrowser with a started SW that answers the engine's one-shots. */
export async function startBrowser(
  options: FakeBrowserOptions = {},
  sw: Partial<SwStub> = {},
): Promise<{ browser: FakeBrowser; sw: FakeContext; stub: SwStub }> {
  const browser = new FakeBrowser(options);
  browser.install();
  const swCtx = await browser.startServiceWorker();
  const stub: SwStub = {
    settings: structuredClone(DEFAULT_SETTINGS),
    sites: {},
    answerSettings: true,
    idleCalls: [],
    idleReply: true,
    pings: 0,
    ...sw,
  };
  swCtx.run(() =>
    onMessageFor("sw", {
      "sw:get-settings": () => {
        if (!stub.answerSettings) throw new Error("settings unavailable");
        return { settings: stub.settings, sites: stub.sites };
      },
      "sw:ping": (payload) => {
        stub.pings += 1;
        return { probe: payload.probe };
      },
      "sw:engine-idle": (payload) => {
        stub.idleCalls.push(payload.idleSinceMs);
        return { closing: stub.idleReply };
      },
    }),
  );
  return { browser, sw: swCtx, stub };
}

/** What src/engine/main.ts does synchronously at the top of the offscreen document. */
export function installGate(
  ctx: FakeContext,
  log?: Logger,
  limits = { msgs: 500, bytes: 64 << 20 },
): ReadyGate {
  return ctx.run(() => {
    const gate = createReadyGate({
      maxMsgsPerPort: limits.msgs,
      maxBytesPerPort: limits.bytes,
      ...(log === undefined ? {} : { log }),
    });
    ctx.onConnect.addListener((port) => {
      if (port.name === "engine" || port.name === "ui") gate.adopt(port as unknown as chrome.runtime.Port);
    });
    onMessageFor("engine", gate.handlers, { allow: gate.allow });
    return gate;
  });
}

export async function createOffscreen(sw: FakeContext): Promise<void> {
  await sw.run(() =>
    sw.ext.offscreen.createDocument({
      url: "engine/offscreen.html",
      reasons: ["WORKERS", "BLOBS"],
      justification: "test",
    }),
  );
}

export interface PortProbe {
  readonly ctx: FakeContext;
  readonly tabId: number;
  readonly port: FakePort;
  readonly received: Array<{ type: string } & Record<string, unknown>>;
  /** lastError of each onDisconnect (null = closed by the other side). */
  readonly disconnects: Array<string | null>;
  post(message: object): void;
  of(type: string): Array<{ type: string } & Record<string, unknown>>;
}

function probe(ctx: FakeContext, tabId: number, port: FakePort, browser: FakeBrowser): PortProbe {
  const received: PortProbe["received"] = [];
  const disconnects: Array<string | null> = [];
  port.onMessage.addListener((message) => {
    received.push(message as { type: string } & Record<string, unknown>);
  });
  port.onDisconnect.addListener(() => {
    disconnects.push(browser.lastError?.message ?? null);
  });
  return {
    ctx,
    tabId,
    port,
    received,
    disconnects,
    post: (message) => ctx.run(() => port.postMessage(message)),
    of: (type) => received.filter((message) => message.type === type),
  };
}

/** A content script in a new tab that opens Port `name` to the engine. */
export function connectContent(browser: FakeBrowser, url: string, name = "engine"): PortProbe {
  const tab = browser.openTab(url);
  const ctx = browser.injectContent(tab.id);
  const port = ctx.run(() => chrome.runtime.connect({ name })) as unknown as FakePort;
  return probe(ctx, tab.id, port, browser);
}

/** An extension page (popup by default) that opens Port "ui". */
export function connectUi(browser: FakeBrowser, path = "ui/popup.html"): PortProbe {
  const ctx = browser.openExtensionPage("popup", path);
  const port = ctx.run(() => chrome.runtime.connect({ name: "ui" })) as unknown as FakePort;
  return probe(ctx, -1, port, browser);
}

export function csHello(mode: "auto" | "manual" = "auto"): { type: "cs:hello" } & CsToEngineMap["cs:hello"] {
  return {
    type: "cs:hello",
    v: PROTOCOL_VERSION,
    build: "test",
    probe: makeProbe(),
    mode,
    page: { title: "Chapter 1", layout: "webtoon", visible: true, dpr: 1 },
  };
}

export function imageSubmit(
  i: number,
  extra: Partial<ImageSubmit> = {},
): { type: "img:submit" } & ImageSubmit {
  return {
    type: "img:submit",
    imageKey: `${i}.0`,
    src: `https://cdn.example/ch1/${i}.jpg`,
    natural: { w: 800, h: 2_000 },
    displayed: { w: 800, h: 2_000 },
    element: "img",
    priority: i,
    pos: { docOrder: i, srcGen: 0, yTop: i * 2_000 },
    acquire: "url",
    ...extra,
  };
}

export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}
