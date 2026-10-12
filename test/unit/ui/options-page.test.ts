// The real Options entry (src/ui/options/options.ts) rendered into a fake DOM against the chrome fake: texts come
// from msg() in the locale chosen by settings.ui.locale (English by default); the endpoint form validates with
// parseBaseUrl / parseModel, saves settings.api and tests the connection with a fake fetch.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { catalogFor, msg, uiLocales, type Catalog } from "../../../src/shared/i18n/index.ts";
import { TARGET_LANGUAGES } from "../../../src/shared/languages.ts";
import type { Settings } from "../../../src/shared/settings.ts";
import { API_PRESETS, formatDateTime, LOG_LEVELS } from "../../../src/ui/options/options-model.ts";
import { until } from "../sw/sw-helpers.ts";
import type { FakeElement } from "./fake-dom.ts";
import { closePage, json, openPage, pillText, texts, type PageRun } from "./page-harness.ts";

afterEach(closePage);

const BASE_URL = "http://127.0.0.1:11434/v1";
const MODEL = "qwen2.5vl:7b";
const LISTED = { data: [{ id: MODEL }, { id: "llava:13b" }] };

async function openOptions(locale: string): Promise<PageRun> {
  return openPage({
    page: "options",
    ids: ["app"],
    settings: { ui: { locale }, api: { baseUrl: BASE_URL, model: MODEL } },
    answer: () => json(200, LISTED),
  });
}

function section(run: PageRun, id: string): FakeElement {
  const el = run.dom.byId("app").findById(id);
  if (el === null) throw new Error(`no section #${id}`);
  return el;
}

function control(run: PageRun, id: string): FakeElement {
  return section(run, "api").findById(id) ?? section(run, "languages").findById(id) ?? missing(id);
}

function missing(id: string): never {
  throw new Error(`no control #${id}`);
}

function message(container: FakeElement): string | undefined {
  return container.findAll("p").find((p) => p.className === "message")?.textContent;
}

/** Waits for the endpoint check, then checks the static texts of every section against catalog `t`. */
async function assertOptionsIn(run: PageRun, t: Catalog): Promise<void> {
  await until(() => {
    const status = run.dom.byId("app").findById("api");
    return status !== null && pillText(status) === t.readiness.ready.label;
  }, "options rendered");
  const api = section(run, "api");
  const title = `${t.ui.appName} – ${t.options.title}`;
  assert.equal(run.dom.document.title, title);
  assert.deepEqual(texts(run.dom.byId("app"), "h1"), [title]);

  assert.deepEqual(texts(api, "h2"), [t.options.apiHeading]);
  assert.deepEqual(texts(api, "li"), [t.popup.endpoint(BASE_URL), t.popup.model(MODEL)]);
  assert.deepEqual(texts(api, "label"), [
    t.options.preset,
    t.options.baseUrl,
    t.options.apiKey,
    t.options.model,
    t.options.concurrency,
  ]);
  const hints = api
    .findAll("p")
    .filter((p) => p.className === "hint")
    .map((p) => p.textContent);
  assert.deepEqual(hints, [
    t.options.apiIntro,
    t.options.baseUrlHint,
    t.options.apiKeyHint,
    t.options.modelHint,
    t.options.concurrencyHint,
  ]);
  assert.deepEqual(texts(api, "button"), [t.options.save, t.options.testConnection]);
  assert.deepEqual(texts(control(run, "preset"), "option"), [
    t.options.presetCustom,
    ...API_PRESETS.map((preset) => preset.label),
  ]);

  const languages = section(run, "languages");
  assert.deepEqual(texts(languages, "h2"), [t.options.languageHeading]);
  assert.deepEqual(texts(languages, "label"), [t.options.uiLanguage, t.options.targetLanguage]);
  // The picker lists every UI locale by its own name (not translated), English first.
  const localeOptions = texts(control(run, "ui-locale"), "option");
  assert.deepEqual(localeOptions, [t.options.languageAuto, ...uiLocales().map((locale) => locale.name)]);
  assert.equal(localeOptions[1], "English");
  assert.ok(localeOptions.includes("Tiếng Việt"));
  const targetOptions = texts(control(run, "target-lang"), "option");
  assert.deepEqual(targetOptions, [
    t.options.languageAuto,
    ...TARGET_LANGUAGES.map((language) => language.nativeName),
  ]);

  const sites = section(run, "sites");
  assert.deepEqual(texts(sites, "h2"), [t.options.sitesHeading]);
  assert.ok(texts(sites, "p").includes(t.options.sitesEmpty));

  const privacy = section(run, "privacy");
  assert.deepEqual(texts(privacy, "h2"), [t.options.privacyHeading]);
  assert.deepEqual(texts(privacy, "li"), t.options.privacyPoints);
  assert.ok(texts(privacy, "p").includes(t.options.privacyNotAcked));

  const cache = section(run, "cache");
  assert.deepEqual(texts(cache, "h2"), [t.options.cacheHeading]);
  assert.deepEqual(texts(cache, "button"), [t.options.cacheClear]);

  const debug = section(run, "debug");
  assert.deepEqual(texts(debug, "h2"), [t.options.debugHeading]);
  assert.deepEqual(
    texts(debug, "option"),
    LOG_LEVELS.map((level) => t.options.logLevels[level]),
  );
  assert.deepEqual(texts(debug, "button"), [t.options.exportLog]);
}

describe("options page", () => {
  test("English: texts from msg(); the preset, the base URL and the server's model list are shown", async () => {
    const run = await openOptions("en");
    await assertOptionsIn(run, catalogFor("en"));
    assert.equal(run.dom.document.documentElement["lang"], "en");
    assert.deepEqual(texts(section(run, "api"), "button"), ["Save", "Test connection"]);
    assert.equal(control(run, "preset").value, "ollama");
    assert.equal(control(run, "base-url").value, BASE_URL);
    assert.equal(control(run, "model").value, MODEL);
    assert.equal(control(run, "ui-locale").value, "en");
    assert.deepEqual(
      section(run, "api")
        .findAll("datalist")[0]
        ?.findAll("option")
        .map((option) => option.value),
      [MODEL, "llava:13b"],
    );
    assert.deepEqual(
      run.fetchCalls.map((call) => [call.url, call.init?.headers]),
      [[`${BASE_URL}/models`, {}]],
      "a local server without an API key gets no Authorization header",
    );
  });

  test("settings.ui.locale vi switches every text to Vietnamese", async () => {
    const vi = catalogFor("vi");
    assert.notEqual(vi.options.apiHeading, catalogFor("en").options.apiHeading);
    const run = await openOptions("vi");
    await assertOptionsIn(run, vi);
    assert.equal(run.dom.document.documentElement["lang"], "vi");
  });

  test("a confirmed privacy notice shows its date formatted for the page locale", async () => {
    const at = Date.UTC(2026, 9, 10, 9, 5);
    for (const locale of ["en", "vi"]) {
      const run = await openPage({
        page: "options",
        ids: ["app"],
        settings: {
          ui: { locale },
          api: { baseUrl: BASE_URL, model: MODEL },
          privacy: { ackUploadNoticeAt: at },
        },
        answer: () => json(200, LISTED),
      });
      const t = catalogFor(locale);
      const expected = t.options.privacyAcked(formatDateTime(new Date(at), locale));
      await until(() => {
        const privacy = run.dom.byId("app").findById("privacy");
        return privacy !== null && texts(privacy, "p").includes(expected);
      }, `privacy date in ${locale}`);
      await closePage();
    }
    assert.notEqual(formatDateTime(new Date(at), "vi"), formatDateTime(new Date(at), "en"));
  });

  test("picking a preset fills the base URL and the model", async () => {
    const run = await openOptions("en");
    await assertOptionsIn(run, msg());
    const preset = control(run, "preset");
    preset.value = "gemini";
    run.dispatch(preset, "change");
    assert.equal(control(run, "base-url").value, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.equal(control(run, "model").value, "gemini-2.5-flash");
    preset.value = "lmstudio";
    run.dispatch(preset, "change");
    assert.equal(control(run, "base-url").value, "http://127.0.0.1:1234/v1");
    assert.equal(control(run, "model").value, "gemini-2.5-flash", "a preset without a model keeps the model");
  });

  test("Save validates the form (msg().options messages) and writes the parsed values to settings.api", async () => {
    const run = await openOptions("en");
    await assertOptionsIn(run, msg());
    const api = section(run, "api");
    const save = api.byText("button", msg().options.save);

    control(run, "base-url").value = "localhost:11434";
    run.dispatch(save, "click");
    assert.equal(message(api), msg().options.baseUrlInvalid);
    control(run, "base-url").value = "https://openrouter.ai/api/v1/";
    control(run, "model").value = "  ";
    run.dispatch(save, "click");
    assert.equal(message(api), "Enter a model id.");
    assert.equal(
      (run.browser.storageGet("local", "settings") as Settings).api.baseUrl,
      BASE_URL,
      "nothing saved",
    );

    control(run, "model").value = " openai/gpt-4o-mini ";
    control(run, "api-key").value = " sk-or-test ";
    control(run, "concurrency").value = "3";
    run.dispatch(save, "click");
    await until(() => message(api) === msg().options.saved, "saved");
    const stored = (run.browser.storageGet("local", "settings") as Settings).api;
    assert.deepEqual(
      [stored.baseUrl, stored.apiKey, stored.model, stored.concurrency],
      ["https://openrouter.ai/api/v1", "sk-or-test", "openai/gpt-4o-mini", 3],
    );
    assert.equal(control(run, "base-url").value, "https://openrouter.ai/api/v1");
    await until(() => run.fetchCalls.length === 2, "health re-checked after saving");
    assert.equal(run.fetchCalls[1]?.url, "https://openrouter.ai/api/v1/models");
    assert.deepEqual(run.fetchCalls[1]?.init?.headers, { Authorization: "Bearer sk-or-test" });
  });

  test("Test connection checks the form's endpoint without saving and reports the result", async () => {
    const run = await openOptions("en");
    await assertOptionsIn(run, msg());
    const api = section(run, "api");
    run.answer(() => json(401, { error: { message: "Incorrect API key provided" } }));
    control(run, "base-url").value = "https://api.openai.com";
    control(run, "api-key").value = "sk-wrong";
    run.dispatch(api.byText("button", msg().options.testConnection), "click");
    assert.equal(message(api), msg().options.testing);
    const failed = msg().options.testFailed(
      `${msg().readiness.unauthorized.label} (Incorrect API key provided)`,
    );
    await until(() => message(api) === failed, "test failed message");
    assert.equal(failed, "Failed: API key rejected (Incorrect API key provided)");
    assert.equal(run.fetchCalls.at(-1)?.url, "https://api.openai.com/v1/models", "bare origin normalized");
    assert.equal(
      (run.browser.storageGet("local", "settings") as Settings).api.baseUrl,
      BASE_URL,
      "not saved",
    );

    run.answer(() => json(200, LISTED));
    control(run, "base-url").value = BASE_URL;
    run.dispatch(api.byText("button", msg().options.testConnection), "click");
    await until(() => message(api) === msg().options.testOk(msg().readiness.ready.label), "test ok message");
  });

  test("changing the interface language saves it and reloads the page; the target language only saves", async () => {
    const run = await openOptions("en");
    await assertOptionsIn(run, msg());
    const languages = section(run, "languages");
    const target = control(run, "target-lang");
    target.value = "es";
    run.dispatch(target, "change");
    await until(() => message(languages) === msg().options.saved, "target saved");
    assert.equal(run.reloads(), 0);
    const ui = control(run, "ui-locale");
    ui.value = "vi";
    run.dispatch(ui, "change");
    await until(() => run.reloads() === 1, "page reloaded for the new UI language");
    const stored = run.browser.storageGet("local", "settings") as Settings;
    assert.deepEqual([stored.ui.locale, stored.translate.targetLang], ["vi", "es"]);
  });
});
