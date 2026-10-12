// Registering extra (possibly partial) UI catalogs at runtime: deep English fallback, picker listing, resolution and
// cache invalidation. Kept apart from i18n.test.ts because registration changes the module's global registry.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EN } from "../../../src/shared/i18n/en.ts";
import {
  catalogFor,
  currentLocale,
  msg,
  registerCatalog,
  registeredCatalog,
  resolveLocale,
  setLocale,
  uiLocales,
} from "../../../src/shared/i18n/index.ts";

describe("registerCatalog with a partial catalog", () => {
  test("missing keys fall back to English, deeply; English itself is untouched", () => {
    registerCatalog("EO", "Esperanto", {
      ui: { siteEnable: "Traduki ĉi tiun retejon" },
      options: { logLevels: { info: "Informoj" } },
      duration: (ms: number): string => `${Math.round(Math.abs(ms) / 1000)} sekundoj`,
    });
    const eo = catalogFor("eo");
    assert.equal(eo.ui.siteEnable, "Traduki ĉi tiun retejon");
    assert.equal(eo.ui.siteDisable, EN.ui.siteDisable);
    assert.equal(eo.options.logLevels.info, "Informoj");
    assert.equal(eo.options.logLevels.debug, EN.options.logLevels.debug);
    assert.deepEqual(eo.errors["api.unreachable"], EN.errors["api.unreachable"]);
    assert.equal(eo.duration(5_000), "5 sekundoj");
    assert.equal(eo.ui.uploadsToday, EN.ui.uploadsToday);
    assert.deepEqual(eo.options.privacyPoints, EN.options.privacyPoints);
    assert.equal(EN.ui.siteEnable, "Translate this site");
    assert.equal(EN.options.logLevels.info, "Info");
  });

  test("the registered catalog is kept as given (code lower-cased)", () => {
    const raw = registeredCatalog("eo");
    assert.equal(raw?.ui?.siteEnable, "Traduki ĉi tiun retejon");
    assert.equal(raw?.ui?.siteDisable, undefined);
    assert.equal(registeredCatalog("EO"), raw);
    assert.equal(registeredCatalog("xx"), undefined);
  });

  test("listed in the picker with its own name, English still first", () => {
    const locales = uiLocales();
    assert.equal(locales[0]?.code, "en");
    assert.deepEqual(
      locales.find(({ code }) => code === "eo"),
      { code: "eo", name: "Esperanto" },
    );
  });

  test("browser languages and settings resolve to it", () => {
    assert.equal(resolveLocale("auto", ["eo-XX", "en"]), "eo");
    assert.equal(resolveLocale("eo", ["fr"]), "eo");
  });

  test("arrays are replaced, not merged", () => {
    registerCatalog("eo", "Esperanto", { options: { privacyPoints: ["Nur unu punkto."] } });
    assert.deepEqual(catalogFor("eo").options.privacyPoints, ["Nur unu punkto."]);
  });

  test("re-registering replaces the catalog and its merged cache", () => {
    registerCatalog("eo", "Esperanto", { ui: { siteEnable: "Nova" } });
    const eo = catalogFor("eo");
    assert.equal(eo.ui.siteEnable, "Nova");
    assert.deepEqual(eo.options.privacyPoints, EN.options.privacyPoints);
    assert.equal(catalogFor("eo"), eo, "cached");
  });

  test("setLocale and msg() use it", () => {
    try {
      assert.equal(setLocale("auto", ["eo"]), "eo");
      assert.equal(currentLocale(), "eo");
      assert.equal(msg().ui.siteEnable, "Nova");
      assert.equal(msg().ui.siteDisable, EN.ui.siteDisable);
    } finally {
      setLocale("en");
    }
  });

  test("an exact regional catalog wins over the language's other region", () => {
    registerCatalog("pt-PT", "Português (Portugal)", { ui: { siteEnable: "Traduzir este sítio" } });
    assert.equal(resolveLocale("auto", ["pt-PT"]), "pt-pt");
    assert.equal(resolveLocale("auto", ["pt-BR"]), "pt-br");
    assert.equal(catalogFor("pt-PT").ui.siteEnable, "Traduzir este sítio");
  });

  test("a registered Hong Kong catalog wins over the zh-hk → zh-tw alias", () => {
    assert.equal(resolveLocale("auto", ["zh-HK"]), "zh-tw");
    registerCatalog("zh-hk", "繁體中文（香港）", { ui: { siteEnable: "翻譯此網站" } });
    assert.equal(resolveLocale("auto", ["zh-HK"]), "zh-hk");
    assert.equal(resolveLocale("auto", ["zh-TW"]), "zh-tw");
  });
});
