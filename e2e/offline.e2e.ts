// Offline mode (experimental, docs/OFFLINE-MODE.md) end to end: a Korean page is read by the on-device OCR and
// translated into English by Opus-MT with no AI endpoint. The pinned models come from a local mirror of
// .cache/offline-models (e2e/helpers/offline-models.ts) through settings.debug.offlineModelBaseUrl, so the engine
// downloads, verifies and caches them exactly as it would from Hugging Face. Runs only when the models are cached
// (npm run fetch-models -- --offline=ocr-korean,ocr-cjk,opus-mt-ko-en); otherwise every test is skipped with that
// hint, so CI without the 140 MB of models stays green.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  balloonUnits,
  chats,
  enableSite,
  groundTruth,
  openPage,
  paintedUnits,
  waitImagesSettled,
  withDiagnostics,
} from "./helpers/flows.ts";
import { launch, type Harness } from "./helpers/launch.ts";
import { missingFiles, startOfflineMirror, type OfflineMirror } from "./helpers/offline-models.ts";

/** The vote on an unknown page language reads with the CJK recognizer first, then the Korean one. */
const NEEDED = ["ocr-korean", "ocr-cjk", "opus-mt-ko-en"];
const missing = missingFiles(NEEDED);
const skip =
  missing.length === 0
    ? false
    : `offline models are not in .cache/offline-models (npm run fetch-models -- --offline=${NEEDED.join(",")})`;

let h: Harness | undefined;
let mirror: OfflineMirror | undefined;

before(async () => {
  if (skip !== false) return;
  mirror = await startOfflineMirror();
  h = await launch({
    settings: {
      translate: { engine: "offline", offlineModel: "opus-mt", targetLang: "en" },
      debug: { offlineModelBaseUrl: mirror.baseUrl },
    },
  });
  await enableSite(h);
});

after(async () => {
  await h?.close();
  await mirror?.close();
});

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/u;

test(
  "ko-p01 → English offline: balloons painted in English, and no request reaches the AI endpoint",
  { skip },
  async () => {
    assert.ok(h !== undefined && mirror !== undefined);
    const harness = h;
    const opened = await openPage(harness, "/paged/?set=ko-p01");
    await withDiagnostics(harness, opened, async () => {
      const settled = await waitImagesSettled(opened.page, 1, 240_000);
      assert.deepEqual(Object.values(settled.images), ["done"], JSON.stringify(settled.images));
      const painted = await paintedUnits(opened.page);
      const balloons = balloonUnits(await groundTruth("ko-p01"));
      assert.ok(
        painted.length >= balloons.length,
        `painted ${painted.length} units, ${balloons.length} balloons`,
      );
      const english = painted.filter((unit) => /[A-Za-z]{2}/u.test(unit.text) && !HANGUL.test(unit.text));
      assert.ok(
        english.length >= balloons.length,
        `English lettering: ${JSON.stringify(painted.map((u) => u.text))}`,
      );
      assert.ok(
        painted.some((unit) => /morning/iu.test(unit.text)),
        `"다음 날 아침" reads as the next morning: ${JSON.stringify(painted.map((u) => u.text))}`,
      );
    });
    assert.equal(chats(harness).length, 0, "no chat request");
    assert.equal(harness.api.requests().length, 0, "not even a /models check");
    const served = mirror.requests();
    for (const model of ["korean_PP-OCRv5_mobile_rec_onnx", "opus-mt-ko-en"]) {
      assert.ok(
        served.some((path) => path.includes(model)),
        `${model} came from the mirror`,
      );
    }
    await opened.page.close();
  },
);

test(
  "once downloaded, the models need no network: another Korean page translates with the mirror gone",
  { skip },
  async () => {
    assert.ok(h !== undefined && mirror !== undefined);
    const harness = h;
    const before = mirror.requests().length;
    await mirror.close();
    const opened = await openPage(harness, "/paged/?set=ko-strip01");
    await withDiagnostics(harness, opened, async () => {
      const settled = await waitImagesSettled(opened.page, 1, 240_000);
      assert.ok(
        ["done", "partial"].includes(Object.values(settled.images)[0] ?? ""),
        JSON.stringify(settled.images),
      );
      const painted = await paintedUnits(opened.page);
      assert.ok(painted.length >= 10, `painted ${painted.length} units on the strip`);
      assert.ok(painted.every((unit) => !HANGUL.test(unit.text)));
    });
    assert.equal(mirror.requests().length, before);
    assert.equal(harness.api.requests().length, 0);
    await opened.page.close();
  },
);
