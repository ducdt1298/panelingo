import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyFetchError, classifyHttpError } from "../../../src/shared/core/api-errors.ts";
import { CtvError } from "../../../src/shared/errors.ts";

/** An OpenAI-style error body: {"error":{"message","type","code","param"}}. */
function openai(message: string, type: string | null = null, code: string | number | null = null): unknown {
  return { error: { message, type, code, param: null } };
}

describe("classifyHttpError: OpenAI-compatible error shapes", () => {
  const rows: Array<[string, number, unknown, string, boolean]> = [
    // [name, status, body, code, retryable]
    [
      "401 invalid_api_key",
      401,
      openai("Incorrect API key provided: sk-abc.", "invalid_request_error", "invalid_api_key"),
      "api.unauthorized",
      true,
    ],
    ["401 without a body", 401, null, "api.unauthorized", true],
    [
      "403 unsupported country",
      403,
      openai("Country, region, or territory not supported", "request_forbidden", "unsupported_country"),
      "api.unauthorized",
      true,
    ],
    [
      "429 rate_limit_exceeded",
      429,
      openai("Rate limit reached for gpt-4o-mini on requests per min.", "requests", "rate_limit_exceeded"),
      "api.rate_limit",
      true,
    ],
    [
      "429 insufficient_quota (billing, needs the user)",
      429,
      openai(
        "You exceeded your current quota, please check your plan and billing details.",
        "insufficient_quota",
        "insufficient_quota",
      ),
      "api.config",
      false,
    ],
    [
      "429 with insufficient_quota only as the type",
      429,
      openai("quota", "insufficient_quota", null),
      "api.config",
      false,
    ],
    [
      "400 context_length_exceeded",
      400,
      openai(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130211 tokens.",
        "invalid_request_error",
        "context_length_exceeded",
      ),
      "api.context_length",
      true,
    ],
    [
      "400 model_not_found code",
      400,
      openai("The requested model is unavailable.", "invalid_request_error", "model_not_found"),
      "api.config",
      false,
    ],
    [
      "400 image input on a text-only model",
      400,
      openai("Invalid content type. image_url is only supported by certain models.", "invalid_request_error"),
      "api.config",
      false,
    ],
    [
      "400 other invalid request",
      400,
      openai("Invalid value for 'temperature'.", "invalid_request_error", "invalid_value"),
      "api.bad_request",
      false,
    ],
    [
      "422 validation error without a message",
      422,
      { detail: [{ loc: ["body"] }] },
      "api.bad_request",
      false,
    ],
    [
      "404 model does not exist",
      404,
      openai(
        "The model `gpt-9` does not exist or you do not have access to it.",
        "invalid_request_error",
        "model_not_found",
      ),
      "api.config",
      false,
    ],
    ["404 wrong base URL (HTML page)", 404, "<html>Not Found</html>", "api.config", false],
    ["413 payload too large", 413, null, "api.too_large", true],
    ["408 request timeout", 408, null, "api.timeout", true],
    ["504 gateway timeout", 504, "<html>504 Gateway Time-out</html>", "api.timeout", true],
    [
      "500 server_error",
      500,
      openai("The server had an error while processing your request.", "server_error"),
      "api.upstream",
      true,
    ],
    ["502 bad gateway", 502, "<html>Bad Gateway</html>", "api.upstream", true],
    ["503 overloaded without a body", 503, null, "api.upstream", true],
    ["402 payment required", 402, openai("Payment required"), "api.config", false],
    ["409 other 4xx", 409, null, "api.bad_request", false],
    ["302 unexpected status", 302, null, "api.protocol", true],
  ];
  for (const [name, status, input, code, retryable] of rows) {
    test(name, () => {
      const info = classifyHttpError(status, input);
      assert.equal(info.code, code);
      assert.equal(info.retryable, retryable);
      assert.equal(info.status, status);
    });
  }
});

describe("classifyHttpError: context length variants", () => {
  test("every provider wording splits the request (api.context_length)", () => {
    const bodies: Array<[number, unknown]> = [
      // vLLM / LM Studio: a flat {"object":"error","message",...} body.
      [
        400,
        {
          object: "error",
          message: "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens.",
          type: "BadRequestError",
          code: 400,
        },
      ],
      // Anthropic-style wording behind an OpenAI-compatible gateway.
      [400, openai("prompt is too long: 210000 tokens > 200000 maximum", "invalid_request_error")],
      [400, openai("Input has too many tokens")],
      [422, { error: "context_length exceeded for this model" }],
      // Raw text body.
      [400, "maximum context length exceeded"],
    ];
    for (const [status, input] of bodies) {
      const info = classifyHttpError(status, input);
      assert.equal(info.code, "api.context_length", JSON.stringify(input));
      assert.equal(info.retryable, true);
    }
  });

  test("a context-length message that also says 'too large' is not an api.too_large", () => {
    const info = classifyHttpError(400, openai("Request too large: maximum context length is 8192 tokens"));
    assert.equal(info.code, "api.context_length");
  });
});

describe("classifyHttpError: content filters are refusals, never retried", () => {
  test("Azure OpenAI content_filter code and content management policy wording", () => {
    const azure = {
      error: {
        message:
          "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
        type: null,
        param: "prompt",
        code: "content_filter",
        status: 400,
        innererror: {
          code: "ResponsibleAIPolicyViolation",
          content_filter_result: { sexual: { filtered: true } },
        },
      },
    };
    for (const status of [400, 403, 500]) {
      const info = classifyHttpError(status, azure);
      assert.equal(info.code, "llm.refused", `status ${status}`);
      assert.equal(info.retryable, false);
      assert.equal(info.status, status);
    }
    assert.equal(classifyHttpError(400, JSON.stringify(azure)).code, "llm.refused", "raw JSON text too");
    assert.equal(classifyHttpError(401, openai("blocked", null, "content_filter")).code, "llm.refused");
  });

  test("a filter named only in nested provider metadata (OpenRouter metadata.raw, LiteLLM details)", () => {
    const routed = {
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: { raw: '{"error":{"code":"content_filter","message":"filtered"}}', provider_name: "Azure" },
      },
    };
    assert.equal(classifyHttpError(400, routed).code, "llm.refused");
    assert.equal(classifyHttpError(403, routed).code, "llm.refused", "also behind a 403");
    const details = { error: { message: "blocked", details: { reason: "ResponsibleAIPolicyViolation" } } };
    assert.equal(classifyHttpError(502, details).code, "llm.refused");
  });

  test("other nested metadata does not make a refusal", () => {
    const routed = { error: { message: "Provider returned error", code: 502, metadata: { raw: "boom" } } };
    assert.equal(classifyHttpError(502, routed).code, "api.upstream");
  });

  test("an OpenRouter moderation 403 is a refusal, not a rejected key", () => {
    const flagged = {
      error: {
        code: 403,
        message: 'openai/gpt-4o requires moderation on OpenAI. Your input was flagged for "violence".',
        metadata: { reasons: ["violence"], flagged_input: "…", provider_name: "OpenAI" },
      },
    };
    const info = classifyHttpError(403, flagged);
    assert.equal(info.code, "llm.refused");
    assert.equal(info.retryable, false);
  });

  test("Gemini safety blocks are refusals", () => {
    assert.equal(
      classifyHttpError(400, openai("Request blocked due to safety reasons (PROHIBITED_CONTENT).")).code,
      "llm.refused",
    );
  });
});

describe("classifyHttpError: billing and keys reported with other statuses", () => {
  test("402 payment required (OpenRouter credits) → api.config, waiting for the user", () => {
    const info = classifyHttpError(402, { error: { message: "Insufficient credits", code: 402 } });
    assert.equal(info.code, "api.config");
    assert.equal(info.retryable, false);
    assert.match(classifyHttpError(402, null).detail ?? "", /payment required/u);
  });

  test("Gemini's array-wrapped 400 for a bad key → api.unauthorized, with its status as the detail", () => {
    const gemini = [
      {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      },
    ];
    const info = classifyHttpError(400, gemini);
    assert.equal(info.code, "api.unauthorized");
    assert.equal(info.message, "API key not valid. Please pass a valid API key.");
    assert.equal(info.detail, "400");
    assert.equal(
      classifyHttpError(400, openai("invalid_api_key: the key has expired")).code,
      "api.unauthorized",
    );
    assert.equal(classifyHttpError(400, openai("Unexpected field 'foo'")).code, "api.bad_request");
  });
});

describe("classifyHttpError: too-large bodies", () => {
  test("413 always; other statuses when the message says the body is too large", () => {
    assert.equal(classifyHttpError(413, "<html>413 Request Entity Too Large</html>").code, "api.too_large");
    assert.equal(classifyHttpError(500, openai("request entity too large")).code, "api.too_large");
    assert.equal(
      classifyHttpError(400, { error: "Request body size exceeds the limit" }).code,
      "api.too_large",
    );
    assert.equal(classifyHttpError(502, "request entity too large").code, "api.too_large");
    assert.equal(classifyHttpError(500, openai("boom")).code, "api.upstream");
  });
});

describe("classifyHttpError: message and detail", () => {
  test("the message comes from error.message, a plain error string, message or detail", () => {
    assert.equal(classifyHttpError(500, openai("nested message")).message, "nested message");
    assert.equal(classifyHttpError(500, { error: "string error" }).message, "string error");
    assert.equal(classifyHttpError(500, { message: "flat message" }).message, "flat message");
    assert.equal(classifyHttpError(500, { detail: "FastAPI detail" }).message, "FastAPI detail");
    assert.equal(classifyHttpError(500, JSON.stringify({ error: "json text" })).message, "json text");
  });

  test("raw text is trimmed and capped at 500 characters; no usable body → the status", () => {
    assert.equal(classifyHttpError(502, "  <html>Bad Gateway</html>\n").message, "<html>Bad Gateway</html>");
    assert.equal(classifyHttpError(500, "x".repeat(800)).message.length, 500);
    assert.equal(classifyHttpError(500, openai("y".repeat(800))).message.length, 500);
    assert.equal(classifyHttpError(503, "").message, "HTTP 503");
    assert.equal(classifyHttpError(503, null).message, "HTTP 503");
    assert.equal(classifyHttpError(503, [1, 2]).message, "HTTP 503");
  });

  test("detail carries the provider's code, else its type, else nothing", () => {
    const key = classifyHttpError(401, openai("bad key", "invalid_request_error", "invalid_api_key"));
    assert.equal(key.detail, "invalid_api_key");
    assert.equal(classifyHttpError(500, openai("boom", "server_error")).detail, "server_error");
    assert.equal(classifyHttpError(500, openai("boom")).detail, undefined);
    assert.equal(
      classifyHttpError(400, { error: { message: "x", code: 400 } }).detail,
      "400",
      "numeric code",
    );
  });

  test("a text-only model gets a readable detail; 404 without a code points at the URL and model", () => {
    const vision = classifyHttpError(
      400,
      openai("This model does not support image input", "invalid_request_error"),
    );
    assert.equal(vision.code, "api.config");
    assert.equal(vision.detail, "model without image input");
    const notFound = classifyHttpError(404, { error: 'model "llava" not found, try pulling it first' });
    assert.equal(notFound.code, "api.config");
    assert.equal(notFound.detail, "not found: check the base URL and the model");
    assert.equal(notFound.message, 'model "llava" not found, try pulling it first');
  });

  test("plain {error: string} bodies (Ollama, LM Studio) naming an unknown model → api.config", () => {
    assert.equal(classifyHttpError(400, { error: "model 'foo' not found" }).code, "api.config");
    assert.equal(classifyHttpError(400, { error: "invalid model name" }).code, "api.config");
    assert.equal(classifyHttpError(400, { error: "no such model: foo" }).code, "api.config");
  });
});

describe("classifyFetchError", () => {
  test("fetch TypeError → api.unreachable", () => {
    const info = classifyFetchError(new TypeError("Failed to fetch"));
    assert.equal(info.code, "api.unreachable");
    assert.equal(info.retryable, true);
    assert.equal(info.status, undefined);
  });

  test("Node fetch failure with an ECONNREFUSED cause → api.unreachable", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
    assert.equal(classifyFetchError(new TypeError("fetch failed", { cause })).code, "api.unreachable");
  });

  test("Local Network Access blocks → api.lna_blocked (needs the user)", () => {
    for (const message of [
      "Permission was denied for this request to access the `loopback` address space.",
      "Request blocked by Local Network Access",
      "private network access denied",
    ]) {
      const info = classifyFetchError(new TypeError(message));
      assert.equal(info.code, "api.lna_blocked", message);
      assert.equal(info.retryable, false);
    }
    const nested = new TypeError("Failed to fetch", { cause: new Error("unknown address space") });
    assert.equal(classifyFetchError(nested).code, "api.lna_blocked");
  });

  test("abort and timeout errors → api.timeout", () => {
    assert.equal(classifyFetchError(new DOMException("aborted", "AbortError")).code, "api.timeout");
    assert.equal(classifyFetchError(new DOMException("timed out", "TimeoutError")).code, "api.timeout");
  });

  test("a CtvError passes through; odd values still classify", () => {
    const error = new CtvError("api.timeout", "idle", { retryable: true, detail: "idle" });
    assert.deepEqual(classifyFetchError(error), error.toInfo());
    assert.equal(classifyFetchError("socket hang up").code, "api.unreachable");
    assert.equal(classifyFetchError("socket hang up").message, "socket hang up");
    assert.equal(classifyFetchError(undefined).message, "network error");
  });
});
