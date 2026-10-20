// The options page's declarative Advanced table (src/ui/options/advanced-model.ts) against docs/CONFIGURATION.md,
// DEFAULT_SETTINGS, LIMITS and every catalog; parsing, clamping through migrateSettings, defaults and resets.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { catalogFor, uiLocales } from "../../../src/shared/i18n/index.ts";
import { EN } from "../../../src/shared/i18n/en.ts";
import { mergeDeep } from "../../../src/platform/storage.ts";
import { DEFAULT_SETTINGS, LIMITS, migrateSettings } from "../../../src/shared/settings.ts";
import {
  ADVANCED_FIELDS,
  advancedGroups,
  applyField,
  defaultsLine,
  displayValue,
  fieldDefault,
  fieldId,
  fieldRange,
  fieldMatches,
  fieldsAt,
  fieldText,
  formatNumber,
  getSetting,
  isDefault,
  parseInput,
  patchFor,
  placeOf,
  resetAllPatch,
  searchKey,
  setSetting,
  storesIntegers,
  toInput,
  type AdvancedField,
  type NumberField,
  type SettingPath,
} from "../../../src/ui/options/advanced-model.ts";
import { SITE_EDITOR_FIELDS } from "../../../src/ui/options/site-model.ts";

const DOC = readFileSync(new URL("../../../docs/CONFIGURATION.md", import.meta.url), "utf8");

/** Settings edited in the basic sections of the options page (endpoint, languages, privacy notice, log level). */
const BASIC_UI: readonly string[] = [
  "api.baseUrl",
  "api.apiKey",
  "api.model",
  "api.concurrency",
  "ui.locale",
  "translate.targetLang",
  "privacy.ackUploadNoticeAt",
  "debug.logLevel",
];

/** Settings that stay hand-edited on purpose: development and test builds only. */
const DEV_ONLY: readonly string[] = ["privacy.devFixtureHosts", "debug.offlineModelBaseUrl"];

/** `setting` → Status of every table row in a part of docs/CONFIGURATION.md (between two "## " headings). */
function documentedStatus(heading: string): Map<string, string> {
  const start = DOC.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `docs heading ${heading}`);
  const next = DOC.indexOf("\n## ", start + 4);
  const part = DOC.slice(start, next < 0 ? undefined : next);
  const out = new Map<string, string>();
  let statusColumn = -1;
  for (const line of part.split("\n")) {
    if (!line.startsWith("|")) {
      statusColumn = -1;
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (statusColumn < 0) {
      statusColumn = cells.indexOf("Status");
      continue;
    }
    const key = /^`([\w.]+)`$/u.exec(cells[0] ?? "")?.[1];
    const status = cells[statusColumn];
    if (key !== undefined && status !== undefined) out.set(key, status);
  }
  return out;
}

const SETTINGS_DOC = documentedStatus("Settings reference");
const SITE_DOC = documentedStatus("Per-site settings");
const PATHS = ADVANCED_FIELDS.map((field) => field.path as string);

function field(path: SettingPath): AdvancedField {
  const found = ADVANCED_FIELDS.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`no row ${path}`);
  return found;
}

function numberField(path: SettingPath): NumberField {
  const found = field(path);
  if (found.kind !== "number") throw new Error(`${path} is not a number row`);
  return found;
}

describe("the Advanced table and docs/CONFIGURATION.md", () => {
  test("the docs tables were parsed", () => {
    assert.ok(SETTINGS_DOC.size >= 70, `settings rows: ${SETTINGS_DOC.size}`);
    assert.equal(SETTINGS_DOC.get("api.baseUrl"), "UI");
    assert.equal(SITE_DOC.get("mode"), "UI");
  });

  test("every setting documented as editable has a row (or a basic control), and nothing else does", () => {
    const editable = [...SETTINGS_DOC]
      .filter(([, status]) => status === "UI" || status === "Advanced")
      .map(([key]) => key)
      .filter((key) => !DEV_ONLY.includes(key))
      .sort();
    assert.deepEqual(editable, [...BASIC_UI, ...PATHS].sort());
  });

  test("rows are documented with status UI; only dev-only keys remain Advanced", () => {
    for (const path of PATHS) assert.equal(SETTINGS_DOC.get(path), "UI", path);
    const advanced = [...SETTINGS_DOC].filter(([, status]) => status === "Advanced").map(([key]) => key);
    assert.deepEqual(advanced, [...DEV_ONLY]);
  });

  test("every per-site setting documented as UI is edited on the options page", () => {
    const editable = [...SITE_DOC].filter(([, status]) => status === "UI").map(([key]) => key);
    assert.deepEqual([...editable].sort(), [...SITE_EDITOR_FIELDS].sort());
    assert.ok(![...SITE_DOC.values()].includes("Advanced"), "no per-site setting is hand-edited only");
  });
});

describe("where rows are edited, and search", () => {
  test("every row has one place; the Advanced tab keeps the rest, in table order", () => {
    const places = ["advanced", "memory", "lettering", "controls", "custom"] as const;
    const placed = places.flatMap((place) => fieldsAt(place).map((row) => row.path));
    assert.deepEqual([...placed].sort(), [...PATHS].sort(), "no row lost or shown twice");
    assert.deepEqual(
      fieldsAt("memory").map((row) => row.path),
      ["memory.enabled", "memory.warmUp"],
    );
    assert.deepEqual(
      fieldsAt("controls").map((row) => row.path),
      ["render.peekKey", "render.peekWithAlt", "render.popupWithAltClick"],
    );
    assert.ok(fieldsAt("lettering").every((row) => row.path.startsWith("render.")));
    assert.deepEqual(
      fieldsAt("custom").map((row) => row.path),
      ["translate.engine", "translate.offlineModel"],
    );
    assert.equal(placeOf(field("api.temperature")), "advanced");
    assert.deepEqual(
      advancedGroups(fieldsAt("advanced")).map((group) => group.section),
      ["api", "translate", "detector", "engine", "discovery", "memory", "cache", "privacy", "debug"],
    );
  });

  test("searchKey drops case, accents and marks (đ is d)", () => {
    assert.equal(searchKey("Lời thoại ĐẦU"), "loi thoai dau");
    assert.equal(searchKey("Café Élan"), "cafe elan");
    assert.equal(searchKey("フォント"), "フォント".normalize("NFD").replace(/\p{M}/gu, ""));
  });

  test("fieldMatches: every word in the label, hint, group title or path; empty matches everything", () => {
    const t = catalogFor("en");
    const lines = field("memory.historyMaxLines");
    assert.equal(fieldMatches(lines, "", t), true);
    assert.equal(fieldMatches(lines, "   ", t), true);
    assert.equal(fieldMatches(lines, "earlier lines", t), true);
    assert.equal(fieldMatches(lines, "LINES earlier", t), true, "any order and case");
    assert.equal(fieldMatches(lines, "series memory", t), true, "the group title");
    assert.equal(fieldMatches(lines, "historyMaxLines", t), true, "the setting path");
    assert.equal(fieldMatches(lines, "earlier zebra", t), false, "every word must match");
    const vi = catalogFor("vi");
    assert.equal(
      fieldMatches(lines, searchKey(vi.optionsAdvanced.fields["memory.historyMaxLines"].label), vi),
      true,
    );
  });
});

describe("table rows", () => {
  test("unique paths and DOM ids; groups follow the settings sections in table order", () => {
    assert.equal(new Set(PATHS).size, PATHS.length);
    assert.equal(new Set(ADVANCED_FIELDS.map(fieldId)).size, PATHS.length);
    assert.equal(fieldId(field("render.maxFontPx")), "adv-render-maxFontPx");
    assert.deepEqual(
      advancedGroups().map((group) => group.section),
      [
        "api",
        "translate",
        "detector",
        "engine",
        "discovery",
        "render",
        "memory",
        "cache",
        "privacy",
        "debug",
      ],
    );
    assert.equal(
      advancedGroups().reduce((sum, group) => sum + group.fields.length, 0),
      PATHS.length,
    );
  });

  test("each row matches its default's type; numbers have LIMITS that contain the default", () => {
    for (const row of ADVANCED_FIELDS) {
      const value = fieldDefault(row);
      assert.notEqual(value, undefined, `${row.path} exists in DEFAULT_SETTINGS`);
      switch (row.kind) {
        case "boolean":
          assert.equal(typeof value, "boolean", row.path);
          break;
        case "select":
          assert.ok(row.choices.includes(value as string), `${row.path} default is a choice`);
          break;
        case "text":
          assert.equal(typeof value, "string", row.path);
          assert.ok(row.pattern.test(value as string), `${row.path} default is valid`);
          break;
        case "number": {
          const range = LIMITS[row.path];
          assert.ok(range !== undefined, `${row.path} has LIMITS`);
          if (value === null) {
            assert.equal(row.nullable, true, `${row.path} has a null default, so it is nullable`);
          } else {
            assert.equal(typeof value, "number", row.path);
            assert.ok((value as number) >= range[0] && (value as number) <= range[1], row.path);
            if (storesIntegers(row)) assert.ok(Number.isInteger(value), `${row.path} stores integers`);
          }
          break;
        }
      }
    }
  });

  test("labels, hints and group titles come from every catalog", () => {
    for (const { code } of uiLocales()) {
      const t = catalogFor(code);
      for (const row of ADVANCED_FIELDS) {
        const text = fieldText(row, t);
        assert.notEqual(text.label, row.path, `${code} ${row.path} label`);
        assert.notEqual(text.label.trim(), "", `${code} ${row.path} label`);
        assert.notEqual(text.hint.trim(), "", `${code} ${row.path} hint`);
      }
      for (const { section } of advancedGroups()) {
        assert.notEqual((t.optionsAdvanced.groups as Record<string, string>)[section] ?? "", "", section);
      }
    }
    // No catalog text for a row that is not in the table.
    assert.deepEqual(Object.keys(EN.optionsAdvanced.fields).sort(), [...PATHS].sort());
  });

  test("display ranges use the row's scale: seconds, MiB, megapixels", () => {
    assert.deepEqual(fieldRange(numberField("api.firstByteTimeoutMs")), [10, 900]);
    assert.deepEqual(fieldRange(numberField("api.healthTimeoutMs")), [0.5, 30]);
    assert.deepEqual(fieldRange(numberField("privacy.maxImageBytes")), [1, 128]);
    assert.deepEqual(fieldRange(numberField("privacy.maxImagePixels")), [1, 200]);
    assert.deepEqual(fieldRange(numberField("render.minFontPx")), [8, 16]);
  });
});

describe("parseInput", () => {
  test("numbers: trimmed, decimal comma, scaled to stored units, rounded where the setting holds integers", () => {
    const cases: Array<[SettingPath, string, unknown]> = [
      ["render.maxFontPx", " 40 ", 40],
      ["render.maxFontPx", "40.6", 41],
      ["api.temperature", "0,7", 0.7],
      ["api.temperature", ".5", 0.5],
      ["api.firstByteTimeoutMs", "30", 30_000],
      ["api.healthTimeoutMs", "1.5", 1_500],
      ["privacy.maxImageBytes", "16", 16 * 1024 * 1024],
      ["privacy.maxImagePixels", "2.5", 2_500_000],
      ["translate.jpegQuality", "0.85", 0.85],
      ["render.maxFontPx", "1e2", 100],
      ["render.maxFontPx", "-3", -3],
    ];
    for (const [path, input, expected] of cases) {
      assert.deepEqual(parseInput(field(path), input), { ok: true, value: expected }, `${path} ${input}`);
    }
  });

  test("an empty nullable number is null; anything else that is not a number is refused", () => {
    assert.deepEqual(parseInput(field("api.temperature"), " "), { ok: true, value: null });
    assert.deepEqual(parseInput(field("translate.boxBudget"), ""), { ok: true, value: null });
    for (const bad of ["", "abc", "1,2,3", "0x10", "12px", "Infinity", "1e999", "--1"]) {
      assert.deepEqual(parseInput(field("render.maxFontPx"), bad), { ok: false, error: "number" }, bad);
    }
  });

  test("booleans, select choices and key codes", () => {
    assert.deepEqual(parseInput(field("memory.enabled"), false), { ok: true, value: false });
    assert.deepEqual(parseInput(field("memory.enabled"), "true"), { ok: false, error: "choice" });
    assert.deepEqual(parseInput(field("detector.backend"), "wasm"), { ok: true, value: "wasm" });
    assert.deepEqual(parseInput(field("detector.backend"), "cuda"), { ok: false, error: "choice" });
    assert.deepEqual(parseInput(field("render.font"), "mali"), { ok: true, value: "mali" });
    for (const code of ["KeyH", "Backquote", "F2", "AltLeft", " Digit1 ", ""]) {
      assert.deepEqual(parseInput(field("render.peekKey"), code), { ok: true, value: code.trim() }, code);
    }
    for (const bad of ["h", "Key H", "`", "Ctrl+H", "K".repeat(33)]) {
      assert.deepEqual(parseInput(field("render.peekKey"), bad), { ok: false, error: "text" }, bad);
    }
  });

  test("every row reads back its own default (toInput → parseInput)", () => {
    for (const row of ADVANCED_FIELDS) {
      const parsed = parseInput(row, toInput(row, fieldDefault(row)));
      assert.deepEqual(parsed, { ok: true, value: fieldDefault(row) }, row.path);
    }
    assert.equal(toInput(field("privacy.maxImageBytes"), 32 * 1024 * 1024), "32");
    assert.equal(toInput(field("api.temperature"), null), "");
    assert.equal(toInput(field("api.urgentLane"), true), true);
    assert.equal(formatNumber(0.1 + 0.2), "0.3");
  });
});

describe("applyField: the same clamping and cross-field rules as migrateSettings", () => {
  const base = migrateSettings({});

  test("in-range values are kept", () => {
    const applied = applyField(base, field("render.maxFontPx"), 40);
    assert.deepEqual([applied.value, applied.adjusted], [40, false]);
    assert.equal(applied.settings.render.maxFontPx, 40);
    const temperature = applyField(base, field("api.temperature"), null);
    assert.deepEqual([temperature.value, temperature.adjusted], [null, false]);
  });

  test("out-of-range values are clamped to LIMITS", () => {
    const cases: Array<[SettingPath, number, number]> = [
      ["render.maxFontPx", 500, 120],
      ["render.minFontPx", 2, 8],
      ["api.firstByteTimeoutMs", 1_000, 10_000],
      ["memory.historyMaxLines", -5, 0],
      ["privacy.maxImageBytes", 1024 ** 3, 128 * 1024 * 1024],
    ];
    for (const [path, value, expected] of cases) {
      const applied = applyField(base, field(path), value);
      assert.deepEqual([applied.value, applied.adjusted], [expected, true], path);
    }
  });

  test("cross-field rules: maxInFlight never below concurrency; minFontPx above maxFontPx raises maxFontPx", () => {
    const lanes = applyField(setSetting(base, "api.concurrency", 3), field("api.maxInFlight"), 1);
    assert.deepEqual([lanes.value, lanes.adjusted], [3, true]);
    const fonts = applyField(setSetting(base, "render.maxFontPx", 16), field("render.minFontPx"), 16);
    assert.deepEqual([fonts.value, fonts.adjusted, fonts.settings.render.maxFontPx], [16, false, 16]);
  });

  test("patchFor groups fields by section; resetAllPatch restores every row's default", () => {
    assert.deepEqual(
      patchFor([
        ["render.minFontPx", 9],
        ["render.maxFontPx", 30],
        ["memory.enabled", false],
      ]),
      { render: { minFontPx: 9, maxFontPx: 30 }, memory: { enabled: false } },
    );
    let changed = base;
    for (const row of ADVANCED_FIELDS) {
      const value =
        row.kind === "boolean"
          ? !(fieldDefault(row) as boolean)
          : row.kind === "select"
            ? row.choices.find((choice) => choice !== fieldDefault(row))
            : row.kind === "text"
              ? "KeyJ"
              : LIMITS[row.path]?.find((bound) => bound !== fieldDefault(row));
      changed = applyField(changed, row, value).settings;
    }
    assert.ok(
      ADVANCED_FIELDS.every((row) => !isDefault(changed, row)),
      "every row changed",
    );
    const reset = migrateSettings(mergeDeep(changed, resetAllPatch()));
    for (const row of ADVANCED_FIELDS) {
      assert.deepEqual(getSetting(reset, row.path), getSetting(DEFAULT_SETTINGS, row.path), row.path);
      assert.ok(isDefault(reset, row), row.path);
    }
  });
});

describe("hint texts", () => {
  test("default and allowed range in display units", () => {
    assert.equal(defaultsLine(field("api.temperature"), EN), "Default: 0.2 · Allowed: 0 to 2");
    assert.equal(defaultsLine(field("api.firstByteTimeoutMs"), EN), "Default: 180 · Allowed: 10 to 900");
    assert.equal(defaultsLine(field("translate.boxBudget"), EN), "Default: automatic · Allowed: 4 to 20");
    assert.equal(defaultsLine(field("privacy.maxImageBytes"), EN), "Default: 32 · Allowed: 1 to 128");
    assert.equal(defaultsLine(field("api.urgentLane"), EN), "Default: on");
    assert.equal(defaultsLine(field("detector.backend"), EN), "Default: Automatic");
    assert.equal(defaultsLine(field("render.font"), EN), "Default: Patrick Hand");
    assert.equal(defaultsLine(field("render.peekKey"), EN), "Default: Backquote");
  });

  test("values as shown in messages", () => {
    assert.equal(displayValue(field("detector.backend"), "webgpu", EN), "GPU (WebGPU)");
    assert.equal(displayValue(field("render.font"), "mali", EN), "Mali");
    assert.equal(displayValue(field("discovery.translateHiddenTabs"), false, EN), "off");
    assert.equal(displayValue(field("api.totalTimeoutMs"), 90_000, EN), "90");
    const vi = catalogFor("vi");
    assert.equal(displayValue(field("api.temperature"), null, vi), vi.optionsAdvanced.automatic);
  });
});

describe("render.verticalText row", () => {
  test("a select of auto and never, labelled from every catalog", () => {
    const row = field("render.verticalText");
    assert.equal(row.kind, "select");
    assert.ok(row.kind === "select");
    assert.deepEqual(row.choices, ["auto", "never"]);
    assert.equal(displayValue(row, "auto", EN), "Automatic");
    assert.equal(displayValue(row, "never", EN), "Never");
    for (const { code } of uiLocales()) {
      const t = catalogFor(code);
      for (const choice of row.choices)
        assert.notEqual(displayValue(row, choice, t).trim(), "", `${code} ${choice}`);
    }
    assert.deepEqual(parseInput(row, "never"), { ok: true, value: "never" });
    assert.deepEqual(parseInput(row, "always"), { ok: false, error: "choice" });
  });
});
