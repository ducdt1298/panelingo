// The real popup entry (src/ui/popup/popup.ts) rendered into a fake DOM against the chrome fake: every text comes
// from msg() in the locale chosen by settings.ui.locale (English by default), the status line comes from the popup's
// own GET {baseUrl}/models (a fake fetch), and the site card turns translation on, picks the mode, the target language
// and the per-site cookies option.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { catalogFor, currentLocale, msg, type Catalog } from "../../../src/shared/i18n/index.ts";
import { TARGET_LANGUAGES } from "../../../src/shared/languages.ts";
import type { Settings, SiteSettings } from "../../../src/shared/settings.ts";
import { until } from "../sw/sw-helpers.ts";
import type { FakeElement } from "./fake-dom.ts";
import { closePage, json, openPage, pillText, texts, type PageRun } from "./page-harness.ts";

afterEach(closePage);

const IDS = ["open-options", "site", "engine", "api", "uploads"];
const BASE_URL = "https://api.example.test/v1";
const MODEL = "gpt-4o-mini";
const SITE = "https://reader.example";

async function openPopup(
  settings: Record<string, unknown>,
  answer = (): Response => json(200, { data: [{ id: MODEL }] }),
  sites: Record<string, unknown> = {},
): Promise<PageRun> {
  return openPage({
    page: "popup",
    ids: IDS,
    settings: { api: { baseUrl: BASE_URL, apiKey: "sk-test", model: MODEL }, ...settings },
    sites,
    tabs: [`${SITE}/ch/1`],
    answer,
  });
}

function control(run: PageRun, id: string): FakeElement {
  const el = run.dom.byId("site").findById(id);
  if (el === null) throw new Error(`no #${id}`);
  return el;
}

/** Waits for the endpoint check, then checks every static text against catalog `t`. */
async function assertPopupIn(run: PageRun, t: Catalog): Promise<void> {
  const { dom } = run;
  await until(() => pillText(dom.byId("api")) === t.readiness.ready.label, "popup rendered");
  const api = dom.byId("api");
  assert.deepEqual(
    api
      .findAll("span")
      .map((span) => [span.className, span.textContent])
      .slice(1),
    [
      ["pill tone-ok", t.readiness.ready.label],
      ["status-detail", MODEL],
      ["status-go", "›"],
    ],
  );
  assert.equal(api.getAttribute("title"), t.popup.options, "the status line opens the settings");
  assert.equal(dom.byId("open-options").textContent, t.popup.options, "the settings button says what it is");
  assert.equal(dom.byId("engine")["hidden"], true, "no engine note while nothing is wrong");
  assert.equal(dom.byId("uploads")["hidden"], true, "no upload counter without an engine");

  const site = dom.byId("site");
  assert.deepEqual(texts(site, "h2"), ["reader.example"]);
  const toggle = site.findAll("label").find((label) => label.getAttribute("for") === "site-enabled");
  assert.equal(toggle?.textContent, t.popup.siteToggle);
  assert.equal(control(run, "site-enabled")["checked"], false);
  assert.deepEqual(texts(control(run, "target-lang"), "option"), [
    t.options.languageAuto,
    ...TARGET_LANGUAGES.map((language) => language.nativeName),
  ]);
  assert.deepEqual(texts(site, "button"), [t.ui.translateVisible, t.popup.openTranscript]);
  assert.deepEqual(texts(site, "summary"), [t.popup.more]);
  assert.deepEqual(texts(site, "a"), [t.popup.siteSettings]);
}

describe("popup page: offline mode", () => {
  test("no fast mode switch: it only changes what is asked of the AI endpoint", async () => {
    const run = await openPopup({ ui: { locale: "en" }, translate: { engine: "offline" } });
    await until(() => run.dom.byId("site").findById("target-lang") !== null, "site card");
    assert.equal(run.dom.byId("site").findById("fast-mode"), null);
  });
});

describe("popup page", () => {
  test("English: texts from msg(), the status line from GET {baseUrl}/models with the API key", async () => {
    const run = await openPopup({ ui: { locale: "en" } });
    await assertPopupIn(run, catalogFor("en"));
    assert.equal(run.dom.document.documentElement["lang"], "en");
    assert.equal(currentLocale(), "en");
    assert.equal(pillText(run.dom.byId("api")), "AI endpoint ready");
    assert.deepEqual(texts(run.dom.byId("site"), "button"), [
      "Translate visible images",
      "Open the transcript",
    ]);
    assert.equal(run.fetchCalls.length, 1);
    assert.equal(run.fetchCalls[0]?.url, `${BASE_URL}/models`);
    assert.deepEqual(run.fetchCalls[0]?.init?.headers, { Authorization: "Bearer sk-test" });
  });

  test("settings.ui.locale vi switches every text to Vietnamese", async () => {
    const vi = catalogFor("vi");
    assert.notEqual(vi.popup.siteToggle, catalogFor("en").popup.siteToggle);
    const run = await openPopup({ ui: { locale: "vi" } });
    await assertPopupIn(run, vi);
    assert.equal(run.dom.document.documentElement["lang"], "vi");
    assert.equal(msg(), vi);
  });

  test("locale auto follows the browser UI language (vi in the chrome fake)", async () => {
    const run = await openPopup({ ui: { locale: "auto" } });
    await assertPopupIn(run, catalogFor("vi"));
    assert.equal(run.dom.document.documentElement["lang"], "vi");
  });

  test("a rejected API key: the status line turns to the unauthorized label and says what to do", async () => {
    const run = await openPopup({ ui: { locale: "en" } }, () =>
      json(401, { error: { message: "Incorrect API key provided" } }),
    );
    const api = run.dom.byId("api");
    await until(() => pillText(api) === msg().readiness.unauthorized.label, "unauthorized");
    assert.equal(pillText(api), "API key rejected");
    assert.equal(api.className, "status-line trouble");
    assert.equal(
      api.findAll("span").find((span) => span.className === "status-hint")?.textContent,
      msg().readiness.unauthorized.hint,
    );
  });

  test("the first enable goes through the privacy notice (in the page locale), then enables the site", async () => {
    const run = await openPopup({ ui: { locale: "en" } });
    await assertPopupIn(run, msg());
    const site = run.dom.byId("site");
    run.dispatch(control(run, "site-enabled"), "change");
    const notice = site.findAll("div").find((div) => div.getAttribute("role") === "dialog");
    assert.ok(notice !== undefined, "privacy notice shown");
    assert.deepEqual(texts(notice, "h3"), ["Before images are sent to the AI"]);
    assert.equal(run.browser.storageGet("local", `site:${SITE}`), undefined, "nothing enabled yet");
    run.dispatch(notice.byText("button", msg().ui.privacyAccept), "click");
    await until(() => control(run, "site-enabled")["checked"] === true, "site enabled");
    const settings = run.browser.storageGet("local", "settings") as Settings;
    assert.equal(typeof settings.privacy.ackUploadNoticeAt, "number");
    assert.equal((run.browser.storageGet("local", `site:${SITE}`) as SiteSettings).enabled, true);
    assert.deepEqual(texts(site, "legend"), [msg().popup.modeLabel]);
    assert.deepEqual(
      site
        .findAll("label")
        .filter((label) => label.className === "radio")
        .map((label) => label.textContent),
      [msg().ui.modeAuto, msg().ui.modeManual],
    );
    assert.equal(
      site.findAll("div").some((div) => div.getAttribute("role") === "dialog"),
      false,
      "the notice closes",
    );
  });

  test("an enabled site: the mode, the cookies option and the target language save", async () => {
    const run = await openPopup({ ui: { locale: "en" }, privacy: { ackUploadNoticeAt: 1 } }, undefined, {
      [SITE]: { enabled: true },
    });
    const site = run.dom.byId("site");
    await until(() => site.findById("site-enabled")?.["checked"] === true, "enabled site rendered");
    const cookies = control(run, "site-cookies");
    assert.equal(cookies["checked"], false, "cookies are off by default");
    assert.equal(
      site
        .findAll("label")
        .find((label) => label.getAttribute("for") === "site-cookies")
        ?.getAttribute("title"),
      msg().popup.cookiesHint,
    );
    cookies["checked"] = true;
    run.dispatch(cookies, "change");
    await until(
      () => (run.browser.storageGet("local", `site:${SITE}`) as SiteSettings).credentials === "include",
      "cookies on",
    );
    await until(() => control(run, "site-cookies")["checked"] === true, "re-rendered with cookies on");

    const manual = site.findAll("input").find((input) => input["value"] === "manual");
    assert.ok(manual !== undefined);
    run.dispatch(manual, "change");
    await until(
      () => (run.browser.storageGet("local", `site:${SITE}`) as SiteSettings).mode === "manual",
      "manual",
    );
    assert.deepEqual(
      texts(site, "button").slice(0, 1),
      [msg().ui.translateVisible],
      "in manual mode translating what is on screen is the main action",
    );

    // The mode change is done (controls enabled again) before the next action.
    await until(() => site.findById("target-lang")?.["disabled"] === false, "idle again");
    const fastMode = control(run, "fast-mode");
    assert.equal(fastMode["checked"], false);
    fastMode["checked"] = true;
    run.dispatch(fastMode, "change");
    await until(
      () => (run.browser.storageGet("local", "settings") as Settings).translate.fastMode,
      "fast mode on",
    );
    await until(() => site.findById("target-lang")?.["disabled"] === false, "idle after fast mode");
    const target = control(run, "target-lang");
    target.value = "fr";
    run.dispatch(target, "change");
    await until(
      () => (run.browser.storageGet("local", "settings") as Settings).translate.targetLang === "fr",
      "target language saved",
    );
    await until(() => texts(site, "p").includes(msg().options.saved), "saved message");
  });
});
