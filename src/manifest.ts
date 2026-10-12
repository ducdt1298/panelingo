// Single source of the extension manifest and its _locales/*/messages.json. scripts/build.ts writes both into dist/.
// User-visible manifest strings come from the UI catalogs (src/shared/i18n) through Chrome's __MSG_name__ lookup.

import { catalogFor, uiLocales, type Catalog } from "./shared/i18n/index.ts";

export type BuildMode = "dev" | "test" | "prod";

export interface ManifestOptions {
  version: string;
  mode: BuildMode;
}

const ICONS = {
  "16": "assets/icons/icon-16.png",
  "32": "assets/icons/icon-32.png",
  "48": "assets/icons/icon-48.png",
  "128": "assets/icons/icon-128.png",
} as const;

/** Chrome on Windows reserves these Alt+Shift shortcuts; suggesting them would be silently dropped. */
export const RESERVED_SHORTCUTS: readonly string[] = [
  "Alt+Shift+T",
  "Alt+Shift+I",
  "Alt+Shift+A",
  "Alt+Shift+N",
];

export function buildManifest({ version, mode }: ManifestOptions): chrome.runtime.ManifestV3 {
  const permissions: chrome.runtime.ManifestPermission[] = [
    "offscreen",
    "scripting",
    "storage",
    "unlimitedStorage",
    "contextMenus",
    "declarativeNetRequestWithHostAccess",
    "sidePanel",
  ];
  if (mode !== "prod") {
    // Lets dev/test builds inspect matched DNR rules; it only works for unpacked extensions.
    permissions.push("declarativeNetRequestFeedback");
  }

  const suffix = mode === "prod" ? "" : mode === "test" ? " (test)" : " (dev)";

  return {
    manifest_version: 3,
    name: `__MSG_extName__${suffix}`,
    short_name: "Panelingo",
    version,
    description: "__MSG_extDescription__",
    default_locale: "en",
    // Structured-clone messaging needs Chrome 148; a runtime probe falls back to base64 where it is not applied.
    minimum_chrome_version: "148",
    message_serialization: "structured_clone",
    // One SW + engine for regular and incognito tabs (the user enables "Allow in Incognito").
    incognito: "spanning",
    icons: ICONS,
    background: { service_worker: "sw.js", type: "module" },
    action: {
      default_popup: "ui/popup.html",
      default_title: "__MSG_extName__",
      default_icon: { "16": ICONS["16"], "32": ICONS["32"] },
    },
    options_page: "ui/options.html",
    side_panel: { default_path: "ui/sidepanel.html" },
    permissions,
    // <all_urls>: DNR Referer rules and engine image fetches on any comic CDN, and requests to whichever
    // OpenAI-compatible endpoint the user configures (a cloud API or a local server).
    host_permissions: ["<all_urls>"],
    // The default MV3 extension_pages CSP disables WebAssembly; onnxruntime-web needs 'wasm-unsafe-eval'.
    // No COOP/COEP in v1 (single-threaded WASM fallback).
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
    // Fonts are the only page-visible resources; the content script loads them as bytes into FontFace.
    web_accessible_resources: [
      { resources: ["assets/fonts/*.woff2"], matches: ["http://*/*", "https://*/*"], use_dynamic_url: true },
    ],
    commands: {
      "toggle-overlay": {
        suggested_key: { default: "Alt+Shift+Y" },
        description: "__MSG_cmdToggleOverlay__",
      },
      "translate-visible": {
        suggested_key: { default: "Alt+Shift+U" },
        description: "__MSG_cmdTranslateVisible__",
      },
      "toggle-site": { description: "__MSG_cmdToggleSite__" },
      "open-side-panel": { description: "__MSG_cmdOpenSidePanel__" },
    },
    // No static content_scripts: src/sw/registration.ts registers them at runtime for opted-in sites only.
  };
}

/** Chrome's _locales folder name for a catalog code ("pt-br" → "pt_BR", "zh-cn" → "zh_CN"). */
export function chromeLocaleDir(code: string): string {
  const [language = code, region] = code.split("-");
  return region === undefined ? language : `${language}_${region.toUpperCase()}`;
}

type ChromeMessages = Record<string, { message: string; description?: string }>;

/** messages.json for one catalog (the strings the manifest references with __MSG_name__). */
export function manifestMessages(catalog: Catalog): ChromeMessages {
  return {
    extName: { message: catalog.ui.appName, description: "Extension name" },
    extDescription: {
      message: catalog.manifest.description,
      description: "Extension description (132 chars max)",
    },
    cmdToggleOverlay: { message: catalog.manifest.commands["toggle-overlay"] },
    cmdTranslateVisible: { message: catalog.manifest.commands["translate-visible"] },
    cmdToggleSite: { message: catalog.manifest.commands["toggle-site"] },
    cmdOpenSidePanel: { message: catalog.manifest.commands["open-side-panel"] },
  };
}

/** Every bundled UI locale as [_locales folder, messages.json]. */
export function allManifestMessages(): Array<[string, ChromeMessages]> {
  return uiLocales().map(({ code }) => [chromeLocaleDir(code), manifestMessages(catalogFor(code))]);
}
