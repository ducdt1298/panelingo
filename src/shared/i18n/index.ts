// UI localisation. Each JS context (service worker, engine, content script, extension pages) picks a locale once
// it knows the settings (settings.ui.locale, "auto" = the browser's UI language) and reads strings with msg().
// Bundled catalogs are complete (typed `Catalog`); catalogs registered later may be partial: missing keys fall back
// to English. PURE (the caller passes the browser language).

import { DE } from "./de.ts";
import { EN, type Catalog } from "./en.ts";
import { ES } from "./es.ts";
import { FR } from "./fr.ts";
import { ID } from "./id.ts";
import { IT } from "./it.ts";
import { JA } from "./ja.ts";
import { KO } from "./ko.ts";
import { PL } from "./pl.ts";
import { PT_BR } from "./pt-br.ts";
import { RU } from "./ru.ts";
import { TH } from "./th.ts";
import { TR } from "./tr.ts";
import { VI } from "./vi.ts";
import { ZH_CN } from "./zh-cn.ts";
import { ZH_TW } from "./zh-tw.ts";

export type { Catalog, ErrorText, ReadinessText } from "./en.ts";

/** A catalog where any key may be missing (deep). Functions and arrays are leaves. */
export type PartialCatalog = DeepPartial<Catalog>;
type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

export interface LocaleInfo {
  /** BCP 47-ish code, lower case with a region only where it matters (e.g. "pt-br", "zh-cn"). */
  code: string;
  /** The language's own name, shown in the picker. */
  name: string;
}

/** Bundled catalogs by code. Codes map to Chrome _locales folders (src/manifest.ts chromeLocaleDir). */
const CATALOGS = new Map<string, PartialCatalog>([
  ["en", EN],
  ["de", DE],
  ["es", ES],
  ["fr", FR],
  ["id", ID],
  ["it", IT],
  ["ja", JA],
  ["ko", KO],
  ["pl", PL],
  ["pt-br", PT_BR],
  ["ru", RU],
  ["th", TH],
  ["tr", TR],
  ["vi", VI],
  ["zh-cn", ZH_CN],
  ["zh-tw", ZH_TW],
]);

const NAMES: Record<string, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  id: "Bahasa Indonesia",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  pl: "Polski",
  "pt-br": "Português (Brasil)",
  ru: "Русский",
  th: "ไทย",
  tr: "Türkçe",
  vi: "Tiếng Việt",
  "zh-cn": "简体中文",
  "zh-tw": "繁體中文",
};

/**
 * Codes (or code prefixes) whose closest catalog is not reached by dropping subtags: Chinese by script or region,
 * Portuguese outside Brazil, and Indonesian's legacy code. Applied only when the target catalog is registered and
 * the code itself has none.
 */
const ALIASES = new Map<string, string>([
  ["zh", "zh-cn"],
  ["zh-hans", "zh-cn"],
  ["zh-sg", "zh-cn"],
  ["zh-my", "zh-cn"],
  ["zh-hant", "zh-tw"],
  ["zh-hk", "zh-tw"],
  ["zh-mo", "zh-tw"],
  ["pt", "pt-br"],
  ["in", "id"],
]);

/** "pt_BR" / "PT-br" → "pt-br". */
function normalize(code: string): string {
  return code.toLowerCase().replace(/_/gu, "-");
}

/** Registers another catalog, possibly partial (replaces any catalog with the same code). */
export function registerCatalog(code: string, name: string, catalog: PartialCatalog): void {
  const key = normalize(code);
  CATALOGS.set(key, catalog);
  NAMES[key] = name;
  merged.delete(key);
}

/** A catalog exactly as registered, without the English fallback (e.g. to list missing keys). */
export function registeredCatalog(code: string): PartialCatalog | undefined {
  return CATALOGS.get(normalize(code));
}

/** Supported UI locales, English first. */
export function uiLocales(): LocaleInfo[] {
  return [...CATALOGS.keys()]
    .sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a.localeCompare(b)))
    .map((code) => ({ code, name: NAMES[code] ?? code }));
}

/**
 * The registered locale for one normalized code: the code or its shorter prefixes ("zh-hant-tw", "zh-hant", "zh"),
 * each exactly or through ALIASES, else any region of the same language ("pt-pt" → "pt-br").
 */
function matchLocale(code: string): string | undefined {
  const parts = code.split("-");
  for (let length = parts.length; length > 0; length--) {
    const prefix = parts.slice(0, length).join("-");
    if (CATALOGS.has(prefix)) return prefix;
    const alias = ALIASES.get(prefix);
    if (alias !== undefined && CATALOGS.has(alias)) return alias;
  }
  const language = parts[0] ?? "";
  if (language === "") return undefined;
  return [...CATALOGS.keys()].find((key) => key.split("-")[0] === language);
}

/**
 * The best supported locale for a setting ("auto" or a code) and the browser's languages, most preferred first
 * (see matchLocale), else English.
 */
export function resolveLocale(setting: string, browserLanguages: readonly string[]): string {
  const candidates =
    setting !== "" && setting !== "auto" ? [setting, ...browserLanguages] : [...browserLanguages];
  for (const raw of candidates) {
    const match = matchLocale(normalize(raw));
    if (match !== undefined) return match;
  }
  return "en";
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const current = base[key];
    out[key] = isPlain(current) && isPlain(value) ? deepMerge(current, value) : value;
  }
  return out;
}

const merged = new Map<string, Catalog>();

/** The full catalog of a locale (missing keys from English). */
export function catalogFor(locale: string): Catalog {
  const code = resolveLocale(locale, []);
  let catalog = merged.get(code);
  if (catalog === undefined) {
    const partial = CATALOGS.get(code) ?? {};
    catalog = (code === "en" ? EN : deepMerge(EN, partial)) as Catalog;
    merged.set(code, catalog);
  }
  return catalog;
}

let activeCode = "en";
let active: Catalog = EN;

/** Picks this context's UI locale; returns the resolved code. */
export function setLocale(setting: string, browserLanguages: readonly string[] = []): string {
  activeCode = resolveLocale(setting, browserLanguages);
  active = catalogFor(activeCode);
  return activeCode;
}

export function currentLocale(): string {
  return activeCode;
}

/** Strings of this context's locale (English until setLocale runs). */
export function msg(): Catalog {
  return active;
}

/** The browser's preferred languages from whatever the context offers (pure input for resolveLocale). */
export function browserLanguages(env: {
  uiLanguage?: string | undefined;
  languages?: readonly string[] | undefined;
}): string[] {
  const out: string[] = [];
  if (env.uiLanguage !== undefined && env.uiLanguage !== "") out.push(env.uiLanguage);
  for (const language of env.languages ?? []) if (!out.includes(language)) out.push(language);
  return out;
}
