// Content-script injection. Scripts are registered at runtime for opted-in sites only: one registered script,
// "ctv-main", covers every enabled site; executeScript handles manual use on other sites (context menu,
// translate-visible) and tabs that were already open when a site was enabled. The registration is recomputed from
// storage on every sync, so it never drifts from the site keys.

import { createLogger } from "../platform/log.ts";
import { isNoReceiver, sendToTab } from "../platform/messaging.ts";
import { loadAllSites, loadSite, saveSite, type SitePatch } from "../platform/storage.ts";
import { errorMessage } from "../shared/errors.ts";
import type { CsApi, ReqOf, ResOf } from "../shared/protocol.ts";
import type { SiteSettings } from "../shared/settings.ts";
import { contentScriptMatches } from "../shared/site.ts";
import { clearConsentHint } from "./badge.ts";

export const CONTENT_SCRIPT_ID = "ctv-main";
export const CONTENT_SCRIPT_FILE = "content/main.js";
/**
 * Attempts after a manual injection: the new script needs a moment to install its message listener, so the single
 * retry gets a short grace window (about half a second in total).
 */
export const INJECT_RETRY_DELAYS_MS: readonly number[] = [0, 150, 400];

const log = createLogger("sw");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function contentScriptFor(matches: string[]): chrome.scripting.RegisteredContentScript {
  return {
    id: CONTENT_SCRIPT_ID,
    js: [CONTENT_SCRIPT_FILE],
    matches,
    allFrames: true,
    // about:blank, srcdoc and blob: frames created by the reader inherit their creator's origin (Chrome 119+).
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
    runAt: "document_idle",
    world: "ISOLATED",
  };
}

/** Same effective registration (Chrome may omit fields that hold their default). */
export function sameRegistration(
  a: chrome.scripting.RegisteredContentScript,
  b: chrome.scripting.RegisteredContentScript,
): boolean {
  const list = (value: string[] | undefined): string => [...(value ?? [])].sort().join("\n");
  return (
    list(a.matches) === list(b.matches) &&
    list(a.js) === list(b.js) &&
    list(a.excludeMatches) === list(b.excludeMatches) &&
    (a.allFrames ?? false) === (b.allFrames ?? false) &&
    (a.matchOriginAsFallback ?? false) === (b.matchOriginAsFallback ?? false) &&
    (a.persistAcrossSessions ?? true) === (b.persistAcrossSessions ?? true) &&
    (a.runAt ?? "document_idle") === (b.runAt ?? "document_idle") &&
    (a.world ?? "ISOLATED") === (b.world ?? "ISOLATED")
  );
}

export interface SyncResult {
  registered: boolean;
  matches: string[];
  change: "registered" | "updated" | "unregistered" | "unchanged";
}

let syncs: Promise<unknown> = Promise.resolve();

async function syncNow(): Promise<SyncResult> {
  const matches = contentScriptMatches(await loadAllSites());
  const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  if (matches.length === 0) {
    if (existing === undefined) return { registered: false, matches, change: "unchanged" };
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    return { registered: false, matches, change: "unregistered" };
  }
  const script = contentScriptFor(matches);
  if (existing === undefined) {
    await chrome.scripting.registerContentScripts([script]);
    return { registered: true, matches, change: "registered" };
  }
  if (sameRegistration(existing, script)) return { registered: true, matches, change: "unchanged" };
  await chrome.scripting.updateContentScripts([script]);
  return { registered: true, matches, change: "updated" };
}

/**
 * Registers, updates in place or unregisters "ctv-main" from the enabled sites in storage. Serialized and
 * idempotent; each run reads storage when its turn comes, so the last call always reflects the newest sites.
 */
export function syncContentScripts(): Promise<SyncResult> {
  const run = syncs.then(syncNow, syncNow);
  syncs = run.catch(() => undefined);
  return run;
}

function setManualFlag(): void {
  // Serialized by Chrome and run in the page's isolated world: no closure, globals only.
  globalThis.__ctvManual = Date.now();
}

/**
 * Injects the content script into one frame (top frame by default). manual first sets globalThis.__ctvManual in
 * the same isolated world, so the script starts in manual mode (translate only what the user asks for).
 */
export async function injectIntoTab(
  tabId: number,
  frameId: number | undefined,
  manual: boolean,
): Promise<{ injected: boolean }> {
  const target: chrome.scripting.InjectionTarget =
    frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] };
  try {
    if (manual) await chrome.scripting.executeScript({ target, world: "ISOLATED", func: setManualFlag });
    await chrome.scripting.executeScript({ target, world: "ISOLATED", files: [CONTENT_SCRIPT_FILE] });
    return { injected: true };
  } catch (error) {
    // chrome://, the Web Store, a closed tab or a frame that navigated away.
    log.info("content script injection failed", { tabId, error: errorMessage(error) });
    return { injected: false };
  }
}

/** Auto-mode injection into every frame of a tab; frames of sites that are not enabled exit by themselves. */
export async function injectAllFrames(tabId: number): Promise<{ injected: boolean }> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      files: [CONTENT_SCRIPT_FILE],
    });
    return { injected: true };
  } catch (error) {
    log.info("content script injection failed", { tabId, error: errorMessage(error) });
    return { injected: false };
  }
}

/**
 * Sends a cs:* command; when no content script listens there, injects one in manual mode into that frame and
 * retries once (within INJECT_RETRY_DELAYS_MS). null when the page cannot be scripted or never answers.
 */
export async function sendOrInject<K extends keyof CsApi>(
  tabId: number,
  frameId: number | undefined,
  type: K,
  payload: ReqOf<CsApi, K>,
  retryDelaysMs: readonly number[] = INJECT_RETRY_DELAYS_MS,
): Promise<ResOf<CsApi, K> | null> {
  const options = frameId === undefined ? {} : { frameId };
  try {
    return await sendToTab(tabId, type, payload, options);
  } catch (error) {
    if (!isNoReceiver(error)) throw error;
  }
  if (!(await injectIntoTab(tabId, frameId, true)).injected) return null;
  for (const delay of retryDelaysMs) {
    if (delay > 0) await sleep(delay);
    try {
      return await sendToTab(tabId, type, payload, options);
    } catch (error) {
      if (!isNoReceiver(error)) throw error;
    }
  }
  return null;
}

/**
 * Saves a site patch and re-syncs the registration. With a tab (popup, toggle-site), enabling also injects into
 * that tab at once (no reload needed) and disabling tears its overlays down.
 */
export async function setSite(
  siteKey: string,
  patch: SitePatch,
  tabId?: number,
): Promise<{ registered: boolean; site: SiteSettings }> {
  const before = await loadSite(siteKey);
  const site = await saveSite(siteKey, patch);
  const { registered } = await syncContentScripts();
  if (tabId !== undefined && before.enabled !== site.enabled) {
    if (site.enabled) {
      await clearConsentHint(tabId).catch(() => undefined);
      await injectAllFrames(tabId);
    } else {
      await sendToTab(tabId, "cs:teardown", { reason: "site-disabled" }).catch(() => undefined);
    }
  }
  return { registered, site };
}
