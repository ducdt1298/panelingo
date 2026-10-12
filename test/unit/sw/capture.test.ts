// sw:capture: captureVisibleTab of the engine's frame tab only when it is the active tab of the last focused window,
// throttled per window (≥ 600 ms between captures), one retry after a quota refusal, PNG scale and visible part.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CtvError } from "../../../src/shared/errors.ts";
import type { Clock } from "../../../src/shared/clock.ts";
import type { SwApi } from "../../../src/shared/protocol.ts";
import { createTabCapturer, dataUrlToBytes } from "../../../src/sw/capture.ts";
import { CHROME_ERRORS, type FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";
import { startBrowser, stopBrowser } from "./sw-helpers.ts";

afterEach(stopBrowser);

/** A PNG whose IHDR says w×h (enough for readImageSize; never decoded here). */
function pngDataUrl(w: number, h: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(w, 16);
  bytes.writeUInt32BE(h, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

class StepClock implements Clock {
  t = 1_000_000;
  private timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  /** Lets fake-API turns run, firing timers due within `ms` in order. */
  async run(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      for (let i = 0; i < 30; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      const due = this.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

interface Setup {
  browser: FakeBrowser;
  sw: FakeContext;
  clock: StepClock;
  capture(request: Partial<SwApi["sw:capture"][0]> & { tabId: number }): Promise<SwApi["sw:capture"][1]>;
}

async function setup(onCapture?: (browser: FakeBrowser) => void): Promise<Setup> {
  const clock = new StepClock();
  let current: FakeBrowser | null = null;
  const { browser, sw } = await startBrowser({
    now: () => clock.t,
    captureVisibleTab: () => {
      if (current !== null) onCapture?.(current);
      return pngDataUrl(2560, 1800);
    },
  });
  current = browser;
  // Throttle timers fire outside sw.run(): they still belong to the service worker.
  browser.setDefaultContext(sw);
  const capturer = createTabCapturer({ clock });
  return {
    browser,
    sw,
    clock,
    capture: (request) => {
      const result = sw.run(() =>
        capturer.capture({
          rect: { left: 40, top: -100, width: 1200, height: 1800 },
          viewport: { w: 1280, h: 900 },
          codec: "sc",
          ...request,
        }),
      );
      void result.catch(() => undefined);
      return result;
    },
  };
}

async function errorOf(promise: Promise<unknown>, clock: StepClock, ms = 5_000): Promise<CtvError> {
  await clock.run(ms);
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CtvError, String(error));
    return error;
  }
  throw new Error("expected a rejection");
}

test("captures the active tab of the focused window: PNG bytes, device scale and the visible part", async () => {
  const s = await setup();
  const tab = s.browser.openTab("https://reader.example/ch/1");
  const pending = s.capture({ tabId: tab.id });
  await s.clock.run(0);
  const reply = await pending;
  assert.ok(reply.png instanceof ArrayBuffer);
  assert.equal(new Uint8Array(reply.png)[1], 80, "PNG signature");
  assert.equal(reply.scale, 2);
  assert.deepEqual(reply.visible, { left: 40, top: 0, width: 1200, height: 900 });
  const b64 = s.capture({ tabId: tab.id, codec: "b64" });
  await s.clock.run(600);
  assert.ok(typeof (await b64).png === "object" && "b64" in (await b64).png, "base64 codec");
});

test("captures of one window start at least 600 ms apart (Chrome's quota is 2 per second)", async () => {
  const s = await setup();
  const tab = s.browser.openTab("https://reader.example/ch/1");
  const all = Promise.all([1, 2, 3, 4].map(() => s.capture({ tabId: tab.id })));
  await s.clock.run(2_000);
  await all;
  const times = s.browser.captureTimes;
  assert.equal(times.length, 4);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok((times[i] ?? 0) - (times[i - 1] ?? 0) >= 600, JSON.stringify(times));
  }
  // One more, long after: no wait.
  await s.clock.run(5_000);
  const late = s.capture({ tabId: tab.id });
  await s.clock.run(0);
  await late;
  assert.equal(s.browser.captureTimes.length, 5);
});

test("refused unless the tab is what the user looks at: hidden tab, other window, minimized, gone", async () => {
  const s = await setup();
  const back = s.browser.openTab("https://reader.example/ch/1");
  const front = s.browser.openTab("https://other.example/");
  let error = await errorOf(s.capture({ tabId: back.id }), s.clock);
  assert.equal(error.code, "image.capture_blocked");
  assert.equal(error.detail, "hidden");
  s.browser.activateTab(back.id);
  s.browser.lastFocusedWindow = 2;
  s.browser.openTab("https://elsewhere.example/", { windowId: 2 });
  error = await errorOf(s.capture({ tabId: back.id }), s.clock);
  assert.equal(error.detail, "unfocused");
  s.browser.lastFocusedWindow = 1;
  s.browser.windowStates.set(1, "minimized");
  error = await errorOf(s.capture({ tabId: back.id }), s.clock);
  assert.equal(error.detail, "hidden");
  error = await errorOf(s.capture({ tabId: 999 }), s.clock);
  assert.equal(error.detail, "tab");
  assert.equal(s.browser.captureTimes.length, 0, "nothing was captured");
  void front;
});

test("a tab switch during the capture discards the picture", async () => {
  let other = 0;
  const s = await setup((browser) => browser.activateTab(other));
  const tab = s.browser.openTab("https://reader.example/ch/1");
  other = s.browser.openTab("https://other.example/", { active: false }).id;
  const error = await errorOf(s.capture({ tabId: tab.id }), s.clock);
  assert.equal(error.code, "image.capture_blocked");
  assert.equal(s.browser.captureTimes.length, 1, "captured, then refused");
});

test("a quota refusal waits and retries once; a second one is reported", async () => {
  const s = await setup();
  const tab = s.browser.openTab("https://reader.example/ch/1");
  s.browser.failNext("tabs.captureVisibleTab", CHROME_ERRORS.captureQuota);
  const ok = s.capture({ tabId: tab.id });
  await s.clock.run(1_000);
  assert.equal((await ok).scale, 2);
  s.browser.failNext("tabs.captureVisibleTab", CHROME_ERRORS.captureQuota, 2);
  const error = await errorOf(s.capture({ tabId: tab.id }), s.clock);
  assert.equal(error.code, "image.capture_unavailable");
  assert.equal(error.detail, "quota");
  s.browser.failNext("tabs.captureVisibleTab", "Cannot access contents of the page.");
  const denied = await errorOf(s.capture({ tabId: tab.id }), s.clock);
  assert.equal(denied.code, "image.capture_blocked");
  assert.equal(denied.detail, "denied");
});

test("invalid requests and data URLs", async () => {
  const s = await setup();
  const tab = s.browser.openTab("https://reader.example/ch/1");
  let error = await errorOf(s.capture({ tabId: tab.id, viewport: { w: 0, h: 900 } }), s.clock);
  assert.equal(error.code, "engine.protocol");
  error = await errorOf(
    s.capture({ tabId: tab.id, rect: { left: Number.NaN, top: 0, width: 1, height: 1 } }),
    s.clock,
  );
  assert.equal(error.code, "engine.protocol");
  error = await errorOf(s.capture({ tabId: -1 }), s.clock);
  assert.equal(error.code, "image.capture_blocked");
  assert.deepEqual([...dataUrlToBytes("data:image/png;base64,AAEC")], [0, 1, 2]);
  assert.throws(() => dataUrlToBytes("data:image/png,raw"), /base64 data URL/);
});
