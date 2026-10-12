// Settings export and import as JSON (options page → Back up and restore), without DOM or chrome. An export holds the
// settings and every site; the API key only when the user asks for it, and never the privacy confirmation or the
// dev-only fixture hosts. An import goes through migrateSettings / migrateSite like any stored value, keeps those
// local-only values from the current settings and reports what it changes. PURE.

import { isSiteKey } from "../../shared/site.ts";
import { migrateSettings, migrateSite, type Settings, type SiteSettings } from "../../shared/settings.ts";

export const SETTINGS_EXPORT_FORMAT = "panelingo-settings";
export const SETTINGS_EXPORT_VERSION = 1;

export interface SettingsExport {
  format: typeof SETTINGS_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  build: string;
  settings: Record<string, unknown>;
  sites: Record<string, SiteSettings>;
}

export interface ExportOptions {
  includeApiKey: boolean;
  now: Date;
  build: string;
}

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The export file's content for the current settings and sites. */
export function exportSettings(
  snapshot: { settings: Settings; sites: Readonly<Record<string, SiteSettings>> },
  options: ExportOptions,
): SettingsExport {
  const settings = clone(snapshot.settings) as unknown as Record<string, Plain>;
  const api = settings["api"] ?? {};
  const privacy = settings["privacy"] ?? {};
  if (!options.includeApiKey) delete api["apiKey"];
  delete privacy["ackUploadNoticeAt"];
  delete privacy["devFixtureHosts"];
  const sites: Record<string, SiteSettings> = {};
  for (const siteKey of Object.keys(snapshot.sites).sort()) {
    const site = snapshot.sites[siteKey];
    if (site !== undefined) sites[siteKey] = clone(site);
  }
  return {
    format: SETTINGS_EXPORT_FORMAT,
    version: SETTINGS_EXPORT_VERSION,
    exportedAt: options.now.toISOString(),
    build: options.build,
    settings,
    sites,
  };
}

/** panelingo-settings-<ISO time>.json, without characters Windows forbids in file names. */
export function exportFileName(date: Date): string {
  return `panelingo-settings-${date.toISOString().replace(/[:.]/gu, "-")}.json`;
}

export interface SettingsImport {
  /** The settings to store: the file's, migrated, with the local-only values of the current settings. */
  settings: Settings;
  /** The file's valid sites, migrated (entries with an invalid site key are left out). */
  sites: Record<string, SiteSettings>;
  /** The file carried an API key, which replaces the current one. */
  apiKeyImported: boolean;
  /** Setting paths ("render.maxFontPx") whose value differs from the current settings. */
  changed: string[];
}

export type ImportError = "json" | "format" | "version";
export type ImportResult = { ok: true; value: SettingsImport } | { ok: false; error: ImportError };

/** Leaf paths whose values differ ("api.model"; arrays compared whole). */
export function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (isPlain(before) && isPlain(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) => changedPaths(before[key], after[key], path === "" ? key : `${path}.${key}`));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
}

/**
 * A settings file (text) → what to store, or why it was refused: not JSON, not a Panelingo settings export, or a
 * newer export version than this build understands.
 */
export function parseSettingsImport(text: string, current: Settings, now: number): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "json" };
  }
  if (!isPlain(data) || data["format"] !== SETTINGS_EXPORT_FORMAT || !isPlain(data["settings"])) {
    return { ok: false, error: "format" };
  }
  const version = data["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: "format" };
  }
  if (version > SETTINGS_EXPORT_VERSION) return { ok: false, error: "version" };

  const raw = data["settings"];
  const rawApi = raw["api"];
  const apiKeyImported = isPlain(rawApi) && typeof rawApi["apiKey"] === "string";
  const settings = migrateSettings(raw);
  if (!apiKeyImported) settings.api.apiKey = current.api.apiKey;
  settings.privacy.ackUploadNoticeAt = current.privacy.ackUploadNoticeAt;
  settings.privacy.devFixtureHosts = [...current.privacy.devFixtureHosts];

  const sites: Record<string, SiteSettings> = {};
  const rawSites = data["sites"];
  if (isPlain(rawSites)) {
    for (const [siteKey, site] of Object.entries(rawSites)) {
      if (isSiteKey(siteKey) && isPlain(site)) sites[siteKey] = migrateSite(site, now);
    }
  }
  const changed = changedPaths(current, settings).filter((path) => path !== "schemaVersion");
  return { ok: true, value: { settings, sites, apiKeyImported, changed } };
}
