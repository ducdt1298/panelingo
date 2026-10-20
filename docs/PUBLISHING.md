# Publishing

This page covers how to cut a release and publish Panelingo to the Chrome Web Store, including the
justification for every permission in the manifest.

## Release checklist

1. **Version.** Bump `version` in `package.json`, which the build copies into `manifest.json`. Use
   [semantic versioning](https://semver.org/) with numbers only (`1.2.0`). Chrome requires one to four dot-separated
   integers in `manifest.json`, so suffixes such as `-rc.1` would produce an extension that does not load.
2. **Changelog.** Move the "Unreleased" entries in [CHANGELOG.md](../CHANGELOG.md) under the new version and date.
3. **Clean build and checks.**

   ```sh
   npm ci
   npm run fetch-models -- --verify
   npm run check:full        # typecheck, lint, format, unit + integration + coverage, E2E
   npm run build:prod
   ```

4. **Inspect `dist/`.**
   - [ ] `manifest.json`: the name has no "(dev)" or "(test)" suffix, the version is correct, there is no
         `declarativeNetRequestFeedback` permission and no `content_scripts` key.
   - [ ] There is no `ui/debug.html` and there are no `.map` files.
   - [ ] `LICENSES/` contains all seven license and notice files listed in
         [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
   - [ ] `build-info.json` lists the expected model hashes.
5. **Smoke test** the production build with _Load unpacked_ in a clean profile, then run
   [manual-checklist.md](manual-checklist.md) on a few real readers.
6. **Tag.** Run `git tag vX.Y.Z && git push origin vX.Y.Z`. The [release workflow](../.github/workflows/release.yml)
   then:
   - checks that the tag matches `package.json`;
   - runs typecheck and lint;
   - fetches the models and builds for production;
   - zips `dist/` with `manifest.json` at the archive root;
   - signs a build provenance attestation for the zip (GitHub artifact attestations, Sigstore), so anyone can check
     it came from this workflow and tag: `gh attestation verify panelingo-X.Y.Z.zip --repo ducdt1298/panelingo`;
   - attaches `panelingo-X.Y.Z.zip` and its SHA-256 to a GitHub release.
7. **Upload** that zip in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
   To make the same archive locally, run `npm run package` (production build into `release/dist`, then
   `release/panelingo-X.Y.Z.zip` and its SHA-256, written with Node only).

To package by hand, zip the **contents** of `dist/`, not the folder itself:

```sh
cd dist && zip -r -X ../panelingo-X.Y.Z.zip .
```

```powershell
Compress-Archive -Path dist\* -DestinationPath panelingo-X.Y.Z.zip
```

## Store listing

| Field                      | Value / source                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                       | Panelingo (from `src/shared/i18n/*` → `_locales`)                                                                                                                                                                            |
| Summary (≤ 132 characters) | "Translate comics, manga and webtoons in place while you read, with any OpenAI-compatible AI." (`manifest.description`)                                                                                                      |
| Description                | Ready to paste in [store-listing.md](store-listing.md) (it states that the user needs their own AI endpoint).                                                                                                                |
| Category                   | Productivity (or Tools)                                                                                                                                                                                                      |
| Icon                       | `assets/icons/icon-128.png`                                                                                                                                                                                                  |
| Screenshots                | 1280×800 or 640×400, 1–5 images: `docs/images/store-1.png` (page before and after), `store-2.png` (webtoon and transcript), `store-3.png` (options and popup), made from synthetic fixture pages by `node e2e/docs-shots.ts` |
| Small promo tile           | 440×280: `docs/images/promo-small.png`                                                                                                                                                                                       |
| Marquee (optional)         | 1400×560: `docs/images/marquee.png`                                                                                                                                                                                          |
| Homepage / support URL     | `https://github.com/ducdt1298/panelingo` / its Issues page                                                                                                                                                                   |
| Privacy policy URL         | `https://github.com/ducdt1298/panelingo/blob/main/docs/PRIVACY.md`                                                                                                                                                           |

Do not show copyrighted pages in screenshots unless you hold the rights. The synthetic fixtures
(`npm run fixtures`, `npm run serve:fixtures`) are original artwork made for this purpose.

## Privacy practices tab

**Single purpose.** "Translates the text in comic, manga and webtoon images on web pages in place, using an AI
endpoint the user configures."

**Remote code.** _No._ All JavaScript and WebAssembly ships inside the package. The `'wasm-unsafe-eval'` CSP source
only lets onnxruntime-web compile its bundled `.wasm` file. The detector models are bundled, not downloaded.

**Data usage disclosures.** Check these boxes in the dashboard so they match [PRIVACY.md](PRIVACY.md):

- **Website content**: images on pages where the user enabled the extension are processed. Composites of images that
  contain text are sent to the AI endpoint the user configured.
- **Authentication information**: the user's API key for their AI endpoint is stored locally. It is sent only to that
  endpoint.
- Certify that data is not sold, not used for unrelated purposes and not used for creditworthiness (Limited Use).

## Permission justifications

Paste these into the dashboard. They describe what the code actually does.

| Permission                                          | Justification                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offscreen`                                         | Hosts the translation engine in an offscreen document (reasons `WORKERS`, `BLOBS`). The engine runs the on-device text detector with WebGPU/WebAssembly, decodes and re-encodes comic images, and streams responses from the AI endpoint. A service worker cannot do this reliably, because it is stopped during long requests and cannot run the WebAssembly runtime.                                           |
| `scripting`                                         | Registers the content script dynamically, and only for the sites the user turned on. It also injects the script into the current tab when the user explicitly asks for a translation (context menu, keyboard shortcut or popup button). No content script runs on any other site.                                                                                                                                |
| `storage`                                           | Stores the user's settings, the AI endpoint configuration and per-site preferences (`chrome.storage.local`). It also keeps a small least-recently-used list of network rules in `chrome.storage.session`.                                                                                                                                                                                                        |
| `unlimitedStorage`                                  | The local IndexedDB cache (detected regions, translations, erase patches) lets previously read chapters reappear instantly without new AI requests. For long series it can exceed the default quota. A daily retention pass and a "clear cache" button keep it bounded.                                                                                                                                          |
| `contextMenus`                                      | Adds "Translate this image" and "Translate this image again" to the context menu of images.                                                                                                                                                                                                                                                                                                                      |
| `declarativeNetRequestWithHostAccess`               | Session rules that apply **only to the extension's own background requests** (`initiatorDomains: [extension id]`, `tabIds: [-1]`). Some rules set the `Referer` header that some comic image hosts require; `fetch()` cannot set this header itself. Others block requests to private and loopback addresses (an SSRF guard) while allowing the user's configured AI endpoint. Page requests are never modified. |
| `sidePanel`                                         | Provides the transcript side panel, opened with a keyboard command.                                                                                                                                                                                                                                                                                                                                              |
| Host permission `<all_urls>`                        | Comics are served from arbitrary domains and CDNs. The engine must download the images the user asked to translate from those hosts, and set the `Referer` header those hosts require (DNR needs host access for that). It must also reach whichever OpenAI-compatible endpoint the user configures, which can be a cloud API or a local server. Content scripts still run only on sites the user enabled.       |
| `incognito: "spanning"`                             | Not a permission. When the user allows the extension in Incognito, one engine and one cache serve all windows.                                                                                                                                                                                                                                                                                                   |
| `web_accessible_resources` (`assets/fonts/*.woff2`) | The overlay lettering fonts. The content script loads them as bytes, and `use_dynamic_url` prevents fingerprinting through stable resource URLs.                                                                                                                                                                                                                                                                 |
| `declarativeNetRequestFeedback`                     | **Development and test builds only.** It is not present in the production build or the store package.                                                                                                                                                                                                                                                                                                            |

### Notes for reviewers

The extension needs an AI endpoint to translate. In the dashboard's test instructions, either provide a temporary API
key with a low spending limit, or explain how to point the extension at a free local server (for example, Ollama with
a small vision model). Also describe the flow:

1. Enter the endpoint in Options and click **Test connection**.
2. Open a comic page and switch on **Translate on this site** in the popup.
3. Accept the privacy notice.
