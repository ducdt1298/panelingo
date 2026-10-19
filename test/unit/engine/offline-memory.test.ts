// Offline mode memory rules (src/engine/offline/memory.ts), the translation worker's two sides with a fake worker
// and fake ORT (worker-runner.ts, mt-worker.ts): budget and restarts, failure mapping, fatal answers, transfers.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MT_HEAP_BUDGET,
  MT_HEAP_RESTART_AT,
  isFatal,
  isOutOfMemory,
  mtCost,
  offlineFailure,
  planLoad,
} from "../../../src/engine/offline/memory.ts";
import { createMtWorkerHandler } from "../../../src/engine/offline/mt-worker.ts";
import type { MtRequest, MtResponse } from "../../../src/engine/offline/mt-worker-protocol.ts";
import type { OfflineOrt, OfflineSession } from "../../../src/engine/offline/ort.ts";
import { createWorkerMtRunner, type WorkerLike } from "../../../src/engine/offline/worker-runner.ts";
import { createLogger, type LogSink } from "../../../src/platform/log.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { LogEntry } from "../../../src/shared/types.ts";

const NLLB = "nllb-200-distilled-600m";
const map = (entries: Array<[string, number]>): Map<string, number> => new Map(entries);
const opus = mtCost(113_000_000);
const nllb = mtCost(895_000_000);

describe("planLoad: the translation heap budget", () => {
  test("estimates: NLLB-200 fits alone, never next to Opus-MT", () => {
    assert.ok(nllb < MT_HEAP_BUDGET && nllb + opus > MT_HEAP_BUDGET - 300_000_000);
    assert.equal(mtCost(1000), 4000);
  });

  test("already loaded: nothing to do; models the pack does not need are unloaded", () => {
    const loaded = map([
      ["opus-mt-ko-en", opus],
      ["opus-mt-en-vi", opus],
    ]);
    assert.deepEqual(
      planLoad({ loaded, needed: map([["opus-mt-ko-en", opus]]), heapBytes: 1e9, isolated: true }),
      { kind: "load", unload: ["opus-mt-en-vi"] },
    );
    assert.deepEqual(
      planLoad({ loaded, needed: map([["opus-mt-ja-en", opus]]), heapBytes: 1e9, isolated: true }),
      { kind: "load", unload: ["opus-mt-ko-en", "opus-mt-en-vi"] },
    );
  });

  test("switching between NLLB-200 and Opus-MT restarts the worker (a fresh heap)", () => {
    assert.deepEqual(
      planLoad({
        loaded: map([["opus-mt-ko-en", opus]]),
        needed: map([[NLLB, nllb]]),
        heapBytes: 6e8,
        isolated: true,
      }),
      { kind: "restart", reason: "family" },
    );
    assert.deepEqual(
      planLoad({
        loaded: map([[NLLB, nllb]]),
        needed: map([["opus-mt-ko-en", opus]]),
        heapBytes: 3.4e9,
        isolated: true,
      }),
      { kind: "restart", reason: "family" },
    );
  });

  test("a heap that grew large is restarted before reuse; small heaps are reused", () => {
    const loaded = map([["opus-mt-ko-en", opus]]);
    const needed = map([["opus-mt-ja-en", opus]]);
    assert.deepEqual(planLoad({ loaded, needed, heapBytes: MT_HEAP_RESTART_AT, isolated: true }), {
      kind: "restart",
      reason: "heap",
    });
    assert.deepEqual(planLoad({ loaded, needed, heapBytes: 8e8, isolated: true }), {
      kind: "load",
      unload: ["opus-mt-ko-en"],
    });
  });

  test("over budget without a worker: unload everything; more than the budget at all: too large", () => {
    assert.deepEqual(
      planLoad({
        loaded: map([["opus-mt-ko-en", opus]]),
        needed: map([[NLLB, nllb]]),
        heapBytes: 0,
        isolated: false,
      }),
      { kind: "load", unload: ["opus-mt-ko-en"] },
    );
    assert.deepEqual(
      planLoad({ loaded: new Map(), needed: map([["huge", 5e9]]), heapBytes: 0, isolated: true }),
      {
        kind: "too-large",
        needBytes: 5e9,
        budget: MT_HEAP_BUDGET,
      },
    );
  });
});

describe("failure mapping", () => {
  test("out of memory and aborts are fatal; ordinary ORT errors are not", () => {
    for (const message of [
      "RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded",
      "RuntimeError: Aborted(OOM)",
      "Error: failed to allocate a buffer of size 475505771",
      "std::bad_alloc",
    ]) {
      assert.equal(isOutOfMemory(message), true, message);
      assert.equal(isFatal(new Error(message)), true, message);
    }
    const runtime = new Error("memory access out of bounds");
    runtime.name = "RuntimeError";
    assert.equal(isFatal(runtime), true);
    assert.equal(isOutOfMemory(runtime), false);
    assert.equal(isFatal(new Error("failed to call OrtRun(). ERROR_CODE: 2, invalid dimensions")), false);
  });

  test("offlineFailure: offline.out_of_memory or offline.run, retryable; CtvErrors unchanged", () => {
    const oom = offlineFailure(new Error("Aborted(OOM)"), "nllb");
    assert.deepEqual([oom.code, oom.retryable], ["offline.out_of_memory", true]);
    const run = offlineFailure(new Error("invalid dimensions"), "nllb");
    assert.deepEqual([run.code, run.retryable], ["offline.run", true]);
    const own = new CtvError("offline.pair_unsupported", "no");
    assert.equal(offlineFailure(own, "x"), own);
  });
});

/* ------------------------------------------------------------------ the worker's side */

function fakeOrt(calls: string[], failCreate?: () => Error | null): OfflineOrt {
  return {
    createSession(bytes) {
      const failure = failCreate?.() ?? null;
      if (failure !== null) return Promise.reject(failure);
      const name = new TextDecoder().decode(bytes);
      calls.push(`create ${name}`);
      const session: OfflineSession = {
        inputNames: name.endsWith("decoder") ? ["input_ids", "encoder_hidden_states"] : ["input_ids"],
        outputNames: ["out"],
        run: (feeds) => {
          calls.push(`run ${name}`);
          if (name.endsWith("encoder")) {
            return Promise.resolve({ last_hidden_state: { data: new Float32Array(8), dims: [1, 1, 8] } });
          }
          // Vocabulary of 3: token 2 first, then end of sentence (0).
          const T = feeds["input_ids"]?.dims[1] ?? 1;
          const logits = new Float32Array(T * 3);
          logits[(T - 1) * 3 + (T === 1 ? 2 : 0)] = 9;
          return Promise.resolve({ logits: { data: logits, dims: [1, T, 3] } });
        },
        release: () => {
          calls.push(`release ${name}`);
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
    float32: (data, dims) => ({ data, dims }),
    int64: (data, dims) => ({ data, dims }),
    bool: (data, dims) => ({ data, dims }),
  };
}

const CONFIG = { heads: 1, headDim: 8, decoderStartId: 1, eosId: 0, padId: 1, suppress: [1] };
const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text));

describe("mt-worker handler", () => {
  test("init, load both parts, generate, unload; one request at a time", async () => {
    const calls: string[] = [];
    const handler = createMtWorkerHandler({
      loadOrt: () => Promise.resolve(fakeOrt(calls)),
      heapBytes: () => 42,
    });
    const answers = await Promise.all([
      handler.handle({ id: 1, type: "init", wasmUrl: "chrome-extension://x/ort.wasm" }),
      handler.handle({ id: 2, type: "load", model: "m", part: "encoder", bytes: bytesOf("m.encoder") }),
      handler.handle({ id: 3, type: "load", model: "m", part: "decoder", bytes: bytesOf("m.decoder") }),
      handler.handle({ id: 4, type: "generate", model: "m", config: CONFIG, inputs: [[5, 0]], prefix: [] }),
      handler.handle({ id: 5, type: "unload", model: "m" }),
    ]);
    assert.ok(answers.every((answer) => answer.ok && answer.heapBytes === 42));
    assert.deepEqual(answers[3]?.ok === true ? answers[3].ids : null, [[2]]);
    assert.deepEqual(calls.slice(0, 2), ["create m.encoder", "create m.decoder"]);
    assert.ok(calls.includes("release m.encoder") && calls.includes("release m.decoder"));
  });

  test("an out-of-memory failure answers fatal, and so does every later request", async () => {
    const handler = createMtWorkerHandler({
      loadOrt: () =>
        Promise.resolve(fakeOrt([], () => new RangeError("WebAssembly.Memory.grow(): out of memory"))),
      heapBytes: () => 4_200_000_000,
    });
    await handler.handle({ id: 1, type: "init", wasmUrl: "u" });
    const failed = await handler.handle({
      id: 2,
      type: "load",
      model: "m",
      part: "encoder",
      bytes: bytesOf("x"),
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.deepEqual([failed.error.fatal, failed.error.outOfMemory], [true, true]);
    const later = await handler.handle({ id: 3, type: "unload", model: "m" });
    assert.ok(!later.ok && later.error.fatal);
  });

  test("a model that is not loaded is an ordinary (non-fatal) error", async () => {
    const handler = createMtWorkerHandler({
      loadOrt: () => Promise.resolve(fakeOrt([])),
      heapBytes: () => 0,
    });
    await handler.handle({ id: 1, type: "init", wasmUrl: "u" });
    const answer = await handler.handle({
      id: 2,
      type: "generate",
      model: "x",
      config: CONFIG,
      inputs: [[1]],
      prefix: [],
    });
    assert.ok(!answer.ok && !answer.error.fatal);
  });
});

/* ------------------------------------------------------------------ the engine's side */

/** A Worker that runs the real handler in-process, recording transfers and terminations. */
function fakeWorkers(
  failCreate?: () => Error | null,
  hold: (message: MtRequest) => boolean = () => false,
): {
  created: () => number;
  terminated: () => number;
  transfers: number[];
  createWorker: () => WorkerLike;
  crashLatest: (message: string) => void;
} {
  const workers: WorkerLike[] = [];
  let terminated = 0;
  const transfers: number[] = [];
  const createWorker = (): WorkerLike => {
    const handler = createMtWorkerHandler({
      loadOrt: () => Promise.resolve(fakeOrt([], failCreate)),
      heapBytes: () => 1_000_000 * workers.length,
    });
    let alive = true;
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(message: MtRequest, transfer: Transferable[]) {
        transfers.push(transfer.length);
        if (hold(message)) return;
        void handler.handle(message).then((response: MtResponse) => {
          if (alive) worker.onmessage?.({ data: response } as MessageEvent<MtResponse>);
        });
      },
      terminate() {
        alive = false;
        terminated += 1;
      },
    };
    workers.push(worker);
    return worker;
  };
  return {
    created: () => workers.length,
    terminated: () => terminated,
    transfers,
    createWorker,
    crashLatest: (message) => workers.at(-1)?.onerror?.({ message } as ErrorEvent),
  };
}

function logger(): { log: ReturnType<typeof createLogger>; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const sink: LogSink = (entry) => entries.push(entry);
  return { log: createLogger("engine", { sinks: [sink], minLevel: "debug" }), entries };
}

describe("worker runner", () => {
  test("starts on first use, transfers model bytes, reports the worker's heap", async () => {
    const fake = fakeWorkers();
    const { log, entries } = logger();
    const runner = createWorkerMtRunner({ createWorker: fake.createWorker, wasmUrl: "u", log });
    assert.equal(fake.created(), 0);
    await runner.loadPart("m", "encoder", bytesOf("m.encoder"));
    await runner.loadPart("m", "decoder", bytesOf("m.decoder"));
    assert.deepEqual(await runner.generate("m", CONFIG, [[5, 0]], []), [[2]]);
    assert.equal(fake.created(), 1);
    assert.deepEqual(fake.transfers, [0, 1, 1, 0], "init, the two parts transferred, generate copied");
    assert.equal(runner.heapBytes(), 1_000_000);
    assert.ok(runner.isolated);
    assert.ok(entries.some((e) => e.msg === "offline translation worker started"));
  });

  test("reset terminates the worker (its heap goes back); the next call starts a new one", async () => {
    const fake = fakeWorkers();
    const runner = createWorkerMtRunner({ createWorker: fake.createWorker, wasmUrl: "u", log: logger().log });
    await runner.loadPart("m", "encoder", bytesOf("m.encoder"));
    await runner.reset("family");
    assert.deepEqual([fake.terminated(), runner.heapBytes()], [1, 0]);
    await runner.loadPart("m", "encoder", bytesOf("m.encoder"));
    assert.equal(fake.created(), 2);
  });

  test("a fatal answer fails with offline.out_of_memory and replaces the worker", async () => {
    let fail = true;
    const fake = fakeWorkers(() => (fail ? new Error("RuntimeError: Aborted(OOM)") : null));
    const runner = createWorkerMtRunner({ createWorker: fake.createWorker, wasmUrl: "u", log: logger().log });
    await assert.rejects(runner.loadPart("m", "encoder", bytesOf("m.encoder")), (error: unknown) => {
      assert.ok(error instanceof CtvError);
      assert.equal(error.code, "offline.out_of_memory");
      return true;
    });
    assert.equal(fake.terminated(), 1);
    fail = false;
    await runner.loadPart("m", "encoder", bytesOf("m.encoder"));
    assert.equal(fake.created(), 2);
  });

  test("a crashed worker fails its pending requests instead of hanging", async () => {
    const fake = fakeWorkers(undefined, (message) => message.type === "load" && message.part === "decoder");
    const runner = createWorkerMtRunner({ createWorker: fake.createWorker, wasmUrl: "u", log: logger().log });
    await runner.loadPart("m", "encoder", bytesOf("m.encoder"));
    const pending = runner.loadPart("m", "decoder", bytesOf("m.decoder"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.crashLatest("Out of memory");
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CtvError && error.code === "offline.out_of_memory",
    );
    assert.equal(fake.terminated(), 1);
  });
});
