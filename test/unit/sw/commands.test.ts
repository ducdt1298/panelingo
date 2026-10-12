import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onMessageFor } from "../../../src/platform/messaging.ts";
import { msg } from "../../../src/shared/i18n/index.ts";
import type { SiteSettings } from "../../../src/shared/settings.ts";
import { COMMANDS, onCommand, toggleSite } from "../../../src/sw/commands.ts";
import { CHROME_ERRORS } from "../../support/chrome-fake.ts";
import { contentWith, startBrowser, stopBrowser, until } from "./sw-helpers.ts";

afterEach(stopBrowser);

test("open-side-panel opens the panel inside the command's user gesture", async () => {
  const { browser, sw } = await startBrowser();
  sw.commandsOnCommand.addListener(onCommand);
  const tab = browser.openTab("https://reader.example/", { windowId: 3 });
  browser.fireCommand(COMMANDS.openSidePanel, tab.id);
  await browser.settle();
  assert.deepEqual(browser.sidePanel.opened, [{ windowId: 3 }]);
  assert.deepEqual(browser.listenerErrors, []);
  // Outside the synchronous part of a user-gesture listener Chrome refuses, which is why onCommand opens first.
  await assert.rejects(
    sw.run(() => chrome.sidePanel.open({ windowId: 3 })),
    new RegExp(CHROME_ERRORS.sidePanelGesture.replace(/[.()`]/g, "\\$&")),
  );
});

test("toggle-overlay is relayed to the tab's content scripts; without one nothing happens", async () => {
  const toggles: number[] = [];
  const { browser, sw } = await startBrowser();
  sw.commandsOnCommand.addListener(onCommand);
  const tab = browser.openTab("https://reader.example/ch/1");
  const cs = browser.injectContent(tab.id);
  cs.run(() =>
    onMessageFor("cs", {
      "cs:toggle-overlay": () => {
        toggles.push(tab.id);
        return { visible: false };
      },
    }),
  );
  browser.fireCommand(COMMANDS.toggleOverlay, tab.id);
  await until(() => toggles.length === 1, "cs:toggle-overlay");

  const bare = browser.openTab("https://elsewhere.example/");
  browser.fireCommand(COMMANDS.toggleOverlay, bare.id);
  await browser.settle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(browser.executeScriptCalls.length, 0, "toggling never injects");
  assert.deepEqual(toggles, [tab.id]);
});

test("translate-visible injects in manual mode when the page has no content script, then relays", async () => {
  let submitted = 0;
  const { browser, sw } = await startBrowser(
    contentWith({
      "cs:translate-visible": () => {
        submitted += 1;
        return { submitted: 4 };
      },
    }),
  );
  sw.commandsOnCommand.addListener(onCommand);
  const tab = browser.openTab("https://not-enabled.example/");
  browser.fireCommand(COMMANDS.translateVisible, tab.id);
  await until(() => submitted === 1, "cs:translate-visible");
  assert.deepEqual(
    browser.executeScriptCalls.map((call) => call.hasFunc),
    [true, false],
  );
  delete (globalThis as { __ctvManual?: number }).__ctvManual;
});

test("toggle-site before the privacy notice: nothing enabled, a badge hint points at the popup", async () => {
  const { browser, sw } = await startBrowser();
  sw.commandsOnCommand.addListener(onCommand);
  const tab = browser.openTab("https://reader.example/ch/1");
  browser.fireCommand(COMMANDS.toggleSite, tab.id);
  await until(() => browser.badges.get(String(tab.id))?.title === msg().popup.consentHint, "consent hint");
  await until(() => browser.badges.get(String(tab.id))?.text === "!", "badge text");
  assert.equal(browser.storageGet("local", "site:https://reader.example"), undefined);
  assert.equal(browser.registeredScripts.size, 0);
  assert.equal(browser.executeScriptCalls.length, 0);
});

test("toggle-site after the notice: enables (register + inject at once), then disables (teardown)", async () => {
  const teardowns: string[] = [];
  const { browser, sw } = await startBrowser(
    contentWith({
      "cs:teardown": (payload) => {
        teardowns.push(payload.reason);
        return {};
      },
    }),
  );
  browser.storageSet("local", { settings: { privacy: { ackUploadNoticeAt: 1_000 } } });
  for (let i = 0; i < 5; i += 1) browser.openTab(`https://filler${i}.example/`, { active: false });
  const tab = browser.openTab("https://reader.example/ch/1");
  const tabInfo = browser.tabInfo(browser.tabs.get(tab.id) ?? tab);

  assert.equal(await sw.run(() => toggleSite(tabInfo)), "enabled");
  assert.equal((browser.storageGet("local", "site:https://reader.example") as SiteSettings).enabled, true);
  assert.deepEqual(browser.registeredScripts.get("ctv-main")?.matches, ["https://reader.example/*"]);
  assert.deepEqual(
    browser.executeScriptCalls.map((call) => [call.tabId, call.hasFunc]),
    [[tab.id, false]],
  );

  assert.equal(await sw.run(() => toggleSite(tabInfo)), "disabled");
  assert.equal((browser.storageGet("local", "site:https://reader.example") as SiteSettings).enabled, false);
  assert.equal(browser.registeredScripts.size, 0);
  assert.deepEqual(teardowns, ["site-disabled"]);

  const internal = browser.openTab("chrome://settings/");
  assert.equal(
    await sw.run(() => toggleSite(browser.tabInfo(browser.tabs.get(internal.id) ?? internal))),
    "unsupported",
  );
});

test("commands without a tab are ignored", async () => {
  const { browser, sw } = await startBrowser();
  sw.commandsOnCommand.addListener(onCommand);
  for (const command of Object.values(COMMANDS)) browser.fireCommand(command);
  await browser.settle();
  assert.deepEqual(browser.sidePanel.opened, []);
  assert.deepEqual(browser.listenerErrors, []);
});
