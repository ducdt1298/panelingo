// API failures against the mock: a transient 500 is retried and the page still ends painted; a refusal leaves the
// original untouched and is not uploaded again; a wrong API key pauses the image (nothing painted), the popup and
// the engine report the unauthorized readiness, and translation resumes by itself once the right key is saved.
// Retry delays (src/shared/core/retry-policy.ts): a 5xx waits HTTP_BACKOFF_MS[0] = 2 s ± 20%, refusals are final.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { EN } from "../src/shared/i18n/en.ts";
import { HTTP_BACKOFF_MS, JITTER_RATIO, UNAUTHORIZED_PROBE_MS } from "../src/shared/core/retry-policy.ts";
import {
  balloonUnits,
  chats,
  covered,
  enableSite,
  groundTruth,
  openExtensionPage,
  openPage,
  paintedUnits,
  sendFromPage,
  sleep,
  waitAllImages,
  waitImagesSettled,
  waitUntil,
  withDiagnostics,
} from "./helpers/flows.ts";
import { launch, type Harness } from "./helpers/launch.ts";

/** The key the mock accepts. */
const API_KEY = "sk-e2e-mock";

let h: Harness;

before(async () => {
  // The mock checks the key, as a hosted provider does.
  h = await launch({ api: { apiKey: API_KEY }, settings: { api: { apiKey: API_KEY } } });
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

/** What the overlay shows on top of the page: units, erase patches, plates or text lines. */
async function overlayInk(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-ctv-host]")].flatMap((host) => [
        ...(host.shadowRoot?.querySelectorAll(".unit, canvas.patch, .plate, .line") ?? []),
      ]).length,
  );
}

test("a transient 500 is retried after the backoff and the page still ends fully painted", async () => {
  h.api.reset();
  h.api.setScenario({ name: "fail-once", sequence: [{ failBeforeHeaders: "server_error" }] });
  const opened = await openPage(h, "/paged/?set=ko-p01");
  await withDiagnostics(h, opened, async () => {
    const settled = await waitImagesSettled(opened.page, 1, 120_000);
    assert.deepEqual(Object.values(settled.images), ["done"]);
    const gt = await groundTruth("ko-p01");
    const balloons = balloonUnits(gt);
    const hit = covered(balloons, await paintedUnits(opened.page));
    assert.equal(hit.length, balloons.length, `painted ${hit.length}/${balloons.length} balloons`);

    const requests = chats(h);
    const failed = requests.filter((r) => r.status === 500);
    assert.equal(failed.length, 1, "exactly the first request failed");
    assert.equal(failed[0]?.errorCode, "server_error");
    // The retry carries the same units and waited for the backoff.
    const units = (r: (typeof requests)[number]): string => JSON.stringify(r.testUnits?.map((u) => u.box));
    const retry = requests.find(
      (r) => r.status === 200 && r.seq > (failed[0]?.seq ?? 0) && units(r) === units(failed[0]!),
    );
    assert.ok(retry !== undefined, "the failed pack was sent again");
    const minWait = (HTTP_BACKOFF_MS[0] ?? 2_000) * (1 - JITTER_RATIO) - 100;
    assert.ok(retry.t - (failed[0]?.t ?? 0) >= minWait, `retried after ${retry.t - (failed[0]?.t ?? 0)} ms`);
    await opened.page.close();
  });
});

test("a refusal leaves the original untouched and is not uploaded again", async () => {
  h.api.reset();
  h.api.setScenario({ name: "refusal", refusal: true });
  const opened = await openPage(h, "/paged/?set=ja-p01");
  await withDiagnostics(h, opened, async () => {
    const settled = await waitImagesSettled(opened.page, 1, 120_000);
    assert.deepEqual(Object.values(settled.images), ["refused"]);
    assert.equal(settled.paintedTotal, 0);
    await sleep(1_000); // nothing arrives late either
    assert.equal(await overlayInk(opened.page), 0, "no patch, plate or text over the refused page");
    const requests = chats(h);
    assert.ok(requests.length >= 1);
    assert.ok(requests.every((r) => r.scenarioName === "refusal" && r.status === 200));
    // Refused content is never sent twice (it would be uploaded again and is never deleted upstream).
    const boxes = requests.flatMap((r) => (r.testUnits ?? []).map((u) => JSON.stringify([u.src, u.box])));
    assert.equal(new Set(boxes).size, boxes.length, "a unit was uploaded twice");
    await opened.page.close();
  });
});

test("a wrong API key pauses the image, popup and engine report it, and fixing the key resumes at once", async () => {
  h.api.reset();
  await h.patchSettings({ api: { apiKey: "sk-e2e-wrong" } });
  const opened = await openPage(h, "/paged/?set=zh-p01");
  let popup: Page | null = null;
  await withDiagnostics(h, opened, async () => {
    const paused = await waitAllImages(opened.page, ["paused", "error"], 1, 120_000);
    assert.equal(paused.paintedTotal, 0);
    assert.equal(await overlayInk(opened.page), 0, "nothing painted without a translation");
    assert.ok(
      chats(h).every((r) => r.status === 401 && !r.authorized),
      "no chat request got through with the wrong key",
    );

    const view = await openExtensionPage(h, "popup");
    popup = view.page;
    const textOf = (selector: string): Promise<string> =>
      view.page.$eval(selector, (el) => el.textContent?.trim() ?? "").catch(() => "");
    await waitUntil(
      "the unauthorized readiness",
      () => textOf("#api .pill"),
      (v) => v === EN.readiness.unauthorized.label,
    );
    const status = await waitUntil(
      "engine status unauthorized",
      async () =>
        (
          await sendFromPage<{ api: { readiness: string }; queue: { pausedBy: string | null } }>(
            view.page,
            "engine",
            "en:status",
            {},
          )
        ).data ?? null,
      (s) => s !== null && s.api.readiness === "unauthorized",
      30_000,
    );
    assert.equal(status?.queue.pausedBy, "api.unauthorized");
    const pausedLine = EN.popup.pausedBy(EN.errors["api.unauthorized"].title);
    await waitUntil(
      "the paused line in the popup",
      () => textOf("#engine"),
      (v) => v.includes(pausedLine),
      15_000,
    );

    // The user saves the right key: the paused page is translated without a reload, well before the 60 s probe.
    const fixedAt = Date.now();
    await h.patchSettings({ api: { apiKey: API_KEY } });
    const done = await waitAllImages(opened.page, ["done"], 1, 90_000);
    const gt = await groundTruth("zh-p01");
    const balloons = balloonUnits(gt);
    const hit = covered(balloons, await paintedUnits(opened.page));
    assert.equal(hit.length, balloons.length, `painted ${hit.length}/${balloons.length} after the fix`);
    assert.ok(done.paintedTotal >= balloons.length);
    const accepted = chats(h).filter((r) => r.status === 200);
    assert.ok(accepted.length >= 1 && accepted.every((r) => r.authorized), "resumed with the saved key");
    const resumedAfter = Math.min(...accepted.map((r) => r.t)) - fixedAt;
    assert.ok(resumedAfter < UNAUTHORIZED_PROBE_MS, `resumed ${resumedAfter} ms after the fix`);
  });
  await (popup as Page | null)?.close();
  await opened.page.close();
});

test("a key revoked mid-request: the probe after the pause uses the key saved in the meantime", async () => {
  h.api.reset();
  const rotated = "sk-e2e-rotated";
  // The first chat request is rejected while /models was ready a moment ago (the provider revoked the key), so the
  // request itself pauses and is probed again after UNAUTHORIZED_PROBE_MS.
  h.api.setScenario({ name: "revoked", sequence: [{ failBeforeHeaders: "unauthorized" }] });
  const opened = await openPage(h, "/paged/?set=en-p01");
  await withDiagnostics(h, opened, async () => {
    const rejected = await waitUntil(
      "the rejected request",
      () => chats(h).filter((r) => r.status === 401),
      (list) => list.length >= 1,
      120_000,
    );
    // The provider now only accepts the new key, and the user saves it.
    h.api.setApiKey(rotated);
    await h.patchSettings({ api: { apiKey: rotated } });
    const done = await waitAllImages(opened.page, ["done"], 1, UNAUTHORIZED_PROBE_MS + 60_000);
    assert.ok(done.paintedTotal > 0);
    const gt = await groundTruth("en-p01");
    const balloons = balloonUnits(gt);
    const hit = covered(balloons, await paintedUnits(opened.page));
    assert.equal(hit.length, balloons.length, `painted ${hit.length}/${balloons.length}`);
    const after = chats(h).filter((r) => r.seq > (rejected[0]?.seq ?? 0));
    assert.ok(
      after.filter((r) => r.status === 401).length === 0,
      `a request after the rotation still used the old key: ${JSON.stringify(after.map((r) => [r.seq, r.status]))}`,
    );
    await opened.page.close();
  });
});
