// Side panel Glossary view (ui/sidepanel.html?tabId=<id> pins the panel to the comic tab): after ko-p01 is
// translated the view shows the tab's series, an entry added by hand is listed under "Your entries" and survives a
// reload of the panel, and the next request for that series carries it in the prompt's glossary.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { GLOSSARY_HEADER } from "../src/shared/core/prompt.ts";
import { EN } from "../src/shared/i18n/en.ts";
import {
  enableSite,
  openExtensionPage,
  openPage,
  sendFromPage,
  tabIdOf,
  waitAllImages,
  waitUntil,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, type Harness } from "./helpers/launch.ts";

const ORIGINAL = "테스트용어";
const RENDERING = "E2E-Term";

let h: Harness;
let comic: OpenedPage | null = null;
let panel: OpenedPage | null = null;
let tabId = -1;

before(async () => {
  h = await launch({ settings: { ui: { locale: "en" } } });
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

const current = (): OpenedPage | null => panel ?? comic;

/** Clicks the first button whose text is exactly `label` (inside `scope` when given). */
async function clickButton(page: Page, label: string, scope = "body"): Promise<void> {
  const clicked = await page.evaluate(
    (text, selector) => {
      const button = [...(document.querySelector(selector)?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === text && !b.disabled,
      );
      button?.click();
      return button !== undefined;
    },
    label,
    scope,
  );
  assert.ok(clicked, `no enabled "${label}" button in ${scope}`);
}

async function manualEntries(page: Page): Promise<Array<{ orig: string; rendering: string }>> {
  return await page.$$eval(".entry.state-manual", (items) =>
    items.map((item) => ({
      orig: item.querySelector(".orig")?.textContent ?? "",
      rendering: item.querySelector(".rendering")?.textContent ?? "",
    })),
  );
}

async function openGlossary(): Promise<Page> {
  panel = await openExtensionPage(h, "sidepanel", `?tabId=${tabId}`);
  const view = panel.page;
  await view.waitForSelector('[role="tab"]', { timeout: 10_000 });
  await clickButton(view, EN.sidepanel.tabs.glossary, "#tabs");
  await view.waitForSelector("form.add", { timeout: 15_000 });
  return view;
}

test("the Glossary view shows the tab's series and adds a manual entry", async () => {
  comic = await openPage(h, "/paged/?set=ko-p01");
  await withDiagnostics(h, current, async () => {
    await waitAllImages(comic!.page, ["done"], 1, 120_000);
    tabId = await tabIdOf(h, comic!.page.url());
    const view = await openGlossary();
    const seriesKey = await view.$eval(".series .key", (el) => el.textContent ?? "");
    assert.ok(seriesKey.startsWith(new URL(h.fixtures.readerUrl).origin), `series key ${seriesKey}`);

    const inputs = await view.$$("form.add input");
    assert.ok(inputs.length >= 2, "original and translation inputs");
    await inputs[0]!.type(ORIGINAL);
    await inputs[1]!.type(RENDERING);
    await clickButton(view, EN.sidepanel.glossary.add, "form.add");

    const entries = await waitUntil(
      "the manual entry",
      () => manualEntries(view),
      (list) => list.length > 0,
    );
    assert.deepEqual(entries, [{ orig: ORIGINAL, rendering: RENDERING }]);
  });
});

test("the entry is stored: a fresh panel lists it again", async () => {
  await withDiagnostics(h, current, async () => {
    await panel?.page.close();
    const view = await openGlossary();
    const entries = await waitUntil(
      "the stored entry",
      () => manualEntries(view),
      (list) => list.length > 0,
    );
    assert.deepEqual(entries, [{ orig: ORIGINAL, rendering: RENDERING }]);
  });
});

test("the next request of the series sends the entry in the prompt's glossary", async () => {
  await withDiagnostics(h, current, async () => {
    const before = h.api.requests().filter((r) => r.path === "/v1/chat/completions").length;
    const view = panel?.page;
    assert.ok(view !== undefined, "needs the panel of the previous test");
    // What the popup's "Translate this page again" sends.
    const reply = await sendFromPage<{ queued: number }>(view, "engine", "en:retranslate", { tabId });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const chats = await waitUntil(
      "a new chat request",
      () => h.api.requests().filter((r) => r.path === "/v1/chat/completions"),
      (list) => list.length > before,
      90_000,
    );
    const prompt = chats
      .slice(before)
      .map((r) => r.systemText)
      .join("\n");
    assert.ok(prompt.includes(GLOSSARY_HEADER), "the prompt has a glossary section");
    assert.ok(prompt.includes(`${ORIGINAL} -> ${RENDERING}`), "the manual entry is in the glossary");
  });
});
