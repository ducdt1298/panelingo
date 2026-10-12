// Options page writes: settings go to chrome.storage.local through platform/storage (the service worker relays every
// change to the engine), site patches through the service worker (sw:site-set saves the site and re-syncs the
// content-script registration before it answers), plus the engine for clearing the cache.

import { callSw } from "../../platform/messaging.ts";
import { removeSite, saveSettings, type SettingsPatch } from "../../platform/storage.ts";
import type { Settings, SiteSettings } from "../../shared/settings.ts";
import { openCtvDb } from "../../platform/db-schema.ts";
import { callEngineEnsured } from "../common/engine-rpc.ts";
import type { SettingsImport } from "./settings-transfer.ts";

/** IndexedDB deletes can take a while on a large cache. */
export const CACHE_CLEAR_TIMEOUT_MS = 60_000;

export interface ApiForm {
  baseUrl: string;
  apiKey: string;
  model: string;
  concurrency: number;
}

export function saveApi(form: ApiForm): Promise<Settings> {
  return saveSettings({ api: { ...form } });
}

export function saveLanguages(uiLocale: string, targetLang: string): Promise<Settings> {
  return saveSettings({ ui: { locale: uiLocale }, translate: { targetLang } });
}

export function saveLogLevel(logLevel: Settings["debug"]["logLevel"]): Promise<Settings> {
  return saveSettings({ debug: { logLevel } });
}

/** Advanced section rows (and their resets): a patch merged into the stored settings, migrated (clamped). */
export function saveAdvanced(patch: SettingsPatch): Promise<Settings> {
  return saveSettings(patch);
}

/** sw:site-set: saves the patch and re-syncs the content-script registration; returns whether one is registered. */
export async function updateSite(siteKey: string, patch: Partial<SiteSettings>): Promise<boolean> {
  return (await callSw("sw:site-set", { siteKey, patch })).registered;
}

/** Stores an import: the settings replace the stored ones, the sites are added or updated one by one. */
export async function applyImport(value: SettingsImport): Promise<void> {
  await saveSettings(value.settings);
  for (const [siteKey, site] of Object.entries(value.sites)) await updateSite(siteKey, site);
}

export function deleteSite(siteKey: string): Promise<void> {
  return removeSite(siteKey);
}

/** The engine's debug log (IndexedDB ring buffer), oldest first; extension pages may read the database. */
export async function readDebugLog(): Promise<unknown[]> {
  const db = await openCtvDb();
  try {
    return await db.getAll("logs");
  } finally {
    db.close();
  }
}

/** en:cache-clear (scope all); starts the engine, since clearing is an explicit user action. */
export async function clearCache(): Promise<number> {
  const result = await callEngineEnsured(
    "en:cache-clear",
    { scope: "all" },
    { timeoutMs: CACHE_CLEAR_TIMEOUT_MS },
  );
  return result.deletedRecords;
}
