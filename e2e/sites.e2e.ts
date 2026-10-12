// Reader-site shapes: a Referer-gated CDN (engine fetch + DNR referer rule), a strict CSP page with Trusted Types,
// a lazy-loading webtoon strip scrolled through, and back/forward navigation (BFCache restore and a fresh load).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { summary, type Harness, launch } from "./helpers/launch.ts";
import {
  balloonUnits,
  chats,
  covered,
  enableSite,
  groundTruth,
  openPage,
  overlayHosts,
  paintedUnits,
  sleep,
  waitAllImages,
  waitImagesSettled,
  withDiagnostics,
  TERMINAL_STATES,
  type OpenedPage,
} from "./helpers/flows.ts";

let h: Harness;

before(async () => {
  h = await launch();
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

async function expectBalloons(page: Page, set: string): Promise<void> {
  const gt = await groundTruth(set);
  const balloons = balloonUnits(gt);
  const hit = covered(balloons, await paintedUnits(page));
  assert.ok(
    hit.length >= Math.ceil(balloons.length * 0.95),
    `${set}: painted ${hit.length}/${balloons.length}`,
  );
}

test("a Referer-gated CDN image is fetched by the engine with the reader's Referer and translated", async () => {
  const opened = await openPage(h, "/protected/?set=ko-p01");
  await withDiagnostics(h, opened, async () => {
    const settled = await waitImagesSettled(opened.page, 1, 120_000);
    assert.deepEqual(Object.values(settled.images), ["done"]);
    await expectBalloons(opened.page, "ko-p01");
    assert.ok(chats(h).length >= 1, "translated now, not from a cache");
    const log = h.fixtures.requests().filter((r) => r.path === "/protected/ko-p01.png");
    // The extension's own request (no initiating page: Sec-Fetch-Site "none") passed the gate thanks to the Referer.
    const engine = log.filter((r) => r.secFetchSite === "none" && r.secFetchDest === "empty");
    assert.ok(engine.length >= 1, `no engine fetch in ${JSON.stringify(log)}`);
    assert.ok(
      engine.some((r) => r.status === 200 && (r.referer ?? "").startsWith(`${h.fixtures.readerUrl}/`)),
      `engine fetches: ${JSON.stringify(engine)}`,
    );
    const rules = await h.sw.evaluate(async () =>
      (await chrome.declarativeNetRequest.getSessionRules()).map((rule) => ({
        type: rule.action.type,
        headers: (rule.action.requestHeaders ?? []).map((x) => `${x.header}:${x.operation}`),
        domains: rule.condition.requestDomains ?? [],
      })),
    );
    assert.ok(
      rules.some(
        (rule) => rule.type === "modifyHeaders" && rule.headers.some((x) => /^referer:set$/i.test(x)),
      ),
      `no Referer rule among ${JSON.stringify(rules)}`,
    );
    await opened.page.close();
  });
});

test("a page with a strict CSP and Trusted Types still gets its overlay, without CSP violations", async () => {
  const opened = await openPage(h, "/csp/?set=zh-p01");
  await withDiagnostics(h, opened, async () => {
    const settled = await waitImagesSettled(opened.page, 1, 120_000);
    assert.deepEqual(Object.values(settled.images), ["done"]);
    await expectBalloons(opened.page, "zh-p01");
    const csp = await opened.page.evaluate(() => {
      const fx = (window as unknown as { __ctvFixture?: { violations: unknown[]; data: { csp: string } } })
        .__ctvFixture;
      return { violations: fx?.violations ?? null, policy: fx?.data.csp ?? "" };
    });
    assert.match(csp.policy, /require-trusted-types-for 'script'/);
    assert.deepEqual(csp.violations, [], "the overlay must not trip the page's CSP");
    await opened.page.close();
  });
});

test("a lazy webtoon strip scrolled through: every image settles and text-free images cost no request", async () => {
  const n = 12;
  const files = Array.from({ length: n }, (_, i) => `chapter-ko-60/${String(i + 1).padStart(3, "0")}`);
  const truths = await Promise.all(files.map((file) => groundTruth(file)));
  const textless = files.filter((_, i) => truths[i]?.units.length === 0);
  assert.ok(textless.length >= 2, "the strip has text-free images");
  const chatsBefore = chats(h).length;
  const opened = await openPage(h, `/webtoon/?set=chapter-ko-60&n=${n}&lazy=io`);
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    // Scroll to the bottom in steps, as a reader would; lazy images get their src near the viewport.
    for (let i = 0; i < 200; i += 1) {
      const atEnd = await page.evaluate(() => {
        window.scrollBy(0, Math.round(innerHeight * 0.8));
        return innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      });
      await sleep(250);
      if (atEnd) break;
    }
    const settled = await waitAllImages(page, TERMINAL_STATES, n, 150_000);
    const states = Object.values(settled.images);
    assert.equal(states.length, n, `tracked ${JSON.stringify(settled.images)}`);
    assert.equal(
      states.filter((s) => s === "no-text").length,
      textless.length,
      JSON.stringify(settled.images),
    );
    assert.equal(
      states.filter((s) => s === "done").length,
      n - textless.length,
      JSON.stringify(settled.images),
    );
    const loaded = await page.$$eval("img.page", (imgs) => imgs.filter((img) => img.complete).length);
    assert.equal(loaded, n, "every lazy image was loaded by the scroll");

    const requests = chats(h).slice(chatsBefore);
    const sent = new Set(requests.flatMap((r) => (r.testUnits ?? []).map((u) => u.src)));
    for (const file of textless) {
      assert.ok(![...sent].some((src) => src.endsWith(`/${file}.jpg`)), `${file} (no text) was uploaded`);
    }
    // Every image with text got its balloons painted.
    const painted = await paintedUnits(page);
    const balloons = truths.flatMap((gt) => balloonUnits(gt));
    const hit = covered(balloons, painted);
    assert.ok(
      hit.length >= Math.ceil(balloons.length * 0.9),
      `painted ${hit.length}/${balloons.length} balloons`,
    );
    await page.close();
  });
});

/** Opens a page, waits until it is translated and returns the painted count and host layout. */
async function translated(path: string): Promise<{ opened: OpenedPage; painted: number }> {
  const opened = await openPage(h, path);
  // Records whether a later pageshow came from the back/forward cache.
  await opened.page.evaluateOnNewDocument(() => {
    addEventListener("pageshow", (event) => {
      document.documentElement.dataset.e2eRestored = String(event.persisted);
    });
  });
  await opened.page.reload();
  const settled = await waitImagesSettled(opened.page, 1, 120_000);
  assert.deepEqual(Object.values(settled.images), ["done"]);
  return { opened, painted: settled.paintedTotal };
}

/** Away to the fixture index and back; returns whether the page came back from the back/forward cache. */
async function awayAndBack(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    (window as unknown as { __e2eMarker: number }).__e2eMarker = 1;
  });
  await page.goto(`${h.fixtures.readerUrl}/`);
  await page.goBack();
  return await page.evaluate(
    () =>
      (window as unknown as { __e2eMarker?: number }).__e2eMarker === 1 &&
      document.documentElement.dataset.e2eRestored === "true",
  );
}

async function expectSinglePaint(page: Page, painted: number): Promise<void> {
  // Give a re-run (re-submission, a second content script, a repaint) time to show up.
  await sleep(2_000);
  const settled = await waitImagesSettled(page, 1, 60_000);
  const hosts = await overlayHosts(page);
  assert.deepEqual(Object.values(hosts), [1], `overlay hosts per image: ${JSON.stringify(hosts)}`);
  const units = await paintedUnits(page);
  assert.equal(units.length, painted, "same units as before the navigation");
  assert.equal(
    new Set(units.map((u) => `${u.image ?? ""}/${u.unit ?? ""}`)).size,
    units.length,
    "no unit twice",
  );
  assert.equal(settled.paintedTotal, painted);
}

test("back/forward cache: a restored page keeps exactly one overlay host per image and paints nothing twice", async () => {
  const { opened, painted } = await translated("/paged/?set=en-p01");
  await withDiagnostics(h, opened, async () => {
    const restored = await awayAndBack(opened.page);
    if (!restored)
      console.log("note: Chrome did not restore the page from the back/forward cache; checked a reload");
    await expectSinglePaint(opened.page, painted);
    // The restored page still works: a second round trip changes nothing either.
    await awayAndBack(opened.page);
    await expectSinglePaint(opened.page, painted);
    const s = await summary(opened.page);
    assert.equal(s?.tornDown, false);
    await opened.page.close();
  });
});

test("back navigation to a no-store page reloads it and paints it once, from the cache", async () => {
  const { opened, painted } = await translated("/paged/?set=ja-p01&nostore=1");
  await withDiagnostics(h, opened, async () => {
    const chatsBefore = chats(h).length;
    await awayAndBack(opened.page);
    await expectSinglePaint(opened.page, painted);
    assert.equal(chats(h).length, chatsBefore, "the translations come from IndexedDB");
    await opened.page.close();
  });
});
