// Screen-capture fallback (ladder step 3): images neither the content script nor the engine can read are captured
// from the screen, cropped (and stitched from tiles when larger than the viewport), translated and painted:
// a canvas tainted by a cross-origin image, a CDN that refuses the engine, an image below the fold that is captured
// once scrolled into view, a background tab where the capture is refused until the tab is in front, and images
// wider than the viewport (columns, and a grid when both sides exceed it). Reader iframes: capture-iframe.e2e.ts.
// chrome.tabs.captureVisibleTab works in Chrome's headless mode too, so this file runs headless and headed.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { launch, waitForSummary, type ContentSummary, type Harness } from "./helpers/launch.ts";
import {
  balloonUnits,
  chats,
  covered,
  engineLogs,
  groundTruth,
  paintedUnits,
  sendToTab,
  sleep,
  tabIdOf,
  waitUntil,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";

/** One CSS px per image px: the capture has the fixture's natural size, so the mock's oracle matches its boxes. */
const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 };

let h: Harness;

before(async () => {
  h = await launch({ settings: { discovery: { translateHiddenTabs: true } } });
  const siteKey = new URL(h.fixtures.readerUrl).origin;
  // A fixed origin-only Referer: the full-URL gate of /protected-full/ refuses every engine fetch.
  await h.setStorage({ [`site:${siteKey}`]: { enabled: true, mode: "auto", referer: "origin" } });
  await sleep(600);
});

after(async () => {
  await h?.close();
});

async function open(path: string, front = true, viewport = VIEWPORT): Promise<OpenedPage> {
  const page = await h.browser.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${String(error)}`));
  await page.setViewport(viewport);
  if (front) await page.bringToFront();
  await page.goto(`${h.fixtures.readerUrl}${path}`);
  return { page, logs };
}

async function expectBalloons(page: Page, set: string, min = 0.95): Promise<void> {
  const balloons = balloonUnits(await groundTruth(set));
  const hit = covered(balloons, await paintedUnits(page));
  assert.ok(
    hit.length >= Math.ceil(balloons.length * min),
    `${set}: painted ${hit.length}/${balloons.length}`,
  );
}

/** Opacity of every overlay host: a finished capture leaves none hidden. */
async function hiddenHosts(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>("[data-ctv-host]")].filter(
        (host) => host.style.getPropertyValue("opacity") === "0",
      ).length,
  );
}

function only(s: ContentSummary): [string, string] {
  const entries = Object.entries(s.images);
  assert.equal(entries.length, 1, JSON.stringify(s.images));
  return entries[0] as [string, string];
}

test("a canvas tainted by a cross-origin image is read from screen captures, stitched, translated and painted", async () => {
  const opened = await open("/capture/ko-p01.html?set=ko-p01");
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    const before = chats(h).length;
    const settled = await waitForSummary(
      page,
      (s) => Object.values(s.images).some((state) => ["done", "error", "partial"].includes(state)),
      150_000,
    );
    const [key, state] = only(settled);
    assert.equal(state, "done", JSON.stringify(settled));
    assert.deepEqual(settled.lowRes, [key], "marked as read from a screen capture");
    await expectBalloons(page, "ko-p01");
    // The upload came from the capture: the canvas has no URL, only its discovery key.
    const sent = chats(h)
      .slice(before)
      .flatMap((r) => (r.testUnits ?? []).map((u) => u.src));
    assert.ok(sent.length > 0 && sent.every((src) => src.includes("#ctv-canvas-")), JSON.stringify(sent));
    // The page is 1800 px tall in a 900 px viewport: captured in bands, then scrolled back and the overlay shown.
    assert.equal(await page.evaluate(() => Math.round(scrollY)), 0, "the scroll position is restored");
    assert.equal(await hiddenHosts(page), 0, "the overlay is visible again");
    await page.close();
  });
});

test("a CDN that refuses the engine: the image on screen is captured instead and translated", async () => {
  const opened = await open("/protected-full/?set=ja-p01");
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    const settled = await waitForSummary(
      page,
      (s) => Object.values(s.images).some((state) => ["done", "error", "partial"].includes(state)),
      150_000,
    );
    const [key, state] = only(settled);
    assert.equal(state, "done", JSON.stringify(settled));
    assert.deepEqual(settled.lowRes, [key]);
    await expectBalloons(page, "ja-p01");
    const engine = h.fixtures
      .requests()
      .filter((r) => r.path === "/protected-full/ja-p01.png" && r.secFetchSite === "none");
    assert.ok(engine.length >= 1, "the engine tried the URL first");
    assert.ok(
      engine.every((r) => r.status === 403),
      `the engine never got the image: ${JSON.stringify(engine)}`,
    );
    await page.close();
  });
});

test("an image below the fold is captured only once it is scrolled into view", async () => {
  const opened = await open("/webtoon/?set=chapter-ko-60&n=2&lazy=none&protected=full");
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    const second = await page.$eval("#p2", (img) => img.getBoundingClientRect().top + scrollY);
    // The first image (on screen) is captured; the second waits for the reader.
    const waiting = await waitForSummary(
      page,
      (s) => Object.keys(s.images).length === 2 && Object.values(s.images).includes("done"),
      150_000,
    );
    const keyOf = (s: ContentSummary, id: string): string =>
      Object.entries(s.ids).find(([, value]) => value === id)?.[0] ?? "";
    const k2 = keyOf(waiting, "p2");
    assert.ok(k2 !== "", JSON.stringify(waiting.ids));
    assert.equal(waiting.images[k2], "error", JSON.stringify(waiting));
    assert.equal(waiting.errors[k2], "image.capture_unavailable", "it says: scroll to the image");
    await page.evaluate((top) => window.scrollTo({ top: top - 40, behavior: "instant" }), second);
    const settled = await waitForSummary(page, (s) => s.images[k2] === "done", 150_000);
    assert.ok(settled.lowRes.includes(k2), JSON.stringify(settled.lowRes));
    const gt = await groundTruth("chapter-ko-60/002");
    const hit = covered(balloonUnits(gt), await paintedUnits(page));
    assert.ok(hit.length >= Math.ceil(balloonUnits(gt).length * 0.95), `002: painted ${hit.length}`);
    await page.close();
  });
});

test("in a background tab the capture is refused with a clear error; in front, a retry translates it", async () => {
  // Opened behind the current tab (translateHiddenTabs lets the content script start there).
  const front = await h.browser.newPage();
  await front.setViewport(VIEWPORT);
  const opened = await open("/protected-full/?set=en-p01", false);
  await front.bringToFront();
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    const refused = await waitForSummary(page, (s) => Object.values(s.images).includes("error"), 120_000);
    const [key] = only(refused);
    assert.equal(refused.errors[key], "image.capture_blocked", JSON.stringify(refused));
    assert.equal(refused.lowRes.length, 0);
    await page.bringToFront();
    await front.close();
    await sleep(300);
    const tabId = await tabIdOf(h, `${h.fixtures.readerUrl}/protected-full/?set=en-p01`);
    await waitUntil(
      "a retry from the page",
      async () =>
        (await sendToTab<{ submitted: number }>(h, tabId, "cs:translate-visible", {})).data?.submitted,
      (n) => (n ?? 0) >= 1,
      10_000,
      500,
    );
    const settled = await waitForSummary(page, (s) => s.images[key] === "done", 150_000);
    assert.deepEqual(settled.lowRes, [key]);
    await expectBalloons(page, "en-p01");
    await page.close();
  });
});

/** Tiles of the last screen capture of the engine log ("image read from a screen capture {tiles}"). */
async function lastTiles(): Promise<number | null> {
  await sleep(1_200); // the engine flushes its log every second
  const line = (await engineLogs(h.browser))
    .filter((l) => l.includes("image read from a screen capture"))
    .at(-1);
  const match = /"tiles":(\d+)/.exec(line ?? "");
  return match === null ? null : Number(match[1]);
}

const NARROW = { width: 800, height: 900, deviceScaleFactor: 1 };

test("an image wider than the viewport is captured in columns, stitched, translated and painted", async () => {
  // 1200×1800 in an 800×1900 window: it fits vertically, not horizontally.
  const opened = await open("/capture/ko-p01.html?set=ko-p01", true, { ...NARROW, height: 1900 });
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    const settled = await waitForSummary(
      page,
      (s) => Object.values(s.images).some((state) => ["done", "error", "partial"].includes(state)),
      150_000,
    );
    const [key, state] = only(settled);
    assert.equal(state, "done", JSON.stringify(settled));
    assert.deepEqual(settled.lowRes, [key]);
    assert.equal(await lastTiles(), 3, "three columns, one row");
    await expectBalloons(page, "ko-p01");
    assert.deepEqual(await page.evaluate(() => [Math.round(scrollX), Math.round(scrollY)]), [0, 0]);
    assert.equal(await hiddenHosts(page), 0);
    await page.close();
  });
});

test("an image wider and taller than the viewport is captured as a grid of tiles", async () => {
  const opened = await open("/capture/ko-p01.html?set=ko-p01", true, NARROW);
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    const settled = await waitForSummary(
      page,
      (s) => Object.values(s.images).some((state) => ["done", "error", "partial"].includes(state)),
      150_000,
    );
    const [key, state] = only(settled);
    assert.equal(state, "done", JSON.stringify(settled));
    assert.deepEqual(settled.lowRes, [key]);
    assert.equal(await lastTiles(), 12, "1200×1800 in an 800×900 window: 4 rows × 3 columns");
    await expectBalloons(page, "ko-p01");
    assert.deepEqual(await page.evaluate(() => [Math.round(scrollX), Math.round(scrollY)]), [0, 0]);
    await page.close();
  });
});
