import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_TARGET,
  effectiveTarget,
  isCjkTarget,
  resolveTargetLang,
  TARGET_LANGUAGES,
  targetLanguage,
} from "../../../src/shared/languages.ts";

describe("TARGET_LANGUAGES", () => {
  test("English first, Vietnamese second; unique lower-case codes with English and native names", () => {
    assert.equal(TARGET_LANGUAGES[0]?.code, "en");
    assert.equal(TARGET_LANGUAGES[1]?.code, "vi");
    const codes = TARGET_LANGUAGES.map((language) => language.code);
    assert.equal(new Set(codes).size, codes.length, "no duplicate codes");
    for (const language of TARGET_LANGUAGES) {
      assert.match(language.code, /^[a-z]{2}(?:-[a-z]{2})?$/u, language.code);
      assert.ok(language.englishName.trim() !== "", language.code);
      assert.ok(language.nativeName.trim() !== "", language.code);
    }
  });

  test("the names used in the prompt and the picker", () => {
    assert.deepEqual(targetLanguage("vi"), {
      code: "vi",
      englishName: "Vietnamese",
      nativeName: "Tiếng Việt",
      script: "latin",
      vertical: false,
    });
    assert.equal(targetLanguage("es")?.englishName, "Spanish");
    assert.equal(targetLanguage("pt-br")?.englishName, "Brazilian Portuguese");
    assert.equal(targetLanguage("xx"), undefined);
    assert.equal(targetLanguage("VI"), undefined, "exact codes only");
  });

  test("the default target is English", () => {
    assert.equal(DEFAULT_TARGET, "en");
  });
});

describe("resolveTargetLang", () => {
  test("an explicit supported setting wins over the browser languages", () => {
    assert.equal(resolveTargetLang("vi", ["en-US", "fr"]).code, "vi");
    assert.equal(resolveTargetLang("es", []).code, "es");
  });

  test("settings are matched case- and separator-insensitively, then without the region", () => {
    assert.equal(resolveTargetLang("PT_BR", []).code, "pt-br");
    assert.equal(resolveTargetLang("fr-CA", []).code, "fr", "region dropped");
    assert.equal(resolveTargetLang("pt-PT", []).code, "pt-br", "the only Portuguese variant");
  });

  test("auto (or empty) follows the first supported browser language", () => {
    assert.equal(resolveTargetLang("auto", ["vi-VN", "en-US"]).code, "vi");
    assert.equal(
      resolveTargetLang("auto", ["nl", "sv", "de-AT", "en"]).code,
      "de",
      "unsupported ones skipped",
    );
    assert.equal(resolveTargetLang("", ["es-419"]).code, "es");
    assert.equal(resolveTargetLang("auto", ["pt_BR"]).code, "pt-br");
  });

  test("an unsupported setting falls back to the browser languages, then English", () => {
    assert.equal(resolveTargetLang("klingon", ["it-IT"]).code, "it");
    assert.equal(resolveTargetLang("nl", ["sv-SE"]).code, "en");
    assert.equal(resolveTargetLang("auto", []).code, "en");
    assert.deepEqual(resolveTargetLang("auto", []), targetLanguage(DEFAULT_TARGET));
  });

  test("the result is one of the supported languages", () => {
    const result = resolveTargetLang("tr", []);
    assert.ok(TARGET_LANGUAGES.includes(result));
  });
});

describe("CJK targets", () => {
  test("Japanese, Simplified and Traditional Chinese and Korean come after the Latin-script languages", () => {
    const codes = TARGET_LANGUAGES.map((language) => language.code);
    assert.deepEqual(codes.slice(-4), ["ja", "zh-cn", "zh-tw", "ko"]);
    const firstCjk = TARGET_LANGUAGES.findIndex((language) => language.script === "cjk");
    assert.ok(TARGET_LANGUAGES.slice(firstCjk).every((language) => language.script === "cjk"));
    assert.deepEqual(
      ["ja", "zh-cn", "zh-tw", "ko"].map((code) => targetLanguage(code)?.englishName),
      ["Japanese", "Simplified Chinese", "Traditional Chinese", "Korean"],
    );
    assert.deepEqual(
      ["ja", "zh-cn", "zh-tw", "ko"].map((code) => targetLanguage(code)?.nativeName),
      ["日本語", "简体中文", "繁體中文", "한국어"],
    );
  });

  test("written top to bottom: Japanese and Traditional Chinese only", () => {
    assert.deepEqual(
      TARGET_LANGUAGES.filter((language) => language.vertical).map((language) => language.code),
      ["ja", "zh-tw"],
    );
    assert.equal(isCjkTarget("zh-cn"), true);
    assert.equal(isCjkTarget("vi"), false);
    assert.equal(isCjkTarget("xx"), false);
  });

  test("browser locales: Japanese and Korean by language, Chinese by script (Hant vs Hans)", () => {
    assert.equal(resolveTargetLang("auto", ["ja-JP"]).code, "ja");
    assert.equal(resolveTargetLang("auto", ["ko-KR"]).code, "ko");
    for (const traditional of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-HK", "zh_TW"]) {
      assert.equal(resolveTargetLang("auto", [traditional]).code, "zh-tw", traditional);
    }
    for (const simplified of ["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN"]) {
      assert.equal(resolveTargetLang("auto", [simplified]).code, "zh-cn", simplified);
    }
    assert.equal(resolveTargetLang("zh-tw", ["en"]).code, "zh-tw", "a setting picks the variant");
  });

  test("effectiveTarget: the setting, else the chosen UI language, else the browser languages", () => {
    assert.equal(effectiveTarget("ja", "vi", ["ko-KR"]).code, "ja");
    assert.equal(effectiveTarget("auto", "zh-tw", ["ko-KR"]).code, "zh-tw");
    assert.equal(effectiveTarget("auto", "auto", ["ko-KR"]).code, "ko");
    assert.equal(effectiveTarget("auto", "auto", []).code, "en");
  });
});
