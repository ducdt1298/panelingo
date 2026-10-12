// The options page's "Back up and restore" section: exports the settings and the site list as a JSON file (the API
// key only when ticked) and imports such a file after a confirmation, then lists what changed.

import type { SettingsSnapshot } from "../../platform/storage.ts";
import { msg } from "../../shared/i18n/index.ts";
import { h, replace } from "../common/dom.ts";
import { applyImport } from "./options-actions.ts";
import {
  exportFileName,
  exportSettings,
  parseSettingsImport,
  type ImportError,
  type SettingsImport,
} from "./settings-transfer.ts";

/** How long an export's object URL stays valid (the download has started long before). */
const EXPORT_URL_TTL_MS = 10_000;

export interface TransferDeps {
  snapshot(): SettingsSnapshot;
  confirm(text: string): boolean;
  /** Called after an import was stored (the page refreshes what it shows). */
  onImported(value: SettingsImport): void;
  onError(what: string, error: unknown): void;
}

/** Starts a download of `data` as a JSON file. */
export function downloadJson(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = h("a", { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_TTL_MS);
}

function importErrorText(error: ImportError): string {
  const t = msg().optionsAdvanced.transfer;
  if (error === "json") return t.notJson;
  return error === "version" ? t.tooNew : t.notSettings;
}

export function transferSection(deps: TransferDeps): HTMLElement {
  const t = msg().optionsAdvanced.transfer;
  const message = h("p", { class: "message", role: "status" });
  const details = h("div", { class: "imported" });
  const includeKey = h("input", {
    type: "checkbox",
    id: "export-api-key",
    "aria-describedby": "export-api-key-hint",
  });

  const onExport = (): void => {
    const now = new Date();
    const data = exportSettings(deps.snapshot(), {
      includeApiKey: includeKey.checked,
      now,
      build: __BUILD_ID__,
    });
    downloadJson(exportFileName(now), data);
    replace(message, "");
    replace(details);
  };

  const importText = async (text: string): Promise<void> => {
    const parsed = parseSettingsImport(text, deps.snapshot().settings, Date.now());
    replace(details);
    if (!parsed.ok) {
      replace(message, importErrorText(parsed.error));
      return;
    }
    if (!deps.confirm(t.importConfirm)) {
      replace(message, "");
      return;
    }
    const value = parsed.value;
    await applyImport(value);
    const siteKeys = Object.keys(value.sites).sort();
    replace(message, t.imported(value.changed.length, siteKeys.length));
    replace(
      details,
      h("p", { class: "hint" }, value.apiKeyImported ? t.keyImported : t.keyKept),
      value.changed.length === 0
        ? null
        : h("ul", { class: "changed" }, ...value.changed.map((path) => h("li", null, h("code", null, path)))),
      siteKeys.length === 0
        ? null
        : h(
            "ul",
            { class: "changed" },
            ...siteKeys.map((siteKey) => h("li", { class: "site-key" }, siteKey)),
          ),
    );
    deps.onImported(value);
  };

  const picker = h("input", {
    type: "file",
    id: "import-file",
    accept: ".json,application/json",
    hidden: true,
  });
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file === undefined) return;
    file
      .text()
      .then(importText)
      .catch((error: unknown) => {
        deps.onError("settings import failed", error);
        replace(message, msg().options.saveFailed);
      });
  });

  return h(
    "section",
    { class: "card", id: "transfer" },
    h("h2", null, t.heading),
    h("p", { class: "hint" }, t.hint),
    h(
      "div",
      { class: "field check" },
      h("label", { for: "export-api-key" }, includeKey, ` ${t.includeKey}`),
      h("p", { class: "hint", id: "export-api-key-hint" }, t.includeKeyHint),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", id: "export-settings", onclick: onExport }, t.export),
      h("button", { type: "button", id: "import-settings", onclick: () => picker.click() }, t.import),
      picker,
    ),
    message,
    details,
  );
}
