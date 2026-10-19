// Messages between the engine (worker-runner.ts) and the translation worker (mt-worker.ts). PURE.

import type { MtPart } from "./mt-runner.ts";
import type { Seq2SeqConfig } from "./seq2seq.ts";

export type MtRequestBody =
  /** First message: where ORT's WebAssembly binary is (workers have no chrome.runtime.getURL). */
  | { type: "init"; wasmUrl: string }
  | { type: "load"; model: string; part: MtPart; bytes: Uint8Array<ArrayBuffer> }
  | {
      type: "generate";
      model: string;
      config: Seq2SeqConfig;
      inputs: number[][];
      prefix: number[];
    }
  | { type: "unload"; model: string };

export type MtRequest = MtRequestBody & { id: number };

export type MtResponse =
  | { id: number; ok: true; heapBytes: number; ids?: number[][] }
  | {
      id: number;
      ok: false;
      heapBytes: number;
      /** fatal: the worker's ORT instance is unusable (aborted, out of memory) and must be replaced. */
      error: { message: string; fatal: boolean; outOfMemory: boolean };
    };
