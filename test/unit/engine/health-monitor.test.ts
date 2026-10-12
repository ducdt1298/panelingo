// GET {baseUrl}/models monitor (cadence, pauses, holds, settings changes) with a manual clock and a scripted fetch:
// no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServiceFactories } from "../../../src/engine/contracts.ts";
import {
  CONFIG_HOLD_MS,
  createHealth,
  HEALTH_CADENCE,
  UNAUTHORIZED_HOLD_MS,
  type HealthFetch,
  type HealthMonitor,
} from "../../../src/engine/health-monitor.ts";
import { createSettingsCache, type SettingsCache } from "../../../src/engine/settings-cache.ts";
import { modelsUrl, type HealthReading } from "../../../src/shared/core/health.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/shared/settings.ts";
import type { ApiReadiness } from "../../../src/shared/types.ts";
import { captureLogger, ManualClock } from "./store/engine-fakes.ts";

/** Never a real provider: the fetch below is fake anyway. */
const BASE_URL = "https://llm.example.invalid/v1";
const API_KEY = "sk-test";
const MODEL = "gpt-4o-mini";

interface Server {
  mode: "answer" | "throw" | "hang" | "defer";
  status: number;
  /** Sent as is when a string, else as JSON. */
  body: unknown;
  error: Error;
  calls: Array<{ url: string; init: Parameters<HealthFetch>[1]; at: number }>;
  /** "defer": answers the held request with the current status and body. */
  release: () => void;
}

interface Harness {
  clock: ManualClock;
  server: Server;
  health: HealthMonitor;
  settings: SettingsCache;
  changes: ApiReadiness[];
  /** Applies a modified copy of the current settings (like en:settings). */
  update(mutate: (settings: Settings) => void): void;
}

/** An OpenAI-style GET /models body. */
function modelList(...ids: string[]): unknown {
  return { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "test" })) };
}

function harness(patch: (settings: Settings) => void = () => undefined): Harness {
  const clock = new ManualClock();
  const settings = createSettingsCache({ clock });
  const base = structuredClone(DEFAULT_SETTINGS);
  base.api.baseUrl = BASE_URL;
  base.api.apiKey = API_KEY;
  base.api.model = MODEL;
  patch(base);
  settings.apply(base, {});
  const server: Server = {
    mode: "answer",
    status: 200,
    body: modelList(MODEL, "gpt-4o"),
    error: new TypeError("x"),
    calls: [],
    release: () => undefined,
  };
  const answer = (): { ok: boolean; status: number; text: () => Promise<string> } => {
    const text = typeof server.body === "string" ? server.body : JSON.stringify(server.body);
    const status = server.status;
    return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
  };
  const fetch: HealthFetch = (url, init) => {
    server.calls.push({ url, init, at: clock.now() });
    switch (server.mode) {
      case "answer":
        return Promise.resolve(answer());
      case "throw":
        return Promise.reject(server.error);
      case "hang":
        return new Promise(() => undefined);
      case "defer":
        return new Promise((resolve) => {
          server.release = () => resolve(answer());
        });
    }
  };
  const health = createHealth({ clock, log: captureLogger().log, settings, fetch });
  const changes: ApiReadiness[] = [];
  health.onChange((reading) => changes.push(reading.readiness));
  return {
    clock,
    server,
    health,
    settings,
    changes,
    update: (mutate) => {
      const next = structuredClone(settings.current());
      mutate(next);
      settings.apply(next, {});
    },
  };
}

const callTimes = (h: Harness): number[] =>
  h.server.calls.map((call) => call.at - (h.server.calls[0]?.at ?? 0));

test("GET {baseUrl}/models with the Bearer key, no-store, no credentials; every readiness value is reachable", async () => {
  const h = harness();
  const { clock, server, health } = h;
  assert.equal(health.reading().readiness, "unknown");
  assert.equal(health.checkedAt(), 0);
  assert.equal(health.sendable(), false);
  const read = (): Promise<HealthReading> => health.refresh();

  assert.deepEqual(await read(), { readiness: "ready", model: MODEL, cause: null });
  assert.equal(health.sendable(), true);
  assert.equal(health.checkedAt(), clock.now());
  const call = server.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, `${BASE_URL}/models`);
  assert.equal(call.url, modelsUrl(BASE_URL));
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.credentials, "omit");
  assert.deepEqual(call.init.headers, { Authorization: `Bearer ${API_KEY}` });
  assert.equal(call.init.signal.aborted, false);
  assert.equal(modelsUrl("http://h:1/v1///"), "http://h:1/v1/models");

  server.body = modelList("gpt-4o", "o3-mini");
  assert.deepEqual(
    await read(),
    { readiness: "ready", model: MODEL, cause: `model "${MODEL}" is not listed by the server` },
    "200 with an unlisted model is ready, with a cause",
  );
  assert.equal(health.sendable(), true, "an unlisted model is only a warning");

  server.status = 401;
  server.body = {
    error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" },
  };
  assert.deepEqual(await read(), {
    readiness: "unauthorized",
    model: MODEL,
    cause: "Incorrect API key provided",
  });
  assert.equal(health.sendable(), false);
  server.status = 403;
  server.body = "";
  assert.deepEqual(await read(), { readiness: "unauthorized", model: MODEL, cause: "HTTP 403" });
  server.status = 404;
  server.body = "Not Found";
  assert.deepEqual(await read(), {
    readiness: "ready",
    model: MODEL,
    cause: "the server has no /models route",
  });
  server.status = 429;
  server.body = { error: { message: "Rate limit reached" } };
  assert.deepEqual(await read(), { readiness: "ready", model: MODEL, cause: "rate limited" });
  server.status = 500;
  server.body = "";
  assert.deepEqual(await read(), { readiness: "unreachable", model: MODEL, cause: "HTTP 500" });
  assert.equal(health.sendable(), false);
  server.status = 200;
  server.body = "<html>not a model list</html>";
  assert.deepEqual(
    await read(),
    { readiness: "ready", model: MODEL, cause: null },
    "a 200 without a model list still proves the endpoint answers",
  );

  server.mode = "throw";
  server.error = new TypeError("Failed to fetch");
  assert.deepEqual(await read(), { readiness: "unreachable", model: MODEL, cause: "Failed to fetch" });
  server.error = new TypeError("Failed to fetch", {
    cause: new Error("Permission was denied for this request to access the `loopback` address space."),
  });
  assert.equal((await read()).readiness, "lna_blocked");

  server.mode = "hang";
  const pending = read();
  await clock.advance(DEFAULT_SETTINGS.api.healthTimeoutMs);
  const timedOut = await pending;
  assert.equal(timedOut.readiness, "unreachable", "a timed-out check counts as a network error");
  assert.match(timedOut.cause ?? "", /timed out/u);
  assert.equal(server.calls.at(-1)?.init.signal.aborted, true, "the timed-out request is aborted");

  // onChange fires on any reading change: a new cause with the same readiness counts too.
  assert.deepEqual(h.changes, [
    "ready",
    "ready",
    "unauthorized",
    "unauthorized",
    "ready",
    "ready",
    "unreachable",
    "ready",
    "unreachable",
    "lna_blocked",
    "unreachable",
  ]);
  health.stop();
});

test("misconfigured without any request: no model, an invalid base URL, a base URL that is not http(s)", async () => {
  const cases: Array<[string, (settings: Settings) => void]> = [
    ["no model configured", (s) => (s.api.model = "")],
    ["no model configured", (s) => (s.api.model = "   ")],
    ["invalid base URL", (s) => (s.api.baseUrl = "not a url")],
    ["the base URL must be http or https", (s) => (s.api.baseUrl = "ftp://files.example/v1")],
  ];
  for (const [cause, patch] of cases) {
    const h = harness(patch);
    const reading = await h.health.refresh();
    assert.equal(reading.readiness, "misconfigured", cause);
    assert.equal(reading.cause, cause);
    assert.equal(h.health.sendable(), false);
    assert.ok(h.health.checkedAt() > 0, "the check itself completed");
    assert.equal(h.server.calls.length, 0, `${cause}: no request is made`);
    h.health.stop();
  }
  const noModel = harness((s) => (s.api.model = ""));
  assert.equal((await noModel.health.refresh()).model, null);
  noModel.health.stop();
});

test("misconfigured keeps polling every 15 s without requests; fixing the model checks at once and resumes", async () => {
  const h = harness((s) => (s.api.model = ""));
  const { clock, server, health } = h;
  health.setBusy(true);
  let resumed = false;
  void health.whenSendable().then(() => {
    resumed = true;
  });
  await clock.advance(0);
  const first = health.checkedAt();
  assert.equal(health.reading().readiness, "misconfigured");
  await clock.advance(HEALTH_CADENCE.pausedMs);
  assert.equal(health.checkedAt(), first + HEALTH_CADENCE.pausedMs, "misconfigured: checked every 15 s");
  await clock.advance(HEALTH_CADENCE.pausedMs * 3);
  assert.equal(server.calls.length, 0);
  assert.equal(resumed, false);

  h.update((s) => (s.api.model = MODEL));
  await clock.advance(0);
  assert.equal(server.calls.length, 1, "a fixed model is checked at once");
  assert.deepEqual(health.reading(), { readiness: "ready", model: MODEL, cause: null });
  assert.equal(resumed, true);
  health.stop();
});

test("a change of baseUrl, apiKey or model is checked at once; other settings are not", async () => {
  const h = harness();
  const { clock, server, health } = h;
  await health.refresh();
  assert.equal(server.calls.length, 1);

  h.update((s) => {
    s.api.concurrency = 1;
    s.translate.targetLang = "vi";
  });
  await clock.advance(0);
  assert.equal(server.calls.length, 1, "unrelated settings do not trigger a check");

  h.update((s) => (s.api.baseUrl = "http://127.0.0.1:11434/v1"));
  await clock.advance(0);
  assert.equal(server.calls.length, 2);
  assert.equal(server.calls.at(-1)?.url, "http://127.0.0.1:11434/v1/models");

  h.update((s) => (s.api.apiKey = ""));
  await clock.advance(0);
  assert.equal(server.calls.length, 3);
  assert.deepEqual(server.calls.at(-1)?.init.headers, {}, "no key: no Authorization header");

  h.update((s) => (s.api.apiKey = "  sk-new  "));
  await clock.advance(0);
  assert.equal(server.calls.length, 4);
  assert.deepEqual(server.calls.at(-1)?.init.headers, { Authorization: "Bearer sk-new" });

  server.body = modelList("llava:13b");
  h.update((s) => (s.api.model = "llava:13b"));
  await clock.advance(0);
  assert.equal(server.calls.length, 5);
  assert.deepEqual(health.reading(), { readiness: "ready", model: "llava:13b", cause: null });

  health.stop();
  h.update((s) => (s.api.model = MODEL));
  await clock.advance(0);
  assert.equal(server.calls.length, 5, "stopped: settings changes are ignored");
  assert.equal((await health.refresh()).model, "llava:13b", "stopped: refresh returns the last reading");
});

test("new endpoint settings lift a hold at once: a new key ends an unauthorized hold, a new model a config hold", async () => {
  const h = harness();
  const { clock, server, health } = h;
  health.setBusy(true);
  await clock.advance(0);

  health.report({ code: "api.unauthorized", message: "Incorrect API key provided", retryable: true });
  assert.equal(health.reading().readiness, "unauthorized");
  assert.equal(health.sendable(), false);
  h.update((s) => (s.api.apiKey = "sk-fixed"));
  await clock.advance(0);
  assert.equal(health.sendable(), true, "the new key was checked and the hold dropped");
  assert.deepEqual(server.calls.at(-1)?.init.headers, { Authorization: "Bearer sk-fixed" });

  health.report({ code: "api.config", message: "The model `gpt-9` does not exist", retryable: false });
  assert.equal(health.reading().readiness, "misconfigured");
  h.update((s) => (s.api.model = "gpt-4o"));
  await clock.advance(0);
  assert.deepEqual(health.reading(), { readiness: "ready", model: "gpt-4o", cause: null });
  health.stop();
});

test("cadence: 30 s while ready with work, 15 s while unauthorized, 5 s after a network error", async () => {
  const h = harness();
  const { clock, server, health } = h;
  health.setBusy(true);
  await clock.advance(0);
  assert.equal(server.calls.length, 1, "work starts polling at once");
  await clock.advance(HEALTH_CADENCE.readyMs - 1);
  assert.equal(server.calls.length, 1);
  await clock.advance(1);
  assert.equal(server.calls.length, 2);

  server.status = 401;
  await clock.advance(HEALTH_CADENCE.readyMs);
  assert.equal(health.reading().readiness, "unauthorized");
  const unauthorizedAt = server.calls.length;
  await clock.advance(HEALTH_CADENCE.pausedMs * 2);
  assert.equal(server.calls.length - unauthorizedAt, 2, "unauthorized: every 15 s");

  server.status = 503;
  await clock.advance(HEALTH_CADENCE.pausedMs);
  assert.equal(health.reading().readiness, "unreachable");
  const downAt = server.calls.length;
  await clock.advance(HEALTH_CADENCE.networkFastMs * 3);
  assert.equal(server.calls.length - downAt, 3, "a 5xx counts as a network error: every 5 s");

  server.status = 200;
  await clock.advance(HEALTH_CADENCE.networkFastMs);
  assert.equal(health.reading().readiness, "ready");
  const readyAt = server.calls.length;
  await clock.advance(HEALTH_CADENCE.readyMs);
  assert.equal(server.calls.length - readyAt, 1);
  health.stop();
  await clock.advance(HEALTH_CADENCE.readyMs * 4);
  assert.equal(server.calls.length - readyAt, 1, "stop() ends polling");
  assert.equal(clock.pending(), 0);
});

test("network errors: every 5 s for 2 min, then every 30 s; a good answer ends the streak", async () => {
  const h = harness();
  const { clock, server, health } = h;
  server.mode = "throw";
  server.error = new TypeError("Failed to fetch");
  health.setBusy(true);
  await clock.advance(0);
  assert.equal(health.reading().readiness, "unreachable");
  await clock.advance(HEALTH_CADENCE.networkFastForMs);
  assert.deepEqual(
    callTimes(h),
    Array.from({ length: 25 }, (_, i) => i * HEALTH_CADENCE.networkFastMs),
  );
  await clock.advance(HEALTH_CADENCE.networkSlowMs * 2);
  assert.deepEqual(callTimes(h).slice(-2), [150_000, 180_000]);
  server.mode = "answer";
  await clock.advance(HEALTH_CADENCE.networkSlowMs);
  assert.equal(health.reading().readiness, "ready");
  const readyAt = server.calls.length;
  await clock.advance(HEALTH_CADENCE.readyMs);
  assert.equal(server.calls.length - readyAt, 1);
  health.stop();
});

test("2 min without work or waiters stops polling; setBusy(true) and whenSendable() restart it", async () => {
  const h = harness();
  const { clock, server, health } = h;
  await health.refresh();
  await clock.advance(HEALTH_CADENCE.idleStopMs * 2);
  assert.deepEqual(callTimes(h), [0, 30_000, 60_000, 90_000]);
  assert.equal(clock.pending(), 0, "polling stopped");

  health.setBusy(true);
  await clock.advance(0);
  assert.equal(server.calls.length, 5, "restarted at once (the last check is stale)");
  health.setBusy(false);
  await clock.advance(HEALTH_CADENCE.idleStopMs + HEALTH_CADENCE.readyMs);
  assert.equal(clock.pending(), 0);
  const before = server.calls.length;

  server.status = 401;
  await health.refresh();
  assert.equal(health.reading().readiness, "unauthorized");
  let resolved = false;
  void health.whenSendable().then(() => {
    resolved = true;
  });
  await clock.advance(HEALTH_CADENCE.pausedMs);
  assert.equal(resolved, false);
  assert.equal(server.calls.length - before, 2, "a waiter keeps polling alive");
  server.status = 200;
  await clock.advance(HEALTH_CADENCE.pausedMs);
  assert.equal(resolved, true);
  health.stop();
});

test("whenSendable() checks at once when nothing is known yet and resolves on the first sendable reading", async () => {
  const h = harness();
  const { server, health } = h;
  server.body = modelList("gpt-4o");
  await health.whenSendable();
  assert.equal(health.reading().readiness, "ready");
  assert.match(health.reading().cause ?? "", /is not listed/u);
  assert.equal(server.calls.length, 1);
  await health.whenSendable();
  assert.equal(server.calls.length, 1, "already sendable: no request");
  health.stop();
});

test("report() pauses at once for network codes; only a /models check requested after it resumes", async () => {
  const h = harness();
  const { clock, server, health } = h;
  health.setBusy(true);
  await clock.advance(0);
  assert.equal(health.sendable(), true);

  health.report({ code: "api.unreachable", message: "Failed to fetch", retryable: true });
  assert.deepEqual(health.reading(), {
    readiness: "unreachable",
    model: MODEL,
    cause: "api.unreachable: Failed to fetch",
  });
  assert.equal(health.sendable(), false);
  let resumed = false;
  void health.whenSendable().then(() => {
    resumed = true;
  });
  const reportedAt = server.calls.length;
  await clock.advance(HEALTH_CADENCE.networkFastMs - 1);
  assert.equal(server.calls.length, reportedAt, "no immediate re-check after a failure");
  await clock.advance(1);
  assert.equal(server.calls.length, reportedAt + 1);
  assert.equal(resumed, true, "/models answered: resume");
  assert.equal(health.reading().readiness, "ready");

  health.report({ code: "api.lna_blocked", message: "loopback address space", retryable: false });
  assert.equal(health.reading().readiness, "lna_blocked");
  assert.equal(health.sendable(), false);
  await clock.advance(HEALTH_CADENCE.networkFastMs);
  assert.equal(health.sendable(), true, "lna_blocked is lifted by the next /models answer");

  for (const code of ["api.rate_limit", "api.upstream", "api.timeout", "api.bad_request"] as const) {
    health.report({ code, message: code, retryable: true });
    assert.equal(health.sendable(), true, `${code}: batch-level codes do not pause the queue`);
  }
  assert.ok(h.changes.includes("unreachable") && h.changes.includes("lna_blocked"));
  health.stop();
});

test("api.unauthorized holds 60 s even while /models says 200 (polled every 15 s), then the probe decides", async () => {
  const h = harness();
  const { clock, server, health } = h;
  health.setBusy(true);
  await clock.advance(0);
  health.report({ code: "api.unauthorized", message: "Incorrect API key provided", retryable: true });
  assert.deepEqual(health.reading(), {
    readiness: "unauthorized",
    model: MODEL,
    cause: "api.unauthorized: Incorrect API key provided",
  });
  await clock.advance(UNAUTHORIZED_HOLD_MS - 1);
  assert.equal(health.sendable(), false, "still held although /models answered 200");
  assert.deepEqual(callTimes(h), [0, 15_000, 30_000, 45_000]);
  await clock.advance(1);
  assert.equal(health.sendable(), true, "the hold ends with a check at 60 s");
  assert.deepEqual(callTimes(h).at(-1), UNAUTHORIZED_HOLD_MS);

  // A probe that /models itself answers with 401 stays unauthorized after the hold.
  health.report({ code: "api.unauthorized", message: "401 from chat", retryable: true });
  server.status = 401;
  server.body = { error: { message: "Invalid authentication" } };
  await clock.advance(HEALTH_CADENCE.pausedMs);
  assert.equal(
    health.reading().cause,
    "api.unauthorized: 401 from chat",
    "the reported cause shows during the hold",
  );
  await clock.advance(UNAUTHORIZED_HOLD_MS - HEALTH_CADENCE.pausedMs);
  assert.deepEqual(health.reading(), {
    readiness: "unauthorized",
    model: MODEL,
    cause: "Invalid authentication",
  });
  health.stop();
});

test("api.config holds 5 min even while /models says 200; /models cannot see a rejected model", async () => {
  const h = harness();
  const { clock, server, health } = h;
  health.setBusy(true);
  await clock.advance(0);
  health.report({ code: "api.config", message: "image input is not supported", retryable: false });
  assert.equal(health.reading().readiness, "misconfigured");
  assert.equal(health.reading().cause, "api.config: image input is not supported");
  const reportedAt = server.calls.length;
  await clock.advance(CONFIG_HOLD_MS - 1);
  assert.equal(health.sendable(), false);
  assert.equal(
    server.calls.length - reportedAt,
    Math.floor((CONFIG_HOLD_MS - 1) / HEALTH_CADENCE.pausedMs),
    "polled every 15 s during the hold",
  );
  await clock.advance(1);
  assert.equal(health.sendable(), true, "the hold runs out with a check at 5 min");
  assert.deepEqual(health.reading(), { readiness: "ready", model: MODEL, cause: null });
  health.stop();
});

test("a check in flight cannot lift a newer pause", async () => {
  const h = harness();
  const { clock, server, health } = h;
  health.setBusy(true);
  await clock.advance(0);
  server.mode = "defer";
  const inFlight = health.refresh();
  await clock.advance(0);
  health.report({ code: "api.unreachable", message: "x", retryable: true });
  server.release();
  await inFlight;
  assert.equal(
    health.reading().readiness,
    "unreachable",
    "a /models sent before the failure keeps the pause",
  );
  assert.equal(health.sendable(), false);
  server.mode = "answer";
  await clock.advance(HEALTH_CADENCE.networkFastMs);
  assert.equal(health.reading().readiness, "ready", "the next check, sent after the failure, resumes");
  health.stop();
});

test("constants: the hold lengths and the cadence", () => {
  assert.equal(UNAUTHORIZED_HOLD_MS, 60_000);
  assert.equal(CONFIG_HOLD_MS, 300_000);
  assert.deepEqual(
    { ...HEALTH_CADENCE },
    {
      readyMs: 30_000,
      pausedMs: 15_000,
      networkFastMs: 5_000,
      networkFastForMs: 120_000,
      networkSlowMs: 30_000,
      idleStopMs: 120_000,
    },
  );
});

test("createHealth fits ServiceFactories.createHealth (fetch defaults to the global one)", () => {
  const factory: ServiceFactories["createHealth"] = createHealth;
  assert.equal(typeof factory, "function");
});
