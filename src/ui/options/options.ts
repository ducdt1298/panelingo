// Options entry, in five tabs (the URL hash names the open one; old section anchors open the tab that holds them):
// - Translation: the engine (AI endpoint or offline, experimental), the endpoint form (preset, base URL, API key,
//   model, parallel requests, connection test) or the offline card (offline-view.ts), and series memory.
// - Language & display: interface and translation languages, lettering and keys (rows from advanced-view.ts).
// - Sites: the site list with a per-site editor (sites-view.ts).
// - Privacy & data: what is sent to the AI, cache clearing, settings backup and restore (transfer-view.ts), the debug
//   log.
// - Advanced: every remaining setting, searchable, generated from a declarative table (advanced-view.ts).
// Settings go to chrome.storage.local and the service worker relays them to the engine; site patches go through
// sw:site-set, which also re-syncs the content-script registration.

import { createLogger } from "../../platform/log.ts";
import { callEngine } from "../../platform/messaging.ts";
import { loadAll, watchSettings, watchSites } from "../../platform/storage.ts";
import { errorMessage } from "../../shared/errors.ts";
import { currentLocale, msg, uiLocales } from "../../shared/i18n/index.ts";
import { applyLocale } from "../../platform/locale.ts";
import { TARGET_LANGUAGES } from "../../shared/languages.ts";
import type { Settings, SiteSettings } from "../../shared/settings.ts";
import { endpointOf, fetchApiHealth } from "../common/api-health.ts";
import { h, replace } from "../common/dom.ts";
import { engineRunning, watchEngine } from "../common/engine-rpc.ts";
import {
  apiBlock,
  engineBlock,
  errorTitle,
  type EngineState,
  type StatusBlock,
} from "../common/status-view.ts";
import { fieldsAt } from "./advanced-model.ts";
import { advancedSection, settingsCard } from "./advanced-view.ts";
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
  OPTION_TABS,
  parseBaseUrl,
  parseConcurrency,
  parseModel,
  presetFor,
  tabFor,
  type OptionTab,
} from "./options-model.ts";
import { offlineSection } from "./offline-view.ts";
import { sitesSection } from "./sites-view.ts";
import { downloadJson, transferSection } from "./transfer-view.ts";

const log = createLogger("options");

const ENGINES = ["api", "offline"] as const;

function logFailure(what: string, error: unknown): void {
  log.warn(what, { error: errorMessage(error) });
}

/** A labeled form field: the label above the control, the hint under it. */
function field(id: string, label: string, input: HTMLElement, hint: string): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, label),
    input,
    hint === "" ? null : h("p", { class: "hint" }, hint),
  );
}

/** The endpoint's readiness in the card header, with what to do when it is not ready. */
function renderApiStatus(pill: HTMLElement, details: HTMLElement, block: StatusBlock): void {
  replace(pill, h("p", { class: `pill tone-${block.tone}` }, block.title));
  replace(
    details,
    block.hint === "" ? null : h("p", { class: "hint" }, block.hint),
    ...block.lines
      .filter((line) => line.startsWith(msg().popup.cause("")))
      .map((line) => h("p", { class: "hint" }, line)),
    ...block.warnings.map((warning) => h("p", { class: "warning", role: "alert" }, warning)),
  );
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

  /* ---- translation engine ---- */
  const engineMessage = h("p", { class: "message", role: "status" });
  const engineRadios = ENGINES.map((engine) =>
    h("input", {
      type: "radio",
      name: "engine",
      id: `engine-${engine}`,
      value: engine,
      checked: settings.translate.engine === engine,
      onchange: () => {
        saveAdvanced({ translate: { engine } })
          .then((saved) => {
            settings = saved;
            showEngine();
            replace(engineMessage, msg().options.saved);
          })
          .catch((error: unknown) => {
            logFailure("saving the translation engine failed", error);
            replace(engineMessage, msg().options.saveFailed);
          });
      },
    }),
  );
  const engineSection = h(
    "section",
    { class: "card", id: "engine-choice" },
    h(
      "fieldset",
      { class: "mode engine-choice" },
      h("legend", null, msg().offline.engine),
      ...ENGINES.map((engine, i) =>
        h(
          "label",
          { class: "radio", for: `engine-${engine}` },
          engineRadios[i],
          msg().offline.engineChoices[engine],
        ),
      ),
    ),
    engineMessage,
  );

  /* ---- AI endpoint ---- */
  const apiPill = h("div", { class: "status", "aria-live": "polite" });
  const apiDetails = h("div", { class: "status-details" });
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
  });
  const apiKeyInput = h("input", {
    type: "password",
    id: "api-key",
    value: settings.api.apiKey,
    autocomplete: "off",
    spellcheck: "false",
  });
  const modelInput = h("input", {
    type: "text",
    id: "model",
    value: settings.api.model,
    spellcheck: "false",
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
    // Offline mode contacts no endpoint on its own (the card is hidden); "Test connection" still checks it.
    if (settings.translate.engine === "offline") return Promise.resolve();
    renderApiStatus(apiPill, apiDetails, apiBlock(null));
    return fetchApiHealth(endpoint)
      .then((result) => {
        renderApiStatus(apiPill, apiDetails, apiBlock(result.reading));
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
  const apiSection = h(
    "section",
    { class: "card", id: "api" },
    h("div", { class: "card-head" }, h("h3", null, msg().options.apiHeading), apiPill),
    apiDetails,
    h("p", { class: "hint" }, msg().options.apiIntro),
    field("preset", msg().options.preset, presetSelect, ""),
    field("base-url", msg().options.baseUrl, baseUrlInput, msg().options.baseUrlHint),
    field("api-key", msg().options.apiKey, apiKeyInput, msg().options.apiKeyHint),
    field(
      "model",
      msg().options.model,
      h("span", { class: "with-list" }, modelInput, modelList),
      msg().options.modelHint,
    ),
    field("concurrency", msg().options.concurrency, concurrencySelect, msg().options.concurrencyHint),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "primary", onclick: saveApiForm }, msg().options.save),
      h("button", { type: "button", onclick: testConnection }, msg().options.testConnection),
    ),
    apiMessage,
  );

  /* ---- offline mode (experimental) ---- */
  const offline = offlineSection({
    settings: () => settings,
    save: saveAdvanced,
    confirm: (text) => globalThis.confirm(text),
    onError: logFailure,
  });

  const fieldDeps = { settings: () => settings, save: saveAdvanced, onError: logFailure };
  const speed = settingsCard("speed", msg().options.speedHeading, fieldsAt("speed"), fieldDeps);
  const memory = settingsCard("memory", msg().optionsAdvanced.groups.memory, fieldsAt("memory"), fieldDeps);

  const showEngine = (): void => {
    const engine = settings.translate.engine;
    for (const radio of engineRadios) radio.checked = radio.value === engine;
    apiSection.hidden = engine !== "api";
    // Fast mode only changes what is asked of the AI endpoint.
    speed.element.hidden = engine !== "api";
    offline.element.hidden = engine !== "offline";
  };

  /* ---- languages and display ---- */
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
    h("h3", null, msg().options.languageHeading),
    field("target-lang", msg().options.targetLanguage, targetSelect, ""),
    field("ui-locale", msg().options.uiLanguage, uiSelect, ""),
    languageMessage,
  );
  const lettering = settingsCard(
    "lettering",
    msg().optionsAdvanced.groups.render,
    fieldsAt("lettering"),
    fieldDeps,
  );
  const controls = settingsCard("controls", msg().options.controlsHeading, fieldsAt("controls"), fieldDeps);

  /* ---- sites ---- */
  const sitesView = sitesSection({
    settings: () => settings,
    onDetails: () => {
      location.hash = "#privacy";
    },
    onError: logFailure,
  });

  /* ---- privacy and data ---- */
  const privacySection = h("section", { class: "card", id: "privacy" });
  const renderPrivacy = (): void => {
    const at = settings.privacy.ackUploadNoticeAt;
    replace(
      privacySection,
      h("h3", null, msg().options.privacyHeading),
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
    h("h3", null, msg().options.cacheHeading),
    h("p", { class: "hint" }, msg().options.cacheHint),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", onclick: onClearCache }, msg().options.cacheClear),
    ),
    cacheMessage,
  );

  const transfer = transferSection({
    snapshot: () => ({ settings, sites }),
    confirm: (text) => globalThis.confirm(text),
    onImported: (value) => {
      // The page text follows an imported UI language only after a reload.
      if (value.settings.ui.locale !== renderedLocale) location.reload();
    },
    onError: logFailure,
  });

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
  // What the engine reports (for bug reports): only read when it already runs; this page never starts it.
  const engineInfo = h("div", { class: "engine-info", id: "engine-status", "aria-live": "polite" });
  const renderEngineInfo = (state: EngineState | null): void => {
    const block = engineBlock(state);
    replace(
      engineInfo,
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "engine-label" }, msg().popup.engineHeading),
        h("p", { class: `pill tone-${block.tone}` }, block.title),
      ),
      block.lines.length === 0
        ? null
        : h("ul", { class: "facts" }, ...block.lines.map((line) => h("li", null, line))),
      block.hint === "" ? null : h("p", { class: "hint" }, block.hint),
    );
  };
  renderEngineInfo(null);
  const debugSection = h(
    "section",
    { class: "card", id: "debug" },
    h("h3", null, msg().options.debugHeading),
    engineInfo,
    field("log-level", msg().options.logLevel, levelSelect, ""),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", onclick: onExportLog }, msg().options.exportLog),
    ),
    debugMessage,
  );

  /* ---- advanced ---- */
  const advanced = advancedSection({
    ...fieldDeps,
    confirm: (text) => globalThis.confirm(text),
  });

  const cards: Record<OptionTab, HTMLElement[]> = {
    engine: [engineSection, apiSection, offline.element, speed.element, memory.element],
    display: [languageSection, lettering.element, controls.element],
    sites: [sitesView.element],
    privacy: [privacySection, cacheSection, transfer, debugSection],
    advanced: [advanced.element],
  };
  const tabs = OPTION_TABS.map((tab) =>
    h(
      "section",
      { class: "tab", id: `tab-${tab}`, role: "tabpanel", "aria-labelledby": `nav-${tab}` },
      h(
        "header",
        { class: "tab-head" },
        h("h2", null, msg().options.tabs[tab].label),
        h("p", { class: "hint" }, msg().options.tabs[tab].intro),
      ),
      ...cards[tab],
    ),
  );
  const nav = settingsNav(tabs);
  replace(
    root,
    h(
      "header",
      { class: "page-header" },
      h("img", { class: "logo", src: "../assets/icons/icon-48.png", width: 36, height: 36, alt: "" }),
      h("h1", null, `${msg().ui.appName} – ${msg().options.title}`),
      h("span", { class: "build muted" }, msg().popup.build(__BUILD_ID__)),
    ),
    h("div", { class: "settings-layout" }, nav, h("div", { class: "settings-form" }, ...tabs)),
  );
  showEngine();
  sitesView.render(sites);
  renderPrivacy();
  void refreshHealth();
  void watchEngineInfo(renderEngineInfo);

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
    lettering.update(next);
    controls.update(next);
    speed.update(next);
    memory.update(next);
    offline.update(next);
    showEngine();
    if (previous.translate.engine !== next.translate.engine) void refreshHealth();
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

/** Shows the engine's status in the Debug log card while it runs (never starts it). */
async function watchEngineInfo(render: (state: EngineState) => void): Promise<void> {
  if (!(await engineRunning())) {
    render({ exists: false, status: null });
    return;
  }
  try {
    render({ exists: true, status: await callEngine("en:status", {}) });
  } catch (error) {
    log.debug("en:status failed", { error: errorMessage(error) });
    render({ exists: true, status: null });
  }
  watchEngine({
    view: "options",
    tabId: null,
    log,
    onStatus: (status) => render({ exists: true, status }),
    onGone: () => render({ exists: false, status: null }),
  });
}

/**
 * The tab list on the left: one tab shown at a time. The tab follows the URL hash, so deep links (#privacy from the
 * popup, #sites, an old #cache bookmark) and the browser's back button work; the first tab is the default. Clicking
 * switches (and scrolls to the top) at once; the hashchange that follows only acts when it names another tab, so the
 * page never jumps after the user moved on.
 */
function settingsNav(tabs: readonly HTMLElement[]): HTMLElement {
  const links = OPTION_TABS.map((tab) =>
    h(
      "a",
      {
        class: `settings-nav-item nav-${tab}`,
        id: `nav-${tab}`,
        href: `#${tab}`,
        role: "tab",
        "aria-controls": `tab-${tab}`,
        onclick: () => {
          if (show(tab) && typeof window !== "undefined") window.scrollTo(0, 0);
        },
      },
      h("span", { class: "nav-icon", "aria-hidden": "true" }),
      msg().options.tabs[tab].label,
    ),
  );
  let shown: OptionTab | null = null;
  /** Shows the tab of `hash`; true when that is another tab than before. */
  const show = (hash: string): boolean => {
    const current = tabFor(hash);
    const changed = current !== shown;
    shown = current;
    OPTION_TABS.forEach((tab, i) => {
      const active = tab === current;
      const panel = tabs[i];
      const link = links[i];
      if (panel !== undefined) panel.hidden = !active;
      if (link !== undefined) {
        link.className = `settings-nav-item nav-${tab}${active ? " is-active" : ""}`;
        link.setAttribute("aria-selected", String(active));
      }
    });
    // An old anchor of a card (#cache, #api…) scrolls to that card inside its tab.
    if (hash !== current && typeof document.getElementById === "function") {
      const card = document.getElementById(hash);
      if (card !== null && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "start" });
    }
    return changed;
  };
  show(location.hash.slice(1));
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("hashchange", () => {
      // Back/forward or a link to another tab; after a click the tab is already shown and nothing moves.
      if (show(location.hash.slice(1)) && OPTION_TABS.some((tab) => `#${tab}` === location.hash)) {
        window.scrollTo(0, 0);
      }
    });
  }
  return h(
    "nav",
    {
      class: "settings-nav",
      role: "tablist",
      "aria-label": msg().options.title,
      "aria-orientation": "vertical",
    },
    ...links,
  );
}
