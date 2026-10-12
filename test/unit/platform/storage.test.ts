import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  loadAll,
  loadAllSites,
  loadSettings,
  loadSite,
  mergeDeep,
  removeSite,
  saveSettings,
  saveSite,
  sitesFrom,
  watchSettings,
  watchSites,
} from "../../../src/platform/storage.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SITE,
  type Settings,
  type SiteSettings,
} from "../../../src/shared/settings.ts";
import { SETTINGS_VERSION } from "../../../src/shared/versions.ts";
import { FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";

let browser: FakeBrowser;
let sw: FakeContext;

beforeEach(async () => {
  browser = new FakeBrowser();
  browser.install();
  sw = await browser.startServiceWorker();
});

afterEach(() => {
  browser.uninstall();
});

test("mergeDeep merges plain objects, replaces arrays and scalars, ignores undefined", () => {
  assert.deepEqual(mergeDeep({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3 }, list: [9] }), {
    a: { x: 1, y: 3 },
    list: [9],
  });
  assert.deepEqual(mergeDeep({ a: 1 }, { a: undefined, b: null }), { a: 1, b: null });
  assert.deepEqual(mergeDeep(undefined, { a: { b: 1 } }), { a: { b: 1 } });
  const base = { a: 1 };
  assert.equal(mergeDeep(base, undefined), base, "no patch keeps the base");
  assert.equal(mergeDeep("x", 5), 5);
});

test("nothing stored → default settings; a patch round-trips migrated and clamped", async () => {
  await sw.run(async () => {
    assert.deepEqual(await loadSettings(), DEFAULT_SETTINGS);
    const saved = await saveSettings({ api: { baseUrl: "http://127.0.0.1:11434/v1", concurrency: 9 } });
    assert.equal(saved.api.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(saved.api.concurrency, 4, "clamped to LIMITS");
    assert.equal(saved.api.model, DEFAULT_SETTINGS.api.model, "untouched fields kept");
    assert.equal(saved.api.apiKey, DEFAULT_SETTINGS.api.apiKey, "untouched fields kept");
    assert.deepEqual(await loadSettings(), saved);
  });
  const stored = browser.storageGet("local", "settings") as Settings;
  assert.equal(stored.schemaVersion, SETTINGS_VERSION);
  assert.equal(stored.api.concurrency, 4, "the stored value is the migrated one");
});

test("api patches: base URL normalized, key and model kept, temperature null kept and numbers clamped", async () => {
  await sw.run(async () => {
    const saved = await saveSettings({
      api: { baseUrl: " http://localhost:1234/ ", apiKey: "sk-test", model: "llava:13b", temperature: null },
    });
    assert.equal(saved.api.baseUrl, "http://localhost:1234/v1", "a bare origin gets the /v1 version path");
    assert.equal(saved.api.apiKey, "sk-test");
    assert.equal(saved.api.model, "llava:13b");
    assert.equal(saved.api.temperature, null, "null leaves the provider's default");
    assert.equal(
      (browser.storageGet("local", "settings") as Settings).api.temperature,
      null,
      "stored as null",
    );
    assert.equal((await loadSettings()).api.temperature, null, "null survives a read");

    const warmer = await saveSettings({ api: { temperature: 5 } });
    assert.equal(warmer.api.temperature, 2, "clamped to LIMITS");
    assert.equal(warmer.api.apiKey, "sk-test", "earlier api fields kept");
    assert.equal(warmer.api.baseUrl, "http://localhost:1234/v1");

    const hosted = await saveSettings({
      api: { baseUrl: "https://openrouter.ai/api/v1/", temperature: 0.7 },
    });
    assert.equal(hosted.api.baseUrl, "https://openrouter.ai/api/v1", "a version path is kept as given");
    assert.equal(hosted.api.temperature, 0.7);
    assert.equal(hosted.api.model, "llava:13b");

    const cleared = await saveSettings({ api: { apiKey: "" } });
    assert.equal(cleared.api.apiKey, "", "an empty key (local servers) is a valid value");

    const ui = await saveSettings({ ui: { locale: "vi" }, translate: { targetLang: "en" } });
    assert.equal(ui.ui.locale, "vi");
    assert.equal(ui.translate.targetLang, "en");
    assert.equal(ui.api.baseUrl, "https://openrouter.ai/api/v1", "other sections untouched");
  });
});

test("schema-1 settings (endpoint under the legacy key) are read back as api and rewritten on save", async () => {
  browser.storageSet("local", {
    settings: {
      schemaVersion: 1,
      adapter: {
        baseUrl: "http://127.0.0.1:4925/",
        sessionId: "legacy-session",
        concurrency: 3,
        firstByteTimeoutMs: 200_000,
      },
      debug: { logLevel: "warn" },
    },
  });
  await sw.run(async () => {
    const loaded = await loadSettings();
    assert.equal(loaded.schemaVersion, SETTINGS_VERSION);
    assert.equal(loaded.api.baseUrl, "http://127.0.0.1:4925/v1", "the bare legacy origin gets /v1");
    assert.equal(loaded.api.concurrency, 3);
    assert.equal(loaded.api.firstByteTimeoutMs, 200_000);
    assert.equal(loaded.api.apiKey, "", "the legacy proxy needed no key");
    assert.equal(loaded.api.model, DEFAULT_SETTINGS.api.model);
    assert.equal(loaded.debug.logLevel, "warn", "other sections are kept");
    assert.equal("adapter" in loaded, false);
    assert.equal("sessionId" in loaded.api, false, "session ids are gone");
    assert.deepEqual((await loadAll()).settings, loaded, "loadAll migrates the same way");

    await saveSettings({ debug: { logLevel: "error" } });
  });
  const stored = browser.storageGet("local", "settings") as Record<string, unknown>;
  assert.equal("adapter" in stored, false, "the legacy key is dropped from storage");
  assert.equal((stored as unknown as Settings).schemaVersion, SETTINGS_VERSION);
  assert.equal((stored as unknown as Settings).api.baseUrl, "http://127.0.0.1:4925/v1");
  assert.equal((stored as unknown as Settings).api.concurrency, 3);
  assert.equal((stored as unknown as Settings).debug.logLevel, "error");
});

test("a first save that patches api keeps the endpoint stored under the legacy key", async () => {
  browser.storageSet("local", {
    settings: { schemaVersion: 1, adapter: { baseUrl: "http://127.0.0.1:4925", concurrency: 3 } },
  });
  const saved = await sw.run(() => saveSettings({ api: { apiKey: "sk-test" } }));
  assert.equal(saved.api.baseUrl, "http://127.0.0.1:4925/v1", "the patch merges over the upgraded endpoint");
  assert.equal(saved.api.concurrency, 3);
  assert.equal(saved.api.apiKey, "sk-test");
  const stored = browser.storageGet("local", "settings") as Record<string, unknown>;
  assert.equal("adapter" in stored, false);
  assert.equal((stored as unknown as Settings).api.baseUrl, "http://127.0.0.1:4925/v1");
});

test("garbage in storage is migrated on read, and patches merge into what was stored", async () => {
  browser.storageSet("local", { settings: { api: { concurrency: "two", baseUrl: 5 }, bogus: true } });
  await sw.run(async () => {
    const loaded = await loadSettings();
    assert.equal(loaded.api.concurrency, DEFAULT_SETTINGS.api.concurrency);
    assert.equal(loaded.api.baseUrl, DEFAULT_SETTINGS.api.baseUrl);
    await saveSettings({ privacy: { ackUploadNoticeAt: 1234 } });
    await saveSettings({ debug: { logLevel: "debug" } });
    const final = await loadSettings();
    assert.equal(final.privacy.ackUploadNoticeAt, 1234);
    assert.equal(final.debug.logLevel, "debug");
    assert.equal("bogus" in (browser.storageGet("local", "settings") as object), false);
  });
});

test("concurrent saves in one context do not lose updates", async () => {
  await sw.run(async () => {
    await Promise.all([
      saveSettings({ api: { concurrency: 1 } }),
      saveSettings({ debug: { logLevel: "warn" } }),
      saveSettings({ privacy: { devFixtureHosts: ["127.0.0.1:8080"] } }),
      saveSettings({ api: { model: "gpt-4o" } }),
    ]);
    const settings = await loadSettings();
    assert.equal(settings.api.concurrency, 1);
    assert.equal(settings.api.model, "gpt-4o", "two patches of the same section both land");
    assert.equal(settings.debug.logLevel, "warn");
    assert.deepEqual(settings.privacy.devFixtureHosts, ["127.0.0.1:8080"]);
  });
});

test("sites: defaults when unknown, saveSite creates with addedAt and merges later patches", async () => {
  await sw.run(async () => {
    const unknown = await loadSite("https://a.example", 77);
    assert.deepEqual(unknown, { ...DEFAULT_SITE, addedAt: 77 });
    const created = await saveSite("https://a.example", { enabled: true }, 1000);
    assert.equal(created.enabled, true);
    assert.equal(created.addedAt, 1000);
    const updated = await saveSite("https://a.example", { mode: "manual" }, 5000);
    assert.equal(updated.enabled, true, "earlier fields kept");
    assert.equal(updated.mode, "manual");
    assert.equal(updated.addedAt, 1000, "addedAt never moves");
    const invalid = await saveSite("https://a.example", {
      mode: "sometimes",
    } as unknown as Partial<SiteSettings>);
    assert.equal(invalid.mode, DEFAULT_SITE.mode, "migrated");
  });
  assert.equal((browser.storageGet("local", "site:https://a.example") as SiteSettings).addedAt, 1000);
});

test("invalid site keys are refused before anything is written", () => {
  sw.run(() => {
    for (const bad of ["https://a.example/", "a.example", "chrome://newtab"]) {
      assert.throws(() => saveSite(bad, { enabled: true }), CtvError);
      assert.throws(() => removeSite(bad), CtvError);
    }
  });
  assert.equal(browser.storage.local.data.size, 0);
});

test("loadAllSites / loadAll return every valid site key, migrated; removeSite deletes", async () => {
  browser.storageSet("local", {
    settings: { debug: { logLevel: "error" } },
    "site:https://a.example": { enabled: true, addedAt: 1 },
    "site:http://127.0.0.1:8080": { enabled: false, mode: "manual", addedAt: 2 },
    "site:not-an-origin": { enabled: true },
    "dnr:other": 1,
  });
  await sw.run(async () => {
    const sites = await loadAllSites();
    assert.deepEqual(Object.keys(sites).sort(), ["http://127.0.0.1:8080", "https://a.example"]);
    assert.equal(sites["http://127.0.0.1:8080"]?.mode, "manual");
    const all = await loadAll();
    assert.equal(all.settings.debug.logLevel, "error");
    assert.deepEqual(all.sites, sites);
    await removeSite("https://a.example");
    assert.deepEqual(Object.keys(await loadAllSites()), ["http://127.0.0.1:8080"]);
  });
  assert.deepEqual(sitesFrom({ "site:https://x.example": null }, 5)["https://x.example"], {
    ...DEFAULT_SITE,
    addedAt: 5,
  });
});

test("content scripts can read settings and sites (storage.local is open to them)", async () => {
  browser.storageSet("local", { "site:https://reader.example": { enabled: true, addedAt: 1 } });
  const tab = browser.openTab("https://reader.example/ch/1");
  const cs = browser.injectContent(tab.id);
  const all = await cs.run(() => loadAll());
  assert.equal(all.sites["https://reader.example"]?.enabled, true);
});

test("watchSettings delivers migrated settings; watchSites reports changes and removals; both unsubscribe", async () => {
  const seen: string[] = [];
  const stop = sw.run(() => [
    watchSettings((settings) => seen.push(`settings:${settings.api.concurrency}`)),
    watchSites((siteKey, site) =>
      seen.push(`site:${siteKey}:${site === null ? "removed" : String(site.enabled)}`),
    ),
  ]);
  browser.storageSet("local", { settings: { api: { concurrency: 7 } } });
  browser.storageSet("local", {
    "site:https://a.example": { enabled: true },
    "site:junk": { enabled: true },
  });
  browser.storageSet("session", { settings: { api: { concurrency: 1 } } });
  await browser.settle();
  await sw.run(() => removeSite("https://a.example"));
  await browser.settle();
  assert.deepEqual(seen, ["settings:4", "site:https://a.example:true", "site:https://a.example:removed"]);
  for (const off of stop) off();
  browser.storageSet("local", { settings: { api: { concurrency: 2 } } });
  await browser.settle();
  assert.equal(seen.length, 3);
});
