// UI catalogs (src/shared/i18n): every bundled locale is complete and shaped like English, its functions follow
// the language's plural rules with English's numbers, browser language codes resolve to the right catalog, and the
// Chrome _locales messages built from the catalogs stay inside Chrome's limits.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allManifestMessages, chromeLocaleDir, manifestMessages } from "../../../src/manifest.ts";
import { EN } from "../../../src/shared/i18n/en.ts";
import {
  browserLanguages,
  catalogFor,
  currentLocale,
  msg,
  registeredCatalog,
  resolveLocale,
  setLocale,
  uiLocales,
} from "../../../src/shared/i18n/index.ts";

/** Bundled locales with their own names, in picker order (English first, then by code). */
const BUNDLED: ReadonlyArray<readonly [code: string, name: string]> = [
  ["en", "English"],
  ["de", "Deutsch"],
  ["es", "Español"],
  ["fr", "Français"],
  ["id", "Bahasa Indonesia"],
  ["it", "Italiano"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["pl", "Polski"],
  ["pt-br", "Português (Brasil)"],
  ["ru", "Русский"],
  ["th", "ไทย"],
  ["tr", "Türkçe"],
  ["vi", "Tiếng Việt"],
  ["zh-cn", "简体中文"],
  ["zh-tw", "繁體中文"],
];
const TRANSLATED = BUNDLED.map(([code]) => code).filter((code) => code !== "en");

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------------------------
// Helpers

type Fn = (...args: readonly unknown[]) => unknown;

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every leaf of a catalog by path ("errors/api.unreachable/title", arrays by index); functions are leaves. */
function leaves(node: unknown, path = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (isPlain(node)) {
    for (const [key, value] of Object.entries(node)) leaves(value, path === "" ? key : `${path}/${key}`, out);
  } else if (Array.isArray(node)) {
    node.forEach((value, index) => leaves(value, `${path}[${index}]`, out));
  } else {
    out.set(path, node);
  }
  return out;
}

function stringLeaves(node: unknown): Array<[string, string]> {
  return [...leaves(node)].filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function call(catalog: unknown, path: string, args: readonly unknown[]): string {
  const fn = leaves(catalog).get(path);
  assert.equal(typeof fn, "function", path);
  const out = (fn as Fn)(...args);
  assert.equal(typeof out, "string", `${path}(${args.join(", ")})`);
  return out as string;
}

/** The digit runs of a text, as a sorted multiset ("Queue: 1 waiting · 21 failed" → ["1", "21"]). */
function numbers(text: string): string[] {
  return (text.match(/\d+/gu) ?? []).sort();
}

/** The text with the number n replaced by "#", to compare the grammatical form around different counts. */
function shape(text: string, n: number): string {
  return text.replace(new RegExp(`(?<!\\d)${n}(?!\\d)`, "gu"), "#");
}

const EN_LEAVES = leaves(EN);

const COUNTS = [0, 1, 2, 3, 4, 5, 11, 12, 13, 14, 21, 22, 25, 101, 111, 112];

/** Sample arguments for every function in the catalogs (keys are leaf paths). */
const SAMPLES: Record<string, ReadonlyArray<readonly unknown[]>> = {
  "ui/uploadsToday": [...COUNTS.map((n) => [n, 7.8]), [1, 0], [2, 0.04], [3, 12.25]],
  "ui/progress": [
    [0, 0],
    [1, 2],
    [2, 5, 12.4],
    [5, 21, 0.2],
    [21, 21, 3_600],
    [1, 2, Number.POSITIVE_INFINITY],
    [1, 2, Number.NaN],
  ],
  duration: [
    0,
    400,
    SECOND,
    59_400,
    59_600,
    89_999,
    61 * SECOND,
    59 * MINUTE,
    HOUR,
    7_200_000,
    47 * HOUR,
    48 * HOUR,
    5 * DAY,
    21 * DAY,
    -90 * SECOND,
  ].map((ms) => [ms]),
  "popup/model": [["gpt-4o-mini"]],
  "sidepanel/page": [[1], [2], [12], [101]],
  "sidepanel/glossary/seen": COUNTS.map((n) => [n]),
  "sidepanel/glossary/imported": COUNTS.map((n) => [n]),
  "popup/endpoint": [["https://api.example.com/v1"]],
  "popup/cause": [["HTTP 401"]],
  "popup/detectorLine": [
    ["GPU (WebGPU)", "ready", "GPU verified"],
    ["CPU (WASM)", "loading", ""],
  ],
  "popup/queueLine": [
    [0, 0, 0, 0],
    [1, 2, 5, 21],
    [3, 1, 12, 0],
  ],
  "popup/pausedBy": [["Rate limited"]],
  "popup/offlineDownload": [
    [0, 115],
    [12.4, 115.2],
    [910, 910],
  ],
  "popup/offlineModels": [["ocr-korean, opus-mt-ko-en"]],
  "offline/stored": [[0], [115.3], [1024]],
  "popup/visibleSent": COUNTS.map((n) => [n]),
  "popup/retranslateQueued": COUNTS.map((n) => [n]),
  "popup/actionFailed": [["Boom"]],
  "popup/build": [["0.1.0+abc123"]],
  "options/testOk": [["2 models"]],
  "options/testFailed": [["HTTP 404"]],
  "options/privacyAcked": [["2026-10-11 09:30"]],
  "options/cacheCleared": COUNTS.map((n) => [n]),
  "options/cacheFailed": [["QuotaExceededError"]],
  "optionsAdvanced/defaultIs": [["0.2"], ["Backquote"]],
  "optionsAdvanced/range": [
    ["0", "2"],
    ["0.5", "30"],
  ],
  "optionsAdvanced/resetLabel": [["Temperature"]],
  "optionsAdvanced/adjusted": [["120"], ["0.5"]],
  "optionsAdvanced/site/settingsFor": [["https://reader.example.com"]],
  "optionsAdvanced/site/framesInvalid": [["ftp://cdn.example.com, not a url"]],
  "optionsAdvanced/transfer/imported": [
    [0, 0],
    [1, 2],
    [21, 5],
  ],
};

/** CLDR cardinal plural categories (integers only) of each bundled language. */
type PluralRule = (n: number) => "one" | "few" | "many" | "other";
const oneOther: PluralRule = (n) => (n === 1 ? "one" : "other");
const noPlural: PluralRule = () => "other";
const slavicFew = (n: number): boolean => [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100);
const PLURAL: Record<string, PluralRule> = {
  en: oneOther,
  de: oneOther,
  es: oneOther,
  it: oneOther,
  "pt-br": oneOther,
  fr: (n) => (n === 0 || n === 1 ? "one" : "other"),
  ru: (n) => (n % 10 === 1 && n % 100 !== 11 ? "one" : slavicFew(n) ? "few" : "many"),
  pl: (n) => (n === 1 ? "one" : slavicFew(n) ? "few" : "many"),
  id: noPlural,
  ja: noPlural,
  ko: noPlural,
  th: noPlural,
  tr: noPlural,
  vi: noPlural,
  "zh-cn": noPlural,
  "zh-tw": noPlural,
};

/** Count-taking texts whose wording must follow the plural category (n → the text for n). */
const COUNTED: ReadonlyArray<[label: string, text: (catalog: unknown, n: number) => string, min: number]> = [
  ["ui.uploadsToday", (catalog, n) => call(catalog, "ui/uploadsToday", [n, 7.8]), 0],
  ["popup.retranslateQueued", (catalog, n) => call(catalog, "popup/retranslateQueued", [n]), 0],
  ["options.cacheCleared", (catalog, n) => call(catalog, "options/cacheCleared", [n]), 0],
  ["popup.visibleSent", (catalog, n) => call(catalog, "popup/visibleSent", [n]), 1],
  ["sidepanel.glossary.imported", (catalog, n) => call(catalog, "sidepanel/glossary/imported", [n]), 0],
];

/** Groups the forms of a counted text by plural category: category → distinct shapes seen. */
function formsByCategory(
  rule: PluralRule,
  text: (n: number) => string,
  counts: readonly number[],
): Map<string, Set<string>> {
  const forms = new Map<string, Set<string>>();
  for (const n of counts) {
    const category = rule(n);
    const seen = forms.get(category) ?? new Set<string>();
    seen.add(shape(text(n), n));
    forms.set(category, seen);
  }
  return forms;
}

/** Names, URLs, ids and commands that every translation keeps verbatim wherever English has them. */
const VERBATIM = [
  "Panelingo",
  "OpenAI",
  "OpenRouter",
  "Azure OpenAI",
  "Google Gemini",
  "Ollama",
  "LM Studio",
  "vLLM",
  "LiteLLM",
  "WebGPU",
  "WASM",
  "GPU",
  "CPU",
  "JPEG",
  "IndexedDB",
  "Referer",
  "http(s)",
  "http/https",
  "https://api.openai.com/v1",
  "http://127.0.0.1:11434/v1",
  "gpt-4o-mini",
  "gemini-2.5-flash",
  "qwen2.5-vl",
  "npm run fetch-models",
  "npm run build",
  "→",
  "Hugging Face",
  "huggingface.co",
  "PaddleOCR",
  "Opus-MT",
  "NLLB-200",
  "Apache-2.0",
  "CC-BY-4.0",
  "CC-BY-NC-4.0",
];

/** Strings a translation may legitimately leave identical to English (names and technical labels). */
const MAY_MATCH_ENGLISH = new Set(["ui/appName", "detectorBackend/webgpu", "detectorBackend/wasm"]);

// ---------------------------------------------------------------------------------------------------------------

describe("bundled locales", () => {
  test("registered: English first, then by code, each with its own name", () => {
    assert.deepEqual(
      uiLocales().map(({ code, name }) => [code, name]),
      BUNDLED.map(([code, name]) => [code, name]),
    );
  });

  test("every bundled language has a plural rule in this test", () => {
    for (const [code] of BUNDLED) assert.ok(code in PLURAL, code);
  });

  test("every function of the English catalog has sample inputs in this test", () => {
    const functions = [...EN_LEAVES].filter(([, value]) => typeof value === "function").map(([path]) => path);
    assert.deepEqual(functions.sort(), Object.keys(SAMPLES).sort());
  });

  test("English is registered as is (the reference)", () => {
    assert.equal(registeredCatalog("en"), EN);
    assert.equal(catalogFor("en"), EN);
  });
});

for (const code of TRANSLATED) {
  describe(`catalog ${code}`, () => {
    const raw = registeredCatalog(code);
    const got = leaves(raw);

    test("has exactly the keys of English, with the same kinds of values", () => {
      assert.ok(isPlain(raw), "registered");
      const missing = [...EN_LEAVES.keys()].filter((path) => !got.has(path));
      const extra = [...got.keys()].filter((path) => !EN_LEAVES.has(path));
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
      const wrongKind = [...EN_LEAVES]
        .filter(([path, value]) => typeof got.get(path) !== typeof value)
        .map(([path]) => path);
      assert.deepEqual(wrongKind, []);
    });

    test("no empty text where English has text; tidy whitespace and punctuation", () => {
      for (const [path, text] of stringLeaves(raw)) {
        const english = EN_LEAVES.get(path);
        if (english !== "") assert.notEqual(text.trim(), "", `${path} is empty`);
        assert.equal(text, text.trim(), `${path} has outer whitespace`);
        assert.doesNotMatch(text, / {2}/u, `${path} has a double space`);
        assert.doesNotMatch(text, /\.\.\./u, `${path}: use "…", not "..."`);
        assert.doesNotMatch(text, /undefined|\[object /u, path);
      }
      // popup.detectorLine leaves the parenthesis out exactly when the canary text is empty.
      assert.equal(got.get("detectorCanary/skipped"), "");
    });

    test("keeps product names, URLs, model ids and commands verbatim", () => {
      for (const [path, english] of stringLeaves(EN)) {
        const text = got.get(path);
        for (const token of VERBATIM) {
          if (english.includes(token)) assert.ok(String(text).includes(token), `${path} lost "${token}"`);
        }
      }
      assert.equal(got.get("ui/appName"), "Panelingo");
      assert.match(String(got.get("sidepanel/title")), /^Panelingo – \S/u);
    });

    test("is translated (only names and technical labels may equal English)", () => {
      const same = stringLeaves(raw)
        .filter(([path, text]) => text !== "" && !MAY_MATCH_ENGLISH.has(path) && text === EN_LEAVES.get(path))
        .map(([path]) => path);
      const total = stringLeaves(EN).filter(([, text]) => text !== "").length;
      assert.ok(
        same.length <= total * 0.08,
        `${same.length}/${total} identical to English: ${same.join(", ")}`,
      );
    });

    test("functions: same arity as English, non-empty text that keeps every argument", () => {
      for (const [path, samples] of Object.entries(SAMPLES)) {
        const fn = got.get(path);
        assert.equal(typeof fn, "function", path);
        assert.equal((fn as Fn).length, (EN_LEAVES.get(path) as Fn).length, `${path} arity`);
        for (const args of samples) {
          const text = call(raw, path, args);
          const label = `${path}(${args.join(", ")}) → ${JSON.stringify(text)}`;
          assert.notEqual(text.trim(), "", label);
          assert.doesNotMatch(text, /undefined|NaN|Infinity|\[object |\$\{/u, label);
          for (const arg of args) {
            if (typeof arg === "string" && arg !== "")
              assert.ok(text.includes(arg), `${label} lost "${arg}"`);
          }
        }
      }
    });

    test("functions show the same numbers as English (same rounding and thresholds)", () => {
      for (const [path, samples] of Object.entries(SAMPLES)) {
        for (const args of samples) {
          const text = call(raw, path, args);
          const english = call(EN, path, args);
          assert.deepEqual(numbers(text), numbers(english), `${path}(${args.join(", ")}) → ${text}`);
        }
      }
    });

    test("duration uses a distinct unit for seconds, minutes, hours and days", () => {
      const units = [5 * SECOND, 5 * MINUTE, 5 * HOUR, 5 * DAY].map((ms) =>
        shape(call(raw, "duration", [ms]), 5),
      );
      assert.equal(new Set(units).size, 4, units.join(" | "));
      assert.equal(call(raw, "duration", [-90 * SECOND]), call(raw, "duration", [90 * SECOND]));
    });
  });
}

describe("plural forms follow each language's CLDR categories", () => {
  for (const [code] of BUNDLED) {
    test(code, () => {
      const catalog = catalogFor(code);
      const rule = PLURAL[code] ?? noPlural;
      for (const [label, text, min] of COUNTED) {
        const counts = COUNTS.filter((n) => n >= min);
        const forms = formsByCategory(rule, (n) => text(catalog, n), counts);
        for (const [category, seen] of forms) {
          assert.equal(
            seen.size,
            1,
            `${code} ${label}: "${category}" counts use different forms: ${[...seen].join(" | ")}`,
          );
        }
        const all = new Set([...forms.values()].flatMap((seen) => [...seen]));
        assert.equal(
          all.size,
          forms.size,
          `${code} ${label}: categories must differ: ${[...all].join(" | ")}`,
        );
      }
      // Days: the same category always gets the same word (some languages share a form between categories).
      const days = formsByCategory(
        rule,
        (n) => catalog.duration(n * DAY),
        COUNTS.filter((n) => n >= 2),
      );
      for (const [category, seen] of days) {
        assert.equal(
          seen.size,
          1,
          `${code} duration: "${category}" days use different forms: ${[...seen].join(" | ")}`,
        );
      }
    });
  }

  test("English texts", () => {
    assert.equal(EN.options.cacheCleared(0), "Deleted 0 records.");
    assert.equal(EN.options.cacheCleared(1), "Deleted 1 record.");
    assert.equal(EN.popup.retranslateQueued(2), "Queued 2 bubbles again.");
    assert.equal(EN.popup.visibleSent(0), "No comic images visible.");
    assert.equal(EN.popup.visibleSent(1), "Sent 1 image for translation.");
    assert.equal(EN.ui.uploadsToday(1, 0.04), "Sent 1 composite image (0.0 MB) to the AI today");
    assert.equal(EN.ui.uploadsToday(3, 12.25), "Sent 3 composite images (12.3 MB) to the AI today");
  });

  test("Russian and Polish differ at 21 and agree at 22", () => {
    const ru = catalogFor("ru").options.cacheCleared;
    const pl = catalogFor("pl").options.cacheCleared;
    assert.equal(shape(ru(21), 21), shape(ru(1), 1));
    assert.equal(shape(ru(22), 22), shape(ru(2), 2));
    assert.equal(shape(ru(11), 11), shape(ru(5), 5));
    assert.equal(shape(pl(21), 21), shape(pl(5), 5));
    assert.equal(shape(pl(22), 22), shape(pl(2), 2));
    assert.notEqual(shape(pl(1), 1), shape(pl(21), 21));
  });

  test("French counts 0 as singular", () => {
    const fr = catalogFor("fr").options.cacheCleared;
    assert.equal(shape(fr(0), 0), shape(fr(1), 1));
    assert.notEqual(shape(fr(2), 2), shape(fr(1), 1));
  });
});

describe("duration", () => {
  test("English thresholds and rounding", () => {
    const cases: Array<[number, string]> = [
      [0, "0 s"],
      [400, "0 s"],
      [59_400, "59 s"],
      [59_600, "1 min"],
      [89_999, "2 min"],
      [59 * MINUTE, "59 min"],
      [HOUR, "1 h"],
      [47 * HOUR, "47 h"],
      [48 * HOUR, "2 days"],
      [21 * DAY, "21 days"],
      [-61 * SECOND, "1 min"],
    ];
    for (const [ms, text] of cases) assert.equal(EN.duration(ms), text, String(ms));
  });

  test("every locale: exactly one number, no outer whitespace", () => {
    for (const [code] of BUNDLED) {
      for (const ms of [0, 5 * SECOND, 5 * MINUTE, 5 * HOUR, 21 * DAY]) {
        const text = catalogFor(code).duration(ms);
        assert.match(text, /^\S.*\S$/u, `${code} ${ms}`);
        assert.equal(numbers(text).length, 1, `${code} ${ms} → ${text}`);
      }
    }
  });
});

describe("resolveLocale", () => {
  const auto = (...languages: string[]): string => resolveLocale("auto", languages);

  test("auto with no browser languages → English", () => {
    assert.equal(auto(), "en");
    assert.equal(resolveLocale("", []), "en");
  });

  test("exact codes, case and separator insensitive", () => {
    assert.equal(auto("vi"), "vi");
    assert.equal(auto("pt-BR"), "pt-br");
    assert.equal(auto("pt_BR"), "pt-br");
    assert.equal(auto("zh-CN"), "zh-cn");
    assert.equal(auto("zh_TW"), "zh-tw");
    assert.equal(auto("ZH-tw"), "zh-tw");
  });

  test("region fallback to the language", () => {
    const cases: Array<[string, string]> = [
      ["es-419", "es"],
      ["es-MX", "es"],
      ["es-ES", "es"],
      ["ja-JP", "ja"],
      ["ko-KR", "ko"],
      ["de-AT", "de"],
      ["de-CH", "de"],
      ["fr-CA", "fr"],
      ["it-IT", "it"],
      ["id-ID", "id"],
      ["ru-RU", "ru"],
      ["pl-PL", "pl"],
      ["tr-TR", "tr"],
      ["th-TH", "th"],
      ["vi-VN", "vi"],
      ["en-GB", "en"],
      ["en-US", "en"],
    ];
    for (const [browser, expected] of cases) assert.equal(auto(browser), expected, browser);
  });

  test("Portuguese without Brazil and Chinese variants map to the closest catalog", () => {
    const cases: Array<[string, string]> = [
      ["pt", "pt-br"],
      ["pt-PT", "pt-br"],
      ["zh", "zh-cn"],
      ["zh-SG", "zh-cn"],
      ["zh-Hans", "zh-cn"],
      ["zh-Hans-CN", "zh-cn"],
      ["zh-HK", "zh-tw"],
      ["zh_HK", "zh-tw"],
      ["zh-MO", "zh-tw"],
      ["zh-Hant", "zh-tw"],
      ["zh-Hant-TW", "zh-tw"],
      ["zh-Hant-HK", "zh-tw"],
      ["in", "id"], // legacy Indonesian code
    ];
    for (const [browser, expected] of cases) assert.equal(auto(browser), expected, browser);
  });

  test("browser languages in order of preference; unsupported ones are skipped", () => {
    assert.equal(auto("nl-NL", "fr-FR", "de"), "fr");
    assert.equal(auto("sv", "nb", "da"), "en");
    assert.equal(auto("xx", "ko"), "ko");
    assert.equal(auto("", "ja"), "ja");
    assert.equal(auto("en-US", "vi"), "en");
  });

  test("an explicit setting wins over the browser", () => {
    assert.equal(resolveLocale("ja", ["fr-FR", "de"]), "ja");
    assert.equal(resolveLocale("pt-br", ["es"]), "pt-br");
    assert.equal(resolveLocale("zh-TW", ["zh-CN"]), "zh-tw");
    assert.equal(resolveLocale("en", ["vi"]), "en");
  });

  test("an unknown setting falls back to the browser, then English", () => {
    assert.equal(resolveLocale("xx", ["fr"]), "fr");
    assert.equal(resolveLocale("xx", []), "en");
  });

  test("every listed code resolves to itself", () => {
    for (const { code } of uiLocales()) assert.equal(resolveLocale(code, ["en"]), code);
  });
});

describe("catalogFor / setLocale / msg", () => {
  test("region variants share the cached catalog; unknown codes get English", () => {
    assert.equal(catalogFor("ja-JP"), catalogFor("ja"));
    assert.equal(catalogFor("pt_BR"), catalogFor("pt-br"));
    assert.equal(catalogFor("xx"), EN);
  });

  test("a complete catalog merges to itself (nothing taken from English)", () => {
    for (const code of TRANSLATED) {
      const raw = stringLeaves(registeredCatalog(code));
      const full = leaves(catalogFor(code));
      for (const [path, text] of raw) assert.equal(full.get(path), text, `${code} ${path}`);
    }
  });

  test("setLocale picks the context's catalog for msg()", () => {
    try {
      assert.equal(setLocale("auto", ["ja-JP", "en"]), "ja");
      assert.equal(currentLocale(), "ja");
      assert.equal(msg(), catalogFor("ja"));
      assert.equal(setLocale("de", ["ja"]), "de");
      assert.equal(msg().options.title, catalogFor("de").options.title);
    } finally {
      setLocale("en");
    }
    assert.equal(msg(), EN);
  });

  test("browserLanguages: UI language first, then the preferred list without duplicates", () => {
    assert.deepEqual(browserLanguages({ uiLanguage: "pt-BR", languages: ["pt-BR", "en-US", "en"] }), [
      "pt-BR",
      "en-US",
      "en",
    ]);
    assert.deepEqual(browserLanguages({ uiLanguage: "", languages: ["ko"] }), ["ko"]);
    assert.deepEqual(browserLanguages({}), []);
  });
});

describe("Chrome _locales messages", () => {
  /** Locale folder names the Chrome Web Store and Chrome accept. */
  const CHROME_LOCALES = new Set(
    (
      "ar am bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu he hi hr hu id it ja kn ko lt " +
      "lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk vi zh_CN zh_TW"
    ).split(" "),
  );

  test("folder names", () => {
    assert.equal(chromeLocaleDir("en"), "en");
    assert.equal(chromeLocaleDir("pt-br"), "pt_BR");
    assert.equal(chromeLocaleDir("zh-cn"), "zh_CN");
    assert.equal(chromeLocaleDir("zh-tw"), "zh_TW");
  });

  test("one folder per bundled locale, all accepted by Chrome, English (default_locale) included", () => {
    const dirs = allManifestMessages().map(([dir]) => dir);
    assert.deepEqual(
      dirs,
      BUNDLED.map(([code]) => chromeLocaleDir(code)),
    );
    for (const dir of dirs) assert.ok(CHROME_LOCALES.has(dir), dir);
    assert.ok(dirs.includes("en"));
  });

  for (const [code] of BUNDLED) {
    test(`${code}: within Chrome's limits, nothing left unresolved`, () => {
      const messages = manifestMessages(catalogFor(code));
      const description = messages["extDescription"]?.message ?? "";
      const name = messages["extName"]?.message ?? "";
      assert.ok(
        description.length <= 132,
        `description has ${description.length} characters: ${description}`,
      );
      // The manifest appends " (test)" or " (dev)" to the name in non-prod builds.
      assert.ok(`${name} (test)`.length <= 75, name);
      assert.equal(name, "Panelingo");
      for (const [key, { message }] of Object.entries(messages)) {
        assert.match(key, /^[A-Za-z0-9_]+$/u, key);
        assert.notEqual(message.trim(), "", key);
        assert.doesNotMatch(message, /__MSG_/u, key);
        // "$" starts a Chrome message placeholder.
        assert.doesNotMatch(message, /\$/u, key);
      }
      if (code !== "en") assert.notEqual(description, EN.manifest.description, "description translated");
    });
  }
});
