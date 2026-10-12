// Look-ahead (tier-B discovery): lazy images below the fold that the page has not loaded are fetched and detected
// by the engine before the reader gets there, the ones inside the translate window are translated (and painted over
// the still-empty element), text-free ones are never uploaded, and nothing is sent twice once the page loads them.
// The horizons are pinned (min = max) so the windows do not follow the measured latency.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { launch, summary, waitForSummary, type ContentSummary, type Harness } from "./helpers/launch.ts";
import {
  balloonUnits,
  chats,
  covered,
  enableSite,
  groundTruth,
  openPage,
  paintedUnits,
  sleep,
  withDiagnostics,
} from "./helpers/flows.ts";

let h: Harness;

before(async () => {
  h = await launch({
    settings: {
      discovery: {
        // Translate window: 8 screens below the viewport; detect horizon: 14 screens.
        lookaheadMinScreens: 8,
        lookaheadMaxScreens: 8,
        lookaheadMaxScreensStrip: 8,
        detectAheadMinScreens: 14,
        detectAheadMaxScreens: 14,
      },
    },
  });
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

function keyOf(s: ContentSummary, id: string): string | null {
  return Object.entries(s.ids).find(([, value]) => value === id)?.[0] ?? null;
}

function stateOf(s: ContentSummary, id: string): string | null {
  const key = keyOf(s, id);
  return key === null ? null : (s.images[key] ?? null);
}

/** Has the page itself loaded the image yet (IntersectionObserver lazy loading sets src near the viewport)? */
async function loadedByPage(page: Page, id: string): Promise<boolean> {
  return await page.$eval(`#${id}`, (img) => (img as HTMLImageElement).hasAttribute("src"));
}

function uploadedFiles(from: number): Set<string> {
  return new Set(
    chats(h)
      .slice(from)
      .flatMap((r) =>
        (r.testUnits ?? []).map((u) => u.src.replace(/^.*\/chapter-ko-60\//, "").replace(/\?.*$/, "")),
      ),
  );
}

test("lazy images below the fold are detected and translated before the page loads them; text-free ones never uploaded", async () => {
  const gt = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((n) => groundTruth(`chapter-ko-60/${String(n).padStart(3, "0")}`)),
  );
  assert.deepEqual(
    gt.map((g) => g.units.length > 0),
    [true, true, true, true, false, false],
    "fixture: images 5 and 6 have no text",
  );
  const before = chats(h).length;
  const opened = await openPage(h, "/webtoon/?set=chapter-ko-60&n=12&lazy=io");
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    // 800×600 viewport, images 800×2000 from y = 37: p2 has priority 3.39, p3 6.73, p4 10.06, p5 13.39, p6 16.73.
    const ahead = await waitForSummary(
      page,
      (s) =>
        stateOf(s, "p2") === "done" &&
        stateOf(s, "p3") === "done" &&
        stateOf(s, "p4") === "waiting" &&
        stateOf(s, "p5") === "no-text",
      150_000,
    );
    for (const id of ["p2", "p3", "p4", "p5"]) {
      assert.equal(await loadedByPage(page, id), false, `${id} is still not loaded by the page`);
    }
    assert.equal(keyOf(ahead, "p6"), null, "p6 is beyond the detect horizon");
    assert.ok(
      keyOf(ahead, "p4") !== null && ahead.prefetch.includes(keyOf(ahead, "p4") ?? ""),
      "p4: detected only",
    );
    const sent = uploadedFiles(before);
    assert.ok(
      sent.has("002.jpg") && sent.has("003.jpg"),
      `inside the translate window: ${[...sent].join(",")}`,
    );
    assert.ok(!sent.has("004.jpg"), "p4 is outside the translate window: nothing uploaded yet");
    assert.ok(!sent.has("005.jpg"), "p5 has no text: never uploaded");
    // The translations already sit over the empty elements.
    const painted = await paintedUnits(page);
    for (const n of [2, 3]) {
      const balloons = balloonUnits(gt[n - 1] ?? { image: "", width: 0, height: 0, lang: "", units: [] });
      const hit = covered(balloons, painted);
      assert.ok(
        hit.length >= Math.ceil(balloons.length * 0.95),
        `p${n}: painted ${hit.length}/${balloons.length}`,
      );
    }

    // Two screens down: p4 (8.06) enters the translate window, p6 (14.73) the detect horizon.
    await page.evaluate(() => window.scrollTo({ top: 1200, behavior: "instant" }));
    const moved = await waitForSummary(
      page,
      (s) => stateOf(s, "p4") === "done" && stateOf(s, "p6") === "no-text",
      150_000,
    );
    assert.ok(moved.prefetch.length === 0 || !moved.prefetch.includes(keyOf(moved, "p4") ?? ""));
    const later = uploadedFiles(before);
    assert.ok(later.has("004.jpg"), "p4 was translated once in the window");
    assert.ok(!later.has("005.jpg") && !later.has("006.jpg"), "text-free images are never uploaded");

    // Read on: the page loads p2 and p3 itself; they keep their key and nothing is uploaded again.
    const chatsBefore = chats(h).length;
    const top = await page.$eval("#p3", (img) => img.getBoundingClientRect().top + window.scrollY);
    for (let y = 1200; y <= top; y += 450) {
      await page.evaluate((to) => window.scrollTo({ top: to, behavior: "instant" }), y);
      await sleep(250);
    }
    await page.waitForFunction(() => document.querySelector("#p3")?.hasAttribute("src") === true, {
      timeout: 30_000,
    });
    await sleep(2_000);
    const read = await summary(page);
    assert.ok(read !== null);
    assert.equal(keyOf(read, "p2"), keyOf(ahead, "p2"), "the loaded image kept its key");
    assert.equal(keyOf(read, "p3"), keyOf(ahead, "p3"));
    assert.equal(stateOf(read, "p3"), "done");
    const repeat = chats(h)
      .slice(chatsBefore)
      .flatMap((r) => (r.testUnits ?? []).map((u) => u.src))
      .filter((src) => /\/00[2-4]\.jpg/.test(src));
    assert.deepEqual(repeat, [], "nothing translated twice");
    assert.ok((read.painted[keyOf(read, "p3") ?? ""] ?? 0) > 0, "p3 still painted after it loaded");
    await page.close();
  });
});
