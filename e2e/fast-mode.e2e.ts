// Fast mode (settings.translate.fastMode): the prompt asks for compact #n|type|translation lines and no learning
// lines, the mock answers in that form, and the page still gets its balloons painted. (No chapter history in fast
// mode is covered by the translator's unit tests.)

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { COMPACT_ITEM_LINE } from "../src/shared/core/prompt.ts";
import {
  balloonUnits,
  chats,
  covered,
  enableSite,
  groundTruth,
  openPage,
  paintedUnits,
  waitImagesSettled,
  withDiagnostics,
} from "./helpers/flows.ts";
import { launch, type Harness } from "./helpers/launch.ts";

let h: Harness;

before(async () => {
  h = await launch({ settings: { translate: { fastMode: true } } });
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

test("ko-p01 in fast mode: compact requests and answers, at least 95% of the balloons painted", async () => {
  const opened = await openPage(h, "/paged/?set=ko-p01");
  await withDiagnostics(h, opened, async () => {
    const settled = await waitImagesSettled(opened.page, 1, 90_000);
    assert.deepEqual(Object.values(settled.images), ["done"], JSON.stringify(settled.images));
    const gt = await groundTruth("ko-p01");
    const balloons = balloonUnits(gt);
    const hit = covered(balloons, await paintedUnits(opened.page));
    assert.ok(hit.length >= Math.ceil(balloons.length * 0.95), `painted ${hit.length}/${balloons.length}`);
    const requests = chats(h);
    assert.ok(requests.length >= 1, "no chat request");
    for (const request of requests) {
      assert.ok(request.systemText.includes(COMPACT_ITEM_LINE), "the compact contract");
      assert.ok(!request.systemText.includes("@term|") && !request.systemText.includes("@sum|"));
    }
  });
});
