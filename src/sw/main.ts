// Service worker entry. Every listener is registered synchronously in the first turn: Chrome only delivers the event
// that woke the worker to listeners that exist by then. The work lives in the imported modules; there is no
// onConnect here (ports go straight to the engine, the only context that listens for them) and no fetch anywhere in
// src/sw (the worker is stopped when a fetch waits more than 30 s; the engine owns every API call).

import { onMessageFor } from "../platform/messaging.ts";
import { onCommand } from "./commands.ts";
import { onInstalled, onStartup } from "./install.ts";
import { onMenuClicked } from "./menus.ts";
import { swAllow, swHandlers } from "./router.ts";
import { onStorageChanged } from "./settings-relay.ts";

export function registerListeners(): void {
  chrome.runtime.onInstalled.addListener(onInstalled);
  chrome.runtime.onStartup.addListener(onStartup);
  chrome.contextMenus.onClicked.addListener(onMenuClicked);
  chrome.commands.onCommand.addListener(onCommand);
  chrome.storage.onChanged.addListener(onStorageChanged);
  onMessageFor("sw", swHandlers, { allow: swAllow });
}

registerListeners();
