# Configuration

Everything Panelingo needs to know is stored locally in `chrome.storage.local`. The source of truth for names,
defaults and limits is [`src/shared/settings.ts`](../src/shared/settings.ts) (`DEFAULT_SETTINGS`, `DEFAULT_SITE`,
`LIMITS`). This page mirrors it. If they ever disagree, the code wins, so please open an issue.

- [Quick setup](#quick-setup)
- [Providers](#providers)
- [Settings reference](#settings-reference)
- [Per-site settings](#per-site-settings)
- [Editing advanced settings](#editing-advanced-settings)

## Quick setup

1. Open the extension's **Options** page (right-click the toolbar icon → _Options_, or the link in the popup).
2. **AI endpoint.** Pick a preset or type a base URL. Enter an API key if the provider needs one, choose a model that
   accepts images, then click **Test connection**. The test calls `GET {baseUrl}/models` and fills the model
   suggestions from the result. It does not save anything; click **Save** when the test passes.
3. **Languages.** Choose the interface language and the language to translate into. Both default to your browser
   language.
4. **Turn translation on for a site.** On a comic page, open the popup and click **Translate this site**. The first time,
   the extension shows what will be sent to your endpoint and asks for confirmation.

The options page exposes the endpoint, model, parallel requests, both languages, the site list with a per-site editor,
a cache reset, settings backup and restore, the log level and a collapsed **Advanced settings** section with every other
setting that is in effect. See [Editing settings](#editing-advanced-settings).

## Providers

Panelingo works with **any endpoint that implements the OpenAI Chat Completions API with streaming and image
input**. Each request is `POST {baseUrl}/chat/completions` with `stream: true`, a system message and one user message.
The user message holds the text plus one `image_url` given as a base64 `data:image/jpeg` URL. The API key, if any, is
sent as `Authorization: Bearer <key>`.

The model **must accept images**. A text-only model will fail or return nothing useful.

| Provider                              | Base URL                                                  | Example vision models                                                           | Key      | Notes                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI _(preset)_                     | `https://api.openai.com/v1`                               | `gpt-4o-mini` (default), `gpt-4.1-mini`, `gpt-4o`, GPT-5 family                 | Yes      | GPT-5 models get a larger box budget (20 regions per request).                                                                                                         |
| OpenRouter _(preset)_                 | `https://openrouter.ai/api/v1`                            | `openai/gpt-4o-mini`, `google/gemini-2.5-flash`, `qwen/qwen2.5-vl-72b-instruct` | Yes      | Use a model whose input modalities include images.                                                                                                                     |
| Google Gemini, OpenAI mode _(preset)_ | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash`, `gemini-2.5-pro`                                            | Yes      | Key from Google AI Studio. Gemini models may use the taller 2048×1152 composite.                                                                                       |
| Azure OpenAI (v1 API)                 | `https://YOUR-RESOURCE.openai.azure.com/openai/v1`        | your deployment name                                                            | Yes      | Base URLs with a query string (`?api-version=`) are rejected. For gateways that only accept an `api-key` header, put a proxy such as LiteLLM in front.                 |
| Ollama _(preset, local)_              | `http://127.0.0.1:11434/v1`                               | `qwen2.5vl:7b` (default), `gemma3`, `llama3.2-vision`, `minicpm-v`              | No       | See [Local servers](#local-servers). If Ollama answers 403, allow the extension origin: `OLLAMA_ORIGINS=chrome-extension://*`.                                         |
| LM Studio _(preset, local)_           | `http://127.0.0.1:1234/v1`                                | any loaded vision model (for example Qwen2.5-VL, Gemma 3)                       | No       | Start the server in LM Studio's Developer tab and copy the model identifier.                                                                                           |
| vLLM _(preset, local)_                | `http://127.0.0.1:8000/v1`                                | `Qwen/Qwen2.5-VL-7B-Instruct`                                                   | Optional | `vllm serve <model>`. Pass `--api-key` to require a key.                                                                                                               |
| LiteLLM proxy (local or hosted)       | `http://127.0.0.1:4000/v1`                                | any vision model you route                                                      | Optional | Useful to put many providers or custom auth headers behind one OpenAI-compatible URL.                                                                                  |
| Other OpenAI-compatible servers       | the server's `/v1` URL                                    | any vision model                                                                | Varies   | Requirements: `/chat/completions` with SSE streaming and `image_url` content parts. A `/models` endpoint is only needed for **Test connection** and model suggestions. |

**Tips**

- A bare origin such as `http://127.0.0.1:11434` is normalized to `http://127.0.0.1:11434/v1`. Trailing slashes are
  removed. URLs with credentials, a query string or a fragment are refused, and so is the bind address `0.0.0.0`.
- Larger hosted models follow the line-based output format most reliably. Small local models (around 7B) work, but
  they miss or merge regions more often. The [retry ladder](ARCHITECTURE.md#12-retry-ladder) recovers what it can.
- The model id selects a composite profile (`src/shared/core/model-profile.ts`). Ids matching `gpt-5`, `gemini`,
  `claude`, `4o`/`gpt-4.1` get tuned profiles. Anything else uses a conservative default of 12 regions per request on a
  2048×768 canvas.
- Costs depend on your provider. Each request carries one JPEG composite, usually 2048×768 and at most
  `translate.requestBodyCapMb` MB, plus a few thousand characters of instructions.

### Local servers

Requests come from the extension's offscreen document, which has `<all_urls>` host permission. That means:

- **No CORS setup is needed.** Extension fetches with host permission are not subject to CORS. The request still
  carries an `Origin: chrome-extension://<id>` header, and some servers check it (see the Ollama note above).
- **Loopback is allowed through the SSRF guard.** Image fetches to private addresses are blocked, but the configured AI
  endpoint is explicitly allowed. `http://127.0.0.1:…` and `http://localhost:…` therefore work. Prefer `127.0.0.1` over
  a LAN address.
- **Local Network Access (LNA).** Chrome's LNA restrictions currently do not apply to extensions that hold the matching
  host permission. If a future Chrome version blocks the request anyway, the popup and options page report a Local Network Access
  error (`api.lna_blocked`). To fix it,
  open `chrome://extensions` → Panelingo → **Details** → **Site settings**, set **Local network access** (shown
  as _Apps on device_ for loopback in newer versions) to **Allow**, then reload the extension.

## Settings reference

Defaults and inclusive limits come straight from `DEFAULT_SETTINGS` and `LIMITS`. Values outside a limit are
**clamped** when settings are read (`migrateSettings`). Unknown keys and values of the wrong type are dropped.

Status column:

- **UI**: editable on the options page (the basic sections, the per-site **Settings** editor or the collapsed
  **Advanced settings** section) or in the popup.
- **Advanced**: in effect, but only editable by hand (development and test builds only).
- **Reserved**: stored, but not used yet; it exists for a [planned feature](ROADMAP.md).

### `api`: AI endpoint

| Setting                  | Default                     | Limits        | Status | Description                                                                                                                                                                                                          |
| ------------------------ | --------------------------- | ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.baseUrl`            | `https://api.openai.com/v1` | http(s) URL   | UI     | Base URL including the version path. A bare origin gets `/v1`.                                                                                                                                                       |
| `api.apiKey`             | `""`                        |               | UI     | Sent as `Authorization: Bearer <key>` when not empty. Stored locally in plain text (see [PRIVACY.md](PRIVACY.md)).                                                                                                   |
| `api.model`              | `gpt-4o-mini`               | no whitespace | UI     | Model id sent with every request. It must accept image input.                                                                                                                                                        |
| `api.temperature`        | `0.2`                       | 0–2 or `null` | UI     | Sampling temperature. `null` omits the field and leaves the provider default. A model that rejects it (some reasoning models take only their default) is asked again at once without it, and gets none from then on. |
| `api.concurrency`        | `2`                         | 1–4           | UI     | Normal request lanes ("Parallel translation requests").                                                                                                                                                              |
| `api.urgentLane`         | `true`                      |               | UI     | Adds one extra lane reserved for images currently on screen.                                                                                                                                                         |
| `api.maxInFlight`        | `4`                         | 1–4           | UI     | Hard cap on requests in flight, urgent lane included. Never lower than `concurrency`. Chrome allows 6 connections per host.                                                                                          |
| `api.firstByteTimeoutMs` | `180000`                    | 10000–900000  | UI     | Abort when no response byte arrives within this time.                                                                                                                                                                |
| `api.idleTimeoutMs`      | `60000`                     | 10000–300000  | UI     | Abort when the stream stalls for this long after the first byte.                                                                                                                                                     |
| `api.totalTimeoutMs`     | `600000`                    | 60000–1200000 | UI     | Abort any request after this long.                                                                                                                                                                                   |
| `api.healthTimeoutMs`    | `5000`                      | 500–30000     | UI     | Timeout of `GET /models` health checks and **Test connection**.                                                                                                                                                      |

### `ui` and `translate`: languages and requests

| Setting                                  | Default     | Limits                 | Status   | Description                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.locale`                              | `"auto"`    | locale code            | UI       | Extension interface language. `auto` follows the browser. Supported codes are the catalogs in `src/shared/i18n/`.                                                                                                                                                                                 |
| `translate.targetLang`                   | `"auto"`    | target code            | UI       | Language to translate into. `auto` uses the browser languages and falls back to English. Codes: `en`, `vi`, `es`, `pt-br`, `fr`, `de`, `it`, `id`, `tl`, `pl`, `tr`, `ja`, `zh-cn`, `zh-tw`, `ko` (`src/shared/languages.ts`).                                                                    |
| `translate.boxBudget`                    | `null`      | 4–20 or `null`         | UI       | Regions per request. `null` uses the model profile (12, 16 or 20).                                                                                                                                                                                                                                |
| `translate.packWaitMs`                   | `500`       | 0–5000                 | UI       | How long the text of one image waits for the next images of the same page so they share one request (ms). A request also leaves as soon as it is full or no other image is still being detected. `0` sends each image on its own.                                                                 |
| `translate.urgentPackMax`                | `8`         | 0–20                   | UI       | The first request of an image on screen holds at most this many regions, so its balloons appear sooner. `0` = no separate cap.                                                                                                                                                                    |
| `translate.jpegQuality`                  | `0.9`       | 0.5–1                  | UI       | JPEG quality of the composite.                                                                                                                                                                                                                                                                    |
| `translate.requestBodyCapMb`             | `4`         | 1–40                   | UI       | Maximum request body size. Larger composites are re-encoded at quality 0.8, then split.                                                                                                                                                                                                           |
| `translate.promptCharCap`                | `16000`     | 2000–200000            | UI       | Cap on the text part of a request. Context is trimmed first.                                                                                                                                                                                                                                      |
| `translate.maxLadderRequestsPerPack`     | `4`         | 0–8                    | UI       | Extra requests per pack to recover missing regions (re-ask, splits).                                                                                                                                                                                                                              |
| `translate.maxHttpRetriesPerRequest`     | `2`         | 0–5                    | UI       | Retries per request for transient HTTP and network errors.                                                                                                                                                                                                                                        |
| `translate.maxAutoPassesPerUnitPer10Min` | `2`         | 0–5                    | Reserved | The engine currently applies a built-in limit of 2 automatic passes per region per 10 minutes.                                                                                                                                                                                                    |
| `translate.splitOnRefusal`               | `false`     |                        | UI       | When the model refuses a pack, split it and try the halves instead of giving up.                                                                                                                                                                                                                  |
| `translate.engine`                       | `"api"`     | `api`, `offline`       | UI       | Who reads and translates. `api`: the configured OpenAI-compatible vision model. `offline` (experimental): on-device OCR and machine translation models, downloaded once from Hugging Face; no AI endpoint is contacted and the queue never waits for one. See [OFFLINE-MODE.md](OFFLINE-MODE.md). |
| `translate.offlineModel`                 | `"opus-mt"` | `opus-mt`, `nllb-600m` | UI       | Offline translation model. `opus-mt`: one small Opus-MT model per direction, through English when no direct model exists. `nllb-600m`: NLLB-200 distilled 600M, any pair, about 910 MB, CC-BY-NC-4.0 (non-commercial).                                                                            |

### `detector`: on-device text detection

| Setting                      | Default  | Limits                   | Status | Description                                                                                    |
| ---------------------------- | -------- | ------------------------ | ------ | ---------------------------------------------------------------------------------------------- |
| `detector.backend`           | `"auto"` | `auto`, `webgpu`, `wasm` | UI     | `auto` uses WebGPU when the canary check passes, otherwise WebAssembly (int8).                 |
| `detector.scoreMin`          | `0.3`    | 0.1–0.9                  | UI     | Minimum detection score. Applied when regions are built, so changing it needs no re-detection. |
| `detector.sliceTriggerRatio` | `3.5`    | 1.5–10                   | UI     | Slice an image or strip whose long/short side ratio exceeds this.                              |
| `detector.sliceHeightRatio`  | `3.0`    | 1–6                      | UI     | Slice length as a multiple of the short side.                                                  |
| `detector.sliceOverlap`      | `0.2`    | 0.05–0.5                 | UI     | Overlap between slices, as a fraction of the slice.                                            |
| `detector.sliceOverlapMinPx` | `200`    | 0–1000                   | UI     | Minimum overlap in pixels.                                                                     |
| `detector.quietRows`         | `false`  |                          | UI     | Snap slice cuts to rows without ink. Experimental, off by default.                             |

### `engine`: offscreen engine lifetime

| Setting                     | Default | Limits | Status | Description                                                                                       |
| --------------------------- | ------- | ------ | ------ | ------------------------------------------------------------------------------------------------- |
| `engine.idleCloseMin`       | `10`    | 2–60   | UI     | Close the offscreen engine after this many minutes without pages or work (frees WASM/GPU memory). |
| `engine.detectorReleaseMin` | `5`     | 1–60   | UI     | Release the detector session after this many minutes without a detection.                         |
| `engine.portIdleMin`        | `5`     | 1–30   | UI     | A page disconnects from the engine after this many idle minutes.                                  |

### `discovery`: finding images on the page

| Setting                              | Default | Limits  | Status | Description                                                                                                                                                                                                                          |
| ------------------------------------ | ------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `discovery.minNaturalSide`           | `300`   | 50–2000 | UI     | Ignore images whose natural short side is smaller (icons, avatars, ads).                                                                                                                                                             |
| `discovery.minDisplayedSide`         | `150`   | 50–2000 | UI     | Ignore images displayed smaller than this (CSS px).                                                                                                                                                                                  |
| `discovery.secondsPerScreenDefault`  | `4`     | 1–30    | UI     | Initial reading-speed estimate before it is measured.                                                                                                                                                                                |
| `discovery.fetchPerHostConcurrency`  | `2`     | 1–6     | UI     | Parallel image fetches per image host.                                                                                                                                                                                               |
| `discovery.prefetchSpacingMs`        | `150`   | 0–5000  | UI     | Minimum spacing between image fetches to the same host.                                                                                                                                                                              |
| `discovery.scrollDebounceMs`         | `250`   | 50–2000 | UI     | Debounce for scroll-driven re-prioritization.                                                                                                                                                                                        |
| `discovery.mutationDebounceMs`       | `400`   | 50–5000 | UI     | Debounce for DOM mutations (lazy loaders, SPA readers).                                                                                                                                                                              |
| `discovery.stripGapPx`               | `4`     | 0–32    | UI     | Maximum gap between images that still form one webtoon strip.                                                                                                                                                                        |
| `discovery.translateHiddenTabs`      | `false` |         | UI     | `false`: automatic mode waits until the tab has been visible. `true`: background tabs start right away.                                                                                                                              |
| `discovery.lookaheadMinScreens`      | `2`     | 1–10    | UI     | Translate window for lazy images the page has not loaded yet (tier B), in screens below the view. The engine sizes it from your reading speed and the measured request time (2 × latency ÷ seconds per screen), within these bounds. |
| `discovery.lookaheadMaxScreens`      | `10`    | 2–30    | UI     | Upper bound of the translate window.                                                                                                                                                                                                 |
| `discovery.lookaheadMaxScreensStrip` | `15`    | 2–30    | UI     | Upper bound of the translate window on webtoon strips.                                                                                                                                                                               |
| `discovery.detectAheadMinScreens`    | `10`    | 2–60    | UI     | Lazy images this far below the view are fetched and detected ahead (nothing is uploaded): 60 s of reading, never less than the translate window, within these bounds.                                                                |
| `discovery.detectAheadMaxScreens`    | `45`    | 2–120   | UI     | Upper bound of the detect horizon.                                                                                                                                                                                                   |
| `discovery.detectMaxImages`          | `25`    | 1–100   | UI     | Images ahead of the reader (on screen and below, loaded or not) the detect horizon may cover.                                                                                                                                        |

### `render`: overlay lettering

| Setting                    | Default          | Limits                 | Status | Description                                                                                                        |
| -------------------------- | ---------------- | ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `render.minFontPx`         | `11`             | 8–16                   | UI     | Smallest lettering size (CSS px) before the text is shortened with "…".                                            |
| `render.maxFontPx`         | `64`             | 16–120                 | UI     | Largest lettering size. Lettering is also capped near the original glyph height.                                   |
| `render.showDoneBadge`     | `false`          |                        | UI     | Show a small "done" badge on translated images.                                                                    |
| `render.font`              | `"patrick-hand"` | `patrick-hand`, `mali` | UI     | Dialogue and thought font: Patrick Hand or Mali. Captions use Mali, signs Mali bold, SFX Bangers.                  |
| `render.verticalText`      | `"auto"`         | `auto`, `never`        | UI     | `auto`: translations into Japanese or Traditional Chinese are lettered top to bottom in vertical balloons.         |
| `render.eraseSfx`          | `false`          |                        | UI     | Erase SFX that have a clean erase patch and letter them in place, instead of labeling them.                        |
| `render.sfxLabels`         | `true`           |                        | UI     | Label translated SFX with a small pill. Off: SFX that are not erased stay untouched.                               |
| `render.peekKey`           | `"Backquote"`    | key code or `""`       | UI     | Hold this key (a `KeyboardEvent.code`) to hide the overlay; `""` turns it off.                                     |
| `render.peekWithAlt`       | `false`          |                        | UI     | Also peek while Alt alone is held.                                                                                 |
| `render.popupWithAltClick` | `true`           |                        | UI     | Alt+click on a translated bubble opens its popup (original text, edit, translate again). A long press always does. |

### `memory`: series memory

Series memory keeps names and terms consistent across a series: a glossary (yours plus terms the AI learned), the
earlier lines of the chapter and a running story summary go with every request (see
[ARCHITECTURE.md](ARCHITECTURE.md#series-memory)). The glossary and the per-series settings are edited in the side
panel's Glossary view.

| Setting                   | Default | Limits | Status | Description                                                                                                                                                  |
| ------------------------- | ------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory.enabled`          | `true`  |        | UI     | Series memory on or off. Off: no glossary, history or summary in requests, and nothing is learned from the answers.                                          |
| `memory.glossaryInPrompt` | `60`    | 0–200  | UI     | Glossary entries sent with each request: manual first, then confirmed, then learned. Suggestions are never sent.                                             |
| `memory.termMinSightings` | `2`     | 1–10   | UI     | Different requests that must name a term (`@term`) before the suggestion becomes a learned entry that is sent.                                               |
| `memory.historyMaxLines`  | `20`    | 0–60   | UI     | Earlier lines of the chapter sent as context (page order, then reading order). 0 sends none.                                                                 |
| `memory.historyMaxTokens` | `700`   | 0–4000 | UI     | Token budget for those lines; the oldest go first.                                                                                                           |
| `memory.summaryMaxWords`  | `60`    | 0–200  | UI     | Length of the running story summary the AI writes (`@sum`) and gets back. 0 turns summaries off.                                                             |
| `memory.warmUp`           | `true`  |        | UI     | While a series has no memory yet, its first request goes alone (at most 60 s) and the next ones start from what it reported: names, forms of address, lines. |

### `cache`: local caches

| Setting                    | Default | Limits  | Status   | Description                                                                                                   |
| -------------------------- | ------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `cache.translationTtlDays` | `30`    | 0–3650  | UI       | AI translations unused for this many days are deleted by the daily retention pass. Manual edits never expire. |
| `cache.encodedBytesLruMb`  | `96`    | 16–1024 | UI       | In-memory cache of downloaded image bytes in the engine.                                                      |
| `cache.patchCacheMb`       | `256`   | 16–4096 | Reserved | Size cap for stored erase patches.                                                                            |
| `cache.contentPatchLruMb`  | `64`    | 8–512   | Reserved | Page-side cache of decoded patches.                                                                           |
| `cache.decodedBitmapsMax`  | `3`     | 1–8     | Reserved | Decoded bitmaps kept at once (bitmaps are currently closed as soon as possible).                              |
| `cache.decodedBitmapsMb`   | `320`   | 64–2048 | Reserved | Memory budget for decoded bitmaps.                                                                            |

### `privacy`

| Setting                      | Default             | Limits           | Status   | Description                                                                                                         |
| ---------------------------- | ------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `privacy.ackUploadNoticeAt`  | `null`              | timestamp        | UI       | When you accepted the notice about what is sent. Nothing is uploaded while it is `null`.                            |
| `privacy.maxImageBytes`      | `33554432` (32 MiB) | 1 MiB–128 MiB    | UI       | Larger images are skipped.                                                                                          |
| `privacy.maxImagePixels`     | `64000000`          | 1 M–200 M        | UI       | Images with more pixels are skipped. The header is checked before decoding.                                         |
| `privacy.keepSentComposites` | `0`                 | 0–100            | Reserved | Keep the last N composites sent, for inspection.                                                                    |
| `privacy.devFixtureHosts`    | `[]`                | `host:port` list | Advanced | **Development and test builds only.** Local fixture hosts exempt from the SSRF guard. Ignored by production builds. |

### `debug`

| Setting                     | Default  | Limits                           | Status   | Description                                                                                                                                                                                                                                                   |
| --------------------------- | -------- | -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug.logLevel`            | `"info"` | `debug`, `info`, `warn`, `error` | UI       | Minimum level written to the log.                                                                                                                                                                                                                             |
| `debug.logCapacity`         | `5000`   | 100–100000                       | UI       | Entries kept in the engine's IndexedDB log ring buffer.                                                                                                                                                                                                       |
| `debug.offlineModelBaseUrl` | `""`     | http(s) URL or empty             | Advanced | **Development and test builds only.** Downloads offline models from `<base>/<repo>/resolve/<revision>/<path>` (a local mirror of `.cache/offline-models`) instead of Hugging Face, and lets that origin through the SSRF guard. Ignored by production builds. |

### Other keys

| Setting         | Default | Status   | Description                                                  |
| --------------- | ------- | -------- | ------------------------------------------------------------ |
| `schemaVersion` | `2`     | Internal | Settings layout version. Older layouts are migrated on read. |
| `enabled`       | `true`  | Reserved | Global on/off switch.                                        |

## Per-site settings

Each site is stored as `site:<origin>`, for example `site:https://reader.example.com`. A site exists once you have
turned it on or off from the popup or the options page.

| Setting             | Default  | Values                                        | Status   | Description                                                                                                                                                |
| ------------------- | -------- | --------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | `false`  |                                               | UI       | Translate on this site. Requires the privacy notice to be accepted.                                                                                        |
| `mode`              | `"auto"` | `auto`, `manual`                              | UI       | `auto`: translate while you scroll. `manual`: only on request (hover button, context menu, Alt+Shift+U).                                                   |
| `includeSubdomains` | `false`  |                                               | UI       | Also run on every subdomain of the origin.                                                                                                                 |
| `extraFrameOrigins` | `[]`     | origins                                       | UI       | Also run inside reader iframes served from these origins.                                                                                                  |
| `credentials`       | `"omit"` | `omit`, `include`                             | UI       | Send cookies with the engine's image requests. Only needed for hosts that gate images behind a login.                                                      |
| `referer`           | `"auto"` | `auto`, `page-url`, `origin`                  | UI       | `auto`: first follow the page's referrer policy, then on 403 retry with the full page URL and no `Origin`. `page-url` and `origin` always send that value. |
| `sourceLang`        | `"auto"` | `auto`, `ja`, `ko`, `zh`, `en`, `es`, `other` | UI       | Source language hint. Picks the language-specific prompt rules and the crop scale.                                                                         |
| `layout`            | `"auto"` | `auto`, `webtoon`, `paged-rtl`, `paged-ltr`   | UI       | Reading direction and layout. `auto` infers it per image.                                                                                                  |
| `prefetchAhead`     | `true`   |                                               | UI       | Automatic mode: detect lazy images below the view before the page loads them, and translate the ones inside the translate window (`discovery.lookahead*`). |
| `addedAt`           | now      | timestamp                                     | Internal | When the site entry was created.                                                                                                                           |

## Editing advanced settings

Everything marked **UI** above is on the options page:

- **Advanced settings** (the collapsed section at the bottom) lists every other setting that is in effect, grouped by
  section, with its default and allowed range. A change is saved when you leave the field and is clamped like a
  stored value; the row then says which value was saved. **Reset** puts one setting back to its default, and
  **Reset all advanced settings** does it for the whole section. Timeouts are shown in seconds, image limits in MiB
  and megapixels.
- **Sites → Settings** opens a site's editor: layout and reading direction, source language, Referer policy,
  cookies, subdomains, preparing images ahead and reader frames from other origins (one origin per line). Site changes take effect through
  the service worker, which re-registers the content script right away.
- **Back up and restore** exports the settings and the site list as a JSON file
  (`{ "format": "panelingo-settings", "version": 1, "settings": …, "sites": … }`). The API key is included only when
  you tick **Include the API key**; the privacy confirmation and the development fixture hosts are never exported.
  An import is validated with the same migration as stored values (unknown keys dropped, numbers clamped), keeps your
  API key when the file has none, replaces the settings, adds or updates the sites in the file and lists what
  changed.

Settings marked **Reserved** or **Advanced** can still be changed by hand from the extension's service-worker
console:

1. Open `chrome://extensions`, enable **Developer mode**, find Panelingo and click **service worker** under
   _Inspect views_.
2. In the console, merge a patch into the stored settings:

   ```js
   const { settings = {} } = await chrome.storage.local.get("settings");
   settings.detector = { ...settings.detector, backend: "wasm" };
   settings.translate = { ...settings.translate, boxBudget: 8 };
   await chrome.storage.local.set({ settings });
   ```

   Per-site example:

   ```js
   const key = "site:https://reader.example.com";
   const { [key]: site = {} } = await chrome.storage.local.get(key);
   await chrome.storage.local.set({ [key]: { ...site, layout: "paged-rtl", sourceLang: "ja" } });
   ```

The service worker notices the change, relays it to the engine if the engine is running, and re-syncs the content
script registration for site changes. Out-of-range values are clamped and invalid ones fall back to the default, so
a typo cannot break the extension. To start over, remove the extension and add it again; that clears storage and the
cache.
