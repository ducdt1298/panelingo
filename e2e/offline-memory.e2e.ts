// Offline mode memory (docs/OFFLINE-MODE.md, "Memory"): several pages in a row with language-pair, target and model
// switches must never restart the engine document, and the engine's own ORT heap (detector and recognizers) must stay
// small, because the translation models live in their own worker heap, which is restarted when NLLB-200 and Opus-MT
// would meet. Before this, NLLB-200 next to the detector, the recognizers and a pivot pair grew the one shared heap to
// 3.8–4.0 GB of its 4.29 GB maximum. Model-gated like offline.e2e.ts; the NLLB-200 test needs that model cached too.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Target } from "puppeteer-core";
import {
  chats,
  enableSite,
  engineLogs,
  openExtensionPage,
  openPage,
  sendFromPage,
  waitImagesSettled,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, type Harness } from "./helpers/launch.ts";
import { missingFiles, startOfflineMirror, type OfflineMirror } from "./helpers/offline-models.ts";

const NEEDED = ["ocr-korean", "ocr-cjk", "opus-mt-ko-en", "opus-mt-en-vi", "opus-mt-ja-en"];
const NLLB = "nllb-200-distilled-600m";
const missing = missingFiles(NEEDED);
const skip =
  missing.length === 0
    ? false
    : `offline models are not in .cache/offline-models (npm run fetch-models -- --offline=${NEEDED.join(",")})`;
const skipNllb =
  skip !== false
    ? skip
    : missingFiles([NLLB]).length === 0
      ? false
      : `NLLB-200 is not in .cache/offline-models (npm run fetch-models -- --offline=${NLLB})`;

/** The engine's ORT heap (detector + recognizers) may grow to this, never to the translation models' size. */
const ENGINE_HEAP_MAX = 1_500_000_000;
/** wasm32: 65536 pages of 64 KiB. */
const WASM_MAX = 4 * 1024 * 1024 * 1024;

let h: Harness | undefined;
let mirror: OfflineMirror | undefined;
let status: OpenedPage | undefined;
const engineEvents: string[] = [];

interface OfflineState {
  state: string;
  active: string[];
  error: string | null;
  heap?: { engine: number; translation: number };
}

before(async () => {
  if (skip !== false) return;
  mirror = await startOfflineMirror();
  h = await launch({
    settings: {
      translate: { engine: "offline", offlineModel: "opus-mt", targetLang: "vi" },
      debug: { offlineModelBaseUrl: mirror.baseUrl },
      // Every fixture page is on one test site: series memory would carry the first page's language on.
      memory: { enabled: false },
      // Test builds run these 60× faster: keep the engine from closing while idle between pages.
      engine: { idleCloseMin: 60, portIdleMin: 30, detectorReleaseMin: 60 },
    },
  });
  const watch = (kind: string) => (target: Target) => {
    if (target.url().includes("engine/offscreen.html")) engineEvents.push(kind);
  };
  h.browser.on("targetcreated", watch("created"));
  h.browser.on("targetdestroyed", watch("destroyed"));
  await enableSite(h);
  status = await openExtensionPage(h, "options");
});

after(async () => {
  await h?.close();
  await mirror?.close();
});

async function offlineState(): Promise<OfflineState> {
  assert.ok(status !== undefined);
  const reply = await sendFromPage<{ offline?: OfflineState }>(status.page, "engine", "en:status", {});
  assert.ok(reply.ok && reply.data?.offline !== undefined, JSON.stringify(reply));
  return reply.data.offline;
}

/** Translates one fixture page and checks the engine afterwards. */
async function translate(harness: Harness, set: string): Promise<OfflineState> {
  const opened = await openPage(harness, `/paged/?set=${set}`);
  await withDiagnostics(harness, opened, async () => {
    const settled = await waitImagesSettled(opened.page, 1, 300_000);
    assert.deepEqual(Object.values(settled.images), ["done"], `${set}: ${JSON.stringify(settled)}`);
  });
  await opened.page.close();
  const state = await offlineState();
  assert.equal(state.error, null, `${set}: ${JSON.stringify(state)}`);
  assert.ok(state.heap !== undefined);
  assert.ok(
    state.heap.engine > 0 && state.heap.engine < ENGINE_HEAP_MAX,
    `${set}: ${JSON.stringify(state.heap)}`,
  );
  assert.ok(state.heap.translation < WASM_MAX, `${set}: ${JSON.stringify(state.heap)}`);
  assert.equal(
    engineEvents.filter((e) => e === "destroyed").length,
    0,
    `the engine restarted: ${engineEvents.join(", ")}`,
  );
  return state;
}

test(
  "pages in a row with pair and target switches: one engine, models swapped in the worker, small engine heap",
  { skip },
  async () => {
    assert.ok(h !== undefined);
    const harness = h;
    let state = await translate(harness, "ko-p01");
    assert.deepEqual([...state.active].sort(), ["ocr-cjk", "ocr-korean", "opus-mt-en-vi", "opus-mt-ko-en"]);
    state = await translate(harness, "ja-p01");
    assert.ok(
      state.active.includes("opus-mt-ja-en") && !state.active.includes("opus-mt-ko-en"),
      state.active.join(),
    );
    await harness.patchSettings({ translate: { targetLang: "en" } });
    state = await translate(harness, "ko-strip01");
    assert.ok(
      state.active.includes("opus-mt-ko-en") && !state.active.includes("opus-mt-en-vi"),
      state.active.join(),
    );
    const logs = await engineLogs(harness.browser);
    assert.ok(
      logs.some((line) => line.includes("offline translation worker started")),
      logs.join("\n"),
    );
    assert.equal(chats(harness).length, 0);
  },
);

test(
  "NLLB-200 and back to Opus-MT: the translation worker restarts in between, the engine stays",
  { skip: skipNllb },
  async () => {
    assert.ok(h !== undefined);
    const harness = h;
    await harness.patchSettings({ translate: { offlineModel: "nllb-600m", targetLang: "vi" } });
    let state = await translate(harness, "ko-p01");
    assert.ok(
      state.active.includes(NLLB) && !state.active.some((id) => id.startsWith("opus-mt")),
      state.active.join(),
    );
    assert.ok(state.heap !== undefined && state.heap.translation > 2_000_000_000, JSON.stringify(state.heap));
    await harness.patchSettings({ translate: { offlineModel: "opus-mt", targetLang: "en" } });
    state = await translate(harness, "ja-p01");
    assert.ok(!state.active.includes(NLLB), state.active.join());
    assert.ok(state.heap !== undefined && state.heap.translation < 1_500_000_000, JSON.stringify(state.heap));
    const logs = await engineLogs(harness.browser);
    assert.ok(
      logs.some((line) => line.includes("offline translation models unloaded") && line.includes("family")),
      logs.filter((line) => line.includes("offline")).join("\n"),
    );
    assert.equal(chats(harness).length, 0);
  },
);
