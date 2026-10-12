import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onMessageFor } from "../../../src/platform/messaging.ts";
import { silentLogger } from "../../../src/platform/log.ts";
import { wrapPort } from "../../../src/platform/port.ts";
import type { EngineToUiMap, UiToEngineMap } from "../../../src/shared/protocol.ts";
import type { EngineStatus } from "../../../src/shared/types.ts";
import { isProbe, makeProbe } from "../../../src/shared/wire.ts";
import { swAllow, swHandlers } from "../../../src/sw/router.ts";
import {
  callEngineEnsured,
  callEngineIfRunning,
  engineRunning,
  watchEngine,
} from "../../../src/ui/common/engine-rpc.ts";
import type { FakeBrowserOptions, FakeContext, FakePort } from "../../support/chrome-fake.ts";
import { callCount, startBrowser, statusFixture, stopBrowser, until } from "../sw/sw-helpers.ts";

afterEach(stopBrowser);

interface EngineStub {
  hellos: Array<UiToEngineMap["ui:hello"]>;
  watches: Array<number | null>;
  push(status: EngineStatus): void;
}

/** Engine double: en:* one-shots plus Port "ui" (hello, watch, status pushes). */
function engineStub(version = 1): { options: FakeBrowserOptions; stub: EngineStub } {
  const ports: Array<ReturnType<typeof wrapPort<UiToEngineMap, EngineToUiMap>>> = [];
  const stub: EngineStub = {
    hellos: [],
    watches: [],
    push: (status) => {
      for (const port of ports) port.post({ type: "en:status", status });
    },
  };
  const options: FakeBrowserOptions = {
    onOffscreenCreated: (ctx: FakeContext) => {
      onMessageFor("engine", {
        "en:status": () => statusFixture({ uploads: { today: 2, bytesToday: 2048 } }),
        "en:cache-clear": (payload) => ({ deletedRecords: payload.scope === "all" ? 42 : 0 }),
      });
      ctx.onConnect.addListener((raw: FakePort) => {
        if (raw.name !== "ui") return;
        const port = wrapPort<UiToEngineMap, EngineToUiMap>(raw as unknown as chrome.runtime.Port, {
          ctx: "engine",
          log: silentLogger,
        });
        ports.push(port);
        port.on("ui:hello", (message) => {
          stub.hellos.push(message);
          port.post({ type: "en:hello", v: version, probe: makeProbe(), codec: "sc" });
        });
        port.on("ui:watch", (message) => {
          stub.watches.push(message.tabId);
          port.post({ type: "en:status", status: statusFixture() });
        });
      });
    },
  };
  return { options, stub };
}

async function setup(version = 1): Promise<{
  browser: Awaited<ReturnType<typeof startBrowser>>["browser"];
  popup: FakeContext;
  stub: EngineStub;
}> {
  const { options, stub } = engineStub(version);
  const { browser, sw } = await startBrowser(options);
  sw.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
  return { browser, popup: browser.openExtensionPage("popup", "ui/popup.html"), stub };
}

test("status views never start the engine; explicit actions do", async () => {
  const { browser, popup } = await setup();
  assert.equal(await popup.run(() => engineRunning()), false);
  assert.equal(await popup.run(() => callEngineIfRunning("en:status", {})), null);
  assert.equal(callCount(browser, "offscreen.createDocument"), 0);

  assert.deepEqual(await popup.run(() => callEngineEnsured("en:cache-clear", { scope: "all" })), {
    deletedRecords: 42,
  });
  assert.equal(callCount(browser, "offscreen.createDocument"), 1);
  assert.equal(await popup.run(() => engineRunning()), true);
  const status = await popup.run(() => callEngineIfRunning("en:status", { tabId: 3 }));
  assert.equal(status?.uploads.today, 2);
});

test("engineRunning is false when the service worker cannot answer", async () => {
  const { browser } = await startBrowser();
  const popup = browser.openExtensionPage("popup", "ui/popup.html");
  assert.equal(await popup.run(() => engineRunning()), false);
});

test("watchEngine: hello with a probe, watch for the tab, then live status pushes until stop()", async () => {
  const { popup, stub } = await setup();
  await popup.run(() => callEngineEnsured("en:status", {}));
  const seen: EngineStatus[] = [];
  const watch = popup.run(() =>
    watchEngine({ view: "popup", tabId: 7, log: silentLogger, onStatus: (status) => seen.push(status) }),
  );
  await until(() => seen.length === 1, "first status");
  assert.equal(stub.hellos[0]?.view, "popup");
  assert.equal(isProbe(stub.hellos[0]?.probe), true);
  assert.deepEqual(stub.watches, [7]);
  stub.push(statusFixture({ phase: "closing" }));
  await until(() => seen.length === 2, "pushed status");
  assert.equal(seen[1]?.phase, "closing");
  watch.stop();
  stub.push(statusFixture());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen.length, 2, "nothing after stop()");
});

test("watchEngine: when the engine goes away it does not restart it and reports gone", async () => {
  const { browser, popup } = await setup();
  await popup.run(() => callEngineEnsured("en:status", {}));
  let gone = 0;
  popup.run(() =>
    watchEngine({
      view: "popup",
      tabId: null,
      log: silentLogger,
      onStatus: () => undefined,
      onGone: () => {
        gone += 1;
      },
      retryDelaysMs: [1, 1],
    }),
  );
  await until(
    () => browser.offscreen !== null && callCount(browser, "runtime.getContexts") >= 1,
    "connected",
  );
  await browser.serviceWorker?.run(() => chrome.offscreen.closeDocument());
  await until(() => gone === 1, "onGone");
  assert.equal(callCount(browser, "offscreen.createDocument"), 1, "never recreated for a status view");
});

test("watchEngine: a protocol mismatch stops watching", async () => {
  const { popup } = await setup(99);
  await popup.run(() => callEngineEnsured("en:status", {}));
  let gone = 0;
  const seen: EngineStatus[] = [];
  popup.run(() =>
    watchEngine({
      view: "options",
      tabId: null,
      log: silentLogger,
      onStatus: (status) => seen.push(status),
      onGone: () => {
        gone += 1;
      },
      retryDelaysMs: [1],
    }),
  );
  await until(() => gone === 1, "onGone after mismatch");
  assert.deepEqual(seen, []);
});
