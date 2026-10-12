// Engine boot (A.5 L1) end to end on the chrome fake: the gate is installed synchronously when the offscreen document
// is created (what main.ts does), startRuntime() wires fake services, then frames, UI pages and the SW talk to it.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { CoreDeps, Pipeline, ServiceFactories } from "../../../src/engine/contracts.ts";
import type { ReadyGate } from "../../../src/engine/ready-gate.ts";
import {
  CLOSE_REVERT_MS,
  createEngineLogging,
  RETENTION_FIRST_CHECK_MS,
  RETENTION_RETRY_MS,
  startRuntime,
  type EngineRuntime,
  type RuntimeEnv,
} from "../../../src/engine/runtime.ts";
import { openStores } from "../../../src/engine/store/db.ts";
import { DAY_MS } from "../../../src/engine/store/retention.ts";
import { callEngine } from "../../../src/platform/messaging.ts";
import { minutesToMs } from "../../../src/platform/time.ts";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import type { EngineStatus, LogEntry } from "../../../src/shared/types.ts";
import { makeProbe } from "../../../src/shared/wire.ts";
import { CHROME_ERRORS, type FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";
import {
  captureLogger,
  connectContent,
  connectUi,
  createOffscreen,
  csHello,
  fakeFactories,
  flushTurns,
  imageSubmit,
  installGate,
  ManualClock,
  percentile,
  startBrowser,
  type FakeServices,
  type SwStub,
} from "./store/engine-fakes.ts";

const browsers: FakeBrowser[] = [];
const runtimes: EngineRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const browser of browsers.splice(0)) browser.uninstall();
});

interface Booted {
  browser: FakeBrowser;
  sw: FakeContext;
  engine: FakeContext;
  stub: SwStub;
  gate: ReadyGate;
  clock: ManualClock;
  services: FakeServices;
  runtime: EngineRuntime | null;
  /** performance.now() when createDocument resolved. */
  createdAt: number;
  entries: LogEntry[];
}

interface BootOptions {
  factories?: (base: ServiceFactories, services: FakeServices) => ServiceFactories;
  stub?: Partial<SwStub>;
  env?: Partial<RuntimeEnv>;
  /** Called right after createDocument resolves, before the runtime is awaited. */
  beforeReady?: (browser: FakeBrowser) => void;
}

/** createDocument with the gate installed synchronously by the onOffscreenCreated hook, like main.ts. */
async function boot(options: BootOptions = {}): Promise<Booted> {
  const clock = new ManualClock();
  const { log, entries } = captureLogger();
  const { factories: base, services } = fakeFactories();
  const factories = options.factories?.(base, services) ?? base;
  const holder: { gate: ReadyGate | null; runtime: Promise<EngineRuntime | null> | null } = {
    gate: null,
    runtime: null,
  };
  const { browser, sw, stub } = await startBrowser(
    {
      onOffscreenCreated: (ctx) => {
        holder.gate = installGate(ctx, log);
        holder.runtime = startRuntime(holder.gate, factories, { clock, log, ...options.env });
      },
    },
    options.stub,
  );
  browsers.push(browser);
  await createOffscreen(sw);
  const createdAt = performance.now();
  options.beforeReady?.(browser);
  assert.ok(holder.gate !== null && holder.runtime !== null);
  const runtime = await holder.runtime;
  if (runtime !== null) runtimes.push(runtime);
  const engine = browser.offscreen;
  assert.ok(engine !== null);
  return { browser, sw, engine, stub, gate: holder.gate, clock, services, runtime, createdAt, entries };
}

function statusOf(message: Record<string, unknown> | undefined): EngineStatus {
  assert.ok(message !== undefined);
  return message.status as EngineStatus;
}

test("P1-04: 50 content scripts connect right after createDocument: no lost connection, every frame gets en:hello", async () => {
  const probes: Array<ReturnType<typeof connectContent>> = [];
  const held = heldOpen();
  let hellosBeforeReady = 0;
  const booted = await boot({
    // Keep the runtime booting until every frame has connected and posted: the gate must carry all of it.
    factories: (base) => ({
      ...base,
      openStores: (deps: CoreDeps) => held.open.then(() => base.openStores(deps)),
    }),
    beforeReady: (browser) => {
      for (let i = 0; i < 50; i += 1) {
        const probe = connectContent(browser, `https://reader.example/ch/${i}`);
        probe.post(csHello());
        for (let k = 0; k < 20; k += 1) probe.post(imageSubmit(k));
        probes.push(probe);
      }
      void browser.settle().then(() => {
        hellosBeforeReady = probes.filter((probe) => probe.of("en:hello").length > 0).length;
        held.release();
      });
    },
  });
  const { browser, services, runtime } = booted;
  assert.ok(runtime !== null);
  await browser.settle();
  assert.equal(runtime.phase(), "ready");
  assert.equal(hellosBeforeReady, 50, "every hello was answered by the gate while booting");
  for (const probe of probes) {
    assert.deepEqual(probe.disconnects, [], "no Receiving end does not exist");
    assert.equal(probe.of("en:hello").length, 1);
    assert.equal(statusOf(probe.of("en:hello")[0]).phase, "booting");
    assert.equal(statusOf(probe.of("en:status")[0]).phase, "ready", "then the real status after drain");
  }
  assert.ok(!probes.some((probe) => probe.disconnects.includes(CHROME_ERRORS.noReceiver)));
  const submits = services.pipeline.calls.filter((call) => call.kind === "submit");
  assert.equal(submits.length, 50 * 20, "every buffered submit reached the pipeline");
  for (const probe of probes) {
    const frameKey = `${probe.tabId}:0:${probe.ctx.documentId}`;
    const keys = submits.flatMap((call) => (call.frameKey === frameKey ? [call.submit.imageKey] : []));
    assert.deepEqual(
      keys,
      Array.from({ length: 20 }, (_, k) => `${k}.0`),
      "arrival order per frame",
    );
  }
  assert.equal(runtime.frames.connectedCount(), 50);
});

test("P1-04 timing over 20 cold starts: en:hello p95 ≤ 50 ms, phase ready p95 ≤ 500 ms", async () => {
  const hello: number[] = [];
  const ready: number[] = [];
  for (let run = 0; run < 20; run += 1) {
    let created = 0;
    const booted = await boot({
      beforeReady: (browser) => {
        created = performance.now();
        for (let i = 0; i < 3; i += 1) {
          const probe = connectContent(browser, `https://reader.example/${run}/${i}`);
          probe.port.onMessage.addListener((message) => {
            if ((message as { type?: unknown }).type === "en:hello") hello.push(performance.now() - created);
          });
          probe.post(csHello());
        }
      },
    });
    ready.push(performance.now() - created);
    await booted.browser.settle();
    for (const runtime of runtimes.splice(0)) await runtime.stop();
    for (const browser of browsers.splice(0)) browser.uninstall();
  }
  assert.equal(hello.length, 60);
  assert.ok(percentile(hello, 95) <= 50, `en:hello p95 ${percentile(hello, 95).toFixed(1)} ms`);
  assert.ok(percentile(ready, 95) <= 500, `ready p95 ${percentile(ready, 95).toFixed(1)} ms`);
});

test("boot order: stores, settings from the SW (mirrored), sw:ping codec, services in dependency order, first /models", async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.api.concurrency = 1;
  const { runtime, services, stub } = await boot({
    stub: { settings, sites: { "https://reader.example": { enabled: true } as never } },
  });
  assert.ok(runtime !== null);
  assert.deepEqual(services.order, [
    "openStores",
    "createGfx",
    "createHealth",
    "createAcquirer",
    "createDecoder",
    "createDetector",
    "createComposite",
    "createUploads",
    "createTranslator",
    "createPipeline",
  ]);
  assert.equal(runtime.settings.current().api.concurrency, 1);
  assert.equal(runtime.settings.site("https://reader.example").enabled, true);
  assert.equal((await runtime.stores.kv.get("settings.mirror"))?.settings.api.concurrency, 1);
  assert.equal(stub.pings, 1);
  assert.equal(runtime.swCodec, "sc");
  assert.equal(services.health.refreshes, 1, "first /models check at boot");
  assert.equal(runtime.status().phase, "ready");
  assert.equal(runtime.status().uploads.today, 2);
});

test("without an answer from the SW the engine starts from the kv mirror", async () => {
  const mirrored = structuredClone(DEFAULT_SETTINGS);
  mirrored.engine.idleCloseMin = 42;
  const { runtime, entries } = await boot({
    stub: { answerSettings: false },
    factories: (base, services) => ({
      ...base,
      openStores: async (deps: CoreDeps) => {
        const stores = await base.openStores(deps);
        await stores.kv.set("settings.mirror", { settings: mirrored, sites: {}, at: 1 });
        services.order.push("mirror-seeded");
        return stores;
      },
    }),
  });
  assert.ok(runtime !== null);
  assert.equal(runtime.settings.current().engine.idleCloseMin, 42);
  assert.ok(entries.some((entry) => entry.msg === "sw:get-settings failed"));
  assert.ok(entries.some((entry) => entry.msg === "using the settings mirror"));
});

/** openStores held until the test releases it (fake boots are otherwise faster than a content hello). */
function heldOpen(): { open: Promise<void>; release: () => void; fail: (error: Error) => void } {
  let release: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const open = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { open, release, fail };
}

test("a boot failure fails the gate: ping says failed, frames are told, startRuntime resolves null", async () => {
  const content: Array<ReturnType<typeof connectContent>> = [];
  const held = heldOpen();
  const { browser, sw, runtime } = await boot({
    factories: (base) => ({
      ...base,
      openStores: (deps: CoreDeps) => held.open.then(() => base.openStores(deps)),
    }),
    beforeReady: (b) => {
      const probe = connectContent(b, "https://reader.example/1");
      probe.post(csHello());
      probe.post(imageSubmit(1));
      content.push(probe);
      void b.settle().then(() => held.fail(new Error("IndexedDB blocked")));
    },
  });
  assert.equal(runtime, null);
  await browser.settle();
  assert.equal((await sw.run(() => callEngine("en:ping", { probe: makeProbe() }))).phase, "failed");
  const probe = content[0];
  assert.ok(probe !== undefined);
  assert.equal(statusOf(probe.of("en:hello")[0]).phase, "booting");
  assert.equal(statusOf(probe.of("en:status")[0]).phase, "failed");
  assert.equal((probe.of("img:state")[0]?.error as { code: string }).code, "engine.internal");
});

test("frames answered while booting get the real status after drain; health changes are pushed (throttled)", async () => {
  const early: Array<ReturnType<typeof connectContent>> = [];
  const held = heldOpen();
  const { browser, runtime, services, clock } = await boot({
    factories: (base) => ({
      ...base,
      openStores: (deps: CoreDeps) => held.open.then(() => base.openStores(deps)),
    }),
    beforeReady: (b) => {
      const probe = connectContent(b, "https://reader.example/1");
      probe.post(csHello());
      early.push(probe);
      void b.settle().then(held.release);
    },
  });
  assert.ok(runtime !== null);
  await browser.settle();
  const probe = early[0];
  assert.ok(probe !== undefined);
  assert.equal(statusOf(probe.of("en:hello")[0]).phase, "booting");
  assert.equal(statusOf(probe.of("en:status")[0]).phase, "ready");

  const late = connectContent(browser, "https://reader.example/2");
  late.post(csHello("manual"));
  const ui = connectUi(browser);
  ui.post({ type: "ui:hello", v: PROTOCOL_VERSION, probe: makeProbe(), view: "popup" });
  ui.post({ type: "ui:watch", tabId: null });
  await browser.settle();
  assert.equal(statusOf(late.of("en:hello")[0]).phase, "ready", "after drain the runtime answers hello");
  assert.equal(runtime.frames.get(`${late.tabId}:0:${late.ctx.documentId}`)?.info.mode, "manual");
  assert.equal(ui.of("en:hello").length, 1);
  assert.equal(ui.of("en:status").length, 1, "ui:watch sends the status at once");

  services.health.set("unreachable");
  services.health.set("unauthorized");
  await clock.advance(250);
  await browser.settle();
  const pushed = late.of("en:status").map((message) => statusOf(message).api.readiness);
  assert.equal(pushed.at(-1), "unauthorized");
  assert.equal(statusOf(late.of("en:status").at(-1)).queue.pausedBy, "api.unauthorized");
  assert.equal(statusOf(ui.of("en:status").at(-1)).api.readiness, "unauthorized");
  const before = late.of("en:status").length;
  await clock.advance(2_000);
  await browser.settle();
  assert.equal(late.of("en:status").length, before, "no push without a change");

  const popup = browser.openExtensionPage("popup", "ui/popup.html");
  const status = await popup.run(() => callEngine("en:status", {}));
  assert.equal(status.api.readiness, "unauthorized");
  assert.equal(status.api.model, DEFAULT_SETTINGS.api.model);
  assert.equal(status.queue.boxBudget, 20);
});

test("en:prepare-close: refused while ports are open; then closing (new ports get en:closing), back to ready after 5 s", async () => {
  const { browser, sw, runtime, clock, services } = await boot();
  assert.ok(runtime !== null);
  const frame = connectContent(browser, "https://reader.example/1");
  frame.post(csHello());
  await browser.settle();
  assert.deepEqual(await sw.run(() => callEngine("en:prepare-close", {})), { ok: false });

  frame.ctx.run(() => frame.port.disconnect());
  await browser.settle();
  services.pipeline.idleValue = false;
  assert.deepEqual(await sw.run(() => callEngine("en:prepare-close", {})), { ok: false }, "work in flight");
  services.pipeline.idleValue = true;
  assert.deepEqual(await sw.run(() => callEngine("en:prepare-close", {})), { ok: true });
  assert.equal(runtime.phase(), "closing");
  assert.deepEqual(await sw.run(() => callEngine("en:prepare-close", {})), { ok: true });

  const refused = connectContent(browser, "https://reader.example/2");
  refused.post(csHello());
  await browser.settle();
  assert.equal(refused.of("en:closing").length, 1);
  assert.equal(refused.of("en:hello").length, 0);
  assert.deepEqual(refused.disconnects, [null], "disconnected by the engine");

  await clock.advance(CLOSE_REVERT_MS);
  assert.equal(runtime.phase(), "ready");
  const again = connectContent(browser, "https://reader.example/3");
  again.post(csHello());
  await browser.settle();
  assert.equal(statusOf(again.of("en:hello")[0]).phase, "ready");
});

test("without ports or work the engine reports sw:engine-idle after idleCloseMin", async () => {
  const { runtime, clock, stub, engine } = await boot();
  assert.ok(runtime !== null);
  const start = clock.now();
  // Timers fire inside the engine's context, as they do in the single-context offscreen document.
  await engine.run(() => clock.advance(minutesToMs(DEFAULT_SETTINGS.engine.idleCloseMin) - 1));
  assert.deepEqual(stub.idleCalls, []);
  await engine.run(() => clock.advance(1));
  await flushTurns(20);
  assert.deepEqual(stub.idleCalls, [start]);
});

test("the pipeline's detector reports activity, so an idle detector session is released", async () => {
  const captured: { pipeline: Parameters<ServiceFactories["createPipeline"]>[0] | null } = { pipeline: null };
  const { runtime, clock, services } = await boot({
    factories: (base) => ({
      ...base,
      createPipeline: (deps): Pipeline => {
        captured.pipeline = deps;
        return base.createPipeline(deps);
      },
    }),
  });
  assert.ok(runtime !== null && captured.pipeline !== null);
  services.detector.current = { backend: "webgpu", state: "ready", canary: "pass" };
  await assert.rejects(captured.pipeline.detector.detect({} as never, {} as never));
  await clock.advance(minutesToMs(DEFAULT_SETTINGS.engine.detectorReleaseMin));
  assert.equal(services.detector.releases, 1);
  assert.equal(captured.pipeline.ui, runtime.ui, "the pipeline broadcasts to the UI registry");
});

test("retention runs once a day, only while idle, with real stores", async () => {
  globalThis.indexedDB = new IDBFactory();
  const { runtime, clock, services } = await boot({
    factories: (base) => ({ ...base, openStores: (deps: CoreDeps) => openStores(deps) }),
  });
  assert.ok(runtime !== null);
  const stores = runtime.stores;
  await stores.db.put("translations", {
    contentKey: "s:old",
    unitKey: "u",
    seriesKey: null,
    type: "dialogue",
    speaker: "",
    original: "a",
    translation: "b",
    manualTranslation: null,
    manual: 0,
    status: "ok",
    lang: "ko",
    model: "m",
    promptVersion: 1,
    attempts: 1,
    updatedAt: 0,
    lastUsedAt: clock.now() - 40 * DAY_MS,
  });
  services.pipeline.idleValue = false;
  await clock.advance(RETENTION_FIRST_CHECK_MS, 40);
  assert.equal(await stores.kv.get("retention.lastRunAt"), undefined, "busy: postponed");
  services.pipeline.idleValue = true;
  await clock.advance(RETENTION_RETRY_MS, 40);
  for (let i = 0; i < 50 && (await stores.kv.get("retention.lastRunAt")) === undefined; i += 1)
    await flushTurns();
  const ranAt = await stores.kv.get("retention.lastRunAt");
  assert.ok(ranAt !== undefined);
  assert.equal(await stores.db.count("translations"), 0);
  await clock.advance(RETENTION_RETRY_MS * 3, 40);
  assert.equal(await stores.kv.get("retention.lastRunAt"), ranAt, "at most once per 24 h");
});

test("stop() cancels every timer and closes ports and stores", async () => {
  const { browser, runtime, clock, services } = await boot();
  assert.ok(runtime !== null);
  const frame = connectContent(browser, "https://reader.example/1");
  frame.post(csHello());
  await browser.settle();
  await runtime.stop();
  runtimes.splice(runtimes.indexOf(runtime), 1);
  await browser.settle();
  assert.equal(clock.pending(), 0);
  assert.equal(services.health.stopped, true);
  assert.deepEqual(frame.disconnects, [null]);
  assert.equal((runtime.stores as { closed?: boolean }).closed, true);
});

test("the default engine logger filters by settings.debug.logLevel and fills the ring buffer once attached", () => {
  const clock = new ManualClock();
  let level: "debug" | "info" | "warn" | "error" = "info";
  const extra: LogEntry[] = [];
  const logging = createEngineLogging({
    clock,
    level: () => level,
    sinks: [(e) => extra.push(e)],
    console: false,
  });
  logging.logger.debug("hidden");
  logging.logger.info("early");
  const appended: LogEntry[] = [];
  logging.attach({
    append: (e) => appended.push(e),
    flush: () => Promise.resolve(),
    recent: () => Promise.resolve([]),
  });
  level = "debug";
  logging.logger.debug("now visible");
  assert.deepEqual(
    appended.map((e) => e.msg),
    ["early", "now visible"],
  );
  assert.equal(extra.length, 3, "extra sinks see everything");
});
