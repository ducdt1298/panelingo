import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { callSw, onMessageFor } from "../../../src/platform/messaging.ts";
import type { Settings, SiteSettings } from "../../../src/shared/settings.ts";
import { closeEngineIfIdle, engineExists, ensureEngine, findEngine } from "../../../src/sw/engine-host.ts";
import { swAllow, swHandlers } from "../../../src/sw/router.ts";
import { CHROME_ERRORS } from "../../support/chrome-fake.ts";
import { callCount, ENGINE_DOC, engineWith, startBrowser, stopBrowser, until } from "./sw-helpers.ts";

afterEach(stopBrowser);

test("20 concurrent ensureEngine calls create exactly one offscreen document", async () => {
  const { browser, sw } = await startBrowser({ offscreenCreateDelayMs: 20 });
  const results = await sw.run(() => Promise.all(Array.from({ length: 20 }, () => ensureEngine())));
  assert.equal(callCount(browser, "offscreen.createDocument"), 1);
  assert.ok(
    results.every((result) => result.created),
    "every caller joined the one creation",
  );
  assert.equal(browser.offscreen?.url, browser.url(ENGINE_DOC));
  assert.equal((await sw.run(() => findEngine())).length, 1);
  assert.deepEqual(await sw.run(() => ensureEngine()), { created: false });
  assert.equal(callCount(browser, "offscreen.createDocument"), 1);
});

test("20 content scripts asking sw:ensure-engine at once still get one engine", async () => {
  const { browser, sw } = await startBrowser({ offscreenCreateDelayMs: 10 });
  sw.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
  const tab = browser.openTab("https://reader.example/ch/1");
  const frames = Array.from({ length: 20 }, () => browser.injectContent(tab.id));
  const replies = await Promise.all(
    frames.map((cs) => cs.run(() => callSw("sw:ensure-engine", { reason: "cs" }))),
  );
  assert.equal(replies.filter((reply) => reply.created).length, 20);
  assert.equal(callCount(browser, "offscreen.createDocument"), 1);
});

test("after a service-worker restart the engine is rediscovered, not recreated", async () => {
  const { browser, sw } = await startBrowser();
  assert.deepEqual(await sw.run(() => ensureEngine()), { created: true });
  const restarted = await browser.restartServiceWorker();
  assert.equal(await restarted.run(() => engineExists()), true);
  assert.deepEqual(await restarted.run(() => ensureEngine()), { created: false });
  assert.equal(callCount(browser, "offscreen.createDocument"), 1);
});

test("losing the createDocument race to another worker instance is not an error", async () => {
  const { browser, sw } = await startBrowser();
  browser.failNext("offscreen.createDocument", CHROME_ERRORS.singleOffscreen);
  assert.deepEqual(await sw.run(() => ensureEngine()), { created: false });
  browser.failNext("offscreen.createDocument", "Some other failure");
  await assert.rejects(
    sw.run(() => ensureEngine()),
    /Some other failure/,
  );
  assert.deepEqual(await sw.run(() => ensureEngine()), { created: true }, "a later call still creates it");
});

test("a created engine receives en:settings with migrated settings and sites", async () => {
  const received: Array<{ settings: Settings; sites: Record<string, SiteSettings> }> = [];
  const { browser, sw } = await startBrowser(
    engineWith({
      "en:settings": (payload) => {
        received.push(payload);
        return {};
      },
    }),
  );
  browser.storageSet("local", {
    settings: { api: { concurrency: 9, baseUrl: "http://127.0.0.1:11434" } },
    "site:https://reader.example": { enabled: true, addedAt: 5 },
  });
  await sw.run(() => ensureEngine());
  await until(() => received.length === 1, "en:settings");
  assert.equal(received[0]?.settings.api.concurrency, 4);
  assert.equal(
    received[0]?.settings.api.baseUrl,
    "http://127.0.0.1:11434/v1",
    "normalized before it is pushed",
  );
  assert.equal(received[0]?.sites["https://reader.example"]?.enabled, true);
});

test("force recreates the running engine once, even when asked twice at the same time", async () => {
  const { browser, sw } = await startBrowser();
  await sw.run(() => ensureEngine());
  const before = (await sw.run(() => findEngine()))[0]?.contextId;
  const results = await sw.run(() => Promise.all([ensureEngine(true), ensureEngine(true)]));
  assert.deepEqual(results, [{ created: true }, { created: true }]);
  assert.equal(callCount(browser, "offscreen.closeDocument"), 1);
  assert.equal(callCount(browser, "offscreen.createDocument"), 2);
  const after = await sw.run(() => findEngine());
  assert.equal(after.length, 1);
  assert.notEqual(after[0]?.contextId, before);
});

test("closeEngineIfIdle: the engine refuses while busy, so nothing is closed", async () => {
  const { browser, sw } = await startBrowser(engineWith({ "en:prepare-close": () => ({ ok: false }) }));
  await sw.run(() => ensureEngine());
  assert.equal(await sw.run(() => closeEngineIfIdle()), false);
  assert.equal(callCount(browser, "offscreen.closeDocument"), 0);
  assert.equal(await sw.run(() => engineExists()), true);
});

test("closeEngineIfIdle: an idle engine that agrees is closed", async () => {
  const asked: string[] = [];
  const { browser, sw } = await startBrowser(
    engineWith({
      "en:prepare-close": (_payload, sender) => {
        asked.push(sender.url ?? "");
        return { ok: true };
      },
    }),
  );
  await sw.run(() => ensureEngine());
  assert.equal(await sw.run(() => closeEngineIfIdle()), true);
  assert.deepEqual(asked, [browser.url("sw.js")]);
  assert.equal(await sw.run(() => engineExists()), false);
  assert.equal(await sw.run(() => closeEngineIfIdle()), false, "nothing left to close");
});

test("closeEngineIfIdle: no answer within the timeout, or no handler at all, keeps the engine", async () => {
  const { browser, sw } = await startBrowser(
    engineWith({ "en:prepare-close": () => new Promise<never>(() => undefined) }),
  );
  await sw.run(() => ensureEngine());
  assert.equal(await sw.run(() => closeEngineIfIdle(30)), false);
  assert.equal(callCount(browser, "offscreen.closeDocument"), 0);

  const bare = await startBrowser();
  await bare.sw.run(() => ensureEngine());
  assert.equal(
    await bare.sw.run(() => closeEngineIfIdle()),
    false,
    "an engine that does not answer is not closed",
  );
  assert.equal(await bare.sw.run(() => engineExists()), true);
});

test("ensureEngine waits for a close in progress, then creates a fresh engine", async () => {
  const { browser, sw } = await startBrowser(engineWith({ "en:prepare-close": () => ({ ok: true }) }));
  await sw.run(() => ensureEngine());
  const offscreen = sw.ext.offscreen;
  const realClose = offscreen.closeDocument;
  let release: (() => void) | null = null;
  offscreen.closeDocument = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => realClose());

  const closing = sw.run(() => closeEngineIfIdle());
  await until(() => release !== null, "closeDocument in progress");
  let ensured: { created: boolean } | null = null;
  const ensuring = sw
    .run(() => ensureEngine())
    .then((result) => {
      ensured = result;
    });
  await browser.settle();
  assert.equal(ensured, null, "ensureEngine must not answer while the old engine is closing");
  assert.ok(browser.offscreen !== null, "old engine still there");
  (release as unknown as () => void)();
  assert.equal(await closing, true);
  await ensuring;
  assert.deepEqual(ensured, { created: true });
  assert.equal(callCount(browser, "offscreen.createDocument"), 2);
  assert.equal((await sw.run(() => findEngine())).length, 1);
});

test("closeEngineIfIdle does nothing while a creation is in flight", async () => {
  const { sw } = await startBrowser({ offscreenCreateDelayMs: 20 });
  const creating = sw.run(() => ensureEngine());
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await sw.run(() => closeEngineIfIdle()), false);
  await creating;
  assert.equal(await sw.run(() => engineExists()), true);
});
