// The options page's Advanced section as a declarative table: every setting that is in effect but has no place in
// the basic sections (docs/CONFIGURATION.md lists them with status "UI"), how it is edited (number, boolean, select
// or text), its display scale and step. Limits and defaults are not repeated here: they come from LIMITS and
// DEFAULT_SETTINGS, and values are clamped by running migrateSettings, exactly like stored settings. PURE.

import type { Catalog } from "../../shared/i18n/index.ts";
import { DEFAULT_SETTINGS, LIMITS, migrateSettings, type Settings } from "../../shared/settings.ts";

/** Settings sections with editable fields (the top-level scalars are internal). */
export type SettingsSection = Exclude<keyof Settings, "schemaVersion" | "enabled">;

/** "<section>.<field>", e.g. "render.maxFontPx". */
export type SettingPath = {
  [S in SettingsSection]: `${S}.${Extract<keyof Settings[S], string>}`;
}[SettingsSection];

interface FieldBase {
  path: SettingPath;
}

export interface NumberField extends FieldBase {
  kind: "number";
  /** Input step in display units; a field whose step × scale is an integer stores integers. */
  step: number;
  /** Stored value = displayed value × scale (ms shown as seconds, bytes as MiB). Default 1. */
  scale?: number;
  /** An empty input stores null (the setting's "automatic" value). */
  nullable?: boolean;
}

export interface BooleanField extends FieldBase {
  kind: "boolean";
}

export interface SelectField extends FieldBase {
  kind: "select";
  choices: readonly string[];
}

export interface TextField extends FieldBase {
  kind: "text";
  /** What a valid (trimmed) value looks like. */
  pattern: RegExp;
  maxLength: number;
}

export type AdvancedField = NumberField | BooleanField | SelectField | TextField;

const SECOND = 1000;
const MIB = 1024 * 1024;
const MEGAPIXEL = 1_000_000;

/** A KeyboardEvent.code ("Backquote", "KeyH", "F2", "AltLeft"), or empty (off). */
const KEY_CODE = /^(?:[A-Z][A-Za-z0-9]{0,31})?$/u;

const num = (path: SettingPath, step = 1, extra: Partial<NumberField> = {}): NumberField => ({
  kind: "number",
  path,
  step,
  ...extra,
});
const bool = (path: SettingPath): BooleanField => ({ kind: "boolean", path });

/**
 * The Advanced section, in display order; rows are grouped by section (first appearance decides the group order).
 * Settings marked "Reserved" in docs/CONFIGURATION.md (stored but not used yet) and dev-only keys stay out.
 */
export const ADVANCED_FIELDS: readonly AdvancedField[] = [
  num("api.temperature", 0.1, { nullable: true }),
  bool("api.urgentLane"),
  num("api.maxInFlight"),
  num("api.firstByteTimeoutMs", 1, { scale: SECOND }),
  num("api.idleTimeoutMs", 1, { scale: SECOND }),
  num("api.totalTimeoutMs", 1, { scale: SECOND }),
  num("api.healthTimeoutMs", 0.5, { scale: SECOND }),

  num("translate.boxBudget", 1, { nullable: true }),
  num("translate.packWaitMs", 50),
  num("translate.urgentPackMax"),
  num("translate.jpegQuality", 0.01),
  num("translate.requestBodyCapMb"),
  num("translate.promptCharCap"),
  num("translate.maxLadderRequestsPerPack"),
  num("translate.maxHttpRetriesPerRequest"),
  bool("translate.splitOnRefusal"),
  { kind: "select", path: "translate.engine", choices: ["api", "offline"] },
  { kind: "select", path: "translate.offlineModel", choices: ["opus-mt", "nllb-600m"] },

  { kind: "select", path: "detector.backend", choices: ["auto", "webgpu", "wasm"] },
  num("detector.scoreMin", 0.05),
  num("detector.sliceTriggerRatio", 0.1),
  num("detector.sliceHeightRatio", 0.1),
  num("detector.sliceOverlap", 0.05),
  num("detector.sliceOverlapMinPx"),
  bool("detector.quietRows"),

  num("engine.idleCloseMin"),
  num("engine.detectorReleaseMin"),
  num("engine.portIdleMin"),

  num("discovery.minNaturalSide"),
  num("discovery.minDisplayedSide"),
  num("discovery.secondsPerScreenDefault"),
  num("discovery.lookaheadMinScreens"),
  num("discovery.lookaheadMaxScreens"),
  num("discovery.lookaheadMaxScreensStrip"),
  num("discovery.detectAheadMinScreens"),
  num("discovery.detectAheadMaxScreens"),
  num("discovery.detectMaxImages"),
  num("discovery.fetchPerHostConcurrency"),
  num("discovery.prefetchSpacingMs"),
  num("discovery.scrollDebounceMs"),
  num("discovery.mutationDebounceMs"),
  num("discovery.stripGapPx"),
  bool("discovery.translateHiddenTabs"),

  { kind: "select", path: "render.font", choices: ["patrick-hand", "mali"] },
  { kind: "select", path: "render.verticalText", choices: ["auto", "never"] },
  num("render.minFontPx"),
  num("render.maxFontPx"),
  bool("render.eraseSfx"),
  bool("render.sfxLabels"),
  bool("render.showDoneBadge"),
  { kind: "text", path: "render.peekKey", pattern: KEY_CODE, maxLength: 32 },
  bool("render.peekWithAlt"),
  bool("render.popupWithAltClick"),

  bool("memory.enabled"),
  num("memory.glossaryInPrompt"),
  num("memory.termMinSightings"),
  num("memory.historyMaxLines"),
  num("memory.historyMaxTokens"),
  num("memory.summaryMaxWords"),
  bool("memory.warmUp"),

  num("cache.translationTtlDays"),
  num("cache.encodedBytesLruMb"),

  num("privacy.maxImageBytes", 1, { scale: MIB }),
  num("privacy.maxImagePixels", 1, { scale: MEGAPIXEL }),

  num("debug.logCapacity"),
];

/**
 * Where a row is edited when it is not in the Advanced tab: the Translation tab's series-memory card ("memory"), the
 * Language & display tab's lettering and keys cards, or its own control on the Translation tab ("custom": the engine
 * choice and the offline model).
 */
export type FieldPlace = "advanced" | "memory" | "lettering" | "controls" | "custom";

const PLACES: Readonly<Partial<Record<SettingPath, FieldPlace>>> = {
  "translate.engine": "custom",
  "translate.offlineModel": "custom",
  "memory.enabled": "memory",
  "memory.warmUp": "memory",
  "render.font": "lettering",
  "render.verticalText": "lettering",
  "render.minFontPx": "lettering",
  "render.maxFontPx": "lettering",
  "render.sfxLabels": "lettering",
  "render.eraseSfx": "lettering",
  "render.showDoneBadge": "lettering",
  "render.peekKey": "controls",
  "render.peekWithAlt": "controls",
  "render.popupWithAltClick": "controls",
};

export function placeOf(field: AdvancedField): FieldPlace {
  return PLACES[field.path] ?? "advanced";
}

/** The rows edited in one place, in table order. */
export function fieldsAt(
  place: FieldPlace,
  fields: readonly AdvancedField[] = ADVANCED_FIELDS,
): AdvancedField[] {
  return fields.filter((field) => placeOf(field) === place);
}

/** Lower case without accents or marks, for search ("Lời thoại" finds "loi thoai", "Đ" finds "d"). */
export function searchKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/gu, "d").toLowerCase();
}

/**
 * Every word of the query appears in the row's label, hint, group title or setting path (so "maxFontPx" and
 * "font size" both find the row). An empty query matches everything.
 */
export function fieldMatches(field: AdvancedField, query: string, t: Catalog): boolean {
  const words = searchKey(query)
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return true;
  const text = fieldText(field, t);
  const group = (t.optionsAdvanced.groups as Readonly<Record<string, string | undefined>>)[
    sectionOf(field.path)
  ];
  const haystack = searchKey(`${text.label} ${text.hint} ${group ?? ""} ${field.path}`);
  return words.every((word) => haystack.includes(word));
}

/** Font names are proper names: shown as is in every language. */
const FONT_NAMES: Readonly<Record<string, string>> = { "patrick-hand": "Patrick Hand", mali: "Mali" };

export function sectionOf(path: SettingPath): SettingsSection {
  return path.slice(0, path.indexOf(".")) as SettingsSection;
}

function fieldName(path: SettingPath): string {
  return path.slice(path.indexOf(".") + 1);
}

/** The table's sections in display order, each with its rows. */
export function advancedGroups(
  fields: readonly AdvancedField[] = ADVANCED_FIELDS,
): Array<{ section: SettingsSection; fields: AdvancedField[] }> {
  const groups: Array<{ section: SettingsSection; fields: AdvancedField[] }> = [];
  for (const field of fields) {
    const section = sectionOf(field.path);
    const group = groups.find((candidate) => candidate.section === section);
    if (group === undefined) groups.push({ section, fields: [field] });
    else group.fields.push(field);
  }
  return groups;
}

/** DOM id of a row's control: "adv-render-maxFontPx". */
export function fieldId(field: AdvancedField): string {
  return `adv-${field.path.replace(".", "-")}`;
}

export function getSetting(settings: Settings, path: SettingPath): unknown {
  const section = settings[sectionOf(path)] as unknown as Record<string, unknown>;
  return section[fieldName(path)];
}

/** A copy of `settings` with one field replaced (other sections shared). */
export function setSetting(settings: Settings, path: SettingPath, value: unknown): Settings {
  const sectionKey = sectionOf(path);
  const section = {
    ...(settings[sectionKey] as unknown as Record<string, unknown>),
    [fieldName(path)]: value,
  };
  return { ...settings, [sectionKey]: section };
}

export function fieldDefault(field: AdvancedField): unknown {
  return getSetting(DEFAULT_SETTINGS, field.path);
}

function scaleOf(field: NumberField): number {
  return field.scale ?? 1;
}

/** Stored values of this field are integers (counts, ms, bytes) rather than fractions. */
export function storesIntegers(field: NumberField): boolean {
  return Number.isInteger(field.step * scaleOf(field));
}

/** The inclusive LIMITS range in display units, or null when the setting has none. */
export function fieldRange(field: NumberField): readonly [number, number] | null {
  const range = LIMITS[field.path];
  if (range === undefined) return null;
  return [range[0] / scaleOf(field), range[1] / scaleOf(field)];
}

/** A number without floating-point noise (0.30000000000000004 → "0.3"). */
export function formatNumber(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

/** The control's value for a stored value: text for inputs and selects, a boolean for checkboxes. */
export function toInput(field: AdvancedField, value: unknown): string | boolean {
  switch (field.kind) {
    case "boolean":
      return value === true;
    case "number":
      return typeof value === "number" ? formatNumber(value / scaleOf(field)) : "";
    case "select":
    case "text":
      return typeof value === "string" ? value : "";
  }
}

export type ParseError = "number" | "choice" | "text";
export type ParseResult = { ok: true; value: unknown } | { ok: false; error: ParseError };

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/iu;

/**
 * A control's value → the value to store, before clamping (applyField clamps). Numbers accept a decimal comma, are
 * converted to stored units and rounded where the setting holds integers; an empty nullable number is null.
 */
export function parseInput(field: AdvancedField, input: string | boolean): ParseResult {
  if (field.kind === "boolean") {
    return typeof input === "boolean" ? { ok: true, value: input } : { ok: false, error: "choice" };
  }
  const text = typeof input === "string" ? input.trim() : "";
  switch (field.kind) {
    case "number": {
      if (text === "")
        return field.nullable === true ? { ok: true, value: null } : { ok: false, error: "number" };
      const normalized = text.replace(",", ".");
      if (!NUMBER.test(normalized)) return { ok: false, error: "number" };
      const stored = Number(normalized) * scaleOf(field);
      if (!Number.isFinite(stored)) return { ok: false, error: "number" };
      return { ok: true, value: storesIntegers(field) ? Math.round(stored) : stored };
    }
    case "select":
      return field.choices.includes(text) ? { ok: true, value: text } : { ok: false, error: "choice" };
    case "text":
      return text.length <= field.maxLength && field.pattern.test(text)
        ? { ok: true, value: text }
        : { ok: false, error: "text" };
  }
}

export interface Applied {
  /** The settings after the change, migrated (clamped, cross-field rules applied). */
  settings: Settings;
  /** What the field holds after migration. */
  value: unknown;
  /** Migration changed the requested value (out of range, or below a related setting). */
  adjusted: boolean;
}

/** Applies a parsed value with the same rules as a save (migrateSettings): the stored result and whether it moved. */
export function applyField(settings: Settings, field: AdvancedField, value: unknown): Applied {
  const next = migrateSettings(setSetting(settings, field.path, value));
  const stored = getSetting(next, field.path);
  return { settings: next, value: stored, adjusted: !Object.is(stored, value) };
}

/** A settings patch that sets the given fields: { section: { field: value } }. */
export function patchFor(values: ReadonlyArray<readonly [SettingPath, unknown]>): Record<string, Plain> {
  const patch: Record<string, Plain> = {};
  for (const [path, value] of values) {
    const section = sectionOf(path);
    patch[section] = { ...patch[section], [fieldName(path)]: value };
  }
  return patch;
}

type Plain = Record<string, unknown>;

/** The patch that puts every row of the table back to its default. */
export function resetAllPatch(fields: readonly AdvancedField[] = ADVANCED_FIELDS): Record<string, Plain> {
  return patchFor(fields.map((field) => [field.path, fieldDefault(field)] as const));
}

export function isDefault(settings: Settings, field: AdvancedField): boolean {
  return JSON.stringify(getSetting(settings, field.path)) === JSON.stringify(fieldDefault(field));
}

/** Label of a select choice in catalog `t`. */
export function choiceLabel(field: SelectField, choice: string, t: Catalog): string {
  if (field.path === "render.font") return FONT_NAMES[choice] ?? choice;
  if (field.path === "render.verticalText") {
    return choice === "never"
      ? t.optionsAdvanced.verticalChoices.never
      : t.optionsAdvanced.verticalChoices.auto;
  }
  if (field.path === "translate.engine") {
    return choice === "offline" ? t.offline.engineChoices.offline : t.offline.engineChoices.api;
  }
  if (field.path === "translate.offlineModel") {
    return choice === "nllb-600m" ? t.offline.modelChoices["nllb-600m"] : t.offline.modelChoices["opus-mt"];
  }
  if (choice === "webgpu") return t.detectorBackend.webgpu;
  if (choice === "wasm") return t.detectorBackend.wasm;
  if (choice === "auto") return t.optionsAdvanced.site.referers.auto;
  return choice;
}

/** A stored value as shown in hints and messages ("0.2", "on", "automatic", "Patrick Hand"). */
export function displayValue(field: AdvancedField, value: unknown, t: Catalog): string {
  if (value === null) return t.optionsAdvanced.automatic;
  switch (field.kind) {
    case "boolean":
      return value === true ? t.optionsAdvanced.on : t.optionsAdvanced.off;
    case "number":
      return typeof value === "number" ? formatNumber(value / scaleOf(field)) : "";
    case "select":
      return typeof value === "string" ? choiceLabel(field, value, t) : "";
    case "text":
      return typeof value === "string" ? value : "";
  }
}

/** "Default: 0.2 · Allowed: 0 to 2" for a row's hint. */
export function defaultsLine(field: AdvancedField, t: Catalog): string {
  const parts = [t.optionsAdvanced.defaultIs(displayValue(field, fieldDefault(field), t))];
  if (field.kind === "number") {
    const range = fieldRange(field);
    if (range !== null) parts.push(t.optionsAdvanced.range(formatNumber(range[0]), formatNumber(range[1])));
  }
  return parts.join(" · ");
}

export interface FieldText {
  label: string;
  hint: string;
}

/** A row's label and hint from catalog `t` (the key path itself if the catalog has none: a bug the tests catch). */
export function fieldText(field: AdvancedField, t: Catalog): FieldText {
  const texts = t.optionsAdvanced.fields as Readonly<Record<string, FieldText | undefined>>;
  return texts[field.path] ?? { label: field.path, hint: "" };
}

/** The message for a value the parser refused. */
export function parseErrorText(field: AdvancedField, t: Catalog): string {
  return field.kind === "text" ? t.optionsAdvanced.badKey : t.optionsAdvanced.notANumber;
}
