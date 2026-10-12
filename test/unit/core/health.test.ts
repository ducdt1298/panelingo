import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyFetchError } from "../../../src/shared/core/api-errors.ts";
import {
  configProblem,
  INITIAL_HEALTH,
  isSendable,
  listedModels,
  modelsUrl,
  readinessErrorCode,
  readinessFrom,
  readinessFromFetchError,
  type HealthAnswer,
  type HealthReading,
} from "../../../src/shared/core/health.ts";
import type { ApiReadiness } from "../../../src/shared/types.ts";

const MODEL = "gpt-4o-mini";

/** An OpenAI-style GET /models list. */
function list(...ids: string[]): unknown {
  return { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "system" })) };
}

function answer(status: number, body: unknown = null): HealthAnswer {
  return { status, body };
}

describe("modelsUrl", () => {
  test("appends /models to the base URL, ignoring trailing slashes", () => {
    assert.equal(modelsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
    assert.equal(modelsUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/models");
    assert.equal(modelsUrl("http://127.0.0.1:11434/v1//"), "http://127.0.0.1:11434/v1/models");
    assert.equal(
      modelsUrl("https://openrouter.ai/api/v1"),
      "https://openrouter.ai/api/v1/models",
      "a deeper version path is kept",
    );
  });
});

describe("configProblem", () => {
  test("a valid http(s) base URL and a model → no problem", () => {
    assert.equal(configProblem("https://api.openai.com/v1", MODEL), null);
    assert.equal(configProblem("http://127.0.0.1:1234/v1", "qwen2.5-vl"), null);
  });

  test("an empty or blank model is reported first", () => {
    assert.equal(configProblem("https://api.openai.com/v1", ""), "no model configured");
    assert.equal(configProblem("https://api.openai.com/v1", "   "), "no model configured");
    assert.equal(configProblem("not a url", ""), "no model configured");
  });

  test("an unparsable base URL or a non-http(s) scheme", () => {
    assert.equal(configProblem("", MODEL), "invalid base URL");
    assert.equal(configProblem("api.openai.com/v1", MODEL), "invalid base URL");
    assert.equal(configProblem("ftp://example.com/v1", MODEL), "the base URL must be http or https");
    assert.equal(configProblem("file:///C:/models", MODEL), "the base URL must be http or https");
  });
});

describe("listedModels", () => {
  test("OpenAI { data: [{ id }] }", () => {
    assert.deepEqual(listedModels(list("gpt-4o", "gpt-4o-mini")), ["gpt-4o", "gpt-4o-mini"]);
  });

  test("{ models: [...] } with name/model keys (Ollama style) and plain arrays of strings", () => {
    assert.deepEqual(listedModels({ models: [{ name: "llava:13b" }, { model: "qwen2.5vl:7b" }] }), [
      "llava:13b",
      "qwen2.5vl:7b",
    ]);
    assert.deepEqual(listedModels(["a", "b"]), ["a", "b"]);
  });

  test("items without a string id are skipped; anything else is not a list", () => {
    assert.deepEqual(listedModels({ data: [{ id: 3 }, null, "x", { id: "y" }] }), ["x", "y"]);
    assert.deepEqual(listedModels({ data: [] }), []);
    assert.equal(listedModels(null), null);
    assert.equal(listedModels("<html>"), null);
    assert.equal(listedModels({ data: "nope" }), null);
    assert.equal(listedModels({ object: "list" }), null);
  });
});

describe("readinessFrom: GET /models answers", () => {
  function reading(status: number, body: unknown = null, model: string | null = MODEL): HealthReading {
    return readinessFrom(answer(status, body), model);
  }

  test("no answer → unreachable", () => {
    assert.deepEqual(readinessFrom(null, MODEL), { readiness: "unreachable", model: MODEL, cause: null });
  });

  test("200 listing the configured model → ready without a cause", () => {
    assert.deepEqual(reading(200, list("gpt-4o", MODEL)), { readiness: "ready", model: MODEL, cause: null });
    assert.equal(reading(204).readiness, "ready", "any 2xx");
  });

  test("200 not listing the configured model → still ready, with a warning cause", () => {
    const r = reading(200, list("gpt-4o", "o3"));
    assert.equal(r.readiness, "ready");
    assert.equal(r.cause, `model "${MODEL}" is not listed by the server`);
  });

  test("200 with an empty list, a non-list body or no model → ready without a cause", () => {
    assert.equal(reading(200, list()).cause, null, "an empty list proves nothing");
    assert.equal(reading(200, "<html>ok</html>").cause, null);
    assert.equal(reading(200, null).cause, null);
    assert.deepEqual(reading(200, list("o3"), null), { readiness: "ready", model: null, cause: null });
  });

  test("401 / 403 → unauthorized with the server's message", () => {
    const openai = reading(401, {
      error: {
        message: "Incorrect API key provided: sk-abc. You can find your API key at …",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    assert.equal(openai.readiness, "unauthorized");
    assert.match(openai.cause ?? "", /^Incorrect API key provided/u);
    assert.deepEqual(reading(403, { error: "Forbidden" }), {
      readiness: "unauthorized",
      model: MODEL,
      cause: "Forbidden",
    });
    assert.equal(reading(401, { message: "no key" }).cause, "no key");
    assert.equal(reading(403, null).cause, "HTTP 403", "no body → the status");
  });

  test("404 / 405 / 501 → ready: the server has no /models route", () => {
    for (const status of [404, 405, 501]) {
      assert.deepEqual(reading(status, { error: "Not Found" }), {
        readiness: "ready",
        model: MODEL,
        cause: "the server has no /models route",
      });
    }
  });

  test("429 → ready: reachable, requests back off on their own", () => {
    assert.deepEqual(reading(429, { error: { message: "Rate limit reached" } }), {
      readiness: "ready",
      model: MODEL,
      cause: "rate limited",
    });
  });

  test("5xx and other statuses → unreachable with the message or the status", () => {
    assert.deepEqual(reading(500, { error: { message: "The server had an error" } }), {
      readiness: "unreachable",
      model: MODEL,
      cause: "The server had an error",
    });
    assert.equal(reading(502, "<html>Bad Gateway</html>").cause, "HTTP 502");
    assert.equal(reading(503, null).readiness, "unreachable");
    assert.equal(reading(400, { error: { message: "bad" } }).readiness, "unreachable");
    assert.equal(reading(302).cause, "HTTP 302");
  });

  test("a 400 saying the key is invalid (Gemini's OpenAI mode, an array body) → unauthorized", () => {
    const gemini = [
      {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
        },
      },
    ];
    assert.deepEqual(reading(400, gemini), {
      readiness: "unauthorized",
      model: MODEL,
      cause: "API key not valid. Please pass a valid API key.",
    });
    assert.equal(reading(500, [{ error: { message: "Internal error" } }]).cause, "Internal error");
  });
});

describe("readinessFromFetchError", () => {
  test("tells a Chrome local network access block from an unreachable endpoint", () => {
    const lna = readinessFromFetchError(classifyFetchError(new TypeError("blocked: loopback address space")));
    assert.equal(lna.readiness, "lna_blocked");
    assert.equal(lna.model, null, "the model defaults to null");
    const down = readinessFromFetchError(classifyFetchError(new TypeError("Failed to fetch")), MODEL);
    assert.deepEqual(down, { readiness: "unreachable", model: MODEL, cause: "Failed to fetch" });
    const timeout = readinessFromFetchError(
      classifyFetchError(new DOMException("signal timed out", "TimeoutError")),
      MODEL,
    );
    assert.equal(timeout.readiness, "unreachable", "a timeout is unreachable, not misconfigured");
  });
});

describe("isSendable and readinessErrorCode", () => {
  const all: ApiReadiness[] = [
    "unknown",
    "ready",
    "unauthorized",
    "unreachable",
    "lna_blocked",
    "misconfigured",
  ];

  test("only ready may send", () => {
    assert.deepEqual(
      all.filter((r) => isSendable(r)),
      ["ready"],
    );
  });

  test("each paused state maps to the error code that pauses the queue", () => {
    assert.deepEqual(
      all.map((r) => readinessErrorCode(r)),
      [null, null, "api.unauthorized", "api.unreachable", "api.lna_blocked", "api.config"],
    );
  });

  test("INITIAL_HEALTH is a frozen unknown reading", () => {
    assert.deepEqual({ ...INITIAL_HEALTH }, { readiness: "unknown", model: null, cause: null });
    assert.ok(Object.isFrozen(INITIAL_HEALTH));
  });
});
