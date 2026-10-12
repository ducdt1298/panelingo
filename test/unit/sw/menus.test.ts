import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onMessageFor } from "../../../src/platform/messaging.ts";
import { catalogFor, msg, setLocale } from "../../../src/shared/i18n/index.ts";
import { createMenus, menuAction, MENU_IDS, onMenuClicked } from "../../../src/sw/menus.ts";
import { contentWith, startBrowser, stopBrowser, until } from "./sw-helpers.ts";

afterEach(async () => {
  await stopBrowser();
  setLocale("en");
});

function click(
  menuItemId: string,
  patch: Partial<chrome.contextMenus.OnClickData> = {},
): Record<string, unknown> {
  return { menuItemId, editable: false, mediaType: "image", srcUrl: "https://cdn.example/p/1.jpg", ...patch };
}

test("two image items titled from msg(); rebuilding never duplicates them", async () => {
  const { browser, sw } = await startBrowser();
  await sw.run(() => createMenus());
  await sw.run(() => createMenus());
  await browser.settle();
  assert.deepEqual(
    [...browser.menus.values()].map((menu) => [menu.id, menu.title, menu.contexts]),
    [
      [MENU_IDS.translate, msg().menu.translateImage, ["image"]],
      [MENU_IDS.retranslate, msg().menu.retranslateImage, ["image"]],
    ],
  );
  assert.equal(msg(), catalogFor("en"), "English by default");
});

test("menu titles come from the active UI locale when the menus are built", async () => {
  const { browser, sw } = await startBrowser();
  setLocale("vi");
  await sw.run(() => createMenus());
  await browser.settle();
  assert.deepEqual(
    [...browser.menus.values()].map((menu) => menu.title),
    [catalogFor("vi").menu.translateImage, catalogFor("vi").menu.retranslateImage],
  );
  assert.notEqual(catalogFor("vi").menu.translateImage, catalogFor("en").menu.translateImage);
  setLocale("en");
  await sw.run(() => createMenus());
  await browser.settle();
  assert.deepEqual(
    [...browser.menus.values()].map((menu) => menu.title),
    [catalogFor("en").menu.translateImage, catalogFor("en").menu.retranslateImage],
  );
  assert.equal(browser.menus.size, 2);
});

test("menuAction: our items only, with a tab and an image URL; retranslate forces", () => {
  const tab = { id: 4, windowId: 1 } as chrome.tabs.Tab;
  const info = (patch: Partial<chrome.contextMenus.OnClickData>): chrome.contextMenus.OnClickData =>
    click(MENU_IDS.translate, patch) as unknown as chrome.contextMenus.OnClickData;
  assert.deepEqual(menuAction(info({ frameId: 2 }), tab), {
    tabId: 4,
    frameId: 2,
    srcUrl: "https://cdn.example/p/1.jpg",
    force: false,
  });
  assert.equal(menuAction(info({ menuItemId: MENU_IDS.retranslate }), tab)?.force, true);
  assert.equal(menuAction(info({}), tab)?.frameId, 0, "top frame by default");
  assert.equal(menuAction(info({ menuItemId: "someone-else" }), tab), null);
  assert.equal(menuAction(info({ srcUrl: undefined }), tab), null);
  assert.equal(menuAction(info({}), undefined), null);
  assert.equal(menuAction(info({}), { ...tab, id: -1 }), null);
});

test("click on an image of a page with the content script: cs:translate-image goes straight to that frame", async () => {
  const requests: Array<{ srcUrl: string; force: boolean }> = [];
  const { browser, sw } = await startBrowser();
  sw.run(() => chrome.contextMenus.onClicked.addListener(onMenuClicked));
  const tab = browser.openTab("https://reader.example/ch/1");
  const frame = browser.addFrame(tab.id, "https://reader.example/viewer");
  browser.injectContent(tab.id, 0);
  const viewer = browser.injectContent(tab.id, frame.frameId);
  viewer.run(() =>
    onMessageFor("cs", {
      "cs:translate-image": (payload) => {
        requests.push(payload);
        return { found: true };
      },
    }),
  );
  browser.clickMenu(click(MENU_IDS.retranslate, { frameId: frame.frameId }), tab.id);
  await until(() => requests.length === 1, "cs:translate-image");
  assert.deepEqual(requests, [{ srcUrl: "https://cdn.example/p/1.jpg", force: true }]);
  assert.equal(browser.executeScriptCalls.length, 0);
});

test("click on a page without the content script: manual injection into the clicked frame, then the request", async () => {
  const requests: Array<{ srcUrl: string; force: boolean }> = [];
  const { browser, sw } = await startBrowser(
    contentWith({
      "cs:translate-image": (payload) => {
        requests.push(payload);
        return { found: true };
      },
    }),
  );
  sw.run(() => chrome.contextMenus.onClicked.addListener(onMenuClicked));
  const tab = browser.openTab("https://not-enabled.example/ch/9");
  browser.clickMenu(click(MENU_IDS.translate, { frameId: 0 }), tab.id);
  await until(() => requests.length === 1, "cs:translate-image after injection");
  assert.deepEqual(
    browser.executeScriptCalls.map((call) => [call.hasFunc, call.files, call.frameIds]),
    [
      [true, [], [0]],
      [false, ["content/main.js"], [0]],
    ],
    "manual flag first, then the script, both in the clicked frame",
  );
  assert.deepEqual(requests, [{ srcUrl: "https://cdn.example/p/1.jpg", force: false }]);
  delete (globalThis as { __ctvManual?: number }).__ctvManual;
});
