// The options page's Advanced section, generated from the declarative table in advanced-model.ts: one labeled row
// per setting (number, checkbox, select or text) with its hint, default and allowed range, a per-row reset and a
// reset for the whole section. Each change is parsed, clamped like a save and written when the control changes.

import type { SettingsPatch } from "../../platform/storage.ts";
import { msg } from "../../shared/i18n/index.ts";
import type { Settings } from "../../shared/settings.ts";
import { h, replace } from "../common/dom.ts";
import {
  ADVANCED_FIELDS,
  advancedGroups,
  applyField,
  choiceLabel,
  defaultsLine,
  displayValue,
  fieldDefault,
  fieldId,
  fieldRange,
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

export interface AdvancedDeps {
  /** The latest known settings. */
  settings(): Settings;
  save(patch: SettingsPatch): Promise<Settings>;
  confirm(text: string): boolean;
  /** Logs a failed save (the row shows the message). */
  onError(what: string, error: unknown): void;
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

export function advancedSection(deps: AdvancedDeps): AdvancedView {
  const t = (): ReturnType<typeof msg>["optionsAdvanced"] => msg().optionsAdvanced;
  const rows: Row[] = [];
  const sectionMessage = h("p", { class: "message", role: "status" });

  const save = (row: Row, value: unknown): void => {
    const applied = applyField(deps.settings(), row.field, value);
    deps
      .save(patchFor([[row.field.path, applied.value]]) as SettingsPatch)
      .then((saved) => {
        showValue(row, saved);
        replace(
          row.message,
          applied.adjusted
            ? t().adjusted(displayValue(row.field, applied.value, msg()))
            : msg().options.saved,
        );
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
    const label = h("label", { for: id }, text.label);
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
    const hint = h(
      "p",
      { class: "hint", id: hintId },
      text.hint === "" ? null : `${text.hint} `,
      h("span", { class: "defaults" }, defaultsLine(field, msg())),
    );
    const element = h(
      "div",
      { class: "adv-field", "data-path": field.path },
      label,
      h("div", { class: "adv-control" }, control, reset),
      hint,
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

  const groups = advancedGroups(ADVANCED_FIELDS).map(({ section, fields }) => {
    const groupRows = fields.map(rowFor);
    rows.push(...groupRows);
    return h(
      "fieldset",
      { class: "adv-group", id: `adv-group-${section}` },
      h("legend", null, (t().groups as Readonly<Record<string, string | undefined>>)[section] ?? section),
      ...groupRows.map((row) => row.element),
    );
  });

  const onResetAll = (): void => {
    if (!deps.confirm(t().resetAllConfirm)) return;
    deps
      .save(resetAllPatch(ADVANCED_FIELDS) as SettingsPatch)
      .then((saved) => {
        for (const row of rows) {
          showValue(row, saved);
          replace(row.message, "");
        }
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
      "details",
      { id: "advanced-details" },
      h("summary", null, h("h2", null, t().heading)),
      h("p", { class: "hint" }, t().intro),
      ...groups,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", id: "adv-reset-all", onclick: onResetAll }, t().resetAll),
      ),
      sectionMessage,
    ),
  );
  const current = deps.settings();
  for (const row of rows) showValue(row, current);

  return {
    element,
    update: (settings) => {
      for (const row of rows) {
        if (document.activeElement !== row.control) showValue(row, settings);
      }
    },
  };
}
