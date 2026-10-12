import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import {
  chatCompletionsUrl,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUTS,
  defaultDeps,
  requestBody,
  requestHeaders,
  streamChat,
  TEST_UNITS_HEADER,
  type ApiClientDeps,
  type StreamChatOptions,
  type StreamChatResult,
  type TransportInit,
  type TransportResponse,
} from "../../../src/engine/api-client.ts";
import { createAccountant } from "../../../src/shared/core/id-accounting.ts";
import { createLineParser } from "../../../src/shared/core/line-parser.ts";
import type { ChatMessage } from "../../../src/shared/core/prompt.ts";
import { CtvError, type ErrorCode } from "../../../src/shared/errors.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";

// ---- Fakes: clock, transport, body stream ----

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class FakeClock {
  t = 0;
  private seq = 0;
  private readonly timers: Array<{ at: number; seq: number; fn: () => void; live: boolean }> = [];

  readonly now = (): number => this.t;

  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, seq: this.seq, fn, live: true };
    this.seq += 1;
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  live(): number {
    return this.timers.filter((timer) => timer.live).length;
  }

  /** Moves time forward, firing due timers in order and letting promises settle in between. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const due = this.timers
        .filter((timer) => timer.live && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) {
        break;
      }
      this.t = due.at;
      due.live = false;
      due.fn();
    }
    this.t = target;
    await flush();
  }
}

interface ControlledBody {
  stream: ReadableStream<Uint8Array>;
  push(chunk: string | Uint8Array): void;
  close(): void;
  fail(error: unknown): void;
  readonly cancelled: boolean;
}

function controlledBody(): ControlledBody {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const encoder = new TextEncoder();
  const ctl = (): ReadableStreamDefaultController<Uint8Array> => {
    assert.ok(controller !== null);
    return controller;
  };
  return {
    stream,
    push: (chunk) => ctl().enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk),
    close: () => ctl().close(),
    fail: (error) => ctl().error(error),
    get cancelled() {
      return cancelled;
    },
  };
}

function bodyOf(chunks: ReadonlyArray<string | Uint8Array>): ReadableStream<Uint8Array> {
  const body = controlledBody();
  for (const chunk of chunks) {
    body.push(chunk);
  }
  body.close();
  return body.stream;
}

function response(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = { "content-type": "text/event-stream" },
  text = "",
): TransportResponse {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    body,
    text: () => Promise.resolve(text),
  };
}

function jsonError(status: number, error: Record<string, unknown>): TransportResponse {
  return response(
    status,
    null,
    { "content-type": "application/json; charset=utf-8" },
    JSON.stringify({ error }),
  );
}

interface Harness {
  clock: FakeClock;
  deps: ApiClientDeps;
  calls: Array<{ url: string; init: TransportInit }>;
}

function harness(respond: (init: TransportInit) => Promise<TransportResponse>): Harness {
  const clock = new FakeClock();
  const calls: Array<{ url: string; init: TransportInit }> = [];
  const deps: ApiClientDeps = {
    transport: (url, init) => {
      calls.push({ url, init });
      return respond(init);
    },
    now: clock.now,
    setTimer: clock.setTimer,
  };
  return { clock, deps, calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Tracks a promise without awaiting it (handles the rejection). */
function track<T>(promise: Promise<T>): { readonly settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

async function rejectsWith(promise: Promise<unknown>, code: ErrorCode, detail?: string): Promise<CtvError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof CtvError, `expected a CtvError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  if (detail !== undefined) {
    assert.equal(caught.detail, detail);
  }
  return caught;
}

// ---- OpenAI-shaped SSE chunks (chat.completion.chunk); sentences and names are made up ----

const ENVELOPE = {
  id: "chatcmpl-1760000000000-a1b2c3d4e",
  object: "chat.completion.chunk",
  created: 1760000000,
  model: "gpt-4o-mini-2024-07-18",
};

function frame(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}
const ROLE = frame({
  ...ENVELOPE,
  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
});
const content = (text: string): string =>
  frame({ ...ENVELOPE, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const USAGE = frame({
  ...ENVELOPE,
  choices: [],
  usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 },
});
const FINISH = frame({ ...ENVELOPE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const DONE = frame("[DONE]");

const LINES = [
  "@lang|ko",
  "#1|dialogue|Zorvik|비가 와요|Trời mưa rồi.",
  "#2|thought||우산이 없어|Mình không có ô...",
  "#3|sfx||쾅|RẦM!",
];
const DELTAS = [
  "@lang|ko\n#1|dia",
  "logue|Zorvik|비가 와",
  "요|Trời mưa rồi.\n#2|thought||우산이 없어|Mình",
  " không có ô...\n#3|sfx||쾅|RẦM!",
];

function fullTranscript(): string {
  return ROLE + DELTAS.map(content).join("") + USAGE + FINISH + DONE;
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "system text" },
  {
    role: "user",
    content: [
      { type: "text", text: "[Task]" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
    ],
  },
];

function options(lines: string[], overrides: Partial<StreamChatOptions> = {}): StreamChatOptions {
  return {
    // Never a real provider: a real-socket test that forgets its own baseUrl fails instead of POSTing anywhere.
    baseUrl: "http://api.invalid/v1",
    model: "test-model",
    messages: MESSAGES,
    onLine: (line) => lines.push(line),
    ...overrides,
  };
}

// ---- Tests ----

describe("streamChat: request", () => {
  test("POST {baseUrl}/chat/completions with the Bearer key, model, temperature, stream:true, no-store, omit", async () => {
    const h = harness(() => Promise.resolve(response(200, bodyOf([fullTranscript()]))));
    await streamChat(
      options([], {
        baseUrl: "http://api.invalid/v1/",
        apiKey: "sk-test-123",
        model: "gpt-4o-mini",
        temperature: 0.2,
      }),
      h.deps,
    );
    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.url, "http://api.invalid/v1/chat/completions");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.credentials, "omit");
    assert.deepEqual(call.init.headers, {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer sk-test-123",
    });
    assert.deepEqual(JSON.parse(call.init.body), {
      model: "gpt-4o-mini",
      stream: true,
      messages: MESSAGES,
      temperature: 0.2,
    });
    assert.equal(call.init.signal.aborted, false, "a completed request is never aborted");
  });

  test("no API key: no Authorization header; a null temperature is left to the provider", async () => {
    const h = harness(() => Promise.resolve(response(200, bodyOf([fullTranscript()]))));
    await streamChat(options([], { apiKey: "", temperature: null, model: "llava:13b" }), h.deps);
    await streamChat(options([]), h.deps);
    for (const call of h.calls) {
      assert.equal(call.url, "http://api.invalid/v1/chat/completions");
      assert.deepEqual(call.init.headers, {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      });
      const body = JSON.parse(call.init.body) as Record<string, unknown>;
      assert.equal(Object.hasOwn(body, "temperature"), false);
    }
    assert.equal((JSON.parse(h.calls[0]?.init.body ?? "{}") as { model?: string }).model, "llava:13b");
    assert.equal((JSON.parse(h.calls[1]?.init.body ?? "{}") as { model?: string }).model, "test-model");
  });

  test("chatCompletionsUrl appends /chat/completions to the base URL, ignoring trailing slashes", () => {
    assert.equal(
      chatCompletionsUrl("https://api.openai.com/v1"),
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(
      chatCompletionsUrl("https://api.openai.com/v1/"),
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(
      chatCompletionsUrl("http://127.0.0.1:11434/v1///"),
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    assert.equal(
      chatCompletionsUrl("https://openrouter.ai/api/v1"),
      "https://openrouter.ai/api/v1/chat/completions",
    );
    assert.equal(DEFAULT_BASE_URL, DEFAULT_SETTINGS.api.baseUrl);
  });

  test("requestHeaders: Bearer only for a non-empty key (trimmed); x-ctv-test-units only when given", () => {
    const base = { "Content-Type": "application/json", Accept: "text/event-stream" };
    assert.deepEqual(requestHeaders(), base);
    assert.deepEqual(requestHeaders(""), base);
    assert.deepEqual(requestHeaders("   "), base, "a blank key counts as no key");
    assert.deepEqual(requestHeaders("sk-abc"), { ...base, Authorization: "Bearer sk-abc" });
    assert.deepEqual(requestHeaders("  sk-abc \n"), { ...base, Authorization: "Bearer sk-abc" });
    assert.equal(requestHeaders()[TEST_UNITS_HEADER], undefined);
    assert.equal(requestHeaders("", "")[TEST_UNITS_HEADER], undefined);
    assert.deepEqual(requestHeaders(undefined, "W3sibiI6MX1d"), {
      ...base,
      [TEST_UNITS_HEADER]: "W3sibiI6MX1d",
    });
    assert.deepEqual(requestHeaders("k", "W3sibiI6MX1d"), {
      ...base,
      Authorization: "Bearer k",
      [TEST_UNITS_HEADER]: "W3sibiI6MX1d",
    });
  });

  test("requestBody: the model verbatim, stream:true, temperature only when not null (0 included)", () => {
    const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(
      parse(requestBody({ model: "openai/gpt-4o-mini", temperature: null, messages: MESSAGES })),
      {
        model: "openai/gpt-4o-mini",
        stream: true,
        messages: MESSAGES,
      },
    );
    assert.deepEqual(parse(requestBody({ model: "m", messages: MESSAGES })), {
      model: "m",
      stream: true,
      messages: MESSAGES,
    });
    assert.deepEqual(parse(requestBody({ model: "m", temperature: 0, messages: [] })), {
      model: "m",
      stream: true,
      messages: [],
      temperature: 0,
    });
    assert.equal(parse(requestBody({ model: "m", temperature: 1.3, messages: [] }))["temperature"], 1.3);
  });

  test("the default watchdogs match the settings defaults", () => {
    assert.deepEqual({ ...DEFAULT_TIMEOUTS }, { firstByteMs: 180_000, idleMs: 60_000, totalMs: 600_000 });
    assert.equal(DEFAULT_TIMEOUTS.firstByteMs, DEFAULT_SETTINGS.api.firstByteTimeoutMs);
    assert.equal(DEFAULT_TIMEOUTS.idleMs, DEFAULT_SETTINGS.api.idleTimeoutMs);
    assert.equal(DEFAULT_TIMEOUTS.totalMs, DEFAULT_SETTINGS.api.totalTimeoutMs);
  });

  test("end to end through defaultDeps() with a fake global fetch: URL, headers and body", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, init });
      return Promise.resolve(
        new Response(fullTranscript(), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      );
    };
    try {
      const lines: string[] = [];
      const result = await streamChat(
        options(lines, {
          baseUrl: "https://llm.example.invalid/openai/v1/",
          apiKey: "sk-live-xyz",
          model: "gpt-5-mini",
          temperature: 0.4,
        }),
        defaultDeps(),
      );
      assert.deepEqual(lines, LINES);
      assert.equal(result.sawDone, true);
      assert.equal(seen.length, 1);
      const call = seen[0];
      assert.ok(call !== undefined);
      assert.equal(call.url, "https://llm.example.invalid/openai/v1/chat/completions");
      assert.equal(call.init?.method, "POST");
      assert.equal(call.init?.credentials, "omit");
      assert.deepEqual(call.init?.headers, {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: "Bearer sk-live-xyz",
      });
      const body = call.init?.body;
      assert.ok(typeof body === "string", "the body is a JSON string");
      assert.deepEqual(JSON.parse(body), {
        model: "gpt-5-mini",
        stream: true,
        messages: MESSAGES,
        temperature: 0.4,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("streamChat: streaming", () => {
  test("lines arrive progressively; [DONE] delivers the final unterminated line", async () => {
    const body = controlledBody();
    const h = harness(() => Promise.resolve(response(200, body.stream)));
    const lines: string[] = [];
    const deltas: string[] = [];
    const run = streamChat(options(lines, { onDelta: (text) => deltas.push(text) }), h.deps);
    await h.clock.advance(1_000);
    body.push(ROLE + content(DELTAS[0] ?? ""));
    await h.clock.advance(2_000);
    assert.deepEqual(lines, ["@lang|ko"], "first line before the stream ends");
    body.push(DELTAS.slice(1).map(content).join(""));
    await h.clock.advance(500);
    assert.deepEqual(lines, LINES.slice(0, 3), "the last line waits for its line break or [DONE]");
    body.push(USAGE + FINISH + DONE);
    const result = await run;
    assert.deepEqual(lines, LINES);
    assert.deepEqual(deltas, DELTAS);
    assert.equal(result.sawDone, true);
    assert.equal(result.truncated, false);
    assert.equal(result.tail, "");
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 });
    assert.equal(result.model, ENVELOPE.model);
    assert.equal(result.ttfbMs, 0);
    assert.equal(result.firstContentMs, 1_000);
    assert.equal(result.totalMs, 3_500);
    assert.equal(result.frames, 8);
    assert.equal(result.invalidFrames, 0);
    assert.equal(h.clock.live(), 0, "no timer left behind");
  });

  test("a body chunked every 3 bytes (split frames and UTF-8 sequences) gives the same lines", async () => {
    const bytes = new TextEncoder().encode(fullTranscript().replaceAll("\n", "\r\n"));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      chunks.push(bytes.slice(i, i + 3));
    }
    const h = harness(() => Promise.resolve(response(200, bodyOf(chunks))));
    const lines: string[] = [];
    const result = await streamChat(options(lines), h.deps);
    assert.deepEqual(lines, LINES);
    assert.equal(result.sawDone, true);
  });

  test("EOF without [DONE] → truncated; the unterminated tail is never delivered", async () => {
    const cut = [...DELTAS.slice(0, 3), " không có ô...\n#3|sfx||쾅|RẦ"];
    const transcript = ROLE + cut.map(content).join("");
    const h = harness(() => Promise.resolve(response(200, bodyOf([transcript]))));
    const lines: string[] = [];
    const result = await streamChat(options(lines), h.deps);
    assert.equal(result.sawDone, false);
    assert.equal(result.truncated, true);
    assert.deepEqual(lines, LINES.slice(0, 3));
    assert.equal(result.tail, "#3|sfx||쾅|RẦ");
  });

  test("[DONE] stops reading and releases the body", async () => {
    const body = controlledBody();
    const h = harness(() => Promise.resolve(response(200, body.stream)));
    const lines: string[] = [];
    const run = streamChat(options(lines), h.deps);
    body.push(ROLE + content("#1|dialogue||a|Một\n") + DONE + content("#2|dialogue||b|late\n"));
    const result = await run;
    await flush();
    assert.equal(result.sawDone, true);
    assert.deepEqual(lines, ["#1|dialogue||a|Một"]);
    assert.equal(body.cancelled, true);
  });

  test("a non-stream JSON completion counts as complete", async () => {
    const json = JSON.stringify({
      choices: [
        { message: { role: "assistant", content: "@lang|en\n#1|sign||EXIT|Lối ra" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const h = harness(() =>
      Promise.resolve(response(200, null, { "content-type": "application/json" }, json)),
    );
    const lines: string[] = [];
    const result = await streamChat(options(lines), h.deps);
    assert.deepEqual(lines, ["@lang|en", "#1|sign||EXIT|Lối ra"]);
    assert.equal(result.sawDone, true);
    assert.equal(result.truncated, false);
    assert.equal(result.finishReason, "stop");
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    const odd = harness(() =>
      Promise.resolve(response(200, null, { "content-type": "application/json" }, "{}")),
    );
    await rejectsWith(streamChat(options([]), odd.deps), "api.protocol");
  });

  test("end to end: stream → line parser → id accounting", async () => {
    const h = harness(() => Promise.resolve(response(200, bodyOf([fullTranscript()]))));
    const accountant = createAccountant(3, "ko");
    const parser = createLineParser((rec) => {
      accountant.accept(rec);
    });
    const result = await streamChat(options([], { onLine: (line) => parser.push(line) }), h.deps);
    parser.end();
    const outcome = accountant.finish(result.sawDone);
    assert.deepEqual(outcome.missing, []);
    assert.equal(outcome.idCoverage, 1);
    assert.equal(outcome.lang, "ko");
    const third = outcome.byId.get(3);
    assert.equal(third?.status === "ok" ? third.rec.translation : null, "RẦM!");
  });
});

describe("streamChat: watchdogs", () => {
  test("late headers: a 170 s wait for the response does not abort", async () => {
    const gate = deferred<TransportResponse>();
    const h = harness(() => gate.promise);
    const lines: string[] = [];
    const run = streamChat(options(lines), h.deps);
    const state = track(run);
    await h.clock.advance(170_000);
    assert.equal(state.settled, false);
    gate.resolve(response(200, bodyOf([fullTranscript()])));
    const result = await run;
    assert.equal(result.ttfbMs, 170_000);
    assert.deepEqual(lines, LINES);
    assert.equal(h.calls[0]?.init.signal.aborted, false);
  });

  test("first-byte watchdog: no response within 180 s → api.timeout, socket aborted", async () => {
    const h = harness(
      (init) =>
        new Promise<TransportResponse>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const run = streamChat(options([]), h.deps);
    const state = track(run);
    await h.clock.advance(179_999);
    assert.equal(state.settled, false);
    await h.clock.advance(1);
    const error = await rejectsWith(run, "api.timeout", "first_byte");
    assert.match(error.message, /within 180 s/u);
    assert.equal(error.retryable, true);
    assert.equal(h.calls[0]?.init.signal.aborted, true);
    assert.equal(h.clock.live(), 0);
  });

  test("first-byte watchdog fires even if the transport ignores the abort; a late response is released", async () => {
    const gate = deferred<TransportResponse>();
    const h = harness(() => gate.promise);
    const run = streamChat(options([]), h.deps);
    track(run);
    await h.clock.advance(190_000);
    await rejectsWith(run, "api.timeout", "first_byte");
    const late = controlledBody();
    gate.resolve(response(200, late.stream));
    await flush();
    assert.equal(late.cancelled, true);
  });

  test("idle watchdog: 60 s without a body chunk after the first byte", async () => {
    const body = controlledBody();
    const h = harness(() => Promise.resolve(response(200, body.stream)));
    const lines: string[] = [];
    const run = streamChat(options(lines), h.deps);
    const state = track(run);
    body.push(ROLE + content("#1|dialogue||a|Một\n"));
    await h.clock.advance(59_000);
    body.push(content("#2|dialogue||b|Hai\n"));
    await h.clock.advance(59_000);
    assert.equal(state.settled, false, "each chunk re-arms the idle watchdog");
    await h.clock.advance(1_000);
    const error = await rejectsWith(run, "api.timeout", "idle");
    assert.match(error.message, /idle for 60 s/u);
    assert.deepEqual(
      lines,
      ["#1|dialogue||a|Một", "#2|dialogue||b|Hai"],
      "lines before the stall stay delivered",
    );
    assert.equal(body.cancelled, true);
    assert.equal(h.calls[0]?.init.signal.aborted, true);
  });

  test("total watchdog: 600 s from send even while chunks keep arriving", async () => {
    const body = controlledBody();
    const h = harness(() => Promise.resolve(response(200, body.stream)));
    const run = streamChat(options([]), h.deps);
    const state = track(run);
    body.push(ROLE);
    for (let i = 0; i < 11; i += 1) {
      await h.clock.advance(50_000);
      body.push(content(`#${i + 1}|dialogue||x|Dòng ${i + 1}\n`));
    }
    assert.equal(state.settled, false);
    await h.clock.advance(50_000);
    await rejectsWith(run, "api.timeout", "total");
  });

  test("watchdogFactor 1.5 stretches the watchdogs (retry after a timeout)", async () => {
    const gate = deferred<TransportResponse>();
    const h = harness(() => gate.promise);
    const run = streamChat(options([], { watchdogFactor: 1.5 }), h.deps);
    const state = track(run);
    await h.clock.advance(260_000);
    assert.equal(state.settled, false);
    await h.clock.advance(10_000);
    await rejectsWith(run, "api.timeout", "first_byte");
    assert.equal(h.clock.t, 270_000);
  });

  test("custom timeouts are honoured", async () => {
    const body = controlledBody();
    const h = harness(() => Promise.resolve(response(200, body.stream)));
    const run = streamChat(options([], { idleTimeoutMs: 5_000 }), h.deps);
    track(run);
    body.push(ROLE);
    await h.clock.advance(5_000);
    await rejectsWith(run, "api.timeout", "idle");
  });
});

describe("streamChat: errors", () => {
  test("401 invalid_api_key → api.unauthorized with the provider code as detail", async () => {
    const h = harness(() =>
      Promise.resolve(
        jsonError(401, {
          message: "Incorrect API key provided: sk-test***.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        }),
      ),
    );
    const error = await rejectsWith(streamChat(options([]), h.deps), "api.unauthorized", "invalid_api_key");
    assert.equal(error.status, 401);
    assert.equal(error.message, "Incorrect API key provided: sk-test***.");
    assert.equal(error.retryable, true, "api.unauthorized resumes through health");
    assert.equal(h.clock.live(), 0);
  });

  test("HTTP statuses map to the api.* codes (OpenAI-shaped and plain error bodies)", async () => {
    const cases: Array<[TransportResponse, ErrorCode]> = [
      [
        jsonError(429, { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" }),
        "api.rate_limit",
      ],
      [
        jsonError(429, { message: "You exceeded your current quota", type: "insufficient_quota" }),
        "api.config",
      ],
      [jsonError(500, { message: "request entity too large", type: "internal_error" }), "api.too_large"],
      [response(413, null, {}, "Payload Too Large"), "api.too_large"],
      [jsonError(504, { message: "Upstream timed out", type: "timeout" }), "api.timeout"],
      [
        jsonError(400, {
          message: "This model's maximum context length is 128000 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        }),
        "api.context_length",
      ],
      [
        jsonError(400, {
          message: "Invalid content type. image_url is only supported by certain models.",
          type: "invalid_request_error",
        }),
        "api.config",
      ],
      [
        jsonError(404, {
          message: "The model `gpt-9` does not exist",
          type: "invalid_request_error",
          code: "model_not_found",
        }),
        "api.config",
      ],
      [
        jsonError(400, { message: "Unrecognized request argument", type: "invalid_request_error" }),
        "api.bad_request",
      ],
      [response(502, null, {}, "Bad Gateway"), "api.upstream"],
    ];
    for (const [res, code] of cases) {
      const h = harness(() => Promise.resolve(res));
      const error = await rejectsWith(streamChat(options([]), h.deps), code);
      assert.equal(error.status, res.status);
    }
  });

  test("a content filter inside nested provider details (error.metadata) → llm.refused (never retried)", async () => {
    // OpenRouter-style wrapper around an Azure content-filter answer.
    const h = harness(() =>
      Promise.resolve(
        jsonError(400, {
          message: "Provider returned error",
          code: 400,
          metadata: {
            provider_name: "Azure",
            raw: '{"error":{"code":"content_filter","message":"The request was blocked by the content management policy."}}',
          },
        }),
      ),
    );
    const error = await rejectsWith(streamChat(options([]), h.deps), "llm.refused");
    assert.equal(error.retryable, false);
    assert.equal(error.status, 400);
  });

  test("transport failures: TypeError → api.unreachable, LNA → api.lna_blocked (cause kept)", async () => {
    const network = new TypeError("Failed to fetch");
    const h1 = harness(() => Promise.reject(network));
    const unreachable = await rejectsWith(streamChat(options([]), h1.deps), "api.unreachable");
    assert.equal(unreachable.cause, network);
    assert.equal(h1.clock.live(), 0);
    const h2 = harness(() =>
      Promise.reject(
        new TypeError("Permission was denied for this request to access the loopback address space."),
      ),
    );
    await rejectsWith(streamChat(options([]), h2.deps), "api.lna_blocked");
  });

  test("a transport that throws synchronously is classified too", async () => {
    const h = harness(() => {
      throw new TypeError("Failed to fetch");
    });
    await rejectsWith(streamChat(options([]), h.deps), "api.unreachable");
    assert.equal(h.clock.live(), 0);
  });

  test("a network error while reading the body → api.unreachable after the lines already delivered", async () => {
    const body = controlledBody();
    const h = harness(() => Promise.resolve(response(200, body.stream)));
    const lines: string[] = [];
    const run = streamChat(options(lines), h.deps);
    track(run);
    body.push(ROLE + content("#1|dialogue||a|Một\n#2|dia"));
    await flush();
    body.fail(new TypeError("network error"));
    await rejectsWith(run, "api.unreachable");
    assert.deepEqual(lines, ["#1|dialogue||a|Một"]);
  });

  test("no content (role, usage, finish, [DONE]) → api.empty", async () => {
    const h = harness(() => Promise.resolve(response(200, bodyOf([ROLE + USAGE + FINISH + DONE]))));
    const error = await rejectsWith(streamChat(options([]), h.deps), "api.empty", "done");
    assert.equal(error.retryable, true);
    const blank = harness(() => Promise.resolve(response(200, bodyOf([ROLE + content(" \n \n") + DONE]))));
    await rejectsWith(streamChat(options([]), blank.deps), "api.empty");
    const noBody = harness(() => Promise.resolve(response(200, null)));
    await rejectsWith(streamChat(options([]), noBody.deps), "api.empty", "no_done");
    const silent = harness(() => Promise.resolve(response(200, bodyOf([]))));
    await rejectsWith(streamChat(options([]), silent.deps), "api.empty", "no_done");
  });

  test("a body that is not SSE → api.protocol", async () => {
    const h = harness(() =>
      Promise.resolve(
        response(200, bodyOf(["<html><body>proxy page</body></html>"]), { "content-type": "text/html" }),
      ),
    );
    await rejectsWith(streamChat(options([]), h.deps), "api.protocol");
  });

  test("an in-stream error frame → api.upstream; a content filter → llm.refused", async () => {
    const errorFrame = frame({
      error: { message: "upstream failed", type: "upstream_error", code: "upstream_sse_error" },
    });
    const body = controlledBody();
    const h = harness(() => Promise.resolve(response(200, body.stream)));
    const lines: string[] = [];
    const run = streamChat(options(lines), h.deps);
    track(run);
    // A content frame behind the error frame in the same chunk is not delivered.
    body.push(ROLE + content("#1|dialogue||a|Một\n") + errorFrame + content("#2|dialogue||b|Hai\n"));
    const error = await rejectsWith(run, "api.upstream", "upstream_sse_error");
    assert.equal(error.retryable, true);
    assert.deepEqual(lines, ["#1|dialogue||a|Một"]);
    await flush();
    assert.equal(body.cancelled, true, "the rest of the body is discarded");
    assert.equal(h.calls[0]?.init.signal.aborted, false, "only a watchdog aborts the request");

    const filtered = frame({
      error: { message: "Blocked by ResponsibleAIPolicyViolation", type: "upstream_error" },
    });
    const h2 = harness(() => Promise.resolve(response(200, bodyOf([ROLE + filtered]))));
    const refused = await rejectsWith(streamChat(options([]), h2.deps), "llm.refused");
    assert.equal(refused.retryable, false);
  });

  test("an exception in onLine propagates and leaves no timer behind", async () => {
    const h = harness(() => Promise.resolve(response(200, bodyOf([fullTranscript()]))));
    const run: Promise<StreamChatResult> = streamChat(
      options([], {
        onLine: () => {
          throw new Error("consumer bug");
        },
      }),
      h.deps,
    );
    await assert.rejects(run, /consumer bug/u);
    assert.equal(h.clock.live(), 0);
    assert.equal(h.calls[0]?.init.signal.aborted, false);
  });
});

// ---- defaultDeps(): real fetch, clock and timers against a local server on an ephemeral port ----

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function shutdown(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("streamChat: defaultDeps over a real socket", () => {
  test("Node fetch streams an OpenAI-shaped SSE body; headers and body reach the server", async () => {
    const seen: { headers: IncomingMessage["headers"]; body: string; method: string; url: string }[] = [];
    const { server, baseUrl } = await listen((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({ headers: req.headers, body, method: req.method ?? "", url: req.url ?? "" });
        // Like a proxy that flushes late: headers and the role chunk go out with the first text chunk, LF-only frames.
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write(ROLE + content(DELTAS[0] ?? ""));
        for (const delta of DELTAS.slice(1)) {
          res.write(content(delta));
        }
        res.end(USAGE + FINISH + DONE);
      });
    });
    try {
      const lines: string[] = [];
      const result = await streamChat(
        options(lines, { baseUrl: `${baseUrl}/v1`, apiKey: "sk-local", model: "local-vision" }),
        defaultDeps(),
      );
      assert.deepEqual(lines, LINES);
      assert.equal(result.sawDone, true);
      assert.equal(result.model, ENVELOPE.model);
      assert.ok(result.totalMs >= result.ttfbMs && result.ttfbMs >= 0);
      const request = seen[0];
      assert.ok(request !== undefined);
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers["accept"], "text/event-stream");
      assert.equal(request.headers["authorization"], "Bearer sk-local");
      assert.deepEqual(JSON.parse(request.body), {
        model: "local-vision",
        stream: true,
        messages: MESSAGES,
      });
    } finally {
      await shutdown(server);
    }
  });

  test("a stalled stream: the idle watchdog fires with real timers and the abort frees the socket", async () => {
    let socketClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      socketClosed = resolve;
    });
    const { server, baseUrl } = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(ROLE + content("#1|dialogue||a|Một\n")); // then nothing: a hung upstream
        res.on("close", () => socketClosed());
      });
    });
    try {
      const lines: string[] = [];
      const error = await rejectsWith(
        streamChat(options(lines, { baseUrl: `${baseUrl}/v1`, idleTimeoutMs: 150 }), defaultDeps()),
        "api.timeout",
        "idle",
      );
      assert.match(error.message, /idle/u);
      assert.deepEqual(lines, ["#1|dialogue||a|Một"]);
      await closed; // the client released the connection
    } finally {
      await shutdown(server);
    }
  });
});
