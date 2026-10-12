import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { applyLocale, contextLanguages } from "../../../src/platform/locale.ts";
import { EN } from "../../../src/shared/i18n/en.ts";
import { catalogFor, currentLocale, msg, setLocale } from "../../../src/shared/i18n/index.ts";

// applyLocale reads chrome.i18n.getUILanguage() and navigator.languages. Both are stubbed per test: a minimal
// chrome.i18n on globalThis, and an own `languages` property that shadows Node's Navigator getter. Unsupported
// languages use codes no catalog will ever have (xx, yy, zz, qq), since bundled catalogs keep being added.

const holder = globalThis as { chrome?: unknown };
let previousChrome: unknown;

function browser(uiLanguage: string | (() => string) | null, languages: readonly string[]): void {
  if (uiLanguage === null) {
    delete holder.chrome;
  } else {
    const getUILanguage = typeof uiLanguage === "function" ? uiLanguage : (): string => uiLanguage;
    holder.chrome = { i18n: { getUILanguage } };
  }
  Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
}

beforeEach(() => {
  previousChrome = holder.chrome;
});

afterEach(() => {
  holder.chrome = previousChrome;
  delete (navigator as { languages?: readonly string[] }).languages;
  // msg() is module state: every other test expects English.
  setLocale("en");
});

const VI = catalogFor("vi");

test("auto follows the browser UI language, with or without a region", () => {
  browser("vi", ["en-US"]);
  assert.equal(applyLocale("auto"), "vi");
  assert.equal(currentLocale(), "vi");
  assert.equal(msg().menu.translateImage, VI.menu.translateImage);
  assert.notEqual(msg().menu.translateImage, EN.menu.translateImage, "not the English string");

  browser("vi-VN", []);
  assert.equal(applyLocale("auto"), "vi", "the region is dropped when only the language is supported");

  browser("en-GB", ["vi"]);
  assert.equal(applyLocale("auto"), "en", "the UI language comes before the preferred languages");
  assert.equal(msg(), EN);
  assert.equal(msg().menu.translateImage, EN.menu.translateImage);
});

test("auto falls back to the preferred languages when the UI language is unsupported or unavailable", () => {
  browser("xx-XX", ["xx", "vi-VN", "en"]);
  assert.deepEqual(contextLanguages(), ["xx-XX", "xx", "vi-VN", "en"]);
  assert.equal(applyLocale("auto"), "vi");

  browser(() => {
    throw new Error("i18n unavailable");
  }, ["vi"]);
  assert.deepEqual(contextLanguages(), ["vi"]);
  assert.equal(applyLocale("auto"), "vi", "a throwing chrome.i18n is ignored");

  browser(null, ["vi-VN"]);
  assert.deepEqual(contextLanguages(), ["vi-VN"], "no chrome global at all (e.g. a plain page)");
  assert.equal(applyLocale("auto"), "vi");

  browser("vi", ["vi", "en"]);
  assert.deepEqual(contextLanguages(), ["vi", "en"], "duplicates are listed once");
  assert.equal(applyLocale(""), "vi", "an empty setting behaves like auto");
});

test("an explicit locale wins over the browser languages", () => {
  browser("vi", ["vi-VN"]);
  assert.equal(applyLocale("en"), "en");
  assert.equal(msg(), EN);
  assert.equal(msg().popup.consentHint, EN.popup.consentHint);

  browser("en-US", ["en"]);
  assert.equal(applyLocale("vi"), "vi");
  assert.equal(msg().popup.consentHint, VI.popup.consentHint);
  assert.notEqual(msg().popup.consentHint, EN.popup.consentHint);
  assert.equal(applyLocale("vi-VN"), "vi", "a regional code resolves to its language");
  assert.equal(applyLocale("VI_vn"), "vi", "case and underscores are normalized");
});

test("unsupported locales end in English; msg() switches with every call", () => {
  browser("xx-XX", ["yy-YY", "zz"]);
  assert.equal(applyLocale("auto"), "en");
  assert.equal(msg(), EN);

  assert.equal(applyLocale("vi"), "vi");
  assert.equal(msg().menu.retranslateImage, VI.menu.retranslateImage);
  assert.notEqual(msg().menu.retranslateImage, EN.menu.retranslateImage);
  assert.equal(applyLocale("qq"), "en", "an unsupported explicit code with unsupported browser languages");
  assert.equal(msg().menu.retranslateImage, EN.menu.retranslateImage);
  assert.equal(currentLocale(), "en");

  browser("vi", []);
  assert.equal(
    applyLocale("qq"),
    "vi",
    "an unsupported explicit code falls back to the browser language before English",
  );
});
