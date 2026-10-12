// Options entry: the OpenAI-compatible endpoint (preset, base URL, API key, model, parallel requests, connection
// test), languages (interface and translation target), the site list with a per-site editor (sites-view.ts), what is
// sent to the AI, cache clearing, settings backup and restore (transfer-view.ts), the debug log and the collapsed
// Advanced section generated from a declarative table (advanced-view.ts). Settings go to chrome.storage.local and the
// service worker relays them to the engine; site patches go through sw:site-set, which also re-syncs the
// content-script registration.

import { createLogger } from "../../platform/log.ts";
import { loadAll, watchSettings, watchSites } from "../../platform/storage.ts";
import { errorMessage } from "../../shared/errors.ts";
import { currentLocale, msg, uiLocales } from "../../shared/i18n/index.ts";
import { applyLocale } from "../../platform/locale.ts";
import { TARGET_LANGUAGES } from "../../shared/languages.ts";
import type { Settings, SiteSettings } from "../../shared/settings.ts";
import { endpointOf, fetchApiHealth } from "../common/api-health.ts";
import { h, replace } from "../common/dom.ts";
import { apiBlock, errorTitle, renderStatusBlock } from "../common/status-view.ts";
import { advancedSection } from "./advanced-view.ts";
import {
  clearCache,
  saveAdvanced,
  saveApi,
  saveLanguages,
  readDebugLog,
  saveLogLevel,
} from "./options-actions.ts";
import {
  API_PRESETS,
  CONCURRENCY_CHOICES,
  debugLogFileName,
  formatDateTime,
  LOG_LEVELS,
  parseBaseUrl,
  parseConcurrency,
  parseModel,
  presetFor,
} from "./options-model.ts";
import { sitesSection } from "./sites-view.ts";
import { downloadJson, transferSection } from "./transfer-view.ts";

const log = createLogger("options");

function logFailure(what: string, error: unknown): void {
  log.warn(what, { error: errorMessage(error) });
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (root === null) return;
  const snapshot = await loadAll();
  applyLocale(snapshot.settings.ui.locale);
  document.documentElement.lang = currentLocale();
  document.title = `${msg().ui.appName} – ${msg().options.title}`;
  let settings: Settings = snapshot.settings;
  let sites: Record<string, SiteSettings> = snapshot.sites;

  /* ---- AI endpoint ---- */
  const apiStatus = h("div", { class: "status", "aria-live": "polite" });
  const apiMessage = h("p", { class: "message", role: "status" });
  const presetSelect = h(
    "select",
    { id: "preset" },
    h("option", { value: "" }, msg().options.presetCustom),
    ...API_PRESETS.map((preset) => h("option", { value: preset.id }, preset.label)),
  );
  presetSelect.value = presetFor(settings.api.baseUrl)?.id ?? "";
  const baseUrlInput = h("input", {
    type: "url",
    id: "base-url",
    value: settings.api.baseUrl,
    spellcheck: "false",
    size: 40,
  });
  const apiKeyInput = h("input", {
    type: "password",
    id: "api-key",
    value: settings.api.apiKey,
    autocomplete: "off",
    spellcheck: "false",
    size: 40,
  });
  const modelInput = h("input", {
    type: "text",
    id: "model",
    value: settings.api.model,
    spellcheck: "false",
    size: 30,
  });
  const modelList = h("datalist", { id: "model-list" });
  modelInput.setAttribute("list", "model-list");
  const concurrencySelect = h(
    "select",
    { id: "concurrency" },
    ...CONCURRENCY_CHOICES.map((n) =>
      h("option", { value: String(n), selected: n === settings.api.concurrency }, String(n)),
    ),
  );
  presetSelect.addEventListener("change", () => {
    const preset = API_PRESETS.find((candidate) => candidate.id === presetSelect.value);
    if (preset === undefined) return;
    baseUrlInput.value = preset.baseUrl;
    if (preset.model !== "") modelInput.value = preset.model;
  });
  const refreshHealth = (endpoint = endpointOf(settings.api)): Promise<void> => {
    renderStatusBlock(apiStatus, msg().options.apiHeading, apiBlock(null));
    return fetchApiHealth(endpoint)
      .then((result) => {
        renderStatusBlock(apiStatus, msg().options.apiHeading, apiBlock(result.reading, endpoint.baseUrl));
        replace(modelList, ...(result.models ?? []).slice(0, 200).map((id) => h("option", { value: id })));
      })
      .catch((error: unknown) => logFailure("health check failed", error));
  };
  const readForm = (): { baseUrl: string; apiKey: string; model: string; concurrency: number } | null => {
    const baseUrl = parseBaseUrl(baseUrlInput.value);
    const model = parseModel(modelInput.value);
    const concurrency = parseConcurrency(concurrencySelect.value);
    if (baseUrl === null) replace(apiMessage, msg().options.baseUrlInvalid);
    else if (model === null) replace(apiMessage, msg().options.modelInvalid);
    else if (concurrency === null) replace(apiMessage, msg().options.concurrencyInvalid);
    if (baseUrl === null || model === null || concurrency === null) return null;
    return { baseUrl, apiKey: apiKeyInput.value.trim(), model, concurrency };
  };
  const saveApiForm = (): void => {
    const form = readForm();
    if (form === null) return;
    saveApi(form)
      .then((saved) => {
        settings = saved;
        baseUrlInput.value = saved.api.baseUrl;
        replace(apiMessage, msg().options.saved);
        void refreshHealth();
      })
      .catch((error: unknown) => {
        logFailure("saving the API settings failed", error);
        replace(apiMessage, msg().options.saveFailed);
      });
  };
  const testConnection = (): void => {
    const form = readForm();
    if (form === null) return;
    replace(apiMessage, msg().options.testing);
    fetchApiHealth({ ...form, healthTimeoutMs: settings.api.healthTimeoutMs })
      .then((result) => {
        const text = msg().readiness[result.reading.readiness].label;
        const detail = result.reading.cause === null ? text : `${text} (${result.reading.cause})`;
        replace(
          apiMessage,
          result.reading.readiness === "ready"
            ? msg().options.testOk(detail)
            : msg().options.testFailed(detail),
        );
        replace(modelList, ...(result.models ?? []).slice(0, 200).map((id) => h("option", { value: id })));
      })
      .catch((error: unknown) => replace(apiMessage, msg().options.testFailed(errorTitle(error))));
  };
  const field = (id: string, label: string, input: HTMLElement, hint: string): HTMLElement =>
    h(
      "div",
      { class: "field" },
      h("label", { for: id }, label),
      input,
      hint === "" ? null : h("p", { class: "hint" }, hint),
    );
  const apiSection = h(
    "section",
    { class: "card", id: "api" },
    apiStatus,
    h("p", { class: "hint" }, msg().options.apiIntro),
    field("preset", msg().options.preset, presetSelect, ""),
    field("base-url", msg().options.baseUrl, baseUrlInput, msg().options.baseUrlHint),
    field("api-key", msg().options.apiKey, apiKeyInput, msg().options.apiKeyHint),
    field("model", msg().options.model, h("span", null, modelInput, modelList), msg().options.modelHint),
    field("concurrency", msg().options.concurrency, concurrencySelect, msg().options.concurrencyHint),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "primary", onclick: saveApiForm }, msg().options.save),
      " ",
      h("button", { type: "button", onclick: testConnection }, msg().options.testConnection),
    ),
    apiMessage,
  );

  /* ---- languages ---- */
  const languageMessage = h("p", { class: "message", role: "status" });
  const uiSelect = h(
    "select",
    { id: "ui-locale" },
    h("option", { value: "auto" }, msg().options.languageAuto),
    ...uiLocales().map((locale) => h("option", { value: locale.code }, locale.name)),
  );
  uiSelect.value = settings.ui.locale;
  const targetSelect = h(
    "select",
    { id: "target-lang" },
    h("option", { value: "auto" }, msg().options.languageAuto),
    ...TARGET_LANGUAGES.map((language) => h("option", { value: language.code }, language.nativeName)),
  );
  targetSelect.value = settings.translate.targetLang;
  // The locale this page was rendered in; `settings` cannot tell, since watchSettings updates it on our own save.
  const renderedLocale = settings.ui.locale;
  const onLanguages = (): void => {
    saveLanguages(uiSelect.value, targetSelect.value)
      .then(() => {
        // The page text itself follows the new UI language on the next load.
        if (uiSelect.value !== renderedLocale) location.reload();
        else replace(languageMessage, msg().options.saved);
      })
      .catch((error: unknown) => {
        logFailure("saving the languages failed", error);
        replace(languageMessage, msg().options.saveFailed);
      });
  };
  uiSelect.addEventListener("change", onLanguages);
  targetSelect.addEventListener("change", onLanguages);
  const languageSection = h(
    "section",
    { class: "card", id: "languages" },
    h("h2", null, msg().options.languageHeading),
    field("ui-locale", msg().options.uiLanguage, uiSelect, ""),
    field("target-lang", msg().options.targetLanguage, targetSelect, ""),
    languageMessage,
  );

  /* ---- sites ---- */
  const sitesView = sitesSection({
    settings: () => settings,
    onDetails: () => privacySection.scrollIntoView({ behavior: "smooth" }),
    onError: logFailure,
  });

  /* ---- privacy ---- */
  const privacySection = h("section", { class: "card", id: "privacy" });
  const renderPrivacy = (): void => {
    const at = settings.privacy.ackUploadNoticeAt;
    replace(
      privacySection,
      h("h2", null, msg().options.privacyHeading),
      h("ul", { class: "points" }, ...msg().options.privacyPoints.map((point) => h("li", null, point))),
      h(
        "p",
        { class: "hint" },
        at === null
          ? msg().options.privacyNotAcked
          : msg().options.privacyAcked(formatDateTime(new Date(at), currentLocale())),
      ),
    );
  };

  /* ---- cache ---- */
  const cacheMessage = h("p", { class: "message", role: "status" });
  const onClearCache = (): void => {
    if (!globalThis.confirm(msg().options.cacheConfirm)) return;
    clearCache()
      .then((count) => replace(cacheMessage, msg().options.cacheCleared(count)))
      .catch((error: unknown) => {
        logFailure("cache clear failed", error);
        replace(cacheMessage, msg().options.cacheFailed(errorTitle(error)));
      });
  };
  const cacheSection = h(
    "section",
    { class: "card", id: "cache" },
    h("h2", null, msg().options.cacheHeading),
    h("p", { class: "hint" }, msg().options.cacheHint),
    h("button", { type: "button", onclick: onClearCache }, msg().options.cacheClear),
    cacheMessage,
  );

  /* ---- debug ---- */
  const levelSelect = h(
    "select",
    { id: "log-level" },
    ...LOG_LEVELS.map((level) =>
      h(
        "option",
        { value: level, selected: level === settings.debug.logLevel },
        msg().options.logLevels[level],
      ),
    ),
  );
  levelSelect.addEventListener("change", () => {
    const level = LOG_LEVELS.find((candidate) => candidate === levelSelect.value);
    if (level !== undefined) {
      saveLogLevel(level).catch((error: unknown) => logFailure("log level save failed", error));
    }
  });
  const debugMessage = h("p", { class: "message", role: "status" });
  const onExportLog = (): void => {
    readDebugLog()
      .then((entries) => {
        if (entries.length === 0) {
          replace(debugMessage, msg().options.exportEmpty);
          return;
        }
        const payload = { build: __BUILD_ID__, exportedAt: new Date().toISOString(), entries };
        downloadJson(debugLogFileName(new Date()), payload);
        replace(debugMessage, "");
      })
      .catch((error: unknown) => {
        logFailure("debug log export failed", error);
        replace(debugMessage, msg().options.exportFailed);
      });
  };
  const debugSection = h(
    "section",
    { class: "card", id: "debug" },
    h("h2", null, msg().options.debugHeading),
    h("label", { for: "log-level" }, msg().options.logLevel),
    " ",
    levelSelect,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", onclick: onExportLog }, msg().options.exportLog),
    ),
    debugMessage,
  );

  /* ---- backup and restore ---- */
  const transfer = transferSection({
    snapshot: () => ({ settings, sites }),
    confirm: (text) => globalThis.confirm(text),
    onImported: (value) => {
      // The page text follows an imported UI language only after a reload.
      if (value.settings.ui.locale !== renderedLocale) location.reload();
    },
    onError: logFailure,
  });

  /* ---- advanced ---- */
  const advanced = advancedSection({
    settings: () => settings,
    save: saveAdvanced,
    confirm: (text) => globalThis.confirm(text),
    onError: logFailure,
  });

  replace(
    root,
    h("h1", null, `${msg().ui.appName} – ${msg().options.title}`),
    apiSection,
    languageSection,
    sitesView.element,
    privacySection,
    cacheSection,
    transfer,
    debugSection,
    advanced.element,
    h("p", { class: "muted" }, msg().popup.build(__BUILD_ID__)),
  );
  sitesView.render(sites);
  renderPrivacy();
  void refreshHealth();
  if (location.hash === "#privacy") privacySection.scrollIntoView();

  watchSettings((next) => {
    const previous = settings;
    settings = next;
    levelSelect.value = next.debug.logLevel;
    concurrencySelect.value = String(next.api.concurrency);
    // Inputs follow stored changes (an import, another tab) unless the user is editing them.
    const follow = (input: HTMLInputElement | HTMLSelectElement, before: string, after: string): void => {
      if (before !== after && document.activeElement !== input) input.value = after;
    };
    follow(baseUrlInput, previous.api.baseUrl, next.api.baseUrl);
    follow(modelInput, previous.api.model, next.api.model);
    follow(apiKeyInput, previous.api.apiKey, next.api.apiKey);
    follow(targetSelect, previous.translate.targetLang, next.translate.targetLang);
    if (previous.api.baseUrl !== next.api.baseUrl && document.activeElement !== presetSelect) {
      presetSelect.value = presetFor(next.api.baseUrl)?.id ?? "";
    }
    advanced.update(next);
    renderPrivacy();
  });
  watchSites((siteKey, site) => {
    const next = { ...sites };
    if (site === null) Reflect.deleteProperty(next, siteKey);
    else next[siteKey] = site;
    sites = next;
    sitesView.render(sites);
  });
}

main().catch((error: unknown) => logFailure("options page failed to start", error));
