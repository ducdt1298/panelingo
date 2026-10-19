// Size of onnxruntime-web's WebAssembly heap. ORT keeps every session (the detector, the offline recognizers and
// translation models) in one wasm32 memory created by its Emscripten glue (`new WebAssembly.Memory({ maximum:
// 65536 pages, shared })`, 4 GiB at most). The memory only grows: its byteLength is the high-water mark of the heap,
// which the offline engine logs and reports in its status (docs/OFFLINE-MODE.md, memory budget). ORT does not expose
// the memory, so the engine document records the memories it creates: installWasmHeapProbe() runs in main.ts before
// ORT is imported and wraps the WebAssembly.Memory constructor (behaviour unchanged; only growable memories are kept,
// as weak references).

const memories: Array<WeakRef<WebAssembly.Memory>> = [];
let installed = false;

/** Wraps WebAssembly.Memory once so the heaps created afterwards can be measured. */
export function installWasmHeapProbe(): void {
  if (installed || typeof WebAssembly === "undefined" || typeof WeakRef === "undefined") return;
  installed = true;
  const Native = WebAssembly.Memory;
  WebAssembly.Memory = new Proxy(Native, {
    construct(target, args: [WebAssembly.MemoryDescriptor], newTarget: new (...a: never[]) => object) {
      const memory = Reflect.construct<[WebAssembly.MemoryDescriptor], WebAssembly.Memory>(
        target,
        args,
        newTarget,
      );
      if ((args[0]?.maximum ?? 0) > (args[0]?.initial ?? 0)) memories.push(new WeakRef(memory));
      return memory;
    },
  });
}

/** Current byteLength of the largest recorded heap (0 before ORT starts, or without the probe). */
export function wasmHeapBytes(): number {
  let largest = 0;
  for (const ref of memories) {
    const memory = ref.deref();
    if (memory !== undefined) largest = Math.max(largest, memory.buffer.byteLength);
  }
  return largest;
}
