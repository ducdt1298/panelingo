// Where the offline translation models run (docs/OFFLINE-MODE.md, "Memory"). The engine uses the worker runner
// (worker-runner.ts): the models live in a dedicated worker with its own onnxruntime-web instance and heap, so they
// can neither exhaust the detector's heap nor take it down when ORT aborts, and restarting the worker gives all of
// their memory back. createLocalMtRunner runs the same operations in the calling context (unit tests, and engines
// where a worker cannot start); the worker itself uses it around its own ORT instance (mt-worker.ts).

import type { OrtLock } from "../contracts.ts";
import type { OfflineOrt, OfflineSession } from "./ort.ts";
import { defaultMaxNew, generate, type Seq2SeqConfig } from "./seq2seq.ts";

export type MtPart = "encoder" | "decoder";

export interface MtRunner {
  /** Creates one part of a model. The bytes are handed over: the caller must not use them afterwards. */
  loadPart(model: string, part: MtPart, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  /** Greedy decoding of a batch of source ids (defaultMaxNew per row); `prefix` is forced after the start token. */
  generate(
    model: string,
    config: Seq2SeqConfig,
    inputs: ReadonlyArray<readonly number[]>,
    prefix: readonly number[],
  ): Promise<number[][]>;
  /** Releases a model's sessions. */
  unload(model: string): Promise<void>;
  /** Drops every model; an isolated runner also gives its heap back (the next call starts afresh). */
  reset(reason: string): Promise<void>;
  /** Size of the runner's ORT heap at the last answer (bytes; 0 before it starts or when unknown). */
  heapBytes(): number;
  /** reset() frees the memory (a worker); false when the models share the caller's heap. */
  readonly isolated: boolean;
}

export interface LocalMtRunnerDeps {
  getOrt(): Promise<OfflineOrt>;
  /** Serializes every ORT call of this instance (asyncify allows one at a time). */
  exclusive: OrtLock;
  heapBytes?: () => number;
}

export function createLocalMtRunner(deps: LocalMtRunnerDeps): MtRunner {
  const { exclusive } = deps;
  const models = new Map<string, Partial<Record<MtPart, OfflineSession>>>();

  const releaseAll = async (parts: Partial<Record<MtPart, OfflineSession>> | undefined): Promise<void> => {
    for (const session of [parts?.encoder, parts?.decoder]) {
      if (session !== undefined) await exclusive(() => session.release()).catch(() => undefined);
    }
  };

  return {
    isolated: false,
    async loadPart(model, part, bytes) {
      const ort = await deps.getOrt();
      const session = await exclusive(() => ort.createSession(bytes, "wasm"));
      const parts = models.get(model) ?? {};
      const previous = parts[part];
      parts[part] = session;
      models.set(model, parts);
      if (previous !== undefined) await exclusive(() => previous.release()).catch(() => undefined);
    },
    async generate(model, config, inputs, prefix) {
      const parts = models.get(model);
      const encoder = parts?.encoder;
      const decoder = parts?.decoder;
      if (encoder === undefined || decoder === undefined) throw new Error(`${model} is not loaded`);
      const ort = await deps.getOrt();
      return await generate(
        ort,
        { encoder, decoder, config },
        (session, feeds) => exclusive(() => session.run(feeds)),
        inputs,
        { prefix: [...prefix], maxNew: defaultMaxNew },
      );
    },
    async unload(model) {
      const parts = models.get(model);
      models.delete(model);
      await releaseAll(parts);
    },
    async reset() {
      const all = [...models.values()];
      models.clear();
      for (const parts of all) await releaseAll(parts);
    },
    heapBytes: () => deps.heapBytes?.() ?? 0,
  };
}
