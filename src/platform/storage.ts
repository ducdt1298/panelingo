// chrome.storage.local access for `settings` and `site:<siteKey>`. Every read is migrated and every write is merged
// then migrated, so callers only ever see valid values. Works in every context with storage access (service worker,
// content scripts, UI pages; the offscreen engine has none and gets settings through en:settings). Writes from one
// context are serialized; per-site keys keep popup and options from racing.

import { CtvError } from "../shared/errors.ts";
import {
  migrateSettings,
  migrateSite,
  siteStorageKey,
  STORAGE_KEYS,
  type Settings,
  type SiteSettings,
} from "../shared/settings.ts";
import { isSiteKey } from "../shared/site.ts";

/** Partial settings: sections are merged field by field, arrays are replaced. */
export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends readonly unknown[]
    ? Settings[K]
    : Settings[K] extends object
      ? Partial<Settings[K]>
      : Settings[K];
};

export type SitePatch = Partial<SiteSettings>;

export interface SettingsSnapshot {
  settings: Settings;
  sites: Record<string, SiteSettings>;
}

type StorageChanges = Record<string, chrome.storage.StorageChange>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge of plain objects; arrays and scalars in `patch` replace, undefined leaves the base value. */
export function mergeDeep(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) ? mergeDeep(out[key], value) : value;
  }
  return out;
}

/** Every valid `site:<siteKey>` entry of a storage dump, migrated. */
export function sitesFrom(items: Record<string, unknown>, now: number): Record<string, SiteSettings> {
  const sites: Record<string, SiteSettings> = {};
  for (const [key, value] of Object.entries(items)) {
    if (!key.startsWith(STORAGE_KEYS.sitePrefix)) continue;
    const siteKey = key.slice(STORAGE_KEYS.sitePrefix.length);
    if (isSiteKey(siteKey)) sites[siteKey] = migrateSite(value, now);
  }
  return sites;
}

function assertSiteKey(siteKey: string): void {
  if (!isSiteKey(siteKey)) {
    throw new CtvError("engine.internal", `invalid siteKey ${JSON.stringify(siteKey)}`);
  }
}

let writes: Promise<unknown> = Promise.resolve();

/** Read-modify-write sequences of this context run one at a time. */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writes.then(task, task);
  writes = run.catch(() => undefined);
  return run;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return migrateSettings(stored[STORAGE_KEYS.settings]);
}

/** Merges `patch` into the stored settings, migrates (clamps) and writes the full result; returns it. */
export function saveSettings(patch: SettingsPatch): Promise<Settings> {
  return serialize(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const next = migrateSettings(mergeDeep(stored[STORAGE_KEYS.settings], patch));
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
    return next;
  });
}

/** The stored site, or the defaults (disabled) when the site was never added. */
export async function loadSite(siteKey: string, now: number = Date.now()): Promise<SiteSettings> {
  const key = siteStorageKey(siteKey);
  const stored = await chrome.storage.local.get(key);
  return migrateSite(stored[key], now);
}

/** Only the sites that were added (enabled or not), keyed by siteKey. */
export async function loadAllSites(now: number = Date.now()): Promise<Record<string, SiteSettings>> {
  return sitesFrom(await chrome.storage.local.get(null), now);
}

/** Settings and every site in one read (sw:get-settings, en:settings). */
export async function loadAll(now: number = Date.now()): Promise<SettingsSnapshot> {
  const items = await chrome.storage.local.get(null);
  return { settings: migrateSettings(items[STORAGE_KEYS.settings]), sites: sitesFrom(items, now) };
}

/** Merges `patch` into the site (created with addedAt = now when new), migrates and writes it; returns it. */
export function saveSite(siteKey: string, patch: SitePatch, now: number = Date.now()): Promise<SiteSettings> {
  assertSiteKey(siteKey);
  return serialize(async () => {
    const key = siteStorageKey(siteKey);
    const stored = await chrome.storage.local.get(key);
    const current = stored[key];
    const base = isPlainObject(current) ? current : { addedAt: now };
    const next = migrateSite({ ...base, ...patch }, now);
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
}

export function removeSite(siteKey: string): Promise<void> {
  assertSiteKey(siteKey);
  return serialize(() => chrome.storage.local.remove(siteStorageKey(siteKey)));
}

function subscribe(listener: (changes: StorageChanges) => void): () => void {
  const event = chrome.storage.onChanged;
  const onChanged = (changes: StorageChanges, area: chrome.storage.AreaName): void => {
    if (area === "local") listener(changes);
  };
  event.addListener(onChanged);
  return () => event.removeListener(onChanged);
}

/** Calls `listener` with the migrated settings after every change of the `settings` key. */
export function watchSettings(listener: (settings: Settings) => void): () => void {
  return subscribe((changes) => {
    const change = changes[STORAGE_KEYS.settings];
    if (change !== undefined) listener(migrateSettings(change.newValue));
  });
}

/** Calls `listener` for every changed site key; `site` is null when the site was removed. */
export function watchSites(listener: (siteKey: string, site: SiteSettings | null) => void): () => void {
  return subscribe((changes) => {
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(STORAGE_KEYS.sitePrefix)) continue;
      const siteKey = key.slice(STORAGE_KEYS.sitePrefix.length);
      if (!isSiteKey(siteKey)) continue;
      listener(siteKey, change.newValue === undefined ? null : migrateSite(change.newValue, Date.now()));
    }
  });
}
