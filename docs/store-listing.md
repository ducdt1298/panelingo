# Chrome Web Store listing text

Ready-to-paste text for the Chrome Web Store Developer Dashboard (_Store listing_ tab). Field limits: summary ≤ 132
characters (it comes from the manifest), description ≤ 16,000 characters. Keep it in line with the README when
features change. Images and the other fields are listed in [PUBLISHING.md](PUBLISHING.md#store-listing).

## Summary

Translate comics, manga and webtoons in place while you read, with any OpenAI-compatible AI.

## Description

```text
Panelingo translates comics, manga, manhwa, manhua and webtoons right where you read them. Speech balloons are
cleaned and re-lettered in your language, so the page still looks like a comic.

HOW IT WORKS
• Text and balloons are found on your device (an open-source detector model running on WebGPU, or WebAssembly).
• Only crops of the text regions are sent to the AI endpoint you choose. Pages without text never leave your
  computer.
• The original lettering is erased while balloon outlines and artwork stay intact, and the translation is lettered
  at the size of the original text.

BRING YOUR OWN AI
Works with any OpenAI-compatible vision model: OpenAI, OpenRouter, Google Gemini (OpenAI mode), Azure OpenAI and
other gateways, or a local server such as Ollama, LM Studio, vLLM or LiteLLM. Presets and "Test connection" are
built in. You need your own API key or local server; Panelingo has no servers of its own.

MADE FOR READING
• Automatic translation while you scroll on the sites you enable, or on request only.
• Webtoon strips: tall images and balloons split across two images are handled; images further down are prepared
  before you reach them.
• Canvas-based and protected readers: images that cannot be fetched are read from a capture of what you already see.
• Series memory: names and terms stay the same across a whole series, with a glossary you can edit.
• Side panel transcript: every line in reading order, edit any translation, translate a balloon again, jump to it.
• Alt+click (or long-press) a balloon for its original text and the full translation.
• Hold the ` key to peek at the original page.
• Re-opened chapters appear instantly from the local cache.

LANGUAGES
Reads Korean, Japanese, Chinese, English and Spanish. Translates into English, Vietnamese, Spanish, Brazilian
Portuguese, French, German, Italian, Indonesian, Filipino, Polish, Turkish, Japanese, Chinese (Simplified and
Traditional) and Korean, with vertical lettering for Japanese and Traditional Chinese. The interface is available
in 16 languages.

PRIVATE BY DESIGN
• Off by default: translation runs only on sites you turn on, after a one-time notice.
• No account, no telemetry, no analytics, no servers of ours.
• The page address is never sent to the AI. Your API key stays in the browser.

OPEN SOURCE
Panelingo is free and open source (MIT). Source code, documentation and issue tracker:
https://github.com/ducdt1298/panelingo
```

## Single purpose (Privacy practices tab)

```text
Translate the text of comic images on web pages the user enables, and show the translation over the images.
```
