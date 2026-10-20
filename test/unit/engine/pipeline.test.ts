import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  AcquireContext,
  AcquiredImage,
  ApiHealth,
  DecodedImage,
  DetectionResult,
  DetectOptions,
  EraseOutput,
  Eraser,
  EngineStores,
  FrameInfo,
  FrameSink,
  ImageAcquirer,
  ImageDecoder,
  ImageStore,
  KvStore,
  LogStore,
  MemoryScope,
  ModelStore,
  PatchStore,
  PackLearning,
  PackMemory,
  PackReport,
  PackTranslator,
  Pipeline,
  SeriesMemory,
  ServiceFactories,
  SettingsSource,
  TextDetector,
  TranslatePack,
  TranslationStore,
  UiBroadcast,
  UnitOutcomeStatus,
  UnitResult,
  UnitStore,
} from "../../../src/engine/contracts.ts";
import {
  AHEAD_WAIT_FACTOR,
  createPipeline,
  FAST_URGENT_PACK_MAX,
  WARM_UP_MAX_MS,
} from "../../../src/engine/pipeline.ts";
import type { CtvDatabase } from "../../../src/platform/db-schema.ts";
import { createLogger } from "../../../src/platform/log.ts";
import { INITIAL_HEALTH, isSendable, type HealthReading } from "../../../src/shared/core/health.ts";
import { MODEL_PROFILES } from "../../../src/shared/core/model-profile.ts";
import { CtvError, type ErrorInfo } from "../../../src/shared/errors.ts";
import type { EngineToCs, EngineToUi, ImageSubmit } from "../../../src/shared/protocol.ts";
import type {
  ImageRecord,
  PatchRecord,
  TranslationRecord,
  UnitsRecord,
} from "../../../src/shared/records.ts";
import {
  migrateSettings,
  migrateSite,
  type Settings,
  type SiteSettings,
} from "../../../src/shared/settings.ts";
import type { ApiReadiness, LogEntry, Size, UnitGeometry } from "../../../src/shared/types.ts";
import { urlKeyOf } from "../../../src/shared/url-normalize.ts";
import { isWireSafe } from "../../../src/shared/wire.ts";

/* ================================================================== fakes */

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

class ManualClock {
  t = 10_000_000;
  private readonly timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  readonly now = (): number => this.t;
  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  advance(ms: number): void {
    this.t += ms;
    for (const timer of this.timers) {
      if (timer.live && timer.at <= this.t) {
        timer.live = false;
        timer.fn();
      }
    }
  }
}

class FakeSettings implements SettingsSource {
  value: Settings = migrateSettings({ privacy: { ackUploadNoticeAt: 1 } });
  readonly siteValue: SiteSettings = migrateSite({ enabled: true, sourceLang: "ko" }, 0);
  private readonly listeners = new Set<(settings: Settings) => void>();
  current(): Settings {
    return this.value;
  }
  site(): SiteSettings {
    return this.siteValue;
  }
  sites(): Readonly<Record<string, SiteSettings>> {
    return {};
  }
  apply(settings: Settings): void {
    this.value = settings;
    for (const listener of this.listeners) listener(settings);
  }
  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update(mutate: (settings: Settings) => void): void {
    const next = structuredClone(this.value);
    mutate(next);
    this.apply(next);
  }
}

class FakeHealth implements ApiHealth {
  current: HealthReading;
  readonly busy: boolean[] = [];
  readonly reported: ErrorInfo[] = [];
  private readonly listeners = new Set<(reading: HealthReading) => void>();
  private waiters: Array<() => void> = [];
  constructor(readiness: ApiReadiness) {
    this.current = { ...INITIAL_HEALTH, readiness, model: "gpt-4o-mini" };
  }
  reading(): HealthReading {
    return this.current;
  }
  sendable(): boolean {
    return isSendable(this.current.readiness);
  }
  whenSendable(): Promise<void> {
    if (this.sendable()) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  report(error: ErrorInfo): void {
    this.reported.push(error);
  }
  checkedAt(): number {
    return 0;
  }
  setBusy(busy: boolean): void {
    this.busy.push(busy);
  }
  refresh(): Promise<HealthReading> {
    return Promise.resolve(this.current);
  }
  onChange(listener: (reading: HealthReading) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  stop(): void {}
  set(readiness: ApiReadiness): void {
    this.current = { ...this.current, readiness };
    for (const listener of this.listeners) listener(this.current);
    if (this.sendable()) {
      const waiting = this.waiters;
      this.waiters = [];
      for (const resolve of waiting) resolve();
    }
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(label: string): ArrayBuffer {
  return encoder.encode(label).buffer;
}

/** Bytes are the UTF-8 of a label; contentKey = "s:" + label. */
class FakeAcquirer implements ImageAcquirer {
  readonly calls: Array<{ submit: ImageSubmit; ctx: AcquireContext }> = [];
  readonly content = new Map<string, string>();
  readonly failures = new Map<string, CtvError>();
  /** When set, acquisitions wait until release() is called (oldest first). */
  hold = false;
  private readonly held: Array<() => void> = [];
  acquire(submit: ImageSubmit, ctx: AcquireContext): Promise<AcquiredImage> {
    this.calls.push({ submit, ctx });
    const failure = this.failures.get(submit.src);
    if (failure !== undefined) return Promise.reject(failure);
    const label = this.content.get(submit.src) ?? submit.src;
    const image: AcquiredImage = {
      bytes: bytesOf(label),
      mime: "image/png",
      source: submit.acquire === "bytes" ? "bytes" : "url",
      lowRes: false,
      url: submit.src,
    };
    if (!this.hold) return Promise.resolve(image);
    return new Promise<AcquiredImage>((resolve) => this.held.push(() => resolve(image)));
  }
  release(): void {
    this.held.shift()?.();
  }
}

interface FakeDecoded extends DecodedImage {
  released: number;
}

class FakeDecoder implements ImageDecoder {
  hashed = 0;
  readonly decoded: FakeDecoded[] = [];
  readonly sizes = new Map<string, Size>();
  contentKeyOf(bytes: ArrayBuffer): Promise<string> {
    this.hashed += 1;
    return Promise.resolve(`s:${decoder.decode(bytes)}`);
  }
  decode(_image: AcquiredImage, contentKey: string): Promise<DecodedImage> {
    const size = this.sizes.get(contentKey) ?? { w: 800, h: 1200 };
    const decoded: FakeDecoded = {
      contentKey,
      size,
      bitmap: { width: size.w, height: size.h, close() {} },
      released: 0,
      release() {
        decoded.released += 1;
      },
    };
    this.decoded.push(decoded);
    return Promise.resolve(decoded);
  }
  /** Decoded images not released yet. */
  open(): FakeDecoded[] {
    return this.decoded.filter((d) => d.released === 0);
  }
}

class FakeDetector implements TextDetector {
  readonly calls: string[] = [];
  readonly options: DetectOptions[] = [];
  readonly units = new Map<string, UnitGeometry[]>();
  readonly failures = new Map<string, CtvError>();
  /** Detection of these images waits until the promise resolves (an image still being detected). */
  readonly holds = new Map<string, Promise<void>>();
  state(): ReturnType<TextDetector["state"]> {
    return { backend: "webgpu", state: "ready", canary: "pass" };
  }
  async detect(image: DecodedImage, options: DetectOptions): Promise<DetectionResult> {
    this.calls.push(image.contentKey);
    this.options.push(options);
    await this.holds.get(image.contentKey);
    const failure = this.failures.get(image.contentKey);
    if (failure !== undefined) throw failure;
    return {
      backend: "webgpu",
      detectorVersion: "v4s:test",
      slices: [{ y1: 0, y2: image.size.h }],
      rawDetections: [],
      units: this.units.get(image.contentKey) ?? [],
      timings: { inferMs: [1], totalMs: 1 },
    };
  }
  unitsFrom(): UnitGeometry[] {
    return [];
  }
  warmup(): Promise<void> {
    return Promise.resolve();
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
}

interface TranslateCall {
  readonly pack: TranslatePack;
  readonly keys: string[];
  emit(unitKey: string, status?: UnitOutcomeStatus, translation?: string, contentKey?: string): void;
  emitAll(status?: UnitOutcomeStatus): void;
  resolve(patch?: Partial<PackReport>): void;
  reject(error: Error): void;
}

class FakeTranslator implements PackTranslator {
  readonly calls: TranslateCall[] = [];
  /** Answer every unit "ok" at once. */
  auto = true;
  translate(pack: TranslatePack, onUnit: (result: UnitResult) => void): Promise<PackReport> {
    const done = Promise.withResolvers<PackReport>();
    const call: TranslateCall = {
      pack,
      keys: pack.units.map((u) => u.unitKey),
      emit(unitKey, status = "ok", text = `vi:${unitKey}`, contentKey?: string) {
        onUnit({
          // A pack may hold units of several images: each result names the image its unit belongs to.
          contentKey: contentKey ?? pack.units.find((u) => u.unitKey === unitKey)?.contentKey ?? "",
          unitKey,
          status,
          type: "dialogue",
          speaker: "",
          original: `orig:${unitKey}`,
          translation: status === "ok" ? text : "",
          lang: "ko",
          model: "azure-gpt-5.2",
        });
      },
      emitAll(status = "ok") {
        for (const unit of pack.units) call.emit(unit.unitKey, status, undefined, unit.contentKey);
      },
      resolve(patch = {}) {
        done.resolve({
          packId: pack.packId,
          requests: 1,
          missing: [],
          error: null,
          model: "azure-gpt-5.2",
          lang: "ko",
          firstLineMs: 1,
          totalMs: 2,
          uploadedBytes: 100,
          ...patch,
        });
      },
      reject: (error) => done.reject(error),
    };
    this.calls.push(call);
    if (this.auto) {
      call.emitAll();
      call.resolve();
    }
    return done.promise;
  }
}

/** The write protocol of src/engine/store/translations.ts (cross-checked against the real merge below). */
function mergeRecord(
  existing: TranslationRecord | undefined,
  incoming: TranslationRecord,
): TranslationRecord {
  if (incoming.manual === 1) {
    if (incoming.manualTranslation !== null) return { ...incoming };
    const status =
      incoming.status === "manual"
        ? incoming.translation.trim() === ""
          ? "untranslated"
          : "ok"
        : incoming.status;
    return { ...incoming, manual: 0, manualTranslation: null, status };
  }
  if (existing !== undefined && existing.manual === 1 && existing.manualTranslation !== null) {
    return {
      ...incoming,
      manualTranslation: existing.manualTranslation,
      manual: 1,
      status: existing.status,
      lastUsedAt: Math.max(existing.lastUsedAt, incoming.lastUsedAt),
    };
  }
  return { ...incoming };
}

class MemoryStores implements EngineStores {
  readonly db = undefined as unknown as CtvDatabase;
  readonly imageRecords = new Map<string, ImageRecord>();
  readonly aliases = new Map<string, string>();
  readonly unitRecords = new Map<string, UnitsRecord>();
  readonly records = new Map<string, TranslationRecord>();
  readonly writes: TranslationRecord[] = [];
  readonly touches: string[] = [];
  flushes = 0;
  failReads = false;

  private read<T>(get: () => T): Promise<T> {
    return this.failReads ? Promise.reject(new CtvError("store.io", "read failed")) : Promise.resolve(get());
  }

  record(contentKey: string, unitKey: string): TranslationRecord | undefined {
    return this.records.get(`${contentKey}\u0000${unitKey}`);
  }

  readonly images: ImageStore = {
    get: (contentKey) => this.read(() => this.imageRecords.get(contentKey)),
    put: (record) => {
      this.imageRecords.set(record.contentKey, record);
      return Promise.resolve();
    },
    touch: (contentKey) => {
      this.touches.push(contentKey);
      return Promise.resolve();
    },
    alias: (urlKey) => this.read(() => this.aliases.get(urlKey)),
    putAlias: (urlKey, contentKey) => {
      this.aliases.set(urlKey, contentKey);
      return Promise.resolve();
    },
  };
  readonly units: UnitStore = {
    get: (contentKey) => this.read(() => this.unitRecords.get(contentKey)),
    put: (record) => {
      this.unitRecords.set(record.contentKey, record);
      return Promise.resolve();
    },
  };
  readonly translations: TranslationStore = {
    forImage: (contentKey) =>
      this.read(() => [...this.records.values()].filter((r) => r.contentKey === contentKey)),
    put: (record) => {
      this.writes.push({ ...record });
      const key = `${record.contentKey}\u0000${record.unitKey}`;
      this.records.set(key, mergeRecord(this.records.get(key), record));
    },
    flush: () => {
      this.flushes += 1;
      return Promise.resolve();
    },
  };
  readonly kv: KvStore = {
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
  };
  readonly logs: LogStore = {
    append: () => {},
    flush: () => Promise.resolve(),
    recent: () => Promise.resolve([]),
  };
  readonly patchRecords = new Map<string, PatchRecord>();
  readonly patches: PatchStore = {
    forImage: (contentKey) =>
      Promise.resolve([...this.patchRecords.values()].filter((record) => record.contentKey === contentKey)),
    put: (record) => {
      this.patchRecords.set(`${record.contentKey}|${record.unitKey}`, record);
      return Promise.resolve();
    },
  };
  readonly models: ModelStore = {
    get: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
  };
  close(): Promise<void> {
    return Promise.resolve();
  }
}

type Msg<T extends EngineToCs["type"]> = Extract<EngineToCs, { type: T }>;

class FakeFrame implements FrameSink {
  readonly info: FrameInfo;
  connected = true;
  readonly messages: EngineToCs[] = [];
  readonly unsafe: string[] = [];
  constructor(tabId: number, frameId = 0) {
    const documentId = `doc-${tabId}-${frameId}`;
    this.info = {
      frameKey: `${tabId}:${frameId}:${documentId}`,
      tabId,
      frameId,
      documentId,
      url: "https://reader.example/series/1/ch/2",
      origin: "https://reader.example",
      siteKey: "https://reader.example",
      mode: "manual",
      codec: "sc",
      page: { title: "Ch. 2", layout: "auto", visible: true, dpr: 1 },
      viewport: null,
      focusSeq: 1,
    };
  }
  post(message: EngineToCs): boolean {
    const check = isWireSafe(message);
    if (!check.ok) this.unsafe.push(`${message.type} ${check.path}: ${check.why}`);
    if (!this.connected) return false;
    this.messages.push(message);
    return true;
  }
  of<T extends EngineToCs["type"]>(type: T, imageKey?: string): Array<Msg<T>> {
    return this.messages.filter(
      (m): m is Msg<T> =>
        m.type === type && (imageKey === undefined || ("imageKey" in m && m.imageKey === imageKey)),
    );
  }
  types(imageKey: string): string[] {
    return this.messages.filter((m) => "imageKey" in m && m.imageKey === imageKey).map((m) => m.type);
  }
  states(imageKey: string): string[] {
    return this.of("img:state", imageKey).map((m) => m.state);
  }
  lastState(imageKey: string): Msg<"img:state"> | undefined {
    return this.of("img:state", imageKey).at(-1);
  }
  /** Rendered units by key: the last img:unit or img:bulk entry wins. */
  shown(imageKey: string): Map<string, { status: string; translation: string }> {
    const out = new Map<string, { status: string; translation: string }>();
    for (const m of this.messages) {
      if (m.type === "img:bulk" && m.imageKey === imageKey) {
        for (const u of m.units) out.set(u.unitKey, { status: u.status, translation: u.translation });
      }
      if (m.type === "img:unit" && m.imageKey === imageKey)
        out.set(m.unit.unitKey, { status: m.unit.status, translation: m.unit.translation });
    }
    return out;
  }
}

class FakeUi implements UiBroadcast {
  readonly posts: Array<{ message: EngineToUi; tabId: number | null | undefined }> = [];
  post(message: EngineToUi, tabId?: number | null): void {
    this.posts.push({ message, tabId });
  }
}

/* ================================================================== helpers */

function units(count: number, opts: { edgeSmall?: true } = {}): UnitGeometry[] {
  return Array.from({ length: count }, (_, i) => {
    const x1 = 40 + (i % 3) * 250;
    const y1 = 40 + Math.floor(i / 3) * 180;
    const bubble = { x1, y1, x2: x1 + 200, y2: y1 + 150 };
    const text = { x1: x1 + 40, y1: y1 + 30, x2: x1 + 160, y2: y1 + 120 };
    const unit: UnitGeometry = {
      unitKey: `k${i}`,
      kind: "bubble",
      bubble,
      text,
      texts: [text],
      orientation: "h",
      glyphPx: 24,
      order: i,
    };
    if (opts.edgeSmall === true) unit.edgeSmall = true;
    return unit;
  });
}

function submitOf(imageKey: string, src: string, patch: Partial<ImageSubmit> = {}): ImageSubmit {
  return {
    imageKey,
    src,
    natural: { w: 800, h: 1200 },
    displayed: { w: 400, h: 600 },
    element: "img",
    priority: 0,
    pos: { docOrder: 0, srcGen: 0, yTop: 0 },
    acquire: "url",
    ...patch,
  };
}

function srcOf(label: string): string {
  return `https://cdn.example/${label}.jpg`;
}

interface Harness {
  clock: ManualClock;
  settings: FakeSettings;
  health: FakeHealth;
  stores: MemoryStores;
  acquirer: FakeAcquirer;
  decoder: FakeDecoder;
  detector: FakeDetector;
  translator: FakeTranslator;
  ui: FakeUi;
  logs: LogEntry[];
  pipeline: Pipeline;
  /** Registers an image: src → label (contentKey "s:" + label) with `count` units. */
  image(label: string, count: number, opts?: { edgeSmall?: true; src?: string }): string;
  /** Puts a fully cached image in the stores (alias, image, units, translations). */
  cache(
    label: string,
    count: number,
    records?: (unitKey: string) => Partial<TranslationRecord> | null,
  ): string;
}

/** Eraser double: every unit gets a mask patch (or what `outcome` says), released when `gate` opens. */
class FakeEraser implements Eraser {
  readonly calls: string[][] = [];
  gate: Promise<void> = Promise.resolve();
  outcome = (unit: UnitGeometry): EraseOutput => ({
    kind: "mask",
    rect: { ...unit.text },
    bg: [255, 255, 255],
    textColor: [0, 0, 0],
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, unit.order]).buffer,
    glyphPx: 31,
    interior: { x1: unit.text.x1 - 5, y1: unit.text.y1 - 5, x2: unit.text.x2 + 5, y2: unit.text.y2 + 5 },
    rectLike: false,
  });
  start(_image: DecodedImage, units: readonly UnitGeometry[]): Map<string, Promise<EraseOutput>> {
    this.calls.push(units.map((u) => u.unitKey));
    return new Map(units.map((u) => [u.unitKey, this.gate.then(() => this.outcome(u))]));
  }
}

function harness(
  options: {
    ack?: boolean;
    readiness?: ApiReadiness;
    concurrency?: number;
    eraser?: Eraser;
    memory?: SeriesMemory;
    /** translate.packWaitMs; 0 (the default here) sends each image's units at once, as the queue tests expect. */
    packWaitMs?: number;
  } = {},
): Harness {
  const clock = new ManualClock();
  const settings = new FakeSettings();
  settings.value.translate.packWaitMs = options.packWaitMs ?? 0;
  if (options.ack === false) settings.value.privacy.ackUploadNoticeAt = null;
  if (options.concurrency !== undefined) {
    settings.value.api.concurrency = options.concurrency;
    settings.value.api.urgentLane = false;
  }
  const health = new FakeHealth(options.readiness ?? "ready");
  const stores = new MemoryStores();
  const acquirer = new FakeAcquirer();
  const decoder = new FakeDecoder();
  const detector = new FakeDetector();
  const translator = new FakeTranslator();
  const ui = new FakeUi();
  const logs: LogEntry[] = [];
  const log = createLogger("engine", {
    minLevel: "debug",
    sinks: [(entry) => logs.push(entry)],
    now: clock.now,
  });
  const pipeline = createPipeline({
    clock,
    log,
    settings,
    stores,
    health,
    acquirer,
    decoder,
    detector,
    translator,
    ui,
    ...(options.eraser === undefined ? {} : { eraser: options.eraser }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
  });
  return {
    clock,
    settings,
    health,
    stores,
    acquirer,
    decoder,
    detector,
    translator,
    ui,
    logs,
    pipeline,
    image(label, count, opts = {}) {
      const src = opts.src ?? srcOf(label);
      acquirer.content.set(src, label);
      detector.units.set(`s:${label}`, units(count, opts.edgeSmall === true ? { edgeSmall: true } : {}));
      return src;
    },
    cache(label, count, records = () => ({})) {
      const contentKey = `s:${label}`;
      const src = srcOf(label);
      acquirer.content.set(src, label);
      const urlKey = urlKeyOf(src);
      if (urlKey !== null) stores.aliases.set(urlKey, contentKey);
      stores.imageRecords.set(contentKey, {
        contentKey,
        w: 800,
        h: 1200,
        mime: "image/png",
        byteLength: 10,
        source: "url",
        lowRes: false,
        lang: "ko",
        seriesKey: null,
        firstSeenAt: 1,
        lastUsedAt: 1,
      });
      const list = units(count);
      stores.unitRecords.set(contentKey, {
        contentKey,
        detectorVersion: "v4s:test",
        unitsVersion: 1,
        backend: "webgpu",
        slices: [],
        rawDetections: [],
        units: list,
        createdAt: 1,
      });
      for (const unit of list) {
        const patch = records(unit.unitKey);
        if (patch === null) continue;
        stores.records.set(`${contentKey}\u0000${unit.unitKey}`, {
          contentKey,
          unitKey: unit.unitKey,
          seriesKey: null,
          type: "dialogue",
          speaker: "",
          original: `orig:${unit.unitKey}`,
          translation: `cached:${unit.unitKey}`,
          manualTranslation: null,
          manual: 0,
          status: "ok",
          lang: "ko",
          model: "azure-gpt-5.2",
          promptVersion: 1,
          attempts: 1,
          updatedAt: 1,
          lastUsedAt: 1,
          ...patch,
        });
      }
      return src;
    },
  };
}

/** img:units before any img:unit / img:bulk, and those before img:done (`strict`: nothing after img:done). */
function assertProtocol(frame: FakeFrame, strict = true): void {
  assert.deepEqual(frame.unsafe, [], "every message is wire-safe (R6)");
  const seen = new Map<string, { units: boolean; done: boolean }>();
  for (const message of frame.messages) {
    if (!("imageKey" in message)) continue;
    const state = seen.get(message.imageKey) ?? { units: false, done: false };
    seen.set(message.imageKey, state);
    if (message.type === "img:units") state.units = true;
    if (message.type === "img:unit" || message.type === "img:bulk" || message.type === "img:done") {
      assert.ok(state.units, `${message.type} before img:units for ${message.imageKey}`);
      if (strict && message.type !== "img:done") assert.ok(!state.done, `${message.type} after img:done`);
    }
    if (message.type === "img:done") state.done = true;
  }
}

/* ================================================================== tests */

describe("cache path", () => {
  test("a cached image answers with img:units + img:bulk + img:done, no acquire, detector or translator call", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.cache("p1", 2)));
    await settle();
    assert.deepEqual(frame.types("1.0"), ["img:state", "img:units", "img:bulk", "img:state", "img:done"]);
    assert.deepEqual(frame.states("1.0"), ["queued", "done"]);
    assert.deepEqual(
      frame.of("img:bulk", "1.0")[0]?.units.map((u) => [u.unitKey, u.status, u.translation]),
      [
        ["k0", "ok", "cached:k0"],
        ["k1", "ok", "cached:k1"],
      ],
    );
    assert.deepEqual(frame.of("img:units", "1.0")[0]?.natural, { w: 800, h: 1200 });
    assert.deepEqual(frame.of("img:done", "1.0")[0]?.counts, { ok: 2 });
    assert.deepEqual(
      [h.acquirer.calls.length, h.decoder.hashed, h.detector.calls.length, h.translator.calls.length],
      [0, 0, 0, 0],
    );
    assert.ok(h.stores.touches.includes("s:p1"), "cache hits keep the image alive for retention");
    assertProtocol(frame);
  });

  test("canvas submits neither use nor create a urlKey alias (their src is the page URL + #ctv-canvas-…)", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const page = "https://reader.example/ch/1";
    const first = h.image("c1", 1, { src: `${page}#ctv-canvas-1.0` });
    const second = h.image("c2", 1, { src: `${page}#ctv-canvas-2.0` });
    const canvas = (label: string): Partial<ImageSubmit> => ({
      element: "canvas",
      acquire: "bytes",
      bytes: bytesOf(label),
      mime: "image/png",
      source: "cs-canvas",
    });
    h.pipeline.submit(frame, submitOf("1.0", first, canvas("c1")));
    await settle();
    h.pipeline.submit(frame, submitOf("2.0", second, canvas("c2")));
    await settle();
    assert.deepEqual(h.detector.calls, ["s:c1", "s:c2"], "the second canvas is not served from the first");
    assert.equal(h.stores.aliases.size, 0, "no alias is stored for a synthetic canvas src");
  });

  test("manual edits and resolved outcomes come back as stored; only ok/manual carry text", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.cache("p1", 3, (key) =>
      key === "k0"
        ? { manualTranslation: "Bản sửa", manual: 1, status: "manual" }
        : key === "k1"
          ? { status: "keep-original", translation: "" }
          : { status: "refused", translation: "" },
    );
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    assert.deepEqual(Object.fromEntries(frame.shown("1.0")), {
      k0: { status: "manual", translation: "Bản sửa" },
      k1: { status: "keep-original", translation: "" },
      k2: { status: "refused", translation: "" },
    });
    assert.equal(h.translator.calls.length, 0, "refused units are never retried automatically (D-005)");
    assert.equal(frame.lastState("1.0")?.state, "partial");
    assertProtocol(frame);
  });

  test("a partly cached image fetches bytes and translates only the missing units, without detection", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.cache("p1", 3, (key) =>
      key === "k0" ? {} : key === "k1" ? { status: "untranslated", translation: "" } : null,
    );
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    assert.equal(h.detector.calls.length, 0);
    assert.equal(h.acquirer.calls.length, 1);
    assert.deepEqual(
      h.translator.calls.map((c) => c.keys),
      [["k1", "k2"]],
    );
    assert.deepEqual(
      frame.of("img:bulk", "1.0")[0]?.units.map((u) => u.unitKey),
      ["k0"],
    );
    assert.deepEqual(frame.of("img:done", "1.0")[0]?.counts, { ok: 3 });
    assert.equal(h.decoder.open().length, 0, "the bitmap is released once the packs finished");
    assertProtocol(frame);
  });

  test("a store read failure falls back to the full flow", async () => {
    const h = harness();
    h.stores.failReads = true;
    const frame = new FakeFrame(1);
    const src = h.cache("p1", 2);
    h.detector.units.set("s:p1", units(2));
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    assert.equal(h.detector.calls.length, 1);
    assert.equal(h.translator.calls.length, 1);
    assert.equal(frame.lastState("1.0")?.state, "done");
    assert.ok(h.logs.some((entry) => entry.code === "store.io"));
  });
});

describe("fresh image", () => {
  test("acquire → hash → decode → detect → translate, persisting alias, image, units and translations", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.image("p1", 3);
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    assert.deepEqual(frame.states("1.0"), [
      "queued",
      "acquiring",
      "detecting",
      "waiting",
      "translating",
      "translating",
      "translating",
      "translating",
      "done",
    ]);
    // Progress counts each unit as its line is accepted; "done" waits for the pack report.
    const progress = frame.of("img:state", "1.0").map((m) => m.progress?.done ?? null);
    assert.deepEqual(progress, [null, null, null, 0, 0, 1, 2, 3, 3]);
    assert.equal(h.stores.aliases.get(urlKeyOf(src) ?? ""), "s:p1");
    assert.equal(h.stores.imageRecords.get("s:p1")?.w, 800);
    assert.equal(h.stores.unitRecords.get("s:p1")?.units.length, 3);
    assert.equal(h.stores.unitRecords.get("s:p1")?.detectorVersion, "v4s:test");
    assert.deepEqual(h.stores.record("s:p1", "k2"), {
      ...h.stores.record("s:p1", "k2"),
      translation: "vi:k2",
      status: "ok",
      manual: 0,
      manualTranslation: null,
      attempts: 1,
    });
    const call = h.translator.calls[0];
    assert.equal(call?.pack.lang, "ko");
    assert.equal(call?.pack.frameKey, frame.info.frameKey);
    assert.equal(call?.pack.units[0]?.script, "hangul");
    assert.equal(call?.pack.images.get("s:p1")?.contentKey, "s:p1");
    assert.equal(h.detector.options[0]?.scoreMin, 0.3);
    assert.equal(h.decoder.open().length, 0);
    assertProtocol(frame);
  });

  test("an image without units is no-text and never reaches the translator", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("blank", 0)));
    await settle();
    assert.deepEqual(frame.types("1.0"), [
      "img:state",
      "img:state",
      "img:state",
      "img:units",
      "img:state",
      "img:done",
    ]);
    assert.equal(frame.lastState("1.0")?.state, "no-text");
    assert.deepEqual(frame.of("img:units", "1.0")[0]?.units, []);
    assert.deepEqual(frame.of("img:done", "1.0")[0]?.counts, {});
    assert.equal(h.translator.calls.length, 0);
    assert.deepEqual(h.stores.unitRecords.get("s:blank")?.units, []);
    assert.equal(h.decoder.open().length, 0);
    assert.equal(h.pipeline.idle(), true);
  });

  test("a prefetched candidate below the size gate is no-text without detection (plan §5.1)", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.image("tiny", 2);
    h.decoder.sizes.set("s:tiny", { w: 120, h: 200 });
    h.pipeline.submit(frame, submitOf("1.0", src, { natural: null, prefetch: true }));
    await settle();
    assert.equal(h.detector.calls.length, 0);
    assert.equal(h.translator.calls.length, 0);
    assert.equal(frame.lastState("1.0")?.state, "no-text");
  });

  test("an image whose only units are edgeSmall (page number) resolves them as ignored without upload", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("pageno", 1, { edgeSmall: true })));
    await settle();
    assert.equal(h.translator.calls.length, 0);
    assert.deepEqual(Object.fromEntries(frame.shown("1.0")), { k0: { status: "ignored", translation: "" } });
    assert.equal(frame.lastState("1.0")?.state, "done");
    assert.equal(h.stores.record("s:pageno", "k0")?.status, "ignored");
  });
});

describe("erase patches (P3)", () => {
  test("patches are computed after detection, stored, and sent with each painted unit; text fits the interior", async () => {
    const eraser = new FakeEraser();
    const h = harness({ eraser });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 2)));
    await settle();
    assert.deepEqual(eraser.calls, [["k0", "k1"]]);
    const painted = frame.of("img:unit", "1.0").filter((m) => m.unit.status === "ok");
    const last = new Map(painted.map((m) => [m.unit.unitKey, m.unit]));
    for (const key of ["k0", "k1"]) {
      const unit = last.get(key);
      assert.ok(unit !== undefined);
      assert.equal(unit.erase.kind, "mask");
      assert.ok(unit.erase.png instanceof ArrayBuffer);
      assert.equal(unit.fit.glyphPx, 31, "glyph measured from pixels");
      const geometry = h.detector.units.get("s:p1")?.find((u) => u.unitKey === key);
      assert.ok(geometry !== undefined);
      assert.deepEqual(unit.fit.region, eraser.outcome(geometry).interior);
    }
    assert.equal(h.stores.patchRecords.size, 2);
    const record = h.stores.patchRecords.get("s:p1|k0");
    assert.equal(record?.kind, "mask");
    assert.equal(record?.glyphPx, 31);
    assertProtocol(frame, false);
  });

  test("a patch that arrives after the translation re-sends the unit with it", async () => {
    const eraser = new FakeEraser();
    let open: () => void = () => undefined;
    eraser.gate = new Promise((resolve) => (open = resolve));
    const h = harness({ eraser });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1)));
    await settle();
    const before = frame.of("img:unit", "1.0").filter((m) => m.unit.status === "ok");
    assert.equal(before.at(-1)?.unit.erase.kind, "box", "a plate over the text box until the patch exists");
    open();
    await settle();
    const after = frame.of("img:unit", "1.0").filter((m) => m.unit.status === "ok");
    assert.equal(after.at(-1)?.unit.erase.kind, "mask");
  });

  test("a cached image brings its stored patches back without the eraser", async () => {
    const eraser = new FakeEraser();
    const h = harness({ eraser });
    const src = h.cache("p1", 1);
    h.stores.patchRecords.set("s:p1|k0", {
      contentKey: "s:p1",
      unitKey: "k0",
      eraseVersion: 1,
      kind: "mask",
      rect: { x1: 1, y1: 2, x2: 3, y2: 4 },
      bg: [250, 250, 250],
      textColor: [10, 10, 10],
      glyphPx: 27,
      interior: { x1: 0, y1: 0, x2: 50, y2: 40 },
      rectLike: true,
      png: new Uint8Array([1, 2, 3]).buffer,
      bytes: 3,
      lastUsedAt: 1,
    });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    const unit = frame.of("img:bulk", "1.0")[0]?.units[0];
    assert.ok(unit !== undefined);
    assert.equal(unit.erase.kind, "mask");
    assert.ok(unit.erase.png instanceof ArrayBuffer);
    assert.deepEqual(unit.fit.region, { x1: 0, y1: 0, x2: 50, y2: 40 });
    assert.equal(unit.fit.shape, "rect");
    assert.equal(unit.fit.glyphPx, 27);
    assert.deepEqual(eraser.calls, []);
  });

  test("without an eraser units still paint, on a plate over their text box", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1)));
    await settle();
    const unit = frame
      .of("img:unit", "1.0")
      .filter((m) => m.unit.status === "ok")
      .at(-1)?.unit;
    assert.equal(unit?.erase.kind, "box");
    assert.equal(unit?.erase.png, undefined);
  });
});

describe("lanes and priorities", () => {
  test("concurrency 2 plus the urgent lane for an on-screen image; never more than inFlightCap", async () => {
    const h = harness();
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    for (const n of [1, 2, 3, 4]) h.pipeline.submit(frame, submitOf(`${n}.0`, h.image(`p${n}`, 1)));
    await settle();
    assert.deepEqual(
      h.translator.calls.map((c) => c.pack.units[0]?.contentKey),
      ["s:p1", "s:p2"],
    );
    assert.deepEqual(
      [
        h.pipeline.queueStatus().inFlight,
        h.pipeline.queueStatus().queued,
        h.pipeline.queueStatus().urgentInFlight,
      ],
      [2, 2, 0],
    );
    assert.equal(frame.lastState("3.0")?.state, "waiting");
    // The reader scrolls image 4 into view: its pack takes the urgent lane at once.
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["4.0"] };
    h.pipeline.priority(frame.info.frameKey, []);
    await settle();
    assert.deepEqual(
      h.translator.calls.map((c) => c.pack.units[0]?.contentKey),
      ["s:p1", "s:p2", "s:p4"],
    );
    assert.equal(h.translator.calls[2]?.pack.urgent, true);
    assert.equal(h.pipeline.queueStatus().urgentInFlight, 1);
    assert.equal(h.pipeline.queueStatus().inFlight, 3);
    h.translator.calls[0]?.emitAll();
    h.translator.calls[0]?.resolve();
    await settle();
    assert.equal(h.translator.calls.length, 4);
    assert.equal(h.translator.calls[3]?.pack.units[0]?.contentKey, "s:p3");
    for (const call of h.translator.calls.slice(1)) {
      call.emitAll();
      call.resolve();
    }
    await settle();
    assert.deepEqual(
      ["1.0", "2.0", "3.0", "4.0"].map((key) => frame.lastState(key)?.state),
      ["done", "done", "done", "done"],
    );
    assert.equal(h.pipeline.queueStatus().done, 4);
    assert.equal(h.pipeline.idle(), true);
  });

  test("an on-screen image sends its first translate.urgentPackMax units in their own pack (8 by default)", async () => {
    for (const [cap, sizes] of [
      [8, [8, 1]],
      [4, [4, 5]],
      [0, [9]],
    ] as const) {
      const h = harness();
      h.settings.value.translate.urgentPackMax = cap;
      const frame = new FakeFrame(1);
      frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["1.0"] };
      h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 9)));
      await settle();
      assert.deepEqual(
        h.translator.calls.map((c) => c.keys.length),
        [...sizes],
        `urgentPackMax ${cap}`,
      );
    }
  });

  test("fast mode: the first request of an on-screen image holds at most FAST_URGENT_PACK_MAX units", async () => {
    for (const [cap, sizes] of [
      [8, [FAST_URGENT_PACK_MAX, 9 - FAST_URGENT_PACK_MAX]],
      [2, [2, 7]],
      [0, [FAST_URGENT_PACK_MAX, 9 - FAST_URGENT_PACK_MAX]],
    ] as const) {
      const h = harness();
      h.settings.value.translate.fastMode = true;
      h.settings.value.translate.urgentPackMax = cap;
      const frame = new FakeFrame(1);
      frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["1.0"] };
      h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 9)));
      await settle();
      assert.deepEqual(
        h.translator.calls.map((c) => c.keys.length),
        [...sizes],
        `urgentPackMax ${cap}`,
      );
    }
  });

  test("lower priority values go first; img:priority reorders unsent packs", async () => {
    const h = harness({ concurrency: 1 });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("0.0", h.image("blocker", 1)));
    await settle();
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1), { priority: 5 }));
    h.pipeline.submit(frame, submitOf("2.0", h.image("p2", 1), { priority: 1 }));
    h.pipeline.submit(frame, submitOf("3.0", h.image("p3", 1), { priority: 3 }));
    await settle();
    assert.equal(h.translator.calls.length, 1);
    h.pipeline.priority(frame.info.frameKey, [{ imageKey: "1.0", priority: 0 }]);
    const finish = async (index: number): Promise<void> => {
      h.translator.calls[index]?.emitAll();
      h.translator.calls[index]?.resolve();
      await settle();
    };
    await finish(0);
    await finish(1);
    await finish(2);
    assert.deepEqual(
      h.translator.calls.map((c) => c.pack.units[0]?.contentKey),
      ["s:blocker", "s:p1", "s:p2", "s:p3"],
    );
  });

  test("image preparation runs two at a time, on-screen images first", async () => {
    const h = harness();
    h.acquirer.hold = true;
    const frame = new FakeFrame(1);
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["3.0"] };
    h.pipeline.submit(frame, submitOf("a.0", h.image("a", 1)));
    h.pipeline.submit(frame, submitOf("b.0", h.image("b", 1)));
    await settle();
    for (const n of [1, 2, 3]) h.pipeline.submit(frame, submitOf(`${n}.0`, h.image(`p${n}`, 1)));
    await settle();
    const fetched = (): string[] => h.acquirer.calls.map((c) => c.submit.imageKey);
    assert.deepEqual(fetched(), ["a.0", "b.0"]);
    assert.equal(h.pipeline.idle(), false);
    h.acquirer.release();
    await settle();
    assert.deepEqual(fetched(), ["a.0", "b.0", "3.0"]);
    h.acquirer.release();
    await settle();
    assert.deepEqual(fetched(), ["a.0", "b.0", "3.0", "1.0"]);
    for (let i = 0; i < 3; i += 1) {
      h.acquirer.release();
      await settle();
    }
    assert.deepEqual(fetched(), ["a.0", "b.0", "3.0", "1.0", "2.0"]);
    assert.equal(h.translator.calls.length, 5);
    assert.equal(h.pipeline.idle(), true);
  });

  test("a hidden tab's packs go last; ties go to the most recently focused tab", async () => {
    const h = harness({ concurrency: 1 });
    h.translator.auto = false;
    const visible = new FakeFrame(1);
    const hidden = new FakeFrame(2);
    const focused = new FakeFrame(3);
    hidden.info.page.visible = false;
    focused.info.focusSeq = 5;
    h.pipeline.submit(visible, submitOf("0.0", h.image("blocker", 1)));
    await settle();
    h.pipeline.submit(hidden, submitOf("1.0", h.image("hidden", 1)));
    h.pipeline.submit(visible, submitOf("2.0", h.image("older-tab", 1)));
    h.pipeline.submit(focused, submitOf("3.0", h.image("focused-tab", 1)));
    await settle();
    for (let i = 0; i < 4; i += 1) {
      h.translator.calls[i]?.emitAll();
      h.translator.calls[i]?.resolve();
      await settle();
    }
    assert.deepEqual(
      h.translator.calls.map((c) => c.pack.units[0]?.contentKey),
      ["s:blocker", "s:focused-tab", "s:older-tab", "s:hidden"],
    );
  });

  test("a translator concurrency cap (throttle) holds requests in flight until it expires", async () => {
    const h = harness();
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.throttle(1, 10 * 60_000);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1)));
    h.pipeline.submit(frame, submitOf("2.0", h.image("p2", 1)));
    await settle();
    assert.equal(h.translator.calls.length, 1);
    assert.equal(h.pipeline.queueStatus().concurrency, 1);
    h.clock.advance(10 * 60_000);
    await settle();
    assert.equal(h.translator.calls.length, 2);
  });

  test("a pack that ends on a 429 lowers concurrency to 1 for 10 minutes", async () => {
    const h = harness();
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1)));
    await settle();
    h.translator.calls[0]?.emitAll("error");
    h.translator.calls[0]?.resolve({
      error: { code: "api.rate_limit", message: "429", retryable: true },
    });
    await settle();
    assert.equal(h.pipeline.queueStatus().concurrency, 1);
    assert.equal(h.pipeline.queueStatus().failed, 1);
    h.clock.advance(10 * 60_000);
    assert.equal(h.pipeline.queueStatus().concurrency, 2);
  });
});

describe("sharing by contentKey (L8)", () => {
  test("two frames with the same bytes share one detection and one translation", async () => {
    const h = harness();
    h.translator.auto = false;
    const a = new FakeFrame(1);
    const b = new FakeFrame(2);
    const srcA = h.image("same", 2);
    const srcB = h.image("same", 2, { src: "https://mirror.example/other-name.jpg" });
    h.pipeline.submit(a, submitOf("1.0", srcA));
    h.pipeline.submit(b, submitOf("9.3", srcB));
    await settle();
    assert.deepEqual(h.detector.calls, ["s:same"]);
    assert.equal(h.translator.calls.length, 1);
    h.translator.calls[0]?.emit("k0");
    await settle();
    for (const [frame, key] of [
      [a, "1.0"],
      [b, "9.3"],
    ] as const) {
      assert.deepEqual(frame.shown(key).get("k0"), { status: "ok", translation: "vi:k0" });
    }
    h.translator.calls[0]?.emit("k1");
    h.translator.calls[0]?.resolve();
    await settle();
    for (const [frame, key] of [
      [a, "1.0"],
      [b, "9.3"],
    ] as const) {
      assert.equal(frame.lastState(key)?.state, "done");
      assert.deepEqual(frame.of("img:done", key)[0]?.counts, { ok: 2 });
      assertProtocol(frame);
    }
    const tabs = h.ui.posts.map((p) => p.tabId);
    assert.ok(tabs.includes(1) && tabs.includes(2), "transcript deltas go to both tabs");
    for (const { message } of h.ui.posts) assert.deepEqual(isWireSafe(message), { ok: true });
  });

  test("a frame that joins mid-translation gets a replay of the finished units, then the rest", async () => {
    const h = harness();
    h.translator.auto = false;
    const a = new FakeFrame(1);
    const b = new FakeFrame(2);
    const src = h.image("p1", 2);
    h.pipeline.submit(a, submitOf("1.0", src));
    await settle();
    h.translator.calls[0]?.emit("k0");
    await settle();
    h.pipeline.submit(b, submitOf("5.0", src));
    await settle();
    assert.deepEqual(b.types("5.0"), ["img:state", "img:units", "img:bulk", "img:state"]);
    assert.equal(b.lastState("5.0")?.state, "translating");
    assert.deepEqual(
      b.of("img:bulk", "5.0")[0]?.units.map((u) => u.unitKey),
      ["k0"],
    );
    h.translator.calls[0]?.emit("k1");
    h.translator.calls[0]?.resolve();
    await settle();
    assert.deepEqual(b.shown("5.0").get("k1"), { status: "ok", translation: "vi:k1" });
    assert.equal(h.translator.calls.length, 1);
    assert.equal(
      h.acquirer.calls.length,
      1,
      "the alias + in-memory work answer the second frame without a fetch",
    );
    assertProtocol(a);
    assertProtocol(b);
  });

  test("resubmitting the same image (reconnect) replays the current state without new work", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const request = submitOf("1.0", h.image("p1", 2));
    h.pipeline.submit(frame, request);
    await settle();
    const before = frame.messages.length;
    h.pipeline.submit(frame, request);
    await settle();
    assert.deepEqual(
      frame.messages.slice(before).map((m) => m.type),
      ["img:units", "img:bulk", "img:state", "img:done"],
    );
    assert.deepEqual([h.acquirer.calls.length, h.translator.calls.length], [1, 1]);
  });
});

describe("privacy and health gates", () => {
  test("no upload before the privacy notice: paused with privacy.consent; cache hits and no-text are unaffected", async () => {
    const h = harness({ ack: false });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("fresh", 2)));
    h.pipeline.submit(frame, submitOf("2.0", h.cache("cached", 1)));
    h.pipeline.submit(frame, submitOf("3.0", h.image("blank", 0)));
    await settle();
    const paused = frame.lastState("1.0");
    assert.equal(paused?.state, "paused");
    assert.equal(paused?.error?.code, "privacy.consent");
    assert.equal(h.translator.calls.length, 0);
    assert.equal(frame.lastState("2.0")?.state, "done");
    assert.equal(frame.lastState("3.0")?.state, "no-text");
    assert.equal(h.pipeline.queueStatus().pausedBy, "privacy.consent");
    h.settings.update((s) => {
      s.privacy.ackUploadNoticeAt = 42;
    });
    await settle();
    assert.equal(h.translator.calls.length, 1);
    assert.equal(frame.lastState("1.0")?.state, "done");
    assert.equal(h.pipeline.queueStatus().pausedBy, null);
    assertProtocol(frame);
  });

  test("while the API is not sendable images pause with its error, and resume when it is", async () => {
    const h = harness({ readiness: "unauthorized" });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 2)));
    await settle();
    const paused = frame.lastState("1.0");
    assert.deepEqual([paused?.state, paused?.error?.code], ["paused", "api.unauthorized"]);
    assert.deepEqual(paused?.progress, { done: 0, total: 2 });
    assert.equal(h.translator.calls.length, 0);
    assert.deepEqual(h.health.busy, [true]);
    assert.equal(h.pipeline.queueStatus().pausedBy, "api.unauthorized");
    h.health.set("misconfigured");
    await settle();
    assert.deepEqual(
      [frame.lastState("1.0")?.state, frame.lastState("1.0")?.error?.code],
      ["paused", "api.config"],
    );
    assert.equal(h.pipeline.queueStatus().pausedBy, "api.config");
    h.health.set("lna_blocked");
    await settle();
    assert.equal(frame.lastState("1.0")?.error?.code, "api.lna_blocked");
    assert.equal(h.translator.calls.length, 0);
    h.health.set("ready");
    await settle();
    assert.equal(h.translator.calls.length, 1);
    assert.equal(frame.lastState("1.0")?.state, "done");
    assert.deepEqual(h.health.busy, [true, false]);
  });

  test("an unknown readiness holds packs without a pause badge", async () => {
    const h = harness({ readiness: "unknown" });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1)));
    await settle();
    assert.deepEqual([frame.lastState("1.0")?.state, frame.lastState("1.0")?.error], ["waiting", undefined]);
    assert.equal(h.pipeline.queueStatus().pausedBy, null);
    h.health.set("ready");
    await settle();
    assert.equal(frame.lastState("1.0")?.state, "done");
  });

  test("losing the API mid-request shows paused but never aborts the request", async () => {
    const h = harness();
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 2)));
    await settle();
    h.health.set("unreachable");
    await settle();
    assert.deepEqual(
      [frame.lastState("1.0")?.state, frame.lastState("1.0")?.error?.code],
      ["paused", "api.unreachable"],
    );
    h.translator.calls[0]?.emitAll();
    h.translator.calls[0]?.resolve();
    await settle();
    assert.equal(frame.lastState("1.0")?.state, "done");
    assert.equal(h.translator.calls.length, 1);
  });

  test("a pack that failed for API health waits for health again, within the automatic budget", async () => {
    const h = harness();
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1)));
    await settle();
    h.health.set("unreachable");
    h.translator.calls[0]?.emitAll("error");
    h.translator.calls[0]?.resolve({
      error: { code: "api.unreachable", message: "down", retryable: true },
    });
    await settle();
    assert.deepEqual(
      [frame.lastState("1.0")?.state, frame.lastState("1.0")?.error?.code],
      ["paused", "api.unreachable"],
    );
    assert.equal(h.translator.calls.length, 1);
    h.health.set("ready");
    await settle();
    assert.equal(h.translator.calls.length, 2);
    // Second failure in the same 10 minutes: the automatic budget (2 passes) is spent, the unit stays "error".
    h.translator.calls[1]?.emitAll("error");
    h.translator.calls[1]?.resolve({
      error: { code: "api.unreachable", message: "down", retryable: true },
    });
    await settle();
    assert.equal(h.translator.calls.length, 2);
    assert.deepEqual(
      [frame.lastState("1.0")?.state, frame.lastState("1.0")?.error?.code],
      ["error", "api.unreachable"],
    );
  });
});

describe("forget, frames and idle", () => {
  test("forget drops unsent packs only; the in-flight pack finishes and is still stored", async () => {
    const h = harness({ concurrency: 1 });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("a", 2)));
    h.pipeline.submit(frame, submitOf("2.0", h.image("b", 2)));
    await settle();
    assert.deepEqual(
      h.translator.calls.map((c) => c.pack.units[0]?.contentKey),
      ["s:a"],
    );
    assert.equal(h.pipeline.queueStatus().queued, 1);
    h.pipeline.forget(frame.info.frameKey, ["1.0", "2.0"]);
    assert.equal(h.pipeline.queueStatus().queued, 0);
    assert.equal(h.pipeline.idle(), false, "the in-flight request keeps the engine busy");
    const imageMessages = (): number => frame.messages.filter((m) => "imageKey" in m).length;
    const after = imageMessages();
    h.translator.calls[0]?.emitAll();
    h.translator.calls[0]?.resolve();
    await settle();
    assert.equal(h.translator.calls.length, 1, "the dropped pack is never sent");
    assert.equal(imageMessages(), after, "a forgotten image gets no more messages");
    assert.equal(h.stores.record("s:a", "k1")?.translation, "vi:k1", "late results are cached");
    assert.equal(h.decoder.open().length, 0);
    assert.equal(h.pipeline.idle(), true);
    assert.deepEqual(h.health.busy, [true, false]);
  });

  test("an image forgotten while preparing is dropped before detection", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("a", 2)));
    h.pipeline.forget(frame.info.frameKey, ["1.0"]);
    await settle();
    assert.equal(h.detector.calls.length, 0);
    assert.equal(h.translator.calls.length, 0);
    assert.equal(h.pipeline.idle(), true);
  });

  test("frameReplaced sends later messages to the new port; frameGone drops the frame's jobs", async () => {
    const h = harness();
    h.translator.auto = false;
    const old = new FakeFrame(1);
    h.pipeline.submit(old, submitOf("1.0", h.image("a", 1)));
    await settle();
    const replacement = new FakeFrame(1);
    h.pipeline.frameReplaced(replacement);
    h.translator.calls[0]?.emitAll();
    h.translator.calls[0]?.resolve();
    await settle();
    assert.deepEqual(replacement.types("1.0"), ["img:unit", "img:state", "img:state", "img:done"]);
    h.pipeline.frameGone(replacement.info.frameKey);
    h.pipeline.retry(replacement.info.frameKey, "1.0");
    await settle();
    assert.equal(h.translator.calls.length, 1);
  });

  test("stored AI translations into another target language are translated again; manual edits and old records stay", async () => {
    const h = harness();
    h.settings.value.translate.targetLang = "en";
    const frame = new FakeFrame(1);
    const src = h.cache("t1", 4, (key) =>
      key === "k0"
        ? { target: "vi" }
        : key === "k1"
          ? { target: "vi", manualTranslation: "Mine", manual: 1, status: "manual" }
          : key === "k2"
            ? { target: "en" }
            : {},
    );
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    assert.deepEqual(
      h.translator.calls.map((c) => c.keys),
      [["k0"]],
      "only the Vietnamese AI translation is redone; the manual edit, the English one and the untagged one stay",
    );
    const written =
      h.stores.records.get("s:t1\u0000k0") ?? [...h.stores.records.values()].find((r) => r.unitKey === "k0");
    assert.equal(written?.target, "en", "the new record carries its target");
  });

  test("changing the target language drops idle translations held in memory", async () => {
    const h = harness();
    h.settings.value.translate.targetLang = "en";
    const frame = new FakeFrame(1);
    const request = submitOf("1.0", h.image("a", 1));
    h.pipeline.submit(frame, request);
    await settle();
    assert.equal(h.translator.calls.length, 1);
    h.pipeline.submit(frame, request);
    await settle();
    assert.equal(h.translator.calls.length, 1, "same target: replayed from memory");
    h.settings.value.translate.targetLang = "es";
    h.pipeline.submit(frame, { ...request, force: true });
    await settle();
    assert.equal(h.translator.calls.length, 2, "new target: translated again");
    assert.ok(h.logs.some((entry) => entry.msg === "target language changed"));
  });

  test("cacheCleared(): the next submit reads the stores again instead of replaying memory", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const request = submitOf("1.0", h.image("a", 1));
    h.pipeline.submit(frame, request);
    await settle();
    h.stores.aliases.clear();
    h.stores.unitRecords.clear();
    h.stores.imageRecords.clear();
    h.stores.records.clear();
    h.pipeline.cacheCleared();
    h.pipeline.submit(frame, request);
    await settle();
    assert.deepEqual(
      [h.acquirer.calls.length, h.detector.calls.length, h.translator.calls.length],
      [2, 2, 2],
    );
  });
});

/** SeriesMemory double: answers `answer` to every context request and records what the pipeline asks. */
class RecordingMemory implements SeriesMemory {
  readonly contexts: Array<{
    scope: MemoryScope;
    pack: { contentKey: string; docOrder: number; pos: number };
  }> = [];
  readonly learned: Array<{
    scope: MemoryScope;
    pack: { packId: string; pos: number; learning: PackLearning };
  }> = [];
  cleared = 0;
  answer: PackMemory | null = {
    lang: "ja",
    style: { genre: "", koNames: "han-viet", keepJaHonorifics: true },
    glossary: [{ original: "민준", translation: "Minjun", source: "manual" }],
    pronouns: [],
    history: [{ pos: 1_000, speaker: "", original: "안녕", translation: "Hello" }],
    summary: "So far.",
    askSummary: true,
  };
  context(
    scope: MemoryScope,
    pack: { contentKey: string; docOrder: number; pos: number },
  ): Promise<PackMemory | null> {
    this.contexts.push({ scope, pack });
    return Promise.resolve(this.answer);
  }
  learn(scope: MemoryScope, pack: { packId: string; pos: number; learning: PackLearning }): Promise<void> {
    this.learned.push({ scope, pack });
    return Promise.resolve();
  }
  idle(): Promise<void> {
    return Promise.resolve();
  }
  cacheCleared(): void {
    this.cleared += 1;
  }
}

describe("series memory", () => {
  // FakeFrame's page: https://reader.example/series/1/ch/2, title "Ch. 2".
  const SCOPE: MemoryScope = {
    seriesKey: "https://reader.example|1",
    chapterKey: "https://reader.example/series/1/ch/2",
    siteKey: "https://reader.example",
    url: "https://reader.example/series/1/ch/2",
    title: "Ch. 2",
  };

  test("each pack goes with its page's series context, and what its answers taught is learned afterwards", async () => {
    const memory = new RecordingMemory();
    const h = harness({ memory });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 3), { pos: { docOrder: 4, srcGen: 0, yTop: 0 } }));
    await settle();
    assert.deepEqual(memory.contexts, [
      { scope: SCOPE, pack: { contentKey: "s:p1", docOrder: 4, pos: 4_000 } },
    ]);
    const call = h.translator.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.pack.seriesKey, SCOPE.seriesKey);
    assert.deepEqual(call.pack.memory, memory.answer);
    assert.equal(call.pack.lang, "ja", "the series language wins over the site's source language");
    assert.equal(memory.learned.length, 0, "nothing is learned before the pack ends");

    const learning: PackLearning = {
      terms: [{ original: "서연", translation: "Seoyeon", note: "" }],
      addresses: [{ a: "Minjun", b: "Seoyeon", aSelf: "tớ", aToB: "cậu" }],
      summary: "Minjun meets Seoyeon.",
      lang: "ko",
    };
    call.emitAll();
    call.resolve({ learning });
    await settle();
    assert.deepEqual(memory.learned, [
      { scope: SCOPE, pack: { packId: call.pack.packId, pos: 4_002, learning } },
    ]);
    // Stored records carry the series, so en:cache-clear can clear one series or site.
    assert.equal(h.stores.record("s:p1", "k0")?.seriesKey, SCOPE.seriesKey);
    assert.equal(h.stores.imageRecords.get("s:p1")?.seriesKey, SCOPE.seriesKey);
    h.pipeline.cacheCleared();
    assert.equal(memory.cleared, 1);
  });

  test("without a context (memory off or unavailable) a pack goes as before, still tagged with its series", async () => {
    const memory = new RecordingMemory();
    memory.answer = null;
    const h = harness({ memory });
    h.pipeline.submit(new FakeFrame(1), submitOf("1.0", h.image("p1", 2)));
    await settle();
    const pack = h.translator.calls[0]?.pack;
    assert.equal(pack?.memory, undefined);
    assert.equal(pack?.lang, "ko");
    assert.equal(pack?.seriesKey, SCOPE.seriesKey);
    assert.equal(memory.learned.length, 0, "a report without learning teaches nothing");
  });

  test("the default memory needs the series stores: without them packs simply carry no context", async () => {
    const h = harness();
    h.pipeline.submit(new FakeFrame(1), submitOf("1.0", h.image("p1", 2)));
    await settle();
    const call = h.translator.calls[0];
    assert.equal(call?.pack.memory, undefined);
    assert.equal(call?.pack.seriesKey, SCOPE.seriesKey);
    assert.equal(h.stores.record("s:p1", "k1")?.status, "ok");
  });

  test("a cached image takes the series of the page that shows it now", async () => {
    const h = harness({ memory: new RecordingMemory() });
    const src = h.cache("p1", 1);
    h.pipeline.submit(new FakeFrame(1), submitOf("1.0", src));
    await settle();
    assert.equal(h.stores.imageRecords.get("s:p1")?.seriesKey, SCOPE.seriesKey);
  });
});

describe("series warm-up (memory.warmUp)", () => {
  const COLD: PackMemory = {
    lang: null,
    style: { genre: "", koNames: "romanized", keepJaHonorifics: false },
    glossary: [],
    pronouns: [],
    history: [],
    summary: null,
    askSummary: true,
  };
  const LEARNING: PackLearning = {
    terms: [],
    addresses: [{ a: "Minjun", b: "Seoyeon", aSelf: "tớ", aToB: "cậu" }],
    summary: null,
    lang: "ko",
  };

  function coldHarness(): Harness & { memory: RecordingMemory; frame: FakeFrame; submit(n: number): void } {
    const memory = new RecordingMemory();
    memory.answer = COLD;
    const h = harness({ memory });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    return {
      ...h,
      memory,
      frame,
      submit(n: number) {
        h.pipeline.submit(
          frame,
          submitOf(`${n}.0`, h.image(`p${n}`, 2), { pos: { docOrder: n, srcGen: 0, yTop: n * 1200 } }),
        );
      },
    };
  }

  test("the first request of a series with no memory goes alone; the rest start once it is answered and learned", async () => {
    const h = coldHarness();
    h.submit(1);
    h.submit(2);
    h.submit(3);
    await settle();
    assert.equal(h.translator.calls.length, 1, "the warm-up request goes alone");
    assert.equal(h.memory.contexts.length, 1);
    const first = h.translator.calls[0];
    assert.ok(first !== undefined);
    first.emitAll();
    first.resolve({ learning: LEARNING });
    await settle();
    assert.equal(h.memory.learned.length, 1, "learned before the next requests read their context");
    assert.equal(h.translator.calls.length, 3, "the others go together");
    assert.ok(h.logs.some((entry) => entry.msg === "series warm-up"));
    for (const call of h.translator.calls.slice(1)) {
      call.emitAll();
      call.resolve();
    }
    h.submit(4);
    h.submit(5);
    await settle();
    assert.equal(h.translator.calls.length, 5, "a warmed-up series is not held again");
  });

  test("a series that already has memory, memory.warmUp off or memory off: nothing is held", async () => {
    const warm = harness({ memory: new RecordingMemory() });
    warm.translator.auto = false;
    const frame = new FakeFrame(1);
    for (const n of [1, 2]) {
      warm.pipeline.submit(
        frame,
        submitOf(`${n}.0`, warm.image(`p${n}`, 2), { pos: { docOrder: n, srcGen: 0, yTop: 0 } }),
      );
    }
    await settle();
    assert.equal(warm.translator.calls.length, 2);

    const offs = [
      (s: Settings) => {
        s.memory.warmUp = false;
      },
      (s: Settings) => {
        s.memory.enabled = false;
      },
      (s: Settings) => {
        s.translate.fastMode = true;
      },
    ];
    for (const off of offs) {
      const h = coldHarness();
      h.settings.update(off);
      h.submit(1);
      h.submit(2);
      await settle();
      assert.equal(h.translator.calls.length, 2);
    }
  });

  test("a warm-up request that fails hands over to the next pack; one that hangs frees the rest after WARM_UP_MAX_MS", async () => {
    const h = coldHarness();
    h.submit(1);
    h.submit(2);
    h.submit(3);
    await settle();
    h.translator.calls[0]?.emitAll("error");
    h.translator.calls[0]?.resolve({ error: { code: "engine.internal", message: "x", retryable: false } });
    await settle();
    assert.equal(h.translator.calls.length, 2, "the next pack leads a new warm-up");
    h.clock.advance(WARM_UP_MAX_MS - 1);
    await settle();
    assert.equal(h.translator.calls.length, 2);
    h.clock.advance(1);
    await settle();
    assert.equal(h.translator.calls.length, 3, "a slow warm-up does not hold the series");
  });
});

describe("edits", () => {
  test("an edit reaches every frame showing the image and is stored as manual; null reverts to the AI text", async () => {
    const h = harness();
    const a = new FakeFrame(1);
    const b = new FakeFrame(2);
    const src = h.image("p1", 2);
    h.pipeline.submit(a, submitOf("1.0", src));
    await settle();
    h.pipeline.submit(b, submitOf("7.0", src));
    await settle();
    await h.pipeline.edit({ frameKey: a.info.frameKey, imageKey: "1.0" }, "k0", "  Bản sửa tay ");
    assert.deepEqual(a.shown("1.0").get("k0"), { status: "manual", translation: "Bản sửa tay" });
    assert.deepEqual(b.shown("7.0").get("k0"), { status: "manual", translation: "Bản sửa tay" });
    const edited = h.stores.record("s:p1", "k0");
    assert.deepEqual(
      [edited?.manualTranslation, edited?.manual, edited?.status, edited?.translation],
      ["Bản sửa tay", 1, "manual", "vi:k0"],
    );
    assert.ok(h.stores.flushes >= 1, "edits are flushed right away");
    const delta = h.ui.posts.at(-1)?.message;
    assert.ok(delta?.type === "tx:delta" && delta.items[0]?.manual === true);

    await h.pipeline.edit({ contentKey: "s:p1" }, "k0", null);
    assert.deepEqual(a.shown("1.0").get("k0"), { status: "ok", translation: "vi:k0" });
    assert.deepEqual(b.shown("7.0").get("k0"), { status: "ok", translation: "vi:k0" });
    const reverted = h.stores.record("s:p1", "k0");
    assert.deepEqual([reverted?.manualTranslation, reverted?.manual, reverted?.status], [null, 0, "ok"]);
    assertProtocol(a, false);
    assertProtocol(b, false);
  });

  test("a re-translation never replaces an edit (manual wins), in the frames and in the store", async () => {
    const h = harness();
    const frame = new FakeFrame(3);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 2)));
    await settle();
    await h.pipeline.edit({ contentKey: "s:p1" }, "k1", "Giữ bản này");
    assert.equal(h.pipeline.retranslate({ tabId: 3, contentKey: "s:p1", unitKey: "k1" }), 1);
    await settle();
    assert.deepEqual(frame.shown("1.0").get("k1"), { status: "manual", translation: "Giữ bản này" });
    const stored = h.stores.record("s:p1", "k1");
    assert.deepEqual([stored?.manualTranslation, stored?.manual, stored?.attempts], ["Giữ bản này", 1, 2]);
    const aiWrite = h.stores.writes.at(-1);
    assert.deepEqual(
      [aiWrite?.manual, aiWrite?.manualTranslation],
      [0, null],
      "AI writes never carry the edit",
    );
  });

  test("records follow the real translation store's write protocol", async () => {
    const { mergeTranslation } = await import("../../../src/engine/store/translations.ts");
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1)));
    await settle();
    await h.pipeline.edit({ contentKey: "s:p1" }, "k0", "Sửa");
    h.pipeline.retranslate({ tabId: 1, contentKey: "s:p1", unitKey: "k0" });
    await settle();
    await h.pipeline.edit({ contentKey: "s:p1" }, "k0", null);
    let real: TranslationRecord | undefined;
    let local: TranslationRecord | undefined;
    for (const write of h.stores.writes) {
      real = mergeTranslation(real, write);
      local = mergeRecord(local, write);
      assert.deepEqual(local, real);
    }
    assert.deepEqual([real?.manualTranslation, real?.manual, real?.status], [null, 0, "ok"]);
  });

  test("editing an image that is not in memory updates its stored record", async () => {
    const h = harness();
    h.cache("p9", 2);
    await h.pipeline.edit({ contentKey: "s:p9" }, "k1", "Ngoại tuyến");
    const stored = h.stores.record("s:p9", "k1");
    assert.deepEqual(
      [stored?.manualTranslation, stored?.manual, stored?.translation],
      ["Ngoại tuyến", 1, "cached:k1"],
    );
    await assert.rejects(h.pipeline.edit({ contentKey: "s:p9" }, "nope", "x"), { code: "engine.internal" });
    await assert.rejects(h.pipeline.edit({ frameKey: "9:9:x", imageKey: "1.0" }, "k0", "x"), {
      code: "engine.internal",
    });
  });
});

describe("errors, retry and re-translation", () => {
  test("an acquire failure ends in img:state error with the ErrorInfo", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.image("p1", 1);
    h.acquirer.failures.set(src, new CtvError("image.http", "HTTP 403", { status: 403, retryable: true }));
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    assert.deepEqual(frame.lastState("1.0"), {
      type: "img:state",
      imageKey: "1.0",
      state: "error",
      error: { code: "image.http", message: "HTTP 403", retryable: true, status: 403 },
    });
    assert.ok(h.logs.some((entry) => entry.code === "image.http" && entry.imageKey === "1.0"));
    // retry() starts the image over.
    h.acquirer.failures.clear();
    h.pipeline.retry(frame.info.frameKey, "1.0");
    await settle();
    assert.equal(frame.lastState("1.0")?.state, "done");
  });

  test("a detector failure fails every frame that shows the image", async () => {
    const h = harness();
    const a = new FakeFrame(1);
    const b = new FakeFrame(2);
    const src = h.image("p1", 1);
    h.detector.failures.set("s:p1", new CtvError("detector.run", "inference failed"));
    h.pipeline.submit(a, submitOf("1.0", src));
    h.pipeline.submit(b, submitOf("2.0", src));
    await settle();
    for (const [frame, key] of [
      [a, "1.0"],
      [b, "2.0"],
    ] as const) {
      assert.deepEqual(
        [frame.lastState(key)?.state, frame.lastState(key)?.error?.code],
        ["error", "detector.run"],
      );
    }
    assert.equal(h.decoder.open().length, 0);
    assert.equal(h.translator.calls.length, 0);
  });

  test("a translator failure marks the units error and the image error with the ErrorInfo", async () => {
    const h = harness();
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 2)));
    await settle();
    h.translator.calls[0]?.reject(new CtvError("api.bad_request", "bad body", { status: 400 }));
    await settle();
    assert.deepEqual(Object.fromEntries(frame.shown("1.0")), {
      k0: { status: "error", translation: "" },
      k1: { status: "error", translation: "" },
    });
    const last = frame.lastState("1.0");
    assert.deepEqual(
      [last?.state, last?.error?.code, last?.error?.status],
      ["error", "api.bad_request", 400],
    );
    assert.deepEqual(frame.of("img:done", "1.0")[0]?.counts, { error: 2 });
    assert.equal(h.stores.record("s:p1", "k0")?.status, "error");
    assertProtocol(frame);
  });

  test("retry() re-sends untranslated units on demand, never rate-limited", async () => {
    const h = harness();
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 3)));
    await settle();
    const first = h.translator.calls[0];
    first?.emit("k0");
    first?.emit("k1", "untranslated");
    first?.emit("k2", "refused");
    first?.resolve({ missing: ["k1"] });
    await settle();
    assert.equal(frame.lastState("1.0")?.state, "partial");
    assert.equal(frame.lastState("1.0")?.error?.code, "llm.missing");
    for (let round = 1; round <= 3; round += 1) {
      h.pipeline.retry(frame.info.frameKey, "1.0");
      await settle();
      assert.deepEqual(h.translator.calls[round]?.keys, ["k1"], "refused units need an explicit unit retry");
      assert.equal(frame.shown("1.0").get("k1")?.status, "pending");
      h.translator.calls[round]?.emit("k1", "untranslated");
      h.translator.calls[round]?.resolve();
      await settle();
    }
    h.pipeline.retry(frame.info.frameKey, "1.0", "k2");
    await settle();
    assert.deepEqual(h.translator.calls[4]?.keys, ["k2"]);
    h.translator.calls[4]?.emit("k2");
    h.translator.calls[4]?.resolve();
    await settle();
    assert.equal(h.acquirer.calls.length, 1, "retries decode from the cached bytes, no new fetch");
    assert.equal(h.decoder.open().length, 0);
  });

  test("retranslate(tab) re-sends every unit not edited by hand and returns the count", async () => {
    const h = harness();
    const frame = new FakeFrame(4);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 2)));
    h.pipeline.submit(frame, submitOf("2.0", h.image("p2", 3)));
    await settle();
    await h.pipeline.edit({ contentKey: "s:p2" }, "k0", "Tay");
    assert.equal(h.pipeline.retranslate({ tabId: 99 }), 0);
    assert.equal(h.pipeline.retranslate({ tabId: 4 }), 4);
    await settle();
    assert.equal(h.translator.calls.length, 4);
    assert.deepEqual(
      h.translator.calls
        .slice(2)
        .map((c) => c.keys)
        .sort(),
      [
        ["k0", "k1"],
        ["k1", "k2"],
      ],
    );
    assert.equal(frame.lastState("2.0")?.state, "done");
  });

  test("a forced submit re-translates a cached image", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.cache("p1", 2);
    h.pipeline.submit(frame, submitOf("1.0", src, { force: true }));
    await settle();
    assert.equal(h.detector.calls.length, 0, "geometry stays (D-012)");
    assert.deepEqual(h.translator.calls[0]?.keys, ["k0", "k1"]);
    assert.deepEqual(frame.shown("1.0").get("k0"), { status: "ok", translation: "vi:k0" });
    // A forced resubmit of the same image re-translates again.
    h.pipeline.submit(frame, submitOf("1.0", src, { force: true }));
    await settle();
    assert.equal(h.translator.calls.length, 2);
  });
});

describe("memory and re-acquisition", () => {
  test("packs waiting for a lane hold no bitmap; a pack decodes again when it starts", async () => {
    const h = harness({ concurrency: 1 });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("a", 1)));
    h.pipeline.submit(frame, submitOf("2.0", h.image("b", 1)));
    await settle();
    assert.deepEqual(
      h.decoder.open().map((d) => d.contentKey),
      ["s:a"],
      "only the image in flight keeps its bitmap",
    );
    h.translator.calls[0]?.emitAll();
    h.translator.calls[0]?.resolve();
    await settle();
    assert.deepEqual(
      h.decoder.open().map((d) => d.contentKey),
      ["s:b"],
    );
    assert.equal(h.decoder.decoded.filter((d) => d.contentKey === "s:b").length, 2);
    h.translator.calls[1]?.emitAll();
    h.translator.calls[1]?.resolve();
    await settle();
    assert.equal(h.decoder.open().length, 0);
    assert.equal(frame.lastState("2.0")?.state, "done");
    assert.equal(h.acquirer.calls.length, 2, "decoding again uses the kept bytes, not the network");
  });

  test("a retry after the cached bytes were evicted fetches the image again by URL", async () => {
    const h = harness();
    h.settings.value.cache.encodedBytesLruMb = 0;
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    const src = h.image("a", 1);
    h.pipeline.submit(
      frame,
      submitOf("1.0", src, { acquire: "bytes", bytes: bytesOf("a"), mime: "image/png" }),
    );
    await settle();
    assert.equal(h.acquirer.calls[0]?.submit.acquire, "bytes");
    h.translator.calls[0]?.emit("k0", "untranslated");
    h.translator.calls[0]?.resolve({ missing: ["k0"] });
    await settle();
    h.pipeline.retry(frame.info.frameKey, "1.0");
    await settle();
    assert.equal(h.acquirer.calls.length, 2);
    const again = h.acquirer.calls[1]?.submit;
    assert.deepEqual([again?.acquire, again?.bytes], ["url", undefined], "content-script bytes are not kept");
    assert.equal(h.translator.calls.length, 2);
  });

  test("when the bytes behind a URL changed, the retry fails instead of uploading the wrong image", async () => {
    const h = harness();
    h.settings.value.cache.encodedBytesLruMb = 0;
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    const src = h.image("a", 1);
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    h.translator.calls[0]?.emit("k0", "untranslated");
    h.translator.calls[0]?.resolve();
    await settle();
    h.acquirer.content.set(src, "a-new-version");
    h.pipeline.retry(frame.info.frameKey, "1.0");
    await settle();
    assert.equal(h.translator.calls.length, 1);
    assert.deepEqual(frame.shown("1.0").get("k0"), { status: "error", translation: "" });
    assert.deepEqual(
      [frame.lastState("1.0")?.state, frame.lastState("1.0")?.error?.code],
      ["error", "cancelled"],
    );
  });

  test("a new src under the same imageKey replaces the job", async () => {
    const h = harness();
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("old", 1)));
    await settle();
    h.pipeline.submit(frame, submitOf("1.0", h.image("new", 1)));
    await settle();
    assert.deepEqual(
      h.translator.calls.map((c) => c.pack.units[0]?.contentKey),
      ["s:old", "s:new"],
    );
    for (const call of h.translator.calls) {
      call.emitAll();
      call.resolve();
    }
    await settle();
    assert.deepEqual(
      frame.of("img:done", "1.0").map((m) => m.contentKey),
      ["s:new"],
    );
    assert.equal(h.stores.record("s:old", "k0")?.status, "ok", "the old image's late result is still cached");
  });
});

describe("reading direction", () => {
  test("the site layout decides the direction for detection and for packs of cached images", async () => {
    const h = harness();
    h.settings.siteValue.layout = "paged-rtl";
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("fresh", 1)));
    h.pipeline.submit(
      frame,
      submitOf(
        "2.0",
        h.cache("cached", 1, () => ({ status: "untranslated", translation: "" })),
      ),
    );
    await settle();
    assert.equal(h.detector.options[0]?.dir, "rtl");
    const dirs = new Map(h.translator.calls.map((c) => [c.pack.units[0]?.contentKey, c.pack.dir]));
    assert.deepEqual([dirs.get("s:fresh"), dirs.get("s:cached")], ["rtl", "rtl"]);
  });

  test("webtoon strips read left to right whatever the language", async () => {
    const h = harness();
    h.settings.siteValue.sourceLang = "ja";
    h.decoder.sizes.set("s:strip", { w: 800, h: 6000 });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("strip", 1)));
    h.pipeline.submit(frame, submitOf("2.0", h.image("page", 1)));
    await settle();
    assert.deepEqual(
      h.detector.options.map((o) => o.dir),
      ["ltr", "rtl"],
    );
  });
});

describe("status and contract", () => {
  test("queueStatus reports lanes, counters and the box budget of the configured model", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 1)));
    await settle();
    assert.deepEqual(h.pipeline.queueStatus(), {
      queued: 0,
      inFlight: 0,
      urgentInFlight: 0,
      done: 1,
      failed: 0,
      pausedBy: null,
      concurrency: 2,
      boxBudget: MODEL_PROFILES.gpt4o.boxBudget,
    });
    assert.equal(h.settings.current().api.model, "gpt-4o-mini", "the default model uses the gpt4o profile");
    h.settings.update((s) => {
      s.api.model = "gpt-5.2";
    });
    assert.equal(h.pipeline.queueStatus().boxBudget, MODEL_PROFILES.gpt5.boxBudget);
    h.settings.update((s) => {
      s.api.model = "llava:13b";
    });
    assert.equal(h.pipeline.queueStatus().boxBudget, MODEL_PROFILES.default.boxBudget);
    h.settings.update((s) => {
      s.translate.boxBudget = 8;
    });
    assert.equal(h.pipeline.queueStatus().boxBudget, 8, "an explicit budget wins over the profile");
  });

  test("message order per frame holds across cache hits, streaming, sharing and edits", async () => {
    const h = harness();
    h.translator.auto = false;
    const a = new FakeFrame(1);
    const b = new FakeFrame(2);
    const fresh = h.image("fresh", 4);
    h.pipeline.submit(a, submitOf("1.0", h.cache("cached", 2)));
    h.pipeline.submit(a, submitOf("2.0", fresh));
    h.pipeline.submit(b, submitOf("3.0", fresh));
    h.pipeline.submit(b, submitOf("4.0", h.image("blank", 0)));
    await settle();
    const call = h.translator.calls[0];
    call?.emit("k0");
    call?.emit("k1", "keep-original");
    await settle();
    call?.emit("k2");
    call?.emit("k3", "ignored");
    call?.resolve();
    await settle();
    assertProtocol(a);
    assertProtocol(b);
    for (const [frame, key] of [
      [a, "1.0"],
      [a, "2.0"],
      [b, "3.0"],
      [b, "4.0"],
    ] as const) {
      assert.equal(frame.of("img:units", key).length, 1, `${key}: one img:units`);
      assert.equal(frame.of("img:done", key).length, 1, `${key}: one img:done`);
    }
  });

  test("createPipeline fits ServiceFactories.createPipeline", () => {
    const factory: ServiceFactories["createPipeline"] = createPipeline;
    assert.equal(typeof factory, "function");
  });
});

describe("look-ahead and screen captures", () => {
  test("a prefetch candidate is detected but nothing is uploaded until a submit without prefetch", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.image("ahead", 3);
    h.pipeline.submit(frame, submitOf("1.0", src, { natural: null, prefetch: true, priority: 9 }));
    await settle();
    assert.deepEqual(h.detector.calls, ["s:ahead"]);
    assert.equal(h.translator.calls.length, 0, "detected only");
    assert.equal(frame.of("img:units", "1.0")[0]?.units.length, 3);
    assert.equal(frame.lastState("1.0")?.state, "waiting");
    assert.equal(h.decoder.open().length, 0, "the bitmap is not kept while waiting");
    // The reader got near it (translate window, or the page loaded it): same src, no prefetch.
    h.pipeline.submit(frame, submitOf("1.0", src, { natural: null, priority: 3 }));
    await settle();
    assert.equal(h.translator.calls.length, 1);
    assert.equal(h.detector.calls.length, 1, "no second detection");
    assert.equal(frame.lastState("1.0")?.state, "done");
  });

  test("a prefetch job on a stored work fetches nothing and uploads nothing until it is wanted", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.cache("stored", 2, () => null);
    h.pipeline.submit(frame, submitOf("1.0", src, { natural: null, prefetch: true }));
    await settle();
    assert.equal(h.acquirer.calls.length, 0, "no bytes needed to wait");
    assert.equal(h.translator.calls.length, 0);
    assert.equal(frame.lastState("1.0")?.state, "waiting");
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    assert.equal(h.acquirer.calls.length, 1, "bytes for the pass");
    assert.equal(h.translator.calls.length, 1);
    assert.equal(frame.lastState("1.0")?.state, "done");
  });

  test("a cached, translated image answers a prefetch submit at once (no upload)", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.cache("done", 2);
    h.pipeline.submit(frame, submitOf("1.0", src, { natural: null, prefetch: true }));
    await settle();
    assert.equal(h.translator.calls.length, 0);
    assert.equal(frame.lastState("1.0")?.state, "done");
    assert.equal(frame.shown("1.0").get("k0")?.translation, "cached:k0");
  });

  test("en:horizons: with the first submit, when the reading speed changes, Strip maximum for strips", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 0)));
    await settle();
    const horizons = (): Array<Msg<"en:horizons">> => frame.of("en:horizons");
    assert.deepEqual(horizons(), [
      { type: "en:horizons", translateScreens: 6, detectScreens: 15, detectMaxImages: 25 },
    ]);
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 1, onScreen: [] };
    h.pipeline.priority(frame.info.frameKey, []);
    h.pipeline.priority(frame.info.frameKey, []);
    assert.deepEqual(horizons().slice(1), [
      { type: "en:horizons", translateScreens: 10, detectScreens: 45, detectMaxImages: 25 },
    ]);
    h.pipeline.submit(frame, submitOf("2.0", h.image("p2", 0), { strip: { stripId: "s1", index: 0 } }));
    await settle();
    assert.equal(horizons().at(-1)?.translateScreens, 15, "lookaheadMaxScreensStrip");
    assert.equal(horizons().length, 3, "sent only when something changed");
  });

  test("the measured request latency moves the translate window", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 2)));
    await settle();
    assert.equal(frame.of("en:horizons")[0]?.translateScreens, 6);
    // The fake translator reports 2 ms per pack: the EMA falls towards the minimum window.
    for (let i = 0; i < 12; i += 1) {
      h.pipeline.submit(frame, submitOf(`${i + 2}.0`, h.image(`more${i}`, 1)));
      await settle();
    }
    assert.equal(
      frame.of("en:horizons").at(-1)?.translateScreens,
      h.settings.value.discovery.lookaheadMinScreens,
    );
  });

  test("an image read from a screen capture is marked lowRes in img:units and in its stored record", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const src = h.image("shot", 2);
    const acquire = h.acquirer.acquire.bind(h.acquirer);
    h.acquirer.acquire = async (submit, ctx) => ({
      ...(await acquire(submit, ctx)),
      source: "capture",
      lowRes: true,
      url: null,
    });
    h.pipeline.submit(frame, submitOf("1.0", src, { element: "canvas", acquire: "capture" }));
    await settle();
    assert.equal(frame.of("img:units", "1.0")[0]?.lowRes, true);
    assert.deepEqual(
      [h.stores.imageRecords.get("s:shot")?.source, h.stores.imageRecords.get("s:shot")?.lowRes],
      ["capture", true],
    );
    assert.equal(frame.lastState("1.0")?.state, "done");
    h.acquirer.acquire = acquire;
    const plain = new FakeFrame(2);
    h.pipeline.submit(plain, submitOf("1.0", h.image("plain", 1)));
    await settle();
    assert.equal(plain.of("img:units", "1.0")[0]?.lowRes, undefined);
  });
});

describe("offline mode (experimental)", () => {
  test("neither the privacy notice nor a sendable API holds packs: nothing is uploaded", async () => {
    const h = harness({ ack: false, readiness: "unreachable" });
    h.settings.value.translate.engine = "offline";
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("1.0", h.image("p1", 2)));
    await settle();
    assert.equal(h.translator.calls.length, 1);
    assert.equal(frame.lastState("1.0")?.state, "done");
    assert.equal(h.pipeline.queueStatus().pausedBy, null);
    h.settings.update((s) => {
      s.translate.engine = "api";
    });
    h.pipeline.submit(frame, submitOf("2.0", h.image("p2", 1)));
    await settle();
    assert.equal(frame.lastState("2.0")?.error?.code, "privacy.consent", "API mode keeps its gates");
  });

  test("stored translations count only for the engine (and offline model) that wrote them", async () => {
    const h = harness();
    h.settings.value.translate.engine = "offline";
    h.settings.value.translate.offlineModel = "opus-mt";
    const frame = new FakeFrame(1);
    const src = h.cache("t1", 4, (key) =>
      key === "k0"
        ? { model: "offline:opus-mt-ko-en" }
        : key === "k1"
          ? { model: "offline:nllb-200-distilled-600m" }
          : key === "k2"
            ? { manualTranslation: "Mine", manual: 1, status: "manual" }
            : {},
    );
    h.pipeline.submit(frame, submitOf("1.0", src));
    await settle();
    assert.deepEqual(
      h.translator.calls.map((c) => c.keys),
      [["k1", "k3"]],
      "the NLLB and the API records are redone; the Opus-MT one and the manual edit stay",
    );
  });

  test("switching the engine drops idle translations held in memory", async () => {
    const h = harness();
    const frame = new FakeFrame(1);
    const request = submitOf("1.0", h.image("a", 1));
    h.pipeline.submit(frame, request);
    await settle();
    h.pipeline.submit(frame, request);
    await settle();
    assert.equal(h.translator.calls.length, 1, "replayed from memory");
    h.settings.value.translate.engine = "offline";
    h.pipeline.submit(frame, { ...request, force: true });
    await settle();
    assert.equal(h.translator.calls.length, 2, "the other engine translates again");
  });
});

describe("cross-image packs (translate.packWaitMs)", () => {
  const imagesOf = (call: TranslateCall): string[] => [...new Set(call.pack.units.map((u) => u.contentKey))];

  test("paged images of one frame detected together share requests, two pages per composite", async () => {
    const h = harness({ packWaitMs: 500 });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["0.0"] };
    for (const [i, label] of ["a", "b", "c"].entries()) {
      h.pipeline.submit(
        frame,
        submitOf(`${i}.0`, h.image(label, 2), { pos: { docOrder: i, srcGen: 0, yTop: i * 1200 } }),
      );
    }
    await settle();
    assert.deepEqual(
      h.translator.calls.map(imagesOf),
      [["s:a", "s:b"], ["s:c"]],
      "two requests instead of three; a composite shows at most two page thumbnails",
    );
    assert.equal(h.translator.calls[0]?.pack.images.size, 2, "both images are decoded for the composite");
    for (const call of h.translator.calls) {
      call.emitAll();
      call.resolve();
    }
    await settle();
    for (const key of ["0.0", "1.0", "2.0"]) {
      assert.equal(frame.of("img:done", key).length, 1, `${key} done`);
      assert.equal(frame.lastState(key)?.state, "done");
    }
    assertProtocol(frame);
  });

  test("webtoon strip images share one request (each shown as a band around its balloons)", async () => {
    const h = harness({ packWaitMs: 500 });
    const frame = new FakeFrame(1);
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["0.0"] };
    for (const [i, label] of ["s1", "s2", "s3", "s4"].entries()) {
      h.decoder.sizes.set(`s:${label}`, { w: 800, h: 2400 });
      h.pipeline.submit(
        frame,
        submitOf(`${i}.0`, h.image(label, 2), {
          natural: { w: 800, h: 2400 },
          pos: { docOrder: i, srcGen: 0, yTop: i * 2400 },
        }),
      );
    }
    await settle();
    assert.deepEqual(h.translator.calls.map(imagesOf), [["s:s1", "s:s2", "s:s3", "s:s4"]]);
    for (const key of ["0.0", "1.0", "2.0", "3.0"]) assert.equal(frame.lastState(key)?.state, "done", key);
  });

  test("a gather leaves as soon as it fills a request (boxBudget)", async () => {
    const h = harness({ packWaitMs: 5_000 });
    h.settings.value.translate.boxBudget = 4;
    const frame = new FakeFrame(1);
    for (const [i, label] of ["a", "b", "c", "d"].entries()) {
      h.pipeline.submit(
        frame,
        submitOf(`${i}.0`, h.image(label, 2), { pos: { docOrder: i, srcGen: 0, yTop: 0 } }),
      );
    }
    await settle();
    const sizes = h.translator.calls.map((c) => c.keys.length);
    assert.ok(
      sizes.every((n) => n <= 4),
      `packs ${JSON.stringify(sizes)}`,
    );
    assert.equal(
      sizes.reduce((a, b) => a + b, 0),
      8,
    );
    assert.equal(sizes.length, 2, "two full requests instead of four small ones");
  });

  test("on screen, ready text waits at most packWaitMs for an image that is still being detected", async () => {
    const h = harness({ packWaitMs: 500 });
    const frame = new FakeFrame(1);
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["0.0"] };
    const release = Promise.withResolvers<void>();
    h.image("slow", 2);
    h.detector.holds.set("s:slow", release.promise);
    h.pipeline.submit(frame, submitOf("0.0", h.image("fast", 2)));
    h.pipeline.submit(frame, submitOf("1.0", srcOf("slow"), { pos: { docOrder: 1, srcGen: 0, yTop: 0 } }));
    await settle();
    assert.equal(h.translator.calls.length, 0, "the fast image waits for its neighbour");
    h.clock.advance(500);
    await settle();
    assert.deepEqual(h.translator.calls.map(imagesOf), [["s:fast"]], "the wait ran out: it goes alone");
    release.resolve();
    await settle();
    h.clock.advance(500 * AHEAD_WAIT_FACTOR);
    await settle();
    assert.deepEqual(
      h.translator.calls.map(imagesOf),
      [["s:fast"], ["s:slow"]],
      "the slow one is ahead of the reader",
    );
  });

  test("on screen, a neighbour that turns out to have no text releases the waiting request at once", async () => {
    const h = harness({ packWaitMs: 5_000 });
    const frame = new FakeFrame(1);
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["0.0"] };
    const release = Promise.withResolvers<void>();
    h.image("blank", 0);
    h.detector.holds.set("s:blank", release.promise);
    h.pipeline.submit(frame, submitOf("0.0", h.image("text", 3)));
    h.pipeline.submit(frame, submitOf("1.0", srcOf("blank"), { pos: { docOrder: 1, srcGen: 0, yTop: 0 } }));
    await settle();
    assert.equal(h.translator.calls.length, 0);
    release.resolve();
    await settle();
    assert.deepEqual(h.translator.calls.map(imagesOf), [["s:text"]], "no timer needed");
  });

  test("images ahead of the reader wait longer to share a request, and leave when the reader arrives", async () => {
    const h = harness({ packWaitMs: 500 });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("0.0", h.image("ahead", 2)));
    await settle();
    h.clock.advance(500);
    await settle();
    assert.equal(h.translator.calls.length, 0, "ahead of the reader: still waiting for neighbours");
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["0.0"] };
    h.pipeline.priority(frame.info.frameKey, []);
    await settle();
    assert.equal(h.translator.calls.length, 1, "the reader reached it: sent at once");
  });

  test("images ahead of the reader leave after AHEAD_WAIT_FACTOR × packWaitMs at the latest", async () => {
    const h = harness({ packWaitMs: 500 });
    const frame = new FakeFrame(1);
    h.pipeline.submit(frame, submitOf("0.0", h.image("ahead", 2)));
    await settle();
    h.clock.advance(500 * AHEAD_WAIT_FACTOR);
    await settle();
    assert.equal(h.translator.calls.length, 1);
  });

  test("a failed shared request fails the units of every image in it", async () => {
    const h = harness({ packWaitMs: 500 });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    frame.info.viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["0.0"] };
    h.pipeline.submit(frame, submitOf("0.0", h.image("a", 1)));
    h.pipeline.submit(frame, submitOf("1.0", h.image("b", 1), { pos: { docOrder: 1, srcGen: 0, yTop: 0 } }));
    await settle();
    assert.equal(h.translator.calls.length, 1);
    h.translator.calls[0]?.reject(new CtvError("api.bad_request", "rejected"));
    await settle();
    for (const key of ["0.0", "1.0"]) assert.equal(frame.lastState(key)?.state, "error", key);
  });

  test("forgetting one image of a queued shared request re-sends the other image on its own", async () => {
    const h = harness({ packWaitMs: 500, concurrency: 1 });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    frame.info.viewport = {
      scrollY: 0,
      innerHeight: 900,
      secondsPerScreen: 4,
      onScreen: ["9.0", "0.0", "1.0"],
    };
    h.pipeline.submit(
      frame,
      submitOf("9.0", h.image("blocker", 1), { pos: { docOrder: 9, srcGen: 0, yTop: 0 } }),
    );
    await settle();
    h.clock.advance(500);
    await settle();
    assert.equal(h.translator.calls.length, 1, "the blocker holds the only lane");
    h.pipeline.submit(frame, submitOf("0.0", h.image("a", 1)));
    h.pipeline.submit(frame, submitOf("1.0", h.image("b", 1), { pos: { docOrder: 1, srcGen: 0, yTop: 0 } }));
    await settle();
    h.pipeline.forget(frame.info.frameKey, ["0.0"]);
    await settle();
    const blocker = h.translator.calls[0];
    blocker?.emitAll();
    blocker?.resolve();
    await settle();
    assert.deepEqual(h.translator.calls.slice(1).map(imagesOf), [["s:b"]], "only the image still shown");
  });
});

describe("late binding: queued packs merge when a lane frees up", () => {
  const imagesOf = (call: TranslateCall): string[] => [...new Set(call.pack.units.map((u) => u.contentKey))];

  /** One image at a time, each leaving its gather on the look-ahead timer while the only lane is busy. */
  async function queueOneByOne(
    h: Harness,
    frame: FakeFrame,
    labels: readonly string[],
    strip = false,
  ): Promise<void> {
    for (const [i, label] of labels.entries()) {
      if (strip) h.decoder.sizes.set(`s:${label}`, { w: 800, h: 2400 });
      h.pipeline.submit(
        frame,
        submitOf(`${i}.0`, h.image(label, 2), {
          ...(strip ? { natural: { w: 800, h: 2400 } } : {}),
          pos: { docOrder: i, srcGen: 0, yTop: 0 },
        }),
      );
      await settle();
      h.clock.advance(500 * AHEAD_WAIT_FACTOR);
      await settle();
    }
  }

  async function busyLane(h: Harness, frame: FakeFrame): Promise<void> {
    h.pipeline.submit(
      frame,
      submitOf("9.0", h.image("blocker", 1), { pos: { docOrder: 9, srcGen: 0, yTop: 0 } }),
    );
    await settle();
    h.clock.advance(500 * AHEAD_WAIT_FACTOR);
    await settle();
    assert.equal(h.translator.calls.length, 1, "the blocker holds the only lane");
  }

  test("packs queued behind a busy lane leave as one request; each image still gets its results", async () => {
    const h = harness({ concurrency: 1, packWaitMs: 500 });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    await busyLane(h, frame);
    await queueOneByOne(h, frame, ["a", "b", "c"]);
    assert.equal(h.translator.calls.length, 1, "three packs wait for the lane");
    h.translator.calls[0]?.emitAll();
    h.translator.calls[0]?.resolve();
    await settle();
    const next = h.translator.calls.slice(1);
    assert.deepEqual(next.map(imagesOf), [["s:a", "s:b"]], "merged; a composite shows at most two pages");
    for (const call of h.translator.calls.slice(1)) {
      call.emitAll();
      call.resolve();
    }
    await settle();
    for (const call of h.translator.calls.slice(2)) {
      call.emitAll();
      call.resolve();
    }
    await settle();
    for (const key of ["0.0", "1.0", "2.0"]) assert.equal(frame.lastState(key)?.state, "done", key);
    assertProtocol(frame);
  });

  test("queued strip images merge up to boxBudget", async () => {
    const h = harness({ concurrency: 1, packWaitMs: 500 });
    h.settings.value.translate.boxBudget = 6;
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    await busyLane(h, frame);
    await queueOneByOne(h, frame, ["s1", "s2", "s3", "s4"], true);
    h.translator.calls[0]?.emitAll();
    h.translator.calls[0]?.resolve();
    await settle();
    const second = h.translator.calls[1];
    assert.ok(second !== undefined);
    assert.deepEqual(imagesOf(second), ["s:s1", "s:s2", "s:s3"]);
    assert.equal(second.keys.length, 6, "filled to boxBudget");
  });

  test("packWaitMs 0 keeps one request per image", async () => {
    const h = harness({ concurrency: 1, packWaitMs: 0 });
    h.translator.auto = false;
    const frame = new FakeFrame(1);
    await busyLane(h, frame);
    await queueOneByOne(h, frame, ["a", "b"]);
    h.translator.calls[0]?.emitAll();
    h.translator.calls[0]?.resolve();
    await settle();
    assert.deepEqual(h.translator.calls.slice(1).map(imagesOf), [["s:a"]]);
  });
});
