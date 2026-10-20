# Contributing to Panelingo

Thanks for your interest in improving Panelingo! Bug reports, site reports, translations, documentation and code
are all welcome. By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Branches and commits](#branches-and-commits)
- [Checks to run](#checks-to-run)
- [Adding a UI language](#adding-a-ui-language)
- [Adding a target language](#adding-a-target-language)
- [Adding a provider preset](#adding-a-provider-preset)
- [Pull request checklist](#pull-request-checklist)

## Ways to contribute

- **Report a bug** with the [bug report form](https://github.com/ducdt1298/panelingo/issues/new/choose).
  Include the extension version, Chrome version, provider and model, and the _kind_ of site. Never include API keys.
- **Report a site that does not work.** Describe how the reader loads its images (lazy loading, canvas, iframe,
  Referer-protected CDN, page-turn). These reports drive the [roadmap](docs/ROADMAP.md).
- **Translate the UI** into your language (see [below](#adding-a-ui-language)) or improve an existing translation.
- **Share provider results.** Which models follow the output format well, and which do not? Discussions are the best
  place for this.
- **Improve the docs.** Everything under `docs/` is plain Markdown.
- **Write code.** Look for issues labeled `good first issue` or `help wanted`. For larger changes, open an issue
  first so we can agree on the approach before you invest time.

Security issues must **not** be reported publicly. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js ≥ 24.19 and Chrome ≥ 148.

```sh
npm ci
npm run fetch-models   # detector models from Hugging Face (pinned commits, sha256-checked)
npm run build          # dist/ → chrome://extensions → Developer mode → Load unpacked
```

Several unit and integration tests read the synthetic fixtures. Generate them once with `npm run fixtures`, which needs
Python 3.14 with Pillow and the Windows fonts listed in [docs/TESTING.md](docs/TESTING.md#test-data). If you cannot
generate them locally, CI generates them for every pull request.

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers every command, the project layout and the coding conventions:

- TypeScript strict;
- relative imports end in `.ts`;
- no `enum`;
- `src/shared/**` stays pure;
- the messaging rules in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Branches and commits

- `main` is always releasable. Work on a branch named after the change: `feat/side-panel-transcript`,
  `fix/webtoon-seam-merge`, `docs/ollama-setup`.
- Keep pull requests focused. One logical change per PR is easier to review and to revert.
- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for commit messages and PR titles:

  ```
  <type>(<optional scope>): <summary in the imperative, lower case, no period>
  ```

  | Type       | Use for                                        |
  | ---------- | ---------------------------------------------- |
  | `feat`     | a user-visible feature                         |
  | `fix`      | a bug fix                                      |
  | `perf`     | a performance improvement                      |
  | `refactor` | code change without behavior change            |
  | `test`     | tests only                                     |
  | `docs`     | documentation only                             |
  | `build`    | build scripts, dependencies                    |
  | `ci`       | GitHub Actions                                 |
  | `chore`    | anything else that does not touch shipped code |

  Common scopes: `engine`, `content`, `sw`, `ui`, `core`, `detector`, `erase`, `prompt`, `render`, `i18n`, `settings`,
  `deps`.

  Examples:

  ```
  feat(render): honor render.peekKey to show the original page
  fix(engine): re-check the guard after cross-origin redirects
  docs(config): add LM Studio setup notes
  ```

  Mark breaking changes with `!` after the type or scope, or with a `BREAKING CHANGE:` footer. Changes to stored data,
  the settings layout or the message protocol count as breaking.

## Checks to run

| Before you…                     | Run                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------- |
| commit                          | `npm run format` and `npm run lint:fix`                                       |
| push                            | `npm run check` (typecheck, lint, format check, unit + integration, coverage) |
| open a PR touching runtime code | `npm run test:e2e` (builds a test build and drives a real Chrome)             |

CI runs the same `check` steps and a production build on every pull request. Line coverage of `src/shared/**` must
stay at or above 85%.

**Tests never call a real AI provider or a real comic site.** Use the mock server, the fixture server or fakes. See
[docs/TESTING.md](docs/TESTING.md).

For visual changes to erasing, lettering or the UI, add before/after screenshots made from the synthetic fixture pages.
Do not post copyrighted pages.

## Adding a UI language

UI catalogs live in [`src/shared/i18n/`](src/shared/i18n/). English (`en.ts`) is the reference and defines the
`Catalog` type.

1. **Create the catalog.** Copy `src/shared/i18n/en.ts` to `src/shared/i18n/<code>.ts`. Use a lower-case code, with a
   region only where it matters (`pt-br`, `zh-tw`). Export it as `export const XX: Catalog = { … }`. Bundled catalogs
   must be complete; TypeScript and the tests enforce it.
2. **Translate every string.** Keep product names, URLs, model ids, keyboard shortcuts and placeholders verbatim.
   Functions (counts, sizes, durations) must keep their arguments and use the language's plural rules.
3. **Register it** in `src/shared/i18n/index.ts`:
   - import the catalog;
   - add `["<code>", XX]` to `CATALOGS`;
   - add the language's own name to `NAMES`;
   - if browsers report codes that should map to it, add them to `ALIASES`.
4. **Add the language's plural categories** to the table in `test/unit/shared/i18n.test.ts`. The test fails until you
   do.
5. **Check the manifest strings.** `ui.appName`, `manifest.description` (≤ 132 characters) and `manifest.commands.*`
   become `_locales/<dir>/messages.json` at build time. `pt-br` becomes `pt_BR`, for example.
6. Run `npm run check`, build, set **Options → Language & display → Interface language** to your language and click through the popup and
   options page. Look for text that overflows its control.

To fix a translation in an existing catalog, edit that file and run `npm run check`.

## Adding a target language

Languages the translation can be written in are listed in
[`src/shared/languages.ts`](src/shared/languages.ts) (`TARGET_LANGUAGES`: `code`, `englishName`, `nativeName`). The
prompt names the language in English. Add the entry, extend `test/unit/shared/languages.test.ts`, and check the result
on the fixture pages.

The bundled lettering font covers Latin and Vietnamese. Characters outside those subsets fall back to system fonts,
so scripts such as Cyrillic, Thai or CJK need a suitable font before they look right. Mention this in the PR.

## Adding a provider preset

Presets are shortcuts in the options page that fill the base URL and a default model. They are defined in
[`src/ui/options/options-model.ts`](src/ui/options/options-model.ts) (`API_PRESETS`):

```ts
{ id: "example", label: "Example AI", baseUrl: "https://api.example.com/v1", model: "example-vision-1", needsKey: true },
```

A preset is accepted when the provider:

- implements OpenAI-compatible `POST /chat/completions` with **SSE streaming** and **`image_url` content parts**
  (base64 data URLs);
- accepts the key as `Authorization: Bearer <key>`, or needs no key;
- has a default `model` that accepts images, or uses `""` for local servers where the user picks a loaded model;
- uses a base URL with no query string; the options page refuses those.

Then:

1. Add the entry. Keep cloud providers first and local servers after them.
2. Update the provider tables in [docs/CONFIGURATION.md](docs/CONFIGURATION.md#providers) and the [README](README.md).
3. If the model family needs its own composite profile, add a matcher in `src/shared/core/model-profile.ts` with a
   test, and explain in the PR how you measured it.
4. Run `npm run check`.
5. Test the preset by hand against the real provider. Never do this from automated tests.

## Pull request checklist

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) repeats these points:

- [ ] The PR title follows Conventional Commits.
- [ ] `npm run check` passes, and `npm run test:e2e` passes for runtime changes.
- [ ] New pure logic lives in `src/shared/**` with unit tests.
- [ ] Settings changes are reflected in `DEFAULT_SETTINGS`/`LIMITS`, in migration tests and in
      [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- [ ] When a persisted or exchanged format changed, the stamp in `src/shared/versions.ts` was bumped.
- [ ] User-visible strings are in `src/shared/i18n/en.ts`, and in every bundled catalog, because the tests require
      complete catalogs. Ask for help with languages you do not speak; maintainers can coordinate.
- [ ] New permissions or data flows are explained in [docs/PUBLISHING.md](docs/PUBLISHING.md) and
      [docs/PRIVACY.md](docs/PRIVACY.md).
- [ ] [CHANGELOG.md](CHANGELOG.md) has an entry under **Unreleased** for user-visible changes.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
