// Popup operations: site opt-in through the service worker (sw:site-set, sw:ack-privacy, sw:inject) and commands to
// the active tab's content script. Kept apart from the DOM so they run against the chrome fake in tests.

import { callSw, isNoReceiver, sendToTab } from "../../platform/messaging.ts";
import { toErrorInfo } from "../../shared/errors.ts";
import type { SiteSettings } from "../../shared/settings.ts";
import { callEngineIfRunning } from "../common/engine-rpc.ts";
import { acknowledgePrivacy } from "../common/privacy-notice.ts";
import type { VisibleOutcome } from "./popup-model.ts";

/** Attempts after injecting into a page that had no content script (it needs a moment to start listening). */
export const VISIBLE_RETRY_DELAYS_MS: readonly number[] = [0, 150, 400];

export async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/** sw:site-set; with the tab id the SW also injects into (or tears down) that tab right away. */
export async function updateSite(
  siteKey: string,
  patch: Partial<SiteSettings>,
  tabId: number | null,
): Promise<boolean> {
  const payload = tabId === null ? { siteKey, patch } : { siteKey, patch, tabId };
  return (await callSw("sw:site-set", payload)).registered;
}

/** The privacy notice was accepted: record it first, then enable the site. */
export async function acceptNoticeAndEnable(siteKey: string, tabId: number | null): Promise<number> {
  const at = await acknowledgePrivacy();
  await updateSite(siteKey, { enabled: true }, tabId);
  return at;
}

/** cs:translate-visible; a page without the content script gets one in manual mode first (sw:inject). */
export async function translateVisible(
  tabId: number,
  retryDelaysMs: readonly number[] = VISIBLE_RETRY_DELAYS_MS,
): Promise<VisibleOutcome> {
  const attempt = async (): Promise<VisibleOutcome | null> => {
    try {
      return { kind: "sent", submitted: (await sendToTab(tabId, "cs:translate-visible", {})).submitted };
    } catch (error) {
      return isNoReceiver(error) ? null : { kind: "error", error: toErrorInfo(error) };
    }
  };
  const first = await attempt();
  if (first !== null) return first;
  try {
    if (!(await callSw("sw:inject", { tabId })).injected) return { kind: "unavailable" };
  } catch (error) {
    return { kind: "error", error: toErrorInfo(error) };
  }
  for (const delay of retryDelaysMs) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const outcome = await attempt();
    if (outcome !== null) return outcome;
  }
  return { kind: "unavailable" };
}

/** en:retranslate for the whole tab; null when the engine is not running (nothing to re-translate then). */
export async function retranslateTab(tabId: number): Promise<number | null> {
  const result = await callEngineIfRunning("en:retranslate", { tabId });
  return result === null ? null : result.queued;
}
