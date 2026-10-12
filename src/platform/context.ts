// Which extension context runs this code, and whether it is still attached to the extension. After an update or a
// reload, orphaned content scripts keep running but chrome.runtime.id is gone and every runtime call throws.

import type { LogContext } from "./log.ts";

/** False once the extension was reloaded, updated or removed under this (content-script) context. */
export function isContextValid(): boolean {
  try {
    return chrome.runtime?.id !== undefined;
  } catch {
    return false;
  }
}

/** "chrome-extension://<id>" without a trailing slash; "" when the context is invalidated. */
export function extensionOrigin(): string {
  try {
    return chrome.runtime.getURL("").replace(/\/+$/, "");
  } catch {
    return "";
  }
}

const PAGE_TAGS: Readonly<Record<string, LogContext>> = {
  "/sw.js": "sw",
  "/engine/offscreen.html": "engine",
  "/ui/popup.html": "popup",
  "/ui/sidepanel.html": "sidepanel",
  "/ui/options.html": "options",
  "/ui/debug.html": "debug",
};

/** Context tag of code running at `href` in the extension whose origin is `origin` (anything else is "cs"). */
export function contextTagFor(href: string, origin: string): LogContext {
  if (origin === "" || !href.startsWith(`${origin}/`)) return "cs";
  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    return "cs";
  }
  return PAGE_TAGS[path] ?? "debug";
}

/** Tag for logs and request ids: sw, engine, popup, sidepanel, options, debug, or cs for content scripts. */
export function contextTag(): LogContext {
  const href = typeof location === "undefined" ? "" : location.href;
  return contextTagFor(href, extensionOrigin());
}
