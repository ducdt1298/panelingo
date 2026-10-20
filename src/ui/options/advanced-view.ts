// Setting rows generated from the declarative table in advanced-model.ts: one labeled row per setting (number,
// switch, select or text) with its hint, default and allowed range and a reset. Each change is parsed, clamped like
// a save and written when the control changes. fieldRows() builds the rows of one card (lettering, keys, series
// memory); advancedSection() builds the Advanced tab: every remaining row in collapsible groups, a search box, an
// "only changed settings" filter and a reset for all of them.

import type { SettingsPatch } from "../../platform/storage.ts";
import { msg } from "../../shared/i18n/index.ts";
import type { Settings } from "../../shared/settings.ts";
import { h, replace } from "../common/dom.ts";
import {
  advancedGroups,
  applyField,
  choiceLabel,
  defaultsLine,
  displayValue,
  fieldDefault,
  fieldId,
  fieldMatches,
  fieldRange,
  fieldsAt,
  fieldText,
  getSetting,
  isDefault,
  parseErrorText,
  parseInput,
  patchFor,
  resetAllPatch,
  toInput,
  type AdvancedField,
} from "./advanced-model.ts";

export interface FieldDeps {
  /** The latest known settings. */
  settings(): Settings;
  save(patch: SettingsPatch): Promise<Settings>;
  /** Logs a failed save (the row shows the message). */
  onError(what: string, error: unknown): void;
}

export interface AdvancedDeps extends FieldDeps {
  confirm(text: string): boolean;
}

export interface AdvancedView {
  element: HTMLElement;
  /** Shows stored values in every control the user is not editing (after any settings change). */
  update(settings: Settings): void;
}

type Control = HTMLInputElement | HTMLSelectElement;

interface Row {
  field: AdvancedField;
  element: HTMLElement;
  control: Control;
  reset: HTMLButtonElement;
  message: HTMLElement;
}

export interface FieldRows {
  rows: readonly Row[];
  elements: HTMLElement[];
  update(settings: Settings): void;
}

function controlFor(field: AdvancedField, id: string, describedBy: string): Control {
  const common = { id, name: field.path, "aria-describedby": describedBy };
  switch (field.kind) {
    case "boolean":
      return h("input", { ...common, type: "checkbox" });
    case "number": {
      const range = fieldRange(field);
      return h("input", {
        ...common,
        type: "number",
        step: field.step,
        min: range?.[0],
        max: range?.[1],
        inputmode: "decimal",
      });
    }
    case "select":
      return h(
        "select",
        common,
        ...field.choices.map((choice) => h("option", { value: choice }, choiceLabel(field, choice, msg()))),
      );
    case "text":
      return h("input", {
        ...common,
        type: "text",
        maxlength: field.maxLength,
        spellcheck: "false",
        autocomplete: "off",
      });
  }
}

function showValue(row: Row, settings: Settings): void {
  const value = toInput(row.field, getSetting(settings, row.field.path));
  if (row.field.kind === "boolean") {
    (row.control as HTMLInputElement).checked = value === true;
  } else {
    row.control.value = String(value);
  }
  const atDefault = isDefault(settings, row.field);
  row.reset.disabled = atDefault;
  row.element.className = atDefault ? "adv-field" : "adv-field modified";
}

function rawValue(row: Row): string | boolean {
  return row.field.kind === "boolean" ? (row.control as HTMLInputElement).checked : row.control.value;
}

/** Rows for these fields; `saved` runs after each stored change (the Advanced filter follows it). */
export function fieldRows(
  fields: readonly AdvancedField[],
  deps: FieldDeps,
  saved: () => void = () => undefined,
): FieldRows {
  const t = (): ReturnType<typeof msg>["optionsAdvanced"] => msg().optionsAdvanced;

  const save = (row: Row, value: unknown): void => {
    const applied = applyField(deps.settings(), row.field, value);
    deps
      .save(patchFor([[row.field.path, applied.value]]) as SettingsPatch)
      .then((stored) => {
        showValue(row, stored);
        replace(
          row.message,
          applied.adjusted
            ? t().adjusted(displayValue(row.field, applied.value, msg()))
            : msg().options.saved,
        );
        saved();
      })
      .catch((error: unknown) => {
        deps.onError(`saving ${row.field.path} failed`, error);
        replace(row.message, msg().options.saveFailed);
      });
  };

  const commit = (row: Row): void => {
    const parsed = parseInput(row.field, rawValue(row));
    if (!parsed.ok) {
      replace(row.message, parseErrorText(row.field, msg()));
      return;
    }
    save(row, parsed.value);
  };

  const rowFor = (field: AdvancedField): Row => {
    const id = fieldId(field);
    const text = fieldText(field, msg());
    const hintId = `${id}-hint`;
    const control = controlFor(field, id, hintId);
    const reset = h(
      "button",
      {
        type: "button",
        class: "reset",
        "aria-label": t().resetLabel(text.label),
        title: t().resetLabel(text.label),
      },
      t().reset,
    );
    const message = h("p", { class: "field-msg", id: `${id}-msg`, "aria-live": "polite" });
    const element = h(
      "div",
      { class: "adv-field", "data-path": field.path },
      h(
        "div",
        { class: "adv-text" },
        h("label", { for: id }, text.label),
        h(
          "p",
          { class: "hint", id: hintId },
          text.hint === "" ? null : `${text.hint} `,
          h("span", { class: "defaults" }, defaultsLine(field, msg())),
        ),
      ),
      h("div", { class: "adv-control" }, control, reset),
      message,
    );
    const row: Row = { field, element, control, reset, message };
    control.addEventListener("change", () => commit(row));
    reset.addEventListener("click", () => {
      // The button turns disabled at the default; keep keyboard focus on the row.
      control.focus();
      save(row, fieldDefault(field));
    });
    return row;
  };

  const rows = fields.map(rowFor);
  const current = deps.settings();
  for (const row of rows) showValue(row, current);
  return {
    rows,
    elements: rows.map((row) => row.element),
    update: (settings) => {
      for (const row of rows) {
        if (document.activeElement !== row.control) showValue(row, settings);
      }
    },
  };
}

/** A card of setting rows under a heading (Lettering, Keys and clicks, Series memory). */
export function settingsCard(
  id: string,
  title: string,
  fields: readonly AdvancedField[],
  deps: FieldDeps,
): AdvancedView {
  const built = fieldRows(fields, deps);
  return {
    element: h("section", { class: "card", id }, h("h3", null, title), ...built.elements),
    update: (settings) => built.update(settings),
  };
}

interface Group {
  element: HTMLDetailsElement;
  count: HTMLElement;
  rows: readonly Row[];
  /** Open state chosen by the user, kept while a search opens the group. */
  userOpen: boolean | null;
}

export function advancedSection(deps: AdvancedDeps): AdvancedView {
  const t = (): ReturnType<typeof msg>["optionsAdvanced"] => msg().optionsAdvanced;
  const sectionMessage = h("p", { class: "message", role: "status" });
  const search = h("input", {
    type: "search",
    id: "adv-search",
    value: "",
    placeholder: t().search,
    "aria-label": t().search,
    autocomplete: "off",
    spellcheck: "false",
  });
  const modifiedOnly = h("input", { type: "checkbox", id: "adv-modified" });
  const summary = h("p", { class: "adv-summary hint", id: "adv-summary", "aria-live": "polite" });
  const allRows: Row[] = [];

  const filter = (): void => {
    const query = search.value;
    const onlyChanged = modifiedOnly.checked;
    const active = query.trim() !== "" || onlyChanged;
    const settings = deps.settings();
    let shown = 0;
    for (const group of groups) {
      let visible = 0;
      for (const row of group.rows) {
        const match =
          fieldMatches(row.field, query, msg()) && (!onlyChanged || !isDefault(settings, row.field));
        row.element.hidden = !match;
        if (match) visible += 1;
      }
      shown += visible;
      group.element.hidden = visible === 0;
      replace(group.count, active ? `${visible}/${group.rows.length}` : String(group.rows.length));
      if (active) {
        group.userOpen ??= group.element.open === true;
        group.element.open = visible > 0;
      } else if (group.userOpen !== null) {
        group.element.open = group.userOpen;
        group.userOpen = null;
      }
    }
    replace(summary, active ? (shown === 0 ? t().noMatch : t().matches(shown)) : "");
  };

  const groups: Group[] = advancedGroups(fieldsAt("advanced")).map(({ section, fields }) => {
    const built = fieldRows(fields, deps, () => {
      if (modifiedOnly.checked) filter();
    });
    allRows.push(...built.rows);
    const count = h("span", { class: "adv-count" });
    const element = h(
      "details",
      { class: "adv-group", id: `adv-group-${section}` },
      h(
        "summary",
        null,
        h(
          "span",
          { class: "adv-title" },
          (t().groups as Readonly<Record<string, string | undefined>>)[section] ?? section,
        ),
        count,
      ),
      ...built.elements,
    );
    return { element, count, rows: built.rows, userOpen: null };
  });

  search.addEventListener("input", filter);
  modifiedOnly.addEventListener("change", filter);

  const onResetAll = (): void => {
    if (!deps.confirm(t().resetAllConfirm)) return;
    deps
      .save(resetAllPatch(fieldsAt("advanced")) as SettingsPatch)
      .then((saved) => {
        for (const row of allRows) {
          showValue(row, saved);
          replace(row.message, "");
        }
        filter();
        replace(sectionMessage, t().resetAllDone);
      })
      .catch((error: unknown) => {
        deps.onError("resetting the advanced settings failed", error);
        replace(sectionMessage, msg().options.saveFailed);
      });
  };

  const element = h(
    "section",
    { class: "card", id: "advanced" },
    h(
      "div",
      { class: "adv-toolbar" },
      search,
      h("label", { class: "check", for: "adv-modified" }, modifiedOnly, t().modifiedOnly),
    ),
    summary,
    ...groups.map((group) => group.element),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", id: "adv-reset-all", onclick: onResetAll }, t().resetAll),
    ),
    sectionMessage,
  );
  const current = deps.settings();
  for (const row of allRows) showValue(row, current);
  filter();

  return {
    element,
    update: (settings) => {
      for (const row of allRows) {
        if (document.activeElement !== row.control) showValue(row, settings);
      }
      if (modifiedOnly.checked) filter();
    },
  };
}
