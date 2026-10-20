// Runs an extension page entry (src/ui/popup/popup.ts, src/ui/options/options.ts) in Node: the chrome fake with the
// service-worker router, a fake DOM, a stub `location` and a fake global fetch for the page's own GET /models (tests
// never reach a real AI endpoint). closePage() restores every global and resets the UI locale to English.
// Imported by tests; not a test file itself.

import { onMessageFor } from "../../../src/platform/messaging.ts";
import { setLocale } from "../../../src/shared/i18n/index.ts";
import { migrateSettings, migrateSite } from "../../../src/shared/settings.ts";
import { swAllow, swHandlers } from "../../../src/sw/router.ts";
import type { FakeBrowser, FakeContext } from "../../support/chrome-fake.ts";
import { startBrowser, stopBrowser } from "../sw/sw-helpers.ts";
import { installFakePage, type FakeElement, type FakePage } from "./fake-dom.ts";

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

export interface PageOptions {
  page: "popup" | "options";
  /** Ids of the page's static elements (its HTML skeleton). */
  ids: readonly string[];
  /** Stored `settings` before the page loads (migrated like a real stored value). */
  settings?: unknown;
  /** Stored sites (site key → partial site settings). */
  sites?: Record<string, unknown>;
  /** Tabs to open before the page loads; the last one is active. */
  tabs?: readonly string[];
  /** The fake endpoint's answer to any fetch. */
  answer: (call: FetchCall) => Response;
}

export interface PageRun {
  browser: FakeBrowser;
  context: FakeContext;
  dom: FakePage;
  fetchCalls: FetchCall[];
  /** location.reload() calls. */
  reloads(): number;
  /** Changes the fake endpoint's answer. */
  answer(next: (call: FetchCall) => Response): void;
  /** Fires a DOM event inside the page's chrome context (like a user action in Chrome). */
  dispatch(el: FakeElement, type: string): void;
}

const cleanups: Array<() => void> = [];
let loads = 0;

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Starts the fake browser, stores the settings, then evaluates a fresh copy of the page module in its context. */
export async function openPage(options: PageOptions): Promise<PageRun> {
  const { browser, sw } = await startBrowser();
  sw.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
  if (options.settings !== undefined)
    browser.storageSet("local", { settings: migrateSettings(options.settings) });
  for (const [siteKey, site] of Object.entries(options.sites ?? {})) {
    browser.storageSet("local", { [`site:${siteKey}`]: migrateSite(site, 1) });
  }
  for (const url of options.tabs ?? []) browser.openTab(url);

  const dom = installFakePage(options.ids);
  cleanups.push(dom.uninstall);

  const fetchCalls: FetchCall[] = [];
  let respond = options.answer;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const call = { url: urlOf(input), init };
    fetchCalls.push(call);
    return Promise.resolve(respond(call));
  };
  cleanups.push(() => {
    globalThis.fetch = realFetch;
  });

  let reloads = 0;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: {
      hash: "",
      reload: () => {
        reloads += 1;
      },
    },
  });
  cleanups.push(() => {
    if (previousLocation === undefined) Reflect.deleteProperty(globalThis, "location");
    else Object.defineProperty(globalThis, "location", previousLocation);
  });

  const context = browser.openExtensionPage(options.page, `ui/${options.page}.html`);
  loads += 1;
  // A query string makes Node evaluate the module again, so its top-level main() runs once per test.
  const specifier = `../../../src/ui/${options.page}/${options.page}.ts?load=${loads}`;
  await context.run(() => import(specifier));
  return {
    browser,
    context,
    dom,
    fetchCalls,
    reloads: () => reloads,
    answer: (next) => {
      respond = next;
    },
    dispatch: (el, type) => {
      context.run(() => el.dispatch(type));
    },
  };
}

/** Stops the fake browser once it is quiet, restores the globals and resets the UI locale (use in afterEach). */
export async function closePage(): Promise<void> {
  await stopBrowser();
  while (cleanups.length > 0) cleanups.pop()?.();
  setLocale("en");
}

/** Text of the status pill (a <p> or <span> of class "pill tone-…") inside a container, or null when there is none yet. */
export function pillText(container: FakeElement): string | null {
  return (
    [...container.findAll("p"), ...container.findAll("span")].find((el) => el.className.startsWith("pill "))
      ?.textContent ?? null
  );
}

/** Texts of the direct or nested elements with this tag. */
export function texts(container: FakeElement, tag: string): string[] {
  return container.findAll(tag).map((el) => el.textContent);
}
