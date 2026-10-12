// Engine client state machine (A.5 L5-L7, P1-04b) against the chrome fake: lazy connect, hello + codec,
// resubmission after reconnect, backoff with jitter, force after fast failures, give-up, BFCache, invalidation,
// en:closing, idle disconnect. Time is a manual clock; visibility and page lifecycle are a fake.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { EngineClient, EngineClientState } from "../../../src/content/contracts.ts";
import {
  BACKOFF_CAP_MS,
  CLOSING_RETRY_MS,
  GIVE_UP_MS,
  HELLO_TIMEOUT_MS,
  RESEND_DELAY_MS,
  asUrlSubmit,
  backoffDelay,
  createEngineClient,
  isTerminal,
  negotiateCodec,
  type EngineClientDeps,
  type PageEvent,
  type PageLifecycle,
} from "../../../src/content/engine-client.ts";
import { createLogger } from "../../../src/platform/log.ts";
import { onMessageFor } from "../../../src/platform/messaging.ts";
import { wrapPort, type TypedPort } from "../../../src/platform/port.ts";
import type { Clock } from "../../../src/shared/clock.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import {
  PROTOCOL_VERSION,
  type CsToEngine,
  type CsToEngineMap,
  type EngineToCs,
  type EngineToCsMap,
  type ImageSubmit,
  type ReqOf,
  type SwApi,
} from "../../../src/shared/protocol.ts";
import type { EngineStatus, LogEntry } from "../../../src/shared/types.ts";
import { isProbe, makeProbe } from "../../../src/shared/wire.ts";
import { FakeBrowser, type FakeContext, type FakePort } from "../../support/chrome-fake.ts";

/* ------------------------------------------------------------------ helpers */

class ManualClock implements Clock {
  #now = 0;
  #seq = 0;
  readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimer(fn: () => void, ms: number): () => void {
    this.#seq += 1;
    const id = this.#seq;
    this.timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return () => {
      this.timers.delete(id);
    };
  }

  nextDelay(): number | null {
    let next: number | null = null;
    for (const timer of this.timers.values()) next = next === null ? timer.at : Math.min(next, timer.at);
    return next === null ? null : next - this.#now;
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      this.#now = dueAt;
      timer?.fn();
    }
    this.#now = target;
  }
}

class FakePage implements PageLifecycle {
  shown = true;
  readonly listeners = new Set<(event: PageEvent) => void>();

  visible(): boolean {
    return this.shown;
  }

  subscribe(listener: (event: PageEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  fire(event: PageEvent): void {
    if (event === "visible") this.shown = true;
    if (event === "hidden") this.shown = false;
    for (const listener of [...this.listeners]) listener(event);
  }
}

const STATUS: EngineStatus = {
  phase: "ready",
  build: "engine-test",
  api: { readiness: "ready", model: null, cause: null, checkedAt: 0 },
  detector: { backend: "none", state: "unloaded", canary: "pending" },
  queue: {
    queued: 0,
    inFlight: 0,
    urgentInFlight: 0,
    done: 0,
    failed: 0,
    pausedBy: null,
    concurrency: 2,
    boxBudget: 20,
  },
  uploads: { today: 0, bytesToday: 0 },
};

const quiet = createLogger("engine", { sinks: [] });

interface EngineSide {
  port: TypedPort<CsToEngineMap, EngineToCsMap>;
  raw: FakePort;
  messages: CsToEngine[];
}

/** The offscreen side: answers cs:hello like the ReadyGate and records everything the content script posts. */
class FakeEngine {
  accepting = true;
  helloMode: "answer" | "silent" | "closing-once" = "answer";
  protocol = PROTOCOL_VERSION;
  readonly sides: EngineSide[] = [];

  install(ctx: FakeContext): void {
    if (!this.accepting) return;
    ctx.onConnect.addListener((raw) => this.adopt(raw));
  }

  adopt(raw: FakePort): void {
    const port = wrapPort<CsToEngineMap, EngineToCsMap>(raw as unknown as chrome.runtime.Port, {
      ctx: "engine",
      log: quiet,
    });
    const side: EngineSide = { port, raw, messages: [] };
    this.sides.push(side);
    raw.onMessage.addListener((message) => {
      side.messages.push(message as CsToEngine);
    });
    port.on("cs:hello", (hello) => {
      if (this.helloMode === "silent") return;
      if (this.helloMode === "closing-once") {
        this.helloMode = "answer";
        port.post({ type: "en:closing" });
        port.close();
        return;
      }
      port.post({
        type: "en:hello",
        v: this.protocol,
        build: "engine-test",
        probe: makeProbe(),
        codec: isProbe(hello.probe) ? "sc" : "b64",
        frameKey: "1:0:DOC",
        status: STATUS,
      });
    });
  }

  get last(): EngineSide {
    const side = this.sides.at(-1);
    assert.ok(side !== undefined, "no engine port yet");
    return side;
  }

  send(message: EngineToCs): void {
    this.last.port.post(message);
  }

  submits(side: EngineSide = this.last): string[] {
    return side.messages.flatMap((m) => (m.type === "img:submit" ? [m.imageKey] : []));
  }
}

type EnsurePayload = ReqOf<SwApi, "sw:ensure-engine">;

let browser: FakeBrowser;
let cs: FakeContext;
let clock: ManualClock;
let page: FakePage;
let engine: FakeEngine;
let ensureCalls: Array<{ at: number; force: boolean }>;
let ensureFails: boolean;
let rereads: string[];
let logs: LogEntry[];

/** sw:ensure-engine handlers still running (createDocument waits on a real timer inside the fake). */
let ensuring = 0;

async function ensure(payload: EnsurePayload): Promise<{ created: boolean }> {
  ensureCalls.push({ at: clock.now(), force: payload.force === true });
  if (ensureFails) throw new CtvError("engine.unavailable", "ensure failed (test)");
  ensuring += 1;
  try {
    if (payload.force === true) {
      engine.accepting = true;
      if (browser.offscreen !== null) await chrome.offscreen.closeDocument();
    }
    if (browser.offscreen !== null) return { created: false };
    await chrome.offscreen.createDocument({
      url: "engine/offscreen.html",
      reasons: ["WORKERS"],
      justification: "test",
    });
    return { created: true };
  } finally {
    ensuring -= 1;
  }
}

async function setup(serialization: "structured_clone" | "json" = "structured_clone"): Promise<void> {
  browser = new FakeBrowser({
    serialization,
    onServiceWorkerStart: () => {
      onMessageFor("sw", { "sw:ensure-engine": (payload) => ensure(payload) });
    },
    onOffscreenCreated: (ctx) => engine.install(ctx),
  });
  browser.install();
  await browser.startServiceWorker();
  const tab = browser.openTab("https://reader.example/ch-1");
  cs = browser.injectContent(tab.id);
  // Manual-clock callbacks run outside any delivery: they act as this content script.
  browser.setDefaultContext(cs);
}

beforeEach(async () => {
  clock = new ManualClock();
  page = new FakePage();
  engine = new FakeEngine();
  ensureCalls = [];
  ensureFails = false;
  ensuring = 0;
  rereads = [];
  logs = [];
  await setup();
});

afterEach(() => {
  browser.uninstall();
});

function makeClient(overrides: Partial<EngineClientDeps> = {}): EngineClient {
  return cs.run(() =>
    createEngineClient({
      mode: "auto",
      pageHints: () => ({ title: "Chapter 1", layout: "webtoon", visible: page.shown, dpr: 1 }),
      page,
      clock,
      random: () => 0.5,
      log: createLogger("cs", { minLevel: "debug", sinks: [(entry) => logs.push(entry)] }),
      portIdleMs: 300_000,
      reread: (submit) => {
        rereads.push(submit.imageKey);
        return Promise.resolve({ ...submit, bytes: Uint8Array.from([9, 9]).buffer });
      },
      ...overrides,
    }),
  );
}

function submitOf(imageKey: string, priority: number, withBytes = false): ImageSubmit {
  const submit: ImageSubmit = {
    imageKey,
    src: `https://cdn.example/${imageKey}.jpg`,
    natural: { w: 800, h: 1200 },
    displayed: { w: 800, h: 1200 },
    element: "img",
    priority,
    pos: { docOrder: priority, srcGen: 0, yTop: 0 },
    acquire: withBytes ? "bytes" : "url",
  };
  if (withBytes) {
    submit.bytes = Uint8Array.from([1, 2, 3, 4]).buffer;
    submit.mime = "image/png";
    submit.source = "cs-fetch";
  }
  return submit;
}

function submitMessages(side: EngineSide): Array<Extract<CsToEngine, { type: "img:submit" }>> {
  return side.messages.flatMap((m) => (m.type === "img:submit" ? [m] : []));
}

/** Deliveries, plus real time while an ensure handler runs (the fake's createDocument waits 1 ms). */
async function flush(): Promise<void> {
  await browser.settle();
  while (ensuring > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await browser.settle();
  }
}

/** Flushes, then fires the next manual timer, until `done()` holds. */
async function drive(done: () => boolean, maxSteps = 400): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    await flush();
    if (done()) return;
    const delay = clock.nextDelay();
    if (delay === null) assert.fail("drive: nothing scheduled and the condition does not hold");
    clock.advance(delay);
  }
  assert.fail("drive: too many steps");
}

function trackStates(client: EngineClient): EngineClientState[] {
  const states: EngineClientState[] = [];
  client.onState((state) => states.push(state));
  return states;
}

/* ------------------------------------------------------------------ pure decisions */

test("backoffDelay: 250 → 8000 ms doubling, ±20 % jitter, never above 8 s", () => {
  const bases = [250, 500, 1000, 2000, 4000, 8000, 8000, 8000];
  bases.forEach((base, attempt) => {
    assert.equal(
      backoffDelay(attempt, () => 0.5),
      base,
    );
    const low = backoffDelay(attempt, () => 0);
    const high = backoffDelay(attempt, () => 0.999_999);
    assert.equal(low, Math.round(base * 0.8));
    assert.ok(high <= Math.min(BACKOFF_CAP_MS, Math.round(base * 1.2)), `attempt ${attempt}: ${high}`);
    assert.ok(high >= Math.min(BACKOFF_CAP_MS, Math.round(base * 1.2) - 1), `attempt ${attempt}: ${high}`);
  });
  for (let i = 0; i < 200; i += 1) {
    const value = backoffDelay(3, Math.random);
    assert.ok(value >= 1600 && value <= 2400, String(value));
  }
});

test("negotiateCodec, isTerminal and asUrlSubmit", () => {
  assert.deepEqual(negotiateCodec({ codec: "sc", probe: makeProbe() }), { codec: "sc", announce: false });
  assert.deepEqual(negotiateCodec({ codec: "b64", probe: makeProbe() }), { codec: "b64", announce: false });
  assert.deepEqual(negotiateCodec({ codec: "sc", probe: {} }), { codec: "b64", announce: true });
  for (const state of ["done", "no-text", "partial", "refused", "stale", "error"] as const) {
    assert.equal(isTerminal(state), true, state);
  }
  for (const state of ["queued", "acquiring", "detecting", "waiting", "translating", "paused"] as const) {
    assert.equal(isTerminal(state), false, state);
  }
  const overloaded = { code: "engine.overloaded", message: "x", retryable: true } as const;
  assert.equal(isTerminal("error", overloaded), false, "the engine wants it again");
  const url = asUrlSubmit(submitOf("A", 1, true));
  assert.equal(url.acquire, "url");
  assert.equal("bytes" in url || "mime" in url || "source" in url, false);
});

/* ------------------------------------------------------------------ connect, hello, codec */

test("connects lazily on the first submit: ensure → Port → cs:hello → en:hello → submits in priority order", async () => {
  const client = makeClient();
  const states = trackStates(client);
  await flush();
  assert.equal(client.state, "idle");
  assert.equal(ensureCalls.length, 0, "no engine for pages that never submit");

  client.submit(submitOf("A", 5, true));
  client.submit(submitOf("B", 1));
  assert.equal(client.state, "connecting");
  assert.equal(client.post({ type: "cs:heartbeat" }), false, "other messages are not queued");
  await drive(() => client.state === "open" && engine.submits().length === 2);

  assert.deepEqual(states, ["connecting", "open"]);
  assert.deepEqual(ensureCalls, [{ at: 0, force: false }]);
  const [hello, ...rest] = engine.last.messages;
  assert.equal(hello?.type, "cs:hello");
  if (hello?.type === "cs:hello") {
    assert.equal(hello.v, PROTOCOL_VERSION);
    assert.equal(hello.mode, "auto");
    assert.equal(isProbe(hello.probe), true);
    assert.deepEqual(hello.page, { title: "Chapter 1", layout: "webtoon", visible: true, dpr: 1 });
  }
  assert.deepEqual(
    rest.map((m) => m.type),
    ["img:submit", "img:submit"],
  );
  assert.deepEqual(engine.submits(), ["B", "A"]);
  assert.ok(submitMessages(engine.last)[1]?.bytes instanceof ArrayBuffer, "bytes travel on the first post");
  assert.equal(client.codec, "sc");

  client.submit(submitOf("C", 3));
  assert.equal(client.post({ type: "cs:heartbeat" }), true);
  await flush();
  assert.deepEqual(engine.submits(), ["B", "A", "C"]);
  assert.equal(engine.last.messages.at(-1)?.type, "cs:heartbeat");
  assert.deepEqual(rereads, []);
});

test("a JSON-only channel negotiates base64: cs:codec is announced and bytes travel as {b64}", async () => {
  browser.uninstall();
  await setup("json");
  const client = makeClient();
  client.submit(submitOf("A", 1, true));
  await drive(() => client.state === "open" && engine.submits().length === 1);
  assert.equal(client.codec, "b64");
  const types = engine.last.messages.map((m) => m.type);
  assert.deepEqual(types, ["cs:hello", "cs:codec", "img:submit"]);
  assert.deepEqual(submitMessages(engine.last)[0]?.bytes, { b64: "AQIDBA==" });
});

test("a submit over the codec's hard limit goes out as a URL submit", async () => {
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "open");
  const huge = { ...submitOf("B", 1, true), bytes: new ArrayBuffer(33 * 1024 * 1024) };
  client.submit(huge);
  await flush();
  const sent = submitMessages(engine.last).find((m) => m.imageKey === "B");
  assert.equal(sent?.acquire, "url");
  assert.equal(sent !== undefined && "bytes" in sent, false);
});

/* ------------------------------------------------------------------ reconnect and resubmission */

test("after a reconnect every unfinished image is resubmitted in priority order; dropped bytes are re-read", async () => {
  const client = makeClient();
  client.submit(submitOf("A", 5, true));
  client.submit(submitOf("B", 1));
  client.submit(submitOf("C", 3, true));
  await drive(() => client.state === "open" && engine.submits().length === 3);
  const first = engine.last;
  assert.deepEqual(engine.submits(first), ["B", "C", "A"]);
  // Reading position changed while connected: the engine and the pending list both learn it.
  assert.equal(client.post({ type: "img:priority", items: [{ imageKey: "A", priority: 0 }] }), true);
  engine.send({ type: "img:state", imageKey: "B", state: "done" });
  engine.send({ type: "img:state", imageKey: "C", state: "translating" });
  await flush();

  browser.offscreen?.destroy();
  await flush();
  assert.equal(client.state, "backoff");
  assert.equal(clock.nextDelay(), 250);
  await drive(() => engine.sides.length === 2 && engine.submits().length === 2);

  assert.equal(client.state, "open");
  assert.deepEqual(engine.submits(), ["A", "C"], "B finished; A now comes first");
  assert.deepEqual(rereads, ["A", "C"], "bytes are re-read, not kept");
  for (const message of submitMessages(engine.last)) {
    assert.deepEqual(new Uint8Array(message.bytes as ArrayBuffer), Uint8Array.from([9, 9]));
  }
});

test("img:state engine.overloaded makes the client send that image again after a short delay", async () => {
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "open" && engine.submits().length === 1);
  engine.send({
    type: "img:state",
    imageKey: "A",
    state: "error",
    error: { code: "engine.overloaded", message: "gate buffer full", retryable: true },
  });
  await flush();
  assert.equal(clock.nextDelay(), RESEND_DELAY_MS);
  clock.advance(RESEND_DELAY_MS);
  await flush();
  assert.deepEqual(engine.submits(), ["A", "A"]);
});

/* ------------------------------------------------------------------ failures */

test("backoff timers follow the schedule, with jitter, until the engine answers", async () => {
  ensureFails = true;
  const client = makeClient({ random: () => 0 });
  client.submit(submitOf("A", 1));
  await drive(() => ensureCalls.length === 8);
  const gaps = ensureCalls.slice(1).map((call, i) => call.at - (ensureCalls[i]?.at ?? 0));
  assert.deepEqual(gaps, [200, 400, 800, 1600, 3200, 6400, 6400]);
  assert.equal(client.state, "backoff");
  ensureFails = false;
  await drive(() => client.state === "open");
  assert.deepEqual(engine.submits(), ["A"]);
});

test("3 fast failures while the engine exists → the next ensure asks for force: true", async () => {
  engine.accepting = false;
  const sw = browser.serviceWorker;
  assert.ok(sw !== null);
  await sw.run(() =>
    chrome.offscreen.createDocument({
      url: "engine/offscreen.html",
      reasons: ["WORKERS"],
      justification: "t",
    }),
  );
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "open");
  assert.deepEqual(
    ensureCalls.map((call) => call.force),
    [false, false, false, true],
  );
  assert.deepEqual(
    ensureCalls.map((call) => call.at),
    [0, 250, 750, 1750],
  );
  assert.deepEqual(engine.submits(), ["A"]);
});

test("no en:hello within 10 s counts as a failure; the next attempt opens a fresh port", async () => {
  engine.helloMode = "silent";
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await flush();
  assert.equal(client.state, "connecting");
  assert.equal(clock.nextDelay(), HELLO_TIMEOUT_MS);
  clock.advance(HELLO_TIMEOUT_MS);
  await flush();
  assert.equal(client.state, "backoff");
  assert.equal(engine.sides[0]?.raw.connected, false, "the silent port was closed");
  engine.helloMode = "answer";
  await drive(() => client.state === "open");
  assert.equal(engine.sides.length, 2);
  assert.deepEqual(engine.submits(), ["A"]);
});

test("en:closing: reconnect after 500 ms without counting a failure", async () => {
  engine.helloMode = "closing-once";
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await flush();
  assert.equal(client.state, "backoff");
  assert.equal(clock.nextDelay(), CLOSING_RETRY_MS);
  await drive(() => client.state === "open");
  assert.equal(ensureCalls.length, 2);
  assert.deepEqual(engine.submits(), ["A"]);
});

test("gives up after 10 visible minutes with engine.unavailable per pending image; a new submit restarts", async () => {
  ensureFails = true;
  const client = makeClient();
  const errors: Array<[string, string]> = [];
  client.on("img:state", (message) => errors.push([message.imageKey, message.error?.code ?? ""]));
  client.submit(submitOf("A", 1));
  client.submit(submitOf("B", 2));
  await drive(() => clock.now() >= 120_000);

  // Hidden time does not count and runs no timers.
  page.fire("hidden");
  await flush();
  assert.equal(client.state, "backoff");
  assert.equal(clock.nextDelay(), null);
  const hiddenFor = 30 * 60_000;
  clock.advance(hiddenFor);
  const callsBefore = ensureCalls.length;
  page.fire("visible");
  assert.equal(client.state, "connecting", "visible again: retry at once");
  assert.equal(ensureCalls.length, callsBefore);
  await drive(() => client.state === "idle");

  const firstFailureAt = ensureCalls[0]?.at ?? 0;
  const visibleFailing = clock.now() - firstFailureAt - hiddenFor;
  assert.ok(
    visibleFailing >= GIVE_UP_MS && visibleFailing <= GIVE_UP_MS + BACKOFF_CAP_MS,
    String(visibleFailing),
  );
  assert.deepEqual(errors, [
    ["A", "engine.unavailable"],
    ["B", "engine.unavailable"],
  ]);
  assert.equal(clock.timers.size, 0, "the loop stopped");
  page.fire("hidden");
  page.fire("visible");
  await flush();
  assert.equal(client.state, "idle", "visibility does not restart a stopped loop");

  ensureFails = false;
  client.submit(submitOf("C", 3));
  await drive(() => client.state === "open" && engine.submits().length === 3);
  assert.deepEqual(engine.submits(), ["A", "B", "C"]);
});

test("a protocol mismatch stops with engine.protocol for the pending images", async () => {
  engine.protocol = PROTOCOL_VERSION + 1;
  const client = makeClient();
  const errors: string[] = [];
  client.on("img:state", (message) => errors.push(message.error?.code ?? ""));
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "idle");
  assert.deepEqual(errors, ["engine.protocol"]);
  assert.equal(engine.submits().length, 0);
});

/* ------------------------------------------------------------------ page lifecycle */

test("hidden page: the backoff waits for visibility, then retries at once", async () => {
  ensureFails = true;
  page.shown = false;
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await flush();
  assert.equal(client.state, "backoff");
  assert.equal(clock.nextDelay(), null, "no timer while hidden");
  ensureFails = false;
  page.fire("visible");
  await drive(() => client.state === "open");
  assert.equal(ensureCalls.length, 2);
  page.fire("hidden");
  await flush();
  const visibility = engine.last.messages.filter((m) => m.type === "cs:visibility");
  assert.deepEqual(visibility, [{ type: "cs:visibility", visible: false }]);
});

test("BFCache: pagehide suspends without reconnecting; pageshow reconnects and resubmits unfinished images", async () => {
  const client = makeClient();
  client.submit(submitOf("A", 1, true));
  client.submit(submitOf("B", 2));
  await drive(() => client.state === "open" && engine.submits().length === 2);
  engine.send({ type: "img:state", imageKey: "B", state: "done" });
  await flush();

  page.fire("bfcache-hide");
  assert.equal(client.state, "suspended");
  await flush();
  assert.equal(engine.sides[0]?.raw.connected, false, "the engine saw the port close");
  clock.advance(10 * 60_000);
  await flush();
  assert.equal(ensureCalls.length, 1, "no attempts while suspended");
  client.submit(submitOf("C", 3, true));
  assert.equal(client.state, "suspended");

  page.fire("bfcache-show");
  await drive(() => engine.sides.length === 2 && engine.submits().length === 2);
  assert.equal(client.state, "open");
  assert.deepEqual(engine.submits(), ["A", "C"]);
  assert.deepEqual(rereads, ["A", "C"]);
});

test("extension reload: the orphan goes dead without retries or listener errors", async () => {
  const client = makeClient();
  const states = trackStates(client);
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "open");
  const calls = ensureCalls.length;

  browser.invalidateExtension();
  await flush();
  assert.equal(client.state, "dead");
  assert.equal(states.at(-1), "dead");
  assert.equal(clock.timers.size, 0);
  clock.advance(60 * 60_000);
  page.fire("bfcache-show");
  client.submit(submitOf("B", 1));
  assert.equal(client.post({ type: "cs:heartbeat" }), false);
  await flush();
  assert.equal(client.state, "dead");
  assert.equal(ensureCalls.length, calls);
  assert.deepEqual(browser.listenerErrors, []);
});

test("a client started in an invalidated context dies on the first submit", async () => {
  browser.invalidateExtension();
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await flush();
  assert.equal(client.state, "dead");
  assert.equal(ensureCalls.length, 0);
});

/* ------------------------------------------------------------------ idle, forget, SW restart */

test("idle: the port closes after portIdleMs with nothing pending; the next submit reconnects", async () => {
  const client = makeClient({ portIdleMs: 5_000 });
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "open" && engine.submits().length === 1);
  engine.send({ type: "img:state", imageKey: "A", state: "translating" });
  await flush();
  assert.equal(clock.nextDelay(), null, "work pending: no idle timer");
  engine.send({ type: "img:done", imageKey: "A", contentKey: "s:1", counts: { ok: 3 } });
  await flush();
  assert.equal(clock.nextDelay(), 5_000);
  clock.advance(4_999);
  assert.equal(client.state, "open");
  clock.advance(1);
  assert.equal(client.state, "idle");
  await flush();
  assert.equal(engine.sides[0]?.raw.connected, false);

  client.submit(submitOf("B", 1));
  await drive(() => engine.sides.length === 2 && engine.submits().length === 1);
  assert.equal(client.state, "open");
  assert.deepEqual(engine.submits(), ["B"]);
});

test("a detected prefetch candidate (waiting) needs nothing more: it does not keep the port open", async () => {
  const client = makeClient({ portIdleMs: 5_000 });
  client.submit({ ...submitOf("P", 4), natural: null, prefetch: true });
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "open" && engine.submits().length === 2);
  engine.send({ type: "img:state", imageKey: "A", state: "waiting" });
  engine.send({ type: "img:state", imageKey: "P", state: "waiting" });
  await flush();
  assert.equal(clock.nextDelay(), null, "A (no prefetch) still waits for its translation");
  engine.send({ type: "img:done", imageKey: "A", contentKey: "s:1", counts: { ok: 1 } });
  await flush();
  assert.equal(clock.nextDelay(), 5_000, "only the prefetch candidate is left: idle timer armed");
});

test("forget drops pending work and tells the engine; on() handlers can unsubscribe", async () => {
  const client = makeClient({ portIdleMs: 1_000 });
  const units: string[] = [];
  const off = client.on("img:unit", (message) => units.push(message.unit.unitKey));
  client.submit(submitOf("A", 1));
  client.submit(submitOf("B", 2));
  await drive(() => client.state === "open" && engine.submits().length === 2);
  const unit = {
    unitKey: "1:2:3:4",
    type: "dialogue" as const,
    speaker: "",
    original: "안녕",
    translation: "Chào",
    status: "ok" as const,
    fit: {
      region: { x1: 0, y1: 0, x2: 10, y2: 10 },
      shape: "ellipse" as const,
      orientation: "h" as const,
      glyphPx: 20,
    },
    erase: {
      kind: "none" as const,
      rect: { x1: 0, y1: 0, x2: 10, y2: 10 },
      bg: null,
      textColor: [0, 0, 0] as const,
    },
  };
  engine.send({ type: "img:unit", imageKey: "A", unit });
  await flush();
  off();
  engine.send({ type: "img:unit", imageKey: "A", unit: { ...unit, unitKey: "5:6:7:8" } });
  client.forget(["A", "B"]);
  await flush();
  assert.deepEqual(units, ["1:2:3:4"]);
  assert.deepEqual(engine.last.messages.at(-1), { type: "img:forget", imageKeys: ["A", "B"] });
  assert.equal(clock.nextDelay(), 1_000, "nothing pending: idle timer armed");
});

test("a service-worker restart leaves the open port alone; later ensures reach the new worker", async () => {
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "open");
  await browser.restartServiceWorker();
  await flush();
  assert.equal(client.state, "open");
  client.submit(submitOf("B", 2));
  await flush();
  assert.deepEqual(engine.submits(), ["A", "B"]);

  browser.offscreen?.destroy();
  await drive(() => engine.sides.length === 2 && engine.submits().length === 2);
  assert.equal(client.state, "open");
  assert.equal(ensureCalls.length, 2);
});

test("close() is permanent and idempotent", async () => {
  const client = makeClient();
  client.submit(submitOf("A", 1));
  await drive(() => client.state === "open");
  client.close();
  client.close();
  await flush();
  assert.equal(client.state, "dead");
  assert.equal(engine.sides[0]?.raw.connected, false);
  assert.equal(page.listeners.size, 0, "page listeners removed");
  assert.ok(
    !logs.some((entry) => entry.level === "error"),
    JSON.stringify(logs.filter((e) => e.level === "error")),
  );
});
