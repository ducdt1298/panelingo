// Popup entry, top to bottom: (1) the site card: turn translation on for this site (the first time through the
// privacy notice), when it translates, the target language, the tab's progress and the actions (translate what is on
// screen, translate the page again, open the transcript), with per-site options folded away; (2) a note when the
// engine is paused or failed; (3) the status line: the AI endpoint's readiness from the popup's own GET /models, so it
// shows without the engine (in offline mode: the offline engine's state instead, and no request to the endpoint), and
// today's upload counter. Rendering never starts the engine.

import { createLogger } from "../../platform/log.ts";
import { callEngine } from "../../platform/messaging.ts";
import { loadAll, saveSettings, watchSettings, watchSites } from "../../platform/storage.ts";
import { errorMessage } from "../../shared/errors.ts";
import { currentLocale, msg } from "../../shared/i18n/index.ts";
import { applyLocale } from "../../platform/locale.ts";
import { TARGET_LANGUAGES } from "../../shared/languages.ts";
import type { Settings, SiteSettings } from "../../shared/settings.ts";
import type { EngineStatus, TabProgress } from "../../shared/types.ts";
import { endpointOf, fetchApiHealth, type HealthResult } from "../common/api-health.ts";
import { h, replace, type Child } from "../common/dom.ts";
import { engineRunning, watchEngine } from "../common/engine-rpc.ts";
import { privacyNotice } from "../common/privacy-notice.ts";
import { hostOf, initialOf } from "../common/site-label.ts";
import {
  apiBlock,
  errorTitle,
  offlineBlock,
  uploadsLine,
  type EngineState,
  type StatusBlock,
} from "../common/status-view.ts";
import {
  acceptNoticeAndEnable,
  activeTab,
  retranslateTab,
  translateVisible,
  updateSite,
} from "./popup-actions.ts";
import { progressView, siteView, toggleStep, visibleMessage, type SiteView } from "./popup-model.ts";

const log = createLogger("popup");

interface State {
  tab: chrome.tabs.Tab | null;
  settings: Settings;
  sites: Record<string, SiteSettings>;
  health: HealthResult | null;
  engine: EngineState | null;
  progress: TabProgress | null;
  /** The privacy notice is open (first enable). */
  consent: boolean;
  /** The per-site options are unfolded. */
  more: boolean;
  busy: boolean;
  message: string | null;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`popup.html lacks #${id}`);
  return el;
}

/** Opens a tab of the options page (`hash`: the tab or card to show) and closes the popup. */
function openOptions(hash: string): void {
  chrome.tabs
    .create({ url: chrome.runtime.getURL(`ui/options.html#${hash}`) })
    .then(() => window.close())
    .catch(() => undefined);
}

async function main(): Promise<void> {
  const view = {
    options: byId("open-options"),
    site: byId("site"),
    engine: byId("engine"),
    api: byId("api"),
    uploads: byId("uploads"),
  };
  const [tab, snapshot] = await Promise.all([activeTab(), loadAll()]);
  applyLocale(snapshot.settings.ui.locale);
  document.documentElement.lang = currentLocale();
  const state: State = {
    tab,
    settings: snapshot.settings,
    sites: snapshot.sites,
    health: null,
    engine: null,
    progress: null,
    consent: false,
    more: false,
    busy: false,
    message: null,
  };
  const tabId = tab?.id ?? null;

  replace(view.options, h("span", { class: "gear", "aria-hidden": "true" }), msg().popup.options);
  view.options.addEventListener("click", () => {
    chrome.runtime
      .openOptionsPage()
      .then(() => window.close())
      .catch(() => undefined);
  });
  view.api.setAttribute("title", msg().popup.options);
  view.api.addEventListener("click", () => openOptions("engine"));

  const offlineMode = (): boolean => state.settings.translate.engine === "offline";

  /** The status line: readiness (or the offline engine's state), the model, and what to do when it is not ready. */
  const renderStatus = (): void => {
    let block: StatusBlock;
    let detail: string;
    if (offlineMode()) {
      block = offlineBlock(state.engine?.status?.offline ?? null);
      detail = msg().popup.offlineHeading;
    } else {
      block = apiBlock(state.health?.reading ?? null);
      detail = state.health?.reading.model ?? state.settings.api.model;
    }
    const trouble = block.tone === "error" || block.tone === "warn";
    replace(
      view.api,
      h(
        "span",
        { class: "status-main" },
        h("span", { class: `pill tone-${block.tone}` }, block.title),
        h("span", { class: "status-detail" }, detail),
      ),
      trouble && block.hint !== "" ? h("span", { class: "status-hint" }, block.hint) : null,
      h("span", { class: "status-go", "aria-hidden": "true" }, "›"),
    );
    view.api.className = `status-line${trouble ? " trouble" : ""}`;
    // Nothing is uploaded in offline mode: no "sent to the AI today" line.
    const line = offlineMode() ? null : uploadsLine(state.engine?.status ?? null);
    replace(view.uploads, line ?? "");
    view.uploads.hidden = line === null;
  };
  const checkApi = (): void => {
    if (offlineMode()) return;
    void fetchApiHealth(endpointOf(state.settings.api)).then((result) => {
      state.health = result;
      renderStatus();
    });
  };

  /** A paused queue or a failed engine, with the fix; hidden when all is well. */
  const renderEngine = (): void => {
    const engine = state.engine;
    const status = engine?.exists === true ? engine.status : undefined;
    let note: Child[] = [];
    if (engine?.exists === true && status === null) {
      note = [h("p", { class: "note-title" }, msg().popup.engineUnreadable)];
    } else if (status !== undefined && status !== null) {
      const paused = status.queue.pausedBy;
      if (status.phase === "failed") {
        note = [h("p", { class: "note-title" }, msg().enginePhase.failed)];
      } else if (paused !== null) {
        const error = msg().errors[paused];
        note = [
          h("p", { class: "note-title" }, msg().popup.pausedBy(error.title)),
          error.hint === "" ? null : h("p", { class: "hint" }, error.hint),
          paused.startsWith("api.")
            ? h("button", { type: "button", onclick: () => openOptions("engine") }, msg().popup.options)
            : null,
        ];
      }
    }
    replace(view.engine, ...note);
    view.engine.hidden = note.length === 0;
  };

  const refreshProgress = (): void => {
    if (tabId === null || state.engine?.exists !== true) return;
    callEngine("en:tab-progress", { tabId })
      .then((progress) => {
        state.progress = progress;
        renderSite();
      })
      .catch((error: unknown) => log.debug("en:tab-progress failed", { error: errorMessage(error) }));
  };

  /** Actions in flight, and the latest one: only its outcome is shown (an older one may finish later). */
  let running = 0;
  let latest = 0;
  const run = (task: () => Promise<string | null>): void => {
    const id = (latest += 1);
    running += 1;
    state.busy = true;
    renderSite();
    task()
      .then((message) => {
        if (id === latest) state.message = message;
      })
      .catch((error: unknown) => {
        log.warn("popup action failed", { error: errorMessage(error) });
        if (id === latest) state.message = msg().popup.actionFailed(errorTitle(error));
      })
      .finally(() => {
        running -= 1;
        state.busy = running > 0;
        renderSite();
      });
  };

  const onToggle = (site: Extract<SiteView, { kind: "site" }>): void => {
    const step = toggleStep(site.enabled, state.settings);
    if (step === "consent") {
      state.consent = true;
      renderSite();
      return;
    }
    run(async () => {
      await updateSite(site.siteKey, { enabled: step === "enable" }, tabId);
      return null;
    });
  };
  const onAccept = (siteKey: string): void => {
    state.consent = false;
    run(async () => {
      const at = await acceptNoticeAndEnable(siteKey, tabId);
      state.settings = { ...state.settings, privacy: { ...state.settings.privacy, ackUploadNoticeAt: at } };
      return null;
    });
  };
  const onMode = (siteKey: string, mode: SiteSettings["mode"]): void => {
    run(async () => {
      await updateSite(siteKey, { mode }, tabId);
      return null;
    });
  };
  const onCookies = (siteKey: string, cookies: boolean): void => {
    run(async () => {
      await updateSite(siteKey, { credentials: cookies ? "include" : "omit" }, tabId);
      return null;
    });
  };
  const onTarget = (targetLang: string): void => {
    run(async () => {
      state.settings = await saveSettings({ translate: { targetLang } });
      return msg().options.saved;
    });
  };
  const onVisible = (id: number): void => {
    run(async () => visibleMessage(await translateVisible(id)));
  };
  const onRetranslate = (id: number): void => {
    run(async () => {
      const queued = await retranslateTab(id);
      return queued === null ? msg().popup.engineStopped : msg().popup.retranslateQueued(queued);
    });
  };
  const onTranscript = (): void => {
    const windowId = state.tab?.windowId;
    if (windowId === undefined) return;
    // Called straight from the click: sidePanel.open() needs the user gesture.
    chrome.sidePanel
      .open({ windowId })
      .then(() => window.close())
      .catch((error: unknown) => log.warn("sidePanel.open failed", { error: errorMessage(error) }));
  };

  /** A switch with its label on the left (the popup's on/off rows). */
  function switchRow(
    id: string,
    label: string,
    checked: boolean,
    onChange: (on: boolean) => void,
    hint = "",
  ): HTMLElement {
    const box = h("input", {
      type: "checkbox",
      id,
      checked,
      disabled: state.busy,
      onchange: (event: Event) => onChange((event.target as HTMLInputElement).checked),
    });
    return h(
      "label",
      { class: "switch-row", for: id, ...(hint === "" ? {} : { title: hint }) },
      h("span", { class: "switch-text" }, label),
      box,
    );
  }

  function modeSelector(site: Extract<SiteView, { kind: "site" }>): HTMLElement {
    const option = (mode: SiteSettings["mode"], label: string): HTMLElement =>
      h(
        "label",
        { class: "radio" },
        h("input", {
          type: "radio",
          name: "mode",
          value: mode,
          checked: site.mode === mode,
          disabled: state.busy,
          onchange: () => onMode(site.siteKey, mode),
        }),
        label,
      );
    return h(
      "fieldset",
      { class: "mode" },
      h("legend", null, msg().popup.modeLabel),
      option("auto", msg().ui.modeAuto),
      option("manual", msg().ui.modeManual),
    );
  }

  function targetRow(): HTMLElement {
    const select = h(
      "select",
      {
        id: "target-lang",
        disabled: state.busy,
        onchange: (event: Event) => onTarget((event.target as HTMLSelectElement).value),
      },
      h("option", { value: "auto" }, msg().options.languageAuto),
      ...TARGET_LANGUAGES.map((language) => h("option", { value: language.code }, language.nativeName)),
    );
    select.value = state.settings.translate.targetLang;
    return h(
      "div",
      { class: "row" },
      h("label", { for: "target-lang" }, msg().options.targetLanguage),
      select,
    );
  }

  function progressBar(): HTMLElement | null {
    const progress = progressView(state.progress);
    if (progress === null) return null;
    const percent = (n: number): string => `${Math.round((n / progress.total) * 100)}%`;
    return h(
      "div",
      { class: `progress${progress.busy ? " busy" : " settled"}`, id: "progress" },
      h(
        "div",
        {
          class: "bar",
          role: "progressbar",
          "aria-valuemin": "0",
          "aria-valuemax": String(progress.total),
          "aria-valuenow": String(progress.done),
        },
        h("span", { class: "fill", style: `width: ${percent(progress.done)}` }),
        progress.failed > 0
          ? h("span", { class: "fill failed", style: `width: ${percent(progress.failed)}` })
          : null,
      ),
      h("p", { class: "progress-text" }, progress.text),
    );
  }

  function renderSite(): void {
    const site = siteView(state.tab?.url, state.sites);
    if (site.kind === "unsupported" || tabId === null) {
      replace(
        view.site,
        h("h2", { class: "site-host" }, msg().popup.siteHeading),
        h("p", { class: "hint" }, msg().popup.siteUnsupported),
      );
      return;
    }
    const manual = !site.enabled || site.mode === "manual";
    const children: Child[] = [
      h(
        "div",
        { class: "site-head" },
        h("span", { class: "site-avatar", "aria-hidden": "true" }, initialOf(site.siteKey)),
        h("h2", { class: "site-host", title: site.siteKey }, hostOf(site.siteKey)),
      ),
      switchRow("site-enabled", msg().popup.siteToggle, site.enabled, () => onToggle(site)),
    ];
    if (state.consent) {
      children.push(
        privacyNotice({
          onAccept: () => onAccept(site.siteKey),
          onDecline: () => {
            state.consent = false;
            renderSite();
          },
          onDetails: () => openOptions("privacy"),
        }),
      );
    }
    if (site.enabled) children.push(modeSelector(site));
    children.push(targetRow(), progressBar());
    children.push(
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            type: "button",
            class: manual ? "primary" : "",
            disabled: state.busy,
            onclick: () => onVisible(tabId),
          },
          msg().ui.translateVisible,
        ),
        state.engine?.exists === true
          ? h(
              "button",
              { type: "button", disabled: state.busy, onclick: () => onRetranslate(tabId) },
              msg().popup.retranslatePage,
            )
          : null,
        state.tab?.windowId === undefined
          ? null
          : h("button", { type: "button", class: "link", onclick: onTranscript }, msg().popup.openTranscript),
      ),
    );
    if (state.message !== null) children.push(h("p", { class: "message", role: "status" }, state.message));
    const more = h(
      "details",
      { class: "more", open: state.more },
      h("summary", null, msg().popup.more),
      site.enabled
        ? switchRow(
            "site-cookies",
            msg().popup.cookies,
            site.cookies,
            (on) => onCookies(site.siteKey, on),
            msg().popup.cookiesHint,
          )
        : null,
      site.enabled ? h("p", { class: "hint" }, msg().popup.cookiesHint) : null,
      h(
        "a",
        {
          href: "#",
          onclick: (event: Event) => {
            event.preventDefault();
            openOptions("sites");
          },
        },
        msg().popup.siteSettings,
      ),
    );
    more.addEventListener("toggle", () => {
      state.more = more.open;
    });
    children.push(more);
    replace(view.site, ...children);
  }

  renderStatus();
  renderEngine();
  renderSite();

  watchSettings((settings) => {
    const engineChanged = settings.translate.engine !== state.settings.translate.engine;
    state.settings = settings;
    if (engineChanged) checkApi();
    renderStatus();
    renderSite();
  });
  watchSites((siteKey, site) => {
    const sites = { ...state.sites };
    if (site === null) Reflect.deleteProperty(sites, siteKey);
    else sites[siteKey] = site;
    state.sites = sites;
    renderSite();
  });

  checkApi();

  const engineChanged = (): void => {
    renderStatus();
    renderEngine();
    renderSite();
    refreshProgress();
  };
  if (!(await engineRunning())) {
    state.engine = { exists: false, status: null };
    engineChanged();
    return;
  }
  let status: EngineStatus | null = null;
  try {
    status = await callEngine("en:status", tabId === null ? {} : { tabId });
  } catch (error) {
    log.debug("en:status failed", { error: errorMessage(error) });
  }
  state.engine = { exists: true, status };
  engineChanged();
  watchEngine({
    view: "popup",
    tabId,
    log,
    onStatus: (next) => {
      state.engine = { exists: true, status: next };
      engineChanged();
    },
    onGone: () => {
      state.engine = { exists: false, status: null };
      state.progress = null;
      engineChanged();
    },
  });
}

main().catch((error: unknown) => {
  log.error("popup failed to start", { error: errorMessage(error) });
});
