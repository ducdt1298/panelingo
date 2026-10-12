# Privacy policy

_Last updated: 2026-10-11_

This policy describes how the **Panelingo** browser extension ("the extension", "we") handles data. In short:
the extension has no servers, collects no telemetry, and sends images only to the AI endpoint **you** configure, and
only after you have agreed.

## Who is responsible

Panelingo is open-source software maintained by the Panelingo contributors
(https://github.com/ducdt1298/panelingo). We do not operate any server that receives your data. The
AI provider you choose, such as OpenAI, Google, OpenRouter or your own local server, processes what the extension
sends to it under that provider's own terms and privacy policy.

Contact: open an issue or a private report at https://github.com/ducdt1298/panelingo (for
security or privacy problems, use _Security → Report a vulnerability_ so the report stays private).

## What the extension processes on your device

| Data                                                                                                                                               | Purpose                                                                 | Where it stays                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Comic images on pages where you enabled the extension or asked for a translation                                                                   | Text detection, erasing the original lettering, drawing the translation | Processed in memory in your browser. Image bytes are not stored, but a hash of them is. |
| Detected regions, the original text as read by the AI, translations, erase patches, a SHA-256 hash and the normalized URL of each processed image  | Showing translations again instantly, without new requests              | The extension's IndexedDB on your device                                                |
| Your settings, including the AI endpoint URL, model and **API key**, and the list of sites you enabled                                             | Making the extension work as you configured it                          | `chrome.storage.local` and the extension's IndexedDB on your device                     |
| Series memory: a key per series and chapter derived from the page address, the glossary, per-series settings and a short story summary per chapter | Keeping names and terms consistent across a series                      | The extension's IndexedDB on your device                                                |
| A daily counter of uploaded composites (number and size)                                                                                           | Shown in the popup so you can see what was sent                         | The extension's IndexedDB on your device                                                |
| Diagnostic log entries (errors, timings, image addresses; no image content)                                                                        | Troubleshooting                                                         | The extension's IndexedDB on your device (fixed-size ring buffer)                       |

The text detector runs entirely in your browser (WebGPU or WebAssembly). The detection model, its runtime and the fonts
ship inside the extension, so nothing is downloaded at run time.

When neither the page nor the extension can read an image (for example a canvas, or a host that refuses the extension's
own request), the extension may take a screenshot of the visible tab, only on sites you enabled and only while that tab
is in front, and crops it at once to that image. The rest of the screenshot is discarded in memory; the cropped image
is then handled like any other comic image.

## What leaves your device, and where it goes

**1. To the AI endpoint you configured, and only there.** For images in which text was detected, the extension sends
requests to `{your base URL}/chat/completions`. Each request contains:

- One JPEG composite image: downscaled thumbnails of the comic pages or webtoon slices that contain text, numbered boxes
  around each text area, and enlarged crops of those text areas.
- Instructions: output format, language rules and the target language.
- Context text from the same series: earlier translated lines of the chapter, the series glossary (your entries and
  the names the AI learned) and a short story summary. The page address itself is not part of it. Setting
  `memory.enabled` to `false` turns this context off.
- Your API key in the `Authorization` header, if you entered one.

The extension also sends `GET {your base URL}/models` to check that the endpoint is reachable.

**What is never sent to the AI endpoint:** images in which no text was detected, the address of the page you are
reading, your cookies, your browsing history, or any identifier created by the extension.

**Uploads require your consent.** Nothing is uploaded until you have read and accepted the notice that explains what
is sent. Automatic translation runs only on sites you enable. On other pages, the extension acts only when you ask
(context menu, keyboard shortcut or popup button).

**2. To the comic's own image servers.** When the extension cannot read an image from the page directly, it downloads
the image again from the same address the page uses. These requests omit cookies by default. Some image hosts refuse
requests without a referrer; for those, the extension may send the page's origin or, if that is refused, the address of
the page as the `Referer` header. This is the same information your browser sends when it displays the page.

**3. Nowhere else.** The extension contains no analytics, no telemetry, no advertising, no crash reporting and no
third-party scripts. It does not contact us.

## Your AI provider

Whatever you send to an AI provider is governed by that provider's terms. Providers may log or retain requests;
treat everything sent as stored. If you do not want images to leave your computer, use a local, OpenAI-compatible
server such as Ollama or LM Studio on `127.0.0.1`.

## Security of your API key

Your API key is stored unencrypted in the extension's local storage (`chrome.storage.local`, and a mirror in its
IndexedDB) on your device. It is not synchronized to your Google account. It is only ever sent to the endpoint you
configured. Anyone with access to your browser profile can read it, so use a key with a spending limit where your
provider supports one.

## Retention and deletion

- Cached AI translations that have not been used for 30 days (configurable) are deleted automatically, and so are the
  image records that no longer have a translation. Translations you edited by hand are kept until you clear the
  cache.
- **Options → Cache → Clear the whole cache** deletes all cached translations, regions and erase patches.
- Removing the site from the options page stops all processing on it.
- Uninstalling the extension deletes all of its local data, including settings and the API key.

## Permissions

The extension asks only for the permissions it needs to translate comics in place. Each one is explained in
[PUBLISHING.md](PUBLISHING.md#permission-justifications).

## Children

The extension is not directed at children and does not knowingly collect personal information from anyone.

## Chrome Web Store user data policy

The use of information received by this extension adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including
the Limited Use requirements. We do not sell user data, do not use or transfer it for purposes unrelated to the
extension's single purpose (translating comics in place), and do not use it to determine creditworthiness or for
lending purposes.

## Changes

We will update this page when the extension's data handling changes, and note the change in
[CHANGELOG.md](../CHANGELOG.md). The "Last updated" date at the top shows the current version.
