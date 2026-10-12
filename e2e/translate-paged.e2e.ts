// Demo path on a fixture page: opt the site in, open a Korean page, and the mock OpenAI-compatible server (oracle
// mode) answers from ground truth; every balloon of ko-p01 must end painted on the page. Reloading the finished page
// paints it again from the engine's IndexedDB cache without a new chat request.

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
  waitUntil,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, waitForSummary, type Harness } from "./helpers/launch.ts";

let h: Harness;
let opened: OpenedPage | null = null;
let paintedBefore = 0;

before(async () => {
  h = await launch();
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

test("auto mode translates ko-p01 and paints every ground-truth balloon", async () => {
  opened = await openPage(h, "/paged/?set=ko-p01");
  const { page } = opened;
  await withDiagnostics(h, opened, async () => {
    const gt = await groundTruth("ko-p01");
    const done = await waitForSummary(page, (s) => Object.values(s.images).some((state) => state === "done"));
    assert.equal(done.mode, "auto");
    const painted = await paintedUnits(page);
    assert.equal(painted.length, done.paintedTotal, "the summary counts what the overlay shows");
    const balloons = balloonUnits(gt);
    const hit = covered(balloons, painted);
    assert.ok(
      hit.length >= Math.ceil(balloons.length * 0.95),
      `painted ${hit.length}/${balloons.length} balloons; missing ${JSON.stringify(
        balloons.filter((u) => !hit.includes(u)).map((u) => u.id),
      )}`,
    );
    const requests = chats(h);
    assert.ok(requests.length >= 1);
    assert.ok(
      requests.every((r) => r.model === h.api.model && r.stream === true && r.status === 200),
      "streamed requests for the configured model",
    );
    // Every unit the mock translated is on the page (no translation lost between the engine and the overlay).
    const translated = requests.reduce((sum, r) => sum + (r.oracle?.matched.length ?? 0), 0);
    assert.ok(painted.length >= translated, `painted ${painted.length}, translated ${translated}`);
    paintedBefore = painted.length;
  });
});

test("reloading a finished page paints it again from the cache, without a new chat request", async () => {
  const current = opened;
  assert.ok(current !== null && paintedBefore > 0, "needs the previous test's page");
  const { page } = current;
  await withDiagnostics(h, current, async () => {
    const chatsBefore = chats(h).length;
    await page.reload();
    const done = await waitForSummary(page, (s) => Object.values(s.images).some((state) => state === "done"));
    const painted = await waitUntil(
      "the cached units painted",
      () => paintedUnits(page),
      (units) => units.length >= paintedBefore,
      15_000,
    );
    assert.equal(painted.length, paintedBefore);
    assert.equal(done.paintedTotal, paintedBefore);
    assert.equal(chats(h).length, chatsBefore, "translations come from IndexedDB, not from the API");
  });
});
