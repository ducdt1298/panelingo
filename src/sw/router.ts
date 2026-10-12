// sw:* one-shot handlers and the sender allow-list. Content scripts may only ask for the engine and record
// the privacy acknowledgement; the offscreen engine gets settings, DNR, capture, idle, badge and ping; extension
// pages (popup, options, side panel, debug) get the user-facing operations. Anything else is ignored silently.

import { extensionOrigin } from "../platform/context.ts";
import type { Handlers } from "../platform/messaging.ts";
import { saveSettings } from "../platform/storage.ts";
import { CtvError, errorMessage } from "../shared/errors.ts";
import type { SwApi } from "../shared/protocol.ts";
import { isSiteKey } from "../shared/site.ts";
import { setBadge } from "./badge.ts";
import { captureTab } from "./capture.ts";
import { ensureRefererRule } from "./dnr.ts";
import { closeEngineIfIdle, engineExists, ENGINE_PATH, ensureEngine } from "./engine-host.ts";
import { injectIntoTab, setSite } from "./registration.ts";
import { settingsSnapshot } from "./settings-relay.ts";

export type SenderKind = "content" | "engine" | "page" | "other";
type SwType = keyof SwApi;

const PAGE_PATHS: ReadonlySet<string> = new Set([
  "/ui/popup.html",
  "/ui/options.html",
  "/ui/sidepanel.html",
  "/ui/debug.html",
]);

export const ALLOWED: Readonly<Record<Exclude<SenderKind, "other">, ReadonlySet<SwType>>> = {
  content: new Set<SwType>(["sw:ensure-engine", "sw:ack-privacy"]),
  engine: new Set<SwType>([
    "sw:get-settings",
    "sw:dnr-ensure",
    "sw:capture",
    "sw:engine-idle",
    "sw:badge",
    "sw:ping",
  ]),
  page: new Set<SwType>([
    "sw:ensure-engine",
    "sw:engine-state",
    "sw:site-set",
    "sw:inject",
    "sw:get-settings",
    "sw:ack-privacy",
  ]),
};

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Who sent a message. Extension documents are told apart by URL (the options page opened in a tab has a sender.tab
 * too); a content script is any other sender of this extension that comes with a tab.
 */
export function senderKind(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
  origin: string,
): SenderKind {
  if (extensionId === "" || sender.id !== extensionId) return "other";
  const url = sender.url ?? "";
  if (origin !== "" && url.startsWith(`${origin}/`)) {
    const path = pathOf(url);
    if (path === `/${ENGINE_PATH}`) return "engine";
    return path !== null && PAGE_PATHS.has(path) ? "page" : "other";
  }
  return sender.tab !== undefined ? "content" : "other";
}

export function isAllowed(type: string, kind: SenderKind): boolean {
  return kind !== "other" && ALLOWED[kind].has(type as SwType);
}

/** onMessageFor("sw") allow option. */
export function swAllow(type: string, sender: chrome.runtime.MessageSender): boolean {
  return isAllowed(type, senderKind(sender, chrome.runtime.id, extensionOrigin()));
}

export const swHandlers: Handlers<SwApi> = {
  "sw:ensure-engine": (payload) => ensureEngine(payload.force === true),
  "sw:engine-state": async () => ({ exists: await engineExists() }),
  "sw:get-settings": () => settingsSnapshot(),
  "sw:site-set": async (payload) => {
    if (!isSiteKey(payload.siteKey)) {
      throw new CtvError(
        "engine.internal",
        `sw:site-set: invalid siteKey ${JSON.stringify(payload.siteKey)}`,
      );
    }
    const { registered } = await setSite(payload.siteKey, payload.patch, payload.tabId);
    return { registered };
  },
  // Pages inject on an explicit user action (e.g. "translate visible" on a site that is not enabled): manual mode.
  "sw:inject": (payload) => injectIntoTab(payload.tabId, payload.frameId, true),
  "sw:dnr-ensure": async (payload) => {
    try {
      return { ruleId: await ensureRefererRule(payload.host, payload.referer, payload.removeOrigin) };
    } catch (error) {
      throw new CtvError("dnr.failed", errorMessage(error), { retryable: true, cause: error });
    }
  },
  "sw:capture": (payload) => captureTab(payload),
  "sw:engine-idle": async () => ({ closing: await closeEngineIfIdle() }),
  "sw:badge": (payload) => {
    setBadge(payload);
    return {};
  },
  "sw:ack-privacy": async () => {
    const at = Date.now();
    await saveSettings({ privacy: { ackUploadNoticeAt: at } });
    return { at };
  },
  // Codec self-test of the engine ↔ SW channel: echo the probe unchanged.
  "sw:ping": (payload) => ({ probe: payload.probe }),
};
