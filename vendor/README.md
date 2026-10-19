# vendor/

Provenance of third-party binaries. **Binaries are not committed.** `npm run fetch-models` downloads the detector models
from Hugging Face into `.cache/models/`. It checks each file's size and SHA-256 against `models.lock.json`, and it
derives the WebGPU model locally. `npm run build` then copies the shipped models and the single onnxruntime-web WASM
binary into `dist/`.

| File                       | Source                                                                                       | Pin                                    | License    | Shipped                |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- | ---------- | ---------------------- |
| `models.lock.json`         | URLs, sizes and SHA-256 values for every model file                                          | commit + sha256                        | n/a        | no                     |
| `detector-v4-s.onnx`       | huggingface.co/ogkalu/comic-text-and-bubble-detector (fp32)                                  | `5084e7d2…` / sha256 `841da5c6…`       | Apache-2.0 | no (input of the next) |
| `detector-v4-s.fixed.onnx` | derived locally from `detector-v4-s.onnx` by removing `value_info` shape hints (WebGPU path) | sha256 `4a01e0bf…`                     | Apache-2.0 | `dist/models/`         |
| `detector-v4-s_int8.onnx`  | same repository (int8, WebAssembly fallback), unmodified                                     | `16e8a622…` / sha256 `5fe9e4f5…`       | Apache-2.0 | `dist/models/`         |
| ORT WASM                   | `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm`                     | onnxruntime-web 1.30.0 (exact version) | MIT        | `dist/vendor/ort/`     |
| Fonts                      | `@fontsource/{patrick-hand,mali,bangers}` 5.3.0, latin + vietnamese subsets                  | package version                        | OFL-1.1    | `dist/assets/fonts/`   |

The build stops with "Run: npm run fetch-models" if a shipped model is missing or does not match the lock.
`npm run fetch-models -- --verify` re-hashes the cached files.

## Offline mode models (not shipped)

The `offline` group of `models.lock.json` pins the models of the experimental [offline mode](../docs/OFFLINE-MODE.md):
PP-OCRv5 recognizers (PaddlePaddle's official ONNX exports, Apache-2.0), Opus-MT translation models and NLLB-200
distilled 600M (Xenova's ONNX exports; Apache-2.0 or CC-BY-4.0, NLLB-200 CC-BY-NC-4.0). Each entry names its Hugging
Face repository, the commit, the path, the size and the SHA-256; the engine downloads
`https://huggingface.co/<repo>/resolve/<revision>/<path>` on first use, checks size and SHA-256 and keeps the file in
Cache Storage. The build only writes this catalog into `build-info.json`, never the files.

`npm run fetch-models -- --offline` (about 2.1 GB, or `--offline=ocr-korean,opus-mt-ko-en` for some models) caches
them in `.cache/offline-models/<repo>/<revision>/<path>` for the offline E2E test and `tools/offline-eval`, which serve
them to a test build from a local mirror. The default `npm run fetch-models` never downloads them.

`LICENSES/` holds the license and notice texts that the build copies to `dist/LICENSES/`. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the full list.
