import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SITE,
  LIMITS,
  inFlightCap,
  migrateSettings,
  migrateSite,
  normalizeBaseUrl,
  siteStorageKey,
  STORAGE_KEYS,
} from "../../../src/shared/settings.ts";
import { SETTINGS_VERSION } from "../../../src/shared/versions.ts";

describe("DEFAULT_SETTINGS", () => {
  test("the API defaults: OpenAI v1, no key, gpt-4o-mini, temperature 0.2, 2 lanes + urgent, cap 4", () => {
    assert.equal(SETTINGS_VERSION, 2);
    assert.equal(DEFAULT_SETTINGS.schemaVersion, SETTINGS_VERSION);
    assert.deepEqual(DEFAULT_SETTINGS.api, {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0.2,
      concurrency: 2,
      urgentLane: true,
      maxInFlight: 4,
      firstByteTimeoutMs: 180_000,
      idleTimeoutMs: 60_000,
      totalTimeoutMs: 600_000,
      healthTimeoutMs: 5_000,
    });
    assert.equal("adapter" in DEFAULT_SETTINGS, false);
  });

  test("UI language and target language follow the browser by default", () => {
    assert.deepEqual(DEFAULT_SETTINGS.ui, { locale: "auto" });
    assert.equal(DEFAULT_SETTINGS.translate.targetLang, "auto");
  });
});

describe("normalizeBaseUrl", () => {
  test("a bare origin gets the /v1 version path (OpenAI convention)", () => {
    assert.equal(normalizeBaseUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1");
    assert.equal(normalizeBaseUrl("http://localhost:1234/"), "http://localhost:1234/v1");
    assert.equal(normalizeBaseUrl("https://api.openai.com"), "https://api.openai.com/v1");
  });

  test("an existing path is kept; trailing slashes and spaces are removed", () => {
    assert.equal(normalizeBaseUrl("https://api.openai.com/v1"), "https://api.openai.com/v1");
    assert.equal(normalizeBaseUrl("  https://api.openai.com/v1///  "), "https://api.openai.com/v1");
    assert.equal(normalizeBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
    assert.equal(
      normalizeBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai/"),
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
  });

  test("text that is not a URL is only trimmed (configProblem reports it later)", () => {
    assert.equal(normalizeBaseUrl("  not a url/ "), "not a url");
    assert.equal(normalizeBaseUrl(""), "");
  });
});

describe("migrateSettings", () => {
  test("nothing stored → the defaults", () => {
    assert.deepEqual(migrateSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(migrateSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(migrateSettings("garbage"), DEFAULT_SETTINGS);
    assert.deepEqual(migrateSettings([1, 2]), DEFAULT_SETTINGS);
  });

  test("defaults are inside their own limits", () => {
    for (const [path, [min, max]] of Object.entries(LIMITS)) {
      const [section, field] = path.split(".") as [string, string];
      const value = (DEFAULT_SETTINGS as unknown as Record<string, Record<string, unknown>>)[section]?.[
        field
      ];
      if (value === null) continue; // nullable fields (boxBudget)
      assert.equal(typeof value, "number", path);
      assert.ok((value as number) >= min && (value as number) <= max, `${path}=${JSON.stringify(value)}`);
    }
  });

  test("keeps valid values, clamps numbers to LIMITS, drops unknown keys", () => {
    const migrated = migrateSettings({
      enabled: false,
      api: { concurrency: 9, baseUrl: "https://openrouter.ai/api/v1", bogus: 1 },
      detector: { scoreMin: 0.01 },
      translate: { boxBudget: 99 },
      unknownSection: { a: 1 },
    });
    assert.equal(migrated.enabled, false);
    assert.equal(migrated.api.concurrency, 4);
    assert.equal(migrated.api.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(migrated.detector.scoreMin, 0.1);
    assert.equal(migrated.translate.boxBudget, 20);
    assert.equal("bogus" in migrated.api, false);
    assert.equal("unknownSection" in migrated, false);
    assert.equal(migrated.schemaVersion, SETTINGS_VERSION);
  });

  test("the API key, model, UI locale and target language are kept as strings", () => {
    const migrated = migrateSettings({
      api: { apiKey: "sk-test-123", model: "gemini-2.5-flash" },
      ui: { locale: "vi" },
      translate: { targetLang: "es" },
    });
    assert.equal(migrated.api.apiKey, "sk-test-123");
    assert.equal(migrated.api.model, "gemini-2.5-flash");
    assert.equal(migrated.ui.locale, "vi");
    assert.equal(migrated.translate.targetLang, "es");
    const wrong = migrateSettings({
      api: { apiKey: 42, model: null },
      ui: { locale: 5 },
      translate: { targetLang: null },
    });
    assert.equal(wrong.api.apiKey, "");
    assert.equal(wrong.api.model, "gpt-4o-mini");
    assert.equal(wrong.ui.locale, "auto");
    assert.equal(wrong.translate.targetLang, "auto");
  });

  test("the stored base URL is normalized (bare origin → /v1, trailing slash removed)", () => {
    assert.equal(
      migrateSettings({ api: { baseUrl: "http://127.0.0.1:1234" } }).api.baseUrl,
      "http://127.0.0.1:1234/v1",
    );
    assert.equal(
      migrateSettings({ api: { baseUrl: "https://api.openai.com/v1/" } }).api.baseUrl,
      "https://api.openai.com/v1",
    );
  });

  test("temperature: null keeps the provider default; numbers are clamped to 0..2; junk → 0.2", () => {
    assert.equal(migrateSettings({ api: { temperature: null } }).api.temperature, null);
    assert.equal(migrateSettings({ api: { temperature: 0.7 } }).api.temperature, 0.7);
    assert.equal(migrateSettings({ api: { temperature: 0 } }).api.temperature, 0);
    assert.equal(migrateSettings({ api: { temperature: 5 } }).api.temperature, 2);
    assert.equal(migrateSettings({ api: { temperature: -1 } }).api.temperature, 0);
    assert.equal(migrateSettings({ api: { temperature: "0.5" } }).api.temperature, 0.2);
    assert.equal(migrateSettings({ api: { temperature: Number.NaN } }).api.temperature, 0.2);
  });

  test("API timeouts and lanes are clamped to their limits", () => {
    const low = migrateSettings({
      api: { concurrency: 0, maxInFlight: 0, firstByteTimeoutMs: 1, healthTimeoutMs: 1, totalTimeoutMs: 1 },
    });
    assert.equal(low.api.concurrency, 1);
    assert.equal(low.api.maxInFlight, 1);
    assert.equal(low.api.firstByteTimeoutMs, 10_000);
    assert.equal(low.api.healthTimeoutMs, 500);
    assert.equal(low.api.totalTimeoutMs, 60_000);
    const high = migrateSettings({ api: { idleTimeoutMs: 1e9, healthTimeoutMs: 1e9 } });
    assert.equal(high.api.idleTimeoutMs, 300_000);
    assert.equal(high.api.healthTimeoutMs, 30_000);
  });

  test("wrong types fall back to the default; NaN/Infinity are rejected", () => {
    const migrated = migrateSettings({
      enabled: "yes",
      api: { concurrency: Number.NaN, idleTimeoutMs: Number.POSITIVE_INFINITY, urgentLane: "no" },
      render: { font: 3 },
      privacy: { devFixtureHosts: ["127.0.0.1:8080", 5] },
    });
    assert.equal(migrated.enabled, true);
    assert.equal(migrated.api.concurrency, DEFAULT_SETTINGS.api.concurrency);
    assert.equal(migrated.api.idleTimeoutMs, DEFAULT_SETTINGS.api.idleTimeoutMs);
    assert.equal(migrated.api.urgentLane, true);
    assert.equal(migrated.render.font, "patrick-hand");
    assert.deepEqual(migrated.privacy.devFixtureHosts, []);
  });

  test("nullable fields accept null and numbers", () => {
    assert.equal(migrateSettings({ translate: { boxBudget: null } }).translate.boxBudget, null);
    assert.equal(migrateSettings({ translate: { boxBudget: 12 } }).translate.boxBudget, 12);
    assert.equal(
      migrateSettings({ privacy: { ackUploadNoticeAt: 1700000000000 } }).privacy.ackUploadNoticeAt,
      1700000000000,
    );
    assert.equal(migrateSettings({ privacy: { ackUploadNoticeAt: "x" } }).privacy.ackUploadNoticeAt, null);
  });

  test("keeps paired ranges consistent", () => {
    const migrated = migrateSettings({
      discovery: {
        lookaheadMinScreens: 8,
        lookaheadMaxScreens: 3,
        detectAheadMinScreens: 40,
        detectAheadMaxScreens: 20,
      },
      render: { minFontPx: 16, maxFontPx: 16 },
      api: { concurrency: 4, maxInFlight: 2 },
    });
    assert.equal(migrated.discovery.lookaheadMaxScreens, 8);
    assert.equal(migrated.discovery.detectAheadMaxScreens, 40);
    assert.ok(migrated.render.maxFontPx >= migrated.render.minFontPx);
    assert.equal(migrated.api.maxInFlight, 4, "the cap never drops below the normal lanes");
  });

  test("the result is a fresh object (mutations never leak into DEFAULT_SETTINGS)", () => {
    const migrated = migrateSettings({});
    migrated.privacy.devFixtureHosts.push("x");
    migrated.api.concurrency = 1;
    migrated.api.apiKey = "sk-leak";
    assert.deepEqual(DEFAULT_SETTINGS.privacy.devFixtureHosts, []);
    assert.equal(DEFAULT_SETTINGS.api.concurrency, 2);
    assert.equal(DEFAULT_SETTINGS.api.apiKey, "");
  });

  test("migration is idempotent", () => {
    const once = migrateSettings({ api: { baseUrl: "http://127.0.0.1:8080", temperature: null } });
    assert.deepEqual(migrateSettings(once), once);
  });
});

describe("migrateSettings: schema 1 (legacy `adapter` key)", () => {
  /** What schema 1 stored: a local proxy at a bare origin, no API key or model. */
  const legacy = {
    schemaVersion: 1,
    enabled: true,
    adapter: {
      baseUrl: "http://127.0.0.1:8000",
      sessionId: "s-123",
      concurrency: 3,
      urgentLane: false,
      maxInFlight: 4,
      firstByteTimeoutMs: 240_000,
      idleTimeoutMs: 90_000,
      totalTimeoutMs: 900_000,
      healthTimeoutMs: 2_000,
    },
    translate: { jpegQuality: 0.85 },
  };

  test("moves the endpoint to `api`, adds /v1 and keeps the tuning values", () => {
    const migrated = migrateSettings(legacy);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal("adapter" in migrated, false);
    assert.deepEqual(migrated.api, {
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0.2,
      concurrency: 3,
      urgentLane: false,
      maxInFlight: 4,
      firstByteTimeoutMs: 240_000,
      idleTimeoutMs: 90_000,
      totalTimeoutMs: 900_000,
      healthTimeoutMs: 2_000,
    });
    assert.equal("sessionId" in migrated.api, false);
    assert.equal(migrated.translate.jpegQuality, 0.85, "other sections are untouched");
    assert.deepEqual(migrated.ui, { locale: "auto" }, "new sections get their defaults");
    assert.equal(migrated.translate.targetLang, "auto");
  });

  test("the input object is not mutated", () => {
    const copy = structuredClone(legacy);
    migrateSettings(copy);
    assert.deepEqual(copy, legacy);
  });

  test("legacy values are clamped like current ones; a legacy layout without baseUrl gets the default", () => {
    const migrated = migrateSettings({ adapter: { concurrency: 12 } });
    assert.equal(migrated.api.concurrency, 4);
    assert.equal(migrated.api.baseUrl, DEFAULT_SETTINGS.api.baseUrl);
  });

  test("fields under `api` win; a leftover `adapter` fills only the fields `api` lacks", () => {
    // A partial `api` patch saved over a schema 1 value: the new fields win, the old tuning is kept.
    const migrated = migrateSettings({
      api: { baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" },
      adapter: { baseUrl: "http://127.0.0.1:8000", concurrency: 1, sessionId: "s-1" },
    });
    assert.equal(migrated.api.baseUrl, "https://api.openai.com/v1");
    assert.equal(migrated.api.model, "gpt-5-mini");
    assert.equal(migrated.api.concurrency, 1, "taken from the legacy key");
    assert.equal("adapter" in migrated, false);
    assert.equal("sessionId" in migrated.api, false);
  });

  test("a schema 1 value with a newer `api` key but no base URL keeps the normalized legacy endpoint", () => {
    const migrated = migrateSettings({
      api: { apiKey: "sk-local" },
      adapter: { baseUrl: "http://127.0.0.1:8000/" },
    });
    assert.equal(migrated.api.baseUrl, "http://127.0.0.1:8000/v1");
    assert.equal(migrated.api.apiKey, "sk-local");
  });

  test("a non-object `adapter` value is ignored", () => {
    assert.deepEqual(migrateSettings({ adapter: "http://127.0.0.1:8000" }), DEFAULT_SETTINGS);
  });
});

describe("migrateSite", () => {
  test("defaults: opt-in off, auto mode, auto Referer, omit credentials, prefetch on", () => {
    const site = migrateSite(undefined, 123);
    assert.deepEqual(site, { ...DEFAULT_SITE, addedAt: 123 });
    assert.equal(site.enabled, false);
  });

  test("keeps valid values and the stored addedAt; rejects unknown enum values", () => {
    const site = migrateSite(
      {
        enabled: true,
        mode: "manual",
        referer: "sideways",
        credentials: "include",
        layout: "webtoon",
        addedAt: 5,
      },
      123,
    );
    assert.equal(site.enabled, true);
    assert.equal(site.mode, "manual");
    assert.equal(site.referer, "auto");
    assert.equal(site.credentials, "include");
    assert.equal(site.layout, "webtoon");
    assert.equal(site.addedAt, 5);
  });

  test("source languages: es is accepted, unknown codes fall back to auto", () => {
    assert.equal(migrateSite({ sourceLang: "es" }, 1).sourceLang, "es");
    assert.equal(migrateSite({ sourceLang: "vi" }, 1).sourceLang, "auto");
    assert.equal(migrateSite({ mode: "sometimes", layout: "spiral", addedAt: Number.NaN }, 7).addedAt, 7);
  });
});

test("in-flight cap: concurrency + urgent lane, never above maxInFlight", () => {
  assert.equal(inFlightCap(DEFAULT_SETTINGS), 3);
  assert.equal(inFlightCap(migrateSettings({ api: { concurrency: 4 } })), 4);
  assert.equal(inFlightCap(migrateSettings({ api: { urgentLane: false } })), 2);
  assert.equal(inFlightCap(migrateSettings({ api: { concurrency: 1, maxInFlight: 1 } })), 1);
});

test("storage keys", () => {
  assert.equal(STORAGE_KEYS.settings, "settings");
  assert.equal(siteStorageKey("https://comic.example"), "site:https://comic.example");
});

describe("render: lettering fonts and the bubble popup", () => {
  test("defaults: Patrick Hand dialogue, SFX labelled not erased, Alt+click opens the popup", () => {
    assert.equal(DEFAULT_SETTINGS.render.font, "patrick-hand");
    assert.equal(DEFAULT_SETTINGS.render.eraseSfx, false);
    assert.equal(DEFAULT_SETTINGS.render.sfxLabels, true);
    assert.equal(DEFAULT_SETTINGS.render.popupWithAltClick, true);
  });

  test("a stored font outside patrick-hand / mali falls back to the default; booleans keep their type", () => {
    assert.equal(migrateSettings({ render: { font: "mali" } }).render.font, "mali");
    assert.equal(migrateSettings({ render: { font: "comic-sans" } }).render.font, "patrick-hand");
    const off = migrateSettings({ render: { popupWithAltClick: false, eraseSfx: true, sfxLabels: false } });
    assert.deepEqual(
      [off.render.popupWithAltClick, off.render.eraseSfx, off.render.sfxLabels],
      [false, true, false],
    );
    assert.equal(migrateSettings({ render: { popupWithAltClick: "no" } }).render.popupWithAltClick, true);
  });
});

describe("render.verticalText", () => {
  test("auto by default; auto and never are kept, anything else falls back to auto", () => {
    assert.equal(DEFAULT_SETTINGS.render.verticalText, "auto");
    assert.equal(migrateSettings({ render: { verticalText: "never" } }).render.verticalText, "never");
    assert.equal(migrateSettings({ render: { verticalText: "auto" } }).render.verticalText, "auto");
    assert.equal(migrateSettings({ render: { verticalText: "always" } }).render.verticalText, "auto");
    assert.equal(migrateSettings({ render: { verticalText: 1 } }).render.verticalText, "auto");
  });
});
