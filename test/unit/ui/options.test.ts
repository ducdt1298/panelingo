import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { onMessageFor } from "../../../src/platform/messaging.ts";
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  migrateSite,
  type Settings,
  type SiteSettings,
} from "../../../src/shared/settings.ts";
import { SETTINGS_VERSION } from "../../../src/shared/versions.ts";
import { swAllow, swHandlers } from "../../../src/sw/router.ts";
import { onStorageChanged } from "../../../src/sw/settings-relay.ts";
import {
  clearCache,
  deleteSite,
  saveApi,
  saveLanguages,
  saveLogLevel,
  updateSite,
} from "../../../src/ui/options/options-actions.ts";
import {
  API_PRESETS,
  CONCURRENCY_CHOICES,
  debugLogFileName,
  formatDateTime,
  LOG_LEVELS,
  parseBaseUrl,
  parseConcurrency,
  parseModel,
  presetFor,
  siteRows,
} from "../../../src/ui/options/options-model.ts";
import { callCount, startBrowser, stopBrowser, until } from "../sw/sw-helpers.ts";

afterEach(stopBrowser);

describe("options model", () => {
  test("API presets: unique ids, normalized base URLs, OpenAI first and matching the defaults", () => {
    assert.deepEqual(
      API_PRESETS.map((preset) => preset.id),
      ["openai", "openrouter", "gemini", "ollama", "lmstudio", "vllm"],
    );
    assert.equal(new Set(API_PRESETS.map((preset) => preset.baseUrl)).size, API_PRESETS.length);
    for (const preset of API_PRESETS) {
      assert.equal(parseBaseUrl(preset.baseUrl), preset.baseUrl, `${preset.id} is already normalized`);
      assert.notEqual(preset.label.trim(), "", preset.id);
      if (preset.model !== "") assert.equal(parseModel(preset.model), preset.model, preset.id);
      const local = new URL(preset.baseUrl).hostname === "127.0.0.1";
      assert.equal(preset.needsKey, !local, `${preset.id}: cloud providers need a key, local servers do not`);
    }
    const openai = API_PRESETS[0];
    assert.deepEqual(
      [openai?.baseUrl, openai?.model],
      [DEFAULT_SETTINGS.api.baseUrl, DEFAULT_SETTINGS.api.model],
    );
  });

  test("presetFor: the preset whose base URL matches (spaces and trailing slashes ignored), else custom", () => {
    for (const preset of API_PRESETS) assert.equal(presetFor(preset.baseUrl), preset, preset.id);
    assert.equal(presetFor(DEFAULT_SETTINGS.api.baseUrl)?.id, "openai");
    assert.equal(presetFor(" http://127.0.0.1:11434/v1/ ")?.id, "ollama");
    assert.equal(presetFor("https://openrouter.ai/api/v1//")?.id, "openrouter");
    assert.equal(presetFor("https://generativelanguage.googleapis.com/v1beta/openai")?.id, "gemini");
    for (const custom of [
      "https://my-proxy.example/v1",
      "http://127.0.0.1:11435/v1",
      "https://api.openai.com/v2",
      "",
    ]) {
      assert.equal(presetFor(custom), null, custom);
    }
  });

  test("parseBaseUrl keeps the version path, normalizes a bare origin to /v1 and strips trailing slashes", () => {
    const cases: Array<[string, string]> = [
      ["https://api.openai.com/v1", "https://api.openai.com/v1"],
      [" http://127.0.0.1:11434/v1/ ", "http://127.0.0.1:11434/v1"],
      ["http://localhost:1234/v1//", "http://localhost:1234/v1"],
      ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1"],
      [
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        "https://generativelanguage.googleapis.com/v1beta/openai",
      ],
      ["https://api.openai.com", "https://api.openai.com/v1"],
      ["https://api.openai.com/", "https://api.openai.com/v1"],
      ["http://192.168.1.20:8000", "http://192.168.1.20:8000/v1"],
      ["HTTPS://API.Example.TEST/v1", "https://api.example.test/v1"],
    ];
    for (const [input, expected] of cases) assert.equal(parseBaseUrl(input), expected, input);
  });

  test("parseBaseUrl rejects non-http(s) schemes, garbage, credentials, queries, fragments and 0.0.0.0", () => {
    for (const bad of [
      "",
      "   ",
      "not a url",
      "api.openai.com/v1",
      "127.0.0.1:11434",
      "localhost:11434",
      "ftp://127.0.0.1:11434/v1",
      "file:///C:/v1",
      "javascript:alert(1)",
      "chrome-extension://abc/v1",
      "http://0.0.0.0:11434/v1",
      "http://user:pw@127.0.0.1:11434/v1",
      "https://api.openai.com/v1?key=1",
      "https://api.openai.com/v1#models",
    ]) {
      assert.equal(parseBaseUrl(bad), null, bad);
    }
  });

  test("parseModel trims and rejects empty ids or ids with whitespace inside", () => {
    assert.deepEqual(
      [" gpt-4o-mini ", "qwen2.5vl:7b", "openai/gpt-4o-mini", "\tgemini-2.5-flash\n"].map(parseModel),
      ["gpt-4o-mini", "qwen2.5vl:7b", "openai/gpt-4o-mini", "gemini-2.5-flash"],
    );
    for (const bad of ["", "   ", "\n", "gpt 4o", "gpt-4o\tmini"]) {
      assert.equal(parseModel(bad), null, JSON.stringify(bad));
    }
  });

  test("parseConcurrency: integers 1..4 only", () => {
    assert.deepEqual(CONCURRENCY_CHOICES, [1, 2, 3, 4]);
    assert.deepEqual(["1", " 2 ", "4"].map(parseConcurrency), [1, 2, 4]);
    for (const bad of ["0", "5", "2.5", "", "x", "-1"]) assert.equal(parseConcurrency(bad), null, bad);
  });

  test("siteRows: enabled first, then alphabetical; log levels", () => {
    const rows = siteRows({
      "https://b.example": migrateSite({ enabled: false, addedAt: 2 }, 0),
      "https://c.example": migrateSite({ enabled: true, mode: "manual", addedAt: 3 }, 0),
      "https://a.example": migrateSite({ enabled: false, addedAt: 1 }, 0),
    });
    assert.deepEqual(
      rows.map((row) => [row.siteKey, row.enabled, row.mode]),
      [
        ["https://c.example", true, "manual"],
        ["https://a.example", false, "auto"],
        ["https://b.example", false, "auto"],
      ],
    );
    assert.deepEqual(LOG_LEVELS, ["debug", "info", "warn", "error"]);
  });

  test("formatDateTime: medium date and short time in the UI locale (English by default); ISO when Intl fails", () => {
    const date = new Date(2026, 9, 10, 9, 5);
    const english = formatDateTime(date);
    assert.equal(formatDateTime(date, "en"), english);
    assert.match(english, /^Oct 10, 2026, 9:05\sAM$/u);
    const vietnamese = formatDateTime(date, "vi");
    assert.notEqual(vietnamese, english);
    assert.match(vietnamese, /2026/u);
    assert.match(vietnamese, /09:05|9:05/u);
    assert.equal(formatDateTime(date, "not a locale!"), date.toISOString(), "an invalid locale tag");
  });

  test("debugLogFileName: an ISO time stamp without characters Windows forbids in file names", () => {
    const name = debugLogFileName(new Date(Date.UTC(2026, 9, 10, 9, 5, 7, 42)));
    assert.match(name, /^[a-z0-9-]+-debug-2026-10-10T09-05-07-042Z\.json$/u);
    assert.doesNotMatch(name, /[<>:"/\\|?*]/u);
  });
});

describe("options actions", () => {
  test("saveApi writes settings.api (other settings kept); the SW re-installs the guard for the new endpoint", async () => {
    const { browser, sw } = await startBrowser();
    browser.storageSet("local", {
      settings: migrateSettings({
        ui: { locale: "vi" },
        api: { temperature: 0.7, urgentLane: false },
        translate: { targetLang: "es" },
      }),
    });
    sw.run(() => chrome.storage.onChanged.addListener(onStorageChanged));
    const options = browser.openExtensionPage("options", "ui/options.html");
    const form = {
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-local",
      model: "qwen2.5vl:7b",
      concurrency: 3,
    };
    const saved = await options.run(() => saveApi(form));
    const expectedApi: Settings["api"] = {
      ...DEFAULT_SETTINGS.api,
      ...form,
      temperature: 0.7,
      urgentLane: false,
    };
    assert.deepEqual(saved.api, expectedApi);
    const stored = browser.storageGet("local", "settings") as Settings;
    assert.deepEqual(stored.api, expectedApi);
    assert.equal(stored.schemaVersion, SETTINGS_VERSION);
    assert.deepEqual([stored.ui.locale, stored.translate.targetLang], ["vi", "es"], "other sections kept");
    await until(
      () => browser.sessionRules.some((rule) => rule.condition.urlFilter === "|http://127.0.0.1:11434/"),
      "guard allow rule for the new endpoint",
    );
  });

  test("saveApi stores the migrated values: a bare origin gets /v1, concurrency is clamped", async () => {
    const { browser } = await startBrowser();
    const options = browser.openExtensionPage("options", "ui/options.html");
    const saved = await options.run(() =>
      saveApi({ baseUrl: "https://api.example.test", apiKey: "", model: "m", concurrency: 9 }),
    );
    assert.deepEqual(
      [saved.api.baseUrl, saved.api.apiKey, saved.api.model, saved.api.concurrency],
      ["https://api.example.test/v1", "", "m", 4],
    );
    assert.deepEqual((browser.storageGet("local", "settings") as Settings).api, saved.api);
  });

  test("saveLanguages writes ui.locale and translate.targetLang only; saveLogLevel writes debug.logLevel", async () => {
    const { browser } = await startBrowser();
    const options = browser.openExtensionPage("options", "ui/options.html");
    await options.run(() =>
      saveApi({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "x/y", concurrency: 2 }),
    );
    const saved = await options.run(() => saveLanguages("vi", "pt-br"));
    assert.deepEqual([saved.ui.locale, saved.translate.targetLang], ["vi", "pt-br"]);
    await options.run(() => saveLogLevel("debug"));
    const stored = browser.storageGet("local", "settings") as Settings;
    assert.deepEqual(stored.ui, { locale: "vi" });
    assert.deepEqual(stored.translate, { ...DEFAULT_SETTINGS.translate, targetLang: "pt-br" });
    assert.equal(stored.debug.logLevel, "debug");
    assert.deepEqual(
      [stored.api.baseUrl, stored.api.model],
      ["https://openrouter.ai/api/v1", "x/y"],
      "the API section is untouched",
    );
    await options.run(() => saveLanguages("auto", "auto"));
    const back = browser.storageGet("local", "settings") as Settings;
    assert.deepEqual([back.ui.locale, back.translate.targetLang], ["auto", "auto"]);
  });

  test("site edits go through sw:site-set (registration synced before it answers); removal through storage", async () => {
    const { browser, sw } = await startBrowser();
    sw.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
    sw.run(() => chrome.storage.onChanged.addListener(onStorageChanged));
    const options = browser.openExtensionPage("options", "ui/options.html");
    assert.equal(await options.run(() => updateSite("https://reader.example", { enabled: true })), true);
    assert.equal(browser.registeredScripts.size, 1, "registered when sw:site-set answers");
    assert.equal(await options.run(() => updateSite("https://reader.example", { mode: "manual" })), true);
    assert.equal((browser.storageGet("local", "site:https://reader.example") as SiteSettings).mode, "manual");
    await options.run(() => updateSite("https://reader.example", { includeSubdomains: true }));
    assert.deepEqual(browser.registeredScripts.get("ctv-main")?.matches, ["https://*.reader.example/*"]);
    await options.run(() => deleteSite("https://reader.example"));
    assert.equal(browser.storageGet("local", "site:https://reader.example"), undefined);
    await until(() => browser.registeredScripts.size === 0, "unregistered");
  });

  test("clearCache starts the engine (explicit action) and returns the deleted count", async () => {
    const scopes: string[] = [];
    const { browser, sw } = await startBrowser({
      onOffscreenCreated: () => {
        onMessageFor("engine", {
          "en:cache-clear": (payload) => {
            scopes.push(payload.scope);
            return { deletedRecords: 17 };
          },
        });
      },
    });
    sw.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
    const options = browser.openExtensionPage("options", "ui/options.html");
    assert.equal(await options.run(() => clearCache()), 17);
    assert.deepEqual(scopes, ["all"]);
    assert.equal(callCount(browser, "offscreen.createDocument"), 1);
  });
});
