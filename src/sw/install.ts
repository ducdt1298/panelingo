// Install, update, reload and browser start. onInstalled rebuilds the context menu, re-syncs the content script
// registration and the DNR guard rules, re-injects into tabs that show an enabled site (their old scripts are
// orphaned by the reload) and logs the keyboard shortcuts. onStartup restores what a browser restart clears.

import { createLogger } from "../platform/log.ts";
import { loadAllSites, loadSettings, saveSettings } from "../platform/storage.ts";
import { normalizeOrigin } from "../shared/dnr-rules.ts";
import { errorMessage } from "../shared/errors.ts";
import type { Settings } from "../shared/settings.ts";
import { findEnabledSite, siteKeyFor } from "../shared/site.ts";
import { installGuardRules, type GuardInstallResult } from "./dnr.ts";
import { applyLocale } from "../platform/locale.ts";
import { createMenus } from "./menus.ts";
import { injectAllFrames, syncContentScripts } from "./registration.ts";

/** Fixture server origins seeded into test builds, so E2E needs no extra setup for the guard. */
export const TEST_FIXTURE_HOSTS: readonly string[] = ["127.0.0.1:8080", "localhost:8081"];

const log = createLogger("sw");

/**
 * Origins the SSRF guard must let through: the configured API endpoint (a local model server lives on a private
 * address), plus the dev fixture hosts in dev and test builds.
 */
export function guardAllowOrigins(settings: Settings, includeDevHosts: boolean): string[] {
  const candidates = [settings.api.baseUrl, ...(includeDevHosts ? settings.privacy.devFixtureHosts : [])];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    try {
      const origin = siteKeyFor(normalizeOrigin(candidate));
      if (origin !== null) origins.add(origin);
    } catch {
      log.warn("ignoring an invalid guard allow origin", { value: candidate });
    }
  }
  return [...origins];
}

let guards: Promise<unknown> = Promise.resolve();

/** Re-installs the guard rules from the stored settings (serialized; each run reads the newest settings). */
export function installGuards(): Promise<GuardInstallResult> {
  const run = guards.then(async () => {
    const settings = await loadSettings();
    const result = await installGuardRules(guardAllowOrigins(settings, __DEV__ || __TEST__));
    if (result.unsupported.length > 0) {
      log.warn("Chrome rejected guard regexes", { count: result.unsupported.length });
    }
    return result;
  });
  guards = run.catch(() => undefined);
  return run;
}

type ManifestCommands = NonNullable<chrome.runtime.ManifestV3["commands"]>;

/** Commands whose suggested key Chrome did not assign (it silently drops keys taken by Chrome or other extensions). */
export function droppedShortcuts(
  declared: ManifestCommands,
  actual: readonly chrome.commands.Command[],
): string[] {
  const dropped: string[] = [];
  for (const [name, command] of Object.entries(declared)) {
    if (command.suggested_key === undefined) continue;
    const assigned = actual.find((entry) => entry.name === name)?.shortcut ?? "";
    if (assigned === "") dropped.push(name);
  }
  return dropped.sort();
}

export async function logCommands(): Promise<string[]> {
  const commands = await chrome.commands.getAll();
  for (const command of commands) {
    log.info("command", { name: command.name ?? "", shortcut: command.shortcut ?? "" });
  }
  const dropped = droppedShortcuts(chrome.runtime.getManifest().commands ?? {}, commands);
  if (dropped.length > 0) {
    log.warn("suggested shortcuts not assigned; set them at chrome://extensions/shortcuts", {
      commands: dropped.join(","),
    });
  }
  return dropped;
}

/** Injects into every open tab whose page belongs to an enabled site; returns how many tabs were injected. */
export async function reinjectOpenTabs(): Promise<number> {
  const sites = await loadAllSites();
  if (!Object.values(sites).some((site) => site.enabled)) return 0;
  const tabs = await chrome.tabs.query({});
  const results = await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.url === undefined || findEnabledSite(tab.url, sites) === null) {
        return false;
      }
      return (await injectAllFrames(tab.id)).injected;
    }),
  );
  return results.filter(Boolean).length;
}

async function seedTestSettings(): Promise<void> {
  const settings = await loadSettings();
  if (settings.privacy.devFixtureHosts.length > 0) return;
  await saveSettings({ privacy: { devFixtureHosts: [...TEST_FIXTURE_HOSTS] } });
}

async function runSteps(steps: ReadonlyArray<readonly [string, Promise<unknown>]>): Promise<void> {
  const results = await Promise.allSettled(steps.map(([, step]) => step));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      log.warn("startup step failed", { step: steps[index]?.[0] ?? "?", error: errorMessage(result.reason) });
    }
  });
}

/** Context menu titles in the UI language of the settings. */
export async function localizedMenus(): Promise<void> {
  applyLocale((await loadSettings()).ui.locale);
  await createMenus();
}

export async function handleInstalled(reason: string): Promise<void> {
  if (__TEST__ && reason === "install") await seedTestSettings();
  const steps: Array<readonly [string, Promise<unknown>]> = [
    ["menus", localizedMenus()],
    ["registration", syncContentScripts()],
    ["guard rules", installGuards()],
    ["commands", logCommands()],
  ];
  if (reason === "install" || reason === "update") steps.push(["re-injection", reinjectOpenTabs()]);
  await runSteps(steps);
}

/** Session DNR rules are gone after a browser restart; the registration persists but is re-checked anyway. */
export async function handleStartup(): Promise<void> {
  await runSteps([
    ["guard rules", installGuards()],
    ["registration", syncContentScripts()],
  ]);
}

export function onInstalled(details: chrome.runtime.InstalledDetails): void {
  handleInstalled(details.reason).catch((error: unknown) => {
    log.warn("onInstalled failed", { error: errorMessage(error) });
  });
}

export function onStartup(): void {
  handleStartup().catch((error: unknown) => {
    log.warn("onStartup failed", { error: errorMessage(error) });
  });
}
