# docs/images

Images used by the README and the Chrome Web Store listing. They show **only the synthetic fixture pages** that
`npm run fixtures` generates (original drawings and sentences, see `tools/fixtures/README.md`), translated by the
extension against the local mock server. **Never commit copyrighted pages.**

| File                                        | Used in                               | Shows                                                                                                         | Size                |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| `demo.gif`                                  | README hero                           | the webtoon strip `ko-strip01` scrolling while its Korean balloons are re-lettered in English                 | 800×600, about 10 s |
| `before.png` / `after.png`                  | README "Before" / "After"             | the Korean page `ko-p01`, untouched and translated into English                                               | 600×900             |
| `before-es.png` / `after-es.png`            | not referenced yet                    | the Spanish page `es-p01`, untouched and translated into English                                              | 600×900             |
| `popup.png`                                 | not referenced yet                    | the toolbar popup for a translated tab                                                                        | CSS size (380 wide) |
| `sidepanel.png`                             | not referenced yet                    | the side panel transcript of `es-p01` (Spanish originals, English translations)                               | 440×800             |
| `options.png`                               | not referenced yet                    | the top of the options page                                                                                   | 1280×800            |
| `store-1.png`                               | Chrome Web Store screenshots          | `ko-p01` before and after                                                                                     | 1280×800            |
| `store-2.png`                               | Chrome Web Store screenshots          | the translated webtoon strip next to its side panel transcript                                                | 1280×800            |
| `store-3.png`                               | Chrome Web Store screenshots          | the options page and the popup                                                                                | 1280×800            |
| `promo-small.png`                           | Chrome Web Store small promo tile     | icon, name and tagline                                                                                        | 440×280             |
| `marquee.png`                               | Chrome Web Store marquee (optional)   | icon, name, tagline and a translated page                                                                     | 1400×560            |
| `offline-ko-p01.png` / `offline-ja-p01.png` | [OFFLINE-MODE.md](../OFFLINE-MODE.md) | `ko-p01` and the vertical Japanese `ja-p01` translated into English by offline mode (Opus-MT), no AI endpoint | 600×900             |

## Regenerate

```sh
npm run fixtures          # once: test/fixtures/generated (Python 3.14 + Pillow 12.3, Windows fonts)
npm run build:test        # or: node scripts/build.ts --test --out=<dir> and set CTV_EXTENSION_DIR=<dir>
node e2e/docs-shots.ts    # writes docs/images; about a minute
```

`e2e/docs-shots.ts` launches the E2E harness (Chrome with the built extension, the fixture server and the mock
OpenAI-compatible server on ephemeral ports; the extension never talks to a real AI endpoint), translates `ko-p01`
and `es-p01` into English, captures the popup, the side panel and the options page, records the demo frames while
`ko-strip01` translates and scrolls, then runs `tools/docs/compose_images.py` (Python + Pillow) to scale, encode
and compose the files above.

- **English output.** The mock's oracle answers from the fixtures' ground truth, whose reference translations are
  Vietnamese. The script gives the mock a temporary copy of the ground truth with `refs.en` (the parallel English
  sentence of each unit, in sentence case) and sets its `oracleLang` scenario field to `en`.
- **Options.** `--out <dir>` (default `docs/images`), `--raw <dir>` keeps the raw captures, `--skip-demo` skips the
  GIF and `store-2.png`. Environment: `CTV_EXTENSION_DIR` (built extension, default `dist/`), `CHROME_PATH`,
  `PYTHON` (default `python`), `CTV_HEADED=1` to watch.
- **Budgets.** PNGs over 400 KB are reduced to 256 colours; the GIF drops frames, then shrinks to 640 px wide,
  until it is under 4 MB.
- **Check every image** after a run (the overlay, the options page and the popup change between releases), and keep
  the README alt texts in line with what the images show.

### Offline mode screenshots

`offline-ko-p01.png` and `offline-ja-p01.png` are not made by `e2e/docs-shots.ts`. They come from the offline
evaluation (models cached with `npm run fetch-models -- --offline`, see [OFFLINE-MODE.md](../OFFLINE-MODE.md)):

```sh
CTV_EXTENSION_DIR=build-offline npm run eval:offline -- --models=opus-mt --backends=auto --targets=en --shots=<dir>
```

then `<dir>/opus-mt-auto-<page>-en.png` (800 px wide) is cropped to the page (y 55 to 1255) and scaled to 600×900.
