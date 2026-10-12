// Popup entry, top to bottom: (1) the AI endpoint's readiness from the popup's own GET /models, so it shows without
// the engine; (2) engine status, only when the engine already runs; (3) this site: opt-in (the first enable goes
// through the privacy notice), mode and quick actions; (4) today's upload counter. Rendering never starts the engine.

import { createLogger } from "../../platform/log.ts";
import { callEngine } from "../../platform/messaging.ts";
import { loadAll, watchSettings, watchSites } from "../../platform/storage.ts";
import { errorMessage } from "../../shared/errors.ts";
import { currentLocale, msg } from "../../shared/i18n/index.ts";
import { applyLocale } from "../../platform/locale.ts";
import type { Settings, SiteSettings } from "../../shared/settings.ts";
import type { EngineStatus } from "../../shared/types.ts";
import { endpointOf, fetchApiHealth, type HealthResult } from "../common/api-health.ts";
import { h, replace, type Child } from "../common/dom.ts";
import { engineRunning, watchEngine } from "../common/engine-rpc.ts";
import { privacyNotice } from "../common/privacy-notice.ts";
import {
  apiBlock,
  engineBlock,
  errorTitle,
  renderStatusBlock,
  uploadsLine,
  type EngineState,
} from "../common/status-view.ts";
import {
  acceptNoticeAndEnable,
  activeTab,
  retranslateTab,
  translateVisible,
  updateSite,
} from "./popup-actions.ts";
import { siteView, toggleStep, visibleMessage, type SiteView } from "./popup-model.ts";

const log = createLogger("popup");

interface State {
  tab: chrome.tabs.Tab | null;
  settings: Settings;
  sites: Record<string, SiteSettings>;
  health: HealthResult | null;
  engine: EngineState | null;
  /** The privacy notice is open (first enable). */
  consent: boolean;
  busy: boolean;
  message: string | null;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`popup.html lacks #${id}`);
  return el;
}

async function main(): Promise<void> {
  const view = {
    api: byId("api"),
    engine: byId("engine"),
    site: byId("site"),
    uploads: byId("uploads"),
    footer: byId("footer"),
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
    consent: false,
    busy: false,
    message: null,
  };
  const tabId = tab?.id ?? null;

  const renderApi = (): void => {
    const block = apiBlock(state.health?.reading ?? null, state.settings.api.baseUrl);
    renderStatusBlock(view.api, msg().popup.apiHeading, block);
  };
  const renderEngine = (): void => {
    renderStatusBlock(view.engine, msg().popup.engineHeading, engineBlock(state.engine));
    const line = uploadsLine(state.engine?.status ?? null);
    replace(view.uploads, line ?? "");
    view.uploads.hidden = line === null;
    renderSite();
  };

  const run = (task: () => Promise<string | null>): void => {
    state.busy = true;
    renderSite();
    task()
      .then((message) => {
        state.message = message;
      })
      .catch((error: unknown) => {
        log.warn("popup action failed", { error: errorMessage(error) });
        state.message = msg().popup.actionFailed(errorTitle(error));
      })
      .finally(() => {
        state.busy = false;
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
  const onVisible = (id: number): void => {
    run(async () => visibleMessage(await translateVisible(id)));
  };
  const onRetranslate = (id: number): void => {
    run(async () => {
      const queued = await retranslateTab(id);
      return queued === null ? msg().popup.engineStopped : msg().popup.retranslateQueued(queued);
    });
  };

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

  function renderSite(): void {
    const site = siteView(state.tab?.url, state.sites);
    const children: Child[] = [h("h2", null, msg().popup.siteHeading)];
    if (site.kind === "unsupported" || tabId === null) {
      children.push(h("p", { class: "hint" }, msg().popup.siteUnsupported));
      replace(view.site, ...children);
      return;
    }
    children.push(
      h("p", { class: "site-key" }, site.siteKey),
      h(
        "p",
        { class: `pill tone-${site.enabled ? "ok" : "idle"}` },
        site.enabled ? msg().popup.siteOn : msg().popup.siteOff,
      ),
      h(
        "button",
        {
          type: "button",
          class: site.enabled ? "" : "primary",
          disabled: state.busy,
          onclick: () => onToggle(site),
        },
        site.enabled ? msg().ui.siteDisable : msg().ui.siteEnable,
      ),
    );
    if (state.consent) {
      children.push(
        privacyNotice({
          onAccept: () => onAccept(site.siteKey),
          onDecline: () => {
            state.consent = false;
            renderSite();
          },
          onDetails: () => {
            chrome.tabs
              .create({ url: chrome.runtime.getURL("ui/options.html#privacy") })
              .catch(() => undefined);
          },
        }),
      );
    }
    if (site.enabled) {
      children.push(
        modeSelector(site),
        h(
          "label",
          { class: "check", title: msg().popup.cookiesHint },
          h("input", {
            type: "checkbox",
            checked: site.cookies,
            disabled: state.busy,
            onchange: (event: Event) => onCookies(site.siteKey, (event.target as HTMLInputElement).checked),
          }),
          " ",
          msg().popup.cookies,
        ),
      );
    }
    children.push(
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          { type: "button", disabled: state.busy, onclick: () => onVisible(tabId) },
          msg().ui.translateVisible,
        ),
        state.engine?.exists === true
          ? h(
              "button",
              { type: "button", disabled: state.busy, onclick: () => onRetranslate(tabId) },
              msg().popup.retranslatePage,
            )
          : null,
      ),
    );
    if (state.message !== null) children.push(h("p", { class: "message", role: "status" }, state.message));
    replace(view.site, ...children);
  }

  replace(
    view.footer,
    h(
      "a",
      {
        href: "#",
        onclick: (event) => {
          event.preventDefault();
          chrome.runtime.openOptionsPage().catch(() => undefined);
        },
      },
      msg().popup.options,
    ),
    state.tab?.windowId === undefined
      ? null
      : h(
          "a",
          {
            href: "#",
            onclick: (event) => {
              event.preventDefault();
              const windowId = state.tab?.windowId;
              if (windowId === undefined) return;
              // Called straight from the click: sidePanel.open() needs the user gesture.
              chrome.sidePanel
                .open({ windowId })
                .then(() => window.close())
                .catch((error: unknown) => log.warn("sidePanel.open failed", { error: errorMessage(error) }));
            },
          },
          msg().popup.openTranscript,
        ),
    h("span", { class: "muted" }, msg().popup.build(__BUILD_ID__)),
  );
  renderApi();
  renderEngine();

  watchSettings((settings) => {
    state.settings = settings;
    renderSite();
  });
  watchSites((siteKey, site) => {
    const sites = { ...state.sites };
    if (site === null) Reflect.deleteProperty(sites, siteKey);
    else sites[siteKey] = site;
    state.sites = sites;
    renderSite();
  });

  void fetchApiHealth(endpointOf(state.settings.api)).then((result) => {
    state.health = result;
    renderApi();
  });

  if (!(await engineRunning())) {
    state.engine = { exists: false, status: null };
    renderEngine();
    return;
  }
  let status: EngineStatus | null = null;
  try {
    status = await callEngine("en:status", tabId === null ? {} : { tabId });
  } catch (error) {
    log.debug("en:status failed", { error: errorMessage(error) });
  }
  state.engine = { exists: true, status };
  renderEngine();
  watchEngine({
    view: "popup",
    tabId,
    log,
    onStatus: (next) => {
      state.engine = { exists: true, status: next };
      renderEngine();
    },
    onGone: () => {
      state.engine = { exists: false, status: null };
      renderEngine();
    },
  });
}

main().catch((error: unknown) => {
  log.error("popup failed to start", { error: errorMessage(error) });
});
