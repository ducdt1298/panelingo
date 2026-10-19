// onnxruntime-web's environment, shared by every ORT instance of the extension: the detector's and the offline
// recognizers' in the engine document, and the translation worker's (offline/mt-worker.ts). Kept free of other
// engine code so the worker bundle only pulls in ORT.

export const ORT_WASM_PATH = "vendor/ort/ort-wasm-simd-threaded.asyncify.wasm";

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

/**
 * The asyncify binary shipped in vendor/ort, one thread, no proxy, errors only. ORT's warnings (e.g. "Removing
 * initializer … not used by any node" for converted PaddleOCR models) are harmless graph-optimizer notes, but Chrome
 * lists every console warning of an extension on its Errors page.
 */
export function configureOrtEnv(env: OrtEnvLike, getURL: (path: string) => string): void {
  env.wasm.wasmPaths = { wasm: getURL(ORT_WASM_PATH) };
  env.wasm.numThreads = 1;
  env.wasm.proxy = false;
  env.logLevel = "error";
}
