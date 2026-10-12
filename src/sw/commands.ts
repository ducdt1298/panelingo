// Keyboard commands (manifest `commands`). They act on the active tab: toggle-overlay and translate-visible are
// relayed to its content script, toggle-site flips the site's opt-in, and open-side-panel opens the side panel, which
// Chrome only allows inside the synchronous part of this listener (user gesture).

import { createLogger } from "../platform/log.ts";
import { isNoReceiver, sendToTab } from "../platform/messaging.ts";
import { loadAll } from "../platform/storage.ts";
import { errorMessage } from "../shared/errors.ts";
import { siteKeyFor } from "../shared/site.ts";
import { showConsentHint } from "./badge.ts";
import { sendOrInject, setSite } from "./registration.ts";

export const COMMANDS = {
  toggleOverlay: "toggle-overlay",
  translateVisible: "translate-visible",
  toggleSite: "toggle-site",
  openSidePanel: "open-side-panel",
} as const;

const log = createLogger("sw");

export type ToggleSiteResult = "enabled" | "disabled" | "consent-needed" | "unsupported";

/**
 * Flips the opt-in of the tab's site. The first enable needs the privacy notice, which only the popup can show
 * (an extension cannot open its popup from a command): then nothing is enabled and the badge points there.
 */
export async function toggleSite(tab: chrome.tabs.Tab): Promise<ToggleSiteResult> {
  const siteKey = tab.url === undefined ? null : siteKeyFor(tab.url);
  if (siteKey === null || tab.id === undefined || tab.id < 0) return "unsupported";
  const { settings, sites } = await loadAll();
  const enabled = sites[siteKey]?.enabled === true;
  if (!enabled && settings.privacy.ackUploadNoticeAt === null) {
    await showConsentHint(tab.id);
    return "consent-needed";
  }
  await setSite(siteKey, { enabled: !enabled }, tab.id);
  return enabled ? "disabled" : "enabled";
}

export async function handleCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  const tabId = tab?.id;
  if (tab === undefined || tabId === undefined || tabId < 0) return;
  switch (command) {
    case COMMANDS.toggleOverlay:
      // Nothing to toggle on a page where the content script does not run.
      await sendToTab(tabId, "cs:toggle-overlay", {}).catch((error: unknown) => {
        if (!isNoReceiver(error)) throw error;
      });
      return;
    case COMMANDS.translateVisible:
      await sendOrInject(tabId, undefined, "cs:translate-visible", {});
      return;
    case COMMANDS.toggleSite:
      log.info("toggle-site", { result: await toggleSite(tab) });
      return;
    default:
      log.debug("unknown command", { command });
  }
}

export function onCommand(command: string, tab?: chrome.tabs.Tab): void {
  if (command === COMMANDS.openSidePanel) {
    // Must stay the first call: any await before sidePanel.open() loses the user gesture and Chrome rejects it.
    if (tab !== undefined) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch((error: unknown) => {
        log.warn("sidePanel.open failed", { error: errorMessage(error) });
      });
    }
    return;
  }
  handleCommand(command, tab).catch((error: unknown) => {
    log.warn("command failed", { command, error: errorMessage(error) });
  });
}
