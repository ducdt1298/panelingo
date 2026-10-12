// Bubble popup on ko-p01: Alt+click on a painted balloon opens a dialog with the original and the full translation
// while the page sees no click; Edit + Save sends the edit to the engine and the overlay letters it; Escape closes the
// popup; an ordinary click passes through to the page; a long press opens the popup too and swallows its click.
// CTV_SHOT=<png> saves a screenshot with the popup open.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ElementHandle, Page } from "puppeteer-core";
import {
  enableSite,
  groundTruth,
  paintedFor,
  paintedUnits,
  sleep,
  waitUntil,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, waitForSummary, type Harness } from "./helpers/launch.ts";

interface PopupState {
  open: boolean;
  role: string | null;
  title: string;
  original: string;
  translation: string;
  edited: boolean;
  status: string;
  rect: { left: number; top: number; width: number; height: number } | null;
}

let h: Harness;

before(async () => {
  h = await launch();
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

/** The client-px center and box of a painted unit's lines (open shadow roots in test builds). */
async function unitBox(
  page: Page,
  unitKey: string,
): Promise<{ x: number; y: number; left: number; top: number; right: number; bottom: number }> {
  const box = await page.evaluate((key) => {
    for (const host of document.querySelectorAll("[data-ctv-host]")) {
      const unit = host.shadowRoot?.querySelector(`.unit[data-unit="${key}"]`);
      if (unit === null || unit === undefined) continue;
      const rects = [...unit.querySelectorAll(".line")].map((l) => l.getBoundingClientRect());
      const left = Math.min(...rects.map((r) => r.left));
      const top = Math.min(...rects.map((r) => r.top));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      return { x: (left + right) / 2, y: (top + bottom) / 2, left, top, right, bottom };
    }
    return null;
  }, unitKey);
  assert.ok(box !== null, `unit ${unitKey} is painted`);
  return box;
}

async function popupState(page: Page): Promise<PopupState> {
  return await page.evaluate(() => {
    const card =
      document.querySelector("ctv-popup")?.shadowRoot?.querySelector<HTMLElement>(".popup") ?? null;
    const text = (selector: string): string => card?.querySelector(selector)?.textContent ?? "";
    const shown = card !== null && card.isConnected && !card.hidden;
    const r = shown ? card.getBoundingClientRect() : null;
    return {
      open: shown,
      role: card?.getAttribute("role") ?? null,
      title: text(".title"),
      original: text(".original"),
      translation: text(".translation"),
      edited: card?.querySelector<HTMLElement>(".tag")?.hidden === false,
      status: text(".status"),
      rect: r === null ? null : { left: r.left, top: r.top, width: r.width, height: r.height },
    };
  });
}

async function popupButton(page: Page, className: string): Promise<ElementHandle<HTMLElement>> {
  const handle = await page.evaluateHandle(
    (name) =>
      document.querySelector("ctv-popup")?.shadowRoot?.querySelector<HTMLElement>(`button.${name}`) ?? null,
    className,
  );
  const element = handle.asElement() as ElementHandle<HTMLElement> | null;
  assert.ok(element !== null, `popup button .${className}`);
  return element;
}

/** Page-side click-to-next stand-in: a click that reaches the page sets #clicked and counts. */
async function watchPageClicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __clicks: number };
    w.__clicks = 0;
    const image = document.querySelector("img");
    image?.addEventListener("click", () => {
      w.__clicks += 1;
      location.hash = "clicked";
    });
    document.addEventListener("click", () => undefined, true);
  });
}

async function pageClicks(page: Page): Promise<{ clicks: number; hash: string }> {
  return await page.evaluate(() => ({
    clicks: (window as unknown as { __clicks: number }).__clicks,
    hash: location.hash,
  }));
}

async function altClick(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.down("Alt");
  await page.mouse.click(x, y);
  await page.keyboard.up("Alt");
}

test("ko-p01: Alt+click opens the popup, Edit/Save re-letters the balloon, Escape closes, clicks pass through", async () => {
  const page = await h.browser.newPage();
  await page.setViewport({ width: 1100, height: 1300 });
  const opened: OpenedPage = { page, logs: [] };
  page.on("console", (message) => opened.logs.push(`${message.type()}: ${message.text()}`));
  await page.goto(`${h.fixtures.readerUrl}/paged/?set=ko-p01`);

  await withDiagnostics(h, opened, async () => {
    const gt = await groundTruth("ko-p01");
    await waitForSummary(page, (s) => Object.values(s.images).some((state) => state === "done"));
    await watchPageClicks(page);
    const painted = await paintedUnits(page);
    const target = gt.units.find((u) => u.id === 3);
    const other = gt.units.find((u) => u.id === 2);
    assert.ok(target !== undefined && other !== undefined);
    const shown = paintedFor(target, painted);
    const otherShown = paintedFor(other, painted);
    assert.ok(shown?.unit != null && otherShown?.unit != null, "both balloons are painted");

    // 1. Alt+click: the popup opens next to the balloon with the original and the whole translation.
    const box = await unitBox(page, shown.unit);
    await altClick(page, box.x, box.y);
    const state = await waitUntil(
      "popup open",
      () => popupState(page),
      (s) => s.open,
      5_000,
    );
    assert.equal(state.role, "dialog");
    assert.equal(state.original, target.original);
    assert.ok(state.translation.includes(target.vi), `translation "${state.translation}"`);
    assert.match(state.title, /^Dialogue/u);
    assert.deepEqual(await pageClicks(page), { clicks: 0, hash: "" }, "the page saw no click");
    const viewport = page.viewport();
    assert.ok(state.rect !== null && viewport !== null);
    assert.ok(state.rect.left >= 0 && state.rect.top >= 0, "inside the viewport");
    assert.ok(state.rect.left + state.rect.width <= viewport.width);
    assert.ok(state.rect.top + state.rect.height <= viewport.height);
    const overlapX =
      Math.min(box.right, state.rect.left + state.rect.width) - Math.max(box.left, state.rect.left);
    const overlapY =
      Math.min(box.bottom, state.rect.top + state.rect.height) - Math.max(box.top, state.rect.top);
    assert.ok(overlapX <= 0 || overlapY <= 0, "next to the lettering, not over it");
    const focused = await page.evaluate(() => document.activeElement?.localName ?? null);
    assert.equal(focused, "ctv-popup", "keyboard focus moved into the dialog");
    const shot = process.env["CTV_SHOT"];
    if (shot !== undefined && shot !== "") await page.screenshot({ path: shot });

    // 2. Edit + Save: the engine stores the edit and pushes the unit back; the overlay letters it.
    const edited = "Sửa tay: bản đồ thiếu nửa thị trấn!";
    await (await popupButton(page, "edit")).click();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.type(edited);
    await (await popupButton(page, "save")).click();
    await waitUntil(
      "the overlay letters the edit",
      () => paintedUnits(page),
      (units) => units.some((u) => u.unit === shown.unit && u.text.replace(/\s+/gu, " ").includes("Sửa tay")),
      10_000,
    );
    const after = await waitUntil(
      "popup shows the edit",
      () => popupState(page),
      (s) => s.edited,
      5_000,
    );
    assert.equal(after.translation, edited);
    assert.equal(after.open, true);
    assert.deepEqual(await pageClicks(page), { clicks: 0, hash: "" }, "popup clicks stay in the popup");

    // 3. Translate again: the edit is dropped and the unit is sent to the AI once more, then lettered again.
    const chatsBefore = h.api.requests().filter((r) => r.path === "/v1/chat/completions").length;
    await (await popupButton(page, "again")).click();
    const again = await waitUntil(
      "popup shows the new AI translation",
      () => popupState(page),
      (s) => !s.edited && s.translation.includes(target.vi) && s.status === "",
      20_000,
    );
    assert.equal(again.open, true);
    await waitUntil(
      "the overlay letters the AI translation again",
      () => paintedUnits(page),
      (units) => units.some((u) => u.unit === shown.unit && !u.text.includes("Sửa tay")),
      10_000,
    );
    const chatsAfter = h.api.requests().filter((r) => r.path === "/v1/chat/completions").length;
    assert.ok(chatsAfter > chatsBefore, "a new request went to the (mock) AI");

    // 4. Escape closes it.
    await page.keyboard.press("Escape");
    await waitUntil(
      "popup closed",
      () => popupState(page),
      (s) => !s.open,
      5_000,
    );

    // 5. An ordinary click on a painted balloon passes through to the page (painted units take no pointer).
    const plain = await unitBox(page, otherShown.unit);
    await page.mouse.click(plain.x, plain.y);
    await sleep(200);
    assert.deepEqual(await pageClicks(page), { clicks: 1, hash: "#clicked" });
    assert.equal((await popupState(page)).open, false);

    // 6. A long press opens the popup and swallows the click that ends it; a press outside closes it.
    await page.mouse.move(plain.x, plain.y);
    await page.mouse.down();
    await sleep(800);
    await page.mouse.up();
    const pressed = await waitUntil(
      "popup after a long press",
      () => popupState(page),
      (s) => s.open,
      5_000,
    );
    assert.ok(pressed.translation.includes(other.vi));
    assert.equal((await pageClicks(page)).clicks, 1, "the long press's click never reached the page");
    await page.mouse.click(5, 5);
    await waitUntil(
      "popup closed by a press outside",
      () => popupState(page),
      (s) => !s.open,
      5_000,
    );
  });
});
