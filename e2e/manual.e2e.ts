// Manual mode: with the site in "manual" mode nothing is uploaded when the page loads; the translate-visible command
// (the service worker sends cs:translate-visible to the tab, as its keyboard command and the popup do) translates it.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  balloonUnits,
  chats,
  covered,
  enableSite,
  groundTruth,
  openPage,
  paintedUnits,
  sendToTab,
  sleep,
  tabIdOf,
  waitAllImages,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, waitForSummary, type Harness } from "./helpers/launch.ts";

/** How long a manual page is watched for an unwanted upload. */
const SETTLE_MS = 4_000;

let h: Harness;
let opened: OpenedPage | null = null;

before(async () => {
  h = await launch();
  await enableSite(h, "manual");
});

after(async () => {
  await h?.close();
});

test("manual mode uploads nothing when the page loads", async () => {
  opened = await openPage(h, "/paged/?set=ko-p01");
  const current = opened;
  await withDiagnostics(h, current, async () => {
    const tracked = await waitForSummary(current.page, (s) => Object.keys(s.images).length >= 1, 30_000);
    assert.equal(tracked.mode, "manual");
    await sleep(SETTLE_MS);
    const later = await waitForSummary(current.page, () => true);
    assert.equal(chats(h).length, 0, "no chat request without a user request");
    assert.equal(later.paintedTotal, 0);
    assert.ok(
      Object.values(later.images).every(
        (state) => !["translating", "done", "partial", "refused"].includes(state),
      ),
      JSON.stringify(later.images),
    );
    assert.equal((await paintedUnits(current.page)).length, 0);
  });
});

test("translate-visible from the service worker translates the on-screen page", async () => {
  const current = opened;
  assert.ok(current !== null, "needs the previous test's page");
  await withDiagnostics(h, current, async () => {
    const tabId = await tabIdOf(h, current.page.url());
    const reply = await sendToTab<{ submitted: number }>(h, tabId, "cs:translate-visible", {});
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.data?.submitted, 1, "the one page image on screen");
    const done = await waitAllImages(current.page, ["done"], 1, 120_000);
    assert.equal(done.mode, "manual");
    const gt = await groundTruth("ko-p01");
    const balloons = balloonUnits(gt);
    const hit = covered(balloons, await paintedUnits(current.page));
    assert.ok(hit.length >= Math.ceil(balloons.length * 0.95), `painted ${hit.length}/${balloons.length}`);
    assert.ok(chats(h).length >= 1);
    // A second request finds nothing left to do.
    const again = await sendToTab<{ submitted: number }>(h, tabId, "cs:translate-visible", {});
    assert.equal(again.data?.submitted, 0);
  });
});
