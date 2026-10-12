// Current settings and per-site settings inside the engine. The offscreen document has no chrome.storage: settings
// arrive through sw:get-settings at boot and en:settings on every change, and are mirrored to kv "settings.mirror"
// so a restart without the SW still starts from the last known values.

import type { Logger } from "../platform/log.ts";
import { migrateSettings, migrateSite, type Settings, type SiteSettings } from "../shared/settings.ts";
import type { Clock, KvStore, SettingsSource } from "./contracts.ts";

export interface SettingsCache extends SettingsSource {
  /**
   * Loads kv "settings.mirror" (used until the SW answers) and mirrors every later apply() to kv. Resolves true when a
   * mirror was loaded; never rejects.
   */
  readonly attach: (kv: KvStore) => Promise<boolean>;
}

export interface SettingsCacheOptions {
  clock: Clock;
  log?: Logger;
}

function migrateSites(raw: unknown, now: number): Record<string, SiteSettings> {
  const sites: Record<string, SiteSettings> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return sites;
  for (const [siteKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (siteKey !== "") sites[siteKey] = migrateSite(value, now);
  }
  return sites;
}

export function createSettingsCache(options: SettingsCacheOptions): SettingsCache {
  const { clock } = options;
  let settings: Settings = migrateSettings(undefined);
  let sites: Record<string, SiteSettings> = {};
  let kv: KvStore | null = null;
  /** Bumped by apply(): a mirror read that finishes after a fresher apply is ignored. */
  let version = 0;
  const listeners = new Set<(settings: Settings) => void>();

  const set = (rawSettings: unknown, rawSites: unknown): boolean => {
    const nextSettings = migrateSettings(rawSettings);
    const nextSites = migrateSites(rawSites, clock.now());
    const changed =
      JSON.stringify(nextSettings) !== JSON.stringify(settings) ||
      JSON.stringify(nextSites) !== JSON.stringify(sites);
    settings = nextSettings;
    sites = nextSites;
    if (changed) {
      for (const listener of [...listeners]) {
        try {
          listener(settings);
        } catch (error) {
          options.log?.warn("settings listener threw", { error: String(error) });
        }
      }
    }
    return changed;
  };

  const mirror = (): void => {
    if (kv === null) return;
    kv.set("settings.mirror", { settings, sites, at: clock.now() }).catch((error: unknown) => {
      options.log?.warn("settings mirror write failed", { error: String(error) }, "store.io");
    });
  };

  return {
    current: () => settings,
    site: (siteKey) =>
      Object.hasOwn(sites, siteKey) ? (sites[siteKey] as SiteSettings) : migrateSite(undefined, clock.now()),
    sites: () => sites,
    apply: (nextSettings, nextSites) => {
      version += 1;
      set(nextSettings, nextSites);
      mirror();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach: async (store) => {
      let loaded = false;
      // The mirror only stands in until real settings arrive; it never overrides an apply().
      if (version === 0) {
        try {
          const saved = await store.get("settings.mirror");
          if (saved !== undefined && version === 0) {
            set(saved.settings, saved.sites);
            loaded = true;
          }
        } catch (error) {
          options.log?.warn("settings mirror unreadable", { error: String(error) }, "store.io");
        }
      }
      kv = store;
      if (version !== 0) mirror();
      return loaded;
    },
  };
}
