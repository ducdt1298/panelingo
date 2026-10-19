# Third-party notices

Panelingo is released under the [MIT License](LICENSE). It bundles, or is built with, the third-party
components listed below. Each one keeps its own license.

## Components shipped in the extension

The build (`npm run build` / `npm run build:prod`) copies these components into `dist/`. It also copies their license
texts into `dist/LICENSES/`, so every packaged extension carries them.

| Component                                                                                                                                                              | Version / pin                                                                       | License    | License text in `dist/LICENSES/`                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| [comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector) by ogkalu, ONNX exports (**modified**, see below)                       | Hugging Face commits pinned in [`vendor/models.lock.json`](vendor/models.lock.json) | Apache-2.0 | `Apache-2.0.txt`, `NOTICE-comic-text-and-bubble-detector.txt` |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) (Microsoft): JavaScript bundle and `ort-wasm-simd-threaded.asyncify.wasm`                                  | 1.30.0                                                                              | MIT        | `MIT-onnxruntime-web.txt`                                     |
| [idb](https://github.com/jakearchibald/idb) (Jake Archibald)                                                                                                           | 8.0.4                                                                               | ISC        | `ISC-idb.txt`                                                 |
| [Patrick Hand](https://fonts.google.com/specimen/Patrick+Hand) font (Patrick Wagesreiter), via [`@fontsource/patrick-hand`](https://fontsource.org/fonts/patrick-hand) | 5.3.0 (latin and vietnamese subsets, weight 400)                                    | OFL-1.1    | `OFL-patrick-hand.txt`                                        |
| [Mali](https://fonts.google.com/specimen/Mali) font (The Mali Project Authors), via [`@fontsource/mali`](https://fontsource.org/fonts/mali)                            | 5.3.0 (latin and vietnamese subsets, weights 400 and 700)                           | OFL-1.1    | `OFL-mali.txt`                                                |
| [Bangers](https://fonts.google.com/specimen/Bangers) font (The Bangers Project Authors), via [`@fontsource/bangers`](https://fontsource.org/fonts/bangers)             | 5.3.0 (latin and vietnamese subsets, weight 400)                                    | OFL-1.1    | `OFL-bangers.txt`                                             |

### Detector model: modification notice (Apache-2.0, section 4(b))

The model files are not committed to this repository. `npm run fetch-models` downloads them from Hugging Face at
pinned commits and checks each file's size and SHA-256 against `vendor/models.lock.json`.

- `detector-v4-s_int8.onnx` is shipped **unmodified**. The extension uses it on the WebAssembly (CPU) path.
- `detector-v4-s.fixed.onnx` is **derived** from the upstream `detector-v4-s.onnx`. The extension uses it on the WebGPU
  path. The derived file is produced by `scripts/lib/onnx-strip.ts`, which removes every `GraphProto.value_info` entry
  (these are optional shape hints). Three of those hints declare the wrong tensor rank, and onnxruntime 1.30 refuses to
  load a model that contains them. Nodes, weights, inputs and outputs are unchanged. The result is verified against a
  pinned SHA-256.

The upstream repository ships no LICENSE or NOTICE file. The license is the one declared on its Hugging Face model
card. [`vendor/LICENSES/NOTICE-comic-text-and-bubble-detector.txt`](vendor/LICENSES/NOTICE-comic-text-and-bubble-detector.txt)
records the provenance and the modification, and it is shipped with every build.

### Fonts

The fonts are licensed under the SIL Open Font License 1.1. They are shipped as unmodified WOFF2 files from
Fontsource and are used only to draw translated lettering. They are not sold on their own.

## Models downloaded by offline mode (experimental, not shipped)

[Offline mode](docs/OFFLINE-MODE.md) is off by default. When a user turns it on, the extension downloads the models
below from Hugging Face on first use, at the commits pinned in the `offline` group of
[`vendor/models.lock.json`](vendor/models.lock.json), and checks each file's size and SHA-256 before using it. They
are never bundled with the extension, never committed to this repository, and used unmodified.

| Models                                                                                                                                                                                                                                                                                         | Used for                                                                       | License          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------- |
| [PP-OCRv5 mobile recognition](https://github.com/PaddlePaddle/PaddleOCR) (PaddlePaddle), official ONNX exports: `PaddlePaddle/PP-OCRv5_mobile_rec_onnx`, `korean_PP-OCRv5_mobile_rec_onnx`, `latin_PP-OCRv5_mobile_rec_onnx`, `en_PP-OCRv5_mobile_rec_onnx`, with their character dictionaries | Text recognition (Chinese and Japanese, Korean, Latin, English)                | Apache-2.0       |
| [Opus-MT](https://github.com/Helsinki-NLP/Opus-MT) (Helsinki-NLP, University of Helsinki) as ONNX exports by Xenova: `opus-mt-ko-en`, `ja-en`, `es-en`, `en-vi`, `en-es`, `en-fr`, `en-it`, `en-id`                                                                                            | Translation, one model per direction                                           | Apache-2.0       |
| Opus-MT `opus-mt-zh-en` and `opus-mt-en-de` (Helsinki-NLP), ONNX exports by Xenova                                                                                                                                                                                                             | Translation                                                                    | CC-BY-4.0        |
| [NLLB-200 distilled 600M](https://huggingface.co/facebook/nllb-200-distilled-600M) (Meta AI), ONNX export by Xenova                                                                                                                                                                            | Translation between any two of its 200 languages (optional, chosen in Options) | **CC-BY-NC-4.0** |

NLLB-200 is licensed for **non-commercial use only** (CC-BY-NC-4.0); the options page says so where it is chosen.
Opus-MT models under CC-BY-4.0 require attribution: "Opus-MT models by Helsinki-NLP (Jörg Tiedemann, Santhosh
Thottingal), trained on OPUS data". PaddleOCR is Copyright (c) PaddlePaddle Authors.

## Development tools (not shipped)

These packages are used only to build, lint and test the project. None of their code ends up in `dist/`.

| Package                                                                                                                                | Version          | License    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------- |
| [esbuild](https://github.com/evanw/esbuild)                                                                                            | 0.28.2           | MIT        |
| [TypeScript](https://github.com/microsoft/TypeScript)                                                                                  | 6.0.3            | Apache-2.0 |
| [ESLint](https://github.com/eslint/eslint) and `@eslint/js`                                                                            | 10.12.0 / 10.0.1 | MIT        |
| [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint)                                                            | 8.71.1           | MIT        |
| [Prettier](https://github.com/prettier/prettier)                                                                                       | 3.9.9            | MIT        |
| [puppeteer-core](https://github.com/puppeteer/puppeteer)                                                                               | 25.13.0          | Apache-2.0 |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas)                                                                              | 1.0.10           | MIT        |
| [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB)                                                                          | 6.2.5            | Apache-2.0 |
| [@types/chrome](https://github.com/DefinitelyTyped/DefinitelyTyped), [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 0.3.4 / 24.19.1  | MIT        |

The optional fixture generator (`tools/fixtures/`) uses [Pillow](https://python-pillow.github.io/) (MIT-CMU). It
reads the system fonts that are already installed and never copies them into the repository.

## Prior art

Some of the detection, erasing, layout and lettering techniques follow the documented behavior and published
parameters of open-source comic translation projects, mainly
[comic-translate](https://github.com/ogkalu2/comic-translate),
[manga-image-translator](https://github.com/zyddnys/manga-image-translator) and
[BallonsTranslator](https://github.com/dmMaze/BallonsTranslator). We wrote our own implementations; no source code from
these projects was copied. Panelingo is an independent project and is not affiliated with any of them.
