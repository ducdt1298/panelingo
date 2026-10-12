// Settings inside the engine: migration on apply, site defaults, change events, kv "settings.mirror".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSettingsCache } from "../../../src/engine/settings-cache.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/shared/settings.ts";
import { captureLogger, ManualClock, memoryStores } from "./store/engine-fakes.ts";

function patched(patch: (settings: Settings) => void): Settings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  patch(settings);
  return settings;
}

test("defaults until something is applied; unknown sites get DEFAULT_SITE with addedAt = now", () => {
  const clock = new ManualClock();
  const cache = createSettingsCache({ clock });
  assert.deepEqual(cache.current(), DEFAULT_SETTINGS);
  assert.deepEqual(cache.sites(), {});
  const site = cache.site("https://reader.example");
  assert.equal(site.enabled, false);
  assert.equal(site.mode, "auto");
  assert.equal(site.addedAt, clock.now());
});

test("apply() migrates and clamps, keeps sites, and notifies only on change", () => {
  const clock = new ManualClock();
  const { log, entries } = captureLogger();
  const cache = createSettingsCache({ clock, log });
  const seen: number[] = [];
  const off = cache.onChange((settings) => seen.push(settings.api.concurrency));
  cache.onChange(() => {
    throw new Error("listener bug");
  });
  const raw = patched((s) => {
    s.api.concurrency = 99;
  });
  cache.apply(raw, { "https://reader.example": { enabled: true, mode: "manual", bogus: 1 } as never });
  assert.equal(cache.current().api.concurrency, 4, "clamped to LIMITS");
  assert.equal(cache.site("https://reader.example").mode, "manual");
  assert.equal(cache.site("https://reader.example").enabled, true);
  assert.deepEqual(seen, [4]);
  cache.apply(raw, { "https://reader.example": { enabled: true, mode: "manual" } as never });
  assert.deepEqual(seen, [4], "same values: no event");
  assert.ok(entries.some((entry) => entry.msg === "settings listener threw"));
  off();
  cache.apply(DEFAULT_SETTINGS, {});
  assert.deepEqual(seen, [4]);
  cache.apply("garbage" as never, "garbage" as never);
  assert.deepEqual(cache.current(), DEFAULT_SETTINGS);
  assert.deepEqual(cache.sites(), {});
});

test("apply() upgrades the schema-1 layout: adapter → api, a bare origin gets /v1", () => {
  const clock = new ManualClock();
  const cache = createSettingsCache({ clock });
  cache.apply(
    {
      schemaVersion: 1,
      adapter: { baseUrl: "http://127.0.0.1:11434/", sessionId: "legacy", concurrency: 3 },
    } as never,
    {},
  );
  const api = cache.current().api;
  assert.equal(cache.current().schemaVersion, DEFAULT_SETTINGS.schemaVersion);
  assert.equal(api.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(api.concurrency, 3);
  assert.equal(api.model, DEFAULT_SETTINGS.api.model, "schema 1 had no model: the default fills in");
  assert.equal(api.apiKey, "");
  assert.equal(Object.hasOwn(cache.current(), "adapter"), false);
  assert.equal(Object.hasOwn(api, "sessionId"), false);
});

test("attach() loads the kv mirror when nothing was applied, and mirrors every later apply", async () => {
  const clock = new ManualClock();
  const stores = memoryStores();
  const saved = patched((s) => {
    s.engine.idleCloseMin = 20;
  });
  await stores.kv.set("settings.mirror", { settings: saved, sites: {}, at: 1 });
  const cache = createSettingsCache({ clock });
  assert.equal(await cache.attach(stores.kv), true);
  assert.equal(cache.current().engine.idleCloseMin, 20);

  // A mirror written by a schema-1 build is upgraded on load.
  const legacy = memoryStores();
  await legacy.kv.set("settings.mirror", {
    settings: { schemaVersion: 1, adapter: { baseUrl: "http://localhost:1234" } } as never,
    sites: {},
    at: 1,
  });
  const upgraded = createSettingsCache({ clock });
  assert.equal(await upgraded.attach(legacy.kv), true);
  assert.equal(upgraded.current().api.baseUrl, "http://localhost:1234/v1");

  cache.apply(
    patched((s) => {
      s.engine.idleCloseMin = 30;
    }),
    {},
  );
  await Promise.resolve();
  const mirror = await stores.kv.get("settings.mirror");
  assert.equal(mirror?.settings.engine.idleCloseMin, 30);
  assert.equal(mirror?.at, clock.now());
});

test("a mirror never overrides settings applied before attach(); those are written instead", async () => {
  const clock = new ManualClock();
  const stores = memoryStores();
  await stores.kv.set("settings.mirror", { settings: DEFAULT_SETTINGS, sites: {}, at: 1 });
  const cache = createSettingsCache({ clock });
  cache.apply(
    patched((s) => {
      s.debug.logLevel = "debug";
    }),
    {},
  );
  assert.equal(await cache.attach(stores.kv), false);
  assert.equal(cache.current().debug.logLevel, "debug");
  await Promise.resolve();
  assert.equal((await stores.kv.get("settings.mirror"))?.settings.debug.logLevel, "debug");
});

test("an unreadable mirror is logged and ignored", async () => {
  const clock = new ManualClock();
  const { log, entries } = captureLogger();
  const stores = memoryStores();
  const cache = createSettingsCache({ clock, log });
  const broken = { ...stores.kv, get: () => Promise.reject(new Error("disk")) };
  assert.equal(await cache.attach(broken), false);
  assert.ok(entries.some((entry) => entry.msg === "settings mirror unreadable"));
  assert.deepEqual(cache.current(), DEFAULT_SETTINGS);
});
