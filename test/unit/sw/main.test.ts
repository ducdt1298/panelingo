// The real service-worker entry: every listener is registered synchronously when the module loads.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { callSw } from "../../../src/platform/messaging.ts";
import type * as SwMain from "../../../src/sw/main.ts";
import { MENU_IDS } from "../../../src/sw/menus.ts";
import { contentWith, startBrowser, stopBrowser, until } from "./sw-helpers.ts";

afterEach(stopBrowser);

let main: typeof SwMain | null = null;

test("loading sw/main.ts registers every listener at once, and none for onConnect", async () => {
  const requests: string[] = [];
  const { browser, sw } = await startBrowser(
    contentWith({
      "cs:translate-image": (payload) => {
        requests.push(payload.srcUrl);
        return { found: true };
      },
    }),
  );
  main = await sw.run(() => import("../../../src/sw/main.ts"));
  assert.equal(sw.onInstalled.size, 1);
  assert.equal(sw.onStartup.size, 1);
  assert.equal(sw.menusOnClicked.size, 1);
  assert.equal(sw.commandsOnCommand.size, 1);
  assert.equal(sw.storageOnChanged.size, 1);
  assert.equal(sw.onMessage.size, 1);
  assert.equal(sw.onConnect.size, 0, "R3: only the engine listens to onConnect");

  browser.storageSet("local", { "site:https://reader.example": { enabled: true, addedAt: 1 } });
  browser.fireInstalled("install");
  await until(() => browser.menus.size === 2 && browser.registeredScripts.size === 1, "install wiring");

  const popup = browser.openExtensionPage("popup", "ui/popup.html");
  assert.deepEqual(await popup.run(() => callSw("sw:engine-state", {})), { exists: false });

  const tab = browser.openTab("https://elsewhere.example/");
  browser.clickMenu(
    { menuItemId: MENU_IDS.translate, srcUrl: "https://cdn.example/a.png", editable: false },
    tab.id,
  );
  await until(() => requests.length === 1, "menu wiring");
  delete (globalThis as { __ctvManual?: number }).__ctvManual;

  browser.fireCommand("open-side-panel", tab.id);
  await browser.settle();
  assert.equal(browser.sidePanel.opened.length, 1, "command wiring");
});

test("a restarted worker registers the same listeners again (module code runs per worker start)", async () => {
  assert.ok(main !== null, "runs after the first test");
  const { browser, sw } = await startBrowser();
  sw.run(() => main?.registerListeners());
  const restarted = await browser.restartServiceWorker();
  restarted.run(() => main?.registerListeners());
  assert.equal(restarted.onMessage.size, 1);
  const popup = browser.openExtensionPage("options", "ui/options.html");
  assert.deepEqual(await popup.run(() => callSw("sw:engine-state", {})), { exists: false });
});
