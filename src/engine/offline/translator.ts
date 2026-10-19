// Offline pack translator (settings.translate.engine "offline", experimental; docs/OFFLINE-MODE.md): the
// PackTranslator contract of translator.ts without any AI endpoint. For a pack: read each unit's text boxes from the
// decoded image, split them into lines or columns (shared/offline/ocr.ts), recognize the lines with a PaddleOCR model
// chosen by the page language (a short script vote when the language is "auto"), then translate the units' texts with
// Opus-MT (direct, or through English) or NLLB-200 (shared/offline/routing.ts), in batches, reporting each unit
// through onUnit as soon as its batch is done. Models download on first use (model-store.ts) and stay loaded until the
// engine has been idle for engine.detectorReleaseMin.
//
// Where the models run: the recognizers in the engine's ORT instance, behind the lock they share with the detector;
// the translation models in their own worker (worker-runner.ts, mt-worker.ts) with their own heap, kept within a
// memory budget (memory.ts planLoad): models a pack does not need are unloaded first, and the worker is restarted
// (all of its memory back) when a model would not fit, when NLLB-200 and Opus-MT would meet, or after ORT failed in
// it. One pack translates at a time (mtLock). An out-of-memory failure fails the pack with offline.out_of_memory and
// the engine keeps running; a model that runs out of memory twice in a row is refused until the next release.
//
// Per unit: status "ok" with the translation, "keep-original" when the translation equals the source, the text has no
// letters or the unit is a sound effect (sentence models turn onomatopoeia into nonsense), "ignored" for page numbers
// at the edge and boxes without readable text, "untranslated" when the model returned nothing. A pack whose language
// pair has no model, or whose models cannot be downloaded or run, ends with report.error (offline.pair_unsupported /
// offline.download / offline.model_integrity / offline.run / offline.out_of_memory) and every unit "error": the
// pipeline never erases a unit without a valid translation. type comes from the geometry (bubble text is dialogue,
// large free text sfx, other free text narration), speaker is always "". report.model (and every unit's model) names
// the models, e.g. "offline:opus-mt-ko-en+opus-mt-en-vi", so cached records follow the engine.

import type { Logger } from "../../platform/log.ts";
import { CtvError, errorMessage, toErrorInfo, type ErrorInfo } from "../../shared/errors.ts";
import type { Gfx, ImageDataLike } from "../../shared/gfx.ts";
import { modelFiles, type OfflineFile, type OfflineRole } from "../../shared/offline/catalog.ts";
import {
  cropRgba,
  fixVerticalText,
  inferOrientation,
  joinsWithoutSpace,
  joinLines,
  latinLanguage,
  parseCharacterDict,
  scriptCounts,
  segmentLines,
  sentenceCase,
  stackColumn,
  textInk,
  type CtcResult,
} from "../../shared/offline/ocr.ts";
import {
  guessLineType,
  hasLetters,
  isRepeatedChunk,
  medianGlyph,
  translationOutcome,
} from "../../shared/offline/results.ts";
import {
  NLLB_MODEL,
  OCR_MODEL,
  planRoute,
  type MtLeg,
  type MtRoute,
  type OfflineModelChoice,
} from "../../shared/offline/routing.ts";
import { loadTokenizer, type Tokenizer } from "../../shared/offline/tokenizer.ts";
import type { Box, Lang, LineType, OfflineStatus } from "../../shared/types.ts";
import type {
  CoreDeps,
  DecodedImage,
  EngineStores,
  OfflinePackTranslator,
  OrtLock,
  PackReport,
  PackUnit,
  TranslatePack,
  UnitOutcomeStatus,
  UnitResult,
} from "../contracts.ts";
import { createMutex } from "../detector.ts";
import { ORT_WASM_PATH } from "../ort-env.ts";
import { promptTarget } from "../translator.ts";
import { wasmHeapBytes } from "../wasm-heap.ts";
import { isFatal, mtCost, offlineFailure, planLoad } from "./memory.ts";
import { createOfflineModelStore, openBrowserCache, type OfflineModelStore } from "./model-store.ts";
import { createLocalMtRunner, type MtPart, type MtRunner } from "./mt-runner.ts";
import { importOfflineOrt, type OfflineBackend, type OfflineOrt, type OfflineSession } from "./ort.ts";
import { recognizeLines, type RecModel } from "./recognizer.ts";
import { seq2seqConfig, type RunSession, type Seq2SeqConfig } from "./seq2seq.ts";
import { createWorkerMtRunner } from "./worker-runner.ts";

/** Sentences per translation batch. */
export const MT_BATCH = 8;
/** Recognized lines below this mean confidence are dropped (outline fragments, screentone). */
export const MIN_LINE_CONFIDENCE = 0.45;
/** Lines read per unit at most. */
export const MAX_LINES_PER_UNIT = 24;
/** Lines recognized for the language vote of an "auto" pack. */
export const VOTE_LINES = 4;
/** Source tokens kept per sentence. */
export const MAX_SOURCE_TOKENS = 200;
/** Out-of-memory failures in a row after which a translation model is refused (until release()). */
export const MT_OOM_STRIKES = 2;
/** The translation worker's script (esbuild entry "offline-worker" of the engine build). */
export const MT_WORKER_PATH = "engine/offline-worker.js";

export type OfflineTranslator = OfflinePackTranslator;

export interface OfflinePlatform {
  loadOrt(): Promise<OfflineOrt>;
  models: OfflineModelStore;
  /** Where the translation models run; default: the translation worker (in-process when Worker is missing). */
  mtRunner: MtRunner;
  /** Monotonic ms for timings. */
  now(): number;
  /** Fetch for model downloads. */
  fetch(url: string): Promise<Response>;
}

export interface OfflineTranslatorDeps extends CoreDeps {
  gfx: Gfx;
  stores: Pick<EngineStores, "models">;
  /** The engine-wide ORT lock shared with the detector. */
  exclusive: OrtLock;
  /** The offline catalog (build-info.json "offline"). */
  catalog(): Promise<readonly OfflineFile[]>;
  /** The detector's backend: the recognizer tries WebGPU only where the detector runs on it. */
  detectorBackend(): "webgpu" | "wasm" | "none";
  /** chrome.runtime.getURL (ORT's WASM binary). */
  getURL?: (path: string) => string;
  platform?: Partial<OfflinePlatform>;
}

interface Crop {
  /** Index of the unit in the pack. */
  unit: number;
  image: ImageDataLike;
  orientation: "h" | "v";
}

/** A translation model as the engine keeps it: what runs in mtRunner is addressed by its id. */
interface MtModel {
  config: Seq2SeqConfig;
  tokenizer: Tokenizer;
}

interface UnitText {
  text: string;
  /** Lines found in the unit's boxes (0: nothing readable). */
  lines: number;
}

/** A text box grown by a fraction of the glyph size, inside the image. */
export function padded(box: Box, glyphPx: number, size: { w: number; h: number }): Box {
  const pad = Math.min(16, Math.max(3, Math.round(glyphPx * 0.2)));
  return {
    x1: Math.max(0, Math.floor(box.x1 - pad)),
    y1: Math.max(0, Math.floor(box.y1 - pad)),
    x2: Math.min(size.w, Math.ceil(box.x2 + pad)),
    y2: Math.min(size.h, Math.ceil(box.y2 + pad)),
  };
}

/** The pixels of one rectangle of a decoded image (RGBA, natural px). */
function readRegion(gfx: Gfx, image: DecodedImage, box: Box): ImageDataLike {
  const w = Math.max(1, box.x2 - box.x1);
  const h = Math.max(1, box.y2 - box.y1);
  const canvas = gfx.createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2D context");
  ctx.drawImage(image.bitmap, box.x1, box.y1, w, h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Line images of one unit, in reading order: each text box split into lines (h) or columns (v). */
export function unitLines(
  region: ImageDataLike,
  origin: Box,
  unit: PackUnit,
): Array<{ image: ImageDataLike; orientation: "h" | "v" }> {
  const g = unit.geometry;
  const out: Array<{ image: ImageDataLike; orientation: "h" | "v" }> = [];
  const boxes = g.texts.length > 0 ? g.texts : [g.text];
  for (const textBox of boxes) {
    const box = padded(textBox, g.glyphPx, unit.imageSize);
    const local: Box = {
      x1: Math.max(0, box.x1 - origin.x1),
      y1: Math.max(0, box.y1 - origin.y1),
      x2: Math.min(region.width, box.x2 - origin.x1),
      y2: Math.min(region.height, box.y2 - origin.y1),
    };
    if (local.x2 - local.x1 < 4 || local.y2 - local.y1 < 4) continue;
    const crop = cropRgba(region, local, false);
    // The detector's box inside the crop: glyphs touching the crop's edge are kept only when they lie in it.
    const keep: Box = {
      x1: Math.floor(textBox.x1) - box.x1,
      y1: Math.floor(textBox.y1) - box.y1,
      x2: Math.ceil(textBox.x2) - box.x1,
      y2: Math.ceil(textBox.y2) - box.y1,
    };
    const { mask, image } = textInk(crop, keep, g.glyphPx);
    const orientation = inferOrientation(mask, g.orientation);
    const lines = segmentLines(mask, orientation);
    for (const line of lines.slice(0, MAX_LINES_PER_UNIT)) {
      out.push({
        image: orientation === "v" ? stackColumn(image, mask, line) : cropRgba(image, line, false),
        orientation,
      });
    }
  }
  return out;
}

export function createOfflineTranslator(deps: OfflineTranslatorDeps): OfflineTranslator {
  const { clock, log, settings, gfx, exclusive } = deps;
  const getURL = deps.getURL ?? ((path: string): string => chrome.runtime.getURL(path));
  const now = deps.platform?.now ?? ((): number => performance.now());
  const fetchFile = deps.platform?.fetch ?? ((url: string): Promise<Response> => fetch(url));
  const models =
    deps.platform?.models ??
    createOfflineModelStore({
      fetch: fetchFile,
      openCache: openBrowserCache,
      integrity: deps.stores.models,
      baseUrl: () => {
        const base = __DEV__ || __TEST__ ? settings.current().debug.offlineModelBaseUrl : "";
        return base === "" ? "https://huggingface.co" : base;
      },
      now: () => clock.now(),
      log,
    });
  const loadOrt = deps.platform?.loadOrt ?? ((): Promise<OfflineOrt> => importOfflineOrt(getURL));

  let ortPromise: Promise<OfflineOrt> | null = null;
  const ocrModels = new Map<string, Promise<RecModel>>();
  /** Translation models loaded (or loading) in mtRunner: their config and tokenizer stay here. */
  const mtModels = new Map<string, Promise<MtModel>>();
  /** Estimated heap cost of each of them (memory.ts mtCost). */
  const mtCosts = new Map<string, number>();
  /** Out-of-memory failures in a row per translation model; refused at MT_OOM_STRIKES until release(). */
  const oomStrikes = new Map<string, number>();
  /** One pack at a time loads and runs translation models (a restart must not hit another pack's batch). */
  const mtLock = createMutex();
  /** Bytes received per file of the downloads in progress. */
  const received = new Map<string, number>();
  let downloadTotal = 0;
  let loading = 0;
  let ocrBackendFailed = false;
  let releaseTimer: (() => void) | null = null;
  let status: OfflineStatus = {
    state: "idle",
    model: settings.current().translate.offlineModel,
    active: [],
    download: null,
    error: null,
  };

  const setStatus = (next: Partial<OfflineStatus>): void => {
    status = { ...status, ...next };
  };

  const getOrt = (): Promise<OfflineOrt> => {
    if (ortPromise === null) {
      const pending = loadOrt();
      ortPromise = pending;
      void pending.catch(() => {
        if (ortPromise === pending) ortPromise = null;
      });
    }
    return ortPromise;
  };

  const run: RunSession = (session, feeds) => exclusive(() => session.run(feeds));

  const mtRunner: MtRunner =
    deps.platform?.mtRunner ??
    (typeof Worker === "function"
      ? createWorkerMtRunner({
          createWorker: () =>
            new Worker(getURL(MT_WORKER_PATH), { type: "module", name: "offline-translation" }),
          wasmUrl: getURL(ORT_WASM_PATH),
          log,
        })
      : createLocalMtRunner({ getOrt, exclusive, heapBytes: wasmHeapBytes }));

  const releaseSession = async (session: OfflineSession): Promise<void> => {
    try {
      await exclusive(() => session.release());
    } catch (error) {
      log.warn("offline session release failed", { message: errorMessage(error) });
    }
  };

  const activeIds = (): string[] => [...ocrModels.keys(), ...mtModels.keys()];

  /** Files of a model by role, from the build's catalog. */
  const filesOf = async (model: string): Promise<Partial<Record<OfflineRole, OfflineFile>>> => {
    const files = modelFiles(await deps.catalog(), model);
    if (files === null) throw new CtvError("offline.run", `${model} is not in this build's offline catalog`);
    return files;
  };

  const progress = (): void => {
    let done = 0;
    for (const value of received.values()) done += value;
    setStatus({ download: downloadTotal > 0 ? { done, total: downloadTotal } : null });
  };

  /**
   * Downloads (or reads from the cache) the files of the given models, tracking the download in the status. With
   * `use`, each file is handed over as soon as it is read and not kept: one large file in memory at a time.
   */
  const fetchFiles = async (
    files: readonly OfflineFile[],
    use?: (file: OfflineFile, bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
  ): Promise<Map<OfflineFile, Uint8Array<ArrayBuffer>>> => {
    const missing: OfflineFile[] = [];
    for (const file of files) {
      if (!(await models.cached(file)) && !received.has(file.sha256)) missing.push(file);
    }
    if (missing.length > 0) {
      for (const file of missing) received.set(file.sha256, 0);
      downloadTotal += missing.reduce((sum, file) => sum + file.bytes, 0);
      setStatus({ state: "downloading", error: null });
      progress();
      log.info("downloading offline models", {
        files: missing.length,
        bytes: missing.reduce((sum, file) => sum + file.bytes, 0),
      });
    }
    const out = new Map<OfflineFile, Uint8Array<ArrayBuffer>>();
    try {
      for (const file of files) {
        const bytes = await models.load(file, (count) => {
          if (received.has(file.sha256)) {
            received.set(file.sha256, count);
            progress();
          }
        });
        if (use === undefined) out.set(file, bytes);
        else await use(file, bytes);
      }
    } finally {
      for (const file of missing) received.delete(file.sha256);
      if (received.size === 0) downloadTotal = 0;
      progress();
    }
    return out;
  };

  const createSession = async (
    bytes: Uint8Array<ArrayBuffer>,
    backend: OfflineBackend,
  ): Promise<OfflineSession> => {
    const ort = await getOrt();
    return await exclusive(() => ort.createSession(bytes, backend));
  };

  /** Loading state while models load; "ready" once nothing is loading. */
  const track = async <T>(task: () => Promise<T>): Promise<T> => {
    loading += 1;
    if (status.state !== "downloading") setStatus({ state: "loading", error: null });
    try {
      return await task();
    } finally {
      loading -= 1;
      if (loading === 0) setStatus({ state: "ready", download: null, active: activeIds() });
    }
  };

  const ocrBackend = (): OfflineBackend =>
    !ocrBackendFailed && settings.current().detector.backend !== "wasm" && deps.detectorBackend() === "webgpu"
      ? "webgpu"
      : "wasm";

  const loadOcr = (model: string): Promise<RecModel> => {
    let pending = ocrModels.get(model);
    if (pending === undefined) {
      const created = track(async (): Promise<RecModel> => {
        const files = await filesOf(model);
        const onnx = files.model;
        const yml = files.dict;
        if (onnx === undefined || yml === undefined)
          throw new CtvError("offline.run", `${model}: missing files`);
        const bytes = await fetchFiles([onnx, yml]);
        const dict = parseCharacterDict(new TextDecoder().decode(bytes.get(yml)));
        const started = now();
        let backend = ocrBackend();
        let session: OfflineSession;
        try {
          session = await createSession(bytes.get(onnx) ?? new Uint8Array(), backend);
        } catch (error) {
          if (backend !== "webgpu") throw error;
          ocrBackendFailed = true;
          log.warn("WebGPU recognizer failed: using WASM", { model, message: errorMessage(error) });
          backend = "wasm";
          session = await createSession(bytes.get(onnx) ?? new Uint8Array(), backend);
        }
        log.info("offline OCR model ready", {
          model,
          backend,
          chars: dict.length,
          ms: Math.round(now() - started),
        });
        return { session, dict };
      });
      pending = created;
      ocrModels.set(model, created);
      void created.catch(() => {
        if (ocrModels.get(model) === created) ocrModels.delete(model);
      });
    }
    return pending;
  };

  const gb = (bytes: number): string => (bytes / 1e9).toFixed(1);

  /** Unloads every translation model; the worker runner is restarted, which gives its whole heap back. */
  const resetMt = async (reason: string): Promise<void> => {
    const loaded = mtModels.size;
    mtModels.clear();
    mtCosts.clear();
    await mtRunner.reset(reason);
    if (loaded > 0) log.info("offline translation models unloaded", { reason, models: loaded });
    setStatus({ active: activeIds() });
  };

  const unloadMt = async (model: string): Promise<void> => {
    mtModels.delete(model);
    mtCosts.delete(model);
    try {
      await mtRunner.unload(model);
    } catch (error) {
      log.warn("offline translation model unload failed", { model, message: errorMessage(error) });
    }
    setStatus({ active: activeIds() });
  };

  /** Estimated heap cost of a translation model, from the size of its encoder and decoder files. */
  const mtCostOf = async (model: string): Promise<number> => {
    const files = await filesOf(model);
    return mtCost((files.encoder?.bytes ?? 0) + (files.decoder?.bytes ?? 0));
  };

  /** Makes room for a pack's translation models (memory.ts planLoad). Runs under mtLock. */
  const prepareMt = async (legs: readonly MtLeg[]): Promise<Map<string, number>> => {
    const needed = new Map<string, number>();
    for (const leg of legs) {
      if ((oomStrikes.get(leg.model) ?? 0) >= MT_OOM_STRIKES) {
        throw new CtvError(
          "offline.out_of_memory",
          `${leg.model} ran out of memory ${MT_OOM_STRIKES} times in a row; ` +
            "it is not loaded again before the offline models are released",
          { retryable: false },
        );
      }
      needed.set(leg.model, await mtCostOf(leg.model));
    }
    const plan = planLoad({
      loaded: mtCosts,
      needed,
      heapBytes: mtRunner.heapBytes(),
      isolated: mtRunner.isolated,
    });
    if (plan.kind === "too-large") {
      throw new CtvError(
        "offline.out_of_memory",
        `${[...needed.keys()].join(" + ")} need about ${gb(plan.needBytes)} GB of memory; ` +
          `the translation models may use ${gb(plan.budget)} GB`,
        { retryable: false },
      );
    }
    if (plan.kind === "restart") await resetMt(plan.reason);
    else for (const model of plan.unload) await unloadMt(model);
    return needed;
  };

  /** Loads a translation model into mtRunner, one file in memory at a time. Runs under mtLock. */
  const loadMt = (model: string, cost: number): Promise<MtModel> => {
    let pending = mtModels.get(model);
    if (pending === undefined) {
      const created = track(async (): Promise<MtModel> => {
        const files = await filesOf(model);
        const { encoder, decoder, tokenizer, config } = files;
        if (
          encoder === undefined ||
          decoder === undefined ||
          tokenizer === undefined ||
          config === undefined
        ) {
          throw new CtvError("offline.run", `${model}: missing files`);
        }
        const text = new TextDecoder();
        let parsedConfig: Seq2SeqConfig | null = null;
        let parsedTokenizer: Tokenizer | null = null;
        const started = now();
        await fetchFiles([config, tokenizer, encoder, decoder], async (file, bytes) => {
          if (file === config) {
            parsedConfig = seq2seqConfig(JSON.parse(text.decode(bytes)) as unknown);
          } else if (file === tokenizer) {
            parsedTokenizer = loadTokenizer(JSON.parse(text.decode(bytes)) as unknown);
          } else {
            const part: MtPart = file === encoder ? "encoder" : "decoder";
            await mtRunner.loadPart(model, part, bytes);
          }
        });
        if (parsedConfig === null || parsedTokenizer === null) {
          throw new CtvError("offline.run", `${model}: config or tokenizer missing`);
        }
        log.info("offline translation model ready", {
          model,
          ms: Math.round(now() - started),
          heapMb: Math.round(mtRunner.heapBytes() / 1e6),
        });
        return { config: parsedConfig, tokenizer: parsedTokenizer };
      });
      pending = created;
      mtModels.set(model, created);
      mtCosts.set(model, cost);
      void created.catch(() => {
        if (mtModels.get(model) === created) {
          mtModels.delete(model);
          mtCosts.delete(model);
        }
      });
    }
    return pending;
  };

  /** Translates texts with one loaded model leg; NLLB gets its language codes, Marian plain sentences. */
  const translateLeg = async (leg: MtLeg, model: MtModel, texts: readonly string[]): Promise<string[]> => {
    const { tokenizer, config } = model;
    const nllb = leg.model === NLLB_MODEL;
    const sourceCode = nllb ? tokenizer.tokenToId(leg.source) : undefined;
    const targetCode = nllb ? tokenizer.tokenToId(leg.target) : undefined;
    if (nllb && (sourceCode === undefined || targetCode === undefined)) {
      throw new CtvError("offline.pair_unsupported", `NLLB-200 does not know ${leg.source} → ${leg.target}`);
    }
    const inputs = texts.map((text) => {
      const ids = tokenizer.encode(text.normalize("NFKC")).slice(0, MAX_SOURCE_TOKENS);
      return nllb ? [sourceCode ?? 0, ...ids, config.eosId] : [...ids, config.eosId];
    });
    const out: string[] = new Array<string>(texts.length).fill("");
    const order = inputs
      .map((ids, index) => ({ index, length: ids.length }))
      .sort((a, b) => a.length - b.length);
    for (let start = 0; start < order.length; start += MT_BATCH) {
      const batch = order.slice(start, start + MT_BATCH);
      const generated = await mtRunner.generate(
        leg.model,
        config,
        batch.map((item) => inputs[item.index] ?? []),
        targetCode === undefined ? [] : [targetCode],
      );
      batch.forEach((item, row) => {
        out[item.index] = tokenizer.decode(generated[row] ?? []).trim();
      });
    }
    return out;
  };

  const armRelease = (): void => {
    releaseTimer?.();
    releaseTimer = clock.setTimer(
      () => {
        releaseTimer = null;
        void release();
      },
      Math.max(1, settings.current().engine.detectorReleaseMin) * 60_000,
    );
  };

  const release = async (): Promise<void> => {
    releaseTimer?.();
    releaseTimer = null;
    const ocr = [...ocrModels.values()];
    const mt = mtModels.size;
    ocrModels.clear();
    for (const pending of ocr) {
      const model = await pending.catch(() => null);
      if (model !== null) await releaseSession(model.session);
    }
    await mtLock(() => resetMt("idle"));
    oomStrikes.clear();
    if (ocr.length + mt > 0) log.info("offline sessions released");
    if (status.state !== "failed") setStatus({ state: "idle", active: [], download: null });
  };

  /** Recognizes line images with a model, keeping lines above the confidence floor. */
  const recognize = async (model: string, lines: readonly ImageDataLike[]): Promise<CtcResult[]> => {
    if (lines.length === 0) return [];
    const ort = await getOrt();
    return await recognizeLines(ort, await loadOcr(model), run, lines);
  };

  /** The page language from a few lines: Japanese kana, Chinese characters, Latin text, else Hangul. */
  const voteLanguage = async (crops: readonly Crop[]): Promise<Lang> => {
    const sample = [...crops]
      .sort((a, b) => b.image.width * b.image.height - a.image.width * a.image.height)
      .slice(0, VOTE_LINES)
      .map((crop) => crop.image);
    if (sample.length === 0) return "other";
    const confidence = (results: readonly CtcResult[]): number =>
      results.reduce((sum, r) => sum + r.confidence, 0) / Math.max(1, results.length);
    const cjk = await recognize(OCR_MODEL.zh, sample);
    const cjkText = cjk.map((r) => r.text).join(" ");
    const cjkCounts = scriptCounts(cjkText);
    const cjkConfidence = confidence(cjk);
    if (cjkCounts.kana > 0 && cjkConfidence >= 0.6) return "ja";
    if (cjkConfidence >= 0.75 && cjkCounts.han >= Math.max(1, cjkCounts.latin)) return "zh";
    if (cjkConfidence >= 0.75 && cjkCounts.latin >= 3) return latinLanguage(cjkText);
    const korean = await recognize(OCR_MODEL.ko, sample);
    const koreanCounts = scriptCounts(korean.map((r) => r.text).join(" "));
    if (koreanCounts.hangul > 0 && confidence(korean) >= cjkConfidence) return "ko";
    if (cjkCounts.kana > 0) return "ja";
    if (cjkCounts.han > 0) return "zh";
    return cjkCounts.latin > 0 ? latinLanguage(cjkText) : "other";
  };

  async function translatePack(
    pack: TranslatePack,
    onUnit: (result: UnitResult) => void,
  ): Promise<PackReport> {
    const plog: Logger = log.child({ frameKey: pack.frameKey, batchId: pack.packId });
    const started = clock.now();
    const t0 = now();
    const current = settings.current();
    const choice: OfflineModelChoice = current.translate.offlineModel;
    if (status.model !== choice) {
      setStatus({ model: choice });
      oomStrikes.clear();
    }
    const target = promptTarget(current).code;
    const report: PackReport = {
      packId: pack.packId,
      requests: 0,
      missing: [],
      error: null,
      model: null,
      lang: pack.lang === "auto" ? null : pack.lang,
      firstLineMs: null,
      totalMs: 0,
      uploadedBytes: 0,
    };
    const final = new Map<number, UnitResult>();
    const glyph = medianGlyph(pack.units.map((unit) => unit.geometry));
    const types: LineType[] = pack.units.map((unit) => guessLineType(unit.geometry, glyph));
    const emit = (
      index: number,
      status: UnitOutcomeStatus,
      original: string,
      translation: string,
      lang: Lang | null,
    ): void => {
      const unit = pack.units[index];
      if (unit === undefined || final.has(index)) return;
      const result: UnitResult = {
        contentKey: unit.contentKey,
        unitKey: unit.unitKey,
        status,
        type: status === "ignored" ? "ignore" : (types[index] ?? "dialogue"),
        speaker: "",
        original,
        translation: status === "ok" ? translation : "",
        lang,
        model: report.model,
      };
      final.set(index, result);
      report.firstLineMs ??= clock.now() - started;
      try {
        onUnit(result);
      } catch (error) {
        plog.error("onUnit threw", { message: errorMessage(error) });
      }
    };

    const timings = { readMs: 0, voteMs: 0, loadMs: 0, ocrMs: 0, mtMs: 0 };
    let lines = 0;
    try {
      // 1. Pixels → line images, synchronously while the pack holds the decoded images.
      const crops: Crop[] = [];
      const lineCounts = pack.units.map(() => 0);
      const readStart = now();
      pack.units.forEach((unit, index) => {
        if (types[index] === "ignore") return;
        const image = pack.images.get(unit.contentKey);
        if (image === undefined) return;
        const origin = padded(unit.geometry.text, unit.geometry.glyphPx, unit.imageSize);
        const region = readRegion(gfx, image, origin);
        for (const line of unitLines(region, origin, unit)) {
          crops.push({ unit: index, image: line.image, orientation: line.orientation });
          lineCounts[index] = (lineCounts[index] ?? 0) + 1;
        }
      });
      timings.readMs = now() - readStart;
      lines = crops.length;

      // 2. The language: the pack's, else a vote on a few lines.
      let lang: Lang;
      if (pack.lang === "auto") {
        const voteStart = now();
        lang = await voteLanguage(crops);
        timings.voteMs = now() - voteStart;
        report.lang = lang === "other" ? null : lang;
        if (lang !== "other") report.learning = { terms: [], summary: null, lang };
      } else {
        lang = pack.lang;
      }
      const source = lang === "other" ? null : lang;
      const route: MtRoute =
        source === null
          ? { kind: "unsupported", reason: "could not tell the page's language" }
          : planRoute(source, target, choice, new Set((await deps.catalog()).map((file) => file.model)));
      if (route.kind === "unsupported" || source === null) {
        throw new CtvError(
          "offline.pair_unsupported",
          `offline mode cannot translate ${lang} → ${target}: ${route.kind === "unsupported" ? route.reason : ""}`,
        );
      }
      report.model = route.kind === "translate" ? route.label : `offline:${OCR_MODEL[source]}`;

      // 3. OCR (its model downloaded and loaded first, timed apart from inference).
      let loadStart = now();
      await loadOcr(OCR_MODEL[source]);
      timings.loadMs += now() - loadStart;
      const ocrStart = now();
      const recognized = await recognize(
        OCR_MODEL[source],
        crops.map((crop) => crop.image),
      );
      timings.ocrMs = now() - ocrStart;
      const perUnit: string[][] = pack.units.map(() => []);
      recognized.forEach((result, i) => {
        const crop = crops[i];
        if (crop === undefined || result.confidence < MIN_LINE_CONFIDENCE) return;
        const text = crop.orientation === "v" ? fixVerticalText(result.text) : result.text;
        perUnit[crop.unit]?.push(text);
      });
      const texts: UnitText[] = perUnit.map((parts, index) => ({
        text: cleanText(joinLines(parts, source), source),
        lines: lineCounts[index] ?? 0,
      }));

      // 4. Units that need no translation. Sound effects (by geometry, or a repeated chunk like "두근두근") keep their
      // lettering: stylized glyphs are often misread, and a sentence model turns onomatopoeia into nonsense
      // ("두근두근" → "Two-by-two").
      const pending: number[] = [];
      texts.forEach((entry, index) => {
        if (types[index] !== "ignore" && isRepeatedChunk(entry.text)) types[index] = "sfx";
        if (types[index] === "ignore") emit(index, "ignored", entry.text, "", source);
        else if (entry.text === "") emit(index, "ignored", "", "", source);
        else if (route.kind === "same" || !hasLetters(entry.text) || types[index] === "sfx")
          emit(index, "keep-original", entry.text, "", source);
        else pending.push(index);
      });

      // 5. Translation, one pack at a time: room is made for the pack's models (memory.ts), they are loaded, then
      // a batch of units at a time goes through each leg in turn. After a failure in the translation runner its
      // models are dropped (a worker is restarted); a model out of memory twice in a row is refused.
      if (route.kind === "translate" && pending.length > 0) {
        const legs = route.legs;
        await mtLock(async () => {
          try {
            loadStart = now();
            const costs = await prepareMt(legs);
            const loaded: MtModel[] = [];
            for (const leg of legs) loaded.push(await loadMt(leg.model, costs.get(leg.model) ?? 0));
            setStatus({ active: activeIds() });
            timings.loadMs += now() - loadStart;
            const mtStart = now();
            for (let start = 0; start < pending.length; start += MT_BATCH) {
              const batch = pending.slice(start, start + MT_BATCH);
              const inputs = batch.map((index) => mtInput(texts[index]?.text ?? "", source));
              let sentences = inputs.map((input) => input.text);
              for (const [i, leg] of legs.entries()) {
                const model = loaded[i];
                if (model !== undefined) sentences = await translateLeg(leg, model, sentences);
              }
              batch.forEach((index, row) => {
                const original = texts[index]?.text ?? "";
                const translated = tidyTranslation(sentences[row] ?? "", original);
                const translation = inputs[row]?.closed === true ? reopen(translated) : translated;
                emit(index, translationOutcome(original, translation), original, translation, source);
              });
            }
            timings.mtMs = now() - mtStart;
            for (const leg of legs) oomStrikes.delete(leg.model);
          } catch (error) {
            const failure = offlineFailure(error, route.label);
            if (failure.retryable && failure.code === "offline.out_of_memory") {
              for (const leg of legs) oomStrikes.set(leg.model, (oomStrikes.get(leg.model) ?? 0) + 1);
            }
            if (failure.retryable || isFatal(error)) await resetMt(failure.code);
            throw failure;
          }
        });
      }
      setStatus({ state: loading > 0 ? status.state : "ready", error: null, active: activeIds() });
    } catch (thrown) {
      const info: ErrorInfo = toErrorInfo(offlineFailure(thrown, "offline engine"));
      report.error = info;
      setStatus({ state: "failed", error: info.code, download: null });
      plog.warn("offline pack failed", { message: info.message }, info.code);
      pack.units.forEach((_, index) => emit(index, "error", "", "", report.lang));
    }

    // Every unit gets exactly one result.
    pack.units.forEach((_, index) => emit(index, "untranslated", "", "", report.lang));
    report.missing = pack.units.flatMap((unit, index) => {
      const s = final.get(index)?.status;
      return s === "untranslated" || s === "error" ? [unit.unitKey] : [];
    });
    report.totalMs = clock.now() - started;
    plog.info("offline pack translated", {
      units: pack.units.length,
      lines,
      lang: report.lang,
      model: report.model,
      readMs: Math.round(timings.readMs),
      voteMs: Math.round(timings.voteMs),
      loadMs: Math.round(timings.loadMs),
      ocrMs: Math.round(timings.ocrMs),
      mtMs: Math.round(timings.mtMs),
      ms: Math.round(now() - t0),
      missing: report.missing.length,
      error: report.error?.code ?? null,
    });
    armRelease();
    return report;
  }

  return {
    translate: translatePack,
    state: () => ({
      ...status,
      model: settings.current().translate.offlineModel,
      active: [...status.active],
      download: status.download === null ? null : { ...status.download },
      heap: { engine: wasmHeapBytes(), translation: mtRunner.heapBytes() },
    }),
    release,
  };
}

/**
 * OCR output tidied per language: single spaces, a space after sentence punctuation in languages written with
 * spaces, and the Spanish "¡" the Latin recognizer reads as "i".
 */
export function cleanText(text: string, lang: Lang): string {
  let out = text.replace(/\s+/gu, " ").trim();
  if (lang === "es") out = out.replace(/(^|[\s"'(])i(?=\p{Lu}{2})/gu, "$1¡");
  // The recognizer often drops the space after a full stop ("들게.너는"); a translation model then skips the second
  // sentence.
  if (!joinsWithoutSpace(lang)) out = out.replace(/([.!?])(?=\p{L})/gu, "$1 ");
  return out;
}

/**
 * The sentence given to the translation model: all-capital Latin lettering in sentence case, and a full stop when the
 * text has no closing punctuation (`closed`).
 */
export function mtInput(text: string, lang: Lang): { text: string; closed: boolean } {
  const cased = lang === "en" || lang === "es" ? sentenceCase(text) : text;
  // Opus-MT learned on punctuated sentences: an unpunctuated caption ("The next morning") can come out as a loop of
  // one word. A full stop is added for the model and taken off its answer.
  if (/[.!?…。！？」』"')\]）]$/u.test(cased)) return { text: cased, closed: false };
  return { text: `${cased}${joinsWithoutSpace(lang) ? "。" : "."}`, closed: true };
}

/** The translation of a sentence whose full stop mtInput added, without it. */
export function reopen(translation: string): string {
  return translation.replace(/[.。]$/u, "");
}

/**
 * A model answer without the subtitle dash Opus-MT often puts first ("- I'm off today"), unless the source had one.
 */
export function tidyTranslation(translation: string, original: string): string {
  const dash = /^[-–—]\s*/u;
  return dash.test(original.trim()) ? translation.trim() : translation.trim().replace(dash, "");
}
