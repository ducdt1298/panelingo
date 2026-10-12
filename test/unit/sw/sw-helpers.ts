// Shared helpers for the service-worker tests (imported by *.test.ts; not a test file itself).

import { onMessageFor, type Handlers } from "../../../src/platform/messaging.ts";
import type { CsApi, EngineApi } from "../../../src/shared/protocol.ts";
import type { EngineStatus } from "../../../src/shared/types.ts";
import { FakeBrowser, type FakeBrowserOptions, type FakeContext } from "../../support/chrome-fake.ts";

export const ENGINE_DOC = "engine/offscreen.html";

let current: FakeBrowser | null = null;

/** A fresh fake Chrome with the global installed and the service worker started. */
export async function startBrowser(
  options: FakeBrowserOptions = {},
): Promise<{ browser: FakeBrowser; sw: FakeContext }> {
  current?.uninstall();
  const browser = new FakeBrowser(options);
  browser.install();
  current = browser;
  const sw = await browser.startServiceWorker();
  return { browser, sw };
}

/** Waits until no fake chrome API has been called for `quietTurns` macrotasks (background SW work finished). */
export async function quiesce(browser: FakeBrowser, quietTurns = 20, maxTurns = 5000): Promise<void> {
  let seen = browser.calls.length;
  let quiet = 0;
  for (let turn = 0; turn < maxTurns && quiet < quietTurns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (browser.calls.length === seen) {
      quiet += 1;
    } else {
      seen = browser.calls.length;
      quiet = 0;
    }
  }
}

/** afterEach: lets background work of the test finish, so it never leaks into the next test's browser. */
export async function stopBrowser(): Promise<void> {
  const browser = current;
  current = null;
  if (browser === null) return;
  await quiesce(browser);
  browser.uninstall();
}

/**
 * Waits until `cond()` holds. SW work runs on fake-API gates and timers that browser.settle() does not track,
 * so tests poll: immediate turns first, then 1 ms timers, up to `timeoutMs`.
 */
export async function until(cond: () => boolean, what = "condition", timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let turn = 0; ; turn += 1) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => (turn < 200 ? setImmediate(resolve) : setTimeout(resolve, 1)));
  }
}

export function callCount(browser: FakeBrowser, api: string): number {
  return browser.calls.filter((call) => call === api).length;
}

/** onOffscreenCreated hook that installs these en:* handlers in every engine document. */
export function engineWith(handlers: Handlers<EngineApi>): Pick<FakeBrowserOptions, "onOffscreenCreated"> {
  return {
    onOffscreenCreated: () => {
      onMessageFor("engine", handlers);
    },
  };
}

/** onContentInjected hook that installs these cs:* handlers in every injected frame. */
export function contentWith(handlers: Handlers<CsApi>): Pick<FakeBrowserOptions, "onContentInjected"> {
  return {
    onContentInjected: () => {
      onMessageFor("cs", handlers);
    },
  };
}

export function statusFixture(patch: Partial<EngineStatus> = {}): EngineStatus {
  return {
    phase: "ready",
    build: "test",
    api: { readiness: "ready", model: "gpt-4o-mini", cause: null, checkedAt: 0 },
    detector: { backend: "webgpu", state: "ready", canary: "pass" },
    queue: {
      queued: 0,
      inFlight: 0,
      urgentInFlight: 0,
      done: 0,
      failed: 0,
      pausedBy: null,
      concurrency: 2,
      boxBudget: 20,
    },
    uploads: { today: 0, bytesToday: 0 },
    ...patch,
  };
}
