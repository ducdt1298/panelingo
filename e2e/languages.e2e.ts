// Source and target languages: Japanese, Chinese, English and Spanish pages translate and paint their balloons, and
// the configured settings.translate.targetLang is what the prompt asks for (also after a live settings change).
// Spanish is covered both ways: as the first target language, and as a source (es-p01, a page lettered like a Spanish
// scanlation) translated into Vietnamese, the language of the ground truth's reference translations.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { targetLanguage } from "../src/shared/languages.ts";
import {
  balloonUnits,
  chats,
  covered,
  enableSite,
  groundTruth,
  openPage,
  paintedUnits,
  sleep,
  waitImagesSettled,
  withDiagnostics,
} from "./helpers/flows.ts";
import { launch, type Harness } from "./helpers/launch.ts";

let h: Harness;

before(async () => {
  h = await launch({ settings: { translate: { targetLang: "es" } } });
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

/** Opens /paged/?set=<set>, waits until it settled and checks the balloon coverage; returns the new chat requests. */
async function translateSet(set: string): Promise<ReturnType<typeof chats>> {
  const before = chats(h).length;
  const opened = await openPage(h, `/paged/?set=${set}`);
  return await withDiagnostics(h, opened, async () => {
    const settled = await waitImagesSettled(opened.page, 1, 90_000);
    assert.deepEqual(Object.values(settled.images), ["done"], `${set}: ${JSON.stringify(settled.images)}`);
    const gt = await groundTruth(set);
    const painted = await paintedUnits(opened.page);
    const balloons = balloonUnits(gt);
    const hit = covered(balloons, painted);
    assert.ok(
      hit.length >= Math.ceil(balloons.length * 0.95),
      `${set}: painted ${hit.length}/${balloons.length} balloons (${painted.length} units in all)`,
    );
    const requests = chats(h).slice(before);
    assert.ok(requests.length >= 1, `${set}: no chat request`);
    // The mock's oracle found the page's ground truth in the language of the set.
    assert.ok(
      requests.every((r) => r.oracle?.lang === gt.lang),
      `${set}: oracle languages differ`,
    );
    await opened.page.close();
    return requests;
  });
}

for (const set of ["ja-p01", "zh-p01", "en-p01"]) {
  test(`${set} translates and paints at least 95% of its balloons`, async () => {
    await translateSet(set);
  });
}

test("every request asked for the configured target language (Spanish)", () => {
  const spanish = targetLanguage("es")?.englishName;
  assert.equal(spanish, "Spanish");
  const requests = chats(h);
  assert.ok(requests.length >= 3);
  for (const r of requests) {
    assert.ok(
      r.systemText.includes(`spoken ${spanish}`),
      `system prompt without Spanish: ${r.systemText.slice(0, 200)}`,
    );
    assert.ok(!r.systemText.includes("spoken Vietnamese"));
  }
});

test("changing the target language applies to the next request (French)", async () => {
  await h.patchSettings({ translate: { targetLang: "fr" } });
  await sleep(500); // the service worker relays the change to the engine
  const requests = await translateSet("ko-p01");
  const french = targetLanguage("fr")?.englishName ?? "French";
  for (const r of requests) {
    assert.ok(
      r.systemText.includes(`spoken ${french}`),
      `system prompt without French: ${r.systemText.slice(0, 200)}`,
    );
    assert.ok(!r.systemText.includes("spoken Spanish"));
  }
});

test("es-p01 (Spanish source) translates into Vietnamese and paints at least 95% of its balloons", async () => {
  await h.patchSettings({ translate: { targetLang: "vi" } });
  await sleep(500);
  const requests = await translateSet("es-p01");
  for (const r of requests) {
    assert.ok(
      r.systemText.includes("spoken Vietnamese"),
      `prompt not into Vietnamese: ${r.systemText.slice(0, 200)}`,
    );
    assert.ok(!r.systemText.includes("spoken French"));
  }
});
