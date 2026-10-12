// Side panel transcript (ui/sidepanel.html?tabId=<id> pins the panel to the comic tab): after ko-p01 is translated
// the panel lists its lines under "Page 1" in reading order; a manual edit (en:edit-unit) shows on the comic's
// overlay and as "Edited", "Undo edit" restores the AI translation, and "Show" finds the bubble on the page.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { EN } from "../src/shared/i18n/en.ts";
import {
  balloonUnits,
  enableSite,
  groundTruth,
  openExtensionPage,
  openPage,
  paintedUnits,
  sleep,
  tabIdOf,
  waitAllImages,
  waitUntil,
  withDiagnostics,
  type GroundTruth,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, type Harness } from "./helpers/launch.ts";

const EDITED = "E2E edited line";

interface PanelLine {
  original: string;
  translation: string;
  status: string;
  buttons: string[];
  editing: boolean;
}

let h: Harness;
let comic: OpenedPage | null = null;
let panel: OpenedPage | null = null;
let gt: GroundTruth;

before(async () => {
  h = await launch({ settings: { ui: { locale: "en" } } });
  await enableSite(h);
  gt = await groundTruth("ko-p01");
});

after(async () => {
  await h?.close();
});

async function panelLines(page: Page): Promise<PanelLine[]> {
  return await page.$$eval("li.line", (items) =>
    items.map((li) => ({
      original: li.querySelector(".original")?.textContent ?? "",
      translation: li.querySelector(".translation")?.textContent ?? "",
      status: li.querySelector(".status")?.textContent ?? "",
      buttons: [...li.querySelectorAll(".line-actions button")].map((b) => b.textContent ?? ""),
      editing: li.querySelector("textarea") !== null,
    })),
  );
}

/** Clicks the button labelled `label` in the index-th line of the panel. */
async function clickLineButton(page: Page, index: number, label: string): Promise<void> {
  const clicked = await page.evaluate(
    (i, text) => {
      const li = document.querySelectorAll("li.line")[i];
      const button = [...(li?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text);
      button?.click();
      return button !== undefined;
    },
    index,
    label,
  );
  assert.ok(clicked, `no "${label}" button in line ${index}`);
}

const squash = (text: string): string => text.replace(/\s+/gu, "");

async function overlayShows(page: Page, text: string): Promise<boolean> {
  return (await paintedUnits(page)).some((unit) => squash(unit.text).includes(squash(text)));
}

const current = (): OpenedPage | null => panel ?? comic;

test("the panel lists the translated lines of the tab under Page 1, in reading order", async () => {
  comic = await openPage(h, "/paged/?set=ko-p01");
  const page = comic.page;
  await withDiagnostics(h, current, async () => {
    const done = await waitAllImages(page, ["done"], 1, 120_000);
    const tabId = await tabIdOf(h, page.url());
    panel = await openExtensionPage(h, "sidepanel", `?tabId=${tabId}`);
    const view = panel.page;
    const lines = await waitUntil(
      "the transcript lines",
      () => panelLines(view),
      (list) => list.length >= done.paintedTotal,
      30_000,
    );
    const headings = await view.$$eval("section.page h2", (hs) => hs.map((x) => x.textContent ?? ""));
    assert.deepEqual(headings, [EN.sidepanel.page(1)]);
    assert.equal(await view.title(), EN.sidepanel.title);
    // Every painted balloon is in the transcript with its original and translation.
    const ids = lines.map(
      (line) => gt.units.find((u) => u.original !== null && squash(u.original) === squash(line.original))?.id,
    );
    for (const unit of balloonUnits(gt)) {
      const line = lines.find((l) => squash(l.original) === squash(unit.original));
      assert.ok(line !== undefined, `unit ${unit.id} (${unit.original}) is not listed`);
      assert.ok(squash(line.translation).includes(squash(unit.vi)), `unit ${unit.id}: ${line.translation}`);
      assert.equal(line.status, EN.unitStatus.ok);
    }
    // Reading order: the listed lines follow the ground truth's order (ko-p01 reads left to right, top to bottom).
    const known = ids.filter((id): id is number => id !== undefined);
    assert.deepEqual(
      known,
      [...known].sort((a, b) => a - b),
      `listed order ${JSON.stringify(ids)}`,
    );
  });
});

test("editing a line updates the overlay and marks it Edited; Undo edit restores the AI translation", async () => {
  const view = panel?.page;
  const page = comic?.page;
  assert.ok(view !== undefined && page !== undefined, "needs the previous test's pages");
  await withDiagnostics(h, current, async () => {
    const [first] = await panelLines(view);
    assert.ok(first !== undefined);
    const aiText = first.translation;
    assert.ok(await overlayShows(page, aiText), "the AI translation is painted before the edit");

    await clickLineButton(view, 0, EN.sidepanel.edit);
    await view.waitForSelector("li.line textarea", { timeout: 5_000 });
    await view.$eval("li.line textarea", (box) => box.select());
    await view.keyboard.type(EDITED);
    await clickLineButton(view, 0, EN.sidepanel.save);

    const edited = await waitUntil(
      "the edited line in the panel",
      async () => (await panelLines(view))[0],
      (line) => line !== undefined && !line.editing && line.status === EN.unitStatus.manual,
      15_000,
    );
    assert.equal(edited?.translation, EDITED);
    assert.ok(edited?.buttons.includes(EN.sidepanel.revert), "an edited line offers Undo edit");
    await waitUntil(
      "the edit on the overlay",
      () => overlayShows(page, EDITED),
      (shown) => shown,
      15_000,
    );
    assert.equal(await overlayShows(page, aiText), false, "the AI text is replaced, not painted twice");

    await clickLineButton(view, 0, EN.sidepanel.revert);
    const reverted = await waitUntil(
      "the reverted line",
      async () => (await panelLines(view))[0],
      (line) => line !== undefined && line.status === EN.unitStatus.ok,
      15_000,
    );
    assert.equal(reverted?.translation, aiText);
    assert.ok(!(reverted?.buttons ?? []).includes(EN.sidepanel.revert));
    await waitUntil(
      "the AI text back on the overlay",
      () => overlayShows(page, aiText),
      (shown) => shown,
      15_000,
    );
    assert.equal(await overlayShows(page, EDITED), false);
  });
});

test("Show finds the bubble on the page (no 'no longer on the page' message)", async () => {
  const view = panel?.page;
  assert.ok(view !== undefined, "needs the previous test's panel");
  await withDiagnostics(h, current, async () => {
    const lines = await panelLines(view);
    await clickLineButton(view, lines.length - 1, EN.sidepanel.jump);
    // en:jump-to answers found: false (→ notFound) or fails (→ failed); an empty message means found: true.
    await sleep(1_000);
    const message = await view.$eval("#message", (el) => el.textContent ?? "");
    assert.notEqual(message, EN.sidepanel.notFound);
    assert.notEqual(message, EN.sidepanel.failed);
    assert.equal(message, "");
  });
});

// The engine answers found: true and posts img:scroll-to to the frame; the overlay scrolls the bubble to mid-screen.
test("Show scrolls the comic page to the bubble", async () => {
  const view = panel?.page;
  const page = comic?.page;
  assert.ok(view !== undefined && page !== undefined);
  await page.evaluate(() => window.scrollTo(0, 0));
  const lines = await panelLines(view);
  // The last line in reading order sits in the bottom half of ko-p01, below the first screen.
  await clickLineButton(view, lines.length - 1, EN.sidepanel.jump);
  await waitUntil(
    "the comic page to scroll",
    () => page.evaluate(() => window.scrollY),
    (y) => y > 0,
    10_000,
  );
});
