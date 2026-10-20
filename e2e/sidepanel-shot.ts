// Manual aid (not a test): node e2e/sidepanel-shot.ts <out-dir> — translates ko-p01 against the mock server, then
// saves screenshots of the side panel's Transcript and Glossary views (440 px wide, like a docked side panel). The
// Glossary view gets two sample forms of address (one learned, one yours) so that section shows too.

import path from "node:path";
import { EN } from "../src/shared/i18n/en.ts";
import {
  enableSite,
  openExtensionPage,
  openPage,
  sendFromPage,
  tabIdOf,
  waitAllImages,
} from "./helpers/flows.ts";
import { launch } from "./helpers/launch.ts";

const outDir = path.resolve(process.argv[2] ?? "reports");
const h = await launch({ settings: { ui: { locale: process.env.CTV_LOCALE ?? "en" } } });
try {
  await enableSite(h);
  const comic = await openPage(h, "/paged/?set=ko-p01");
  await waitAllImages(comic.page, ["done"], 1, 120_000);
  const tabId = await tabIdOf(h, comic.page.url());
  const panel = await openExtensionPage(h, "sidepanel", `?tabId=${tabId}`);
  await panel.page.setViewport({ width: 440, height: 900 });
  await panel.page.waitForSelector("li.line", { timeout: 30_000 });
  await panel.page.screenshot({ path: path.join(outDir, "sidepanel-transcript.png"), fullPage: true });
  await panel.page.evaluate((label) => {
    const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (b) => b.textContent === label,
    );
    tab?.click();
  }, EN.sidepanel.tabs.glossary);
  await panel.page.waitForSelector("form.add", { timeout: 15_000 });
  const seriesKey = await panel.page.$eval(".series .key", (el) => el.textContent ?? "");
  await sendFromPage(panel.page, "engine", "en:series-update", {
    seriesKey,
    patch: {
      pronouns: [
        {
          a: "Minjun",
          b: "Seoyeon",
          aSelf: "tớ",
          aToB: "cậu",
          source: "learned",
          sightings: 3,
          updatedAt: 2,
        },
        { a: "Seoyeon", b: "Minjun", aSelf: "em", aToB: "anh", source: "manual" },
      ],
    },
  });
  await panel.page.evaluate((label) => {
    [...document.querySelectorAll<HTMLButtonElement>(".actions button")]
      .find((b) => b.textContent === label)
      ?.click();
  }, EN.sidepanel.refresh);
  await panel.page.waitForSelector(".entry.address", { timeout: 15_000 });
  await panel.page.screenshot({ path: path.join(outDir, "sidepanel-glossary.png"), fullPage: true });
  console.log(`saved to ${outDir}`);
} finally {
  await h.close();
}
