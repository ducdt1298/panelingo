// In-memory fake of the chrome.* extension APIs this extension uses, for node:test (docs/TESTING.md).
//
// One FakeBrowser simulates Chrome running one extension. Every extension context (service worker, offscreen
// engine, popup / side panel / options / debug page) and every content-script frame gets its OWN `chrome`
// namespace; storage, DNR rules, registered scripts, menus, badges and the offscreen document are shared:
//   - runtime.sendMessage from an extension context reaches the OTHER extension contexts (never content scripts);
//     from a content script it reaches every extension context. tabs.sendMessage reaches content scripts only.
//   - runtime.connect reaches the extension contexts that listen to onConnect; messages posted before the
//     connection is established are queued like in Chrome.
//   - Delivery is asynchronous (setImmediate, FIFO) and payloads are cloned: structured clone by default, JSON when
//     the browser is created with serialization "json". With strictWire (default) payloads that are not wire-safe
//     (shared/wire.ts isWireSafe) throw "Could not serialize message." so tests catch them.
//   - Exact Chrome error strings (CHROME_ERRORS) so production error mapping is exercised.
//
// Global `chrome`: browser.install() points globalThis.chrome at a proxy that resolves to the namespace of the
// CURRENT context, tracked with AsyncLocalStorage. Code started inside browser.run(ctx, fn) (including its awaits,
// timers and promise chains) and listeners dispatched into ctx all see ctx's namespace. Import a module that
// registers listeners at top level inside browser.run(ctx, () => import(...)).
//
// Fault injection: browser.failNext("declarativeNetRequest.updateSessionRules", "boom") makes the next call reject.
// Time: captureVisibleTab quota and alarms use options.now (default Date.now). windows.get/getLastFocused report
// browser.lastFocusedWindow as focused and browser.windowStates (default "normal").

import { AsyncLocalStorage } from "node:async_hooks";
import { isWireSafe } from "../../src/shared/wire.ts";

export const FAKE_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

export const CHROME_ERRORS = {
  noReceiver: "Could not establish connection. Receiving end does not exist.",
  portClosed: "The message port closed before a response was received.",
  asyncClosed:
    "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
  invalidated: "Extension context invalidated.",
  disconnectedPort: "Attempting to use a disconnected port object",
  serialize: "Could not serialize message.",
  singleOffscreen: "Only a single offscreen document may be created.",
  noOffscreen: "No current offscreen document.",
  captureQuota: "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.",
  sidePanelGesture: "`sidePanel.open()` may only be called in response to a user gesture.",
  storageAccess: "Access to storage is not allowed from this context.",
} as const;

/* ---------------------------------------------------------------- enums (values equal Chrome's) */

export const ENUMS = {
  runtime: {
    ContextType: {
      TAB: "TAB",
      POPUP: "POPUP",
      BACKGROUND: "BACKGROUND",
      OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT",
      SIDE_PANEL: "SIDE_PANEL",
      DEVELOPER_TOOLS: "DEVELOPER_TOOLS",
    },
    OnInstalledReason: {
      INSTALL: "install",
      UPDATE: "update",
      CHROME_UPDATE: "chrome_update",
      SHARED_MODULE_UPDATE: "shared_module_update",
    },
  },
  offscreen: {
    Reason: {
      TESTING: "TESTING",
      AUDIO_PLAYBACK: "AUDIO_PLAYBACK",
      IFRAME_SCRIPTING: "IFRAME_SCRIPTING",
      DOM_SCRAPING: "DOM_SCRAPING",
      BLOBS: "BLOBS",
      DOM_PARSER: "DOM_PARSER",
      USER_MEDIA: "USER_MEDIA",
      DISPLAY_MEDIA: "DISPLAY_MEDIA",
      WEB_RTC: "WEB_RTC",
      CLIPBOARD: "CLIPBOARD",
      LOCAL_STORAGE: "LOCAL_STORAGE",
      WORKERS: "WORKERS",
      BATTERY_STATUS: "BATTERY_STATUS",
      MATCH_MEDIA: "MATCH_MEDIA",
      GEOLOCATION: "GEOLOCATION",
    },
  },
  scripting: { ExecutionWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" } },
  storage: {
    AccessLevel: {
      TRUSTED_CONTEXTS: "TRUSTED_CONTEXTS",
      TRUSTED_AND_UNTRUSTED_CONTEXTS: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
    },
  },
  contextMenus: {
    ContextType: {
      ALL: "all",
      PAGE: "page",
      FRAME: "frame",
      SELECTION: "selection",
      LINK: "link",
      EDITABLE: "editable",
      IMAGE: "image",
      VIDEO: "video",
      AUDIO: "audio",
      ACTION: "action",
    },
  },
  declarativeNetRequest: {
    RuleActionType: {
      BLOCK: "block",
      REDIRECT: "redirect",
      ALLOW: "allow",
      UPGRADE_SCHEME: "upgradeScheme",
      MODIFY_HEADERS: "modifyHeaders",
      ALLOW_ALL_REQUESTS: "allowAllRequests",
    },
    HeaderOperation: { APPEND: "append", SET: "set", REMOVE: "remove" },
    ResourceType: {
      MAIN_FRAME: "main_frame",
      SUB_FRAME: "sub_frame",
      STYLESHEET: "stylesheet",
      SCRIPT: "script",
      IMAGE: "image",
      FONT: "font",
      OBJECT: "object",
      XMLHTTPREQUEST: "xmlhttprequest",
      PING: "ping",
      CSP_REPORT: "csp_report",
      MEDIA: "media",
      WEBSOCKET: "websocket",
      WEBTRANSPORT: "webtransport",
      WEBBUNDLE: "webbundle",
      OTHER: "other",
    },
    DomainType: { FIRST_PARTY: "firstParty", THIRD_PARTY: "thirdParty" },
    RequestMethod: {
      CONNECT: "connect",
      DELETE: "delete",
      GET: "get",
      HEAD: "head",
      OPTIONS: "options",
      PATCH: "patch",
      POST: "post",
      PUT: "put",
      OTHER: "other",
    },
    UnsupportedRegexReason: { SYNTAX_ERROR: "syntaxError", MEMORY_LIMIT_EXCEEDED: "memoryLimitExceeded" },
  },
} as const;

/* ---------------------------------------------------------------- events */

type Listener<A extends unknown[]> = (...args: A) => unknown;
type AnyFunction = (...args: never[]) => unknown;

/** chrome.events.Event look-alike. dispatch() calls listeners synchronously and returns their results. */
export class FakeEvent<A extends unknown[]> {
  readonly #listeners: Array<Listener<A>> = [];
  readonly #report: (error: unknown) => void;

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  addListener(listener: Listener<A>): void {
    if (!this.#listeners.includes(listener)) this.#listeners.push(listener);
  }

  removeListener(listener: Listener<A>): void {
    const index = this.#listeners.indexOf(listener);
    if (index >= 0) this.#listeners.splice(index, 1);
  }

  hasListener(listener: Listener<A>): boolean {
    return this.#listeners.includes(listener);
  }

  hasListeners(): boolean {
    return this.#listeners.length > 0;
  }

  get size(): number {
    return this.#listeners.length;
  }

  /** A throwing listener is recorded in browser.listenerErrors (Chrome logs it) and the others still run. */
  dispatch(...args: A): unknown[] {
    const results: unknown[] = [];
    for (const listener of [...this.#listeners]) {
      try {
        results.push(listener(...args));
      } catch (error) {
        this.#report(error);
        results.push(undefined);
      }
    }
    return results;
  }
}

/* ---------------------------------------------------------------- ports */

interface Wire {
  readonly data: unknown;
}

export class FakePort {
  readonly name: string;
  /** Set on the receiving side only (like Chrome). */
  readonly sender: chrome.runtime.MessageSender | undefined;
  readonly onMessage: FakeEvent<[unknown, FakePort]>;
  readonly onDisconnect: FakeEvent<[FakePort]>;
  readonly ctx: FakeContext;
  readonly #browser: FakeBrowser;
  readonly #peers = new Set<FakePort>();
  #connected = true;
  #connecting: Wire[] | null;

  constructor(
    browser: FakeBrowser,
    ctx: FakeContext,
    name: string,
    sender: chrome.runtime.MessageSender | undefined,
    connecting: boolean,
  ) {
    this.#browser = browser;
    this.ctx = ctx;
    this.name = name;
    this.sender = sender;
    this.onMessage = new FakeEvent(browser.reportListenerError);
    this.onDisconnect = new FakeEvent(browser.reportListenerError);
    this.#connecting = connecting ? [] : null;
    ctx.ports.add(this);
  }

  get connected(): boolean {
    return this.#connected;
  }

  get peerCount(): number {
    return this.#peers.size;
  }

  postMessage(message: unknown): void {
    if (this.ctx.invalidated) throw new Error(CHROME_ERRORS.invalidated);
    if (!this.#connected) throw new Error(CHROME_ERRORS.disconnectedPort);
    const wire = this.#browser.serialize(message);
    this.#browser.stats.portMessages += 1;
    if (this.#connecting !== null) {
      this.#connecting.push(wire);
      return;
    }
    for (const peer of this.#peers) this.#sendTo(peer, wire);
  }

  disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#connecting = null;
    this.#releasePeers();
  }

  /** @internal Connection established: link the peer and flush messages queued while connecting. */
  link(peer: FakePort): void {
    this.#peers.add(peer);
  }

  /** @internal */
  established(): void {
    const queued = this.#connecting ?? [];
    this.#connecting = null;
    for (const wire of queued) for (const peer of this.#peers) this.#sendTo(peer, wire);
  }

  /** @internal The other end went away (or never existed): fires onDisconnect in this port's context. */
  closeFromRemote(lastError: string | null): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#connecting = null;
    for (const peer of this.#peers) peer.#peers.delete(this);
    this.#peers.clear();
    this.ctx.ports.delete(this);
    this.#browser.withLastError(lastError, () => this.onDisconnect.dispatch(this));
  }

  /** @internal Context died: no event here, peers get onDisconnect. */
  die(): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#connecting = null;
    this.#releasePeers();
  }

  #releasePeers(): void {
    for (const peer of this.#peers) {
      peer.#peers.delete(this);
      if (peer.#peers.size === 0) this.#browser.deliver(peer.ctx, () => peer.closeFromRemote(null));
    }
    this.#peers.clear();
    this.ctx.ports.delete(this);
  }

  #sendTo(peer: FakePort, wire: Wire): void {
    this.#browser.deliver(peer.ctx, () => {
      if (peer.#connected) peer.onMessage.dispatch(this.#browser.deserialize(wire), peer);
    });
  }
}

/* ---------------------------------------------------------------- contexts */

export type ContextKind = "sw" | "offscreen" | "popup" | "sidepanel" | "options" | "debug" | "content";

export interface FakeFrame {
  frameId: number;
  parentFrameId: number;
  url: string;
  documentId: string;
}

export interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  frames: FakeFrame[];
}

type InstalledDetails = { reason: string; previousVersion?: string };

/** One JS realm with its own `chrome` namespace and listeners. */
export class FakeContext {
  readonly kind: ContextKind;
  readonly contextId: string;
  readonly documentId: string;
  readonly url: string;
  /** -1 for extension contexts. */
  readonly tabId: number;
  /** -1 for the service worker, 0 for extension documents, the frame id for content scripts. */
  readonly frameId: number;
  readonly ports = new Set<FakePort>();
  /** Async message channels this context promised to answer (rejected if it dies first). */
  readonly pendingReplies = new Set<() => void>();
  alive = true;
  /** Content scripts of a reloaded/removed extension: chrome.runtime calls throw, runtime.id is undefined. */
  invalidated = false;

  readonly onMessage: FakeEvent<[unknown, chrome.runtime.MessageSender, (response?: unknown) => void]>;
  readonly onConnect: FakeEvent<[FakePort]>;
  readonly onInstalled: FakeEvent<[InstalledDetails]>;
  readonly onStartup: FakeEvent<[]>;
  readonly onSuspend: FakeEvent<[]>;
  readonly tabsOnRemoved: FakeEvent<[number, { windowId: number; isWindowClosing: boolean }]>;
  readonly tabsOnUpdated: FakeEvent<[number, Record<string, unknown>, chrome.tabs.Tab]>;
  readonly tabsOnActivated: FakeEvent<[{ tabId: number; windowId: number }]>;
  readonly storageOnChanged: FakeEvent<[Record<string, chrome.storage.StorageChange>, string]>;
  readonly areaOnChanged: Record<AreaName, FakeEvent<[Record<string, chrome.storage.StorageChange>]>>;
  readonly menusOnClicked: FakeEvent<[Record<string, unknown>, chrome.tabs.Tab | undefined]>;
  readonly commandsOnCommand: FakeEvent<[string, chrome.tabs.Tab | undefined]>;
  readonly actionOnClicked: FakeEvent<[chrome.tabs.Tab]>;
  readonly alarmsOnAlarm: FakeEvent<[FakeAlarm]>;
  readonly chrome: FakeChrome;
  readonly #browser: FakeBrowser;

  constructor(browser: FakeBrowser, kind: ContextKind, url: string, tabId: number, frameId: number) {
    this.#browser = browser;
    this.kind = kind;
    this.url = url;
    this.tabId = tabId;
    this.frameId = frameId;
    this.contextId = browser.nextId("ctx");
    this.documentId = browser.nextId("doc").toUpperCase();
    const report = browser.reportListenerError;
    this.onMessage = new FakeEvent(report);
    this.onConnect = new FakeEvent(report);
    this.onInstalled = new FakeEvent(report);
    this.onStartup = new FakeEvent(report);
    this.onSuspend = new FakeEvent(report);
    this.tabsOnRemoved = new FakeEvent(report);
    this.tabsOnUpdated = new FakeEvent(report);
    this.tabsOnActivated = new FakeEvent(report);
    this.storageOnChanged = new FakeEvent(report);
    this.areaOnChanged = {
      local: new FakeEvent(report),
      session: new FakeEvent(report),
      sync: new FakeEvent(report),
    };
    this.menusOnClicked = new FakeEvent(report);
    this.commandsOnCommand = new FakeEvent(report);
    this.actionOnClicked = new FakeEvent(report);
    this.alarmsOnAlarm = new FakeEvent(report);
    this.chrome = kind === "content" ? contentNamespace(browser, this) : extensionNamespace(browser, this);
  }

  get isExtension(): boolean {
    return this.kind !== "content";
  }

  /** The full namespace of an extension context (throws for content scripts). */
  get ext(): ExtensionChrome {
    if (this.kind === "content") throw new Error("fake chrome: content scripts have no extension-only APIs");
    return this.chrome as ExtensionChrome;
  }

  /** The context goes away (SW stopped, document closed, frame navigated): its ports disconnect their peers. */
  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const port of [...this.ports]) port.die();
    for (const abort of [...this.pendingReplies]) abort();
    this.pendingReplies.clear();
    this.#browser.forgetContext(this);
  }

  /** Runs fn with this context as the current `chrome` (see FakeBrowser.run). */
  run<T>(fn: () => T): T {
    return this.#browser.run(this, fn);
  }
}

/* ---------------------------------------------------------------- storage */

type AreaName = "local" | "session" | "sync";

class StorageStore {
  readonly data = new Map<string, string>();
  accessLevel: string = ENUMS.storage.AccessLevel.TRUSTED_CONTEXTS;
}

function toJson(value: unknown): string | undefined {
  // JSON.stringify returns undefined for undefined, functions and symbols despite its declared type.
  const text: string | undefined = JSON.stringify(value);
  return text;
}

function fromJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/* ---------------------------------------------------------------- misc shared state */

export interface FakeAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

export interface ExecuteScriptCall {
  tabId: number;
  frameIds: number[];
  files: string[];
  world: string;
  hasFunc: boolean;
}

export interface FakeBrowserOptions {
  /** "json" simulates a browser without message_serialization structured_clone (ArrayBuffer -> {}). */
  serialization?: "structured_clone" | "json";
  /** Reject payloads that are not wire-safe (default true). */
  strictWire?: boolean;
  /** When listeners exist but none answers: Chrome rejects with "message port closed" (default "reject"). */
  unansweredMessage?: "reject" | "undefined";
  manifest?: Record<string, unknown>;
  commands?: chrome.commands.Command[];
  /** Delay before createDocument creates the context (tests single-flight ensureEngine). */
  offscreenCreateDelayMs?: number;
  /** Boots engine code in the new offscreen context; createDocument resolves after it settles. */
  onOffscreenCreated?: (ctx: FakeContext) => void | Promise<void>;
  /** Boots a service worker context (startServiceWorker / restartServiceWorker). */
  onServiceWorkerStart?: (ctx: FakeContext) => void | Promise<void>;
  /** executeScript with files: boots the content script in the new frame context. */
  onContentInjected?: (ctx: FakeContext, files: readonly string[]) => void | Promise<void>;
  /** executeScript with func: default calls func(...args) in Node. */
  onExecuteFunc?: (frame: { tabId: number; frameId: number }, func: AnyFunction, args: unknown[]) => unknown;
  /** captureVisibleTab result (data URL). */
  captureVisibleTab?: (windowId: number) => string;
  now?: () => number;
}

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* ---------------------------------------------------------------- the browser */

export class FakeBrowser {
  readonly extensionId = FAKE_EXTENSION_ID;
  readonly options: FakeBrowserOptions;
  readonly contexts: FakeContext[] = [];
  readonly tabs = new Map<number, FakeTab>();
  readonly listenerErrors: unknown[] = [];
  readonly stats = { runtimeMessages: 0, tabMessages: 0, portMessages: 0 };
  /** Log of API calls worth asserting on (e.g. "offscreen.createDocument"). */
  readonly calls: string[] = [];
  readonly storage: Record<AreaName, StorageStore> = {
    local: new StorageStore(),
    session: new StorageStore(),
    sync: new StorageStore(),
  };
  sessionRules: chrome.declarativeNetRequest.Rule[] = [];
  dynamicRules: chrome.declarativeNetRequest.Rule[] = [];
  readonly registeredScripts = new Map<string, chrome.scripting.RegisteredContentScript>();
  readonly executeScriptCalls: ExecuteScriptCall[] = [];
  readonly menus = new Map<string, Record<string, unknown>>();
  readonly badges = new Map<string, { text: string; color: string; title: string }>();
  readonly sidePanel = {
    opened: [] as Array<{ tabId?: number; windowId?: number }>,
    options: new Map<string, Record<string, unknown>>(),
    behavior: { openPanelOnActionClick: false },
  };
  readonly alarms = new Map<string, FakeAlarm>();
  readonly captureTimes: number[] = [];
  /** windows.getLastFocused(): the window the user looks at (captureVisibleTab checks). */
  lastFocusedWindow = 1;
  /** windows.get(id).state; "normal" when unset. */
  readonly windowStates = new Map<number, "normal" | "minimized" | "maximized" | "fullscreen">();
  readonly permissions = { granted: true };
  offscreen: FakeContext | null = null;
  #offscreenCreating = false;
  serviceWorker: FakeContext | null = null;
  #lastError: { message: string } | undefined;
  #userGesture = false;
  #pending = 0;
  #seq = 0;
  #nextTabId = 1;
  readonly #als = new AsyncLocalStorage<FakeContext>();
  readonly #faults = new Map<string, Array<string | Error>>();
  readonly #restore: Array<() => void> = [];

  constructor(options: FakeBrowserOptions = {}) {
    this.options = options;
  }

  readonly reportListenerError = (error: unknown): void => {
    this.listenerErrors.push(error);
  };

  get serialization(): "structured_clone" | "json" {
    return this.options.serialization ?? "structured_clone";
  }

  now(): number {
    return (this.options.now ?? Date.now)();
  }

  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}${this.#seq.toString(16).padStart(6, "0")}`;
  }

  url(path: string): string {
    return `chrome-extension://${this.extensionId}/${path.replace(/^\//, "")}`;
  }

  get lastError(): { message: string } | undefined {
    return this.#lastError;
  }

  get userGesture(): boolean {
    return this.#userGesture;
  }

  /* ---- global chrome ---- */

  /** Points globalThis.chrome at the current-context proxy. Returns a restore function (also run by uninstall). */
  install(): () => void {
    const holder = globalThis as { chrome?: unknown };
    const previous = holder.chrome;
    const resolve = (): FakeChrome => this.current().chrome;
    holder.chrome = new Proxy(
      {},
      {
        get: (_target, key) => Reflect.get(resolve(), key) as unknown,
        has: (_target, key) => Reflect.has(resolve(), key),
        ownKeys: () => Reflect.ownKeys(resolve()),
        getOwnPropertyDescriptor: (_target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), key);
          return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
        },
      },
    );
    const restore = (): void => {
      holder.chrome = previous;
    };
    this.#restore.push(restore);
    return restore;
  }

  uninstall(): void {
    for (const restore of this.#restore.splice(0).reverse()) restore();
  }

  #defaultContext: FakeContext | null = null;

  /** Context used by the global proxy outside run()/dispatch (e.g. top-level test code). */
  setDefaultContext(ctx: FakeContext | null): void {
    this.#defaultContext = ctx;
  }

  current(): FakeContext {
    const ctx = this.#als.getStore() ?? this.#defaultContext;
    if (ctx === null) {
      throw new Error("fake chrome: no current context (use browser.run(ctx, fn) or setDefaultContext)");
    }
    return ctx;
  }

  run<T>(ctx: FakeContext, fn: () => T): T {
    return this.#als.run(ctx, fn);
  }

  /* ---- contexts ---- */

  #addContext(kind: ContextKind, url: string, tabId = -1, frameId = kind === "sw" ? -1 : 0): FakeContext {
    const ctx = new FakeContext(this, kind, url, tabId, frameId);
    this.contexts.push(ctx);
    return ctx;
  }

  /** @internal */
  forgetContext(ctx: FakeContext): void {
    const index = this.contexts.indexOf(ctx);
    if (index >= 0) this.contexts.splice(index, 1);
    if (this.offscreen === ctx) this.offscreen = null;
    if (this.serviceWorker === ctx) this.serviceWorker = null;
    if (this.#defaultContext === ctx) this.#defaultContext = null;
  }

  async startServiceWorker(): Promise<FakeContext> {
    if (this.serviceWorker !== null) return this.serviceWorker;
    const ctx = this.#addContext("sw", this.url("sw.js"));
    this.serviceWorker = ctx;
    if (this.options.onServiceWorkerStart !== undefined) {
      const hook = this.options.onServiceWorkerStart;
      await this.run(ctx, () => hook(ctx));
    }
    return ctx;
  }

  /** The worker is stopped (idle timeout, crash) and a new one starts; module state of real code is NOT reset. */
  async restartServiceWorker(): Promise<FakeContext> {
    this.serviceWorker?.destroy();
    return this.startServiceWorker();
  }

  openExtensionPage(kind: "popup" | "sidepanel" | "options" | "debug", path: string): FakeContext {
    return this.#addContext(kind, this.url(path));
  }

  /** Reload/remove the extension: extension contexts die, content scripts become orphans. */
  invalidateExtension(): void {
    for (const ctx of [...this.contexts]) if (ctx.isExtension) ctx.destroy();
    for (const ctx of this.contexts) ctx.invalidated = true;
  }

  /* ---- tabs and frames ---- */

  openTab(url: string, options: { active?: boolean; windowId?: number; title?: string } = {}): FakeTab {
    const id = this.#nextTabId;
    this.#nextTabId += 1;
    const tab: FakeTab = {
      id,
      windowId: options.windowId ?? 1,
      url,
      title: options.title ?? url,
      active: options.active ?? true,
      frames: [{ frameId: 0, parentFrameId: -1, url, documentId: this.nextId("doc").toUpperCase() }],
    };
    if (tab.active)
      for (const other of this.tabs.values()) if (other.windowId === tab.windowId) other.active = false;
    this.tabs.set(id, tab);
    return tab;
  }

  addFrame(tabId: number, url: string, parentFrameId = 0): FakeFrame {
    const tab = this.#tab(tabId);
    const frameId = Math.max(...tab.frames.map((f) => f.frameId)) + 1;
    const frame: FakeFrame = { frameId, parentFrameId, url, documentId: this.nextId("doc").toUpperCase() };
    tab.frames.push(frame);
    return frame;
  }

  /** Creates a content-script context in tab/frame (what executeScript or a registered script would do). */
  injectContent(tabId: number, frameId = 0): FakeContext {
    const tab = this.#tab(tabId);
    const frame = tab.frames.find((f) => f.frameId === frameId);
    if (frame === undefined) throw new Error(`fake chrome: no frame ${frameId} in tab ${tabId}`);
    return this.#addContext("content", frame.url, tabId, frameId);
  }

  contentContexts(tabId: number, frameId?: number): FakeContext[] {
    return this.contexts.filter(
      (c) => c.kind === "content" && c.tabId === tabId && (frameId === undefined || c.frameId === frameId),
    );
  }

  /** Navigates a frame: its content contexts die, the document id changes, tabs.onUpdated fires for the top frame. */
  navigate(tabId: number, url: string, frameId = 0): void {
    const tab = this.#tab(tabId);
    const doomed = new Set<number>([frameId]);
    if (frameId === 0) for (const frame of tab.frames) doomed.add(frame.frameId);
    for (const ctx of this.contentContexts(tabId)) if (doomed.has(ctx.frameId)) ctx.destroy();
    if (frameId === 0) {
      tab.frames = [{ frameId: 0, parentFrameId: -1, url, documentId: this.nextId("doc").toUpperCase() }];
      tab.url = url;
      const info = this.tabInfo(tab);
      this.#broadcast((ctx) => ctx.tabsOnUpdated.dispatch(tabId, { status: "complete", url }, info));
    } else {
      const frame = tab.frames.find((f) => f.frameId === frameId);
      if (frame !== undefined) {
        frame.url = url;
        frame.documentId = this.nextId("doc").toUpperCase();
      }
    }
  }

  closeTab(tabId: number): void {
    const tab = this.#tab(tabId);
    for (const ctx of this.contentContexts(tabId)) ctx.destroy();
    this.tabs.delete(tabId);
    this.#broadcast((ctx) =>
      ctx.tabsOnRemoved.dispatch(tabId, { windowId: tab.windowId, isWindowClosing: false }),
    );
  }

  activateTab(tabId: number): void {
    const tab = this.#tab(tabId);
    for (const other of this.tabs.values())
      if (other.windowId === tab.windowId) other.active = other.id === tabId;
    this.#broadcast((ctx) => ctx.tabsOnActivated.dispatch({ tabId, windowId: tab.windowId }));
  }

  windowInfo(windowId: number): chrome.windows.Window {
    return {
      id: windowId,
      focused: windowId === this.lastFocusedWindow,
      state: this.windowStates.get(windowId) ?? "normal",
      type: "normal",
      alwaysOnTop: false,
      incognito: false,
    };
  }

  tabInfo(tab: FakeTab): chrome.tabs.Tab {
    return {
      id: tab.id,
      index: tab.id - 1,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      highlighted: tab.active,
      pinned: false,
      incognito: false,
      selected: tab.active,
      discarded: false,
      autoDiscardable: true,
      frozen: false,
      groupId: -1,
      status: "complete",
    } as chrome.tabs.Tab;
  }

  #tab(tabId: number): FakeTab {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  }

  /* ---- user-triggered events (dispatched in the service worker with a user gesture) ---- */

  fireInstalled(reason: string = ENUMS.runtime.OnInstalledReason.INSTALL, previousVersion?: string): void {
    const details: InstalledDetails =
      previousVersion === undefined ? { reason } : { reason, previousVersion };
    this.#toServiceWorker((ctx) => ctx.onInstalled.dispatch(details));
  }

  fireStartup(): void {
    this.#toServiceWorker((ctx) => ctx.onStartup.dispatch());
  }

  fireCommand(command: string, tabId?: number): void {
    const tab = tabId === undefined ? undefined : this.tabInfo(this.#tab(tabId));
    this.#withGesture(() => this.#toServiceWorker((ctx) => ctx.commandsOnCommand.dispatch(command, tab)));
  }

  clickMenu(info: Record<string, unknown>, tabId?: number): void {
    const tab = tabId === undefined ? undefined : this.tabInfo(this.#tab(tabId));
    this.#withGesture(() => this.#toServiceWorker((ctx) => ctx.menusOnClicked.dispatch(info, tab)));
  }

  clickAction(tabId: number): void {
    const tab = this.tabInfo(this.#tab(tabId));
    this.#withGesture(() => this.#toServiceWorker((ctx) => ctx.actionOnClicked.dispatch(tab)));
  }

  fireAlarm(name: string): void {
    const alarm = this.alarms.get(name);
    if (alarm === undefined) throw new Error(`fake chrome: no alarm ${name}`);
    if (alarm.periodInMinutes === undefined) this.alarms.delete(name);
    else alarm.scheduledTime = this.now() + alarm.periodInMinutes * 60_000;
    this.#toServiceWorker((ctx) => ctx.alarmsOnAlarm.dispatch({ ...alarm }));
  }

  #withGesture(fn: () => void): void {
    this.#userGesture = true;
    try {
      fn();
    } finally {
      this.#userGesture = false;
    }
  }

  #toServiceWorker(fn: (ctx: FakeContext) => void): void {
    const sw = this.serviceWorker;
    if (sw === null) throw new Error("fake chrome: no service worker (call startServiceWorker first)");
    this.run(sw, () => fn(sw));
  }

  #broadcast(fn: (ctx: FakeContext) => void): void {
    for (const ctx of [...this.contexts]) if (ctx.isExtension && ctx.alive) this.deliver(ctx, () => fn(ctx));
  }

  /* ---- delivery ---- */

  /** @internal Runs fn in ctx on a later macrotask, unless ctx died meanwhile. */
  deliver(ctx: FakeContext, fn: () => void): void {
    this.#pending += 1;
    setImmediate(() => {
      this.#pending -= 1;
      if (ctx.alive) this.run(ctx, fn);
    });
  }

  #later(fn: () => void): void {
    this.#pending += 1;
    setImmediate(() => {
      this.#pending -= 1;
      fn();
    });
  }

  /** Resolves once no delivery is pending for two consecutive turns (code under test may keep scheduling). */
  async settle(maxTurns = 2000): Promise<void> {
    let quiet = 0;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      quiet = this.#pending === 0 ? quiet + 1 : 0;
      if (quiet >= 2) return;
    }
    throw new Error("fake chrome: deliveries did not settle");
  }

  /** @internal */
  withLastError(message: string | null, fn: () => void): void {
    const previous = this.#lastError;
    this.#lastError = message === null ? undefined : { message };
    try {
      fn();
    } finally {
      this.#lastError = previous;
    }
  }

  /** @internal Clones like Chrome's message serialization; throws "Could not serialize message.". */
  serialize(message: unknown): Wire {
    if (this.options.strictWire !== false) {
      const check = isWireSafe(message);
      if (!check.ok) throw new Error(`${CHROME_ERRORS.serialize} (${check.path}: ${check.why})`);
    }
    if (this.serialization === "json") return { data: toJson(message) };
    try {
      return { data: structuredClone(message) };
    } catch {
      throw new Error(CHROME_ERRORS.serialize);
    }
  }

  /** @internal */
  deserialize(wire: Wire): unknown {
    if (this.serialization === "json") return typeof wire.data === "string" ? fromJson(wire.data) : undefined;
    return structuredClone(wire.data);
  }

  /* ---- faults ---- */

  /** The next `times` calls of `api` (e.g. "storage.local.set") reject with `error`. */
  failNext(api: string, error: string | Error, times = 1): void {
    const queue = this.#faults.get(api) ?? [];
    for (let i = 0; i < times; i += 1) queue.push(error);
    this.#faults.set(api, queue);
  }

  /** @internal Every async API passes through here: records the call, applies faults, yields a turn (IPC). */
  async gate(api: string): Promise<void> {
    this.calls.push(api);
    const fault = this.#faults.get(api)?.shift();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (fault !== undefined) throw typeof fault === "string" ? new Error(fault) : fault;
  }

  /* ---- messaging ---- */

  senderOf(ctx: FakeContext): chrome.runtime.MessageSender {
    if (ctx.kind === "content") {
      const tab = this.tabs.get(ctx.tabId);
      return {
        id: this.extensionId,
        url: ctx.url,
        origin: new URL(ctx.url).origin,
        frameId: ctx.frameId,
        documentId: ctx.documentId,
        documentLifecycle: "active",
        ...(tab === undefined ? {} : { tab: this.tabInfo(tab) }),
      };
    }
    const sender: chrome.runtime.MessageSender = {
      id: this.extensionId,
      url: ctx.url,
      origin: `chrome-extension://${this.extensionId}`,
    };
    if (ctx.kind !== "sw") {
      sender.documentId = ctx.documentId;
      sender.frameId = 0;
    }
    return sender;
  }

  /** @internal */
  sendRuntimeMessage(from: FakeContext, message: unknown): Promise<unknown> {
    if (from.invalidated || !from.alive) throw new Error(CHROME_ERRORS.invalidated);
    const wire = this.serialize(message);
    this.stats.runtimeMessages += 1;
    const targets = (): FakeContext[] =>
      this.contexts.filter((c) => c.alive && c !== from && c.isExtension && c.onMessage.hasListeners());
    return this.#gateThen("runtime.sendMessage", () => this.#dispatchMessage(from, targets(), wire));
  }

  /** @internal */
  sendTabMessage(
    from: FakeContext,
    tabId: number,
    message: unknown,
    options: { frameId?: number; documentId?: string } = {},
  ): Promise<unknown> {
    const wire = this.serialize(message);
    this.stats.tabMessages += 1;
    return this.#gateThen("tabs.sendMessage", () => {
      if (!this.tabs.has(tabId)) return Promise.reject(new Error(`No tab with id: ${tabId}.`));
      const targets = this.contexts.filter(
        (c) =>
          c.alive &&
          !c.invalidated &&
          c.kind === "content" &&
          c.tabId === tabId &&
          (options.frameId === undefined || c.frameId === options.frameId) &&
          (options.documentId === undefined || c.documentId === options.documentId) &&
          c.onMessage.hasListeners(),
      );
      return this.#dispatchMessage(from, targets, wire);
    });
  }

  #gateThen<T>(api: string, fn: () => Promise<T>): Promise<T> {
    return this.gate(api).then(fn);
  }

  #dispatchMessage(from: FakeContext, targets: FakeContext[], wire: Wire): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (targets.length === 0) {
        reject(new Error(CHROME_ERRORS.noReceiver));
        return;
      }
      let settled = false;
      let waiting = 0;
      const respond = (response?: unknown): void => {
        if (settled) return;
        settled = true;
        let reply: Wire;
        try {
          reply = this.serialize(response);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.#later(() => resolve(this.deserialize(reply)));
      };
      const sender = this.senderOf(from);
      for (const target of targets) {
        const results = this.run(target, () =>
          target.onMessage.dispatch(this.deserialize(wire), sender, respond),
        );
        if (results.some((result) => result === true)) {
          waiting += 1;
          const abort = (): void => {
            if (settled) return;
            settled = true;
            reject(new Error(CHROME_ERRORS.asyncClosed));
          };
          target.pendingReplies.add(abort);
        }
      }
      if (!settled && waiting === 0) {
        settled = true;
        if (this.options.unansweredMessage === "undefined") this.#later(() => resolve(undefined));
        else this.#later(() => reject(new Error(CHROME_ERRORS.portClosed)));
      }
    });
  }

  /** @internal */
  connect(from: FakeContext, name: string): FakePort {
    if (from.invalidated || !from.alive) throw new Error(CHROME_ERRORS.invalidated);
    const opener = new FakePort(this, from, name, undefined, true);
    this.deliver(from, () => {
      const receivers = this.contexts.filter(
        (c) => c.alive && c !== from && c.isExtension && c.onConnect.hasListeners(),
      );
      if (receivers.length === 0) {
        opener.closeFromRemote(CHROME_ERRORS.noReceiver);
        return;
      }
      const sender = this.senderOf(from);
      const accepted: FakePort[] = [];
      for (const receiver of receivers) {
        const port = new FakePort(this, receiver, name, sender, false);
        opener.link(port);
        port.link(opener);
        accepted.push(port);
      }
      // onConnect runs synchronously in each receiver before any queued message is delivered.
      for (const port of accepted) this.run(port.ctx, () => port.ctx.onConnect.dispatch(port));
      opener.established();
    });
    return opener;
  }

  /* ---- storage ---- */

  /** @internal */
  storageChanged(area: AreaName, changes: Record<string, chrome.storage.StorageChange>): void {
    if (Object.keys(changes).length === 0) return;
    for (const ctx of [...this.contexts]) {
      if (!ctx.alive || ctx.invalidated) continue;
      if (!ctx.isExtension && !this.#storageAllowed(ctx, area)) continue;
      this.deliver(ctx, () => {
        ctx.areaOnChanged[area].dispatch(structuredClone(changes));
        ctx.storageOnChanged.dispatch(structuredClone(changes), area);
      });
    }
  }

  #storageAllowed(ctx: FakeContext, area: AreaName): boolean {
    if (ctx.isExtension) return true;
    if (area !== "session") return true;
    return this.storage.session.accessLevel === ENUMS.storage.AccessLevel.TRUSTED_AND_UNTRUSTED_CONTEXTS;
  }

  /** @internal */
  checkStorageAccess(ctx: FakeContext, area: AreaName): void {
    if (ctx.invalidated) throw new Error(CHROME_ERRORS.invalidated);
    if (!this.#storageAllowed(ctx, area)) throw new Error(CHROME_ERRORS.storageAccess);
  }

  /** Direct read for assertions (JSON round trip like Chrome). */
  storageGet(area: AreaName, key: string): unknown {
    const text = this.storage[area].data.get(key);
    return text === undefined ? undefined : fromJson(text);
  }

  /** Direct write for test setup; fires onChanged like a real write. */
  storageSet(area: AreaName, items: Record<string, unknown>): void {
    writeStorage(this, area, items);
  }

  /* ---- offscreen ---- */

  /** @internal */
  async createOffscreen(parameters: {
    url: string;
    reasons: string[];
    justification: string;
  }): Promise<void> {
    await this.gate("offscreen.createDocument");
    if (this.offscreen !== null || this.#offscreenCreating) throw new Error(CHROME_ERRORS.singleOffscreen);
    if (parameters.reasons.length === 0) throw new Error("At least one reason must be specified.");
    if (parameters.justification.trim() === "") throw new Error("A justification must be specified.");
    this.#offscreenCreating = true;
    try {
      const delay = this.options.offscreenCreateDelayMs ?? 1;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      const ctx = this.#addContext("offscreen", this.url(parameters.url));
      this.offscreen = ctx;
      const hook = this.options.onOffscreenCreated;
      if (hook !== undefined) await this.run(ctx, () => hook(ctx));
    } finally {
      this.#offscreenCreating = false;
    }
  }

  /** @internal */
  async closeOffscreen(): Promise<void> {
    await this.gate("offscreen.closeDocument");
    if (this.offscreen === null) throw new Error(CHROME_ERRORS.noOffscreen);
    this.offscreen.destroy();
  }

  /** @internal */
  getContexts(filter: Record<string, unknown[] | boolean | undefined>): chrome.runtime.ExtensionContext[] {
    const typeOf = (ctx: FakeContext): string => {
      switch (ctx.kind) {
        case "sw":
          return "BACKGROUND";
        case "offscreen":
          return "OFFSCREEN_DOCUMENT";
        case "popup":
          return "POPUP";
        case "sidepanel":
          return "SIDE_PANEL";
        case "options":
        case "debug":
        case "content":
          return "TAB";
      }
    };
    const keep = (list: unknown[] | boolean | undefined, value: unknown): boolean =>
      !Array.isArray(list) || list.includes(value);
    return this.contexts
      .filter((ctx) => ctx.alive && ctx.isExtension)
      .filter((ctx) => keep(filter.contextTypes, typeOf(ctx)))
      .filter((ctx) => keep(filter.contextIds, ctx.contextId))
      .filter((ctx) => keep(filter.documentUrls, ctx.url))
      .filter((ctx) => keep(filter.documentIds, ctx.documentId))
      .map(
        (ctx) =>
          ({
            contextType: typeOf(ctx),
            contextId: ctx.contextId,
            tabId: -1,
            windowId: -1,
            frameId: ctx.kind === "sw" ? -1 : 0,
            documentId: ctx.kind === "sw" ? undefined : ctx.documentId,
            documentUrl: ctx.kind === "sw" ? undefined : ctx.url,
            documentOrigin: ctx.kind === "sw" ? undefined : `chrome-extension://${this.extensionId}`,
            incognito: false,
          }) as unknown as chrome.runtime.ExtensionContext,
      );
  }

  /* ---- user gesture for sidePanel.open ---- */

  /** @internal */
  requireGesture(): void {
    if (!this.#userGesture) throw new Error(CHROME_ERRORS.sidePanelGesture);
  }
}

/* ---------------------------------------------------------------- namespaces */

function writeStorage(browser: FakeBrowser, area: AreaName, items: Record<string, unknown>): void {
  const store = browser.storage[area].data;
  const changes: Record<string, chrome.storage.StorageChange> = {};
  for (const [key, value] of Object.entries(items)) {
    if (value === undefined) continue;
    const next = toJson(value);
    if (next === undefined) continue;
    const previous = store.get(key);
    if (previous === next) continue;
    store.set(key, next);
    const change: chrome.storage.StorageChange = { newValue: fromJson(next) };
    if (previous !== undefined) change.oldValue = fromJson(previous);
    changes[key] = change;
  }
  browser.storageChanged(area, changes);
}

function storageArea(browser: FakeBrowser, ctx: FakeContext, area: AreaName) {
  const store = browser.storage[area];
  const api = `storage.${area}`;
  const read = (keys: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const take = (key: string, fallback?: unknown): void => {
      const text = store.data.get(key);
      if (text !== undefined) out[key] = fromJson(text);
      else if (fallback !== undefined) out[key] = structuredClone(fallback);
    };
    if (keys === undefined || keys === null) for (const key of store.data.keys()) take(key);
    else if (typeof keys === "string") take(keys);
    else if (Array.isArray(keys)) for (const key of keys as unknown[]) take(String(key));
    else for (const [key, fallback] of Object.entries(keys as Record<string, unknown>)) take(key, fallback);
    return out;
  };
  return {
    QUOTA_BYTES: area === "sync" ? 102_400 : 10_485_760,
    onChanged: ctx.areaOnChanged[area],
    async get(keys?: unknown): Promise<Record<string, unknown>> {
      browser.checkStorageAccess(ctx, area);
      await browser.gate(`${api}.get`);
      return read(keys);
    },
    async set(items: Record<string, unknown>): Promise<void> {
      browser.checkStorageAccess(ctx, area);
      await browser.gate(`${api}.set`);
      writeStorage(browser, area, items);
    },
    async remove(keys: string | string[]): Promise<void> {
      browser.checkStorageAccess(ctx, area);
      await browser.gate(`${api}.remove`);
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const key of typeof keys === "string" ? [keys] : keys) {
        const previous = store.data.get(key);
        if (previous === undefined) continue;
        store.data.delete(key);
        changes[key] = { oldValue: fromJson(previous) };
      }
      browser.storageChanged(area, changes);
    },
    async clear(): Promise<void> {
      browser.checkStorageAccess(ctx, area);
      await browser.gate(`${api}.clear`);
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, previous] of store.data) changes[key] = { oldValue: fromJson(previous) };
      store.data.clear();
      browser.storageChanged(area, changes);
    },
    async getBytesInUse(keys?: string | string[] | null): Promise<number> {
      browser.checkStorageAccess(ctx, area);
      await browser.gate(`${api}.getBytesInUse`);
      const wanted = keys === undefined || keys === null ? null : typeof keys === "string" ? [keys] : keys;
      let total = 0;
      for (const [key, text] of store.data)
        if (wanted === null || wanted.includes(key)) total += key.length + text.length;
      return total;
    },
    async setAccessLevel(options: { accessLevel: string }): Promise<void> {
      if (!ctx.isExtension) throw new Error("setAccessLevel is only available to extension contexts.");
      await browser.gate(`${api}.setAccessLevel`);
      store.accessLevel = options.accessLevel;
    },
  };
}

function runtimeCore(browser: FakeBrowser, ctx: FakeContext) {
  return {
    get id(): string | undefined {
      return ctx.invalidated ? undefined : browser.extensionId;
    },
    get lastError(): { message: string } | undefined {
      return browser.lastError;
    },
    getURL(path: string): string {
      if (ctx.invalidated) throw new Error(CHROME_ERRORS.invalidated);
      return browser.url(path);
    },
    getManifest(): Record<string, unknown> {
      return structuredClone(
        browser.options.manifest ?? { manifest_version: 3, name: "ctv-test", version: "0.0.0" },
      );
    },
    sendMessage(message: unknown): Promise<unknown> {
      return browser.sendRuntimeMessage(ctx, message);
    },
    connect(info: { name?: string } = {}): FakePort {
      return browser.connect(ctx, info.name ?? "");
    },
    onMessage: ctx.onMessage,
    onConnect: ctx.onConnect,
  };
}

function contentNamespace(browser: FakeBrowser, ctx: FakeContext) {
  return {
    runtime: runtimeCore(browser, ctx),
    storage: {
      local: storageArea(browser, ctx, "local"),
      session: storageArea(browser, ctx, "session"),
      sync: storageArea(browser, ctx, "sync"),
      onChanged: ctx.storageOnChanged,
    },
    i18n: { getUILanguage: (): string => "vi", getMessage: (): string => "" },
  };
}

function extensionNamespace(browser: FakeBrowser, ctx: FakeContext) {
  const content = contentNamespace(browser, ctx);
  return {
    ...content,
    runtime: Object.assign(runtimeCore(browser, ctx), {
      ...ENUMS.runtime,
      onInstalled: ctx.onInstalled,
      onStartup: ctx.onStartup,
      onSuspend: ctx.onSuspend,
      async getContexts(filter: Record<string, unknown[] | boolean | undefined>) {
        await browser.gate("runtime.getContexts");
        return browser.getContexts(filter);
      },
      async getPlatformInfo() {
        await browser.gate("runtime.getPlatformInfo");
        return { os: "win", arch: "x86-64", nacl_arch: "x86-64" };
      },
      async openOptionsPage(): Promise<void> {
        await browser.gate("runtime.openOptionsPage");
      },
      reload(): void {
        browser.calls.push("runtime.reload");
      },
    }),
    tabs: {
      TAB_ID_NONE: -1,
      onRemoved: ctx.tabsOnRemoved,
      onUpdated: ctx.tabsOnUpdated,
      onActivated: ctx.tabsOnActivated,
      async get(tabId: number): Promise<chrome.tabs.Tab> {
        await browser.gate("tabs.get");
        const tab = browser.tabs.get(tabId);
        if (tab === undefined) throw new Error(`No tab with id: ${tabId}.`);
        return browser.tabInfo(tab);
      },
      async query(query: {
        active?: boolean;
        currentWindow?: boolean;
        url?: string;
      }): Promise<chrome.tabs.Tab[]> {
        await browser.gate("tabs.query");
        return [...browser.tabs.values()]
          .filter((tab) => query.active === undefined || tab.active === query.active)
          .filter((tab) => query.currentWindow !== true || tab.windowId === 1)
          .filter((tab) => query.url === undefined || tab.url === query.url)
          .map((tab) => browser.tabInfo(tab));
      },
      sendMessage(tabId: number, message: unknown, options?: { frameId?: number; documentId?: string }) {
        return browser.sendTabMessage(ctx, tabId, message, options);
      },
      async create(properties: { url?: string; active?: boolean }): Promise<chrome.tabs.Tab> {
        await browser.gate("tabs.create");
        const options = properties.active === undefined ? {} : { active: properties.active };
        return browser.tabInfo(browser.openTab(properties.url ?? "about:blank", options));
      },
      async captureVisibleTab(windowId?: number, _options?: unknown): Promise<string> {
        await browser.gate("tabs.captureVisibleTab");
        const now = browser.now();
        const recent = browser.captureTimes.filter((t) => now - t < 1000);
        if (recent.length >= 2) throw new Error(CHROME_ERRORS.captureQuota);
        browser.captureTimes.push(now);
        return (browser.options.captureVisibleTab ?? ((): string => TINY_PNG))(windowId ?? 1);
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      async get(windowId: number): Promise<chrome.windows.Window> {
        await browser.gate("windows.get");
        const known =
          windowId === browser.lastFocusedWindow ||
          [...browser.tabs.values()].some((t) => t.windowId === windowId);
        if (!known) throw new Error(`No window with id: ${windowId}.`);
        return browser.windowInfo(windowId);
      },
      async getLastFocused(): Promise<chrome.windows.Window> {
        await browser.gate("windows.getLastFocused");
        return browser.windowInfo(browser.lastFocusedWindow);
      },
    },
    declarativeNetRequest: {
      ...ENUMS.declarativeNetRequest,
      MAX_NUMBER_OF_SESSION_RULES: 5000,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      async getSessionRules(filter?: { ruleIds?: number[] }): Promise<chrome.declarativeNetRequest.Rule[]> {
        await browser.gate("declarativeNetRequest.getSessionRules");
        const ids = filter?.ruleIds;
        return structuredClone(
          browser.sessionRules.filter((rule) => ids === undefined || ids.includes(rule.id)),
        );
      },
      async updateSessionRules(update: {
        removeRuleIds?: number[];
        addRules?: chrome.declarativeNetRequest.Rule[];
      }): Promise<void> {
        await browser.gate("declarativeNetRequest.updateSessionRules");
        browser.sessionRules = applyRuleUpdate(browser.sessionRules, update, 5000);
      },
      async getDynamicRules(filter?: { ruleIds?: number[] }): Promise<chrome.declarativeNetRequest.Rule[]> {
        await browser.gate("declarativeNetRequest.getDynamicRules");
        const ids = filter?.ruleIds;
        return structuredClone(
          browser.dynamicRules.filter((rule) => ids === undefined || ids.includes(rule.id)),
        );
      },
      async updateDynamicRules(update: {
        removeRuleIds?: number[];
        addRules?: chrome.declarativeNetRequest.Rule[];
      }): Promise<void> {
        await browser.gate("declarativeNetRequest.updateDynamicRules");
        browser.dynamicRules = applyRuleUpdate(browser.dynamicRules, update, 30000);
      },
      async isRegexSupported(options: {
        regex: string;
        isCaseSensitive?: boolean;
        requireCapturing?: boolean;
      }): Promise<{ isSupported: boolean; reason?: string }> {
        await browser.gate("declarativeNetRequest.isRegexSupported");
        return re2Supported(options.regex)
          ? { isSupported: true }
          : { isSupported: false, reason: ENUMS.declarativeNetRequest.UnsupportedRegexReason.SYNTAX_ERROR };
      },
      async getMatchedRules(): Promise<{ rulesMatchedInfo: unknown[] }> {
        await browser.gate("declarativeNetRequest.getMatchedRules");
        return { rulesMatchedInfo: [] };
      },
    },
    offscreen: {
      ...ENUMS.offscreen,
      createDocument: (parameters: { url: string; reasons: string[]; justification: string }) =>
        browser.createOffscreen(parameters),
      closeDocument: () => browser.closeOffscreen(),
      async hasDocument(): Promise<boolean> {
        await browser.gate("offscreen.hasDocument");
        return browser.offscreen !== null;
      },
    },
    scripting: {
      ...ENUMS.scripting,
      async registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void> {
        await browser.gate("scripting.registerContentScripts");
        const seen = new Set<string>();
        for (const script of scripts) {
          if (script.id === "" || script.id.startsWith("_"))
            throw new Error(`Invalid script ID '${script.id}'.`);
          if (browser.registeredScripts.has(script.id) || seen.has(script.id)) {
            throw new Error(`Duplicate script ID '${script.id}'`);
          }
          if (script.matches === undefined || script.matches.length === 0) {
            throw new Error(`Script with ID '${script.id}' must specify 'matches'.`);
          }
          if ((script.js?.length ?? 0) + (script.css?.length ?? 0) === 0) {
            throw new Error(`Script with ID '${script.id}' must specify at least one js or css file.`);
          }
          seen.add(script.id);
        }
        for (const script of scripts) browser.registeredScripts.set(script.id, structuredClone(script));
      },
      async getRegisteredContentScripts(filter?: {
        ids?: string[];
      }): Promise<chrome.scripting.RegisteredContentScript[]> {
        await browser.gate("scripting.getRegisteredContentScripts");
        const ids = filter?.ids;
        return [...browser.registeredScripts.values()]
          .filter((script) => ids === undefined || ids.includes(script.id))
          .map((script) => structuredClone(script));
      },
      async unregisterContentScripts(filter?: { ids?: string[] }): Promise<void> {
        await browser.gate("scripting.unregisterContentScripts");
        const ids = filter?.ids;
        if (ids === undefined) {
          browser.registeredScripts.clear();
          return;
        }
        for (const id of ids)
          if (!browser.registeredScripts.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
        for (const id of ids) browser.registeredScripts.delete(id);
      },
      async updateContentScripts(
        scripts: Array<Partial<chrome.scripting.RegisteredContentScript> & { id: string }>,
      ) {
        await browser.gate("scripting.updateContentScripts");
        for (const script of scripts) {
          if (!browser.registeredScripts.has(script.id))
            throw new Error(`Nonexistent script ID '${script.id}'`);
        }
        for (const script of scripts) {
          const current = browser.registeredScripts.get(script.id);
          if (current === undefined) continue;
          const merged = {
            ...current,
            ...structuredClone(script),
          } as chrome.scripting.RegisteredContentScript;
          browser.registeredScripts.set(script.id, merged);
        }
      },
      async executeScript(injection: {
        target: { tabId: number; frameIds?: number[]; allFrames?: boolean; documentIds?: string[] };
        files?: string[];
        func?: AnyFunction;
        args?: unknown[];
        world?: string;
        injectImmediately?: boolean;
      }): Promise<Array<{ frameId: number; documentId: string; result?: unknown }>> {
        await browser.gate("scripting.executeScript");
        const tab = browser.tabs.get(injection.target.tabId);
        if (tab === undefined) throw new Error(`No tab with id: ${injection.target.tabId}.`);
        const frames = tab.frames.filter((frame) => {
          if (injection.target.allFrames === true) return true;
          if (injection.target.frameIds !== undefined)
            return injection.target.frameIds.includes(frame.frameId);
          if (injection.target.documentIds !== undefined)
            return injection.target.documentIds.includes(frame.documentId);
          return frame.frameId === 0;
        });
        if (injection.target.frameIds !== undefined) {
          for (const id of injection.target.frameIds) {
            if (!tab.frames.some((frame) => frame.frameId === id)) {
              throw new Error(`No frame with id ${id} in tab with id ${tab.id}`);
            }
          }
        }
        const files = injection.files ?? [];
        browser.executeScriptCalls.push({
          tabId: tab.id,
          frameIds: frames.map((frame) => frame.frameId),
          files,
          world: injection.world ?? "ISOLATED",
          hasFunc: injection.func !== undefined,
        });
        const results: Array<{ frameId: number; documentId: string; result?: unknown }> = [];
        for (const frame of frames) {
          let result: unknown;
          if (files.length > 0) {
            const content = browser.injectContent(tab.id, frame.frameId);
            const hook = browser.options.onContentInjected;
            if (hook !== undefined) await browser.run(content, () => hook(content, files));
          } else if (injection.func !== undefined) {
            const call = browser.options.onExecuteFunc;
            const args = injection.args ?? [];
            result =
              call === undefined
                ? (injection.func as (...a: unknown[]) => unknown)(...args)
                : call({ tabId: tab.id, frameId: frame.frameId }, injection.func, args);
          }
          results.push({ frameId: frame.frameId, documentId: frame.documentId, result });
        }
        return results;
      },
    },
    contextMenus: {
      ...ENUMS.contextMenus,
      onClicked: ctx.menusOnClicked,
      create(properties: Record<string, unknown>, callback?: () => void): string {
        const id = typeof properties.id === "string" ? properties.id : browser.nextId("menu");
        const duplicate = browser.menus.has(id);
        if (!duplicate) browser.menus.set(id, structuredClone(properties));
        browser.calls.push("contextMenus.create");
        if (callback !== undefined) {
          browser.deliver(ctx, () =>
            browser.withLastError(duplicate ? `Cannot create item with duplicate id ${id}` : null, callback),
          );
        }
        return id;
      },
      async update(id: string, properties: Record<string, unknown>): Promise<void> {
        await browser.gate("contextMenus.update");
        const current = browser.menus.get(id);
        if (current === undefined) throw new Error(`Cannot find menu item with id ${id}`);
        browser.menus.set(id, { ...current, ...structuredClone(properties) });
      },
      async remove(id: string): Promise<void> {
        await browser.gate("contextMenus.remove");
        if (!browser.menus.delete(id)) throw new Error(`Cannot find menu item with id ${id}`);
      },
      async removeAll(): Promise<void> {
        await browser.gate("contextMenus.removeAll");
        browser.menus.clear();
      },
    },
    commands: {
      onCommand: ctx.commandsOnCommand,
      async getAll(): Promise<chrome.commands.Command[]> {
        await browser.gate("commands.getAll");
        return structuredClone(browser.options.commands ?? []);
      },
    },
    action: {
      onClicked: ctx.actionOnClicked,
      async setBadgeText(details: { text?: string; tabId?: number }): Promise<void> {
        await browser.gate("action.setBadgeText");
        badgeOf(browser, details.tabId).text = details.text ?? "";
      },
      async getBadgeText(details: { tabId?: number }): Promise<string> {
        await browser.gate("action.getBadgeText");
        return badgeOf(browser, details.tabId).text;
      },
      async setBadgeBackgroundColor(details: { color: string | number[]; tabId?: number }): Promise<void> {
        await browser.gate("action.setBadgeBackgroundColor");
        badgeOf(browser, details.tabId).color = String(details.color);
      },
      async setBadgeTextColor(_details: { color: string | number[]; tabId?: number }): Promise<void> {
        await browser.gate("action.setBadgeTextColor");
      },
      async setTitle(details: { title: string; tabId?: number }): Promise<void> {
        await browser.gate("action.setTitle");
        badgeOf(browser, details.tabId).title = details.title;
      },
      async getTitle(details: { tabId?: number }): Promise<string> {
        await browser.gate("action.getTitle");
        return badgeOf(browser, details.tabId).title;
      },
      async setIcon(_details: unknown): Promise<void> {
        await browser.gate("action.setIcon");
      },
      async setPopup(_details: unknown): Promise<void> {
        await browser.gate("action.setPopup");
      },
    },
    sidePanel: {
      open(options: { tabId?: number; windowId?: number }): Promise<void> {
        // Synchronous gesture check: the call must happen inside the command/menu/action listener itself.
        try {
          browser.requireGesture();
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        browser.sidePanel.opened.push({ ...options });
        return browser.gate("sidePanel.open");
      },
      async setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void> {
        await browser.gate("sidePanel.setOptions");
        const key = String(options.tabId ?? "global");
        browser.sidePanel.options.set(key, { ...(browser.sidePanel.options.get(key) ?? {}), ...options });
      },
      async getOptions(options: { tabId?: number }): Promise<Record<string, unknown>> {
        await browser.gate("sidePanel.getOptions");
        return { ...(browser.sidePanel.options.get(String(options.tabId ?? "global")) ?? {}) };
      },
      async setPanelBehavior(behavior: { openPanelOnActionClick?: boolean }): Promise<void> {
        await browser.gate("sidePanel.setPanelBehavior");
        browser.sidePanel.behavior.openPanelOnActionClick = behavior.openPanelOnActionClick ?? false;
      },
      async getPanelBehavior(): Promise<{ openPanelOnActionClick: boolean }> {
        await browser.gate("sidePanel.getPanelBehavior");
        return { ...browser.sidePanel.behavior };
      },
    },
    alarms: {
      onAlarm: ctx.alarmsOnAlarm,
      async create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }) {
        await browser.gate("alarms.create");
        const scheduledTime =
          info.when ?? browser.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000;
        const alarm: FakeAlarm = { name, scheduledTime };
        if (info.periodInMinutes !== undefined) alarm.periodInMinutes = info.periodInMinutes;
        browser.alarms.set(name, alarm);
      },
      async get(name: string): Promise<FakeAlarm | undefined> {
        await browser.gate("alarms.get");
        const alarm = browser.alarms.get(name);
        return alarm === undefined ? undefined : { ...alarm };
      },
      async getAll(): Promise<FakeAlarm[]> {
        await browser.gate("alarms.getAll");
        return [...browser.alarms.values()].map((alarm) => ({ ...alarm }));
      },
      async clear(name: string): Promise<boolean> {
        await browser.gate("alarms.clear");
        return browser.alarms.delete(name);
      },
      async clearAll(): Promise<boolean> {
        await browser.gate("alarms.clearAll");
        const had = browser.alarms.size > 0;
        browser.alarms.clear();
        return had;
      },
    },
    permissions: {
      async contains(_permissions: unknown): Promise<boolean> {
        await browser.gate("permissions.contains");
        return browser.permissions.granted;
      },
      async getAll(): Promise<{ permissions: string[]; origins: string[] }> {
        await browser.gate("permissions.getAll");
        return { permissions: [], origins: browser.permissions.granted ? ["<all_urls>"] : [] };
      },
    },
  };
}

export type ExtensionChrome = ReturnType<typeof extensionNamespace>;
export type ContentChrome = ReturnType<typeof contentNamespace>;
export type FakeChrome = ExtensionChrome | ContentChrome;

function badgeOf(
  browser: FakeBrowser,
  tabId: number | undefined,
): { text: string; color: string; title: string } {
  const key = String(tabId ?? "global");
  let badge = browser.badges.get(key);
  if (badge === undefined) {
    badge = { text: "", color: "", title: "" };
    browser.badges.set(key, badge);
  }
  return badge;
}

/** RE2 rejects lookaround, backreferences and atomic groups; everything else must at least compile. */
export function re2Supported(regex: string): boolean {
  if (/\(\?<?[=!]|\(\?>|\\[1-9]/.test(regex)) return false;
  try {
    new RegExp(regex);
    return true;
  } catch {
    return false;
  }
}

function applyRuleUpdate(
  current: chrome.declarativeNetRequest.Rule[],
  update: { removeRuleIds?: number[]; addRules?: chrome.declarativeNetRequest.Rule[] },
  max: number,
): chrome.declarativeNetRequest.Rule[] {
  const remove = new Set(update.removeRuleIds ?? []);
  const next = current.filter((rule) => !remove.has(rule.id));
  for (const rule of update.addRules ?? []) {
    if (!Number.isInteger(rule.id) || rule.id < 1)
      throw new Error(`Rule with id ${rule.id} must have a positive integer id.`);
    if (next.some((existing) => existing.id === rule.id)) {
      throw new Error(`Rule with id ${rule.id} does not have a unique ID.`);
    }
    const { condition, action } = rule;
    if (condition.regexFilter !== undefined && condition.urlFilter !== undefined) {
      throw new Error(`Rule with id ${rule.id} cannot specify both "urlFilter" and "regexFilter" keys.`);
    }
    if (condition.regexFilter !== undefined && !re2Supported(condition.regexFilter)) {
      throw new Error(`Rule with id ${rule.id} specified an invalid "regexFilter" key.`);
    }
    if ((action.type as string | undefined) === undefined) {
      throw new Error(`Rule with id ${rule.id} must specify an action type.`);
    }
    if (
      action.type === "modifyHeaders" &&
      (action.requestHeaders?.length ?? 0) + (action.responseHeaders?.length ?? 0) === 0
    ) {
      throw new Error(`Rule with id ${rule.id} does not specify the headers to be modified.`);
    }
    next.push(structuredClone(rule));
  }
  if (next.length > max) throw new Error("The number of rules exceeds the limit.");
  return next;
}

/** Convenience: a browser with the global installed and a started service worker. */
export async function createFakeBrowser(
  options: FakeBrowserOptions = {},
): Promise<{ browser: FakeBrowser; sw: FakeContext }> {
  const browser = new FakeBrowser(options);
  browser.install();
  const sw = await browser.startServiceWorker();
  return { browser, sw };
}
