# Roadmap

This roadmap shows where Panelingo is heading. It is a statement of intent, not a promise of dates. Priorities
follow user feedback, so 👍 the matching issue or open a
[feature request](https://github.com/ducdt1298/panelingo/issues/new/choose) if something matters to
you. Pull requests are welcome; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Available in 0.1.0

- On-device text and balloon detection: onnxruntime-web on WebGPU, with an int8 WebAssembly fallback and a canary
  self-check.
- Automatic translation while you scroll on sites you enable. A manual mode works through the hover button, the context
  menu and Alt+Shift+U.
- Webtoon strips: tall images are sliced, and balloons split across two images are merged.
- Pixel-level erasing that keeps balloon outlines and artwork, with a translucent plate wherever a clean erase is not
  safe.
- Fitted lettering whose size follows the original glyph height.
- Any OpenAI-compatible vision endpoint, with presets for OpenAI, OpenRouter, Gemini, Ollama, LM Studio and vLLM.
- A streaming parser with per-region id accounting, a retry ladder and rate-limit handling.
- IndexedDB cache by content hash and URL, so re-opened chapters are instant.
- Privacy: opt-in per site, a notice before the first upload, nothing sent for images without text, no telemetry.
- A UI localized into 16 languages, and eleven target languages.

## Done since 0.1.0 (in the next release)

- **Series memory.** A glossary per series, learned from the model's `@term` lines and edited by you (your entries
  always win over AI output), the earlier lines of the chapter and a running story summary in every request, and
  per-series settings (source language, Korean name style, Japanese honorifics). The glossary exports and imports as
  JSON.
- **Transcript side panel.** The tab's dialogue in reading order, with editing (your edits always win over AI output),
  re-translation of single balloons, jump-to-balloon, "Copy all", a mark on lines that differ from the glossary, and
  the Glossary view. The popup opens it.
- **Toolbar progress.** The extension icon shows per-tab progress: the number of images in progress (blue), an orange
  "!" when translation is paused on something you may need to fix, and a red "!" on an error. It clears once
  everything has settled.
- **Peek at the original.** Hold `render.peekKey` (the backquote key by default) to hide the overlay, optionally only
  together with Alt (`render.peekWithAlt`).
- **Balloon popup.** Alt+click or long-press a translated balloon to see the original text, the full translation (also
  when the lettering had to be shortened), and to copy, edit or re-translate it.
- **Lettering fonts.** Mali for captions, bold Mali for signs and Bangers for sound effects, each sized from its own
  cap height so it still matches the original lettering; `render.font` picks Patrick Hand or Mali for dialogue, and
  sound effects can be erased (`render.eraseSfx`) instead of labeled.
- **Harder sites.** A screen-capture fallback for canvas-rendered or protected images (captured in bands and
  stitched, only for the visible tab of an enabled site), and lazy images in the reading column detected and translated
  before you scroll to them, with a look-ahead that follows your reading speed.
- **Capture everywhere.** The screen-capture fallback also works inside reader iframes (an offset chain through the
  parent frames tells the frame where it sits in the tab) and for images wider than the viewport (columns, or a grid
  of tiles when both sides exceed it).
- **Settings UI.** Every setting in effect is editable in the options page: a searchable Advanced tab, a per-site editor
  (layout, source language, Referer and cookie policy, subdomains, reader frames, prepare-ahead) and a JSON backup and
  restore.
- **Signed releases.** Every tag builds the extension zip with a SHA-256 and a signed build provenance attestation.
- **Spanish source pages** in the test fixtures, and cleaner erasing of long Latin-script lines that fill their balloons.
- **CJK targets and vertical lettering.** Translation into Japanese, Simplified and Traditional Chinese and Korean,
  lettered with the system's CJK fonts and broken between characters (basic kinsoku rules); Japanese and Traditional
  Chinese are lettered top to bottom in tategaki balloons (`render.verticalText`).

## Next

| Area             | Planned work                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Distribution** | Publishing the Chrome Web Store listing from the maintainer account: the zip (`npm run package`), the text ([store-listing.md](store-listing.md)), images and permission justifications ([PUBLISHING.md](PUBLISHING.md)) are ready. |

## Later and under consideration

- More UI languages and target languages, including targets whose scripts need extra fonts (Cyrillic, CJK, Thai).
- Optional host permissions, so access can be granted per site instead of up front.
- Keeping the last N composites that were sent, for inspection (`privacy.keepSentComposites`).
- Comics drawn as CSS background images.
- Better right-to-left manga page segmentation.
- GPU-backed end-to-end runs in CI.
- Other Chromium-based browsers and, if there is demand, Firefox.

## Not planned

- A hosted translation service run by this project. The extension will keep talking only to endpoints you choose.
- Bundling or redistributing copyrighted comics in any form, including test data.
