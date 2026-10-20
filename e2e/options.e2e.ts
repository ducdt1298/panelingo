// The options page in real Chrome: an Advanced setting typed into the generated form lands in chrome.storage.local
// (clamped like a stored value), the per-site editor saves through sw:site-set, and a site switched to manual mode on
// the options page uploads nothing when its comic page loads; switched back to automatic, the page translates.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { EN } from "../src/shared/i18n/en.ts";
import type { Settings, SiteSettings } from "../src/shared/settings.ts";
import {
  chats,
  openExtensionPage,
  openPage,
  sleep,
  waitAllImages,
  waitUntil,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, waitForSummary, type Harness } from "./helpers/launch.ts";

/** How long a manual page is watched for an unwanted upload. */
const SETTLE_MS = 4_000;

let h: Harness;
let siteKey = "";
let options: OpenedPage | null = null;

before(async () => {
  h = await launch();
  siteKey = new URL(h.fixtures.readerUrl).origin;
  await h.setStorage({ [`site:${siteKey}`]: { enabled: true, mode: "auto" } });
  await sleep(600); // the service worker registers the content script on the storage change
});

after(async () => {
  await h?.close();
});

async function storedSettings(): Promise<Settings> {
  return await h.sw.evaluate(
    async () => (await chrome.storage.local.get("settings"))["settings"] as Settings,
  );
}

async function storedSite(): Promise<SiteSettings> {
  return await h.sw.evaluate(
    async (key) => (await chrome.storage.local.get(key))[key] as SiteSettings,
    `site:${siteKey}`,
  );
}

async function registeredMatches(): Promise<string[]> {
  return await h.sw.evaluate(async () => {
    const [script] = await chrome.scripting.getRegisteredContentScripts({ ids: ["ctv-main"] });
    return script?.matches ?? [];
  });
}

/** Replaces an input's text like a user (select all, type) and leaves it with Tab, which fires `change`. */
async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  await page.focus(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type(value);
  await page.keyboard.press("Tab");
}

async function textOf(page: Page, selector: string): Promise<string> {
  return await page.$eval(selector, (el) => el.textContent ?? "");
}

test("an Advanced setting typed in the options page is stored, clamped to its limits", async () => {
  options = await openExtensionPage(h, "options");
  const current = options;
  await withDiagnostics(h, current, async () => {
    const { page } = current;
    await page.waitForSelector("#adv-search", { timeout: 15_000 });
    // Settings are tabs: only the chosen one shows.
    const hidden = (selector: string): Promise<boolean> =>
      page.$eval(selector, (el) => (el as HTMLElement).hidden === true);
    assert.equal(await hidden("#tab-advanced"), true, "not the first tab");
    await page.click('a.settings-nav-item[href="#advanced"]');
    assert.equal(await hidden("#tab-advanced"), false);
    assert.equal(await hidden("#tab-engine"), true, "one tab at a time");
    // The groups start collapsed; a search opens the one that holds the setting.
    assert.equal(await page.$eval("#adv-group-memory", (el) => (el as HTMLDetailsElement).open), false);
    await page.type("#adv-search", "earlier lines");
    assert.equal(await page.$eval("#adv-group-memory", (el) => (el as HTMLDetailsElement).open), true);
    assert.equal(await hidden("#adv-group-api"), true, "groups without a match hide");

    await typeInto(page, "#adv-memory-historyMaxLines", "5");
    await waitUntil(
      "memory.historyMaxLines stored",
      async () => (await storedSettings()).memory.historyMaxLines,
      (value) => value === 5,
      10_000,
    );
    await waitUntil(
      "the row confirms the save",
      () => textOf(page, "#adv-memory-historyMaxLines-msg"),
      (text) => text === EN.options.saved,
    );

    // Lettering rows live on the Language & display tab.
    await page.click('a.settings-nav-item[href="#display"]');
    assert.equal(await hidden("#tab-display"), false);
    await typeInto(page, "#adv-render-maxFontPx", "500");
    await waitUntil(
      "render.maxFontPx clamped to 120",
      async () => (await storedSettings()).render.maxFontPx,
      (value) => value === 120,
      10_000,
    );
    assert.equal(await textOf(page, "#adv-render-maxFontPx-msg"), EN.optionsAdvanced.adjusted("120"));
    assert.equal(await page.$eval("#adv-render-maxFontPx", (el) => (el as HTMLInputElement).value), "120");

    // Series memory is on the Translation tab.
    await page.click('a.settings-nav-item[href="#engine"]');
    await page.click("#adv-memory-enabled");
    await waitUntil(
      "memory.enabled off",
      async () => (await storedSettings()).memory.enabled,
      (value) => !value,
      10_000,
    );
    // The row's Reset button puts it back.
    await page.click('[data-path="memory.enabled"] button.reset');
    await waitUntil(
      "memory.enabled reset to on",
      async () => (await storedSettings()).memory.enabled,
      (value) => value,
      10_000,
    );
    const settings = await storedSettings();
    assert.equal(settings.api.baseUrl, h.api.baseUrl, "the endpoint is untouched");
  });
});

test("the per-site editor saves through the service worker and keeps the registration in sync", async () => {
  const current = options;
  assert.ok(current !== null, "needs the options page of the previous test");
  await withDiagnostics(h, current, async () => {
    const { page } = current;
    const row = `li.site-item[data-site="${siteKey}"]`;
    await page.click('a.settings-nav-item[href="#sites"]');
    await page.waitForSelector(row);
    const base = await page.$eval(`${row} button.site-toggle`, (el) => el.id.replace(/-toggle$/u, ""));
    await page.click(`#${base}-toggle`);
    await page.waitForSelector(`#${base}-editor`);
    assert.equal(await page.$eval(`#${base}-toggle`, (el) => el.getAttribute("aria-expanded")), "true");

    await page.select(`#${base}-layout`, "paged-ltr");
    await page.select(`#${base}-sourceLang`, "ko");
    await waitUntil(
      "layout and source language stored",
      storedSite,
      (site) => site.layout === "paged-ltr" && site.sourceLang === "ko",
      10_000,
    );
    await typeInto(page, `#${base}-extraFrameOrigins`, "https://viewer.example.com/reader");
    await waitUntil(
      "reader frame origin stored and registered",
      async () => ({ site: await storedSite(), matches: await registeredMatches() }),
      ({ site, matches }) =>
        site.extraFrameOrigins.join() === "https://viewer.example.com" &&
        matches.includes("https://viewer.example.com/*"),
      10_000,
    );

    await page.select(`#${base}-mode`, "manual");
    await waitUntil("mode manual stored", storedSite, (site) => site.mode === "manual", 10_000);
    const site = await storedSite();
    assert.equal(site.enabled, true);
    assert.equal(await page.$eval(`#${base}-layout`, (el) => (el as HTMLSelectElement).value), "paged-ltr");
  });
});

test("the site switched to manual on the options page uploads nothing when its page loads", async () => {
  const opened = await openPage(h, "/paged/?set=ko-p01");
  await withDiagnostics(h, opened, async () => {
    const tracked = await waitForSummary(opened.page, (s) => Object.keys(s.images).length >= 1, 30_000);
    assert.equal(tracked.mode, "manual");
    await sleep(SETTLE_MS);
    const later = await waitForSummary(opened.page, () => true);
    assert.equal(chats(h).length, 0, "no chat request without a user request");
    assert.equal(later.paintedTotal, 0);
  });
  await opened.page.close();
});

test("switched back to automatic on the options page, the same page translates on load", async () => {
  const current = options;
  assert.ok(current !== null, "needs the options page");
  await withDiagnostics(h, current, async () => {
    const row = `li.site-item[data-site="${siteKey}"]`;
    const base = await current.page.$eval(`${row} button.site-toggle`, (el) =>
      el.id.replace(/-toggle$/u, ""),
    );
    await current.page.select(`#${base}-mode`, "auto");
    await waitUntil("mode auto stored", storedSite, (site) => site.mode === "auto", 10_000);
  });
  const opened = await openPage(h, "/paged/?set=ko-p01");
  await withDiagnostics(h, opened, async () => {
    const done = await waitAllImages(opened.page, ["done"], 1, 120_000);
    assert.notEqual(done.mode, "manual");
    assert.ok(chats(h).length >= 1, "translated through the mock endpoint");
  });
  await opened.page.close();
});
