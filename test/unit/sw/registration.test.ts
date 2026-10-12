import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onMessageFor } from "../../../src/platform/messaging.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import { msg } from "../../../src/shared/i18n/index.ts";
import {
  CONTENT_SCRIPT_FILE,
  CONTENT_SCRIPT_ID,
  contentScriptFor,
  injectAllFrames,
  injectIntoTab,
  sameRegistration,
  sendOrInject,
  setSite,
  syncContentScripts,
} from "../../../src/sw/registration.ts";
import { callCount, contentWith, startBrowser, stopBrowser } from "./sw-helpers.ts";

afterEach(stopBrowser);

function site(patch: Record<string, unknown>): Record<string, unknown> {
  return { enabled: true, addedAt: 1, ...patch };
}

test("no enabled site: nothing is registered", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", { "site:https://off.example": site({ enabled: false }) });
  const result = await sw.run(() => syncContentScripts());
  assert.deepEqual(result, { registered: false, matches: [], change: "unchanged" });
  assert.equal(browser.registeredScripts.size, 0);
});

test("registration follows site changes: register, update in place, no-op, unregister", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", { "site:http://127.0.0.1:8080": site({}) });
  assert.equal((await sw.run(() => syncContentScripts())).change, "registered");
  assert.deepEqual(browser.registeredScripts.get(CONTENT_SCRIPT_ID), {
    id: "ctv-main",
    js: ["content/main.js"],
    matches: ["http://127.0.0.1:8080/*"],
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
    runAt: "document_idle",
    world: "ISOLATED",
  });

  browser.storageSet("local", {
    "site:https://comic.example": site({
      includeSubdomains: true,
      extraFrameOrigins: ["https://viewer.example"],
    }),
  });
  const updated = await sw.run(() => syncContentScripts());
  assert.equal(updated.change, "updated");
  assert.deepEqual(browser.registeredScripts.get(CONTENT_SCRIPT_ID)?.matches, [
    "http://127.0.0.1:8080/*",
    "https://*.comic.example/*",
    "https://viewer.example/*",
  ]);
  assert.equal(callCount(browser, "scripting.registerContentScripts"), 1);

  assert.equal((await sw.run(() => syncContentScripts())).change, "unchanged");
  assert.equal(callCount(browser, "scripting.updateContentScripts"), 1, "no churn when nothing changed");

  browser.storageSet("local", {
    "site:http://127.0.0.1:8080": site({ enabled: false }),
    "site:https://comic.example": site({ enabled: false }),
  });
  assert.equal((await sw.run(() => syncContentScripts())).change, "unregistered");
  assert.equal(browser.registeredScripts.size, 0);
});

test("concurrent syncs are serialized: no duplicate registration error", async () => {
  const { browser, sw } = await startBrowser();
  browser.storageSet("local", { "site:https://a.example": site({}), "site:https://b.example": site({}) });
  const results = await sw.run(() => Promise.all(Array.from({ length: 5 }, () => syncContentScripts())));
  assert.deepEqual(
    results.map((result) => result.change),
    ["registered", "unchanged", "unchanged", "unchanged", "unchanged"],
  );
  assert.equal(browser.registeredScripts.size, 1);
});

test("sameRegistration ignores omitted defaults and match order", () => {
  const script = contentScriptFor(["https://b.example/*", "https://a.example/*"]);
  assert.equal(
    sameRegistration(script, {
      id: "ctv-main",
      js: [CONTENT_SCRIPT_FILE],
      matches: ["https://a.example/*", "https://b.example/*"],
      allFrames: true,
      matchOriginAsFallback: true,
    }),
    true,
  );
  assert.equal(sameRegistration(script, { ...script, allFrames: false }), false);
  assert.equal(sameRegistration(script, { ...script, matches: ["https://a.example/*"] }), false);
});

test("manual injection runs the flag function before the content script, in the ISOLATED world", async () => {
  const { browser, sw } = await startBrowser();
  const tab = browser.openTab("https://not-enabled.example/ch/1");
  const frame = browser.addFrame(tab.id, "https://not-enabled.example/viewer");
  const globals = globalThis as { __ctvManual?: number };
  delete globals.__ctvManual;
  const before = Date.now();

  assert.deepEqual(await sw.run(() => injectIntoTab(tab.id, undefined, true)), { injected: true });
  assert.deepEqual(
    browser.executeScriptCalls.map((call) => [call.hasFunc, call.files, call.frameIds, call.world]),
    [
      [true, [], [0], "ISOLATED"],
      [false, [CONTENT_SCRIPT_FILE], [0], "ISOLATED"],
    ],
  );
  assert.ok(
    (globals.__ctvManual ?? 0) >= before,
    "the injected function sets globalThis.__ctvManual = Date.now()",
  );
  delete globals.__ctvManual;

  await sw.run(() => injectIntoTab(tab.id, frame.frameId, true));
  assert.deepEqual(
    browser.executeScriptCalls.slice(2).map((call) => [call.hasFunc, call.frameIds]),
    [
      [true, [frame.frameId]],
      [false, [frame.frameId]],
    ],
  );
  delete globals.__ctvManual;

  await sw.run(() => injectIntoTab(tab.id, undefined, false));
  assert.equal(browser.executeScriptCalls.at(-1)?.hasFunc, false, "auto injection sets no flag");
  assert.equal(browser.executeScriptCalls.length, 5);
  assert.equal(browser.contentContexts(tab.id).length, 3);
});

test("injection failures resolve injected: false; injectAllFrames reaches every frame", async () => {
  const { browser, sw } = await startBrowser();
  assert.deepEqual(await sw.run(() => injectIntoTab(999, undefined, true)), { injected: false });
  assert.deepEqual(await sw.run(() => injectAllFrames(999)), { injected: false });
  const tab = browser.openTab("https://reader.example/1");
  browser.addFrame(tab.id, "https://reader.example/frame");
  browser.addFrame(tab.id, "https://ads.example/");
  assert.deepEqual(await sw.run(() => injectAllFrames(tab.id)), { injected: true });
  assert.deepEqual(browser.executeScriptCalls.at(-1)?.frameIds, [0, 1, 2]);
});

test("sendOrInject: delivers directly when a content script listens", async () => {
  const seen: string[] = [];
  const { browser, sw } = await startBrowser();
  const tab = browser.openTab("https://reader.example/1");
  const cs = browser.injectContent(tab.id);
  cs.run(() =>
    onMessageFor("cs", {
      "cs:translate-image": (payload) => {
        seen.push(payload.srcUrl);
        return { found: true };
      },
    }),
  );
  const reply = await sw.run(() =>
    sendOrInject(tab.id, 0, "cs:translate-image", { srcUrl: "https://cdn.example/1.jpg", force: false }),
  );
  assert.deepEqual(reply, { found: true });
  assert.deepEqual(seen, ["https://cdn.example/1.jpg"]);
  assert.equal(browser.executeScriptCalls.length, 0);
});

test("sendOrInject: without a receiver it injects in manual mode into that frame and retries", async () => {
  const seen: Array<{ srcUrl: string; force: boolean }> = [];
  const { browser, sw } = await startBrowser(
    contentWith({
      "cs:translate-image": (payload) => {
        seen.push(payload);
        return { found: true };
      },
    }),
  );
  const tab = browser.openTab("https://other.example/1");
  const frame = browser.addFrame(tab.id, "https://other.example/viewer");
  const reply = await sw.run(() =>
    sendOrInject(tab.id, frame.frameId, "cs:translate-image", { srcUrl: "blob:x", force: true }),
  );
  assert.deepEqual(reply, { found: true });
  assert.deepEqual(seen, [{ srcUrl: "blob:x", force: true }]);
  assert.deepEqual(
    browser.executeScriptCalls.map((call) => [call.hasFunc, call.frameIds]),
    [
      [true, [frame.frameId]],
      [false, [frame.frameId]],
    ],
  );
});

test("sendOrInject: unscriptable page or silent script → null; a closed tab is an error", async () => {
  const { browser, sw } = await startBrowser();
  const tab = browser.openTab("chrome://extensions/");
  browser.failNext("scripting.executeScript", "Cannot access a chrome:// URL");
  assert.equal(await sw.run(() => sendOrInject(tab.id, undefined, "cs:translate-visible", {})), null);

  const quiet = browser.openTab("https://quiet.example/");
  // Injection succeeds but nothing ever listens (e.g. the script exits at once).
  assert.equal(
    await sw.run(() => sendOrInject(quiet.id, undefined, "cs:translate-visible", {}, [0, 1])),
    null,
  );
  assert.equal(browser.executeScriptCalls.length, 2);

  await assert.rejects(
    sw.run(() => sendOrInject(999, undefined, "cs:translate-visible", {})),
    (error: unknown) => error instanceof CtvError && /No tab with id/.test(error.message),
  );
});

test("setSite with a tab: enabling injects into every frame at once, disabling tears the overlays down", async () => {
  const teardowns: string[] = [];
  const { browser, sw } = await startBrowser(
    contentWith({
      "cs:teardown": (payload) => {
        teardowns.push(payload.reason);
        return {};
      },
    }),
  );
  const tab = browser.openTab("https://reader.example/ch/1");
  browser.addFrame(tab.id, "https://reader.example/frame");

  const enabled = await sw.run(() => setSite("https://reader.example", { enabled: true }, tab.id));
  assert.equal(enabled.registered, true);
  assert.equal(enabled.site.enabled, true);
  assert.deepEqual(browser.executeScriptCalls.at(-1)?.frameIds, [0, 1]);
  assert.equal(browser.executeScriptCalls.at(-1)?.hasFunc, false, "auto mode, no manual flag");
  assert.equal(browser.badges.get(String(tab.id))?.title, msg().ui.appName, "consent hint cleared");

  const again = await sw.run(() => setSite("https://reader.example", { mode: "manual" }, tab.id));
  assert.equal(again.site.mode, "manual");
  assert.equal(browser.executeScriptCalls.length, 1, "no re-injection when enabled did not change");

  const disabled = await sw.run(() => setSite("https://reader.example", { enabled: false }, tab.id));
  assert.equal(disabled.registered, false);
  assert.deepEqual(teardowns.sort(), ["site-disabled", "site-disabled"]);
  assert.equal(browser.registeredScripts.size, 0);
});
