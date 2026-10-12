import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type {
  Clock,
  DecodedImage,
  DetectOptions,
  KvStore,
  ServiceFactories,
} from "../../../src/engine/contracts.ts";
import {
  CANARY_IMAGE,
  CANARY_REFERENCE,
  FP32_MODEL,
  INT8_MODEL,
  ORT_WASM_PATH,
  chromeMajorOf,
  createDetector,
  decisionUsable,
  gpuLabel,
  sessionOptions,
} from "../../../src/engine/detector.ts";
import type {
  BackendSetting,
  CspViolation,
  Detector,
  DetectorBackend,
  GpuInfo,
  OrtEnvLike,
  OrtLike,
  OrtSessionLike,
  OrtSessionOptions,
  OrtTensorLike,
} from "../../../src/engine/detector.ts";
import type {
  BuildInfo,
  FetchResponseLike,
  ModelEntry,
  ModelFiles,
} from "../../../src/engine/model-files.ts";
import type { TilePixels } from "../../../src/engine/tiling.ts";
import { createLogger } from "../../../src/platform/log.ts";
import { parseCanaryReference } from "../../../src/shared/core/detector-io.ts";
import type { RawBox } from "../../../src/shared/core/detector-io.ts";
import { detectorVersionOf } from "../../../src/shared/core/units-build.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { Gfx, ImageDataLike } from "../../../src/shared/gfx.ts";
import type { DetectorDecision, KvKey, KvMap } from "../../../src/shared/records.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import type { Settings } from "../../../src/shared/settings.ts";
import type { LogEntry, Size } from "../../../src/shared/types.ts";

const BASE = "chrome-extension://test/";
const SHA_FP32 = "4a01e0bf9c265248f0eeb2f657789ddeaf9ac169d6566ddaf255a0e59afc44fa";
const SHA_INT8 = "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79";
const CANARY_SIZE = { w: 800, h: 1200 };
const REFERENCE_JSON: unknown = JSON.parse(
  readFileSync(new URL("../../../assets/canary/canary-01.ref-v4s-fp32-wasm.json", import.meta.url), "utf8"),
);
const REFERENCE_ROWS = parseCanaryReference(REFERENCE_JSON).detections;
const NVIDIA: GpuInfo = {
  vendor: "nvidia",
  architecture: "turing",
  device: "",
  description: "",
  fallback: false,
};

const OPTIONS: DetectOptions = {
  scoreMin: 0.3,
  slice: { triggerRatio: 3.5, heightRatio: 3, overlap: 0.2, overlapMinPx: 200, quietRows: false },
  dir: "ltr",
};

const row = (label: number, score: number, x1: number, y1: number, x2: number, y2: number): RawBox => ({
  label,
  score,
  box: [x1, y1, x2, y2],
});

/** What every slice of a test image "contains", in slice px: a bubble with its text, and faint free text. */
const TILE_ROWS = [
  row(0, 0.9, 100, 100, 400, 300),
  row(1, 0.85, 150, 150, 350, 250),
  row(2, 0.2, 100, 500, 400, 540),
];

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/* ------------------------------------------------------------------ fakes */

interface FakeEnv {
  logLevel?: NonNullable<OrtEnvLike["logLevel"]>;
  versions: { web?: string };
  wasm: OrtEnvLike["wasm"];
  webgpu: { device?: unknown };
}

interface FakeDevice {
  lost: Promise<{ reason?: string; message?: string }>;
  adapterInfo: { vendor: string; architecture: string };
  lose(reason: string): void;
}

function fakeDevice(): FakeDevice {
  let lose: (info: { reason?: string; message?: string }) => void = () => undefined;
  const lost = new Promise<{ reason?: string; message?: string }>((resolve) => {
    lose = resolve;
  });
  return {
    lost,
    adapterInfo: { vendor: "nvidia", architecture: "turing" },
    lose: (reason) => lose({ reason, message: "gpu process crashed" }),
  };
}

class FakeSession implements OrtSessionLike {
  readonly inputNames = ["images", "orig_target_sizes"];
  readonly outputNames = ["labels", "boxes", "scores"];
  released = false;
  readonly ort: FakeOrt;
  readonly backend: DetectorBackend;

  constructor(ort: FakeOrt, backend: DetectorBackend) {
    this.ort = ort;
    this.backend = backend;
  }

  async run(feeds: Record<string, OrtTensorLike>): Promise<Readonly<Record<string, OrtTensorLike>>> {
    const ort = this.ort;
    if (this.released) throw new Error("run on a released session");
    ort.active++;
    ort.maxActive = Math.max(ort.maxActive, ort.active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const images = feeds["images"]?.data;
      const sizes = feeds["orig_target_sizes"]?.data;
      assert.ok(images instanceof Float32Array && images.length === 3 * 640 * 640);
      assert.ok(sizes instanceof BigInt64Array && sizes.length === 2);
      const target = { w: Number(sizes[0]), h: Number(sizes[1]) };
      const kind =
        target.w === 640 && target.h === 640 ? "warmup" : sameSize(target, CANARY_SIZE) ? "canary" : "tile";
      ort.runs.push({ backend: this.backend, kind, target });
      const failure = ort.failRun?.(this.backend, kind);
      if (failure !== undefined && failure !== null) throw new Error(failure);
      if (kind === "warmup") return ort.outputs([]);
      if (kind === "canary") return ort.outputs(ort.canaryRows);
      return ort.outputs(ort.tileRows);
    } finally {
      ort.active--;
    }
  }

  release(): Promise<void> {
    this.released = true;
    return this.ort.failRelease ? Promise.reject(new Error("release failed")) : Promise.resolve();
  }
}

function sameSize(a: Size, b: Size): boolean {
  return a.w === b.w && a.h === b.h;
}

class FakeOrt implements OrtLike {
  readonly env: FakeEnv = { versions: { web: "1.30.0" }, wasm: {}, webgpu: {} };
  readonly creates: Array<{ backend: DetectorBackend; options: OrtSessionOptions; bytes: number }> = [];
  readonly sessions: FakeSession[] = [];
  readonly runs: Array<{ backend: DetectorBackend; kind: "warmup" | "canary" | "tile"; target: Size }> = [];
  readonly devices: FakeDevice[] = [];
  failCreate: Partial<Record<DetectorBackend, string>> = {};
  failRun: ((backend: DetectorBackend, kind: string) => string | null) | null = null;
  failRelease = false;
  canaryRows: RawBox[] = REFERENCE_ROWS;
  tileRows: RawBox[] = TILE_ROWS;
  active = 0;
  maxActive = 0;
  tensors = 0;
  disposed = 0;

  createSession(model: Uint8Array<ArrayBuffer>, options: OrtSessionOptions): Promise<OrtSessionLike> {
    const backend = options.executionProviders[0] ?? "wasm";
    this.creates.push({ backend, options, bytes: model.byteLength });
    const failure = this.failCreate[backend];
    if (failure !== undefined) return Promise.reject(new Error(failure));
    if (backend === "webgpu") {
      const device = fakeDevice();
      this.devices.push(device);
      this.env.webgpu.device = device;
    }
    const session = new FakeSession(this, backend);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  float32(data: Float32Array): OrtTensorLike {
    return this.tensor(data);
  }

  int64(data: BigInt64Array): OrtTensorLike {
    return this.tensor(data);
  }

  tensor(data: unknown): OrtTensorLike {
    this.tensors++;
    return { data, dispose: () => void this.disposed++ };
  }

  outputs(rows: readonly RawBox[]): Record<string, OrtTensorLike> {
    const labels = new BigInt64Array(300);
    const boxes = new Float32Array(1200);
    const scores = new Float32Array(300);
    rows.forEach((r, i) => {
      labels[i] = BigInt(r.label);
      scores[i] = r.score;
      boxes.set(r.box, 4 * i);
    });
    return { labels: this.tensor(labels), boxes: this.tensor(boxes), scores: this.tensor(scores) };
  }

  kinds(): string[] {
    return this.runs.map((r) => `${r.backend}:${r.kind}`);
  }
}

class FakeModels implements ModelFiles {
  readonly loads: string[] = [];
  readonly failLoad = new Map<string, Error>();
  readonly info: BuildInfo = {
    buildId: "0.1.0+test",
    mode: "test",
    ort: "1.30.0",
    models: [
      { file: FP32_MODEL, sha256: SHA_FP32, bytes: 4 },
      { file: INT8_MODEL, sha256: SHA_INT8, bytes: 4 },
    ],
  };

  buildInfo(): Promise<BuildInfo> {
    return Promise.resolve(this.info);
  }

  entry(file: string): Promise<ModelEntry> {
    const found = this.info.models.find((m) => m.file === file);
    return found === undefined ? Promise.reject(new Error(`no ${file}`)) : Promise.resolve(found);
  }

  load(file: string): Promise<Uint8Array<ArrayBuffer>> {
    this.loads.push(file);
    const failure = this.failLoad.get(file);
    return failure === undefined ? Promise.resolve(new Uint8Array(4)) : Promise.reject(failure);
  }
}

class FakeKv implements KvStore {
  readonly data = new Map<KvKey, unknown>();
  writes = 0;
  broken = false;

  get<K extends KvKey>(key: K): Promise<KvMap[K] | undefined> {
    if (this.broken) return Promise.reject(new Error("idb read failed"));
    return Promise.resolve(structuredClone(this.data.get(key)) as KvMap[K] | undefined);
  }

  set<K extends KvKey>(key: K, value: KvMap[K]): Promise<void> {
    if (this.broken) return Promise.reject(new Error("idb write failed"));
    this.writes++;
    this.data.set(key, structuredClone(value));
    return Promise.resolve();
  }

  decision(): DetectorDecision | undefined {
    return this.data.get("detector.decision") as DetectorDecision | undefined;
  }
}

class ManualClock implements Clock {
  t = 1_760_000_000_000;
  readonly timers: Array<{ at: number; fn: () => void; live: boolean }> = [];

  now(): number {
    return this.t;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

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

function white(w: number, h: number): ImageDataLike {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
}

const fakePixels: TilePixels = {
  stretch: (_source, _rect, side) => Promise.resolve(white(side, side)),
  region: (_source, rect) => Promise.resolve(white(rect.w, rect.h)),
  decode: () => Promise.resolve({ source: {}, size: CANARY_SIZE, close: () => undefined }),
};

const unusedGfx: Gfx = {
  createCanvas: () => {
    throw new Error("unused");
  },
  encodeJpeg: () => Promise.reject(new Error("unused")),
  encodePng: () => Promise.reject(new Error("unused")),
  loadImage: () => Promise.reject(new Error("unused")),
};

interface Harness {
  ort: FakeOrt;
  models: FakeModels;
  kv: FakeKv;
  clock: ManualClock;
  settings: Settings;
  logs: LogEntry[];
  fetched: string[];
  csp: Array<(violation: CspViolation) => void>;
  detector: Detector;
}

interface HarnessOptions {
  ort?: FakeOrt;
  /** Replaces the ORT import (default: resolves `ort`). */
  loadOrt?: () => Promise<OrtLike>;
  kv?: FakeKv;
  models?: FakeModels;
  clock?: ManualClock;
  gpu?: GpuInfo | null;
  probeGpu?: () => Promise<GpuInfo | null>;
  chromeMajor?: number;
  backend?: BackendSetting;
  /** Package files served by the fake fetch (default: the canary image and reference); null = 404. */
  file?: (path: string) => unknown;
}

function canaryFile(path: string): unknown {
  if (path === CANARY_IMAGE) return new Uint8Array([137, 80, 78, 71]);
  return path === CANARY_REFERENCE ? REFERENCE_JSON : null;
}

function harness(options: HarnessOptions = {}): Harness {
  const ort = options.ort ?? new FakeOrt();
  const models = options.models ?? new FakeModels();
  const kv = options.kv ?? new FakeKv();
  const clock = options.clock ?? new ManualClock();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.detector.backend = options.backend ?? "auto";
  const logs: LogEntry[] = [];
  const fetched: string[] = [];
  const csp: Array<(violation: CspViolation) => void> = [];
  const gpu = options.gpu === undefined ? NVIDIA : options.gpu;
  const fetchFile = (url: string): Promise<FetchResponseLike> => {
    fetched.push(url);
    const body = (options.file ?? canaryFile)(url.slice(BASE.length));
    return Promise.resolve({
      ok: body !== null,
      status: body === null ? 404 : 200,
      arrayBuffer: () =>
        Promise.resolve(body instanceof Uint8Array ? body.slice().buffer : new ArrayBuffer(0)),
      json: () => Promise.resolve(body),
    });
  };
  const detector = createDetector(
    {
      clock,
      log: createLogger("engine", { sinks: [(e) => logs.push(e)], minLevel: "debug", now: () => clock.t }),
      settings: { current: () => settings },
      stores: { kv, models: { get: () => Promise.resolve(undefined), put: () => Promise.resolve() } },
      gfx: unusedGfx,
    },
    {
      loadOrt: options.loadOrt ?? (() => Promise.resolve(ort)),
      getURL: (path) => BASE + path,
      fetch: fetchFile,
      probeGpu: options.probeGpu ?? (() => Promise.resolve(gpu)),
      chromeMajor: () => options.chromeMajor ?? 154,
      pixels: fakePixels,
      models,
      now: () => 0,
      listenCsp: (listener) => {
        csp.push(listener);
        return () => undefined;
      },
    },
  );
  return { ort, models, kv, clock, settings, logs, fetched, csp, detector };
}

function decoded(w: number, h: number): DecodedImage {
  return { contentKey: `s:${w}x${h}`, size: { w, h }, bitmap: {} as ImageBitmap, release: () => undefined };
}

const PAGE = decoded(800, 1000);
const STRIP = decoded(800, 7680);

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<CtvError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return error instanceof CtvError && error.code === code;
  });
  return caught as CtvError;
}

/* ------------------------------------------------------------------ tests */

describe("contract", () => {
  test("createDetector fits ServiceFactories.createDetector", () => {
    const factory: ServiceFactories["createDetector"] = createDetector;
    assert.equal(typeof factory, "function");
  });

  test("starts unloaded, with the canary pending, and touches nothing until used", () => {
    const h = harness();
    assert.deepEqual(h.detector.state(), { backend: "none", state: "unloaded", canary: "pending" });
    assert.equal(h.ort.creates.length, 0);
    assert.equal(h.fetched.length, 0);
  });

  test("helpers: Chrome major from the user agent, GPU label, Phase 0 session options", () => {
    assert.equal(
      chromeMajorOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.8037.98 Safari/537.36",
      ),
      154,
    );
    assert.equal(chromeMajorOf("Node.js/24"), 0);
    assert.equal(gpuLabel(NVIDIA), "nvidia / turing");
    assert.deepEqual(sessionOptions("webgpu"), {
      executionProviders: ["webgpu"],
      freeDimensionOverrides: { N: 1 },
      graphOptimizationLevel: "all",
    });
  });
});

describe("backend choice (auto)", () => {
  test("WebGPU passes the canary: fp32 on WebGPU, verdict stored, ORT configured as in Phase 0", async () => {
    const h = harness();
    const result = await h.detector.detect(PAGE, OPTIONS);
    assert.equal(result.backend, "webgpu");
    assert.deepEqual(h.detector.state(), { backend: "webgpu", state: "ready", canary: "pass" });
    assert.deepEqual(h.ort.kinds(), ["webgpu:warmup", "webgpu:canary", "webgpu:tile"]);
    assert.deepEqual(h.models.loads, [FP32_MODEL]);
    assert.deepEqual(h.ort.creates[0]?.options, sessionOptions("webgpu"));
    assert.deepEqual(h.ort.env.wasm, {
      wasmPaths: { wasm: BASE + ORT_WASM_PATH },
      numThreads: 1,
      proxy: false,
    });
    assert.equal(h.ort.env.logLevel, "warning");
    assert.ok(
      h.ort.creates.every((c) => !("logSeverityLevel" in c.options)),
      "never verbose (D-017)",
    );
    assert.ok(h.ort.creates.every((c) => !c.options.executionProviders.includes("webnn" as DetectorBackend)));
    assert.deepEqual(h.kv.decision(), {
      backend: "webgpu",
      canary: "pass",
      ort: "1.30.0",
      modelSha: SHA_FP32,
      chromeMajor: 154,
      gpu: "nvidia / turing",
      at: h.clock.t,
    });
    assert.deepEqual(h.fetched.sort(), [BASE + CANARY_IMAGE, BASE + CANARY_REFERENCE].sort());
  });

  test("a WebGPU create failure falls back to int8 on WASM and is remembered", async () => {
    const h = harness();
    h.ort.failCreate.webgpu = "no WebGPU device for the webgpu EP";
    const result = await h.detector.detect(PAGE, OPTIONS);
    assert.equal(result.backend, "wasm");
    assert.deepEqual(
      h.ort.creates.map((c) => c.backend),
      ["webgpu", "wasm"],
    );
    assert.deepEqual(h.ort.creates[1]?.options, sessionOptions("wasm"));
    assert.deepEqual(h.models.loads, [FP32_MODEL, INT8_MODEL]);
    assert.deepEqual(h.detector.state(), { backend: "wasm", state: "ready", canary: "skipped" });
    assert.deepEqual([h.kv.decision()?.backend, h.kv.decision()?.canary], ["wasm", "skipped"]);
    assert.ok(h.logs.some((e) => e.code === "detector.webgpu_unavailable" && e.level === "warn"));
  });

  test("a failed warm-up counts as a WebGPU failure and releases the session", async () => {
    const h = harness();
    h.ort.failRun = (backend, kind) =>
      backend === "webgpu" && kind === "warmup" ? "shader compile failed" : null;
    await h.detector.detect(PAGE, OPTIONS);
    assert.equal(h.detector.state().backend, "wasm");
    assert.equal(h.ort.sessions[0]?.released, true);
  });

  test("a canary mismatch falls back to WASM, releases the WebGPU session and stores the verdict", async () => {
    const h = harness();
    h.ort.canaryRows = REFERENCE_ROWS.slice(2);
    const result = await h.detector.detect(PAGE, OPTIONS);
    assert.equal(result.backend, "wasm");
    assert.equal(h.ort.sessions[0]?.backend, "webgpu");
    assert.equal(h.ort.sessions[0]?.released, true);
    assert.deepEqual(h.detector.state(), { backend: "wasm", state: "ready", canary: "fail" });
    assert.deepEqual([h.kv.decision()?.backend, h.kv.decision()?.canary], ["wasm", "fail"]);
    const log = h.logs.find((e) => e.code === "detector.canary_mismatch");
    assert.equal(log?.data?.["matched"], 11);
    assert.deepEqual(h.ort.kinds(), ["webgpu:warmup", "webgpu:canary", "wasm:warmup", "wasm:tile"]);
  });

  test("no GPU, or only a software fallback GPU: WASM without trying WebGPU", async () => {
    for (const gpu of [null, { ...NVIDIA, vendor: "google", architecture: "swiftshader", fallback: true }]) {
      const h = harness({ gpu });
      assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
      assert.deepEqual(
        h.ort.creates.map((c) => c.backend),
        ["wasm"],
      );
      assert.equal(h.kv.decision()?.gpu, null);
      assert.ok(h.logs.some((e) => e.code === "detector.webgpu_unavailable"));
    }
  });

  test("a hung GPU probe times out after 5 s and falls back to WASM", async () => {
    const clock = new ManualClock();
    const h = harness({ clock, probeGpu: () => new Promise<GpuInfo | null>(() => undefined) });
    const detecting = h.detector.detect(PAGE, OPTIONS);
    await flush();
    assert.equal(h.detector.state().state, "loading");
    clock.advance(5_000);
    assert.equal((await detecting).backend, "wasm");
  });

  test("canary assets that cannot be read mean WASM, without storing a verdict", async () => {
    for (const file of [
      () => null,
      (path: string) => (path === CANARY_IMAGE ? canaryFile(path) : { detections: 1 }),
    ]) {
      const h = harness({ file });
      assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
      assert.equal(h.kv.decision(), undefined, "retried at the next engine start");
      assert.deepEqual(
        h.ort.creates.map((c) => c.backend),
        ["wasm"],
        "WebGPU is not even created without a canary to check it",
      );
      assert.deepEqual(h.detector.state(), { backend: "wasm", state: "ready", canary: "skipped" });
    }
  });

  test("an fp32 integrity failure is logged as such, falls back to WASM and stores no GPU verdict", async () => {
    const h = harness();
    h.models.failLoad.set(FP32_MODEL, new CtvError("detector.model_integrity", "fp32: sha256 mismatch"));
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
    assert.equal(h.kv.decision(), undefined);
    assert.ok(h.logs.some((e) => e.level === "error" && e.code === "detector.model_integrity"));
  });
});

describe("cached decision (kv detector.decision, D-023)", () => {
  test("the same key skips the canary; a new Chrome major or GPU runs it again", async () => {
    const kv = new FakeKv();
    await harness({ kv }).detector.detect(PAGE, OPTIONS);
    const firstAt = kv.decision()?.at;

    const again = harness({ kv });
    await again.detector.detect(PAGE, OPTIONS);
    assert.deepEqual(again.ort.kinds(), ["webgpu:warmup", "webgpu:tile"], "no canary run");
    assert.deepEqual(again.detector.state(), { backend: "webgpu", state: "ready", canary: "pass" });
    assert.equal(again.fetched.length, 0, "canary assets are not even fetched");
    assert.equal(kv.decision()?.at, firstAt);

    const newChrome = harness({ kv, chromeMajor: 155 });
    await newChrome.detector.detect(PAGE, OPTIONS);
    assert.deepEqual(newChrome.ort.kinds(), ["webgpu:warmup", "webgpu:canary", "webgpu:tile"]);
    assert.equal(kv.decision()?.chromeMajor, 155);

    const newGpu = harness({ kv, chromeMajor: 155, gpu: { ...NVIDIA, architecture: "ampere" } });
    await newGpu.detector.detect(PAGE, OPTIONS);
    assert.ok(newGpu.ort.kinds().includes("webgpu:canary"));
    assert.equal(kv.decision()?.gpu, "nvidia / ampere");
  });

  test("a cached canary failure goes straight to WASM until the key changes", async () => {
    const kv = new FakeKv();
    const first = harness({ kv });
    first.ort.canaryRows = [];
    await first.detector.detect(PAGE, OPTIONS);

    const again = harness({ kv });
    await again.detector.detect(PAGE, OPTIONS);
    assert.deepEqual(
      again.ort.creates.map((c) => c.backend),
      ["wasm"],
    );
    assert.deepEqual(again.detector.state(), { backend: "wasm", state: "ready", canary: "fail" });

    const newOrt = new FakeOrt();
    newOrt.env.versions.web = "1.31.0";
    const upgraded = harness({ kv, ort: newOrt });
    await upgraded.detector.detect(PAGE, OPTIONS);
    assert.ok(upgraded.ort.kinds().includes("webgpu:canary"));
    assert.equal(kv.decision()?.backend, "webgpu");
  });

  test("a stored WebGPU start failure is retried after a day", () => {
    const key = { ort: "1.30.0", modelSha: SHA_FP32, chromeMajor: 154, gpu: "nvidia / turing" };
    const failed: DetectorDecision = { backend: "wasm", canary: "skipped", ...key, at: 0 };
    assert.equal(decisionUsable(failed, key, 23 * 3_600_000), true);
    assert.equal(decisionUsable(failed, key, 24 * 3_600_000), false);
    const mismatch: DetectorDecision = { backend: "wasm", canary: "fail", ...key, at: 0 };
    assert.equal(
      decisionUsable(mismatch, key, 365 * 24 * 3_600_000),
      true,
      "canary verdicts wait for a key change",
    );
    assert.equal(decisionUsable({ ...mismatch, modelSha: SHA_INT8 }, key, 0), false);
    const noGpu: DetectorDecision = { ...failed, gpu: null };
    assert.equal(decisionUsable(noGpu, { ...key, gpu: null }, 48 * 3_600_000), true);
  });

  test("a cached WebGPU verdict whose session now fails falls back and remembers the failure", async () => {
    const kv = new FakeKv();
    await harness({ kv }).detector.detect(PAGE, OPTIONS);
    const h = harness({ kv });
    h.ort.failCreate.webgpu = "device lost during create";
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
    assert.deepEqual([kv.decision()?.backend, kv.decision()?.canary], ["wasm", "skipped"]);
  });
});

describe("forced backends", () => {
  test('"wasm" never touches WebGPU', async () => {
    const h = harness({ backend: "wasm" });
    await h.detector.detect(PAGE, OPTIONS);
    assert.deepEqual(h.ort.kinds(), ["wasm:warmup", "wasm:tile"]);
    assert.deepEqual(h.detector.state(), { backend: "wasm", state: "ready", canary: "skipped" });
    assert.equal(h.kv.writes, 0);
  });

  test('"webgpu" skips the canary, and falls back only when WebGPU cannot start', async () => {
    const h = harness({ backend: "webgpu" });
    await h.detector.detect(PAGE, OPTIONS);
    assert.deepEqual(h.ort.kinds(), ["webgpu:warmup", "webgpu:tile"]);
    assert.deepEqual(h.detector.state(), { backend: "webgpu", state: "ready", canary: "skipped" });
    assert.equal(h.kv.writes, 0);

    const failing = harness({ backend: "webgpu" });
    failing.ort.failCreate.webgpu = "boom";
    assert.equal((await failing.detector.detect(PAGE, OPTIONS)).backend, "wasm");
    const noGpu = harness({ backend: "webgpu", gpu: null });
    assert.equal((await noGpu.detector.detect(PAGE, OPTIONS)).backend, "wasm");
  });

  test("changing the setting re-creates the session on the next detection", async () => {
    const h = harness();
    await h.detector.detect(PAGE, OPTIONS);
    h.settings.detector.backend = "wasm";
    await h.detector.detect(PAGE, OPTIONS);
    assert.equal(h.ort.sessions[0]?.released, true);
    assert.deepEqual(h.detector.state(), { backend: "wasm", state: "ready", canary: "skipped" });
  });
});

describe("mutex and lifecycle", () => {
  test("concurrent detections never overlap a run, release waits its turn, the next one re-creates", async () => {
    const h = harness();
    const runs = Promise.all([
      h.detector.detect(STRIP, OPTIONS),
      h.detector.detect(PAGE, OPTIONS),
      h.detector.detect(STRIP, OPTIONS),
    ]);
    const released = h.detector.release();
    const after = h.detector.detect(PAGE, OPTIONS);
    const [a, b, c] = await runs;
    await released;
    const d = await after;
    assert.equal(h.ort.maxActive, 1, "two runs never overlap (P1-07)");
    assert.deepEqual(
      [a, b, c, d].map((r) => r.units.length),
      [4, 1, 4, 1],
    );
    assert.deepEqual(
      h.ort.kinds().filter((k) => !k.endsWith("tile")),
      ["webgpu:warmup", "webgpu:canary", "webgpu:warmup"],
      "one canary; the re-created session only warms up",
    );
    assert.equal(h.ort.kinds().filter((k) => k.endsWith("tile")).length, 4 + 1 + 4 + 1);
    assert.deepEqual(
      h.ort.sessions.map((s) => s.released),
      [true, false],
    );
  });

  test("release drops the session; the next detection lazily creates a new one", async () => {
    const h = harness();
    await h.detector.detect(PAGE, OPTIONS);
    await h.detector.release();
    assert.deepEqual(h.detector.state(), { backend: "none", state: "unloaded", canary: "pass" });
    assert.equal(h.ort.sessions[0]?.released, true);
    await h.detector.release();
    await h.detector.detect(PAGE, OPTIONS);
    assert.equal(h.ort.sessions.length, 2);
    assert.deepEqual(h.detector.state(), { backend: "webgpu", state: "ready", canary: "pass" });
  });

  test("every tensor is disposed", async () => {
    const h = harness();
    await h.detector.detect(STRIP, OPTIONS);
    assert.ok(h.ort.tensors > 0);
    assert.equal(h.ort.disposed, h.ort.tensors);
  });

  test("warmup() prepares the session without an image and never rejects", async () => {
    const h = harness();
    await h.detector.warmup();
    assert.deepEqual(h.ort.kinds(), ["webgpu:warmup", "webgpu:canary"]);
    assert.equal(h.detector.state().state, "ready");
    const broken = harness({ backend: "wasm" });
    broken.models.failLoad.set(INT8_MODEL, new CtvError("detector.model_integrity", "bad"));
    await broken.detector.warmup();
    assert.equal(broken.detector.state().state, "failed");
  });
});

describe("results", () => {
  test("a strip: backend, detectorVersion, slice records, raw detections, units in order, timings", async () => {
    const h = harness();
    const result = await h.detector.detect(STRIP, OPTIONS);
    assert.equal(result.detectorVersion, detectorVersionOf(OPTIONS.slice));
    assert.deepEqual(result.slices, [
      { y1: 0, y2: 2400 },
      { y1: 1760, y2: 4160 },
      { y1: 3520, y2: 5920 },
      { y1: 5280, y2: 7680 },
    ]);
    assert.equal(result.rawDetections.length, 12, "3 rows per slice, faint ones included");
    assert.ok(result.rawDetections.some((d) => d.score < 0.3));
    assert.deepEqual(
      result.units.map((u) => [u.order, u.bubble?.y1]),
      [
        [0, 100],
        [1, 1860],
        [2, 3620],
        [3, 5380],
      ],
    );
    assert.equal(result.timings.inferMs.length, 4);
    assert.equal(typeof result.timings.totalMs, "number");
  });

  test("unitsFrom rebuilds the same units from the stored raw detections, without the model", async () => {
    const h = harness();
    const result = await h.detector.detect(STRIP, OPTIONS);
    const runs = h.ort.runs.length;
    const stored = structuredClone(result);
    assert.deepEqual(h.detector.unitsFrom(stored.rawDetections, STRIP.size, OPTIONS), result.units);
    assert.deepEqual(
      h.detector.unitsFrom(stored.rawDetections, STRIP.size, OPTIONS, stored.slices),
      result.units,
    );
    const lower = h.detector.unitsFrom(stored.rawDetections, STRIP.size, { ...OPTIONS, scoreMin: 0.15 });
    assert.equal(lower.length, 8, "scoreMin is applied at read time (D-012)");
    assert.equal(h.ort.runs.length, runs);
  });
});

describe("failures", () => {
  test("a failed run is detector.run; the session is dropped and re-created next time", async () => {
    const h = harness();
    await h.detector.detect(PAGE, OPTIONS);
    h.ort.failRun = (_backend, kind) => (kind === "tile" ? "GPU buffer mapping failed" : null);
    const error = await rejectsWith(h.detector.detect(PAGE, OPTIONS), "detector.run");
    assert.equal(error.retryable, true);
    assert.equal(h.ort.sessions[0]?.released, true);
    assert.equal(h.detector.state().state, "unloaded");
    h.ort.failRun = null;
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "webgpu");
    assert.equal(h.ort.sessions.length, 2);
  });

  test("two WebGPU failures within 10 min move this engine to WASM", async () => {
    const h = harness();
    await h.detector.detect(PAGE, OPTIONS);
    h.ort.failRun = (backend, kind) => (backend === "webgpu" && kind === "tile" ? "lost" : null);
    await rejectsWith(h.detector.detect(PAGE, OPTIONS), "detector.run");
    h.clock.advance(60_000);
    await rejectsWith(h.detector.detect(PAGE, OPTIONS), "detector.run");
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
    assert.ok(h.logs.some((e) => e.msg.startsWith("WebGPU failed twice")));
  });

  test("a lost device is noticed: the next detection re-creates the session", async () => {
    const h = harness();
    await h.detector.detect(PAGE, OPTIONS);
    await flush();
    assert.ok(h.logs.some((e) => e.msg === "WebGPU device" && e.data?.["architecture"] === "turing"));
    h.ort.devices[0]?.lose("unknown");
    await flush();
    assert.ok(h.logs.some((e) => e.msg === "WebGPU device lost"));
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "webgpu");
    assert.equal(h.ort.sessions[0]?.released, true);
    // A second loss within 10 min: WASM from now on.
    h.ort.devices[1]?.lose("unknown");
    await flush();
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
  });

  test("a device destroyed by our own release is not a loss", async () => {
    const h = harness();
    await h.detector.detect(PAGE, OPTIONS);
    await h.detector.release();
    h.ort.devices[0]?.lose("destroyed");
    await flush();
    assert.ok(!h.logs.some((e) => e.msg === "WebGPU device lost"));
  });

  test("a model integrity failure is detector.model_integrity and sticks (no refetch)", async () => {
    const h = harness({ backend: "wasm" });
    h.models.failLoad.set(INT8_MODEL, new CtvError("detector.model_integrity", "int8: 3 bytes, expected 4"));
    await rejectsWith(h.detector.detect(PAGE, OPTIONS), "detector.model_integrity");
    assert.deepEqual(h.detector.state(), { backend: "none", state: "failed", canary: "skipped" });
    h.clock.advance(3_600_000);
    await rejectsWith(h.detector.detect(PAGE, OPTIONS), "detector.model_integrity");
    assert.equal(h.models.loads.length, 1);
    assert.ok(h.logs.some((e) => e.level === "error" && e.code === "detector.model_integrity"));
  });

  test("when no backend starts: detector.init, retried after 30 s", async () => {
    const h = harness();
    h.ort.failCreate = { webgpu: "no webgpu", wasm: "wasm instantiate failed" };
    const error = await rejectsWith(h.detector.detect(PAGE, OPTIONS), "detector.init");
    assert.match(error.message, /wasm instantiate failed/);
    assert.equal(h.detector.state().state, "failed");
    const creates = h.ort.creates.length;
    await rejectsWith(h.detector.detect(PAGE, OPTIONS), "detector.init");
    assert.equal(h.ort.creates.length, creates, "fails fast inside the cool-down");
    h.clock.advance(30_000);
    h.ort.failCreate = {};
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm", "the stored verdict says WASM");
  });

  test("a failed ORT import is detector.init and is retried later", async () => {
    let attempts = 0;
    const ort = new FakeOrt();
    const h = harness({
      gpu: null,
      loadOrt: () =>
        ++attempts === 1 ? Promise.reject(new Error("chunk load failed")) : Promise.resolve(ort),
    });
    const error = await rejectsWith(h.detector.detect(PAGE, OPTIONS), "detector.init");
    assert.match(error.message, /chunk load failed/);
    h.clock.advance(30_000);
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
    assert.equal(attempts, 2);
  });
});

describe("degraded environments", () => {
  test("a broken kv store only costs the cached verdict", async () => {
    const kv = new FakeKv();
    kv.broken = true;
    const h = harness({ kv });
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "webgpu");
    assert.deepEqual(
      h.logs.filter((e) => e.code === "store.io").map((e) => e.msg),
      ["detector decision read failed", "detector decision write failed"],
    );
  });

  test("a canary run that throws on WebGPU is a WebGPU failure", async () => {
    const h = harness();
    h.ort.failRun = (backend, kind) => (backend === "webgpu" && kind === "canary" ? "device hung" : null);
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
    assert.equal(h.ort.sessions[0]?.released, true);
    assert.deepEqual([h.kv.decision()?.backend, h.kv.decision()?.canary], ["wasm", "skipped"]);
  });

  test("a reference recorded with another model is reported, and still compared", async () => {
    const models = new FakeModels();
    const fp32 = models.info.models[0];
    assert.ok(fp32 !== undefined);
    fp32.sha256 = SHA_INT8;
    const h = harness({ models });
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "webgpu");
    const warning = h.logs.find((e) => e.msg === "canary reference was recorded with another model");
    assert.deepEqual(warning?.data, { recorded: SHA_FP32.slice(0, 12), model: SHA_INT8.slice(0, 12) });
  });

  test("a build without the fp32 model runs int8 on WASM", async () => {
    const models = new FakeModels();
    models.info.models.splice(0, 1);
    const h = harness({ models });
    assert.equal((await h.detector.detect(PAGE, OPTIONS)).backend, "wasm");
    assert.deepEqual(h.models.loads, [INT8_MODEL]);
  });

  test("a session that fails to release is logged and forgotten", async () => {
    const h = harness();
    await h.detector.detect(PAGE, OPTIONS);
    h.ort.failRelease = true;
    await h.detector.release();
    assert.equal(h.detector.state().state, "unloaded");
    assert.ok(h.logs.some((e) => e.msg === "detector session release failed"));
  });
});

describe("CSP violations", () => {
  test("each distinct violation is logged once, with URLs reduced to origin + path", () => {
    const h = harness();
    assert.equal(h.csp.length, 1, "registered once, at creation");
    const listener = h.csp[0];
    assert.ok(listener !== undefined);
    const violation = {
      directive: "script-src",
      blockedURI: "https://cdn.example/ort.mjs?token=secret#x",
      sourceFile: "chrome-extension://test/engine/main.js",
    };
    listener(violation);
    listener({ ...violation });
    listener({ directive: "script-src", blockedURI: "wasm-eval", sourceFile: "" });
    const logged = h.logs.filter((e) => e.msg === "CSP violation");
    assert.deepEqual(
      logged.map((e) => [e.level, e.data?.["directive"], e.data?.["blocked"]]),
      [
        ["warn", "script-src", "https://cdn.example/ort.mjs"],
        ["warn", "script-src", "wasm-eval"],
      ],
    );
  });
});
