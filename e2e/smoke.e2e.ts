// Smoke: the service worker starts, the engine (offscreen document) only comes up on demand, the popup and the
// options page render against the mock endpoint, and switching settings.ui.locale localizes both pages.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { EN } from "../src/shared/i18n/en.ts";
import { VI } from "../src/shared/i18n/vi.ts";
import {
  engineDocumentOpen,
  openExtensionPage,
  sendFromPage,
  sleep,
  waitUntil,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, type Harness } from "./helpers/launch.ts";

let h: Harness;
let current: OpenedPage | null = null;

before(async () => {
  // A fixed UI language: "auto" would follow the machine's Chrome language.
  h = await launch({ settings: { ui: { locale: "en" } } });
});

after(async () => {
  await h?.close();
});

const text = (page: Page, selector: string): Promise<string> =>
  page.$eval(selector, (el) => el.textContent?.trim() ?? "").catch(() => "");

test("the service worker runs the test build and the engine is not started eagerly", async () => {
  const info = await h.sw.evaluate(() => ({
    id: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    popup: (chrome.runtime.getManifest() as chrome.runtime.ManifestV3).action?.default_popup ?? null,
  }));
  assert.equal(info.id, h.extensionId);
  assert.equal(info.popup, "ui/popup.html");
  // Nothing asked for the engine yet: no page with candidates, no explicit UI action.
  await sleep(500);
  assert.equal(await engineDocumentOpen(h), false, "no offscreen document before anything needs it");
});

test("the popup shows the endpoint as ready with the configured model, without starting the engine", async () => {
  current = await openExtensionPage(h, "popup");
  const { page } = current;
  await withDiagnostics(h, current, async () => {
    await waitUntil(
      "the API readiness pill",
      () => text(page, "#api .pill"),
      (value) => value === EN.readiness.ready.label,
      15_000,
    );
    assert.equal(await text(page, "#api .status-detail"), h.api.model, "the status line names the model");
    assert.ok(
      await page.$eval("#api .pill", (el) => el.classList.contains("tone-ok")),
      "the readiness pill has the ok tone",
    );
    // The popup asked the mock itself (GET /v1/models); rendering must not start the engine.
    assert.ok(h.api.requests().some((r) => r.path === "/v1/models" && r.status === 200));
    assert.equal(
      await page.$eval("#engine", (el) => (el as HTMLElement).hidden),
      true,
      "no engine note while nothing is wrong",
    );
    assert.equal(await engineDocumentOpen(h), false, "the popup must not start the engine");
  });
});

test("the engine starts on demand and reports the endpoint as ready", async () => {
  const opened = current;
  assert.ok(opened !== null);
  await withDiagnostics(h, opened, async () => {
    const reply = await sendFromPage<{ created: boolean }>(opened.page, "sw", "sw:ensure-engine", {
      reason: "ui",
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.data?.created, true);
    assert.equal(await engineDocumentOpen(h), true);
    const status = await waitUntil(
      "engine status ready",
      async () =>
        (
          await sendFromPage<{ phase: string; api: { readiness: string; model: string | null } }>(
            opened.page,
            "engine",
            "en:status",
            {},
          )
        ).data ?? null,
      (s) => s !== null && s.phase === "ready" && s.api.readiness === "ready",
      30_000,
      300,
    );
    assert.equal(status?.api.model, h.api.model);
    // A second call finds the running engine.
    const again = await sendFromPage<{ created: boolean }>(opened.page, "sw", "sw:ensure-engine", {
      reason: "ui",
    });
    assert.equal(again.data?.created, false);
    await opened.page.close();
  });
});

test("the options page renders the endpoint settings and the language pickers", async () => {
  current = await openExtensionPage(h, "options");
  const { page } = current;
  await withDiagnostics(h, current, async () => {
    await page.waitForSelector("#languages h3", { timeout: 15_000 });
    assert.equal(await text(page, "#languages h3"), EN.options.languageHeading);
    assert.equal(await page.title(), `${EN.ui.appName} – ${EN.options.title}`);
    assert.equal(await page.$eval("#base-url", (el) => (el as HTMLInputElement).value), h.api.baseUrl);
    assert.equal(await page.$eval("#model", (el) => (el as HTMLInputElement).value), h.api.model);
    assert.equal(await page.$eval("#ui-locale", (el) => (el as HTMLSelectElement).value), "en");
    await waitUntil(
      "the options readiness pill",
      () => text(page, "#api .pill"),
      (v) => v === EN.readiness.ready.label,
    );
  });
});

test("choosing Vietnamese as the interface language localizes the options page and the popup", async () => {
  const opened = current;
  assert.ok(opened !== null);
  await withDiagnostics(h, opened, async () => {
    const { page } = opened;
    // The options page saves the choice and reloads itself in the new language.
    await page.select("#ui-locale", "vi");
    await waitUntil(
      "the Vietnamese language heading",
      () => text(page, "#languages h3"),
      (v) => v === VI.options.languageHeading,
      15_000,
    );
    assert.equal(await page.evaluate(() => document.documentElement.lang), "vi");
    const stored = await h.sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      return (settings as { ui?: { locale?: string } } | undefined)?.ui?.locale ?? null;
    });
    assert.equal(stored, "vi");
    await page.close();

    current = await openExtensionPage(h, "popup");
    const popup = current.page;
    await waitUntil(
      "the Vietnamese readiness pill",
      () => text(popup, "#api .pill"),
      (v) => v === VI.readiness.ready.label,
      15_000,
    );
    assert.equal(await text(popup, "#open-options"), VI.popup.options);
    assert.equal(await text(popup, "#site h2"), VI.popup.siteHeading);
    assert.notEqual(VI.popup.siteHeading, EN.popup.siteHeading, "the catalog string differs from English");
    await popup.close();
  });
});
