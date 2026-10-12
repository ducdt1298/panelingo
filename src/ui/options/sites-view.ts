// The options page's site list: one row per stored site (on/off, mode, settings, remove) and, per site, an
// expandable editor with every per-site setting in effect: layout and reading direction, source language, Referer
// policy, cookies, subdomains and reader frames from other origins. Patches go through sw:site-set, so the
// content-script registration is re-synced before the save resolves; turning a site on asks for the privacy notice
// first when it was never confirmed.

import { msg } from "../../shared/i18n/index.ts";
import type { Settings, SiteSettings } from "../../shared/settings.ts";
import { h, replace, type Child } from "../common/dom.ts";
import { acknowledgePrivacy, needsPrivacyAck, privacyNotice } from "../common/privacy-notice.ts";
import { errorTitle } from "../common/status-view.ts";
import { deleteSite, updateSite } from "./options-actions.ts";
import { siteRows, type SiteRow } from "./options-model.ts";
import {
  framesText,
  parseSiteEdit,
  SITE_LAYOUTS,
  SITE_MODES,
  SITE_REFERERS,
  SITE_SOURCE_LANGS,
  type SiteInput,
} from "./site-model.ts";

export interface SitesDeps {
  /** The latest known settings (for the privacy confirmation). */
  settings(): Settings;
  /** Shows the full explanation of what is sent (the privacy section). */
  onDetails(): void;
  onError(what: string, error: unknown): void;
}

export interface SitesView {
  element: HTMLElement;
  /** Renders the list for these sites (after loading and after every site change). */
  render(sites: Readonly<Record<string, SiteSettings>>): void;
}

/** The id of the focused element, to focus its replacement after a re-render (keyboard users keep their place). */
function focusedId(): string {
  const active = document.activeElement as HTMLElement | null;
  return active?.id ?? "";
}

function restoreFocus(id: string): void {
  if (id === "") return;
  const el = document.getElementById(id);
  if (el !== null && el !== document.activeElement) el.focus();
}

interface EditorControls {
  layout: HTMLSelectElement;
  sourceLang: HTMLSelectElement;
  referer: HTMLSelectElement;
  cookies: HTMLInputElement;
  subdomains: HTMLInputElement;
  prefetch: HTMLInputElement;
  frames: HTMLTextAreaElement;
  note: HTMLElement;
}

function field(id: string, label: string, control: HTMLElement, hint: string): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, label),
    control,
    hint === "" ? null : h("p", { class: "hint", id: `${id}-hint` }, hint),
  );
}

function checkField(id: string, label: string, box: HTMLInputElement, hint: string): HTMLElement {
  return h(
    "div",
    { class: "field check" },
    h("label", { for: id }, box, ` ${label}`),
    hint === "" ? null : h("p", { class: "hint", id: `${id}-hint` }, hint),
  );
}

export function sitesSection(deps: SitesDeps): SitesView {
  const element = h("section", { class: "card", id: "sites" });
  const message = h("p", { class: "message", role: "status" });
  let sites: Readonly<Record<string, SiteSettings>> = {};
  /** Site waiting for the privacy notice to be confirmed before it is enabled. */
  let consentFor: string | null = null;
  /** Sites whose editor is open. */
  const expanded = new Set<string>();
  /** Last outcome shown in a site's editor ("Saved.", a validation error). */
  const notes = new Map<string, string>();
  /** Reader-frame text the user typed but that could not be saved yet (kept across re-renders). */
  const drafts = new Map<string, string>();
  /** Stable DOM id prefix per site (site keys are not valid ids). */
  const ids = new Map<string, string>();
  /** Controls of the open editors, updated in place while the list itself stays the same. */
  const editors = new Map<string, EditorControls>();
  /** What the last full render showed (sites with on/off and mode, open editors, pending notice). */
  let shown = "";

  const idOf = (siteKey: string): string => {
    let id = ids.get(siteKey);
    if (id === undefined) {
      id = `site-${ids.size + 1}`;
      ids.set(siteKey, id);
    }
    return id;
  };

  const run = (task: Promise<unknown>, siteKey: string | null): void => {
    task
      .then(() => {
        replace(message, "");
        if (siteKey !== null && expanded.has(siteKey)) {
          notes.set(siteKey, msg().options.saved);
          render();
        }
      })
      .catch((error: unknown) => {
        deps.onError("site update failed", error);
        replace(message, msg().popup.actionFailed(errorTitle(error)));
      });
  };

  const edit = (siteKey: string, input: SiteInput): void => {
    const parsed = parseSiteEdit(siteKey, input);
    if (input.field === "extraFrameOrigins") drafts.set(siteKey, input.value);
    if (!parsed.ok) {
      notes.set(
        siteKey,
        input.field === "extraFrameOrigins"
          ? msg().optionsAdvanced.site.framesInvalid(parsed.invalid.join(", "))
          : msg().options.saveFailed,
      );
      render();
      return;
    }
    if (input.field === "extraFrameOrigins") drafts.delete(siteKey);
    if (parsed.patch.enabled === true && needsPrivacyAck(deps.settings())) {
      consentFor = siteKey;
      render();
      return;
    }
    run(updateSite(siteKey, parsed.patch), siteKey);
  };

  const editorRow = (siteKey: string, site: SiteSettings, base: string): HTMLElement => {
    const t = msg().optionsAdvanced.site;
    const langs = msg().sidepanel.glossary;
    const layout = h(
      "select",
      { id: `${base}-layout`, name: "layout" },
      ...SITE_LAYOUTS.map((value) =>
        h("option", { value, selected: value === site.layout }, t.layouts[value]),
      ),
    );
    layout.addEventListener("change", () => edit(siteKey, { field: "layout", value: layout.value }));
    const sourceLang = h(
      "select",
      { id: `${base}-sourceLang`, name: "sourceLang", "aria-describedby": `${base}-sourceLang-hint` },
      ...SITE_SOURCE_LANGS.map((value) =>
        h(
          "option",
          { value, selected: value === site.sourceLang },
          value === "auto" ? langs.langAuto : langs.langs[value],
        ),
      ),
    );
    sourceLang.addEventListener("change", () =>
      edit(siteKey, { field: "sourceLang", value: sourceLang.value }),
    );
    const referer = h(
      "select",
      { id: `${base}-referer`, name: "referer", "aria-describedby": `${base}-referer-hint` },
      ...SITE_REFERERS.map((value) =>
        h("option", { value, selected: value === site.referer }, t.referers[value]),
      ),
    );
    referer.addEventListener("change", () => edit(siteKey, { field: "referer", value: referer.value }));
    const cookies = h("input", {
      type: "checkbox",
      id: `${base}-credentials`,
      name: "credentials",
      checked: site.credentials === "include",
      "aria-describedby": `${base}-credentials-hint`,
    });
    cookies.addEventListener("change", () => edit(siteKey, { field: "credentials", value: cookies.checked }));
    const subdomains = h("input", {
      type: "checkbox",
      id: `${base}-includeSubdomains`,
      name: "includeSubdomains",
      checked: site.includeSubdomains,
      "aria-describedby": `${base}-includeSubdomains-hint`,
    });
    subdomains.addEventListener("change", () =>
      edit(siteKey, { field: "includeSubdomains", value: subdomains.checked }),
    );
    const prefetch = h("input", {
      type: "checkbox",
      id: `${base}-prefetchAhead`,
      name: "prefetchAhead",
      checked: site.prefetchAhead,
      "aria-describedby": `${base}-prefetchAhead-hint`,
    });
    prefetch.addEventListener("change", () =>
      edit(siteKey, { field: "prefetchAhead", value: prefetch.checked }),
    );
    const frames = h("textarea", {
      id: `${base}-extraFrameOrigins`,
      name: "extraFrameOrigins",
      rows: 3,
      spellcheck: "false",
      "aria-describedby": `${base}-extraFrameOrigins-hint`,
      value: drafts.get(siteKey) ?? framesText(site.extraFrameOrigins),
    });
    frames.addEventListener("change", () =>
      edit(siteKey, { field: "extraFrameOrigins", value: frames.value }),
    );
    const note = h("p", { class: "message", "aria-live": "polite" }, notes.get(siteKey) ?? "");
    editors.set(siteKey, { layout, sourceLang, referer, cookies, subdomains, prefetch, frames, note });
    return h(
      "tr",
      { id: `${base}-editor`, class: "site-editor", "data-site": siteKey },
      h(
        "td",
        { colspan: 4 },
        h(
          "div",
          { class: "site-form" },
          field(`${base}-layout`, t.layout, layout, ""),
          field(`${base}-sourceLang`, langs.sourceLang, sourceLang, t.sourceLangHint),
          field(`${base}-referer`, t.referer, referer, t.refererHint),
          checkField(`${base}-credentials`, msg().popup.cookies, cookies, msg().popup.cookiesHint),
          checkField(`${base}-includeSubdomains`, t.subdomains, subdomains, t.subdomainsHint),
          checkField(`${base}-prefetchAhead`, t.prefetch, prefetch, t.prefetchHint),
          field(`${base}-extraFrameOrigins`, t.frames, frames, t.framesHint),
          note,
        ),
      ),
    );
  };

  const rowElements = (row: SiteRow): HTMLElement[] => {
    const siteKey = row.siteKey;
    const base = idOf(siteKey);
    const open = expanded.has(siteKey);
    const modeSelect = h(
      "select",
      { id: `${base}-mode`, name: "mode", "aria-label": msg().options.siteMode },
      ...SITE_MODES.map((mode) =>
        h(
          "option",
          { value: mode, selected: row.mode === mode },
          mode === "auto" ? msg().ui.modeAuto : msg().ui.modeManual,
        ),
      ),
    );
    modeSelect.addEventListener("change", () => edit(siteKey, { field: "mode", value: modeSelect.value }));
    const enabledBox = h("input", {
      type: "checkbox",
      id: `${base}-enabled`,
      name: "enabled",
      checked: row.enabled,
    });
    enabledBox.addEventListener("change", () =>
      edit(siteKey, { field: "enabled", value: enabledBox.checked }),
    );
    const toggle = h(
      "button",
      {
        type: "button",
        id: `${base}-toggle`,
        class: "site-toggle",
        "aria-expanded": open ? "true" : "false",
        "aria-controls": `${base}-editor`,
        "aria-label": msg().optionsAdvanced.site.settingsFor(siteKey),
        onclick: () => {
          if (open) expanded.delete(siteKey);
          else expanded.add(siteKey);
          notes.delete(siteKey);
          render();
        },
      },
      msg().optionsAdvanced.site.settings,
    );
    const remove = h(
      "button",
      {
        type: "button",
        id: `${base}-remove`,
        onclick: () => {
          expanded.delete(siteKey);
          drafts.delete(siteKey);
          notes.delete(siteKey);
          run(deleteSite(siteKey), null);
        },
      },
      msg().options.siteRemove,
    );
    const out: HTMLElement[] = [
      h(
        "tr",
        { class: open ? "site-row open" : "site-row", "data-site": siteKey },
        h("td", { class: "site-key" }, siteKey),
        h("td", null, h("label", { for: `${base}-enabled` }, enabledBox, ` ${msg().options.siteEnabled}`)),
        h("td", null, modeSelect),
        h("td", { class: "site-buttons" }, toggle, " ", remove),
      ),
    ];
    const site = sites[siteKey];
    if (open && site !== undefined) out.push(editorRow(siteKey, site, base));
    return out;
  };

  /** Shows stored values and notes in the open editors, leaving the control being edited alone. */
  const refreshEditors = (): void => {
    for (const [siteKey, controls] of editors) {
      const site = sites[siteKey];
      if (site === undefined) continue;
      const show = (el: HTMLSelectElement | HTMLTextAreaElement, value: string): void => {
        if (document.activeElement !== el) el.value = value;
      };
      const check = (el: HTMLInputElement, value: boolean): void => {
        if (document.activeElement !== el) el.checked = value;
      };
      show(controls.layout, site.layout);
      show(controls.sourceLang, site.sourceLang);
      show(controls.referer, site.referer);
      check(controls.cookies, site.credentials === "include");
      check(controls.subdomains, site.includeSubdomains);
      check(controls.prefetch, site.prefetchAhead);
      show(controls.frames, drafts.get(siteKey) ?? framesText(site.extraFrameOrigins));
      replace(controls.note, notes.get(siteKey) ?? "");
    }
  };

  /**
   * Rebuilds the list when its rows change (sites, on/off, mode, open editors, the notice); otherwise updates the
   * open editors in place, so a save never replaces the field the user moved on to (and what they typed in it).
   */
  function render(): void {
    const shape = JSON.stringify([
      siteRows(sites).map((row) => [row.siteKey, row.enabled, row.mode]),
      [...expanded].sort(),
      consentFor,
    ]);
    if (shape === shown) {
      refreshEditors();
      return;
    }
    shown = shape;
    editors.clear();
    const focused = focusedId();
    const rows = siteRows(sites);
    const children: Child[] = [h("h2", null, msg().options.sitesHeading)];
    if (rows.length === 0) children.push(h("p", { class: "hint" }, msg().options.sitesEmpty));
    else children.push(h("table", { class: "sites" }, h("tbody", null, ...rows.flatMap(rowElements))));
    const pending = consentFor;
    if (pending !== null) {
      children.push(
        privacyNotice({
          onAccept: () => {
            consentFor = null;
            run(
              acknowledgePrivacy().then(() => updateSite(pending, { enabled: true })),
              pending,
            );
            render();
          },
          onDecline: () => {
            consentFor = null;
            render();
          },
          onDetails: () => deps.onDetails(),
        }),
      );
    }
    children.push(message);
    replace(element, ...children);
    restoreFocus(focused);
  }

  return {
    element,
    render: (next) => {
      sites = next;
      for (const siteKey of [...expanded]) if (sites[siteKey] === undefined) expanded.delete(siteKey);
      render();
    },
  };
}
