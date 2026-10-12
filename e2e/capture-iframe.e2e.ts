// Screen capture inside a reader iframe: the reader page (127.0.0.1) embeds the comic in a cross-origin frame
// (the CDN origin, enabled through the site's extraFrameOrigins). The frame draws a tainted canvas, so only a capture
// can read it; it learns where it sits in the tab from the top frame's content script (the offset chain), both the
// frame and the page scroll for the tiles, and everything is put back afterwards.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Frame, Page } from "puppeteer-core";
import { launch, type ContentSummary, type Harness } from "./helpers/launch.ts";
import {
  balloonUnits,
  covered,
  engineLogs,
  groundTruth,
  sleep,
  waitUntil,
  withDiagnostics,
  type OpenedPage,
  type PaintedUnit,
} from "./helpers/flows.ts";

const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 };

let h: Harness;

before(async () => {
  h = await launch();
  const siteKey = new URL(h.fixtures.readerUrl).origin;
  const cdn = new URL(h.fixtures.cdnUrl).origin;
  await h.setStorage({ [`site:${siteKey}`]: { enabled: true, mode: "auto", extraFrameOrigins: [cdn] } });
  await sleep(600);
});

after(async () => {
  await h?.close();
});

async function open(path: string): Promise<OpenedPage> {
  const page = await h.browser.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${String(error)}`));
  await page.setViewport(VIEWPORT);
  await page.bringToFront();
  await page.goto(`${h.fixtures.readerUrl}${path}`);
  return { page, logs };
}

function readerFrame(page: Page): Frame | undefined {
  return page.frames().find((frame) => frame.url().includes("/frame/capture/"));
}

async function frameSummary(frame: Frame): Promise<ContentSummary | null> {
  const raw = await frame.evaluate(() => document.documentElement.dataset.ctvTest ?? null);
  return raw === null ? null : (JSON.parse(raw) as ContentSummary);
}

async function framePainted(frame: Frame): Promise<PaintedUnit[]> {
  return await frame.evaluate(() =>
    [...document.querySelectorAll("[data-ctv-host]")].flatMap((host) =>
      [...(host.shadowRoot?.querySelectorAll(".unit") ?? [])].map((unit) => {
        const line = unit.querySelector<HTMLElement>(".line");
        return {
          image: host.getAttribute("data-ctv-image"),
          unit: unit.getAttribute("data-unit"),
          erase: unit.getAttribute("data-erase"),
          kind: unit.getAttribute("data-kind"),
          fontPx: line === null ? null : Number.parseFloat(line.style.fontSize),
          text: [...unit.querySelectorAll(".line")].map((l) => l.textContent ?? "").join(" "),
        };
      }),
    ),
  );
}

test("a tainted canvas in a cross-origin reader iframe is captured through the frame chain, translated and painted", async () => {
  const opened = await open("/capture/iframe.html?set=ko-p01");
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    const frame = await waitUntil(
      "the reader frame",
      () => readerFrame(page),
      (f) => f !== undefined,
      30_000,
    );
    if (frame === undefined) throw new Error("no reader frame");
    const settled = await waitUntil(
      "the framed image to settle",
      () => frameSummary(frame),
      (s) =>
        s !== null && Object.values(s.images).some((state) => ["done", "error", "partial"].includes(state)),
      150_000,
      250,
    );
    const [key, state] = Object.entries(settled?.images ?? {})[0] ?? [];
    assert.equal(state, "done", JSON.stringify(settled));
    assert.deepEqual(settled?.lowRes, [key], "read from a screen capture");
    const balloons = balloonUnits(await groundTruth("ko-p01"));
    const hit = covered(balloons, await framePainted(frame));
    assert.ok(hit.length >= Math.ceil(balloons.length * 0.95), `painted ${hit.length}/${balloons.length}`);
    await sleep(1_200);
    const line = (await engineLogs(h.browser))
      .filter((l) => l.includes("image read from a screen capture"))
      .at(-1);
    assert.match(line ?? "", /"frame":[1-9]/u, "captured in a subframe");
    assert.match(line ?? "", /"w":1200,"h":1800/u, "the whole canvas at its natural size");
    // The frame (1000 px tall, scrolling inside) and the page both scrolled for the tiles, and both went back.
    assert.equal(await page.evaluate(() => Math.round(scrollY)), 0, "the reader page is back at the top");
    assert.equal(await frame.evaluate(() => Math.round(scrollY)), 0, "the frame is back at the top");
    await page.close();
  });
});
