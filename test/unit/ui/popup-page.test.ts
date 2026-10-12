// The real popup entry (src/ui/popup/popup.ts) rendered into a fake DOM against the chrome fake: every text comes
// from msg() in the locale chosen by settings.ui.locale (English by default), and the endpoint block comes from the
// popup's own GET {baseUrl}/models (a fake fetch).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { catalogFor, currentLocale, msg, type Catalog } from "../../../src/shared/i18n/index.ts";
import type { Settings, SiteSettings } from "../../../src/shared/settings.ts";
import { until } from "../sw/sw-helpers.ts";
import { closePage, json, openPage, pillText, texts, type PageRun } from "./page-harness.ts";

afterEach(closePage);

const IDS = ["api", "engine", "site", "uploads", "footer"];
const BASE_URL = "https://api.example.test/v1";
const MODEL = "gpt-4o-mini";
const SITE = "https://reader.example";

async function openPopup(
  settings: Record<string, unknown>,
  answer = (): Response => json(200, { data: [{ id: MODEL }] }),
): Promise<PageRun> {
  return openPage({
    page: "popup",
    ids: IDS,
    settings: { api: { baseUrl: BASE_URL, apiKey: "sk-test", model: MODEL }, ...settings },
    tabs: [`${SITE}/ch/1`],
    answer,
  });
}

/** Waits for the endpoint check and the engine state, then checks every static text against catalog `t`. */
async function assertPopupIn(run: PageRun, t: Catalog): Promise<void> {
  const { dom } = run;
  await until(
    () =>
      pillText(dom.byId("api")) === t.readiness.ready.label &&
      pillText(dom.byId("engine")) === t.popup.engineStopped,
    "popup rendered",
  );
  const api = dom.byId("api");
  assert.deepEqual(texts(api, "h2"), [t.popup.apiHeading]);
  assert.deepEqual(texts(api, "li"), [t.popup.endpoint(BASE_URL), t.popup.model(MODEL)]);
  assert.deepEqual(texts(dom.byId("engine"), "h2"), [t.popup.engineHeading]);
  assert.equal(dom.byId("uploads")["hidden"], true, "no upload counter without an engine");
  const site = dom.byId("site");
  assert.deepEqual(texts(site, "h2"), [t.popup.siteHeading]);
  assert.equal(site.findAll("p").find((p) => p.className === "site-key")?.textContent, SITE);
  assert.equal(pillText(site), t.popup.siteOff);
  assert.deepEqual(texts(site, "button"), [t.ui.siteEnable, t.ui.translateVisible]);
  const footer = dom.byId("footer");
  assert.deepEqual(texts(footer, "a"), [t.popup.options, t.popup.openTranscript]);
  assert.deepEqual(texts(footer, "span"), [t.popup.build(__BUILD_ID__)]);
}

describe("popup page", () => {
  test("English: texts from msg(), endpoint block from GET {baseUrl}/models with the API key", async () => {
    const run = await openPopup({ ui: { locale: "en" } });
    await assertPopupIn(run, catalogFor("en"));
    assert.equal(run.dom.document.documentElement["lang"], "en");
    assert.equal(currentLocale(), "en");
    assert.equal(pillText(run.dom.byId("api")), "AI endpoint ready");
    assert.deepEqual(texts(run.dom.byId("site"), "button"), [
      "Translate this site",
      "Translate visible images",
    ]);
    assert.equal(run.fetchCalls.length, 1);
    assert.equal(run.fetchCalls[0]?.url, `${BASE_URL}/models`);
    assert.deepEqual(run.fetchCalls[0]?.init?.headers, { Authorization: "Bearer sk-test" });
  });

  test("settings.ui.locale vi switches every text to Vietnamese", async () => {
    const vi = catalogFor("vi");
    assert.notEqual(vi.popup.apiHeading, catalogFor("en").popup.apiHeading);
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

  test("a rejected API key shows the unauthorized label, its remediation and the server's message", async () => {
    const run = await openPopup({ ui: { locale: "en" } }, () =>
      json(401, { error: { message: "Incorrect API key provided" } }),
    );
    const api = run.dom.byId("api");
    await until(() => pillText(api) === msg().readiness.unauthorized.label, "unauthorized");
    assert.equal(pillText(api), "API key rejected");
    assert.deepEqual(
      api
        .findAll("p")
        .filter((p) => p.className === "hint")
        .map((p) => p.textContent),
      [msg().readiness.unauthorized.hint],
    );
    assert.equal(texts(api, "li").at(-1), "Details: Incorrect API key provided");
  });

  test("the first enable goes through the privacy notice (in the page locale), then enables the site", async () => {
    const run = await openPopup({ ui: { locale: "en" } });
    await assertPopupIn(run, msg());
    const site = run.dom.byId("site");
    run.dispatch(site.byText("button", msg().ui.siteEnable), "click");
    const notice = site.findAll("div").find((div) => div.getAttribute("role") === "dialog");
    assert.ok(notice !== undefined, "privacy notice shown");
    assert.deepEqual(texts(notice, "h3"), ["Before images are sent to the AI"]);
    run.dispatch(notice.byText("button", msg().ui.privacyAccept), "click");
    await until(() => pillText(site) === msg().popup.siteOn, "site enabled");
    const settings = run.browser.storageGet("local", "settings") as Settings;
    assert.equal(typeof settings.privacy.ackUploadNoticeAt, "number");
    assert.equal((run.browser.storageGet("local", `site:${SITE}`) as SiteSettings).enabled, true);
    assert.deepEqual(texts(site, "legend"), [msg().popup.modeLabel]);
    assert.deepEqual(texts(site, "label"), [
      msg().ui.modeAuto,
      msg().ui.modeManual,
      ` ${msg().popup.cookies}`,
    ]);
    assert.deepEqual(texts(site, "button"), [msg().ui.siteDisable, msg().ui.translateVisible]);
  });

  test("an enabled site: mode and the cookies option (with its hint) save to the site settings", async () => {
    const run = await openPage({
      page: "popup",
      ids: IDS,
      settings: {
        ui: { locale: "en" },
        api: { baseUrl: BASE_URL, model: MODEL },
        privacy: { ackUploadNoticeAt: 1 },
      },
      sites: { [SITE]: { enabled: true } },
      tabs: [`${SITE}/ch/1`],
      answer: () => json(200, { data: [{ id: MODEL }] }),
    });
    const site = run.dom.byId("site");
    await until(() => pillText(site) === msg().popup.siteOn, "enabled site rendered");
    const cookies = site.findAll("label").find((label) => label.className === "check");
    assert.equal(cookies?.getAttribute("title"), msg().popup.cookiesHint);
    const checkbox = cookies?.findAll("input")[0];
    assert.ok(checkbox !== undefined);
    assert.equal(checkbox["checked"], false, "cookies are off by default");

    checkbox["checked"] = true;
    run.dispatch(checkbox, "change");
    await until(
      () => (run.browser.storageGet("local", `site:${SITE}`) as SiteSettings).credentials === "include",
      "cookies on",
    );
    const manual = site.findAll("input").find((input) => input["value"] === "manual");
    assert.ok(manual !== undefined);
    run.dispatch(manual, "change");
    await until(
      () => (run.browser.storageGet("local", `site:${SITE}`) as SiteSettings).mode === "manual",
      "manual",
    );
    await until(() => {
      const box = site
        .findAll("label")
        .find((label) => label.className === "check")
        ?.findAll("input")[0];
      return box?.["checked"] === true;
    }, "re-rendered with cookies on");
  });
});
