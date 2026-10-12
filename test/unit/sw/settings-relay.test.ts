import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { catalogFor, currentLocale, setLocale } from "../../../src/shared/i18n/index.ts";
import { DEFAULT_SETTINGS, type Settings, type SiteSettings } from "../../../src/shared/settings.ts";
import { ensureEngine } from "../../../src/sw/engine-host.ts";
import { installGuards } from "../../../src/sw/install.ts";
import {
  guardInputsChanged,
  localeChanged,
  onStorageChanged,
  relayPlan,
  relayStorageChange,
  settingsSnapshot,
} from "../../../src/sw/settings-relay.ts";
import type { FakeBrowser } from "../../support/chrome-fake.ts";
import { callCount, engineWith, startBrowser, stopBrowser, until } from "./sw-helpers.ts";

afterEach(async () => {
  await stopBrowser();
  // A locale change rebuilds the menus through applyLocale, which switches the worker's msg().
  setLocale("en");
});

type Pushed = { settings: Settings; sites: Record<string, SiteSettings> };

function change(oldValue: unknown, newValue: unknown): chrome.storage.StorageChange {
  return { oldValue, newValue };
}

function menuTitles(browser: FakeBrowser): string[] {
  return [...browser.menus.values()].map((menu) => String(menu.title));
}

test("relayPlan: settings → push (+ guards when the API base URL or dev hosts change); sites → push + sync", () => {
  const before = { api: { baseUrl: "http://127.0.0.1:11434/v1", concurrency: 2 } };
  assert.deepEqual(
    relayPlan({
      settings: change(before, { api: { baseUrl: "http://127.0.0.1:11434/v1", concurrency: 3 } }),
    }),
    { push: true, sync: false, guards: false, menus: false },
  );
  assert.deepEqual(
    relayPlan({ settings: change(before, { api: { baseUrl: "http://127.0.0.1:11435/v1" } }) }),
    { push: true, sync: false, guards: true, menus: false },
  );
  assert.deepEqual(
    relayPlan({
      settings: change(before, { ...before, api: { ...before.api, apiKey: "sk-new", model: "gpt-4o" } }),
    }),
    { push: true, sync: false, guards: false, menus: false },
    "key and model changes reach the engine but need no new guard rules",
  );
  assert.deepEqual(relayPlan({ "site:https://a.example": change(undefined, { enabled: true }) }), {
    push: true,
    sync: true,
    guards: false,
    menus: false,
  });
  assert.deepEqual(relayPlan({ "dnr:lru": change({}, { a: 1 }), other: change(1, 2) }), {
    push: false,
    sync: false,
    guards: false,
    menus: false,
  });
});

test("relayPlan: a ui.locale change rebuilds the menus; other settings changes do not", () => {
  const english = { ui: { locale: "en" }, debug: { logLevel: "info" } };
  assert.deepEqual(relayPlan({ settings: change(english, { ...english, ui: { locale: "vi" } }) }), {
    push: true,
    sync: false,
    guards: false,
    menus: true,
  });
  assert.deepEqual(relayPlan({ settings: change(english, { ...english, debug: { logLevel: "debug" } }) }), {
    push: true,
    sync: false,
    guards: false,
    menus: false,
  });
  assert.deepEqual(
    relayPlan({
      settings: change(english, { ui: { locale: "vi" }, api: { baseUrl: "http://localhost:1234/v1" } }),
      "site:https://a.example": change(undefined, { enabled: true }),
    }),
    { push: true, sync: true, guards: true, menus: true },
    "every step at once",
  );
  assert.equal(relayPlan({ "site:https://a.example": change(undefined, { enabled: true }) }).menus, false);
});

test("localeChanged compares migrated values", () => {
  assert.equal(localeChanged(undefined, { ui: { locale: "vi" } }), true);
  assert.equal(localeChanged(undefined, { ui: { locale: "auto" } }), false, "auto is the default");
  assert.equal(localeChanged(undefined, { debug: { logLevel: "debug" } }), false);
  assert.equal(localeChanged({ ui: { locale: "vi" } }, { ui: { locale: "vi" }, enabled: false }), false);
  assert.equal(localeChanged({ ui: { locale: "vi" } }, { ui: { locale: "en" } }), true);
  assert.equal(localeChanged({ ui: { locale: "en" } }, { ui: { locale: "auto" } }), true);
  assert.equal(
    localeChanged({ ui: { locale: "auto" } }, { ui: { locale: 5 } }),
    false,
    "garbage migrates to auto",
  );
  assert.equal(localeChanged({ ui: { locale: "vi" } }, undefined), true, "settings removed → back to auto");
});

test("guardInputsChanged compares migrated values (first write of settings counts only if it differs)", () => {
  assert.equal(guardInputsChanged(undefined, { debug: { logLevel: "debug" } }), false);
  assert.equal(guardInputsChanged(undefined, { privacy: { devFixtureHosts: ["127.0.0.1:8080"] } }), true);
  assert.equal(
    guardInputsChanged({ privacy: { devFixtureHosts: ["a:1"] } }, { privacy: { devFixtureHosts: ["a:1"] } }),
    false,
  );
  assert.equal(
    guardInputsChanged(DEFAULT_SETTINGS, {
      ...DEFAULT_SETTINGS,
      api: { ...DEFAULT_SETTINGS.api, baseUrl: "http://x:1/v1" },
    }),
    true,
  );
  assert.equal(
    guardInputsChanged(
      { api: { baseUrl: "http://127.0.0.1:11434" } },
      { api: { baseUrl: "http://127.0.0.1:11434/v1/" } },
    ),
    false,
    "both normalize to the same base URL",
  );
  assert.equal(
    guardInputsChanged(DEFAULT_SETTINGS, {
      ...DEFAULT_SETTINGS,
      api: { ...DEFAULT_SETTINGS.api, apiKey: "sk-1" },
    }),
    false,
  );
  assert.equal(
    guardInputsChanged(
      { adapter: { baseUrl: "http://127.0.0.1:4925" } },
      { api: { baseUrl: "http://127.0.0.1:4925/v1" } },
    ),
    false,
    "rewriting the schema-1 endpoint section as api changes nothing",
  );
});

test("no engine: a settings change never starts it and sends nothing", async () => {
  const { browser, sw } = await startBrowser();
  const plan = await sw.run(() =>
    relayStorageChange({ settings: change(undefined, { api: { concurrency: 1 } }) }),
  );
  assert.equal(plan.push, true);
  assert.equal(browser.offscreen, null);
  assert.equal(callCount(browser, "offscreen.createDocument"), 0);
  assert.equal(browser.stats.runtimeMessages, 0, "no en:settings sent");
});

test("engine running: storage changes are pushed as en:settings with migrated values", async () => {
  const pushed: Pushed[] = [];
  const { browser, sw } = await startBrowser(
    engineWith({
      "en:settings": (payload) => {
        pushed.push(payload);
        return {};
      },
    }),
  );
  sw.run(() => chrome.storage.onChanged.addListener(onStorageChanged));
  await sw.run(() => ensureEngine());
  await until(() => pushed.length === 1, "push after create");

  browser.storageSet("local", {
    settings: { api: { concurrency: 99, apiKey: "sk-test", temperature: null } },
  });
  await until(() => pushed.length === 2, "push after settings change");
  assert.equal(pushed[1]?.settings.api.concurrency, 4);
  assert.equal(pushed[1]?.settings.api.apiKey, "sk-test");
  assert.equal(pushed[1]?.settings.api.temperature, null);

  browser.storageSet("local", { "site:https://reader.example": { enabled: true, addedAt: 3 } });
  await until(() => pushed.length === 3, "push after site change");
  assert.equal(pushed[2]?.sites["https://reader.example"]?.enabled, true);
  await until(() => browser.registeredScripts.size === 1, "registration synced");

  browser.storageSet("session", { settings: { api: { concurrency: 1 } } });
  browser.storageSet("local", { "dnr:lru": { x: 1 } });
  await browser.settle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pushed.length, 3, "session area and unrelated keys are not relayed");
});

test("an API base URL change re-installs the guard rules with the new allow origin", async () => {
  const { browser, sw } = await startBrowser();
  await sw.run(() => installGuards());
  assert.ok(browser.sessionRules.some((rule) => rule.condition.urlFilter === "|https://api.openai.com/"));

  sw.run(() => chrome.storage.onChanged.addListener(onStorageChanged));
  browser.storageSet("local", { settings: { api: { baseUrl: "http://127.0.0.1:11434/v1" } } });
  await until(
    () => browser.sessionRules.some((rule) => rule.condition.urlFilter === "|http://127.0.0.1:11434/"),
    "allow rule for the new base URL",
  );
  assert.ok(
    browser.sessionRules.some((rule) => rule.action.type === "block"),
    "block rules installed too",
  );
  assert.ok(
    !browser.sessionRules.some((rule) => rule.condition.urlFilter === "|https://api.openai.com/"),
    "the previous endpoint is no longer allowed",
  );
});

test("a ui.locale change rebuilds the menus in the new language; other changes leave them alone", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", { settings: { ui: { locale: "en" } } });
  await browser.settle(); // onChanged is asynchronous: let this first write go by unobserved
  sw.run(() => chrome.storage.onChanged.addListener(onStorageChanged));

  browser.storageSet("local", { settings: { ui: { locale: "vi" } } });
  await until(() => menuTitles(browser)[0] === catalogFor("vi").menu.translateImage, "Vietnamese menus");
  assert.deepEqual(menuTitles(browser), [
    catalogFor("vi").menu.translateImage,
    catalogFor("vi").menu.retranslateImage,
  ]);
  assert.equal(currentLocale(), "vi", "the worker's msg() follows the setting");
  await browser.settle();
  const rebuilds = callCount(browser, "contextMenus.removeAll");
  assert.equal(rebuilds, 1);

  browser.storageSet("local", { settings: { ui: { locale: "vi" }, debug: { logLevel: "debug" } } });
  browser.storageSet("local", { "site:https://reader.example": { enabled: true, addedAt: 1 } });
  await until(() => browser.registeredScripts.size === 1, "site change handled");
  await browser.settle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(callCount(browser, "contextMenus.removeAll"), rebuilds, "menus untouched");

  browser.storageSet("local", { settings: { ui: { locale: "en" }, debug: { logLevel: "debug" } } });
  await until(() => menuTitles(browser)[0] === catalogFor("en").menu.translateImage, "English menus");
  assert.equal(currentLocale(), "en");
  assert.equal(browser.menus.size, 2, "rebuilt, never duplicated");
});

test("settingsSnapshot (sw:get-settings) returns migrated settings and sites", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", {
    settings: { api: { concurrency: "x", baseUrl: "http://localhost:1234" } },
    "site:https://a.example": { enabled: true, mode: "weird", addedAt: 9 },
  });
  const snapshot = await sw.run(() => settingsSnapshot());
  assert.equal(snapshot.settings.api.concurrency, DEFAULT_SETTINGS.api.concurrency);
  assert.equal(snapshot.settings.api.baseUrl, "http://localhost:1234/v1");
  assert.equal(snapshot.sites["https://a.example"]?.mode, "auto");
});
