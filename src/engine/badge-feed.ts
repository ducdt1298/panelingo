// Toolbar badge per tab, fed from the img:state posts the engine sends to content scripts: the number of images still
// in progress (blue), "!" on a pause the user may need to fix (orange) or an error (red), and nothing once every image
// of the tab settled. Only changes are sent (sw:badge); the service worker throttles the redraws.

import type { Logger } from "../platform/log.ts";
import type { ReqOf, SwApi } from "../shared/protocol.ts";
import type { ImageState, TabProgress } from "../shared/types.ts";

export type BadgeRequest = ReqOf<SwApi, "sw:badge">;
export type Badge = Pick<BadgeRequest, "text" | "tone">;

const IN_PROGRESS: ReadonlySet<ImageState> = new Set<ImageState>([
  "queued",
  "acquiring",
  "detecting",
  "waiting",
  "translating",
]);

/** Images of a tab by state, for the popup (en:tab-progress). */
export function progressOf(states: Iterable<ImageState>): TabProgress {
  const progress: TabProgress = { total: 0, working: 0, paused: 0, failed: 0 };
  for (const state of states) {
    progress.total += 1;
    if (IN_PROGRESS.has(state)) progress.working += 1;
    else if (state === "paused") progress.paused += 1;
    else if (state === "error") progress.failed += 1;
  }
  return progress;
}

/** Badge text holds about four characters. */
const MAX_COUNT = 99;

export const CLEAR_BADGE: Badge = { text: "", tone: "none" };

/** The badge for the image states of one tab. */
export function badgeFor(states: Iterable<ImageState>): Badge {
  let active = 0;
  let paused = false;
  let failed = false;
  for (const state of states) {
    if (IN_PROGRESS.has(state)) active += 1;
    else if (state === "paused") paused = true;
    else if (state === "error") failed = true;
  }
  if (failed) return { text: "!", tone: "error" };
  if (paused) return { text: "!", tone: "warn" };
  if (active > 0) return { text: active > MAX_COUNT ? `${MAX_COUNT}+` : String(active), tone: "busy" };
  return CLEAR_BADGE;
}

export interface BadgeFeedDeps {
  log: Logger;
  /** callSw("sw:badge", request). */
  send(request: BadgeRequest): Promise<unknown>;
}

export interface BadgeFeed {
  /** An img:state post to a frame of `tabId`. */
  observe(tabId: number, frameKey: string, imageKey: string, state: ImageState): void;
  /** The frame is gone for good (navigation, closed tab): its images no longer count. */
  forgetFrame(frameKey: string): void;
  /** Where the tab's images are now. */
  progress(tabId: number): TabProgress;
}

export function createBadgeFeed(deps: BadgeFeedDeps): BadgeFeed {
  /** tabId → `${frameKey}\0${imageKey}` → last state. */
  const tabs = new Map<number, Map<string, ImageState>>();
  /** frameKey → tabId, to find the tab of a frame that went away. */
  const frameTabs = new Map<string, number>();
  /** The last badge sent per tab ("text|tone"). */
  const shown = new Map<number, string>();

  const publish = (tabId: number): void => {
    const images = tabs.get(tabId);
    const badge = images === undefined ? CLEAR_BADGE : badgeFor(images.values());
    const signature = `${badge.text}|${badge.tone}`;
    if (shown.get(tabId) === signature || (!shown.has(tabId) && badge === CLEAR_BADGE)) return;
    if (badge === CLEAR_BADGE) shown.delete(tabId);
    else shown.set(tabId, signature);
    deps.send({ tabId, ...badge }).catch((error: unknown) => {
      deps.log.debug("sw:badge failed", { error: String(error) });
    });
  };

  return {
    observe(tabId, frameKey, imageKey, state) {
      if (tabId < 0) return;
      frameTabs.set(frameKey, tabId);
      let images = tabs.get(tabId);
      if (images === undefined) {
        images = new Map();
        tabs.set(tabId, images);
      }
      images.set(`${frameKey}\u0000${imageKey}`, state);
      publish(tabId);
    },
    forgetFrame(frameKey) {
      const tabId = frameTabs.get(frameKey);
      if (tabId === undefined) return;
      frameTabs.delete(frameKey);
      const images = tabs.get(tabId);
      if (images !== undefined) {
        const prefix = `${frameKey}\u0000`;
        for (const key of [...images.keys()]) if (key.startsWith(prefix)) images.delete(key);
        if (images.size === 0) tabs.delete(tabId);
      }
      publish(tabId);
    },
    progress: (tabId) => progressOf(tabs.get(tabId)?.values() ?? []),
  };
}
