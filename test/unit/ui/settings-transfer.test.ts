// Settings export and import (src/ui/options/settings-transfer.ts): the API key only on request, never the privacy
// confirmation or the dev fixture hosts; an import round-trips, is migrated like stored values and invalid files are
// refused with a reason.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  migrateSite,
  type Settings,
} from "../../../src/shared/settings.ts";
import {
  changedPaths,
  exportFileName,
  exportSettings,
  parseSettingsImport,
  SETTINGS_EXPORT_FORMAT,
  SETTINGS_EXPORT_VERSION,
  type SettingsExport,
} from "../../../src/ui/options/settings-transfer.ts";

const NOW = new Date(Date.UTC(2026, 9, 11, 9, 30, 5, 42));

function mine(): Settings {
  return migrateSettings({
    api: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-secret", model: "x/y", temperature: null },
    render: { maxFontPx: 40, font: "mali" },
    memory: { historyMaxLines: 5 },
    privacy: { ackUploadNoticeAt: 1_700_000_000_000, devFixtureHosts: ["127.0.0.1:5000"] },
    ui: { locale: "vi" },
  });
}

const SITES = {
  "https://b.example": migrateSite({ enabled: true, mode: "manual", layout: "paged-rtl", addedAt: 2 }, 0),
  "https://a.example": migrateSite(
    { enabled: false, extraFrameOrigins: ["https://v.example"], addedAt: 1 },
    0,
  ),
};

function exported(includeApiKey: boolean): SettingsExport {
  return exportSettings({ settings: mine(), sites: SITES }, { includeApiKey, now: NOW, build: "0.1.0+test" });
}

describe("exportSettings", () => {
  test("format header, settings without the API key, the privacy confirmation or dev hosts; sites sorted", () => {
    const data = exported(false);
    assert.deepEqual(
      [data.format, data.version, data.exportedAt, data.build],
      [SETTINGS_EXPORT_FORMAT, SETTINGS_EXPORT_VERSION, NOW.toISOString(), "0.1.0+test"],
    );
    const api = data.settings["api"] as Record<string, unknown>;
    const privacy = data.settings["privacy"] as Record<string, unknown>;
    assert.ok(!("apiKey" in api), "no API key by default");
    assert.equal(api["model"], "x/y");
    assert.ok(!("ackUploadNoticeAt" in privacy) && !("devFixtureHosts" in privacy));
    assert.equal(privacy["maxImageBytes"], DEFAULT_SETTINGS.privacy.maxImageBytes);
    assert.doesNotMatch(JSON.stringify(data), /sk-or-secret|127\.0\.0\.1:5000|1700000000000/u);
    assert.deepEqual(Object.keys(data.sites), ["https://a.example", "https://b.example"]);
    assert.deepEqual(data.sites["https://b.example"], SITES["https://b.example"]);
  });

  test("the API key only when asked for; the current settings are not modified", () => {
    const settings = mine();
    const data = exportSettings({ settings, sites: {} }, { includeApiKey: true, now: NOW, build: "b" });
    assert.equal((data.settings["api"] as Record<string, unknown>)["apiKey"], "sk-or-secret");
    exportSettings({ settings, sites: {} }, { includeApiKey: false, now: NOW, build: "b" });
    assert.equal(settings.api.apiKey, "sk-or-secret");
    assert.equal(settings.privacy.ackUploadNoticeAt, 1_700_000_000_000);
  });

  test("file name: an ISO time stamp without characters Windows forbids", () => {
    assert.equal(exportFileName(NOW), "panelingo-settings-2026-10-11T09-30-05-042Z.json");
  });
});

describe("parseSettingsImport", () => {
  const fresh = migrateSettings({
    api: { apiKey: "sk-local" },
    privacy: { ackUploadNoticeAt: 5, devFixtureHosts: ["127.0.0.1:9"] },
  });

  test("round trip with the key: settings and sites come back; local-only values stay local", () => {
    const result = parseSettingsImport(JSON.stringify(exported(true)), fresh, 99);
    assert.ok(result.ok);
    const { settings, sites, apiKeyImported } = result.value;
    assert.equal(apiKeyImported, true);
    assert.deepEqual(settings, {
      ...mine(),
      privacy: { ...mine().privacy, ackUploadNoticeAt: 5, devFixtureHosts: ["127.0.0.1:9"] },
    });
    assert.deepEqual(sites, SITES);
  });

  test("without a key in the file the current key is kept", () => {
    const result = parseSettingsImport(JSON.stringify(exported(false)), fresh, 99);
    assert.ok(result.ok);
    assert.equal(result.value.apiKeyImported, false);
    assert.equal(result.value.settings.api.apiKey, "sk-local");
    assert.equal(result.value.settings.api.model, "x/y");
  });

  test("lists the setting paths that change", () => {
    const result = parseSettingsImport(JSON.stringify(exported(false)), fresh, 99);
    assert.ok(result.ok);
    assert.deepEqual(result.value.changed.sort(), [
      "api.baseUrl",
      "api.model",
      "api.temperature",
      "memory.historyMaxLines",
      "render.font",
      "render.maxFontPx",
      "ui.locale",
    ]);
    const same = parseSettingsImport(
      JSON.stringify(
        exportSettings({ settings: fresh, sites: {} }, { includeApiKey: false, now: NOW, build: "b" }),
      ),
      fresh,
      99,
    );
    assert.ok(same.ok);
    assert.deepEqual(same.value.changed, []);
  });

  test("values are migrated: clamped, unknown keys dropped, dev hosts ignored, invalid sites skipped", () => {
    const file = {
      format: SETTINGS_EXPORT_FORMAT,
      version: 1,
      settings: {
        render: { maxFontPx: 999, minFontPx: "big" },
        api: { maxInFlight: 1, concurrency: 3 },
        privacy: { devFixtureHosts: ["10.0.0.1:80"], ackUploadNoticeAt: 1 },
        evil: { x: 1 },
      },
      sites: {
        "https://ok.example": { enabled: true, layout: "sideways", addedAt: 7 },
        "https://ok.example/path": { enabled: true },
        "javascript:alert(1)": { enabled: true },
        "https://array.example": [1],
      },
    };
    const result = parseSettingsImport(JSON.stringify(file), fresh, 99);
    assert.ok(result.ok);
    const { settings, sites } = result.value;
    assert.equal(settings.render.maxFontPx, 120);
    assert.equal(settings.render.minFontPx, DEFAULT_SETTINGS.render.minFontPx);
    assert.deepEqual([settings.api.concurrency, settings.api.maxInFlight], [3, 3]);
    assert.deepEqual(settings.privacy.devFixtureHosts, ["127.0.0.1:9"]);
    assert.equal(settings.privacy.ackUploadNoticeAt, 5);
    assert.ok(!("evil" in settings));
    assert.deepEqual(Object.keys(sites), ["https://ok.example"]);
    assert.deepEqual(sites["https://ok.example"], { ...migrateSite({ enabled: true }, 0), addedAt: 7 });
  });

  test("refuses invalid JSON, other files and newer export versions", () => {
    const cases: Array<[string, string]> = [
      ["", "json"],
      ["{not json", "json"],
      ["null", "format"],
      ["[]", "format"],
      ['"panelingo-settings"', "format"],
      [JSON.stringify({ version: 1, settings: {} }), "format"],
      [JSON.stringify({ format: "panelingo-glossary", version: 1, settings: {} }), "format"],
      [JSON.stringify({ format: SETTINGS_EXPORT_FORMAT, version: 1 }), "format"],
      [JSON.stringify({ format: SETTINGS_EXPORT_FORMAT, version: 1, settings: [] }), "format"],
      [JSON.stringify({ format: SETTINGS_EXPORT_FORMAT, version: "1", settings: {} }), "format"],
      [JSON.stringify({ format: SETTINGS_EXPORT_FORMAT, version: 0, settings: {} }), "format"],
      [JSON.stringify({ format: SETTINGS_EXPORT_FORMAT, version: 1.5, settings: {} }), "format"],
      [
        JSON.stringify({
          format: SETTINGS_EXPORT_FORMAT,
          version: SETTINGS_EXPORT_VERSION + 1,
          settings: {},
        }),
        "version",
      ],
    ];
    for (const [text, error] of cases) {
      assert.deepEqual(parseSettingsImport(text, fresh, 99), { ok: false, error }, text);
    }
  });

  test("changedPaths compares leaves and whole arrays", () => {
    assert.deepEqual(changedPaths({ a: { b: 1, c: [1] } }, { a: { b: 1, c: [1, 2] }, d: 2 }), ["a.c", "d"]);
    assert.deepEqual(changedPaths({ a: 1 }, { a: 1 }), []);
  });
});
