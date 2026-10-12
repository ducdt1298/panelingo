import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { callSw, onMessageFor } from "../../../src/platform/messaging.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { SwApi } from "../../../src/shared/protocol.ts";
import type { Settings } from "../../../src/shared/settings.ts";
import { isProbe, makeProbe } from "../../../src/shared/wire.ts";
import { ALLOWED, isAllowed, senderKind, swAllow, swHandlers } from "../../../src/sw/router.ts";
import { FAKE_EXTENSION_ID, type FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";
import { ENGINE_DOC, engineWith, startBrowser, stopBrowser, until } from "./sw-helpers.ts";

afterEach(stopBrowser);

const ORIGIN = `chrome-extension://${FAKE_EXTENSION_ID}`;
const ALL_TYPES: ReadonlyArray<keyof SwApi> = [
  "sw:ensure-engine",
  "sw:engine-state",
  "sw:get-settings",
  "sw:site-set",
  "sw:inject",
  "sw:dnr-ensure",
  "sw:capture",
  "sw:engine-idle",
  "sw:badge",
  "sw:ack-privacy",
  "sw:ping",
];

function sender(patch: Partial<chrome.runtime.MessageSender>): chrome.runtime.MessageSender {
  return { id: FAKE_EXTENSION_ID, ...patch };
}

const TAB = { id: 3 } as chrome.tabs.Tab;

test("senderKind tells content scripts, the engine and extension pages apart", () => {
  const kind = (patch: Partial<chrome.runtime.MessageSender>): string =>
    senderKind(sender(patch), FAKE_EXTENSION_ID, ORIGIN);
  assert.equal(kind({ url: "https://reader.example/ch/1", tab: TAB }), "content");
  assert.equal(kind({ url: "about:blank", tab: TAB }), "content");
  assert.equal(kind({ url: `${ORIGIN}/${ENGINE_DOC}` }), "engine");
  assert.equal(kind({ url: `${ORIGIN}/ui/popup.html` }), "page");
  assert.equal(
    kind({ url: `${ORIGIN}/ui/options.html#privacy`, tab: TAB }),
    "page",
    "options opened in a tab",
  );
  assert.equal(kind({ url: `${ORIGIN}/ui/sidepanel.html` }), "page");
  assert.equal(kind({ url: `${ORIGIN}/ui/debug.html` }), "page");
  assert.equal(kind({ url: `${ORIGIN}/sw.js` }), "other");
  assert.equal(kind({ url: `${ORIGIN}/ui/unknown.html` }), "other");
  assert.equal(kind({ url: `${ORIGIN}/engine/offscreen.html.evil` }), "other");
  assert.equal(kind({ url: "https://reader.example/" }), "other", "no tab, not ours");
  assert.equal(senderKind(sender({ id: "another-extension", tab: TAB }), FAKE_EXTENSION_ID, ORIGIN), "other");
  assert.equal(senderKind(sender({ url: `${ORIGIN}/ui/popup.html` }), "", ""), "other", "invalidated");
});

test("R5 allow-list: exactly the documented operations per sender kind", () => {
  assert.deepEqual([...ALLOWED.content].sort(), ["sw:ack-privacy", "sw:ensure-engine"]);
  assert.deepEqual([...ALLOWED.engine].sort(), [
    "sw:badge",
    "sw:capture",
    "sw:dnr-ensure",
    "sw:engine-idle",
    "sw:get-settings",
    "sw:ping",
  ]);
  assert.deepEqual([...ALLOWED.page].sort(), [
    "sw:ack-privacy",
    "sw:engine-state",
    "sw:ensure-engine",
    "sw:get-settings",
    "sw:inject",
    "sw:site-set",
  ]);
  for (const type of ALL_TYPES) assert.equal(isAllowed(type, "other"), false, type);
  assert.equal(isAllowed("sw:unknown", "page"), false);
  for (const type of ALL_TYPES) assert.ok(swHandlers[type] !== undefined, `handler for ${type}`);
});

async function routed(): Promise<{ browser: FakeBrowser; sw: FakeContext; engine: FakeContext }> {
  const { browser, sw } = await startBrowser(
    engineWith({ "en:prepare-close": () => ({ ok: true }), "en:settings": () => ({}) }),
  );
  sw.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
  await sw.run(() =>
    sw.ext.offscreen.createDocument({
      url: ENGINE_DOC,
      reasons: ["WORKERS", "BLOBS"],
      justification: "test",
    }),
  );
  assert.ok(browser.offscreen !== null);
  return { browser, sw, engine: browser.offscreen };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof CtvError ? error.code : `not CtvError: ${String(error)}`;
  }
}

test("through chrome messaging, each sender kind reaches only its allowed handlers", async () => {
  const { browser, engine } = await routed();
  const tab = browser.openTab("https://reader.example/ch/1");
  const cs = browser.injectContent(tab.id);
  const popup = browser.openExtensionPage("popup", "ui/popup.html");

  // Content scripts: the engine and the privacy acknowledgement only.
  assert.equal(await codeOf(cs.run(() => callSw("sw:ensure-engine", { reason: "cs" }))), "ok");
  assert.equal(await codeOf(cs.run(() => callSw("sw:ack-privacy", {}))), "ok");
  for (const type of ["sw:get-settings", "sw:engine-state", "sw:capture", "sw:ping"] as const) {
    const payload =
      type === "sw:capture" ? capturePayload() : type === "sw:ping" ? { probe: makeProbe() } : {};
    assert.equal(
      await codeOf(cs.run(() => callSw(type, payload as never))),
      "engine.unavailable",
      `content must not reach ${type}`,
    );
  }
  // Extension pages: user operations, not the engine-only ones.
  assert.equal(await codeOf(popup.run(() => callSw("sw:engine-state", {}))), "ok");
  assert.equal(await codeOf(popup.run(() => callSw("sw:get-settings", {}))), "ok");
  assert.equal(
    await codeOf(popup.run(() => callSw("sw:badge", { tabId: null, text: "x", tone: "busy" }))),
    "engine.unavailable",
  );
  assert.equal(
    await codeOf(
      popup.run(() => callSw("sw:dnr-ensure", { host: "a.example", referer: null, removeOrigin: false })),
    ),
    "engine.unavailable",
  );
  // The engine: its own operations, not the user ones.
  assert.equal(await codeOf(engine.run(() => callSw("sw:get-settings", {}))), "ok");
  assert.equal(await codeOf(engine.run(() => callSw("sw:inject", { tabId: tab.id }))), "engine.unavailable");
  assert.equal(
    await codeOf(engine.run(() => callSw("sw:site-set", { siteKey: "https://a.example", patch: {} }))),
    "engine.unavailable",
  );
});

function capturePayload(): SwApi["sw:capture"][0] {
  return {
    tabId: 1,
    rect: { left: 0, top: 0, width: 10, height: 10 },
    viewport: { w: 100, h: 100 },
    codec: "sc",
  };
}

test("engine operations: settings, ping, DNR rule, capture, badge, idle close", async () => {
  const { browser, engine } = await routed();
  browser.storageSet("local", {
    settings: { api: { concurrency: 3, apiKey: "sk-test", temperature: null } },
  });

  const snapshot = await engine.run(() => callSw("sw:get-settings", {}));
  assert.equal(snapshot.settings.api.concurrency, 3);
  assert.equal(snapshot.settings.api.apiKey, "sk-test");
  assert.equal(snapshot.settings.api.temperature, null);
  assert.deepEqual(snapshot.sites, {});

  const pong = await engine.run(() => callSw("sw:ping", { probe: makeProbe() }));
  assert.equal(isProbe(pong.probe), true, "the probe comes back as the same bytes");

  const { ruleId } = await engine.run(() =>
    callSw("sw:dnr-ensure", {
      host: "cdn.example",
      referer: "https://reader.example/ch/1",
      removeOrigin: true,
    }),
  );
  assert.ok(ruleId >= 1000);
  assert.equal(
    browser.sessionRules.find((rule) => rule.id === ruleId)?.condition.requestDomains?.[0],
    "cdn.example",
  );
  browser.failNext("declarativeNetRequest.updateSessionRules", "Internal error.");
  assert.equal(
    await codeOf(
      engine.run(() => callSw("sw:dnr-ensure", { host: "x.example", referer: null, removeOrigin: false })),
    ),
    "dnr.failed",
  );

  assert.equal(
    await codeOf(engine.run(() => callSw("sw:capture", capturePayload()))),
    "image.capture_blocked",
    "no such tab: nothing is captured (sw/capture.ts is covered in capture.test.ts)",
  );

  await engine.run(() => callSw("sw:badge", { tabId: 7, text: "3", tone: "busy" }));
  await until(() => browser.badges.get("7")?.color === "#1a73e8", "badge colour");
  assert.equal(browser.badges.get("7")?.text, "3");

  assert.deepEqual(await engine.run(() => callSw("sw:engine-idle", { idleSinceMs: 600_000 })), {
    closing: true,
  });
  assert.equal(browser.offscreen, null, "the idle engine was closed");
});

test("page operations: engine state and ensure, site-set (validated), inject (manual), ack-privacy", async () => {
  const { browser } = await startBrowser();
  browser.serviceWorker?.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
  const popup = browser.openExtensionPage("popup", "ui/popup.html");
  const tab = browser.openTab("https://reader.example/ch/1");

  assert.deepEqual(await popup.run(() => callSw("sw:engine-state", {})), { exists: false });
  assert.deepEqual(await popup.run(() => callSw("sw:ensure-engine", { reason: "ui" })), { created: true });
  assert.deepEqual(await popup.run(() => callSw("sw:engine-state", {})), { exists: true });

  assert.equal(
    await codeOf(
      popup.run(() =>
        callSw("sw:site-set", { siteKey: "https://reader.example/", patch: { enabled: true } }),
      ),
    ),
    "engine.internal",
  );
  const set = await popup.run(() =>
    callSw("sw:site-set", { siteKey: "https://reader.example", patch: { enabled: true }, tabId: tab.id }),
  );
  assert.deepEqual(set, { registered: true });
  assert.deepEqual(browser.registeredScripts.get("ctv-main")?.matches, ["https://reader.example/*"]);

  const other = browser.openTab("https://elsewhere.example/");
  assert.deepEqual(await popup.run(() => callSw("sw:inject", { tabId: other.id })), { injected: true });
  assert.deepEqual(
    browser.executeScriptCalls.slice(-2).map((call) => [call.tabId, call.hasFunc]),
    [
      [other.id, true],
      [other.id, false],
    ],
  );
  delete (globalThis as { __ctvManual?: number }).__ctvManual;

  const before = Date.now();
  const { at } = await popup.run(() => callSw("sw:ack-privacy", {}));
  assert.ok(at >= before);
  assert.equal((browser.storageGet("local", "settings") as Settings).privacy.ackUploadNoticeAt, at);
});

test("messages from content scripts of the same extension ack the privacy notice too", async () => {
  const { browser, sw } = await startBrowser();
  sw.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
  const tab = browser.openTab("https://not-enabled.example/");
  const cs = browser.injectContent(tab.id);
  const { at } = await cs.run(() => callSw("sw:ack-privacy", {}));
  assert.equal((browser.storageGet("local", "settings") as Settings).privacy.ackUploadNoticeAt, at);
});
