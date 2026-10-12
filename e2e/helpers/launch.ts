// Launches Chrome with the built extension (dist/, `npm run build:test`), the fixture server and the mock
// OpenAI-compatible server, all on ephemeral ports. The extension is pointed at the mock, never at a real AI endpoint.

import path from "node:path";
import puppeteer, { TargetType, type Browser, type Page, type WebWorker } from "puppeteer-core";
import { createFixtureServer, type FixtureServer } from "../../tools/fixture-server/server.ts";
import { createMockServer, type MockServer, type MockServerOptions } from "../../tools/mock-openai/server.ts";
import { ROOT, chromePath, extensionDir } from "./chrome.ts";

export interface Harness {
  browser: Browser;
  sw: WebWorker;
  extensionId: string;
  fixtures: FixtureServer;
  /** The mock OpenAI-compatible server the extension talks to. */
  api: MockServer;
  /**
   * Writes chrome.storage.local keys through the service worker. A `settings` value replaces the stored object (the
   * extension fills what is missing from the defaults, including the public default endpoint): use patchSettings.
   */
  setStorage(items: Record<string, unknown>): Promise<void>;
  /** Deep-merges a patch into the stored settings, keeping the mock endpoint and the fixture hosts. */
  patchSettings(patch: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Show the browser window (default: CTV_HEADED=1); headed runs get real WebGPU and captureVisibleTab. */
  headed?: boolean;
  api?: MockServerOptions;
  /** Settings patch merged over the test defaults. */
  settings?: Record<string, unknown>;
}

export async function launch(options: LaunchOptions = {}): Promise<Harness> {
  const fixtures = await createFixtureServer({
    root: path.join(ROOT, "test/fixtures"),
    readerPort: 0,
    cdnPort: 0,
    quiet: true,
  });
  const api = await createMockServer({
    port: 0,
    gtDir: path.join(ROOT, "test/fixtures/generated"),
    replayDir: path.join(ROOT, "test/fixtures/sse"),
    ...options.api,
  });
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: !(options.headed ?? process.env.CTV_HEADED === "1"),
    pipe: true,
    enableExtensions: [extensionDir()],
  });
  try {
    const target = await browser.waitForTarget(
      (t) =>
        t.type() === TargetType.SERVICE_WORKER &&
        t.url().startsWith("chrome-extension://") &&
        t.url().endsWith("/sw.js"),
      { timeout: 15_000 },
    );
    const sw = await target.worker();
    if (sw === null) throw new Error("service worker target has no worker handle");
    const extensionId = new URL(target.url()).host;
    const setStorage = async (items: Record<string, unknown>): Promise<void> => {
      await sw.evaluate((value) => chrome.storage.local.set(value), items);
    };
    const patchSettings = async (patch: Record<string, unknown>): Promise<void> => {
      await sw.evaluate(async (value) => {
        const merge = (base: unknown, next: unknown): unknown => {
          const isObject = (v: unknown): v is Record<string, unknown> =>
            typeof v === "object" && v !== null && !Array.isArray(v);
          if (!isObject(base) || !isObject(next)) return next;
          const out: Record<string, unknown> = { ...base };
          for (const [key, v] of Object.entries(next)) out[key] = merge(base[key], v);
          return out;
        };
        const { settings } = await chrome.storage.local.get("settings");
        await chrome.storage.local.set({ settings: merge(settings ?? {}, value) });
      }, patch);
    };
    // onInstalled seeds test settings with a read-merge-write; writing before it finishes would be overwritten.
    for (let i = 0; i < 100; i += 1) {
      const seeded = await sw.evaluate(async () => {
        const stored = await chrome.storage.local.get("settings");
        const settings = stored.settings as { privacy?: { devFixtureHosts?: unknown[] } } | undefined;
        return (settings?.privacy?.devFixtureHosts?.length ?? 0) > 0;
      });
      if (seeded) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const reader = new URL(fixtures.readerUrl);
    const cdn = new URL(fixtures.cdnUrl);
    const detector = process.env.CTV_DETECTOR; // "wasm" reproduces CI machines without WebGPU
    await patchSettings({
      api: { baseUrl: api.baseUrl, model: api.model, apiKey: "" },
      privacy: { devFixtureHosts: [reader.host, cdn.host], ackUploadNoticeAt: Date.now() },
      debug: { logLevel: process.env.CTV_LOG_LEVEL ?? "info" },
      ...(detector === undefined || detector === "" ? {} : { detector: { backend: detector } }),
    });
    // Deep-merged, so a patch cannot drop the mock endpoint by accident.
    if (options.settings !== undefined) await patchSettings(options.settings);
    return {
      browser,
      sw,
      extensionId,
      fixtures,
      api,
      setStorage,
      patchSettings,
      close: async () => {
        await browser.close();
        await Promise.allSettled([fixtures.close(), api.close()]);
      },
    };
  } catch (error) {
    await browser.close();
    await Promise.allSettled([fixtures.close(), api.close()]);
    throw error;
  }
}

/** src/content/test-hooks.ts PublishedSummary, as parsed by the tests. */
export interface ContentSummary {
  mode: string;
  client: string;
  frameKey: string | null;
  /** imageKey → engine ImageState or a local stage (tracked, queued, reading, submitted). */
  images: Record<string, string>;
  painted: Record<string, number>;
  paintedTotal: number;
  /** imageKeys read from a screen capture. */
  lowRes: string[];
  /** imageKeys submitted as tier-B prefetch candidates, translation not asked yet. */
  prefetch: string[];
  /** imageKey → element id. */
  ids: Record<string, string>;
  /** imageKey → current error code. */
  errors: Record<string, string>;
  tornDown: boolean;
  seq: number;
}

/** Reads the content script's test summary (src/content/test-hooks.ts) from the page. */
export async function summary(page: Page): Promise<ContentSummary | null> {
  const raw = await page.evaluate(() => document.documentElement.dataset.ctvTest ?? null);
  return raw === null ? null : (JSON.parse(raw) as ContentSummary);
}

export async function waitForSummary(
  page: Page,
  done: (s: ContentSummary) => boolean,
  timeoutMs = 60_000,
): Promise<ContentSummary> {
  const started = Date.now();
  let last: ContentSummary | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await summary(page);
    if (last !== null && done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out; last summary: ${JSON.stringify(last)}`);
}
