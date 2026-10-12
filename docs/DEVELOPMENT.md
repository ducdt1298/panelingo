# Development guide

This guide covers building Panelingo from source, the everyday commands, the project layout and the coding
conventions. Testing has its own page: [TESTING.md](TESTING.md). For how the parts fit together, read
[ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

| Tool                 | Version                   | Needed for                                                                                                                                                        |
| -------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js              | **≥ 24.19** (with npm 11) | Everything. Node runs the TypeScript build scripts and tests directly, using built-in type stripping, with no transpile step.                                     |
| Google Chrome        | **≥ 148**                 | Loading the extension (`minimum_chrome_version`) and E2E tests. 148 adds structured-clone messaging.                                                              |
| Network access       | huggingface.co            | `npm run fetch-models`, once per model version.                                                                                                                   |
| Python + Pillow      | Python 3.14, Pillow 12.3  | _Optional._ Regenerating test fixtures (`npm run fixtures`) and icons (`npm run icons`).                                                                          |
| Windows system fonts |                           | _Optional._ The fixture generator reads Malgun Gothic, Yu Gothic, Microsoft YaHei, Comic Sans MS, Impact and Arial from `C:/Windows/Fonts`, or from `--font-dir`. |

## Getting started

```sh
git clone https://github.com/ducdt1298/panelingo.git
cd panelingo
npm ci
npm run fetch-models   # downloads the detector models into .cache/models (about 52 MB)
npm run build          # writes the unpacked extension to dist/
```

`npm run fetch-models` downloads the detector from
[Hugging Face](https://huggingface.co/ogkalu/comic-text-and-bubble-detector) at pinned commits listed in
[`vendor/models.lock.json`](../vendor/models.lock.json). It streams each file to a `.part` file, checks the byte count
and SHA-256, and renames the file only on success. It then derives the WebGPU model locally by stripping invalid
`value_info` shape hints, and verifies the result against its pinned hash too. Run it again with `-- --verify` to
re-hash the cache. The build refuses to run if a shipped model is missing or does not match the lock.

Then load the extension:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/` folder.
3. After each rebuild, click the reload icon on the extension card. Content scripts already injected into open tabs
   detach, so reload those tabs too.

## Commands

| Command                           | What it does                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm run build`                   | Development build into `dist/`: linked sourcemaps, the debug page, `__DEV__ = true`, and the name suffix "(dev)".  |
| `npm run build:test`              | Test build used by E2E: like dev plus `__TEST__ = true`, open shadow roots, fixture hosts seeded, test hooks.      |
| `npm run build:prod`              | Production build: minified, no sourcemaps, no debug page, no `declarativeNetRequestFeedback` permission.           |
| `npm run package`                 | Production build into `release/dist`, then the store-ready `release/panelingo-<version>.zip` and its SHA-256.      |
| `npm run watch`                   | Development build that rebuilds on change, including HTML, CSS and assets.                                         |
| `npm run typecheck`               | Runs `tsc` for every TypeScript project: browser code, service worker, shared code, scripts, tools, tests and E2E. |
| `npm run lint` / `lint:fix`       | ESLint with type-aware rules.                                                                                      |
| `npm run format` / `format:check` | Prettier.                                                                                                          |
| `npm test`                        | Unit and integration tests (`node --test`).                                                                        |
| `npm run test:unit`               | Unit tests only.                                                                                                   |
| `npm run test:cov`                | Unit and integration tests with coverage. `src/shared/**` must stay at **≥ 85% line coverage**.                    |
| `npm run test:e2e`                | `build:test`, then end-to-end tests in a real Chrome (see [TESTING.md](TESTING.md#end-to-end-tests)).              |
| `npm run check`                   | `typecheck` + `lint` + `format:check` + `test:cov`. **Run before every pull request.**                             |
| `npm run check:full`              | `check` + `test:e2e`.                                                                                              |
| `npm run fetch-models`            | Downloads and verifies the detector models (see above).                                                            |
| `npm run mock-api`                | Starts the mock OpenAI-compatible server on `http://127.0.0.1:4925`.                                               |
| `npm run serve:fixtures`          | Starts the fixture reader (`http://127.0.0.1:8080`) and fixture CDN (`http://localhost:8081`).                     |
| `npm run fixtures`                | Regenerates the synthetic test images into `test/fixtures/generated/` (Python + Pillow).                           |
| `npm run test:fixtures`           | Unit tests of the fixture generator (Python).                                                                      |
| `npm run icons`                   | Redraws `assets/icons/*.png` (Python + Pillow). The icons are committed, so you rarely need this.                  |

### Build modes

`scripts/build.ts` bundles with esbuild (target `chrome148`) and generates `dist/manifest.json` from
[`src/manifest.ts`](../src/manifest.ts) and `dist/_locales/*/messages.json` from the UI catalogs.

| Output                 | Source                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| `dist/sw.js`           | `src/sw/main.ts` (ES module)                                       |
| `dist/engine/`         | `src/engine/main.ts` + `offscreen.html` (ES modules, code-split)   |
| `dist/content/main.js` | `src/content/main.ts` (IIFE; the build fails on top-level imports) |
| `dist/ui/`             | popup, options, side panel, plus the debug page outside prod       |
| `dist/models/`         | shipped models from `.cache/models/`                               |
| `dist/vendor/ort/`     | the single onnxruntime-web WASM binary                             |
| `dist/assets/`         | icons, the detector canary, fonts (latin + vietnamese subsets)     |
| `dist/LICENSES/`       | third-party license texts                                          |
| `dist/build-info.json` | build id, mode, ORT version and model hashes                       |

The build also checks the output. It fails on a missing icon, a model with the wrong size, extra ORT files,
`content_scripts` or COOP/COEP in the manifest, or a `dist/` larger than 85 MB.

## Trying it without a paid API

- **Mock server.** `npm run mock-api` starts a mock OpenAI-compatible server (`tools/mock-openai/`) on port 4925. It
  serves `GET /v1/models` and streaming `POST /v1/chat/completions` with scriptable scenarios: delays, chunking,
  failures before headers, dropped streams, missing, duplicate or garbage ids, refusals and empty answers. Use it to
  exercise error handling and the retry ladder without spending tokens. Point the options page at
  `http://127.0.0.1:4925/v1`. Control routes (`/__scenario`, `/__requests`, `/__reset`) let a test or a terminal
  change behavior at runtime.
- **Local model.** Ollama or LM Studio with a small vision model is free. It is slower and less accurate than hosted
  models. See [CONFIGURATION.md](CONFIGURATION.md#local-servers).
- **Fixture pages.** `npm run serve:fixtures` serves synthetic readers made from the generated fixtures: paged, webtoon,
  seam, srcset, WebP, protected (Referer-gated), cookie-gated, infinite scroll, SPA, canvas, CSP, iframe and
  prerender. The image CDN is a different origin on purpose. Development builds block private hosts like any other
  build, so add `127.0.0.1:8080` and `localhost:8081` to `privacy.devFixtureHosts` (test builds seed them for you).
  See [Editing advanced settings](CONFIGURATION.md#editing-advanced-settings).

## Debugging

- **Service worker.** `chrome://extensions` → Panelingo → _Inspect views: service worker_.
- **Offscreen engine.** While the engine runs, `engine/offscreen.html` also shows up under _Inspect views_. Its DevTools
  console holds the pipeline logs. Under **Application → IndexedDB → ctv** you can see the cache, including the `logs`
  store.
- **Content script.** Use the page's own DevTools and select the extension's context in the console's context picker.
  In test builds the overlay uses open shadow roots, so you can inspect it.
- **Log level.** Options → _Debug log_, or `debug.logLevel`. Development builds also print to the console.
- **Engine restarts.** The engine closes after `engine.idleCloseMin` minutes of inactivity. A new page or popup starts it
  again.

## Project layout

```
.
├── src/
│   ├── manifest.ts         # manifest + _locales generation
│   ├── sw/                 # service worker
│   ├── engine/             # offscreen engine (+ store/ for IndexedDB repositories)
│   ├── content/            # content script (+ overlay/)
│   ├── ui/                 # popup, options, sidepanel, debug, common/
│   ├── platform/           # chrome.* wrappers (messaging, ports, storage, db schema, log)
│   ├── shared/             # PURE: settings, protocol, wire, errors, url guard, languages, i18n/
│   │   └── core/           # PURE algorithms (detection post-processing → text fitting)
│   └── types/              # global declarations (__DEV__, __TEST__, __BUILD_ID__)
├── test/
│   ├── unit/               # mirrors src/ (content, core, engine, platform, shared, sw, ui, …)
│   ├── integration/        # translator vs mock server, fixture server, Node graphics port
│   ├── support/            # setup.ts (preload), chrome-fake.ts
│   └── fixtures/           # sentences/, sites/, sse/ (committed); generated/ (gitignored)
├── e2e/                    # Puppeteer tests against a real Chrome
├── tools/
│   ├── mock-openai/        # mock OpenAI-compatible server
│   ├── fixture-server/     # two-origin reader + CDN for fixtures
│   ├── fixtures/           # deterministic Python fixture generator
│   ├── scoring/            # detection/translation scoring helpers
│   └── gfx-node.ts         # @napi-rs/canvas graphics port for Node tests
├── scripts/                # build.ts, fetch-models.ts, typecheck.ts, make-icons.py
├── vendor/                 # models.lock.json, LICENSES/
├── assets/                 # icons/, canary/ (detector self-check)
└── docs/
```

## Coding conventions

**TypeScript, strict.** `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `verbatimModuleSyntax`,
`erasableSyntaxOnly` and `isolatedModules`. Each environment (browser, service worker, pure shared code, Node scripts,
tools, tests) has its own `tsconfig.json` with the right `lib` and `types`.

**Node-runnable sources.** Node executes `.ts` files by stripping types, so:

- Relative imports always name the file with its extension (`./settings.ts`). ESLint enforces this.
- Only erasable syntax is allowed: no `enum`, no `namespace`, no parameter properties, no decorators. Use union types
  and `as const` objects instead.
- Use `import type` for type-only imports (`@typescript-eslint/consistent-type-imports`).

**`src/shared/**` is pure.** It must behave identically in Node tests and every Chrome context. ESLint forbids browser
globals (`chrome`, `window`, `document`, `fetch`, `indexedDB`, `OffscreenCanvas`, …), Node globals (`process`,
`Buffer`, …) and imports from `node:*`, `platform/`, `engine/`, `content/`, `ui/` or `sw/`. Inject whatever the code
needs: a clock, a measure function, a graphics port.

**Messaging rules.** See [PROTOCOL.md](PROTOCOL.md). ESLint enforces two of them:

- **R1:** `chrome.*` event listeners must be plain, non-`async` functions, and one-shot messages are received only
  through `onMessageFor()` from `src/platform/messaging.ts`.
- **R3:** only `src/engine/main.ts` may listen to `runtime.onConnect`.

**Other lint rules.** `eqeqeq` (null comparisons excepted), no floating or misused promises, exhaustive `switch` over
unions, unused variables only with a `_` prefix, and no `innerHTML`/`outerHTML` in content scripts (build DOM nodes).

**Formatting.** Prettier with a print width of 110, double quotes, semicolons and trailing commas. Run
`npm run format` before committing. Line endings are LF in git and native on checkout (`.gitattributes`).

**Build-time constants.** Use the bare identifiers `__DEV__`, `__TEST__` and `__BUILD_ID__`. esbuild replaces them, so
dev- and test-only code disappears from production bundles. In Node tests, `test/support/setup.ts` defines them.

**Strings.** Every user-visible string lives in the UI catalogs in `src/shared/i18n/`. English (`en.ts`) is the
reference. Bundled catalogs must be complete, which the type checker and `test/unit/shared/i18n.test.ts` enforce. Only
catalogs registered at run time may be partial. See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-ui-language).

**Versioned formats.** When you change something persisted or exchanged (the IndexedDB schema, the settings layout,
messages, the prompt or output format, unit derivation, the erase algorithm), bump the matching constant in
`src/shared/versions.ts`, and add a migration where needed (`migrateSettings` for settings).

**Settings.** A new setting needs a default in `DEFAULT_SETTINGS`, a range in `LIMITS` for numbers, a migration test,
and a row in [CONFIGURATION.md](CONFIGURATION.md).

**Comments** explain _why_: the constraint, the measurement, the browser quirk. They do not restate the code.

## Updating third-party binaries

- **onnxruntime-web** is pinned exactly. The build ships only `ort-wasm-simd-threaded.asyncify.wasm` and fails if
  another ORT file appears. After an upgrade, run the E2E tests on a machine with a GPU to confirm that the WebGPU
  canary still passes.
- **Detector model.** Change `vendor/models.lock.json` (URL with a commit, byte size, SHA-256), run
  `npm run fetch-models`, regenerate the canary reference in `assets/canary/` if outputs change, and update
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and `vendor/LICENSES/`.
