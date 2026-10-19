// The ORT surface of the offline engine: the same lazily loaded "onnxruntime-web/webgpu" module and environment as
// the detector (ort-env.ts), with the tensor types the recognizers and the translation models need. In the engine
// document it is the detector's instance (the recognizers share its lock: asyncify forbids overlapping calls); in
// the translation worker (mt-worker.ts) it is the worker's own instance.

import { configureOrtEnv } from "../ort-env.ts";

export type OfflineBackend = "webgpu" | "wasm";

export interface OfflineTensor {
  readonly data: unknown;
  readonly dims: readonly number[];
  dispose?(): void;
}

export interface OfflineSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OfflineTensor>): Promise<Readonly<Record<string, OfflineTensor>>>;
  release(): Promise<void>;
}

export interface OfflineOrt {
  createSession(model: Uint8Array<ArrayBuffer>, backend: OfflineBackend): Promise<OfflineSession>;
  float32(data: Float32Array, dims: readonly number[]): OfflineTensor;
  int64(data: BigInt64Array, dims: readonly number[]): OfflineTensor;
  bool(data: Uint8Array, dims: readonly number[]): OfflineTensor;
}

/** The real module, configured like the detector's (in the engine document: the detector's WASM instance). */
export async function importOfflineOrt(getURL: (path: string) => string): Promise<OfflineOrt> {
  const ort = await import("onnxruntime-web/webgpu");
  configureOrtEnv(ort.env, getURL);
  return {
    createSession: (model, backend) =>
      ort.InferenceSession.create(model, {
        executionProviders: [backend],
        graphOptimizationLevel: "all",
        // 3 = error: no optimizer warnings on the extension's Errors page (see configureOrtEnv).
        logSeverityLevel: 3,
      }),
    float32: (data, dims) => new ort.Tensor("float32", data, dims),
    int64: (data, dims) => new ort.Tensor("int64", data, dims),
    bool: (data, dims) => new ort.Tensor("bool", data, dims),
  };
}
