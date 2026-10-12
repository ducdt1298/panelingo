// The extension pages' own GET {baseUrl}/models (popup status, Options "Test connection"), always with a fake fetch:
// tests never reach a real AI endpoint.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import { endpointOf, fetchApiHealth, type ApiEndpoint } from "../../../src/ui/common/api-health.ts";

const ENDPOINT: ApiEndpoint = {
  baseUrl: "https://api.example.test/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  healthTimeoutMs: 1500,
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** A fetch that records its calls and answers with `respond()` (a Response, or a thrown error). */
function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: urlOf(input), init });
    try {
      return Promise.resolve(respond());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { fetch: fetchFn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

const LISTED = { object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] };

describe("fetchApiHealth: the request", () => {
  test("GET {baseUrl}/models, uncached, without cookies, with a timeout signal and no key header", async () => {
    const fake = fakeFetch(() => json(200, LISTED));
    await fetchApiHealth(ENDPOINT, { fetch: fake.fetch });
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call?.url, "https://api.example.test/v1/models");
    assert.equal(call?.init?.method, "GET");
    assert.equal(call?.init?.cache, "no-store");
    assert.equal(call?.init?.credentials, "omit");
    assert.ok(call?.init?.signal instanceof AbortSignal, "AbortSignal.timeout(healthTimeoutMs)");
    assert.deepEqual(headersOf(call), {}, "no Authorization header without an API key");
  });

  test("Bearer header only with a (trimmed) API key; a blank key sends none", async () => {
    const fake = fakeFetch(() => json(200, LISTED));
    await fetchApiHealth({ ...ENDPOINT, apiKey: "  sk-test-123 " }, { fetch: fake.fetch });
    await fetchApiHealth({ ...ENDPOINT, apiKey: "   " }, { fetch: fake.fetch });
    assert.deepEqual(headersOf(fake.calls[0]), { Authorization: "Bearer sk-test-123" });
    assert.deepEqual(headersOf(fake.calls[1]), {});
  });

  test("trailing slashes of the base URL do not double the slash; the version path is kept", async () => {
    const fake = fakeFetch(() => json(200, LISTED));
    await fetchApiHealth({ ...ENDPOINT, baseUrl: "http://127.0.0.1:11434/v1//" }, { fetch: fake.fetch });
    await fetchApiHealth(
      { ...ENDPOINT, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
      { fetch: fake.fetch },
    );
    assert.deepEqual(
      fake.calls.map((call) => call.url),
      ["http://127.0.0.1:11434/v1/models", "https://generativelanguage.googleapis.com/v1beta/openai/models"],
    );
  });

  test("misconfigured settings make no request", async () => {
    const fake = fakeFetch(() => {
      throw new Error("must not be called");
    });
    const cases: Array<[Partial<ApiEndpoint>, string | null, string]> = [
      [{ model: "" }, null, "no model configured"],
      [{ model: "   " }, null, "no model configured"],
      [{ baseUrl: "not a url" }, "gpt-4o-mini", "invalid base URL"],
      [{ baseUrl: "" }, "gpt-4o-mini", "invalid base URL"],
      [{ baseUrl: "ftp://files.example.test/v1" }, "gpt-4o-mini", "the base URL must be http or https"],
    ];
    for (const [patch, model, cause] of cases) {
      const result = await fetchApiHealth({ ...ENDPOINT, ...patch }, { fetch: fake.fetch });
      assert.deepEqual(
        result,
        { reading: { readiness: "misconfigured", model, cause }, models: null },
        JSON.stringify(patch),
      );
    }
    assert.equal(fake.calls.length, 0);
  });
});

describe("fetchApiHealth: readiness from the answer", () => {
  test("200 listing the configured model → ready, no cause, with the model list", async () => {
    const result = await fetchApiHealth(ENDPOINT, { fetch: fakeFetch(() => json(200, LISTED)).fetch });
    assert.deepEqual(result, {
      reading: { readiness: "ready", model: "gpt-4o-mini", cause: null },
      models: ["gpt-4o", "gpt-4o-mini"],
    });
  });

  test("200 without the configured model → still ready, with a warning cause", async () => {
    const result = await fetchApiHealth(
      { ...ENDPOINT, model: "my-vision-model" },
      { fetch: fakeFetch(() => json(200, LISTED)).fetch },
    );
    assert.deepEqual(result, {
      reading: {
        readiness: "ready",
        model: "my-vision-model",
        cause: 'model "my-vision-model" is not listed by the server',
      },
      models: ["gpt-4o", "gpt-4o-mini"],
    });
  });

  test("200 with an empty list, a non-list body or a non-JSON body → ready without a list", async () => {
    const empty = await fetchApiHealth(ENDPOINT, {
      fetch: fakeFetch(() => json(200, { data: [] })).fetch,
    });
    assert.deepEqual([empty.reading.readiness, empty.reading.cause, empty.models], ["ready", null, []]);
    const odd = await fetchApiHealth(ENDPOINT, { fetch: fakeFetch(() => json(200, { ok: true })).fetch });
    assert.deepEqual([odd.reading.readiness, odd.reading.cause, odd.models], ["ready", null, null]);
    const text = await fetchApiHealth(ENDPOINT, {
      fetch: fakeFetch(() => new Response("OK", { status: 200 })).fetch,
    });
    assert.deepEqual([text.reading.readiness, text.reading.cause, text.models], ["ready", null, null]);
  });

  test("401 / 403 → unauthorized, with the server's message (or the status) as cause", async () => {
    const rejected = await fetchApiHealth(
      { ...ENDPOINT, apiKey: "sk-wrong" },
      { fetch: fakeFetch(() => json(401, { error: { message: "Incorrect API key provided" } })).fetch },
    );
    assert.deepEqual(rejected, {
      reading: { readiness: "unauthorized", model: "gpt-4o-mini", cause: "Incorrect API key provided" },
      models: null,
    });
    const forbidden = await fetchApiHealth(ENDPOINT, {
      fetch: fakeFetch(() => new Response("<html>denied</html>", { status: 403 })).fetch,
    });
    assert.deepEqual(
      [forbidden.reading.readiness, forbidden.reading.cause, forbidden.models],
      ["unauthorized", "HTTP 403", null],
    );
  });

  test("404 (no /models route) → ready with a cause; 429 → ready (rate limited)", async () => {
    for (const status of [404, 405, 501]) {
      const result = await fetchApiHealth(ENDPOINT, {
        fetch: fakeFetch(() => json(status, { error: "not found" })).fetch,
      });
      assert.deepEqual(
        result,
        {
          reading: { readiness: "ready", model: "gpt-4o-mini", cause: "the server has no /models route" },
          models: null,
        },
        String(status),
      );
    }
    const limited = await fetchApiHealth(ENDPOINT, { fetch: fakeFetch(() => json(429, {})).fetch });
    assert.deepEqual([limited.reading.readiness, limited.reading.cause], ["ready", "rate limited"]);
  });

  test("5xx → unreachable, with the server's message (or the status) as cause", async () => {
    const down = await fetchApiHealth(ENDPOINT, {
      fetch: fakeFetch(() => json(503, { error: { message: "model is loading" } })).fetch,
    });
    assert.deepEqual(down, {
      reading: { readiness: "unreachable", model: "gpt-4o-mini", cause: "model is loading" },
      models: null,
    });
    const gateway = await fetchApiHealth(ENDPOINT, {
      fetch: fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 })).fetch,
    });
    assert.deepEqual([gateway.reading.readiness, gateway.reading.cause], ["unreachable", "HTTP 502"]);
  });

  test("a fetch that throws → unreachable (timeout, refused) or lna_blocked (Chrome's local network block)", async () => {
    const throwing = (error: Error): typeof fetch =>
      fakeFetch(() => {
        throw error;
      }).fetch;
    const refused = await fetchApiHealth(ENDPOINT, { fetch: throwing(new TypeError("Failed to fetch")) });
    assert.deepEqual(refused, {
      reading: { readiness: "unreachable", model: "gpt-4o-mini", cause: "Failed to fetch" },
      models: null,
    });
    const timeout = await fetchApiHealth(ENDPOINT, {
      fetch: throwing(new DOMException("The operation timed out.", "TimeoutError")),
    });
    assert.deepEqual(
      [timeout.reading.readiness, timeout.reading.cause],
      ["unreachable", "The operation timed out."],
    );
    const lna = await fetchApiHealth(
      { ...ENDPOINT, baseUrl: "http://192.168.1.20:11434/v1" },
      {
        fetch: throwing(
          new TypeError("Failed to fetch", {
            cause: new Error("Request blocked by the Local Network Access (address space) policy"),
          }),
        ),
      },
    );
    assert.deepEqual([lna.reading.readiness, lna.models], ["lna_blocked", null]);
  });
});

test("endpointOf keeps only the endpoint fields of settings.api", () => {
  const api = { ...DEFAULT_SETTINGS.api, baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k", model: "m" };
  assert.deepEqual(endpointOf(api), {
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "k",
    model: "m",
    healthTimeoutMs: DEFAULT_SETTINGS.api.healthTimeoutMs,
  });
  assert.deepEqual(Object.keys(endpointOf(DEFAULT_SETTINGS.api)).sort(), [
    "apiKey",
    "baseUrl",
    "healthTimeoutMs",
    "model",
  ]);
});
