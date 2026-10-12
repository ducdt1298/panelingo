// Shared E2E steps on top of launch.ts: opt a fixture site in, open a page, wait for the content summary, read the
// painted units out of the (open, test-build) shadow roots and the engine's IndexedDB log, talk to the extension
// (service worker, extension pages, content scripts) and print diagnostics when a test fails.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { PROTOCOL_VERSION } from "../../src/shared/versions.ts";
import { ROOT } from "./chrome.ts";
import { summary, waitForSummary, type ContentSummary, type Harness } from "./launch.ts";

export const TERMINAL_STATES = ["done", "error", "partial", "no-text", "refused"] as const;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` every `everyMs` until `done` accepts its value; throws with the last value after `timeoutMs`. */
export async function waitUntil<T>(
  label: string,
  probe: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs = 30_000,
  everyMs = 200,
): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (done(last)) return last;
    if (Date.now() - started >= timeoutMs) break;
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}; last: ${JSON.stringify(last)}`);
}

export async function enableSite(h: Harness, mode: "auto" | "manual" = "auto"): Promise<string> {
  const siteKey = new URL(h.fixtures.readerUrl).origin;
  await h.setStorage({ [`site:${siteKey}`]: { enabled: true, mode } });
  // The service worker re-registers the content script on the storage change.
  await sleep(600);
  return siteKey;
}

export interface OpenedPage {
  page: Page;
  logs: string[];
}

function collectLogs(page: Page, logs: string[]): void {
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${String(error)}`));
}

export async function openPage(h: Harness, path: string): Promise<OpenedPage> {
  const page = await h.browser.newPage();
  const logs: string[] = [];
  collectLogs(page, logs);
  await page.goto(`${h.fixtures.readerUrl}${path}`);
  return { page, logs };
}

/** Opens an extension page of the build (ui/popup.html, ui/options.html, ui/sidepanel.html) in a tab. */
export async function openExtensionPage(
  h: Harness,
  name: "popup" | "options" | "sidepanel",
  query = "",
): Promise<OpenedPage> {
  const page = await h.browser.newPage();
  const logs: string[] = [];
  collectLogs(page, logs);
  await page.goto(`chrome-extension://${h.extensionId}/ui/${name}.html${query}`);
  return { page, logs };
}

/** Waits until `count` images (or every tracked image) reached a terminal state. */
export function waitImagesSettled(page: Page, count = 1, timeoutMs = 60_000): Promise<ContentSummary> {
  return waitForSummary(page, (s) => settledCount(s) >= count, timeoutMs);
}

export function settledCount(s: ContentSummary): number {
  return Object.values(s.images).filter((state) => (TERMINAL_STATES as readonly string[]).includes(state))
    .length;
}

/** Waits until every image the content script tracks is in one of `states` (at least `min` images). */
export function waitAllImages(
  page: Page,
  states: readonly string[],
  min = 1,
  timeoutMs = 60_000,
): Promise<ContentSummary> {
  return waitForSummary(
    page,
    (s) => {
      const values = Object.values(s.images);
      return values.length >= min && values.every((state) => states.includes(state));
    },
    timeoutMs,
  );
}

export interface PaintedUnit {
  /** imageKey of the overlay host. */
  image: string | null;
  unit: string | null;
  erase: string | null;
  kind: string | null;
  fontPx: number | null;
  text: string;
}

/** Painted units read from the overlay's shadow roots (open in test builds). */
export async function paintedUnits(page: Page): Promise<PaintedUnit[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll("[data-ctv-host]")].flatMap((host) =>
      [...(host.shadowRoot?.querySelectorAll(".unit") ?? [])].map((unit) => {
        const line = unit.querySelector<HTMLElement>(".line");
        return {
          image: host.getAttribute("data-ctv-image"),
          unit: unit.getAttribute("data-unit"),
          erase: unit.getAttribute("data-erase"),
          kind: unit.getAttribute("data-kind"),
          fontPx: line === null ? null : Number.parseFloat(line.style.fontSize),
          text: [...unit.querySelectorAll(".line")].map((l) => l.textContent ?? "").join(" "),
        };
      }),
    ),
  );
}

/** Waits until at least `min` units are painted, up to `timeoutMs`. */
export async function waitPainted(page: Page, min: number, timeoutMs = 30_000): Promise<PaintedUnit[]> {
  return await waitUntil(
    `${min} painted units`,
    () => paintedUnits(page),
    (units) => units.length >= min,
    timeoutMs,
  );
}

/** Overlay hosts per imageKey (one host per image is the invariant). */
export async function overlayHosts(page: Page): Promise<Record<string, number>> {
  return await page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const host of document.querySelectorAll("[data-ctv-host]")) {
      const key = host.getAttribute("data-ctv-image") ?? "?";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  });
}

/** The engine's debug log (IndexedDB ring buffer of the offscreen document). */
export async function engineLogs(browser: Browser): Promise<string[]> {
  const engine = browser.targets().find((t) => t.url().includes("offscreen.html"));
  if (engine === undefined) return ["(no offscreen target)"];
  const session = await engine.createCDPSession();
  try {
    const result = await session.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((resolve) => {
        const r = indexedDB.open("ctv");
        r.onsuccess = () => {
          const q = r.result.transaction("logs").objectStore("logs").getAll();
          q.onsuccess = () => resolve(q.result.map((e) => e.level + " " + e.msg + " " + JSON.stringify(e.data ?? {}) + (e.code ? " code=" + e.code : "")));
        };
        r.onerror = () => resolve(["cannot open ctv"]);
      })`,
    });
    return (result.result.value as string[] | undefined) ?? [JSON.stringify(result.exceptionDetails ?? null)];
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export function chatRequests(h: Harness): number {
  return h.api.requests().filter((r) => r.path === "/v1/chat/completions").length;
}

export function chats(h: Harness): ReturnType<Harness["api"]["requests"]> {
  return h.api.requests().filter((r) => r.path === "/v1/chat/completions");
}

/* ---- talking to the extension ---- */

export interface Reply<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Whether the offscreen engine document exists (asked in the service worker, which never starts it for this). */
export async function engineDocumentOpen(h: Harness): Promise<boolean> {
  return await h.sw.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    return contexts.length > 0;
  });
}

/**
 * Sends a one-shot envelope from an extension page (the engine and the service worker only accept some types from
 * ui/ pages). Returns the Reply.
 */
export async function sendFromPage<T>(
  page: Page,
  target: "sw" | "engine",
  type: string,
  payload: unknown,
): Promise<Reply<T>> {
  return await page.evaluate((envelope) => chrome.runtime.sendMessage<unknown, Reply<T>>(envelope), {
    target,
    type,
    v: PROTOCOL_VERSION,
    payload,
  });
}

/** The id of the tab showing `url` (exact match, without the fragment). */
export async function tabIdOf(h: Harness, url: string): Promise<number> {
  const id = await h.sw.evaluate(async (wanted) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === wanted)?.id ?? null;
  }, url);
  if (id === null) throw new Error(`no tab shows ${url}`);
  return id;
}

/** Sends a cs:* envelope to a tab's content script from the service worker (as its commands do). */
export async function sendToTab<T>(
  h: Harness,
  tabId: number,
  type: string,
  payload: unknown,
): Promise<Reply<T>> {
  return await h.sw.evaluate(
    (id, envelope) => chrome.tabs.sendMessage<unknown, Reply<T>>(id, envelope),
    tabId,
    { target: "cs", type, v: PROTOCOL_VERSION, payload },
  );
}

/* ---- ground truth ---- */

export interface GtUnit {
  id: number;
  kind: string;
  type: string;
  original: string;
  vi: string;
  fontPx: number;
  glyphPx: number;
}

export interface GroundTruth {
  image: string;
  width: number;
  height: number;
  lang: string;
  units: GtUnit[];
}

/** Ground truth of a generated fixture image (`ko-p01`, `chapter-ko-60/005`). */
export async function groundTruth(name: string): Promise<GroundTruth> {
  const text = await readFile(path.join(ROOT, "test/fixtures/generated", `${name}.gt.json`), "utf8");
  return JSON.parse(text) as GroundTruth;
}

/**
 * Units inside balloons and caption boxes (dialogue, thought, narration). Free text (signs, sound effects) depends
 * more on the detector's recall on synthetic lettering, so coverage targets are set on balloons.
 */
export function balloonUnits(gt: GroundTruth): GtUnit[] {
  return gt.units.filter((u) => u.kind === "bubble" && u.type !== "ignore");
}

function squash(text: string): string {
  return text.replace(/[\s­]+/gu, "");
}

/** The painted unit showing a ground-truth unit's translation (the mock's oracle answers `VI:<gt.vi>`). */
export function paintedFor(unit: GtUnit, painted: readonly PaintedUnit[]): PaintedUnit | undefined {
  const want = squash(unit.vi);
  return painted.find((p) => squash(p.text).includes(want));
}

/** Ground-truth units of `units` that have a painted translation. */
export function covered(units: readonly GtUnit[], painted: readonly PaintedUnit[]): GtUnit[] {
  return units.filter((u) => paintedFor(u, painted) !== undefined);
}

/* ---- diagnostics ---- */

/** Prints what helps to understand a failure: content summary, page console, mock requests and the engine log. */
export async function printDiagnostics(h: Harness, opened: OpenedPage | null, error: unknown): Promise<void> {
  const lines: string[] = [`--- E2E failure: ${error instanceof Error ? error.message : String(error)}`];
  if (opened !== null && !opened.page.isClosed()) {
    lines.push(`summary: ${JSON.stringify(await summary(opened.page).catch(() => null))}`);
    lines.push(`painted: ${JSON.stringify(await paintedUnits(opened.page).catch(() => []))}`);
  }
  if (opened !== null) lines.push("page console:", ...opened.logs.slice(-80));
  lines.push(
    "mock requests:",
    ...h.api
      .requests()
      .slice(-40)
      .map((r) =>
        JSON.stringify({
          path: r.path,
          status: r.status,
          outcome: r.outcome,
          n: r.n,
          oracle: r.oracle?.matched.length ?? null,
          error: r.errorCode,
          scenario: r.scenarioName,
        }),
      ),
  );
  await sleep(1_200); // the engine flushes its log batches every second
  lines.push("engine log:", ...(await engineLogs(h.browser).catch((e: unknown) => [String(e)])).slice(-80));
  console.log(lines.join("\n"));
}

/** Runs a test body; on failure prints diagnostics for `opened` (a page or a getter) and rethrows. */
export async function withDiagnostics<T>(
  h: Harness,
  opened: OpenedPage | (() => OpenedPage | null) | null,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const page = typeof opened === "function" ? opened() : opened;
    await printDiagnostics(h, page, error).catch((e: unknown) => console.log("diagnostics failed", e));
    throw error;
  }
}
