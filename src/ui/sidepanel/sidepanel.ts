// Side panel with two views of the active tab. Transcript: every translated line in page order then reading order,
// with manual edits, per-line retranslation, "show on page", a plain-text copy and a mark on lines that differ from
// the glossary; it reads en:transcript and refreshes on the engine's tx:delta pushes over Port "ui", and viewing it
// never starts the engine (edits and retranslation do). Glossary (glossary-view.ts): the series memory of the tab's
// series; opening it is an explicit action, so it starts the engine when needed.

import { applyLocale } from "../../platform/locale.ts";
import { createLogger } from "../../platform/log.ts";
import { loadSettings } from "../../platform/storage.ts";
import { errorMessage } from "../../shared/errors.ts";
import { currentLocale, msg } from "../../shared/i18n/index.ts";
import { pageKeysOf } from "../../shared/series-key.ts";
import type { Transcript, TranscriptItem } from "../../shared/types.ts";
import { h, replace, type Child } from "../common/dom.ts";
import {
  callEngineEnsured,
  callEngineIfRunning,
  engineRunning,
  watchEngine,
  type EngineWatch,
} from "../common/engine-rpc.ts";
import { createGlossaryView } from "./glossary-view.ts";
import {
  canEdit,
  canRetranslate,
  canRevert,
  editPayload,
  groupPages,
  itemKey,
  transcriptText,
} from "./sidepanel-model.ts";

const log = createLogger("sidepanel");

/** Coalesces bursts of tx:delta pushes (one per accepted line) into one transcript read. */
const REFRESH_DEBOUNCE_MS = 400;
/** While the engine is not running, how often to look again (a page may start it at any time). */
const IDLE_POLL_MS = 4_000;

type View = "transcript" | "glossary";

interface State {
  windowId: number | null;
  tabId: number | null;
  view: View;
  /** Series of the tab's page from its URL and title (the transcript's key wins once the engine reports one). */
  tabSeries: string | null;
  transcript: Transcript | null;
  /** itemKey of the line being edited, with its draft text. */
  editing: { key: string; draft: string } | null;
  busy: boolean;
  message: string | null;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`sidepanel.html lacks #${id}`);
  return el;
}

async function activeTabId(windowId: number | null): Promise<number | null> {
  const query: chrome.tabs.QueryInfo =
    windowId === null ? { active: true, currentWindow: true } : { active: true, windowId };
  const [tab] = await chrome.tabs.query(query);
  return tab?.id ?? null;
}

/** The series of a tab's page, from its URL and title (null for pages that cannot be translated). */
async function tabSeriesKey(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return pageKeysOf(tab.url ?? "", tab.title ?? "")?.seriesKey ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  applyLocale((await loadSettings()).ui.locale);
  document.documentElement.lang = currentLocale();
  document.title = msg().sidepanel.title;

  const view = { tabs: byId("tabs"), toolbar: byId("toolbar"), list: byId("list"), message: byId("message") };
  const state: State = {
    windowId: null,
    tabId: null,
    view: "transcript",
    tabSeries: null,
    transcript: null,
    editing: null,
    busy: false,
    message: null,
  };
  let watch: EngineWatch | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** A refresh arrived while a line was being edited; applied when editing ends. */
  let deferred = false;

  const say = (text: string | null): void => {
    state.message = text;
    replace(view.message, text ?? "");
  };

  const fail = (what: string, error: unknown): void => {
    log.warn(`${what} failed`, { error: errorMessage(error) });
    say(msg().sidepanel.failed);
  };

  const glossary = createGlossaryView({ say, fail, changed: () => render() });
  const seriesKey = (): string | null => state.transcript?.seriesKey ?? state.tabSeries;

  const show = (next: View): void => {
    if (next === state.view) return;
    state.view = next;
    state.editing = null;
    say(null);
    render();
    if (next === "glossary") void glossary.load(seriesKey());
    else void refresh();
  };

  const renderTabs = (): void => {
    const tab = (id: View, label: string): HTMLElement =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          class: state.view === id ? "tab selected" : "tab",
          "aria-selected": state.view === id ? "true" : "false",
          onclick: () => show(id),
        },
        label,
      );
    replace(
      view.tabs,
      tab("transcript", msg().sidepanel.tabs.transcript),
      tab("glossary", msg().sidepanel.tabs.glossary),
    );
  };

  const renderToolbar = (): void => {
    if (state.view === "glossary") {
      replace(view.toolbar, h("h1", null, msg().sidepanel.tabs.glossary), glossary.actions());
      return;
    }
    const items = state.transcript?.items ?? [];
    replace(
      view.toolbar,
      h("h1", null, msg().sidepanel.heading),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => void refresh() }, msg().sidepanel.refresh),
        h(
          "button",
          { type: "button", disabled: items.length === 0, onclick: () => void copyAll() },
          msg().sidepanel.copy,
        ),
      ),
    );
  };

  const lineActions = (item: TranscriptItem, key: string): HTMLElement => {
    const buttons: Child[] = [
      h(
        "button",
        { type: "button", title: msg().sidepanel.jumpHint, onclick: () => void jump(item) },
        msg().sidepanel.jump,
      ),
    ];
    if (canEdit(item)) {
      buttons.push(
        h(
          "button",
          {
            type: "button",
            disabled: state.busy,
            onclick: () => {
              state.editing = { key, draft: item.translation };
              render();
            },
          },
          msg().sidepanel.edit,
        ),
      );
    }
    if (canRevert(item)) {
      buttons.push(
        h(
          "button",
          { type: "button", disabled: state.busy, onclick: () => void saveEdit(item, null) },
          msg().sidepanel.revert,
        ),
      );
    }
    if (canRetranslate(item)) {
      buttons.push(
        h(
          "button",
          { type: "button", disabled: state.busy, onclick: () => void retranslate(item) },
          msg().sidepanel.retranslate,
        ),
      );
    }
    return h("div", { class: "line-actions" }, ...buttons);
  };

  const editor = (item: TranscriptItem): HTMLElement => {
    const box = h("textarea", { rows: 3, "aria-label": msg().sidepanel.edit }, state.editing?.draft ?? "");
    box.addEventListener("input", () => {
      if (state.editing !== null) state.editing.draft = box.value;
    });
    queueMicrotask(() => box.focus());
    const stop = (): void => {
      state.editing = null;
      render();
      if (deferred) void refresh();
    };
    return h(
      "div",
      { class: "editor" },
      box,
      h(
        "div",
        { class: "line-actions" },
        h(
          "button",
          {
            type: "button",
            class: "primary",
            disabled: state.busy,
            onclick: () => {
              const translation = editPayload(item, box.value);
              if (translation === undefined) stop();
              else void saveEdit(item, translation);
            },
          },
          msg().sidepanel.save,
        ),
        h("button", { type: "button", onclick: stop }, msg().sidepanel.cancel),
      ),
    );
  };

  const lineNode = (item: TranscriptItem): HTMLElement => {
    const key = itemKey(item);
    const editing = state.editing?.key === key;
    const meta: Child[] = [h("span", { class: "type" }, msg().sidepanel.types[item.type])];
    if (item.speaker.trim() !== "") meta.push(h("span", { class: "speaker" }, item.speaker));
    meta.push(h("span", { class: `status status-${item.status}` }, msg().unitStatus[item.status]));
    if (item.flags.includes("inconsistent"))
      meta.push(h("span", { class: "flag" }, msg().sidepanel.inconsistent));
    return h(
      "li",
      { class: "line", "data-key": key },
      h("div", { class: "meta" }, ...meta),
      item.original.trim() === "" ? null : h("p", { class: "original" }, item.original),
      editing
        ? editor(item)
        : h(
            "p",
            { class: item.translation.trim() === "" ? "translation empty" : "translation" },
            item.translation.trim() === "" ? msg().sidepanel.noTranslation : item.translation,
          ),
      editing ? null : lineActions(item, key),
    );
  };

  const renderList = (): void => {
    if (state.view === "glossary") {
      glossary.render(view.list);
      return;
    }
    const groups = groupPages(state.transcript?.items ?? []);
    if (groups.length === 0) {
      replace(
        view.list,
        h(
          "div",
          { class: "empty" },
          h("p", null, msg().sidepanel.empty),
          h("p", { class: "muted" }, msg().sidepanel.emptyHint),
        ),
      );
      return;
    }
    replace(
      view.list,
      ...groups.map((group) =>
        h(
          "section",
          { class: "page" },
          h("h2", null, msg().sidepanel.page(group.pageOrder + 1)),
          h("ol", { class: "lines" }, ...group.items.map(lineNode)),
        ),
      ),
    );
  };

  function render(): void {
    renderTabs();
    renderToolbar();
    renderList();
  }

  const schedulePoll = (): void => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void connect();
    }, IDLE_POLL_MS);
  };

  async function refresh(): Promise<void> {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (state.editing !== null) {
      deferred = true;
      return;
    }
    deferred = false;
    const tabId = state.tabId;
    if (tabId === null) {
      state.transcript = null;
      render();
      return;
    }
    try {
      const transcript = await callEngineIfRunning("en:transcript", { tabId });
      if (state.tabId !== tabId) return;
      const before = seriesKey();
      state.transcript = transcript;
      if (state.view === "transcript") {
        render();
      } else if (seriesKey() !== before) {
        // The engine knows the series of the frame that holds the comic (it may be a reader iframe). Otherwise the
        // glossary view is left alone, so new lines streaming in never disturb a form being filled in.
        void glossary.load(seriesKey());
      }
    } catch (error) {
      fail("transcript", error);
    }
  }

  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
  };

  /** Watches the engine for the current tab, or polls until the engine runs. */
  async function connect(): Promise<void> {
    watch?.stop();
    watch = null;
    if (!(await engineRunning())) {
      state.transcript = null;
      render();
      schedulePoll();
      return;
    }
    const tabId = state.tabId;
    watch = watchEngine({
      view: "sidepanel",
      tabId,
      log,
      onStatus: () => {},
      onTranscript: (changed) => {
        if (changed === state.tabId) scheduleRefresh();
      },
      onGone: () => {
        watch = null;
        schedulePoll();
      },
    });
    await refresh();
  }

  async function follow(tabId: number | null): Promise<void> {
    if (tabId === state.tabId) return;
    state.tabId = tabId;
    state.editing = null;
    state.transcript = null;
    say(null);
    await updateTabSeries();
    await connect();
  }

  /** Reads the tab's series from its URL; the glossary view follows it. */
  async function updateTabSeries(): Promise<void> {
    const tabId = state.tabId;
    const key = tabId === null ? null : await tabSeriesKey(tabId);
    if (tabId !== state.tabId) return;
    state.tabSeries = key;
    if (state.view === "glossary") void glossary.load(seriesKey());
  }

  async function run(what: string, action: () => Promise<void>): Promise<void> {
    if (state.busy) return;
    state.busy = true;
    say(null);
    render();
    try {
      await action();
    } catch (error) {
      fail(what, error);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function saveEdit(item: TranscriptItem, translation: string | null): Promise<void> {
    await run("edit", async () => {
      await callEngineEnsured("en:edit-unit", {
        contentKey: item.contentKey,
        unitKey: item.unitKey,
        translation,
      });
      state.editing = null;
      await refresh();
    });
  }

  async function retranslate(item: TranscriptItem): Promise<void> {
    const tabId = state.tabId;
    if (tabId === null) return;
    await run("retranslate", async () => {
      await callEngineEnsured("en:retranslate", {
        tabId,
        contentKey: item.contentKey,
        unitKey: item.unitKey,
      });
      await refresh();
    });
  }

  async function jump(item: TranscriptItem): Promise<void> {
    const tabId = state.tabId;
    if (tabId === null) return;
    try {
      const result = await callEngineIfRunning("en:jump-to", {
        tabId,
        contentKey: item.contentKey,
        unitKey: item.unitKey,
      });
      say(result?.found === true ? null : msg().sidepanel.notFound);
    } catch (error) {
      fail("jump", error);
    }
  }

  async function copyAll(): Promise<void> {
    const text = transcriptText(groupPages(state.transcript?.items ?? []), msg().sidepanel.page);
    try {
      await navigator.clipboard.writeText(text);
      say(msg().sidepanel.copied);
    } catch (error) {
      fail("copy", error);
    }
  }

  // ui/sidepanel.html?tabId=<id> pins the panel to one tab (opened as a normal page for tests and debugging).
  const pinned = Number.parseInt(new URLSearchParams(location.search).get("tabId") ?? "", 10);
  state.windowId = (await chrome.windows.getCurrent()).id ?? null;
  chrome.tabs.onActivated.addListener((info) => {
    if (Number.isInteger(pinned)) return;
    if (state.windowId === null || info.windowId === state.windowId) void follow(info.tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId !== state.tabId) return;
    // A navigation drops the old page's lines; the new page's lines arrive as tx:delta.
    if (change.status === "loading" && change.url !== undefined) {
      state.transcript = null;
      state.editing = null;
      render();
    }
    if (change.status === "complete") {
      void updateTabSeries();
      void connect();
    }
  });

  render();
  await follow(Number.isInteger(pinned) ? pinned : await activeTabId(state.windowId));
}

main().catch((error: unknown) => {
  log.error("side panel failed to start", { error: errorMessage(error) });
});
