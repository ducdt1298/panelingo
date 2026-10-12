import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyFetchError } from "../../../src/shared/core/api-errors.ts";
import {
  configProblem,
  INITIAL_HEALTH,
  readinessFrom,
  readinessFromFetchError,
  type HealthReading,
} from "../../../src/shared/core/health.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import { catalogFor, msg, setLocale } from "../../../src/shared/i18n/index.ts";
import type { ApiReadiness, EngineStatus } from "../../../src/shared/types.ts";
import {
  apiBlock,
  engineBlock,
  errorTitle,
  READINESS_TONE,
  uploadsLine,
} from "../../../src/ui/common/status-view.ts";
import { statusFixture } from "../sw/sw-helpers.ts";

const MODEL = "gpt-4o-mini";
const BASE_URL = "https://api.example.test/v1";

/** Every readiness value, with the GET /models answer (or failure) that produces it. */
function everyReadiness(): Record<ApiReadiness, HealthReading> {
  const lnaError = new TypeError("Failed to fetch", {
    cause: new Error("Request blocked by the Local Network Access (address space) policy"),
  });
  return {
    unknown: { ...INITIAL_HEALTH },
    ready: readinessFrom({ status: 200, body: { data: [{ id: MODEL }] } }, MODEL),
    unauthorized: readinessFrom(
      { status: 401, body: { error: { message: "Incorrect API key provided" } } },
      MODEL,
    ),
    unreachable: readinessFromFetchError(classifyFetchError(new TypeError("Failed to fetch")), MODEL),
    lna_blocked: readinessFromFetchError(classifyFetchError(lnaError), MODEL),
    misconfigured: { readiness: "misconfigured", model: null, cause: configProblem("not a url", MODEL) },
  };
}

describe("apiBlock", () => {
  test("every readiness value renders its own label, remediation and tone (msg().readiness)", () => {
    const all = everyReadiness();
    for (const [readiness, reading] of Object.entries(all) as Array<[ApiReadiness, HealthReading]>) {
      assert.equal(reading.readiness, readiness, `fixture for ${readiness}`);
      const block = apiBlock(reading, BASE_URL);
      assert.equal(block.title, msg().readiness[readiness].label, readiness);
      assert.equal(block.hint, msg().readiness[readiness].hint, readiness);
      assert.equal(block.tone, READINESS_TONE[readiness], readiness);
    }
    assert.deepEqual(READINESS_TONE, {
      unknown: "pending",
      ready: "ok",
      unauthorized: "error",
      unreachable: "error",
      lna_blocked: "error",
      misconfigured: "error",
    });
    assert.equal(apiBlock(all.unauthorized).hint, msg().errors["api.unauthorized"].hint);
    assert.equal(apiBlock(all.unreachable).hint, msg().errors["api.unreachable"].hint);
    assert.equal(apiBlock(all.lna_blocked).hint, msg().errors["api.lna_blocked"].hint);
    assert.match(apiBlock(all.lna_blocked).hint, /Local network access/);
    assert.equal(apiBlock(all.misconfigured).hint, msg().errors["api.config"].hint);
    assert.equal(apiBlock(all.ready).title, "AI endpoint ready", "English by default");
  });

  test("ready: endpoint and model lines, no cause and no warning", () => {
    const block = apiBlock(everyReadiness().ready, BASE_URL);
    assert.deepEqual(block.lines, [`Endpoint: ${BASE_URL}`, `Model: ${MODEL}`]);
    assert.deepEqual(block.lines, [msg().popup.endpoint(BASE_URL), msg().popup.model(MODEL)]);
    assert.deepEqual(block.warnings, []);
  });

  test("ready with a cause (model not listed, no /models route): the cause is a warning, not a fact", () => {
    const unlisted = readinessFrom({ status: 200, body: { data: [{ id: "other" }] } }, MODEL);
    const block = apiBlock(unlisted, BASE_URL);
    assert.equal(block.tone, "ok");
    assert.deepEqual(block.lines, [msg().popup.endpoint(BASE_URL), msg().popup.model(MODEL)]);
    assert.deepEqual(block.warnings, [msg().popup.cause(`model "${MODEL}" is not listed by the server`)]);
    const noRoute = apiBlock(readinessFrom({ status: 404, body: null }, MODEL), BASE_URL);
    assert.deepEqual(noRoute.warnings, ["Details: the server has no /models route"]);
  });

  test("not ready: the cause is the last fact line", () => {
    const all = everyReadiness();
    const unauthorized = apiBlock(all.unauthorized, BASE_URL);
    assert.deepEqual(unauthorized.lines, [
      msg().popup.endpoint(BASE_URL),
      msg().popup.model(MODEL),
      msg().popup.cause("Incorrect API key provided"),
    ]);
    assert.deepEqual(unauthorized.warnings, []);
    assert.equal(apiBlock(all.unreachable, BASE_URL).lines.at(-1), msg().popup.cause("Failed to fetch"));
    const misconfigured = apiBlock(all.misconfigured, "not a url");
    assert.deepEqual(misconfigured.lines, [
      msg().popup.endpoint("not a url"),
      msg().popup.cause("invalid base URL"),
    ]);
  });

  test("no endpoint line without a base URL; no model line without a model", () => {
    const reading: HealthReading = { readiness: "unreachable", model: null, cause: null };
    assert.deepEqual(apiBlock(reading).lines, []);
    assert.deepEqual(apiBlock(reading, null).lines, []);
    assert.deepEqual(apiBlock(reading, "").lines, []);
    assert.deepEqual(apiBlock(reading, BASE_URL).lines, [msg().popup.endpoint(BASE_URL)]);
  });

  test("while GET /models is pending the block says so", () => {
    const block = apiBlock(null, BASE_URL);
    assert.deepEqual(block, {
      tone: "pending",
      title: msg().popup.checking,
      hint: "",
      lines: [],
      warnings: [],
    });
  });

  test("texts follow the UI locale (vi), then English again", () => {
    const reading = everyReadiness().unauthorized;
    const english = apiBlock(reading, BASE_URL);
    const vi = catalogFor("vi");
    try {
      setLocale("vi");
      const block = apiBlock(reading, BASE_URL);
      assert.equal(block.title, vi.readiness.unauthorized.label);
      assert.notEqual(block.title, english.title);
      assert.equal(block.hint, vi.readiness.unauthorized.hint);
      assert.deepEqual(block.lines, [
        vi.popup.endpoint(BASE_URL),
        vi.popup.model(MODEL),
        vi.popup.cause("Incorrect API key provided"),
      ]);
      assert.equal(apiBlock(null).title, vi.popup.checking);
    } finally {
      setLocale("en");
    }
    assert.deepEqual(apiBlock(reading, BASE_URL), english);
  });
});

describe("engineBlock and uploadsLine", () => {
  test("pending, stopped, unreadable", () => {
    assert.equal(engineBlock(null).title, msg().popup.checking);
    assert.equal(engineBlock(null).tone, "pending");
    const stopped = engineBlock({ exists: false, status: null });
    assert.deepEqual([stopped.tone, stopped.title], ["idle", msg().popup.engineStopped]);
    const unreadable = engineBlock({ exists: true, status: null });
    assert.deepEqual([unreadable.tone, unreadable.title], ["warn", msg().popup.engineUnreadable]);
  });

  test("running: detector backend and canary, queue counts", () => {
    const status = statusFixture({
      detector: { backend: "wasm", state: "ready", canary: "fail" },
      queue: { ...statusFixture().queue, queued: 5, inFlight: 2, done: 9, failed: 1 },
    });
    const block = engineBlock({ exists: true, status });
    assert.equal(block.tone, "ok");
    assert.equal(block.title, "Engine running");
    assert.equal(block.title, msg().enginePhase.ready);
    assert.deepEqual(block.lines, [
      "Text detection: CPU (WASM), ready (the GPU gave inconsistent results, switched to the CPU)",
      "Queue: 5 waiting · 2 sending · 9 done · 1 failed",
    ]);
    const skipped = engineBlock({
      exists: true,
      status: statusFixture({ detector: { backend: "webgpu", state: "loading", canary: "skipped" } }),
    });
    assert.equal(
      skipped.lines[0],
      "Text detection: GPU (WebGPU), loading",
      "no parentheses without a canary",
    );
  });

  test("paused: the reason first, with its remediation as the hint", () => {
    const status: EngineStatus = statusFixture({
      queue: { ...statusFixture().queue, pausedBy: "api.unauthorized" },
    });
    const block = engineBlock({ exists: true, status });
    assert.equal(block.tone, "warn");
    assert.equal(block.lines[0], msg().popup.pausedBy(msg().errors["api.unauthorized"].title));
    assert.equal(block.lines[0], "Paused: The AI endpoint rejected the API key");
    assert.equal(block.hint, msg().errors["api.unauthorized"].hint);
    assert.equal(engineBlock({ exists: true, status: statusFixture({ phase: "failed" }) }).tone, "error");
    assert.equal(engineBlock({ exists: true, status: statusFixture({ phase: "booting" }) }).tone, "pending");
  });

  test("uploads line only with an engine status", () => {
    assert.equal(uploadsLine(null), null);
    const line = uploadsLine(statusFixture({ uploads: { today: 12, bytesToday: 3.5 * 1024 * 1024 } }));
    assert.equal(line, "Sent 12 composite images (3.5 MB) to the AI today");
    assert.equal(
      uploadsLine(statusFixture({ uploads: { today: 1, bytesToday: 0 } })),
      msg().ui.uploadsToday(1, 0),
    );
  });

  test("engine texts follow the UI locale (vi), then English again", () => {
    const status = statusFixture({ uploads: { today: 2, bytesToday: 1024 * 1024 } });
    const vi = catalogFor("vi");
    try {
      setLocale("vi");
      assert.equal(engineBlock({ exists: true, status }).title, vi.enginePhase.ready);
      assert.equal(engineBlock({ exists: false, status: null }).title, vi.popup.engineStopped);
      assert.equal(uploadsLine(status), vi.ui.uploadsToday(2, 1));
      assert.notEqual(uploadsLine(status), "Sent 2 composite images (1.0 MB) to the AI today");
    } finally {
      setLocale("en");
    }
    assert.equal(uploadsLine(status), "Sent 2 composite images (1.0 MB) to the AI today");
  });
});

test("errorTitle: the msg().errors title of a CtvError; anything else is engine.internal", () => {
  assert.equal(errorTitle(new CtvError("api.unreachable", "down")), msg().errors["api.unreachable"].title);
  assert.equal(
    errorTitle(new CtvError("api.config", "no model")),
    "The AI endpoint or model is misconfigured",
  );
  assert.equal(errorTitle(new Error("boom")), msg().errors["engine.internal"].title);
  assert.equal(errorTitle("plain"), msg().errors["engine.internal"].title);
});
