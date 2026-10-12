// Relays chrome.storage changes. The offscreen engine has no storage access, so every change of `settings` or a
// `site:*` key is pushed to it as en:settings, but only when it already runs (a settings change never starts it).
// Site changes also re-sync the content-script registration; API endpoint or dev-host changes re-install the DNR
// guard rules. sw:get-settings is answered here with migrated values.

import { createLogger } from "../platform/log.ts";
import { loadAll, type SettingsSnapshot } from "../platform/storage.ts";
import { errorMessage } from "../shared/errors.ts";
import { migrateSettings, STORAGE_KEYS } from "../shared/settings.ts";
import { engineExists, pushSettingsToEngine } from "./engine-host.ts";
import { installGuards, localizedMenus } from "./install.ts";
import { syncContentScripts } from "./registration.ts";

type StorageChanges = Record<string, chrome.storage.StorageChange>;

const log = createLogger("sw");

export interface RelayPlan {
  /** en:settings to the engine (if it runs). */
  push: boolean;
  /** Re-sync the "ctv-main" registration. */
  sync: boolean;
  /** Re-install the DNR guard rules. */
  guards: boolean;
  /** Re-create the context menus (the UI language changed). */
  menus: boolean;
}

/** True when the UI language setting changed (menu titles follow it). */
export function localeChanged(oldValue: unknown, newValue: unknown): boolean {
  return migrateSettings(oldValue).ui.locale !== migrateSettings(newValue).ui.locale;
}

/** True when the guard rules depend on something that changed (API base URL or dev fixture hosts). */
export function guardInputsChanged(oldValue: unknown, newValue: unknown): boolean {
  const before = migrateSettings(oldValue);
  const after = migrateSettings(newValue);
  return (
    before.api.baseUrl !== after.api.baseUrl ||
    before.privacy.devFixtureHosts.join("\n") !== after.privacy.devFixtureHosts.join("\n")
  );
}

export function relayPlan(changes: StorageChanges): RelayPlan {
  const settings = changes[STORAGE_KEYS.settings];
  const sites = Object.keys(changes).some((key) => key.startsWith(STORAGE_KEYS.sitePrefix));
  return {
    push: settings !== undefined || sites,
    sync: sites,
    guards: settings !== undefined && guardInputsChanged(settings.oldValue, settings.newValue),
    menus: settings !== undefined && localeChanged(settings.oldValue, settings.newValue),
  };
}

/** sw:get-settings. */
export function settingsSnapshot(): Promise<SettingsSnapshot> {
  return loadAll();
}

/** en:settings if the engine exists; returns whether it was sent. */
export async function pushIfEngineRuns(): Promise<boolean> {
  if (!(await engineExists())) return false;
  await pushSettingsToEngine();
  return true;
}

export async function relayStorageChange(changes: StorageChanges): Promise<RelayPlan> {
  const plan = relayPlan(changes);
  const tasks: Array<readonly [string, Promise<unknown>]> = [];
  if (plan.push) tasks.push(["en:settings", pushIfEngineRuns()]);
  if (plan.sync) tasks.push(["registration", syncContentScripts()]);
  if (plan.guards) tasks.push(["guard rules", installGuards()]);
  if (plan.menus) tasks.push(["menus", localizedMenus()]);
  const results = await Promise.allSettled(tasks.map(([, task]) => task));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      log.warn("settings relay step failed", {
        step: tasks[index]?.[0] ?? "?",
        error: errorMessage(reason),
      });
    }
  });
  return plan;
}

export function onStorageChanged(changes: StorageChanges, area: chrome.storage.AreaName): void {
  if (area !== "local") return;
  const plan = relayPlan(changes);
  if (!plan.push && !plan.sync && !plan.guards && !plan.menus) return;
  relayStorageChange(changes).catch((error: unknown) => {
    log.warn("settings relay failed", { error: errorMessage(error) });
  });
}
