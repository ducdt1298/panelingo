# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Offline mode (experimental).** `translate.engine: "offline"` translates without any AI endpoint: PaddleOCR
  PP-OCRv5 recognizers read the detected text boxes (lines and vertical columns found on the page's ink), and Opus-MT
  (direct or through English) or NLLB-200 distilled 600M (`translate.offlineModel`) translate them, all on
  onnxruntime-web in the engine. The models are downloaded once from pinned Hugging Face revisions, checked against
  their SHA-256 and kept in Cache Storage. A card in Options explains it (quality, sizes, licences; NLLB-200 is
  CC-BY-NC-4.0) and can delete the downloaded models; the popup shows the offline engine instead of the endpoint.
  `npm run fetch-models -- --offline` and `npm run eval:offline` evaluate it on the fixtures
  ([docs/OFFLINE-MODE.md](docs/OFFLINE-MODE.md)). The API mode is unchanged and stays the default.
- **Series memory.** Names and terms stay consistent across a whole series:
  - Series and chapter keys are derived from the page URL (and title) with generic rules for manga, manhwa, webtoon
    and Spanish reader URL styles.
  - A glossary per series. The model's `@term` suggestions become learned entries once two different requests gave
    them; your manual entries and the suggestions you confirm always win, and the model never changes them.
  - Every request carries the glossary, the earlier lines of the chapter (page order, then reading order) and a running
    story summary (`@sum`), within the `memory.*` limits. `@lang` votes settle a series' source language.
  - New setting `memory.enabled` (on by default) turns all of it off.
- **Consistent forms of address across a series.** The model reports how each pair of characters talk to each other
  (`@addr`: how the speaker refers to themself and to the listener, e.g. tớ / cậu or anh / em). The pair is learned at
  once and sent back with every later request of the series, so the xưng hô of the first pages holds to the last; a
  different rendering replaces it only after two requests agree, and your own rules are never changed. The side
  panel's Glossary view lists them (learned or yours) and adds, edits, keeps or deletes them. While a new series has
  no memory yet, its first request goes alone so the next ones start from it (`memory.warmUp`, on by default).
- **Transcript side panel.** The tab's translated lines in reading order, with editing, "Translate again" per balloon,
  "Show" (scroll to the balloon), "Copy all" and a mark on lines that differ from the glossary. The popup opens it
  ("Open the transcript").
- **Glossary view** in the side panel: entries grouped as yours, confirmed, learned and suggestions; add, edit, confirm
  and delete; per-series source language, Korean name style, Japanese honorifics and summary switch; JSON export and
  import.
- **Toolbar progress.** The extension icon shows the number of images in progress on the tab, an orange "!" for a
  pause you may need to fix and a red "!" for an error.
- **Peek at the original.** Hold the backquote key (`render.peekKey`, optionally with Alt) to hide the overlay.
- **Balloon popup.** Alt+click (`render.popupWithAltClick`) or a long press on a translated balloon opens a popup with
  the original text, the full translation, type and speaker, and Copy, Edit, Translate again and Close. The click is
  cancelled so the page does not navigate.
- **Lettering fonts.** Captions are lettered in Mali, signs in bold Mali and sound effects in Bangers; `render.font`
  picks Patrick Hand or Mali for dialogue. Each face is sized from its own cap height, so the lettering still matches
  the original glyph size. `render.eraseSfx` erases sound effects with a clean patch and letters them in place, and
  `render.sfxLabels` turns the labels off.
- **Screen-capture fallback** (image acquisition step 3) for canvas-rendered images and hosts that refuse the engine:
  only on enabled sites, for the visible tab; tall images are captured in overlapping bands and
  stitched; captures are throttled to Chrome's quota and marked low-resolution. A new error tells you when only a
  capture can read an image and the tab is not in front.
- **Screen capture in reader iframes and of wide images.** A reader iframe on an enabled site (its origin in the
  site's `extraFrameOrigins`) is captured too: the frame learns its position in the tab from its parent frames.
  Images wider than the viewport are captured in columns, or in a grid when they are also taller.
- **Lazy-image look-ahead.** In automatic mode, lazy images in the reading column are detected before the page loads
  them and translated within a look-ahead window that follows your reading speed (`discovery.lookahead*`,
  `discovery.detectAhead*`, per-site "Prepare images ahead").
- **Advanced settings in the options page.** Every setting that is in effect can now be changed without editing
  storage: a collapsible Advanced section built from one table (defaults, limits, per-field and global reset), a
  per-site editor (layout and reading direction, source language, Referer policy, cookies, subdomains, reader frames)
  and a JSON backup and restore of settings and sites (the API key only when you ask for it).
- **New logo**: two overlapping comic speech balloons holding "A" and "文", on an indigo-to-violet tile; the popup
  shows it next to the name.
- **Spanish source fixtures** (`es-p01`, `es-strip01`) and an end-to-end test that translates them.
- **CodeQL** code scanning on every pull request and weekly, and an end-to-end job in CI.
- **Store-ready packaging.** `npm run package` writes `release/panelingo-<version>.zip` (manifest at the root,
  reproducible bytes) and its SHA-256; release tags also sign a build provenance attestation. The Chrome Web Store
  text is ready to paste in `docs/store-listing.md`.
- **Japanese, Chinese and Korean targets.** Translation into Japanese, Simplified Chinese, Traditional Chinese and
  Korean, lettered with the system's CJK fonts (sized by ink height) and broken between characters with the basic
  kinsoku rules. In vertical (tategaki) balloons, Japanese and Traditional Chinese are lettered top to bottom in
  columns right to left; `render.verticalText` "never" keeps everything horizontal.

### Changed

- **Fewer, fuller AI requests.** Requests are no longer one per image: consecutive images of a page share requests
  (gathered while their text becomes ready, and merged again when a lane frees up), so a webtoon chapter makes far
  fewer calls (29 → 17 on a 60-strip fixture chapter). The first request of an on-screen image now holds up to 8
  balloons instead of 4. New settings `translate.packWaitMs` (500 ms, 0 = one request per image as before) and
  `translate.urgentPackMax` (8).
- Retention and "Clear the whole cache" also drop unconfirmed glossary suggestions; manual edits, series settings,
  chapter summaries and the glossary entries in use are kept.
- `PROMPT_VERSION` is 3: requests carry series context and ask for `@addr` lines (every target but English); the
  forms-of-address table explains its format.

### Fixed

- A model that accepts only its default temperature (OpenAI reasoning models answer 400 "Unsupported value:
  'temperature'") no longer fails every request: the request is sent again at once without `temperature`, and the
  model gets none from then on.
- The text detector starts loading when a page in auto mode connects, while its images download, instead of at the
  first detection (the model load and the WebGPU compile take a few seconds on a fresh engine).
- **Offline mode no longer takes the engine down.** The translation models ran in the detector's onnxruntime-web
  instance, whose single 4 GiB WebAssembly heap NLLB-200 next to a pivot pair grew to 3.8–4.0 GB; the next growth made
  ORT abort and broke detection for every later image. They now run in their own worker with their own heap, within a
  memory budget (unneeded models unloaded first, the worker restarted between NLLB-200 and Opus-MT), model files are
  handed over one at a time, and running out of memory fails only that batch with the new `offline.out_of_memory`
  error (all 16 languages) while the engine keeps running ([docs/OFFLINE-MODE.md](docs/OFFLINE-MODE.md#memory)).

- Changing the target language no longer shows cached translations in the old language: stored AI translations
  remember their target and are translated again for a new one (your manual edits stay).
- Captions and signs whose text fills the box are erased with a flat fill of the box interior (the frame stays)
  instead of a translucent plate that let the original show through.
- Long lines that fill an elliptical balloon are erased: the balloon outline crossing the corners of the text box no
  longer counts as leftover ink.
- Tall vertical (tategaki) lines that fill an elliptical balloon are erased cleanly: the eraser keeps sampling inside
  the balloon instead of treating it as a box and failing on the page around it.
- The side panel's "Show" scrolls the page to the balloon (the content script now handles `img:scroll-to`).
- Changing the interface language in the options page now applies it (the page reloads in the new language).
- After a 401, the retry uses the API key saved in the meantime instead of the old one.
- OpenRouter moderation (403 "flagged") is a refusal, not a rejected key; 402 (no credits) asks you to fix the
  account instead of being reported as a bug; Gemini's array-wrapped errors and its 400 for a bad key are recognized.
- Upgrading settings from schema 1 keeps the endpoint even when the first save changes another API field.
- A history or forms-of-address limit of 0 no longer sends every line.
- Style rules say "an English", "an Italian", "an Indonesian" onomatopoeia instead of "a English".

## [0.1.0] - Unreleased

First public release.

### Added

- **In-place translation** of comics, manga, manhwa, manhua and webtoons in Chrome (Manifest V3, Chrome 148+).
- **On-device text detection** with the
  [comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector) ONNX model on
  onnxruntime-web. WebGPU (fp32) is used when a bundled canary check passes; otherwise the extension falls back to
  WebAssembly (int8).
- **Webtoon support.** Tall images and strips of touching images are sliced for detection, and boxes are merged across
  seams.
- **Translation units and reading order.** Text is grouped by balloon; reading direction comes from the site layout
  or is inferred (left-to-right or right-to-left).
- **Pixel-level erasing** of the original lettering. Balloon outlines, panel borders and art stay intact. A translucent
  plate is used where a clean erase is not safe (screentone, textured backgrounds).
- **Fitted lettering.** Balanced line breaks inside the balloon's ellipse, a font size capped near the original glyph
  height, re-fitting on zoom and resize, and the bundled Patrick Hand font (OFL).
- **Any OpenAI-compatible vision endpoint.** Presets for OpenAI, OpenRouter, Google Gemini (OpenAI mode), Ollama,
  LM Studio and vLLM. Test connection lists the available models.
- **Set-of-Mark composites.** Downscaled pages with numbered boxes plus enlarged crops, in one JPEG per request, with
  per-model profiles for GPT-4o, GPT-5, Gemini and Claude model ids.
- **Streaming results.** Balloons fill in while the model is still answering. Each line is checked: id range,
  duplicates, empty answers, wrong script, refusals, suspected merges.
- **Retry ladder.** HTTP retries with backoff, crops-only re-asks for missing regions, positional splits, and automatic
  slowdown on rate limits and timeouts.
- **Priority scheduling.** Images on screen use an urgent lane, followed by images below the viewport.
- **Cache.** IndexedDB cache by image content hash and normalized URL, so re-opened chapters show translations
  instantly. Retention is daily (30 days for unused AI translations) and the cache can be cleared from the options page.
- **Image acquisition.** The content script reads images locally when it can. Otherwise the engine fetches them with
  per-host politeness, automatic Referer handling through declarativeNetRequest session rules, and an SSRF guard.
- **Controls.**
  - Per-site opt-in with automatic ("translate while scrolling") or manual ("on request") mode.
  - A hover "Translate" button, context menu items for images, and the keyboard shortcuts Alt+Shift+Y (show or hide
    the overlay) and Alt+Shift+U (translate visible images).
- **Privacy.**
  - A notice before the first upload, and nothing sent for images without text.
  - The page URL is never sent, and there is no telemetry.
  - A daily upload counter in the popup.
- **Languages.** Localized UI in 16 languages, and translation into English, Vietnamese, Spanish, Brazilian
  Portuguese, French, German, Italian, Indonesian, Filipino, Polish and Turkish.
- **Project tooling.**
  - Strict TypeScript run directly by Node 24, with esbuild bundling.
  - Unit and integration tests on `node:test` with a Chrome API fake, plus Puppeteer E2E tests against synthetic
    fixtures, a mock OpenAI-compatible server and a two-origin fixture server.
  - GitHub Actions CI and a release workflow.

[Unreleased]: https://github.com/ducdt1298/panelingo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ducdt1298/panelingo/releases/tag/v0.1.0
