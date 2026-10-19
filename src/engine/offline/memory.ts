// Memory rules of the offline translation models (docs/OFFLINE-MODE.md, "Memory"). PURE.
//
// onnxruntime-web keeps every session of one instance in a single wasm32 heap of at most 4 GiB that only grows.
// Measured with the pinned int8 exports (Chrome 154 and Node, graphOptimizationLevel "all"): a translation model
// takes about 2.6× its file size once loaded and up to 3.9× after its first batch (ORT's CPU arena), e.g. NLLB-200
// (895 MB of files) 3.4 GB; Opus-MT (113 MB) about 0.3–0.4 GB. In the engine's shared instance, next to the
// detector, the recognizers and a pivot pair, NLLB-200 pushed the heap to 3.8–4.0 GB of the 4.29 GB maximum, where
// any further growth fails and ORT aborts — taking the detector down with it. The translation models therefore run in
// their own worker (mt-worker.ts) with their own heap, and planLoad() keeps that heap within a budget: a pack whose
// models need more than the budget is refused, models the pack does not need are unloaded first, and the worker is
// restarted (which gives the whole heap back) when NLLB-200 and Opus-MT would meet in one heap, or when a heap that
// already grew large would be reused for another model.

import { CtvError, errorMessage } from "../../shared/errors.ts";
import { NLLB_MODEL } from "../../shared/offline/routing.ts";

/** The wasm32 maximum: 65536 pages of 64 KiB. */
export const WASM_HEAP_MAX = 4 * 1024 * 1024 * 1024;
/** Heap bytes a translation model may take per byte of its encoder and decoder files (measured 3.6–3.9). */
export const MT_HEAP_FACTOR = 4;
/** What the loaded translation models may take together (estimates), leaving room for batches and loading. */
export const MT_HEAP_BUDGET = 3_800_000_000;
/** A heap that already grew past this is restarted before another model is loaded into it (fragmentation). */
export const MT_HEAP_RESTART_AT = 2_000_000_000;

/** Estimated heap bytes of a translation model from the size of its encoder and decoder files. */
export function mtCost(fileBytes: number): number {
  return Math.ceil(fileBytes * MT_HEAP_FACTOR);
}

export interface LoadPlanInput {
  /** Loaded (or loading) translation models and their estimated cost. */
  loaded: ReadonlyMap<string, number>;
  /** The models this pack needs (one, or two for a pivot) and their estimated cost. */
  needed: ReadonlyMap<string, number>;
  /** Current size of the runner's heap (its high-water mark; 0 when unknown). */
  heapBytes: number;
  /** A restart gives the memory back (the worker runner); the in-process fallback can only unload. */
  isolated: boolean;
  budget?: number;
}

export type LoadPlan =
  /** Unload these models, then load what is missing. */
  | { kind: "load"; unload: string[] }
  /** Restart the runner (everything unloaded, a fresh heap), then load what is needed. */
  | { kind: "restart"; reason: "family" | "heap" }
  /** The needed models cannot fit in one heap at all. */
  | { kind: "too-large"; needBytes: number; budget: number };

const family = (model: string): "nllb" | "opus" => (model === NLLB_MODEL ? "nllb" : "opus");

export function planLoad(input: LoadPlanInput): LoadPlan {
  const budget = input.budget ?? MT_HEAP_BUDGET;
  const sum = (costs: Iterable<number>): number => [...costs].reduce((total, cost) => total + cost, 0);
  const needBytes = sum(input.needed.values());
  if (needBytes > budget) return { kind: "too-large", needBytes, budget };
  const unload = [...input.loaded.keys()].filter((model) => !input.needed.has(model));
  const missing = [...input.needed.keys()].filter((model) => !input.loaded.has(model));
  if (missing.length === 0) return { kind: "load", unload };
  if (input.isolated) {
    const families = new Set([...input.loaded.keys()].map(family));
    if (missing.some((model) => families.size > 0 && !families.has(family(model)))) {
      return { kind: "restart", reason: "family" };
    }
    if (input.heapBytes >= MT_HEAP_RESTART_AT && unload.length > 0)
      return { kind: "restart", reason: "heap" };
  }
  return { kind: "load", unload };
}

/** ORT / WebAssembly failures that mean the heap ran out (Memory.grow refused, malloc failed, ORT aborted on OOM). */
const OUT_OF_MEMORY =
  /out of memory|\boom\b|bad_alloc|bad allocation|cannot enlarge memory|could not allocate|failed to allocate|allocation failed|memory\.grow|RangeError: .*(memory|buffer)/iu;

/** Failures after which the ORT instance must not be used again (an abort leaves the module unusable). */
const FATAL =
  /aborted\(|abort\(|RuntimeError|unreachable|memory access out of bounds|null function|table index is out of bounds|worker (failed|crashed|stopped)/iu;

export function isOutOfMemory(error: unknown): boolean {
  return OUT_OF_MEMORY.test(errorMessage(error));
}

export function isFatal(error: unknown): boolean {
  if (error instanceof CtvError) return error.code === "offline.out_of_memory";
  const text = errorMessage(error);
  return isOutOfMemory(text) || FATAL.test(text) || (error instanceof Error && error.name === "RuntimeError");
}

/** The pack error for a failure of a translation or recognition model. */
export function offlineFailure(error: unknown, what: string): CtvError {
  if (error instanceof CtvError) return error;
  const message = errorMessage(error);
  if (isOutOfMemory(message)) {
    return new CtvError("offline.out_of_memory", `${what}: out of memory (${message})`, {
      retryable: true,
      cause: error,
    });
  }
  return new CtvError("offline.run", `${what}: ${message}`, { retryable: true, cause: error });
}
