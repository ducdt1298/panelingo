## Summary

<!-- What does this change and why? Link the issue it closes, e.g. "Closes #123". -->

## Type of change

- [ ] `fix` – bug fix
- [ ] `feat` – new feature
- [ ] `perf` / `refactor` – no behavior change for users
- [ ] `docs` / `test` / `build` / `ci` / `chore`
- [ ] Breaking change (stored data, settings layout or message protocol)

## How was this tested?

<!-- Commands you ran, sites or fixtures you tried, screenshots for visual changes (lettering, erasing, UI). -->

## Checklist

- [ ] `npm run check` passes (typecheck, lint, format, unit + integration tests with coverage).
- [ ] `npm run test:e2e` passes, or this change cannot affect the extension at runtime.
- [ ] New logic in `src/shared/**` is pure and covered by unit tests.
- [ ] No test calls a real AI provider or a real comic site.
- [ ] Settings changes are reflected in `DEFAULT_SETTINGS`/`LIMITS` and `docs/CONFIGURATION.md`.
- [ ] Persisted or exchanged formats changed → the matching stamp in `src/shared/versions.ts` was bumped.
- [ ] New user-visible strings are in `src/shared/i18n/en.ts` and every bundled catalog (the i18n tests require complete catalogs).
- [ ] New permissions, hosts or data flows are justified in `docs/PUBLISHING.md` and
      `docs/PRIVACY.md`.
- [ ] `CHANGELOG.md` has an entry under "Unreleased" for user-visible changes.
