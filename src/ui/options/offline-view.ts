// The options page's "Offline mode (experimental)" card (docs/OFFLINE-MODE.md): the translation engine (the AI
// endpoint or on-device models) and the offline translation model, with what to expect (quality, download sizes,
// language pairs, licences), and the size of the downloaded models with a button that deletes them. The two selects
// write the same settings as their rows in the Advanced section (translate.engine, translate.offlineModel).

import type { SettingsPatch } from "../../platform/storage.ts";
import { msg } from "../../shared/i18n/index.ts";
import { OFFLINE_CACHE } from "../../shared/offline/catalog.ts";
import type { Settings } from "../../shared/settings.ts";
import { h, replace } from "../common/dom.ts";

export interface OfflineViewDeps {
  settings(): Settings;
  save(patch: SettingsPatch): Promise<Settings>;
  confirm(text: string): boolean;
  onError(what: string, error: unknown): void;
}

export interface OfflineView {
  element: HTMLElement;
  /** Shows stored values in the controls the user is not editing. */
  update(settings: Settings): void;
}

const ENGINES = ["api", "offline"] as const;
const MODELS = ["opus-mt", "nllb-600m"] as const;

/** Bytes of the downloaded models in Cache Storage (shared with the engine's offscreen document). */
export async function storedModelBytes(): Promise<number> {
  if (typeof caches === "undefined" || !(await caches.has(OFFLINE_CACHE))) return 0;
  const cache = await caches.open(OFFLINE_CACHE);
  let total = 0;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    total += Number(response?.headers.get("content-length") ?? 0) || 0;
  }
  return total;
}

export function offlineSection(deps: OfflineViewDeps): OfflineView {
  const t = (): ReturnType<typeof msg>["offline"] => msg().offline;
  const message = h("p", { class: "message", role: "status" });
  const engineSelect = h(
    "select",
    { id: "offline-engine" },
    ...ENGINES.map((engine) => h("option", { value: engine }, t().engineChoices[engine])),
  );
  const modelSelect = h(
    "select",
    { id: "offline-model" },
    ...MODELS.map((model) => h("option", { value: model }, t().modelChoices[model])),
  );
  const stored = h("p", { class: "hint", id: "offline-stored" });
  const deleteButton = h("button", { type: "button", id: "offline-delete" }, t().deleteModels);

  const show = (settings: Settings): void => {
    if (document.activeElement !== engineSelect) engineSelect.value = settings.translate.engine;
    if (document.activeElement !== modelSelect) modelSelect.value = settings.translate.offlineModel;
    modelSelect.disabled = settings.translate.engine !== "offline";
  };

  const measure = (): void => {
    storedModelBytes()
      .then((bytes) => {
        replace(stored, t().stored(bytes / 1_000_000));
        deleteButton.disabled = bytes === 0;
      })
      .catch((error: unknown) => deps.onError("measuring the offline models failed", error));
  };

  const save = (patch: SettingsPatch): void => {
    deps
      .save(patch)
      .then((saved) => {
        show(saved);
        replace(message, msg().options.saved);
      })
      .catch((error: unknown) => {
        deps.onError("saving the offline settings failed", error);
        replace(message, msg().options.saveFailed);
      });
  };

  engineSelect.addEventListener("change", () => {
    const engine = ENGINES.find((value) => value === engineSelect.value);
    if (engine !== undefined) save({ translate: { engine } });
  });
  modelSelect.addEventListener("change", () => {
    const offlineModel = MODELS.find((value) => value === modelSelect.value);
    if (offlineModel !== undefined) save({ translate: { offlineModel } });
  });
  deleteButton.addEventListener("click", () => {
    if (!deps.confirm(t().deleteConfirm)) return;
    caches
      .delete(OFFLINE_CACHE)
      .then(() => {
        replace(message, t().deleted);
        measure();
      })
      .catch((error: unknown) => {
        deps.onError("deleting the offline models failed", error);
        replace(message, msg().options.saveFailed);
      });
  });

  const field = (id: string, label: string, input: HTMLElement): HTMLElement =>
    h("div", { class: "field" }, h("label", { for: id }, label), input);

  const element = h(
    "section",
    { class: "card", id: "offline" },
    h("h2", null, t().heading),
    h("p", { class: "hint" }, t().intro),
    field("offline-engine", t().engine, engineSelect),
    field("offline-model", t().model, modelSelect),
    h("p", { class: "hint" }, t().download),
    h("p", { class: "hint" }, t().pairs),
    h("p", { class: "hint" }, t().license),
    stored,
    h("div", { class: "actions" }, deleteButton),
    message,
  );
  show(deps.settings());
  measure();
  return { element, update: show };
}
