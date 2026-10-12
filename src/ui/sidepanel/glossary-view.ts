// Side panel "Glossary" view: the glossary and settings of the current tab's series (en:glossary-list), grouped by
// state, with add, edit, delete and confirm, a small series-settings form, and JSON export (a download link) and
// import (a file input). Opening the view is an explicit action, so its reads and writes start the engine when
// needed. Pure helpers live in glossary-model.ts.

import { SOURCE_LANGS } from "../../shared/core/memory.ts";
import { msg } from "../../shared/i18n/index.ts";
import type { GlossaryEntry } from "../../shared/records.ts";
import type { GlossaryEdit, Lang, SeriesProfile } from "../../shared/types.ts";
import { h, replace, type Child } from "../common/dom.ts";
import { callEngineEnsured } from "../common/engine-rpc.ts";
import {
  canConfirm,
  chunks,
  editFromDraft,
  exportFileName,
  exportGlossary,
  groupByState,
  IMPORT_CHUNK,
  importPatch,
  parseGlossaryImport,
  profileDraft,
  profilePatch,
  seriesLabel,
  type ProfileDraft,
} from "./glossary-model.ts";

/** How long a download link's object URL stays valid. */
const EXPORT_URL_TTL_MS = 30_000;

export interface GlossaryViewDeps {
  /** Status line (null clears it). */
  say(text: string | null): void;
  /** Logs a failed action and tells the user. */
  fail(what: string, error: unknown): void;
  /** The view changed: render the panel again. */
  changed(): void;
}

export interface GlossaryView {
  /** Toolbar actions (refresh, export, import). */
  actions(): HTMLElement;
  /** Fills the list area. */
  render(into: HTMLElement): void;
  /** Shows the glossary of a series (null: the tab has no series) and reads it. */
  load(seriesKey: string | null): Promise<void>;
}

interface Draft {
  orig: string;
  translation: string;
  note: string;
}

const emptyDraft = (): Draft => ({ orig: "", translation: "", note: "" });

function valueOf(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
}

function textInput(label: string, value: string, onInput: (value: string) => void): HTMLElement {
  return h(
    "label",
    { class: "field" },
    h("span", null, label),
    h("input", { type: "text", value, oninput: (event) => onInput(valueOf(event)) }),
  );
}

export function createGlossaryView(deps: GlossaryViewDeps): GlossaryView {
  let seriesKey: string | null = null;
  let series: SeriesProfile | null = null;
  let entries: GlossaryEntry[] = [];
  let loaded = false;
  let busy = false;
  let adding: Draft = emptyDraft();
  let editing: (Draft & { key: string }) | null = null;
  let profile: ProfileDraft = profileDraft(null);
  /** The settings form stays open across renders once opened. */
  let profileOpen = false;
  /** Bumped per load, so a slow answer for another series is dropped. */
  let generation = 0;
  const t = (): ReturnType<typeof msg>["sidepanel"]["glossary"] => msg().sidepanel.glossary;

  async function reload(): Promise<void> {
    const key = seriesKey;
    const mine = (generation += 1);
    if (key === null) {
      series = null;
      entries = [];
      loaded = true;
      deps.changed();
      return;
    }
    const list = await callEngineEnsured("en:glossary-list", { seriesKey: key });
    if (mine !== generation) return;
    series = list.series;
    entries = list.entries;
    profile = profileDraft(series);
    loaded = true;
    deps.changed();
  }

  /** One edit at a time, then a fresh read; resolves to whether it worked (failures are reported). */
  async function run(what: string, action: (key: string) => Promise<void>): Promise<boolean> {
    const key = seriesKey;
    if (busy || key === null) return false;
    busy = true;
    deps.say(null);
    deps.changed();
    try {
      await action(key);
      await reload();
      return true;
    } catch (error) {
      deps.fail(what, error);
      return false;
    } finally {
      busy = false;
      deps.changed();
    }
  }

  const upsert = async (edit: GlossaryEdit): Promise<void> => {
    await run("glossary upsert", async (key) => {
      await callEngineEnsured("en:glossary-upsert", { seriesKey: key, entries: [edit] });
      editing = null;
    });
  };

  function add(): void {
    const edit = editFromDraft(adding);
    if (edit === null) {
      deps.say(t().incomplete);
      return;
    }
    adding = emptyDraft();
    void upsert(edit);
  }

  function exportFile(): void {
    const key = seriesKey;
    if (key === null) return;
    const json = JSON.stringify(exportGlossary(series, entries), null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = h("a", { href: url, download: exportFileName(key, series), hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_TTL_MS);
  }

  async function importFile(file: File): Promise<void> {
    const parsed = parseGlossaryImport(await file.text());
    if (parsed === null) {
      deps.say(t().importFailed);
      return;
    }
    const done = await run("glossary import", async (key) => {
      for (const part of chunks(parsed.edits, IMPORT_CHUNK)) {
        await callEngineEnsured("en:glossary-upsert", { seriesKey: key, entries: part });
      }
      const patch = parsed.patch;
      if (patch !== null) {
        await callEngineEnsured("en:series-update", { seriesKey: key, patch: importPatch(patch, series) });
      }
    });
    if (done) deps.say(t().imported(parsed.edits.length));
  }

  function entryNode(entry: GlossaryEntry): HTMLElement {
    if (editing?.key === entry.orig) {
      const draft = editing;
      return h(
        "li",
        { class: "entry editing" },
        h("p", { class: "orig" }, entry.orig),
        textInput(t().translation, draft.translation, (value) => {
          draft.translation = value;
        }),
        textInput(t().note, draft.note, (value) => {
          draft.note = value;
        }),
        h(
          "div",
          { class: "line-actions" },
          h(
            "button",
            {
              type: "button",
              class: "primary",
              disabled: busy,
              onclick: () => {
                const edit = editFromDraft(draft);
                if (edit === null) deps.say(t().incomplete);
                else void upsert(edit);
              },
            },
            msg().sidepanel.save,
          ),
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                editing = null;
                deps.changed();
              },
            },
            msg().sidepanel.cancel,
          ),
        ),
      );
    }
    const buttons: Child[] = [
      h(
        "button",
        {
          type: "button",
          disabled: busy,
          onclick: () => {
            editing = { key: entry.orig, orig: entry.orig, translation: entry.translation, note: entry.note };
            deps.changed();
          },
        },
        msg().sidepanel.edit,
      ),
    ];
    if (canConfirm(entry)) {
      buttons.push(
        h(
          "button",
          {
            type: "button",
            disabled: busy,
            onclick: () =>
              void run("glossary confirm", async (key) => {
                await callEngineEnsured("en:glossary-confirm", { seriesKey: key, origs: [entry.orig] });
              }),
          },
          t().confirm,
        ),
      );
    }
    buttons.push(
      h(
        "button",
        {
          type: "button",
          disabled: busy,
          onclick: () =>
            void run("glossary delete", async (key) => {
              await callEngineEnsured("en:glossary-delete", { seriesKey: key, origs: [entry.orig] });
            }),
        },
        t().delete,
      ),
    );
    return h(
      "li",
      { class: `entry state-${entry.state}` },
      h(
        "p",
        { class: "term" },
        h("span", { class: "orig" }, entry.orig),
        h("span", { class: "arrow" }, " → "),
        h("span", { class: "rendering" }, entry.translation),
      ),
      entry.note === "" ? null : h("p", { class: "note muted" }, entry.note),
      entry.sightings > 0 ? h("p", { class: "seen muted" }, t().seen(entry.sightings)) : null,
      h("div", { class: "line-actions" }, ...buttons),
    );
  }

  function addForm(): HTMLElement {
    return h(
      "form",
      {
        class: "add",
        onsubmit: (event) => {
          event.preventDefault();
          add();
        },
      },
      textInput(t().original, adding.orig, (value) => {
        adding.orig = value;
      }),
      textInput(t().translation, adding.translation, (value) => {
        adding.translation = value;
      }),
      textInput(t().note, adding.note, (value) => {
        adding.note = value;
      }),
      h(
        "div",
        { class: "line-actions" },
        h("button", { type: "submit", class: "primary", disabled: busy }, t().add),
      ),
    );
  }

  function profileForm(): HTMLElement {
    const langs: Array<Lang | "auto"> = ["auto", ...SOURCE_LANGS];
    const details = h("details", { class: "profile", open: profileOpen });
    details.addEventListener("toggle", () => {
      profileOpen = details.open;
    });
    details.append(
      h("summary", null, t().profileHeading),
      h(
        "form",
        {
          onsubmit: (event) => {
            event.preventDefault();
            void run("series update", async (key) => {
              await callEngineEnsured("en:series-update", {
                seriesKey: key,
                patch: profilePatch(profile, series),
              });
            }).then((done) => {
              if (done) deps.say(t().saved);
            });
          },
        },
        h(
          "label",
          { class: "field" },
          h("span", null, t().sourceLang),
          h(
            "select",
            {
              onchange: (event) => {
                profile.lang = langs.find((code) => code === valueOf(event)) ?? "auto";
              },
            },
            ...langs.map((code) =>
              h(
                "option",
                { value: code, selected: profile.lang === code },
                code === "auto" ? t().langAuto : t().langs[code],
              ),
            ),
          ),
        ),
        h(
          "label",
          { class: "field" },
          h("span", null, t().koNames),
          h(
            "select",
            {
              onchange: (event) => {
                profile.koNames = valueOf(event) === "han-viet" ? "han-viet" : "romanized";
              },
            },
            h("option", { value: "romanized", selected: profile.koNames === "romanized" }, t().koRomanized),
            h("option", { value: "han-viet", selected: profile.koNames === "han-viet" }, t().koHanViet),
          ),
        ),
        h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            checked: profile.keepJaHonorifics,
            onchange: (event) => {
              profile.keepJaHonorifics = (event.target as HTMLInputElement).checked;
            },
          }),
          t().keepHonorifics,
        ),
        h(
          "label",
          { class: "check" },
          h("input", {
            type: "checkbox",
            checked: profile.summaryEnabled,
            onchange: (event) => {
              profile.summaryEnabled = (event.target as HTMLInputElement).checked;
            },
          }),
          t().summary,
        ),
        h("div", { class: "line-actions" }, h("button", { type: "submit", disabled: busy }, t().saveProfile)),
      ),
    );
    return details;
  }

  return {
    actions: () => {
      const picker = h("input", { type: "file", accept: ".json,application/json", hidden: true });
      picker.addEventListener("change", () => {
        const file = picker.files?.[0];
        picker.value = "";
        if (file !== undefined) {
          importFile(file).catch((error: unknown) => deps.fail("glossary import", error));
        }
      });
      const noSeries = seriesKey === null;
      return h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            type: "button",
            disabled: noSeries || busy,
            onclick: () => {
              deps.say(null);
              reload().catch((error: unknown) => deps.fail("glossary", error));
            },
          },
          msg().sidepanel.refresh,
        ),
        h("button", { type: "button", disabled: noSeries || !loaded, onclick: exportFile }, t().export),
        h(
          "button",
          { type: "button", disabled: noSeries || busy, onclick: () => picker.click() },
          t().import,
        ),
        picker,
      );
    },
    render: (into) => {
      if (seriesKey === null) {
        replace(into, h("div", { class: "empty" }, h("p", null, t().noSeries)));
        return;
      }
      const groups = groupByState(entries);
      const label = seriesLabel(seriesKey, series);
      replace(
        into,
        h(
          "section",
          { class: "series" },
          h("h2", null, label === "" ? t().untitled : label),
          h("p", { class: "muted key" }, seriesKey),
        ),
        addForm(),
        loaded && groups.length === 0 ? h("p", { class: "muted empty" }, t().empty) : null,
        ...groups.map((group) =>
          h(
            "section",
            { class: "group" },
            h("h2", null, `${t().states[group.state]} (${group.entries.length})`),
            h("p", { class: "muted hint" }, t().hints[group.state]),
            h("ul", { class: "entries" }, ...group.entries.map(entryNode)),
          ),
        ),
        profileForm(),
      );
    },
    load: async (key) => {
      if (key !== seriesKey) {
        seriesKey = key;
        series = null;
        entries = [];
        loaded = false;
        editing = null;
        adding = emptyDraft();
        profile = profileDraft(null);
      }
      deps.changed();
      try {
        await reload();
      } catch (error) {
        deps.fail("glossary", error);
      }
    },
  };
}
