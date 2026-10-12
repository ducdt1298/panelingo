// Image context menu ("Translate this image", "Translate this image again"). Works on every site: when no content
// script runs in the clicked frame, one is injected in manual mode there first.

import { createLogger } from "../platform/log.ts";
import { errorMessage } from "../shared/errors.ts";
import { msg } from "../shared/i18n/index.ts";
import { sendOrInject } from "./registration.ts";

export const MENU_IDS = {
  translate: "ctv-translate-image",
  retranslate: "ctv-retranslate-image",
} as const;

const log = createLogger("sw");

/** Menu items persist in Chrome; onInstalled rebuilds them from scratch so an update never duplicates one. */
export async function createMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  const items = [
    { id: MENU_IDS.translate, title: msg().menu.translateImage },
    { id: MENU_IDS.retranslate, title: msg().menu.retranslateImage },
  ];
  for (const item of items) {
    chrome.contextMenus.create({ ...item, contexts: ["image"] }, () => {
      const error = chrome.runtime.lastError;
      if (error !== undefined) {
        log.warn("context menu create failed", { id: item.id, error: error.message ?? "" });
      }
    });
  }
}

export interface MenuAction {
  tabId: number;
  frameId: number;
  srcUrl: string;
  force: boolean;
}

/** What a click asks for; null for other menus, clicks without a tab or images without a URL. */
export function menuAction(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): MenuAction | null {
  const force = info.menuItemId === MENU_IDS.retranslate;
  if (!force && info.menuItemId !== MENU_IDS.translate) return null;
  if (tab?.id === undefined || tab.id < 0) return null;
  if (info.srcUrl === undefined || info.srcUrl === "") return null;
  return { tabId: tab.id, frameId: info.frameId ?? 0, srcUrl: info.srcUrl, force };
}

export async function handleMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): Promise<{ found: boolean } | null> {
  const action = menuAction(info, tab);
  if (action === null) return null;
  return sendOrInject(action.tabId, action.frameId, "cs:translate-image", {
    srcUrl: action.srcUrl,
    force: action.force,
  });
}

export function onMenuClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): void {
  handleMenuClick(info, tab).catch((error: unknown) => {
    log.warn("context menu action failed", { error: errorMessage(error) });
  });
}
