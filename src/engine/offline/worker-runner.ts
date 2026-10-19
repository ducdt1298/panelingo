// The engine's side of the translation worker (mt-worker.ts): an MtRunner whose models live in a dedicated worker
// with its own onnxruntime-web heap. The worker starts on first use; requests carry ids and model bytes are
// transferred, not copied. A fatal answer (ORT aborted, out of memory), a worker error or a reset() terminates the
// worker: its whole heap goes back to the system, every pending request fails with offline.out_of_memory or
// offline.run, and the next request starts a new worker. docs/OFFLINE-MODE.md, "Memory".

import type { Logger } from "../../platform/log.ts";
import { CtvError } from "../../shared/errors.ts";
import type { MtRunner } from "./mt-runner.ts";
import type { MtRequest, MtRequestBody, MtResponse } from "./mt-worker-protocol.ts";

/** The part of a dedicated Worker used here. */
export interface WorkerLike {
  postMessage(message: MtRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<MtResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export interface WorkerRunnerDeps {
  createWorker(): WorkerLike;
  /** URL of ORT's WebAssembly binary for the worker. */
  wasmUrl: string;
  log: Logger;
}

interface Pending {
  resolve(response: MtResponse & { ok: true }): void;
  reject(error: CtvError): void;
}

interface Live {
  worker: WorkerLike;
  pending: Map<number, Pending>;
  started: Promise<void>;
}

export function createWorkerMtRunner(deps: WorkerRunnerDeps): MtRunner {
  const { log } = deps;
  let live: Live | null = null;
  let nextId = 1;
  let heap = 0;
  let generation = 0;

  const failure = (message: string, outOfMemory: boolean): CtvError =>
    new CtvError(outOfMemory ? "offline.out_of_memory" : "offline.run", `translation worker: ${message}`, {
      retryable: true,
    });

  const stop = (current: Live, error: CtvError, reason: string): void => {
    if (live !== current) return;
    live = null;
    try {
      current.worker.terminate();
    } catch {
      // already gone
    }
    for (const pending of current.pending.values()) pending.reject(error);
    current.pending.clear();
    log.info("offline translation worker stopped", { reason, heapMb: Math.round(heap / 1e6) });
    heap = 0;
  };

  const send = (current: Live, body: MtRequestBody, transfer: Transferable[] = []): Promise<MtResponse> =>
    new Promise((resolve, reject) => {
      // Stopped while the caller waited (crash, reset): never post to a terminated worker.
      if (live !== current) {
        reject(failure("stopped", false));
        return;
      }
      const id = nextId++;
      current.pending.set(id, { resolve, reject });
      try {
        const message: MtRequest = { ...body, id };
        current.worker.postMessage(message, transfer);
      } catch (error) {
        current.pending.delete(id);
        reject(failure(String(error), false));
      }
    });

  const start = (): Live => {
    generation += 1;
    const worker = deps.createWorker();
    const current: Live = { worker, pending: new Map(), started: Promise.resolve() };
    live = current;
    worker.onmessage = (event) => {
      const response = event.data;
      heap = response.heapBytes;
      const pending = current.pending.get(response.id);
      if (pending === undefined) return;
      current.pending.delete(response.id);
      if (response.ok) {
        pending.resolve(response);
        return;
      }
      const error = failure(response.error.message, response.error.outOfMemory);
      if (response.error.fatal) {
        pending.reject(error);
        stop(current, error, response.error.message);
      } else {
        pending.reject(error);
      }
    };
    worker.onerror = (event) => {
      const message =
        typeof event.message === "string" && event.message !== "" ? event.message : "worker failed";
      stop(current, failure(`worker crashed: ${message}`, /memory/iu.test(message)), message);
    };
    worker.onmessageerror = () => stop(current, failure("unreadable message", false), "messageerror");
    current.started = send(current, { type: "init", wasmUrl: deps.wasmUrl }).then(() => undefined);
    log.info("offline translation worker started", { generation });
    return current;
  };

  const request = async (body: MtRequestBody, transfer: Transferable[] = []): Promise<MtResponse> => {
    const current = live ?? start();
    await current.started;
    return await send(current, body, transfer);
  };

  return {
    isolated: true,
    async loadPart(model, part, bytes) {
      await request({ type: "load", model, part, bytes }, [bytes.buffer]);
    },
    async generate(model, config, inputs, prefix) {
      const response = await request({
        type: "generate",
        model,
        config,
        inputs: inputs.map((row) => [...row]),
        prefix: [...prefix],
      });
      if (!response.ok || response.ids === undefined) throw failure("no output", false);
      return response.ids;
    },
    async unload(model) {
      if (live === null) return;
      await request({ type: "unload", model });
    },
    reset(reason) {
      if (live !== null) stop(live, failure(`restarted (${reason})`, false), reason);
      return Promise.resolve();
    },
    heapBytes: () => heap,
  };
}
