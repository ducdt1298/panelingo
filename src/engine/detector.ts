// Text detector service: the TextDetector of engine/contracts.ts.
//
// - ORT loads lazily: import("onnxruntime-web/webgpu") lands in its own chunk. Environment: the bundle's embedded glue
//   plus the asyncify binary only, one thread, no proxy, default log severity (verbose logging made WebGPU ~9×
//   slower). Never "webnn" in executionProviders.
// - Backend (settings.detector.backend). "auto": a high-performance WebGPU adapter (fallback and software adapters
//   do not count) → fp32 session on ["webgpu"] with N pinned to 1, warm-up, then the canary page compared with a
//   recorded WASM fp32 reference, so a GPU that computes wrong boxes is never used. No WebGPU adapter, a failed
//   create or warm-up, or a canary mismatch → int8 on ["wasm"] (same slicing). The verdict is kept in kv
//   "detector.decision" and re-checked only when the ORT version, the fp32 sha, the GPU or the Chrome major version
//   changes; a WebGPU create failure is retried after a day. "webgpu" forces WebGPU without the canary (WASM only if
//   it cannot start); "wasm" never touches WebGPU.
// - One promise chain serialises session creation, every run and release: asyncify forbids overlapping calls, and two
//   runs never overlap. A failed run or a lost device drops the session; two such WebGPU failures within 10 min move
//   this engine to WASM.
// - Units come from core/units-build on the raw detections, so unitsFrom(rawDetections) rebuilds exactly the units
//   detect() returned.

import type { Logger } from "../platform/log.ts";
import {
  DETECTOR_INPUT,
  DETECTOR_INPUTS,
  DETECTOR_OUTPUTS,
  canaryPasses,
  decodeRawBoxes,
  inputLength,
  matchDetections,
  parseCanaryReference,
  readDetectorOutputs,
  rgbaToNchw,
  targetSizes,
} from "../shared/core/detector-io.ts";
import type { CanaryMatch, CanaryReference } from "../shared/core/detector-io.ts";
import type { DetectorOutput } from "../shared/core/detections.ts";
import {
  buildUnitGeometry,
  detectorVersionOf,
  planDetectorSlices,
  sliceRecordsOf,
  slicesFromRecords,
} from "../shared/core/units-build.ts";
import { CtvError, errorMessage } from "../shared/errors.ts";
import type { Gfx } from "../shared/gfx.ts";
import type { DetectorDecision } from "../shared/records.ts";
import type { Settings } from "../shared/settings.ts";
import type { EngineStatus, Size } from "../shared/types.ts";
import type {
  Clock,
  DecodedImage,
  DetectOptions,
  DetectionResult,
  EngineStores,
  SettingsSource,
  TextDetector,
} from "./contracts.ts";
import { createModelFiles } from "./model-files.ts";
import type { FetchLike, ModelFiles } from "./model-files.ts";
import { defaultTilePixels, runTiling } from "./tiling.ts";
import type { TilePixels, TileRunner } from "./tiling.ts";

export type DetectorBackend = "webgpu" | "wasm";
export type BackendSetting = Settings["detector"]["backend"];
export type DetectorStatus = EngineStatus["detector"];

export const FP32_MODEL = "detector-v4-s.fixed.onnx";
export const INT8_MODEL = "detector-v4-s_int8.onnx";
export const ORT_WASM_PATH = "vendor/ort/ort-wasm-simd-threaded.asyncify.wasm";
export const CANARY_IMAGE = "assets/canary/canary-01.png";
export const CANARY_REFERENCE = "assets/canary/canary-01.ref-v4s-fp32-wasm.json";

/** requestAdapter can hang when the GPU process is wedged; the mutex must not wait forever. */
const ADAPTER_TIMEOUT_MS = 5_000;
/** After a failed create (both backends), detect() fails fast for this long before trying again. */
const INIT_RETRY_MS = 30_000;
/** A stored "WebGPU could not start" verdict is retried after this long (canary verdicts only on a key change). */
const WEBGPU_RETRY_MS = 24 * 60 * 60_000;
/** Two WebGPU failures (run error or lost device) within this window move the engine to WASM. */
const WEBGPU_FAILURE_WINDOW_MS = 10 * 60_000;
/** Distinct CSP violations logged per engine. */
const CSP_LOG_MAX = 20;

/* ------------------------------------------------------------------ ORT surface used here */

export interface OrtTensorLike {
  readonly data: unknown;
  dispose(): void;
}

export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensorLike>): Promise<Readonly<Record<string, OrtTensorLike>>>;
  release(): Promise<void>;
}

export interface OrtSessionOptions {
  executionProviders: readonly DetectorBackend[];
  freeDimensionOverrides: Readonly<Record<string, number>>;
  graphOptimizationLevel: "all";
}

export interface OrtEnvLike {
  logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
  readonly versions: { readonly web?: string };
  readonly wasm: {
    wasmPaths?: string | { wasm?: string | URL; mjs?: string | URL };
    numThreads?: number;
    proxy?: boolean;
  };
  /** ORT stores the GPUDevice it created here (a Promise in the typings, the device itself in 1.30). */
  readonly webgpu?: { readonly device?: unknown };
}

export interface OrtLike {
  readonly env: OrtEnvLike;
  createSession(model: Uint8Array<ArrayBuffer>, options: OrtSessionOptions): Promise<OrtSessionLike>;
  float32(data: Float32Array, dims: readonly number[]): OrtTensorLike;
  int64(data: BigInt64Array, dims: readonly number[]): OrtTensorLike;
}

/** The real module, loaded into its own chunk on first use. */
export async function importOrt(): Promise<OrtLike> {
  const ort = await import("onnxruntime-web/webgpu");
  return {
    env: ort.env,
    createSession: (model, options) => ort.InferenceSession.create(model, options),
    float32: (data, dims) => new ort.Tensor("float32", data, dims),
    int64: (data, dims) => new ort.Tensor("int64", data, dims),
  };
}

/** Session options with the batch dimension N pinned to 1; identical for both backends apart from the provider. */
export function sessionOptions(backend: DetectorBackend): OrtSessionOptions {
  return { executionProviders: [backend], freeDimensionOverrides: { N: 1 }, graphOptimizationLevel: "all" };
}

/* ------------------------------------------------------------------ platform */

export interface GpuInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  /** A fallback or software (SwiftShader-like) adapter: never used for the detector. */
  fallback: boolean;
}

export interface CspViolation {
  directive: string;
  blockedURI: string;
  sourceFile: string;
}

/** Everything the detector reaches outside the engine's services; tests replace any of it. */
export interface DetectorPlatform {
  loadOrt(): Promise<OrtLike>;
  /** chrome.runtime.getURL. */
  getURL(path: string): string;
  fetch: FetchLike;
  /** The high-performance WebGPU adapter, or null when WebGPU is missing. */
  probeGpu(): Promise<GpuInfo | null>;
  chromeMajor(): number;
  pixels: TilePixels;
  models: ModelFiles;
  /** Monotonic ms for timings. */
  now(): number;
  /** Subscribes to securitypolicyviolation events; returns the unsubscribe function. */
  listenCsp(listener: (violation: CspViolation) => void): () => void;
}

const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|lavapipe|softpipe|basic render driver/i;

async function probeWebGpu(): Promise<GpuInfo | null> {
  const gpu = typeof navigator === "undefined" ? undefined : (navigator as { gpu?: GPU }).gpu;
  if (gpu === undefined) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (adapter === null) return null;
  const { info } = adapter;
  const text = `${info.vendor} ${info.architecture} ${info.device} ${info.description}`;
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    fallback:
      Reflect.get(info, "isFallbackAdapter") === true ||
      Reflect.get(adapter, "isFallbackAdapter") === true ||
      SOFTWARE_ADAPTER.test(text),
  };
}

/** Chrome major version from a user agent string; 0 when unknown. */
export function chromeMajorOf(userAgent: string): number {
  const match = /\bChrom(?:e|ium)\/(\d+)/.exec(userAgent);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function listenDocumentCsp(listener: (violation: CspViolation) => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const handler = (event: SecurityPolicyViolationEvent): void => {
    listener({
      directive: event.effectiveDirective,
      blockedURI: event.blockedURI,
      sourceFile: event.sourceFile,
    });
  };
  document.addEventListener("securitypolicyviolation", handler);
  return () => document.removeEventListener("securitypolicyviolation", handler);
}

/** URLs keep origin + path (query strings may hold tokens); keywords such as "eval" stay as they are. */
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.origin === "null" ? `${url.protocol}${url.pathname}` : `${url.origin}${url.pathname}`;
  } catch {
    return value.slice(0, 200);
  }
}

/* ------------------------------------------------------------------ decisions */

export interface DecisionKey {
  ort: string;
  modelSha: string;
  chromeMajor: number;
  /** gpuLabel of the WebGPU adapter, or null when no usable adapter exists. */
  gpu: string | null;
}

export function gpuLabel(info: GpuInfo): string {
  return (
    [info.vendor, info.architecture, info.device, info.description].filter((s) => s !== "").join(" / ") || "?"
  );
}

/** The stored verdict applies to this key, and a "WebGPU could not start" verdict is not due for a retry. */
export function decisionUsable(decision: DetectorDecision, key: DecisionKey, now: number): boolean {
  const sameKey =
    decision.ort === key.ort &&
    decision.modelSha === key.modelSha &&
    decision.chromeMajor === key.chromeMajor &&
    decision.gpu === key.gpu;
  const retryDue =
    decision.backend === "wasm" &&
    decision.canary === "skipped" &&
    decision.gpu !== null &&
    now - decision.at >= WEBGPU_RETRY_MS;
  return sameKey && !retryDue;
}

/* ------------------------------------------------------------------ service */

export interface DetectorDeps {
  clock: Clock;
  log: Logger;
  settings: Pick<SettingsSource, "current">;
  stores: Pick<EngineStores, "kv" | "models">;
  gfx: Gfx;
}

/** The detector service; TextDetector already carries unitsFrom(..., slices?) and warmup(). */
export type Detector = TextDetector;

interface Active {
  backend: DetectorBackend;
  session: OrtSessionLike;
  /** settings.detector.backend the session was chosen for. */
  mode: BackendSetting;
  canary: DetectorStatus["canary"];
  lost: boolean;
}

interface Canary {
  input: Float32Array;
  size: Size;
  reference: CanaryReference;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function isIntegrity(error: unknown): boolean {
  return error instanceof CtvError && error.code === "detector.model_integrity";
}

interface DeviceLike {
  readonly lost: Promise<{ readonly reason?: string; readonly message?: string }>;
  readonly adapterInfo?: { readonly vendor?: string; readonly architecture?: string };
}

function isDeviceLike(value: unknown): value is DeviceLike {
  return typeof value === "object" && value !== null && "lost" in value && value.lost instanceof Promise;
}

function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

export function createDetector(deps: DetectorDeps, platform: Partial<DetectorPlatform> = {}): Detector {
  const { log, clock } = deps;
  const getURL = platform.getURL ?? ((path: string): string => chrome.runtime.getURL(path));
  const fetchFile: FetchLike = platform.fetch ?? ((url) => fetch(url));
  const now = platform.now ?? ((): number => performance.now());
  const models =
    platform.models ??
    createModelFiles({ getURL, fetch: fetchFile, store: deps.stores.models, now: () => clock.now(), log });
  const pixels = platform.pixels ?? defaultTilePixels(deps.gfx);
  const probeGpu = platform.probeGpu ?? probeWebGpu;
  const chromeMajor =
    platform.chromeMajor ?? ((): number => chromeMajorOf(globalThis.navigator?.userAgent ?? ""));
  const loadOrt = platform.loadOrt ?? importOrt;
  const exclusive = createMutex();

  let ortPromise: Promise<OrtLike> | null = null;
  let active: Active | null = null;
  let status: DetectorStatus = { backend: "none", state: "unloaded", canary: "pending" };
  let failure: { error: CtvError; at: number; sticky: boolean; mode: BackendSetting } | null = null;
  let input: Float32Array | null = null;
  let lastWebgpuFailure: number | null = null;
  let webgpuBlocked = false;

  const seenCsp = new Set<string>();
  (platform.listenCsp ?? listenDocumentCsp)((v) => {
    const blocked = redactUrl(v.blockedURI);
    const key = `${v.directive} ${blocked}`;
    if (seenCsp.has(key) || seenCsp.size >= CSP_LOG_MAX) return;
    seenCsp.add(key);
    log.warn("CSP violation", { directive: v.directive, blocked, source: redactUrl(v.sourceFile) });
  });

  function setStatus(next: Partial<DetectorStatus>): void {
    status = { ...status, ...next };
  }

  function getOrt(): Promise<OrtLike> {
    if (ortPromise === null) {
      const loading = loadOrt().then((ort) => {
        ort.env.wasm.wasmPaths = { wasm: getURL(ORT_WASM_PATH) };
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.logLevel = "warning";
        return ort;
      });
      ortPromise = loading;
      void loading.catch(() => {
        if (ortPromise === loading) ortPromise = null;
      });
    }
    return ortPromise;
  }

  function inputBuffer(): Float32Array {
    input ??= new Float32Array(inputLength());
    return input;
  }

  async function runModel(
    ort: OrtLike,
    session: OrtSessionLike,
    data: Float32Array,
    target: Size,
  ): Promise<DetectorOutput> {
    const images = ort.float32(data, [1, 3, DETECTOR_INPUT, DETECTOR_INPUT]);
    const sizes = ort.int64(targetSizes(target), [1, 2]);
    let outputs: Readonly<Record<string, OrtTensorLike>> | null = null;
    try {
      outputs = await session.run({ [DETECTOR_INPUTS.images]: images, [DETECTOR_INPUTS.sizes]: sizes });
      return readDetectorOutputs(outputs);
    } finally {
      images.dispose();
      sizes.dispose();
      if (outputs !== null) for (const tensor of Object.values(outputs)) tensor.dispose();
    }
  }

  async function releaseQuietly(session: OrtSessionLike): Promise<void> {
    try {
      await session.release();
    } catch (error) {
      log.warn("detector session release failed", { message: errorMessage(error) });
    }
  }

  async function openSession(ort: OrtLike, backend: DetectorBackend): Promise<OrtSessionLike> {
    const bytes = await models.load(backend === "webgpu" ? FP32_MODEL : INT8_MODEL);
    const t0 = now();
    const session = await ort.createSession(bytes, sessionOptions(backend));
    const createMs = now() - t0;
    try {
      const missing = [
        ...Object.values(DETECTOR_INPUTS).filter((name) => !session.inputNames.includes(name)),
        ...DETECTOR_OUTPUTS.filter((name) => !session.outputNames.includes(name)),
      ];
      if (missing.length > 0) throw new Error(`model lacks tensors: ${missing.join(", ")}`);
      const t1 = now();
      await runModel(ort, session, inputBuffer().fill(0), { w: DETECTOR_INPUT, h: DETECTOR_INPUT });
      log.info("detector session ready", { backend, createMs: round(createMs), warmupMs: round(now() - t1) });
      return session;
    } catch (error) {
      await releaseQuietly(session);
      throw error;
    }
  }

  function noteWebgpuFailure(): void {
    const t = clock.now();
    if (lastWebgpuFailure !== null && t - lastWebgpuFailure < WEBGPU_FAILURE_WINDOW_MS && !webgpuBlocked) {
      webgpuBlocked = true;
      log.warn(
        "WebGPU failed twice within 10 min: WASM until the engine restarts",
        {},
        "detector.webgpu_unavailable",
      );
    }
    lastWebgpuFailure = t;
  }

  function watchDevice(ort: OrtLike, act: Active): void {
    void Promise.resolve(ort.env.webgpu?.device)
      .then(async (device) => {
        if (!isDeviceLike(device)) return;
        log.info("WebGPU device", {
          vendor: device.adapterInfo?.vendor ?? "",
          architecture: device.adapterInfo?.architecture ?? "",
        });
        const lost = await device.lost;
        if (active !== act || lost.reason === "destroyed") return;
        act.lost = true;
        noteWebgpuFailure();
        log.warn("WebGPU device lost", { reason: lost.reason ?? "", message: lost.message ?? "" });
      })
      .catch(() => undefined);
  }

  async function activate(
    ort: OrtLike,
    backend: DetectorBackend,
    mode: BackendSetting,
    canary: DetectorStatus["canary"],
    session?: OrtSessionLike,
  ): Promise<Active> {
    const act: Active = {
      backend,
      session: session ?? (await openSession(ort, backend)),
      mode,
      canary,
      lost: false,
    };
    if (backend === "webgpu") watchDevice(ort, act);
    return act;
  }

  async function probeGpuSafe(): Promise<GpuInfo | null> {
    let cancel: () => void = () => undefined;
    const timeout = new Promise<never>((_, reject) => {
      cancel = clock.setTimer(
        () => reject(new Error(`requestAdapter timed out after ${ADAPTER_TIMEOUT_MS} ms`)),
        ADAPTER_TIMEOUT_MS,
      );
    });
    try {
      const info = await Promise.race([probeGpu(), timeout]);
      if (info === null) {
        log.info("no WebGPU adapter", {}, "detector.webgpu_unavailable");
        return null;
      }
      if (info.fallback) {
        log.info(
          "WebGPU adapter is a fallback or software adapter",
          { gpu: gpuLabel(info) },
          "detector.webgpu_unavailable",
        );
        return null;
      }
      return info;
    } catch (error) {
      log.warn(
        "WebGPU adapter request failed",
        { message: errorMessage(error) },
        "detector.webgpu_unavailable",
      );
      return null;
    } finally {
      cancel();
    }
  }

  async function readDecision(): Promise<DetectorDecision | undefined> {
    try {
      return await deps.stores.kv.get("detector.decision");
    } catch (error) {
      log.warn("detector decision read failed", { message: errorMessage(error) }, "store.io");
      return undefined;
    }
  }

  async function storeDecision(decision: DetectorDecision): Promise<void> {
    try {
      await deps.stores.kv.set("detector.decision", decision);
    } catch (error) {
      log.warn("detector decision write failed", { message: errorMessage(error) }, "store.io");
    }
  }

  async function loadCanary(fp32Sha: string): Promise<Canary> {
    const [image, json] = await Promise.all([
      fetchFile(getURL(CANARY_IMAGE)),
      fetchFile(getURL(CANARY_REFERENCE)),
    ]);
    if (!image.ok || !json.ok) throw new Error(`canary assets: HTTP ${image.status}/${json.status}`);
    const reference = parseCanaryReference(await json.json());
    if (reference.modelSha256 !== null && reference.modelSha256 !== fp32Sha) {
      log.warn("canary reference was recorded with another model", {
        recorded: reference.modelSha256.slice(0, 12),
        model: fp32Sha.slice(0, 12),
      });
    }
    const decoded = await pixels.decode(new Uint8Array(await image.arrayBuffer()));
    try {
      const { w, h } = decoded.size;
      const rgba = await pixels.stretch(decoded.source, { x: 0, y: 0, w, h }, DETECTOR_INPUT, "draw-low");
      return { input: rgbaToNchw(rgba.data, rgba.width, rgba.height), size: decoded.size, reference };
    } finally {
      decoded.close();
    }
  }

  async function runCanary(ort: OrtLike, session: OrtSessionLike, canary: Canary): Promise<CanaryMatch> {
    const out = await runModel(ort, session, canary.input, canary.size);
    return matchDetections(decodeRawBoxes(out, canary.reference.scoreMin), canary.reference.detections);
  }

  /** WebGPU could not start: log, remember (auto mode only), fall back. Integrity problems are not GPU verdicts. */
  async function webgpuFailed(
    ort: OrtLike,
    mode: BackendSetting,
    error: unknown,
    remember: ((backend: DetectorBackend, canary: DetectorDecision["canary"]) => Promise<void>) | null,
  ): Promise<Active> {
    if (isIntegrity(error)) {
      log.error(
        "fp32 model failed its integrity check: using WASM",
        { message: errorMessage(error) },
        "detector.model_integrity",
      );
    } else {
      log.warn(
        "WebGPU session failed: using WASM",
        { message: errorMessage(error) },
        "detector.webgpu_unavailable",
      );
      await remember?.("wasm", "skipped");
    }
    return activate(ort, "wasm", mode, "skipped");
  }

  async function createAuto(ort: OrtLike): Promise<Active> {
    const mode: BackendSetting = "auto";
    const gpu = await probeGpuSafe();
    const info = await models.buildInfo();
    const fp32 = info.models.find((m) => m.file === FP32_MODEL);
    if (fp32 === undefined) {
      log.warn(`${FP32_MODEL} is not in the build: WASM only`, {}, "detector.webgpu_unavailable");
      return activate(ort, "wasm", mode, "skipped");
    }
    const key: DecisionKey = {
      ort: ort.env.versions.web ?? info.ort,
      modelSha: fp32.sha256,
      chromeMajor: chromeMajor(),
      gpu: gpu === null ? null : gpuLabel(gpu),
    };
    const remember = (backend: DetectorBackend, canary: DetectorDecision["canary"]): Promise<void> =>
      storeDecision({ backend, canary, ...key, at: clock.now() });
    const cached = await readDecision();
    const usable = cached !== undefined && decisionUsable(cached, key, clock.now());
    if (gpu === null) {
      if (!usable) await remember("wasm", "skipped");
      return activate(ort, "wasm", mode, "skipped");
    }
    if (usable) {
      if (cached.backend === "wasm") return activate(ort, "wasm", mode, cached.canary);
      try {
        return await activate(ort, "webgpu", mode, "pass");
      } catch (error) {
        return webgpuFailed(ort, mode, error, remember);
      }
    }

    let canary: Canary;
    try {
      canary = await loadCanary(fp32.sha256);
    } catch (error) {
      log.error(
        "canary unavailable: using WASM",
        { message: errorMessage(error) },
        "detector.canary_mismatch",
      );
      return activate(ort, "wasm", mode, "skipped");
    }
    let session: OrtSessionLike;
    let match: CanaryMatch;
    try {
      session = await openSession(ort, "webgpu");
    } catch (error) {
      return webgpuFailed(ort, mode, error, remember);
    }
    try {
      match = await runCanary(ort, session, canary);
    } catch (error) {
      await releaseQuietly(session);
      return webgpuFailed(ort, mode, error, remember);
    }
    const pass = canaryPasses(match);
    const ratio = (v: number): number => Math.round(v * 1000) / 1000;
    const data = {
      gpu: key.gpu,
      matched: match.matched,
      reference: canary.reference.detections.length,
      recall: ratio(match.recall),
      precision: ratio(match.precision),
      countDiff: match.countDiff,
      meanIou: ratio(match.meanIou),
    };
    if (pass) {
      log.info("detector canary passed: WebGPU", data);
      await remember("webgpu", "pass");
      return activate(ort, "webgpu", mode, "pass", session);
    }
    log.warn("detector canary mismatch: using WASM", data, "detector.canary_mismatch");
    await releaseQuietly(session);
    await remember("wasm", "fail");
    return activate(ort, "wasm", mode, "fail");
  }

  async function create(ort: OrtLike, mode: BackendSetting): Promise<Active> {
    if (mode === "wasm") return activate(ort, "wasm", mode, "skipped");
    if (webgpuBlocked) return activate(ort, "wasm", mode, "skipped");
    if (mode === "auto") return createAuto(ort);
    if ((await probeGpuSafe()) === null) return activate(ort, "wasm", mode, "skipped");
    try {
      return await activate(ort, "webgpu", mode, "skipped");
    } catch (error) {
      return webgpuFailed(ort, mode, error, null);
    }
  }

  async function dropSession(): Promise<void> {
    const current = active;
    active = null;
    if (current !== null) await releaseQuietly(current.session);
  }

  /** Inside the mutex. */
  async function ensureSession(): Promise<{ ort: OrtLike; act: Active }> {
    const mode = deps.settings.current().detector.backend;
    if (active !== null && active.mode === mode && !active.lost) return { ort: await getOrt(), act: active };
    await dropSession();
    if (failure?.mode === mode && (failure.sticky || clock.now() - failure.at < INIT_RETRY_MS)) {
      setStatus({ backend: "none", state: "failed" });
      throw failure.error;
    }
    setStatus({ backend: "none", state: "loading", canary: "pending" });
    const started = now();
    try {
      const ort = await getOrt();
      const act = await create(ort, mode);
      active = act;
      failure = null;
      setStatus({ backend: act.backend, state: "ready", canary: act.canary });
      log.info("detector ready", {
        backend: act.backend,
        canary: act.canary,
        mode,
        ms: round(now() - started),
      });
      return { ort, act };
    } catch (thrown) {
      const error =
        thrown instanceof CtvError
          ? thrown
          : new CtvError("detector.init", `detector init failed: ${errorMessage(thrown)}`, { cause: thrown });
      failure = { error, at: clock.now(), sticky: error.code === "detector.model_integrity", mode };
      setStatus({ backend: "none", state: "failed", canary: "skipped" });
      log.error("detector unavailable", { message: error.message }, error.code);
      throw error;
    }
  }

  async function runDetection(image: DecodedImage, options: DetectOptions): Promise<DetectionResult> {
    const started = now();
    const { ort, act } = await ensureSession();
    let runFailed = false;
    const run: TileRunner = async (data, target) => {
      try {
        if (act.lost) throw new Error("WebGPU device lost");
        return await runModel(ort, act.session, data, target);
      } catch (error) {
        runFailed = true;
        throw error;
      }
    };
    try {
      const result = await runTiling({ source: image.bitmap, size: image.size }, options, {
        pixels,
        run,
        now,
        input: inputBuffer(),
      });
      return {
        backend: act.backend,
        detectorVersion: detectorVersionOf(options.slice),
        slices: sliceRecordsOf(result.plan.slices, image.size),
        rawDetections: result.rawDetections,
        units: result.units,
        timings: { inferMs: result.inferMs.map(round), totalMs: round(now() - started) },
      };
    } catch (thrown) {
      if (runFailed) {
        log.warn("detector run failed: dropping the session", {
          backend: act.backend,
          message: errorMessage(thrown),
        });
        // A lost device was already counted when it was reported.
        if (act.backend === "webgpu" && !act.lost) noteWebgpuFailure();
        if (active === act) {
          await dropSession();
          setStatus({ backend: "none", state: "unloaded" });
        }
      }
      if (thrown instanceof CtvError) throw thrown;
      throw new CtvError("detector.run", `detection failed: ${errorMessage(thrown)}`, {
        retryable: true,
        cause: thrown,
      });
    }
  }

  return {
    state: () => ({ ...status }),
    detect: (image, options) => exclusive(() => runDetection(image, options)),
    unitsFrom(raw, size, options, slices) {
      const plan =
        slices !== undefined
          ? slicesFromRecords(slices, size)
          : planDetectorSlices(size, options.slice).slices;
      return buildUnitGeometry(raw, plan, size, { scoreMin: options.scoreMin, dir: options.dir });
    },
    release: () =>
      exclusive(async () => {
        await dropSession();
        input = null;
        if (status.state !== "failed") setStatus({ backend: "none", state: "unloaded" });
      }),
    warmup: () =>
      exclusive(async () => {
        await ensureSession();
      }).catch(() => undefined),
  };
}
