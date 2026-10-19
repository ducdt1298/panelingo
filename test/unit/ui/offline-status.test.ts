// Offline mode in the status: the engine's snapshot carries the offline engine (and never a /models pause), and the
// popup's offline block shows its state, the download in MB, the loaded models and failures.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { assembleStatus } from "../../../src/engine/handlers-ui.ts";
import { idleOffline, offlineUnavailable } from "../../../src/engine/runtime.ts";
import { catalogFor, msg, setLocale } from "../../../src/shared/i18n/index.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import type { OfflineStatus } from "../../../src/shared/types.ts";
import { offlineBlock } from "../../../src/ui/common/status-view.ts";
import { fakeDetector, fakeHealth, fakeUploads, recordingPipeline } from "../engine/store/engine-fakes.ts";

afterEach(() => {
  setLocale("en");
});

const READY: OfflineStatus = {
  state: "ready",
  model: "opus-mt",
  active: ["ocr-korean", "opus-mt-ko-en"],
  download: null,
  error: null,
};

test("assembleStatus: offline mode adds the engine and its state, and an unreachable API pauses nothing", () => {
  const sources = {
    phase: () => "ready" as const,
    health: fakeHealth("unreachable"),
    checkedAt: () => 0,
    detector: fakeDetector(),
    pipeline: recordingPipeline(),
    uploads: fakeUploads(0, 0),
  };
  const api = assembleStatus(sources);
  assert.equal(api.engine, undefined, "API mode: the snapshot is unchanged");
  assert.equal(api.offline, undefined);
  assert.equal(api.queue.pausedBy, "api.unreachable");
  const offline = assembleStatus({ ...sources, engine: () => "offline", offline: () => READY });
  assert.equal(offline.engine, "offline");
  assert.deepEqual(offline.offline, READY);
  assert.equal(offline.queue.pausedBy, null);
  assert.deepEqual(idleOffline(DEFAULT_SETTINGS), {
    state: "idle",
    model: "opus-mt",
    active: [],
    download: null,
    error: null,
  });
});

test("offlineBlock: idle before the engine runs, download progress in MB, models, failures with their hint", () => {
  const idle = offlineBlock(null);
  assert.deepEqual([idle.tone, idle.title], ["idle", msg().offlineState.idle]);
  assert.equal(idle.hint, msg().popup.offlineHint);

  const downloading = offlineBlock({
    ...READY,
    state: "downloading",
    active: [],
    download: { done: 12_400_000, total: 115_200_000 },
  });
  assert.equal(downloading.tone, "pending");
  assert.deepEqual(downloading.lines, ["Downloading 12 of 115 MB"]);

  const ready = offlineBlock(READY);
  assert.deepEqual([ready.tone, ready.lines], ["ok", ["Models: ocr-korean, opus-mt-ko-en"]]);

  const failed = offlineBlock({ ...READY, state: "failed", error: "offline.pair_unsupported" });
  assert.equal(failed.tone, "error");
  assert.equal(failed.title, msg().errors["offline.pair_unsupported"].title);
  assert.equal(failed.hint, msg().errors["offline.pair_unsupported"].hint);
});

test("offlineBlock follows the UI language", () => {
  setLocale("vi");
  assert.equal(offlineBlock(READY).title, catalogFor("vi").offlineState.ready);
});

test("an engine without an offline translator fails offline packs with offline.run, one error per unit", async () => {
  const results: string[] = [];
  const report = await offlineUnavailable(
    {
      packId: "pk-1",
      frameKey: "1:0:d",
      seriesKey: null,
      lang: "ko",
      dir: "ltr",
      urgent: false,
      images: new Map(),
      units: ["a", "b"].map((unitKey) => ({
        contentKey: "s:x",
        unitKey,
        geometry: {
          unitKey,
          kind: "bubble" as const,
          bubble: null,
          text: { x1: 0, y1: 0, x2: 10, y2: 10 },
          texts: [],
          orientation: "h" as const,
          glyphPx: 10,
          order: 0,
        },
        imageSize: { w: 100, h: 100 },
        script: "hangul" as const,
        src: "x.png",
      })),
    },
    (result) => results.push(`${result.unitKey}:${result.status}`),
  );
  assert.deepEqual(results, ["a:error", "b:error"]);
  assert.equal(report.error?.code, "offline.run");
  assert.deepEqual(report.missing, ["a", "b"]);
});
