// The translation worker (dist/engine/offline-worker.js, started by worker-runner.ts): the offline translation models
// in their own onnxruntime-web instance, so their heap (up to 4 GiB, NLLB-200 alone takes about 3.4 GB) is not the
// detector's, an ORT abort only kills this worker, and terminating it gives the memory back. Requests are handled one
// at a time (asyncify allows one ORT call at a time); after a fatal failure every request answers fatal, and the
// engine starts a new worker. docs/OFFLINE-MODE.md, "Memory".

import { installWasmHeapProbe, wasmHeapBytes } from "../wasm-heap.ts";
import { isFatal, isOutOfMemory } from "./memory.ts";
import { createLocalMtRunner, type MtRunner } from "./mt-runner.ts";
import type { MtRequest, MtResponse } from "./mt-worker-protocol.ts";
import type { OfflineOrt } from "./ort.ts";

export interface MtWorkerHandlerDeps {
  loadOrt(wasmUrl: string): Promise<OfflineOrt>;
  heapBytes(): number;
}

export interface MtWorkerHandler {
  handle(request: MtRequest): Promise<MtResponse>;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export function createMtWorkerHandler(deps: MtWorkerHandlerDeps): MtWorkerHandler {
  let wasmUrl: string | null = null;
  let ortPromise: Promise<OfflineOrt> | null = null;
  let dead: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const runner: MtRunner = createLocalMtRunner({
    getOrt: () => {
      if (wasmUrl === null) return Promise.reject(new Error("translation worker: init first"));
      ortPromise ??= deps.loadOrt(wasmUrl);
      return ortPromise;
    },
    // The worker handles one request at a time already.
    exclusive: (fn) => fn(),
  });

  async function serve(request: MtRequest): Promise<MtResponse> {
    if (dead !== null) {
      return {
        id: request.id,
        ok: false,
        heapBytes: deps.heapBytes(),
        error: { message: `translation worker stopped after: ${dead}`, fatal: true, outOfMemory: false },
      };
    }
    try {
      switch (request.type) {
        case "init":
          wasmUrl = request.wasmUrl;
          return { id: request.id, ok: true, heapBytes: deps.heapBytes() };
        case "load":
          await runner.loadPart(request.model, request.part, request.bytes);
          return { id: request.id, ok: true, heapBytes: deps.heapBytes() };
        case "generate": {
          const ids = await runner.generate(request.model, request.config, request.inputs, request.prefix);
          return { id: request.id, ok: true, heapBytes: deps.heapBytes(), ids };
        }
        case "unload":
          await runner.unload(request.model);
          return { id: request.id, ok: true, heapBytes: deps.heapBytes() };
      }
    } catch (error) {
      const message = errorText(error);
      const fatal = isFatal(error);
      if (fatal) dead = message;
      return {
        id: request.id,
        ok: false,
        heapBytes: deps.heapBytes(),
        error: { message, fatal, outOfMemory: isOutOfMemory(message) },
      };
    }
  }

  return {
    handle(request) {
      const result = queue.then(() => serve(request));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<MtRequest>) => void) | null;
  postMessage(message: MtResponse): void;
}

/** Worker entry: only when this module runs as a dedicated worker (unit tests import the handler alone). */
function start(scope: WorkerScope): void {
  // Before ORT creates its heap, so the engine can be told how large it grew.
  installWasmHeapProbe();
  const handler = createMtWorkerHandler({
    loadOrt: async (wasmUrl) => {
      const { importOfflineOrt } = await import("./ort.ts");
      return await importOfflineOrt(() => wasmUrl);
    },
    heapBytes: wasmHeapBytes,
  });
  scope.onmessage = (event) => {
    void handler.handle(event.data).then((response) => scope.postMessage(response));
  };
}

declare const WorkerGlobalScope: (new () => object) | undefined;
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  start(globalThis);
}
