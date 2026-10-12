import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { catalogFor, currentLocale, msg, setLocale } from "../../../src/shared/i18n/index.ts";
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from "../../../src/shared/settings.ts";
import {
  droppedShortcuts,
  guardAllowOrigins,
  handleInstalled,
  handleStartup,
  installGuards,
  localizedMenus,
  logCommands,
  onInstalled,
  reinjectOpenTabs,
  TEST_FIXTURE_HOSTS,
} from "../../../src/sw/install.ts";
import { MENU_IDS } from "../../../src/sw/menus.ts";
import type { FakeBrowser } from "../../support/chrome-fake.ts";
import { callCount, startBrowser, stopBrowser, until } from "./sw-helpers.ts";

afterEach(async () => {
  await stopBrowser();
  // localizedMenus switches the worker's msg(); later tests expect English.
  setLocale("en");
});

const COMMANDS_MANIFEST = {
  "toggle-overlay": { suggested_key: { default: "Alt+Shift+Y" }, description: "a" },
  "translate-visible": { suggested_key: { default: "Alt+Shift+U" }, description: "b" },
  "toggle-site": { description: "c" },
};

function withBaseUrl(baseUrl: string): Settings {
  return { ...DEFAULT_SETTINGS, api: { ...DEFAULT_SETTINGS.api, baseUrl } };
}

test("guardAllowOrigins: the origin of api.baseUrl, dev hosts only when asked, invalid values dropped", () => {
  const settings = migrateSettings({
    api: { baseUrl: "http://127.0.0.1:11434/v1" },
    privacy: { devFixtureHosts: ["127.0.0.1:8080", "localhost:8081", "::bad::", "127.0.0.1:8080"] },
  });
  assert.deepEqual(guardAllowOrigins(settings, false), ["http://127.0.0.1:11434"], "local server, port kept");
  assert.deepEqual(guardAllowOrigins(settings, true), [
    "http://127.0.0.1:11434",
    "http://127.0.0.1:8080",
    "http://localhost:8081",
  ]);
  assert.deepEqual(guardAllowOrigins(DEFAULT_SETTINGS, false), ["https://api.openai.com"], "the default");
  assert.deepEqual(guardAllowOrigins(withBaseUrl("not a url"), false), []);
  assert.deepEqual(guardAllowOrigins(withBaseUrl("ftp://files.example/v1"), false), [], "http(s) only");
});

test("guardAllowOrigins follows custom hosts and local servers, never the path", () => {
  assert.deepEqual(guardAllowOrigins(withBaseUrl("https://openrouter.ai/api/v1"), false), [
    "https://openrouter.ai",
  ]);
  assert.deepEqual(guardAllowOrigins(withBaseUrl("https://llm.corp.example:8443/openai/v1"), false), [
    "https://llm.corp.example:8443",
  ]);
  assert.deepEqual(guardAllowOrigins(withBaseUrl("http://localhost:1234/v1"), false), [
    "http://localhost:1234",
  ]);
  assert.deepEqual(guardAllowOrigins(withBaseUrl("http://192.168.1.20:8000/v1"), false), [
    "http://192.168.1.20:8000",
  ]);
  assert.deepEqual(guardAllowOrigins(withBaseUrl("http://[::1]:8080/v1"), false), ["http://[::1]:8080"]);
  assert.deepEqual(
    guardAllowOrigins(withBaseUrl("https://api.example.com:443/v1"), false),
    ["https://api.example.com"],
    "the default port is dropped like in a real origin",
  );
  assert.deepEqual(
    guardAllowOrigins(
      {
        ...withBaseUrl("http://127.0.0.1:8080/v1"),
        privacy: { ...DEFAULT_SETTINGS.privacy, devFixtureHosts: ["127.0.0.1:8080"] },
      },
      true,
    ),
    ["http://127.0.0.1:8080"],
    "an endpoint that is also a dev host is listed once",
  );
  // Schema-1 settings kept the endpoint under a legacy key; it is migrated to api and still allowed.
  assert.deepEqual(
    guardAllowOrigins(migrateSettings({ adapter: { baseUrl: "http://127.0.0.1:4925/" } }), false),
    ["http://127.0.0.1:4925"],
  );
});

test("installGuards reads api.baseUrl from storage: a local server with a port gets its allow rule", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", {
    settings: { api: { baseUrl: "http://192.168.1.20:8000/v1" }, privacy: { devFixtureHosts: [] } },
  });
  const result = await sw.run(() => installGuards());
  assert.deepEqual(result.unsupported, []);
  assert.deepEqual(allowFilters(browser), ["|http://192.168.1.20:8000/"]);
  assert.ok(
    browser.sessionRules.some((rule) => rule.action.type === "block"),
    "the private-address block rules stay in place",
  );

  browser.storageSet("local", {
    settings: { api: { baseUrl: "https://llm.corp.example/v1" }, privacy: { devFixtureHosts: [] } },
  });
  await sw.run(() => installGuards());
  assert.deepEqual(allowFilters(browser), ["|https://llm.corp.example/"], "the old origin is replaced");
});

function allowFilters(browser: FakeBrowser): Array<string | undefined> {
  return browser.sessionRules
    .filter((rule) => rule.action.type === "allow")
    .map((rule) => rule.condition.urlFilter);
}

function menuTitles(browser: FakeBrowser): string[] {
  return [...browser.menus.values()].map((menu) => String(menu.title));
}

test("localizedMenus: titles come from msg() in the locale of settings.ui.locale", async () => {
  const { browser, sw } = await startBrowser();
  const en = catalogFor("en").menu;
  const vi = catalogFor("vi").menu;

  browser.storageSet("local", { settings: { ui: { locale: "en" } } });
  await sw.run(() => localizedMenus());
  assert.deepEqual(menuTitles(browser), [en.translateImage, en.retranslateImage]);
  assert.equal(currentLocale(), "en");

  browser.storageSet("local", { settings: { ui: { locale: "vi" } } });
  await sw.run(() => localizedMenus());
  assert.deepEqual(menuTitles(browser), [vi.translateImage, vi.retranslateImage]);
  assert.notDeepEqual(
    menuTitles(browser),
    [en.translateImage, en.retranslateImage],
    "the titles really changed",
  );
  assert.equal(msg().menu.translateImage, vi.translateImage, "the worker's msg() switched too");
  assert.equal(browser.menus.size, 2, "rebuilt, never duplicated");
});

test("localizedMenus with ui.locale auto follows the browser UI language", async () => {
  const { browser, sw } = await startBrowser();
  // The fake browser's chrome.i18n.getUILanguage() is "vi".
  await sw.run(() => localizedMenus());
  assert.equal(currentLocale(), "vi");
  assert.deepEqual(menuTitles(browser), [
    catalogFor("vi").menu.translateImage,
    catalogFor("vi").menu.retranslateImage,
  ]);

  sw.ext.i18n.getUILanguage = () => "en-US";
  await sw.run(() => localizedMenus());
  assert.equal(currentLocale(), "en");
  assert.deepEqual(menuTitles(browser), [
    catalogFor("en").menu.translateImage,
    catalogFor("en").menu.retranslateImage,
  ]);
});

test("droppedShortcuts lists commands whose suggested key Chrome did not assign", () => {
  assert.deepEqual(
    droppedShortcuts(COMMANDS_MANIFEST, [
      { name: "toggle-overlay", shortcut: "Alt+Shift+Y" },
      { name: "translate-visible", shortcut: "" },
      { name: "toggle-site", shortcut: "" },
    ]),
    ["translate-visible"],
  );
  assert.deepEqual(droppedShortcuts(COMMANDS_MANIFEST, []), ["toggle-overlay", "translate-visible"]);
});

test("onInstalled (install): test-build seeding, menus, guard rules, registration, re-injection", async () => {
  const { browser, sw } = await startBrowser({
    manifest: { manifest_version: 3, name: "t", version: "0.0.0", commands: COMMANDS_MANIFEST },
    commands: [
      { name: "toggle-overlay", shortcut: "Alt+Shift+Y" },
      { name: "translate-visible", shortcut: "Alt+Shift+U" },
    ],
  });
  browser.storageSet("local", { "site:http://127.0.0.1:8080": { enabled: true, addedAt: 1 } });
  const reader = browser.openTab("http://127.0.0.1:8080/webtoon/?n=3");
  browser.addFrame(reader.id, "http://127.0.0.1:8080/frame");
  browser.openTab("https://not-enabled.example/");
  browser.openTab("chrome://extensions/");

  sw.run(() => chrome.runtime.onInstalled.addListener(onInstalled));
  browser.fireInstalled("install");
  await until(
    () => callCount(browser, "commands.getAll") === 1 && browser.executeScriptCalls.length === 1,
    "install",
  );
  await until(() => browser.sessionRules.length === 9, "guard rules");

  const settings = browser.storageGet("local", "settings") as Settings;
  assert.deepEqual(
    settings.privacy.devFixtureHosts,
    [...TEST_FIXTURE_HOSTS],
    "test builds seed the fixture hosts",
  );
  assert.deepEqual([...browser.menus.keys()], [MENU_IDS.translate, MENU_IDS.retranslate]);
  assert.deepEqual(
    menuTitles(browser),
    [catalogFor("vi").menu.translateImage, catalogFor("vi").menu.retranslateImage],
    "ui.locale auto: titles in the browser UI language (the fake reports vi)",
  );
  assert.deepEqual(
    allowFilters(browser),
    ["|https://api.openai.com/", "|http://127.0.0.1:8080/", "|http://localhost:8081/"],
    "the default endpoint's origin plus the seeded fixture hosts",
  );
  assert.deepEqual(browser.registeredScripts.get("ctv-main")?.matches, ["http://127.0.0.1:8080/*"]);
  assert.deepEqual(
    browser.executeScriptCalls.map((call) => [call.tabId, call.frameIds, call.files, call.hasFunc]),
    [[reader.id, [0, 1], ["content/main.js"], false]],
    "only the enabled site's tab, every frame, auto mode",
  );
});

test("already seeded settings are kept; update re-injects, chrome_update does not", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", {
    settings: { privacy: { devFixtureHosts: ["127.0.0.1:9999"] } },
    "site:https://reader.example": { enabled: true, addedAt: 1 },
  });
  const tab = browser.openTab("https://reader.example/ch/2");
  await sw.run(() => handleInstalled("install"));
  assert.deepEqual((browser.storageGet("local", "settings") as Settings).privacy.devFixtureHosts, [
    "127.0.0.1:9999",
  ]);
  assert.equal(browser.executeScriptCalls.length, 1);
  await sw.run(() => handleInstalled("update"));
  assert.equal(browser.executeScriptCalls.length, 2);
  await sw.run(() => handleInstalled("chrome_update"));
  assert.equal(browser.executeScriptCalls.length, 2);
  assert.equal(browser.menus.size, 2);
  assert.equal(browser.executeScriptCalls.at(-1)?.tabId, tab.id);
});

test("onStartup restores guard rules and registration without touching menus or tabs", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", { "site:https://reader.example": { enabled: true, addedAt: 1 } });
  browser.openTab("https://reader.example/ch/2");
  await sw.run(() => handleStartup());
  assert.ok(browser.sessionRules.length >= 7);
  assert.equal(browser.registeredScripts.size, 1);
  assert.equal(browser.menus.size, 0);
  assert.equal(browser.executeScriptCalls.length, 0);
});

test("one failing step does not stop the others", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", { "site:https://reader.example": { enabled: true, addedAt: 1 } });
  browser.failNext("declarativeNetRequest.getSessionRules", "DNR down");
  await sw.run(() => handleInstalled("update"));
  assert.equal(browser.registeredScripts.size, 1);
  assert.equal(browser.menus.size, 2);
});

test("reinjectOpenTabs does nothing without enabled sites; logCommands reports dropped keys", async () => {
  const { browser, sw } = await startBrowser({
    manifest: { manifest_version: 3, name: "t", version: "0.0.0", commands: COMMANDS_MANIFEST },
    commands: [{ name: "toggle-overlay", shortcut: "" }],
  });
  browser.openTab("https://reader.example/");
  assert.equal(await sw.run(() => reinjectOpenTabs()), 0);
  assert.equal(callCount(browser, "tabs.query"), 0);
  assert.deepEqual(await sw.run(() => logCommands()), ["toggle-overlay", "translate-visible"]);
});
