// Content script entry, bundled as an IIFE. Registered at runtime for opted-in sites; injected on request elsewhere,
// after the SW sets globalThis.__ctvManual = Date.now() in the same (isolated) world.
//   1. Supersede/orphan handshake: a healthy instance in this frame wins and the newcomer exits; an orphan of a
//      reloaded extension tears itself down, and stale overlay hosts are removed.
//   2. Mode: manual if __ctvManual was set < 10 s ago, else the mode of the enabled site that covers this frame
//      (shared/site.ts: own record, includeSubdomains, extraFrameOrigins), else exit quietly (a foreign frame).
//   3. Gates: wait until prerendering ends; in auto mode with translateHiddenTabs off, until the page was visible.
//   4. Start the controller. The engine connection is lazy: pages without candidates never create the engine.

import { isContextValid } from "../platform/context.ts";
import { applyLocale } from "../platform/locale.ts";
import { consoleSink } from "../platform/log.ts";
import { callSw } from "../platform/messaging.ts";
import { sitesFrom } from "../platform/storage.ts";
import { minutesToMs } from "../platform/time.ts";
import { systemClock } from "../shared/clock.ts";
import { toHex } from "../shared/ids.ts";
import type { PageHints } from "../shared/protocol.ts";
import { STORAGE_KEYS, migrateSettings, type Settings, type SiteSettings } from "../shared/settings.ts";
import { findEnabledSite, siteKeyFor } from "../shared/site.ts";
import { readLocalBytes } from "./acquire-local.ts";
import { createController, type Controller } from "./controller.ts";
import { createDiscovery } from "./discovery.ts";
import { createEngineClient, documentLifecycle } from "./engine-client.ts";
import { listenForCommands, type CommandTarget, type TeardownReason } from "./messages.ts";
import { createOverlay } from "./overlay/index.ts";
import { createTestHooks } from "./test-hooks.ts";

export const MANUAL_FLAG_TTL_MS = 10_000;
/** Tolerated clock difference between the SW that set the flag and this script. */
const MANUAL_FLAG_SKEW_MS = 1_000;
export const PROBE_EVENT = "ctv:probe";
export const ALIVE_ATTR = "data-ctv-alive";
export const HOST_SELECTOR = "[data-ctv-host]";

export type ContentMode = "auto" | "manual";

/* ------------------------------------------------------------------ pure decisions */

export function isManualFlagFresh(flag: unknown, now: number): boolean {
  if (typeof flag !== "number" || !Number.isFinite(flag)) return false;
  const age = now - flag;
  return age >= -MANUAL_FLAG_SKEW_MS && age < MANUAL_FLAG_TTL_MS;
}

/**
 * The frame's site from a storage dump (shared/site.ts rules, the same the SW registers with): its own record,
 * enabled or not, else the enabled site that covers it through includeSubdomains or extraFrameOrigins (a reader
 * iframe served from another origin).
 */
export function pickSite(
  origin: string,
  stored: Readonly<Record<string, unknown>>,
  now: number,
): SiteSettings | null {
  const siteKey = siteKeyFor(origin);
  if (siteKey === null) return null;
  const sites = sitesFrom(stored, now);
  return sites[siteKey] ?? findEnabledSite(origin, sites)?.site ?? null;
}

/** Step 2: null means "not for this frame: exit quietly". */
export function chooseMode(input: {
  manualFlag: unknown;
  now: number;
  site: SiteSettings | null;
}): ContentMode | null {
  if (isManualFlagFresh(input.manualFlag, input.now)) return "manual";
  if (input.site?.enabled === true) return input.site.mode;
  return null;
}

export interface Gates {
  /** document.prerendering: wait for prerenderingchange. */
  prerender: boolean;
  /** Auto mode with translateHiddenTabs off on a page never seen yet: wait for visibilitychange. */
  visible: boolean;
}

/** Step 3: nothing is discovered or uploaded for pages the user has not looked at. */
export function gatesFor(input: {
  mode: ContentMode;
  translateHiddenTabs: boolean;
  prerendering: boolean;
  visible: boolean;
}): Gates {
  return {
    prerender: input.prerendering,
    visible: input.mode === "auto" && !input.translateHiddenTabs && !input.visible,
  };
}

export function randomHex(
  byteCount: number,
  fill: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  // getRandomValues, not randomUUID: http:// pages are not secure contexts.
  return toHex(fill(new Uint8Array(byteCount)));
}

export function pageHints(
  doc: Document,
  win: Pick<Window, "devicePixelRatio">,
  site: SiteSettings | null,
): PageHints {
  return {
    title: doc.title,
    layout: site?.layout ?? "auto",
    visible: doc.visibilityState === "visible",
    dpr: win.devicePixelRatio > 0 ? win.devicePixelRatio : 1,
  };
}

/* ------------------------------------------------------------------ handshake (step 1) */

export interface Handshake {
  /** False: a healthy instance already runs in this frame; this one must exit. */
  proceed: boolean;
  /** Stops answering newcomers (this instance exits or tears down). */
  dispose(): void;
}

/**
 * Dispatches ctv:probe with a nonce: a healthy instance answers synchronously by setting data-ctv-alive to it,
 * an orphan (invalid context) tears itself down instead. Works across worlds and builds (the detail is a string).
 */
export function handshake(
  doc: Document,
  nonce: string,
  contextValid: () => boolean,
  onOrphaned: () => void,
): Handshake {
  doc.dispatchEvent(new CustomEvent(PROBE_EVENT, { detail: nonce }));
  const root = doc.documentElement;
  if (root.getAttribute(ALIVE_ATTR) === nonce) {
    root.removeAttribute(ALIVE_ATTR);
    return { proceed: false, dispose: () => undefined };
  }
  const onProbe = (event: Event): void => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string") return;
    if (contextValid()) root.setAttribute(ALIVE_ATTR, detail);
    else onOrphaned();
  };
  doc.addEventListener(PROBE_EVENT, onProbe);
  return { proceed: true, dispose: () => doc.removeEventListener(PROBE_EVENT, onProbe) };
}

/** Overlay hosts left by an orphan; this instance has none yet when it runs. */
export function removeStaleHosts(doc: Document): number {
  const stale = [...doc.querySelectorAll(HOST_SELECTOR)];
  for (const host of stale) host.remove();
  return stale.length;
}

/* ------------------------------------------------------------------ boot */

export interface StartConfig {
  mode: ContentMode;
  settings: Settings;
  site: SiteSettings | null;
  onTeardown: (reason: TeardownReason) => void;
}

export interface BootEnv {
  doc: Document;
  /** location.origin of this frame. */
  origin: string;
  now: () => number;
  /** Reads and clears globalThis.__ctvManual. */
  takeManualFlag: () => unknown;
  /** The whole chrome.storage.local: settings plus every site:<siteKey> (extraFrameOrigins may name this frame). */
  readStorage: () => Promise<Record<string, unknown>>;
  isContextValid: () => boolean;
  listen: (target: CommandTarget) => () => void;
  start: (config: StartConfig) => Controller;
}

export type BootOutcome = "superseded" | "not-enabled" | "started" | "stopped";

function isPrerendering(doc: Document): boolean {
  return (doc as Document & { prerendering?: boolean }).prerendering === true;
}

/** Resolves once `done()` holds after an event of `type` (or at once); a cleanup resolves it early. */
function waitFor(
  doc: Document,
  type: string,
  done: () => boolean,
  cleanups: Array<() => void>,
): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      doc.removeEventListener(type, onEvent);
      resolve();
    };
    const onEvent = (): void => {
      if (done()) finish();
    };
    doc.addEventListener(type, onEvent);
    cleanups.push(finish);
  });
}

export async function bootContentScript(env: BootEnv): Promise<BootOutcome> {
  const { doc } = env;
  const manualFlag = env.takeManualFlag();
  const cleanups: Array<() => void> = [];
  let controller: Controller | null = null;
  let stopped = false;
  const stop = (reason: TeardownReason): void => {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    controller?.teardown(reason);
  };

  const shake = handshake(doc, randomHex(8), env.isContextValid, () => stop("ctx.invalidated"));
  if (!shake.proceed) return "superseded";
  cleanups.push(() => shake.dispose());
  removeStaleHosts(doc);

  // Commands may arrive right after an on-request injection: answer them once the controller exists.
  let settle: (controller: Controller | null) => void = () => undefined;
  const ready = new Promise<Controller | null>((resolve) => {
    settle = resolve;
  });
  cleanups.push(() => settle(null));

  try {
    cleanups.push(
      env.listen({
        toggleOverlay: async () => (await ready)?.toggleOverlay() ?? false,
        translateVisible: async () => (await ready)?.translateVisible() ?? 0,
        translateImage: async (srcUrl, force) => (await ready)?.translateImage(srcUrl, force) ?? false,
        teardown: (reason) => stop(reason),
      }),
    );
    const stored = await env.readStorage();
    if (stopped) return "stopped";
    const now = env.now();
    const settings = migrateSettings(stored[STORAGE_KEYS.settings]);
    const site = pickSite(env.origin, stored, now);
    const mode = chooseMode({ manualFlag, now, site });
    if (mode === null) {
      stop("not-enabled");
      return "not-enabled";
    }
    const gateInput = (): Parameters<typeof gatesFor>[0] => ({
      mode,
      translateHiddenTabs: settings.discovery.translateHiddenTabs,
      prerendering: isPrerendering(doc),
      visible: doc.visibilityState === "visible",
    });
    if (gatesFor(gateInput()).prerender) {
      await waitFor(doc, "prerenderingchange", () => !isPrerendering(doc), cleanups);
    }
    if (!stopped && gatesFor(gateInput()).visible) {
      await waitFor(doc, "visibilitychange", () => doc.visibilityState === "visible", cleanups);
    }
    if (stopped) return "stopped";
    controller = env.start({ mode, settings, site, onTeardown: (reason) => stop(reason) });
    settle(controller);
    controller.start();
    return "started";
  } catch (error) {
    // An orphan's storage read rejects with "Extension context invalidated": leave without console noise.
    if (__DEV__ && env.isContextValid()) console.warn("[ctv:cs] content script failed to start", error);
    stop("ctx.invalidated");
    return "stopped";
  }
}

/* ------------------------------------------------------------------ production wiring */

function takeManualFlag(): unknown {
  const flag: unknown = globalThis.__ctvManual;
  globalThis.__ctvManual = undefined;
  return flag;
}

function startController(config: StartConfig): Controller {
  const { mode, settings, site } = config;
  applyLocale(settings.ui.locale);
  const hooks = __TEST__ ? createTestHooks(document) : null;
  return createController({
    doc: document,
    mode,
    settings,
    siteEnabled: site?.enabled === true,
    createOverlay,
    readLocalBytes,
    createDiscovery: (events) =>
      createDiscovery({ doc: document, win: window, timers: systemClock }, settings.discovery, events, {
        // Tier B: prefetch lazy images ahead of the reader, in automatic mode on an enabled site.
        prefetch: mode === "auto" && site?.enabled === true && site.prefetchAhead,
      }),
    createClient: ({ log, reread }) =>
      createEngineClient({
        mode,
        pageHints: () => pageHints(document, window, site),
        page: documentLifecycle(document, window),
        clock: systemClock,
        random: () => Math.random(),
        log,
        portIdleMs: minutesToMs(settings.engine.portIdleMin),
        reread,
      }),
    clock: systemClock,
    ackPrivacy: () => callSw("sw:ack-privacy", {}),
    logSinks: __DEV__ ? [consoleSink] : [],
    ...(hooks === null ? {} : { onSummary: (summary) => hooks.publish(summary) }),
    onTeardown: (reason) => {
      hooks?.dispose();
      config.onTeardown(reason);
    },
  });
}

if (typeof document !== "undefined") {
  bootContentScript({
    doc: document,
    origin: location.origin,
    now: () => Date.now(),
    takeManualFlag,
    readStorage: () => chrome.storage.local.get(null),
    isContextValid,
    listen: listenForCommands,
    start: startController,
  }).catch((error: unknown) => {
    // Never an uncaught rejection: an orphaned script must leave no console errors.
    if (__DEV__) console.warn("[ctv:cs] content script boot failed", error);
  });
}
