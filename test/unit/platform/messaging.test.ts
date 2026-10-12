import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  callEngine,
  callSw,
  isNoReceiver,
  onMessageFor,
  sendToTab,
} from "../../../src/platform/messaging.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import { makeEnvelope, type Reply } from "../../../src/shared/protocol.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import type { EngineStatus } from "../../../src/shared/types.ts";
import { isProbe, makeProbe } from "../../../src/shared/wire.ts";
import { FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";

let browser: FakeBrowser;
let sw: FakeContext;

beforeEach(async () => {
  browser = new FakeBrowser();
  browser.install();
  sw = await browser.startServiceWorker();
});

afterEach(() => {
  browser.uninstall();
});

async function startEngine(): Promise<FakeContext> {
  await sw.run(() =>
    sw.ext.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "test" }),
  );
  const engine = browser.offscreen;
  assert.ok(engine !== null);
  return engine;
}

function contentScript(): FakeContext {
  const tab = browser.openTab("https://reader.example/ch-1");
  return browser.injectContent(tab.id);
}

async function rejectsWith(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<CtvError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CtvError, `expected CtvError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

test("R1: the listener returns undefined for other targets and non-envelopes, true for its own async work", async () => {
  const engine = await startEngine();
  engine.run(() => onMessageFor("engine", { "en:status": () => Promise.resolve(statusFixture()) }));
  const responses: unknown[] = [];
  const respond = (reply?: unknown): void => {
    responses.push(reply);
  };
  const sender = browser.senderOf(sw);

  assert.deepEqual(engine.onMessage.dispatch({ hello: 1 }, sender, respond), [undefined]);
  assert.deepEqual(engine.onMessage.dispatch(makeEnvelope("sw", "sw:engine-state", {}), sender, respond), [
    undefined,
  ]);
  assert.deepEqual(
    engine.onMessage.dispatch({ target: "engine", type: "en:unknown", v: 1, payload: {} }, sender, respond),
    [undefined],
    "unknown type for this target",
  );
  assert.deepEqual(engine.onMessage.dispatch(makeEnvelope("engine", "en:status", {}), sender, respond), [
    true,
  ]);
  await browser.settle();
  assert.equal(responses.length, 1);
  assert.equal((responses[0] as Reply<unknown>).ok, true);
});

test("callEngine resolves sync and async handlers; errors cross as ErrorInfo and come back as CtvError", async () => {
  const engine = await startEngine();
  engine.run(() =>
    onMessageFor("engine", {
      "en:ping": (payload) => ({ probe: payload.probe, phase: "ready" as const }),
      "en:status": () => Promise.resolve(statusFixture()),
      "en:edit-unit": () => {
        throw new CtvError("store.quota", "disk full", { retryable: false, detail: "quota" });
      },
      "en:retranslate": () => Promise.reject(new Error("boom")),
    }),
  );
  const cs = contentScript();
  await cs.run(async () => {
    const ping = await callEngine("en:ping", { probe: makeProbe() });
    assert.equal(ping.phase, "ready");
    assert.equal(isProbe(ping.probe), true, "structured clone keeps the ArrayBuffer");
    const status = await callEngine("en:status", {});
    assert.deepEqual(status.api, { readiness: "ready", model: "gpt-4o-mini", cause: null, checkedAt: 0 });
    const quota = await rejectsWith(
      callEngine("en:edit-unit", { contentKey: "s:1", unitKey: "u1", translation: "x" }),
      "store.quota",
    );
    assert.equal(quota.detail, "quota");
    await rejectsWith(callEngine("en:retranslate", { tabId: 1 }), "engine.internal", /boom/);
  });
});

test("no engine: engine.unavailable within 100 ms (P1-02)", async () => {
  // The SW listens for "sw" messages only, so Chrome reports an unanswered message.
  sw.run(() => onMessageFor("sw", { "sw:engine-state": () => ({ exists: false }) }));
  const cs = contentScript();
  const started = performance.now();
  await cs.run(() => rejectsWith(callEngine("en:status", {}), "engine.unavailable", /no receiver/));
  assert.ok(performance.now() - started <= 100, `took ${performance.now() - started} ms`);

  sw.destroy();
  const bare = performance.now();
  await cs.run(() => rejectsWith(callEngine("en:status", {}), "engine.unavailable", /no receiver/));
  assert.ok(performance.now() - bare <= 100);
});

test("a handler that never answers times out as engine.unavailable", async () => {
  const engine = await startEngine();
  engine.run(() => onMessageFor("engine", { "en:status": () => new Promise<never>(() => undefined) }));
  await sw.run(() =>
    rejectsWith(callEngine("en:status", {}, { timeoutMs: 30 }), "engine.unavailable", /timed out/),
  );
});

test("R5: the sender allow-list drops messages silently", async () => {
  const engine = await startEngine();
  const seen: string[] = [];
  engine.run(() =>
    onMessageFor(
      "engine",
      { "en:status": () => statusFixture() },
      {
        allow: (type, sender) => {
          seen.push(`${type}@${sender.url ?? "?"}`);
          return sender.tab === undefined;
        },
      },
    ),
  );
  const cs = contentScript();
  await cs.run(() => rejectsWith(callEngine("en:status", {}), "engine.unavailable"));
  const fromSw = await sw.run(() => callEngine("en:status", {}));
  assert.equal(fromSw.api.readiness, "ready");
  assert.equal(seen.length, 2);
});

test("the returned function removes the listener", async () => {
  const engine = await startEngine();
  const off = engine.run(() => onMessageFor("engine", { "en:status": () => statusFixture() }));
  await sw.run(() => callEngine("en:status", {}));
  off();
  await sw.run(() => rejectsWith(callEngine("en:status", {}), "engine.unavailable"));
});

test("callSw reaches the service worker from content scripts and extension pages", async () => {
  sw.run(() =>
    onMessageFor("sw", {
      "sw:get-settings": () => ({ settings: DEFAULT_SETTINGS, sites: {} }),
      "sw:ensure-engine": (payload, sender) => ({
        created: payload.reason === "cs" && sender.tab !== undefined,
      }),
    }),
  );
  const cs = contentScript();
  const ensured = await cs.run(() => callSw("sw:ensure-engine", { reason: "cs" }));
  assert.deepEqual(ensured, { created: true });
  const popup = browser.openExtensionPage("popup", "popup.html");
  const got = await popup.run(() => callSw("sw:get-settings", {}));
  assert.equal(got.settings.api.baseUrl, DEFAULT_SETTINGS.api.baseUrl);
  assert.deepEqual(
    got.settings,
    DEFAULT_SETTINGS,
    "nullable fields (boxBudget, ackUploadNoticeAt) cross as null",
  );
});

test("sendToTab targets one frame; a frame without the content script is engine.unavailable", async () => {
  const tab = browser.openTab("https://reader.example/ch-2");
  const frame = browser.addFrame(tab.id, "https://reader.example/embed");
  const top = browser.injectContent(tab.id, 0);
  const child = browser.injectContent(tab.id, frame.frameId);
  const hits: string[] = [];
  top.run(() => onMessageFor("cs", { "cs:toggle-overlay": () => (hits.push("top"), { visible: true }) }));
  child.run(() =>
    onMessageFor("cs", { "cs:toggle-overlay": () => (hits.push("child"), { visible: false }) }),
  );

  const reply = await sw.run(() => sendToTab(tab.id, "cs:toggle-overlay", {}, { frameId: frame.frameId }));
  assert.deepEqual(reply, { visible: false });
  assert.deepEqual(hits, ["child"]);

  const other = browser.openTab("https://reader.example/ch-3");
  const missing = await sw.run(() =>
    rejectsWith(sendToTab(other.id, "cs:toggle-overlay", {}), "engine.unavailable", /no receiver/),
  );
  assert.equal(isNoReceiver(missing), true, "callers inject a content script only in this case");
});

test("isNoReceiver only matches the missing-listener case", () => {
  assert.equal(isNoReceiver(new CtvError("engine.unavailable", "cs:cs:x: no receiver")), true);
  assert.equal(isNoReceiver(new CtvError("engine.unavailable", "cs:cs:x: timed out after 3000 ms")), false);
  assert.equal(isNoReceiver(new CtvError("engine.unavailable", "cs:cs:x: no reply")), false);
  assert.equal(isNoReceiver(new CtvError("ctx.invalidated", "no receiver")), false);
  assert.equal(isNoReceiver(new Error("no receiver")), false);
});

test("an orphaned content script gets ctx.invalidated (extension reloaded)", async () => {
  const cs = contentScript();
  browser.invalidateExtension();
  await cs.run(() => rejectsWith(callSw("sw:engine-state", {}), "ctx.invalidated"));
});

test("R6: a payload that is not wire-safe is engine.protocol, never a silent loss", async () => {
  const engine = await startEngine();
  engine.run(() => onMessageFor("engine", { "en:status": () => statusFixture() }));
  const bad = { tabId: undefined } as unknown as { tabId?: number };
  await sw.run(() => rejectsWith(callEngine("en:status", bad), "engine.protocol", /serialize/));
});

test("a handler returning a non-wire-safe value rejects instead of hanging", async () => {
  const engine = await startEngine();
  engine.run(() =>
    onMessageFor("engine", { "en:status": () => ({ when: new Date(0) }) as unknown as EngineStatus }),
  );
  await sw.run(() => rejectsWith(callEngine("en:status", {}), "engine.protocol"));
});

test("JSON serialization (no structured clone): ArrayBuffer probes arrive as {}", async () => {
  browser.uninstall();
  browser = new FakeBrowser({ serialization: "json" });
  browser.install();
  sw = await browser.startServiceWorker();
  const engine = await startEngine();
  engine.run(() =>
    onMessageFor("engine", { "en:ping": (payload) => ({ probe: payload.probe, phase: "ready" as const }) }),
  );
  const ping = await sw.run(() => callEngine("en:ping", { probe: makeProbe() }));
  assert.equal(isProbe(ping.probe), false);
  assert.deepEqual(ping.probe, {});
});

function statusFixture(): EngineStatus {
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
  };
}
