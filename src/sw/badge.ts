// Per-tab action badge (sw:badge from the engine). Chrome redraws the toolbar on every call, so updates are throttled
// to one per second per tab: the first goes out at once, later ones within the window collapse into the newest value,
// sent when the window ends.

import { createLogger } from "../platform/log.ts";
import { msg } from "../shared/i18n/index.ts";
import type { ReqOf, SwApi } from "../shared/protocol.ts";

export type BadgeRequest = ReqOf<SwApi, "sw:badge">;
export type BadgeTone = BadgeRequest["tone"];

export const BADGE_INTERVAL_MS = 1000;

export const BADGE_COLORS: Readonly<Record<BadgeTone, string>> = {
  busy: "#1a73e8",
  warn: "#e37400",
  error: "#d93025",
  none: "#5f6368",
};

export interface BadgeDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): void;
  apply(request: BadgeRequest): Promise<void>;
}

export interface BadgeController {
  set(request: BadgeRequest): void;
}

interface Slot {
  last: number;
  shown: string | null;
  pending: BadgeRequest | null;
  timer: boolean;
}

const log = createLogger("sw");

function signature(request: BadgeRequest): string {
  return request.tone === "none" ? "" : `${request.tone}:${request.text}`;
}

export function createBadgeController(deps: BadgeDeps): BadgeController {
  const slots = new Map<string, Slot>();

  const send = (slot: Slot, request: BadgeRequest): void => {
    slot.last = deps.now();
    slot.shown = signature(request);
    deps.apply(request).catch((error: unknown) => {
      // Usually the tab was closed meanwhile.
      log.debug("badge update failed", { error: String(error) });
    });
  };

  return {
    set(request) {
      const key = request.tabId === null ? "global" : String(request.tabId);
      let slot = slots.get(key);
      if (slot === undefined) {
        slot = { last: Number.NEGATIVE_INFINITY, shown: null, pending: null, timer: false };
        slots.set(key, slot);
      }
      const current = slot;
      if (current.timer) {
        current.pending = request;
        return;
      }
      if (signature(request) === current.shown) return;
      const wait = current.last + BADGE_INTERVAL_MS - deps.now();
      if (wait <= 0) {
        send(current, request);
        return;
      }
      current.pending = request;
      current.timer = true;
      deps.setTimer(() => {
        current.timer = false;
        const next = current.pending;
        current.pending = null;
        if (next !== null && signature(next) !== current.shown) send(current, next);
      }, wait);
    },
  };
}

/** chrome.action calls for one request; tabId null changes the global badge. */
export async function applyBadge(request: BadgeRequest): Promise<void> {
  const target = request.tabId === null ? {} : { tabId: request.tabId };
  const text = request.tone === "none" ? "" : request.text;
  await chrome.action.setBadgeText({ ...target, text });
  if (text !== "") {
    await chrome.action.setBadgeBackgroundColor({ ...target, color: BADGE_COLORS[request.tone] });
  }
}

let shared: BadgeController | null = null;

/** Module-level controller; it only throttles, so losing it with the worker is harmless. */
export function setBadge(request: BadgeRequest): void {
  shared ??= createBadgeController({
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      setTimeout(fn, ms);
    },
    apply: applyBadge,
  });
  shared.set(request);
}

/** toggle-site without the privacy notice: point the user at the popup (Chrome cannot open it for us). */
export async function showConsentHint(tabId: number): Promise<void> {
  setBadge({ tabId, text: "!", tone: "warn" });
  await chrome.action.setTitle({ tabId, title: msg().popup.consentHint });
}

export async function clearConsentHint(tabId: number): Promise<void> {
  setBadge({ tabId, text: "", tone: "none" });
  await chrome.action.setTitle({ tabId, title: msg().ui.appName });
}
