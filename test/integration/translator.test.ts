// The translator end to end against tools/mock-openai on an EPHEMERAL port in oracle mode: real composites
// (src/engine/composite.ts on tools/gfx-node.ts) of the synthetic ko-p01 page carry x-ctv-test-units, the mock answers
// from test/fixtures/generated/ko-p01.gt.json. The transport refuses any URL but the mock's, so no real AI endpoint
// can ever be reached from here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Transport } from "../../src/engine/api-client.ts";
import { createComposite } from "../../src/engine/composite.ts";
import type {
  ApiHealth,
  Clock,
  DecodedImage,
  PackReport,
  PackUnit,
  SettingsSource,
  TranslatePack,
  UnitResult,
} from "../../src/engine/contracts.ts";
import { createTranslator } from "../../src/engine/translator.ts";
import { silentLogger } from "../../src/platform/log.ts";
import type { HealthReading } from "../../src/shared/core/health.ts";
import {
  EMPTY_RETRY_DELAY_MS,
  HTTP_BACKOFF_MS,
  RATE_LIMIT_CONCURRENCY,
  TIMEOUT_CONCURRENCY,
  TIMEOUT_RETRY_DELAY_MS,
  UNAUTHORIZED_PROBE_MS,
} from "../../src/shared/core/retry-policy.ts";
import type { ErrorInfo } from "../../src/shared/errors.ts";
import { unitKeyOf } from "../../src/shared/ids.ts";
import { migrateSettings, type Settings } from "../../src/shared/settings.ts";
import type { Box } from "../../src/shared/types.ts";
import { createMockServer, type MockServer, type RecordedRequest } from "../../tools/mock-openai/server.ts";
import { nodeGfx } from "../../tools/gfx-node.ts";

const GT_DIR = fileURLToPath(new URL("../fixtures/generated/", import.meta.url));
const MODEL = "mock-vision";
const API_KEY = "sk-mock-translator";

// ---- Fakes: manual clock (backoff timers) and ApiHealth ----

class ManualClock implements Clock {
  t = 1_000_000;
  private readonly timers: Array<{ at: number; ms: number; fn: () => void; live: boolean }> = [];

  readonly now = (): number => this.t;

  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  pending(): number[] {
    return this.timers.filter((timer) => timer.live).map((timer) => timer.ms);
  }

  /** Fires every timer due within `ms` (the I/O they start runs in real time). */
  advance(ms: number): void {
    this.t += ms;
    for (const timer of this.timers.filter((tm) => tm.live && tm.at <= this.t).sort((a, b) => a.at - b.at)) {
      timer.live = false;
      timer.fn();
    }
  }
}

class FakeHealth implements ApiHealth {
  ready = true;
  reports: ErrorInfo[] = [];
  private waiters: Array<() => void> = [];

  reading(): HealthReading {
    return { readiness: this.ready ? "ready" : "unauthorized", model: MODEL, cause: null };
  }
  sendable(): boolean {
    return this.ready;
  }
  whenSendable(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  report(error: ErrorInfo): void {
    this.reports.push(error);
    this.ready = false;
  }
  checkedAt(): number {
    return 0;
  }
  resume(): void {
    this.ready = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
  setBusy(): void {}
  refresh(): Promise<HealthReading> {
    return Promise.resolve(this.reading());
  }
  onChange(): () => void {
    return () => undefined;
  }
  stop(): void {}
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ---- The ko-p01 pack ----

interface GtFile {
  width: number;
  height: number;
  units: Array<{
    id: number;
    kind: "bubble" | "free";
    type: string;
    bubble: Box | null;
    text: Box;
    texts: Box[];
    orientation: "h" | "v";
    glyphPx: number;
    /** Reference translation. */
    vi: string | null;
  }>;
}

const GT = JSON.parse(readFileSync(`${GT_DIR}ko-p01.gt.json`, "utf8")) as GtFile;
const SIZE = { w: GT.width, h: GT.height };
const UNITS: PackUnit[] = GT.units.map((u, order) => {
  const unitKey = unitKeyOf(u.bubble ?? u.text);
  return {
    contentKey: "s:ko-p01",
    unitKey,
    geometry: {
      unitKey,
      kind: u.kind,
      bubble: u.bubble,
      text: u.text,
      texts: u.texts,
      orientation: u.orientation,
      glyphPx: u.glyphPx,
      order,
    },
    imageSize: SIZE,
    script: "hangul",
    src: "ko-p01.png",
  };
});
const ALL_OK = UNITS.map((_, i) => (GT.units[i]?.type === "ignore" ? "ignored" : "ok"));

function settingsSource(settings: Settings): SettingsSource {
  return {
    current: () => settings,
    site: () => {
      throw new Error("not used");
    },
    sites: () => ({}),
    apply: () => undefined,
    onChange: () => () => undefined,
  };
}

interface Run {
  report: Promise<PackReport>;
  results: UnitResult[];
  /** Chat requests the mock had received when each unit was delivered. */
  seenAt: Map<string, number>;
  clock: ManualClock;
  health: FakeHealth;
  uploads: number[];
  caps: Array<{ value: number; forMs: number }>;
}

describe("translator against the mock OpenAI-compatible server (oracle mode)", () => {
  let mock: MockServer;
  let images: ReadonlyMap<string, DecodedImage>;

  const chats = (): RecordedRequest[] => mock.requests().filter((r) => r.path === "/v1/chat/completions");

  function start(): Run {
    const settings = migrateSettings(undefined);
    settings.api = {
      ...settings.api,
      baseUrl: mock.baseUrl,
      model: MODEL,
      apiKey: API_KEY,
      temperature: 0.2,
    };
    const clock = new ManualClock();
    const health = new FakeHealth();
    const deps = { clock, log: silentLogger, settings: settingsSource(settings) };
    const guarded: Transport = (url, init) => {
      assert.ok(url.startsWith(`${mock.url}/`), `refusing to call ${url}`);
      return fetch(url, init);
    };
    const uploads: number[] = [];
    const caps: Array<{ value: number; forMs: number }> = [];
    const translator = createTranslator({
      ...deps,
      health,
      composite: createComposite({ ...deps, gfx: nodeGfx }),
      uploads: { record: (bytes) => uploads.push(bytes), today: () => ({ today: 0, bytesToday: 0 }) },
      transport: guarded,
      random: () => 0.5,
      onConcurrencyCap: (cap) => caps.push(cap),
    });
    const pack: TranslatePack = {
      packId: "ko-p01#1",
      frameKey: "1:0:doc",
      seriesKey: null,
      lang: "ko",
      dir: "ltr",
      units: UNITS,
      urgent: true,
      images,
    };
    const results: UnitResult[] = [];
    const seenAt = new Map<string, number>();
    const report = translator.translate(pack, (result) => {
      assert.ok(!seenAt.has(result.unitKey), `onUnit fired twice for ${result.unitKey}`);
      seenAt.set(result.unitKey, chats().length);
      results.push(result);
    });
    return { report, results, seenAt, clock, health, uploads, caps };
  }

  function statuses(results: readonly UnitResult[]): string[] {
    return UNITS.map((u) => results.find((r) => r.unitKey === u.unitKey)?.status ?? "none");
  }

  /** Unit keys a recorded request asked for (its x-ctv-test-units boxes). */
  function askedKeys(record: RecordedRequest | undefined): string[] {
    return (record?.testUnits ?? []).map((t) => {
      const unit = UNITS.find((u) => JSON.stringify(u.geometry.text) === JSON.stringify(t.box));
      assert.ok(unit !== undefined, "test unit box matches a pack unit");
      return unit.unitKey;
    });
  }

  before(async () => {
    mock = await createMockServer({ port: 0, gtDir: GT_DIR, model: MODEL, apiKey: API_KEY });
    const bitmap = await nodeGfx.loadImage(readFileSync(`${GT_DIR}ko-p01.png`));
    images = new Map([
      [
        "s:ko-p01",
        {
          contentKey: "s:ko-p01",
          size: SIZE,
          bitmap: bitmap as unknown as ImageBitmap,
          release: () => undefined,
        },
      ],
    ]);
  });

  after(async () => {
    await mock.close();
  });

  beforeEach(() => {
    mock.reset();
  });

  test("all nine units come back in one request, with the ground-truth translations", async () => {
    const run = start();
    const report = await run.report;
    assert.deepEqual(statuses(run.results), ALL_OK);
    assert.equal(report.requests, 1);
    assert.deepEqual(report.missing, []);
    assert.equal(report.lang, "ko");
    assert.equal(report.model, MODEL);
    assert.equal(
      run.results.find((r) => r.unitKey === UNITS[0]?.unitKey)?.translation,
      `VI:${GT.units[0]?.vi ?? ""}`,
    );

    const [record] = chats();
    assert.ok(record !== undefined);
    assert.equal(chats().length, 1);
    assert.equal(record.outcome, "done");
    assert.equal(record.n, 9);
    assert.equal(record.imageCount, 1);
    assert.equal(record.images[0]?.sniff, "jpeg");
    assert.equal(record.authorized, true, "the configured API key is sent as a Bearer token");
    assert.equal(record.model, MODEL);
    assert.equal(record.temperature, 0.2);
    assert.equal(record.stream, true);
    assert.equal(record.oracle?.matched.length, 9);
    assert.deepEqual(run.uploads, [record.imageBytes]);
    assert.equal(report.uploadedBytes, record.imageBytes);
  });

  test("missing ids: only those are re-asked, crops-only and renumbered, then resolved", async () => {
    mock.setScenario({ sequence: [{ missingIds: [3, 7] }] });
    const run = start();
    const report = await run.report;
    assert.deepEqual(statuses(run.results), ALL_OK);
    assert.equal(report.requests, 2);
    const reask = chats()[1];
    assert.equal(reask?.n, 2);
    assert.deepEqual(
      reask?.testUnits?.map((t) => t.n),
      [1, 2],
    );
    assert.deepEqual(askedKeys(reask), [UNITS[2]?.unitKey, UNITS[6]?.unitKey]);
  });

  test("a truncated stream (silent EOF): delivered lines stay, only the rest is asked again", async () => {
    mock.setScenario({ sequence: [{ dropAfterChunks: 24 }] });
    const run = start();
    const report = await run.report;
    assert.equal(chats()[0]?.outcome, "truncated");
    assert.deepEqual(statuses(run.results), ALL_OK);
    assert.ok(report.requests >= 2 && report.requests <= 5, `requests ${report.requests}`);
    const firstPass = UNITS.filter((u) => run.seenAt.get(u.unitKey) === 1).map((u) => u.unitKey);
    assert.ok(firstPass.length >= 2, "lines before the cut were delivered");
    const askedLater = chats()
      .slice(1)
      .flatMap((record) => askedKeys(record));
    assert.deepEqual(
      askedLater.filter((key) => firstPass.includes(key)),
      [],
    );
  });

  test("401: the pack pauses, probes once after the probe delay, and resumes once the endpoint is sendable", async () => {
    mock.setScenario({ sequence: [{ failBeforeHeaders: "unauthorized" }] });
    const run = start();
    await waitFor(() => run.health.reports.length === 1, "the 401 report");
    assert.equal(run.health.reports[0]?.code, "api.unauthorized");
    await waitFor(() => run.clock.pending().includes(UNAUTHORIZED_PROBE_MS), "the probe timer");
    run.clock.advance(UNAUTHORIZED_PROBE_MS);
    await sleep(30);
    assert.equal(chats().length, 1, "nothing is sent while the endpoint is not sendable");
    run.health.resume();
    const report = await run.report;
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(run.results), ALL_OK);
    assert.equal(report.error, null);
  });

  test("a dropped connection pauses the pack until the endpoint is sendable again", async () => {
    mock.setScenario({ sequence: [{ resetAfterChunks: 0 }] });
    const run = start();
    await waitFor(() => run.health.reports.length === 1, "the unreachable report");
    assert.equal(run.health.reports[0]?.code, "api.unreachable");
    assert.equal(chats()[0]?.outcome, "reset");
    await sleep(30);
    assert.equal(chats().length, 1, "nothing is sent while paused");
    run.health.resume();
    const report = await run.report;
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(run.results), ALL_OK);
  });

  test("429: backs off on the clock, caps queue concurrency, then succeeds", async () => {
    const backoff = HTTP_BACKOFF_MS[0] ?? 0;
    mock.setScenario({ sequence: [{ failBeforeHeaders: "rate_limit" }] });
    const run = start();
    await waitFor(() => run.clock.pending().includes(backoff), "the first backoff step");
    assert.equal(chats().length, 1);
    assert.deepEqual(run.caps, [{ ...RATE_LIMIT_CONCURRENCY }]);
    run.clock.advance(backoff - 1);
    await sleep(20);
    assert.equal(chats().length, 1, "not before the backoff ends");
    run.clock.advance(1);
    const report = await run.report;
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(run.results), ALL_OK);
  });

  test("an in-stream error frame before any line: retried after the backoff", async () => {
    const backoff = HTTP_BACKOFF_MS[0] ?? 0;
    mock.setScenario({ sequence: [{ errorFrame: "server_error", dropAfterChunks: 0 }] });
    const run = start();
    await waitFor(() => run.clock.pending().includes(backoff), "the first backoff step");
    assert.equal(chats()[0]?.outcome, "stream-error");
    run.clock.advance(backoff);
    const report = await run.report;
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(run.results), ALL_OK);
  });

  test("504 gateway timeout: retried alone after the timeout delay, with a temporary concurrency cap", async () => {
    mock.setScenario({ sequence: [{ failBeforeHeaders: "timeout" }] });
    const run = start();
    await waitFor(() => run.clock.pending().includes(TIMEOUT_RETRY_DELAY_MS), "the timeout retry delay");
    assert.deepEqual(run.caps, [{ ...TIMEOUT_CONCURRENCY }]);
    run.clock.advance(TIMEOUT_RETRY_DELAY_MS);
    const report = await run.report;
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(run.results), ALL_OK);
  });

  test("an empty answer: one full retry after the empty-answer delay, counted in the ladder", async () => {
    mock.setScenario({ sequence: [{ empty: true }] });
    const run = start();
    await waitFor(() => run.clock.pending().includes(EMPTY_RETRY_DELAY_MS), "the empty-answer delay");
    run.clock.advance(EMPTY_RETRY_DELAY_MS);
    const report = await run.report;
    assert.equal(report.requests, 2);
    assert.equal(chats()[1]?.n, 9);
    assert.deepEqual(statuses(run.results), ALL_OK);
  });

  test("≤ 5 requests per pack per pass: split, re-ask and a second split level resolve persistent gaps", async () => {
    mock.setScenario({ missingIds: [2, 4, 6, 8] });
    const run = start();
    const report = await run.report;
    assert.equal(report.requests, 5);
    assert.equal(chats().length, 5);
    assert.deepEqual(statuses(run.results), ALL_OK);
    const key = (i: number): string => UNITS[i - 1]?.unitKey ?? "";
    assert.deepEqual(
      chats().map((record) => askedKeys(record)),
      [UNITS.map((u) => u.unitKey), [key(2), key(4)], [key(6), key(8)], [key(4)], [key(8)]],
    );
  });

  test("≤ 5 requests even when nothing ever validates; the units stay untranslated", async () => {
    mock.setScenario({ missingIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    const run = start();
    const report = await run.report;
    assert.ok(report.requests <= 5, `requests ${report.requests}`);
    assert.equal(chats().length, report.requests);
    assert.deepEqual(statuses(run.results), Array(9).fill("untranslated"));
    assert.equal(report.missing.length, 9);
  });
});
