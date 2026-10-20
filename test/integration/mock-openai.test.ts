// Mock OpenAI-compatible server (tools/mock-openai): wire format, validation, routing, API key, scenarios, oracle
// mode, latency, bookkeeping, and the extension's own API client, error classifier and readiness check driven by it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultDeps, streamChat, type StreamChatOptions } from "../../src/engine/api-client.ts";
import { classifyHttpError } from "../../src/shared/core/api-errors.ts";
import { COMPACT_ITEM_LINE } from "../../src/shared/core/prompt.ts";
import { readinessFrom } from "../../src/shared/core/health.ts";
import { CtvError } from "../../src/shared/errors.ts";
import {
  COMPACT_REQUEST,
  compactLine,
  groundTruthCandidates,
  normalizeGroundTruth,
  oracleLine,
  oracleTranslation,
  oracleVi,
} from "../../tools/mock-openai/oracle.ts";
import { MockApiError, validateChatRequest } from "../../tools/mock-openai/request.ts";
import { placeholderLine, placeholderVi, splitCodePoints } from "../../tools/mock-openai/scenarios.ts";
import {
  createMockServer,
  encodeTestUnits,
  failureBody,
  FAILURES,
  HEALTH_PRESETS,
  healthResponse,
  sampleLatency,
  TEST_UNITS_HEADER,
  type FailSpec,
  type FailureName,
  type LatencyProfile,
  type MockServer,
  type RecordedRequest,
  type TestUnit,
} from "../../tools/mock-openai/server.ts";
import {
  buildUsage,
  estimatePromptTokens,
  estimateTokens,
  splitSseFrames,
} from "../../tools/mock-openai/wire.ts";

// A 1×1 PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = 70;
const MODEL = "test-vision-model";

type Json = Record<string, unknown>;

function chatBody(n: number, extra: Json = {}): Json {
  return {
    model: MODEL,
    stream: true,
    messages: [
      { role: "system", content: "Translate every numbered region." },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Task]\nThe attached image has N = ${n} numbered regions. Output @lang, then #1 to #${n}.`,
          },
          { type: "image_url", image_url: { url: PNG_DATA_URL, detail: "high" } },
        ],
      },
    ],
    ...extra,
  };
}

function textBody(content: unknown, extra: Json = {}): Json {
  return { model: MODEL, messages: [{ role: "user", content }], ...extra };
}

async function post(
  mock: MockServer,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${mock.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function jsonOf(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

/** SSE frames of a body: `data: …` payloads (JSON parsed, "[DONE]" kept as a string). */
function sseData(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => {
      assert.ok(frame.startsWith("data: "), `frame must start with "data: ": ${frame}`);
      const data = frame.slice(6);
      return data === "[DONE]" ? data : (JSON.parse(data) as unknown);
    });
}

function contentOf(frames: unknown[]): string {
  let text = "";
  for (const frame of frames) {
    const choices = (frame as { choices?: Array<{ delta?: { content?: string } }> }).choices;
    text += choices?.[0]?.delta?.content ?? "";
  }
  return text;
}

function lastRecord(mock: MockServer, path = "/v1/chat/completions"): RecordedRequest {
  const record = mock
    .requests()
    .filter((r) => r.path === path)
    .at(-1);
  assert.ok(record, `no recorded request for ${path}`);
  return record;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await sleep(10);
  }
}

async function settled(mock: MockServer): Promise<RecordedRequest> {
  await waitFor(() => mock.inFlight() === 0 && lastRecord(mock).outcome !== "pending");
  return lastRecord(mock);
}

function expectedError(spec: FailSpec): unknown {
  return failureBody(spec);
}

interface RawResponse {
  statusLine: string;
  status: number;
  /** Raw header lines in wire order. */
  headerLines: string[];
  headers: Map<string, string>;
  /** Chunked-encoding payloads in order (one per server write), or null for a Content-Length body. */
  chunks: Buffer[] | null;
  body: Buffer;
  /** ms from sending the request to the first response byte. */
  firstByteMs: number;
}

/** The response once `data` holds a complete HTTP message, else null. */
function parseRawResponse(
  data: Buffer,
  method: string,
  firstByteMs: number,
  ended: boolean,
): RawResponse | null {
  const headEnd = data.indexOf("\r\n\r\n");
  if (headEnd < 0) {
    return null;
  }
  const [statusLine = "", ...headerLines] = data.subarray(0, headEnd).toString("latin1").split("\r\n");
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  const status = Number(statusLine.split(" ")[1]);
  let rest = data.subarray(headEnd + 4);
  const response = { statusLine, status, headerLines, headers, firstByteMs };
  if (method === "HEAD" || status === 304 || status === 204) {
    return { ...response, chunks: null, body: Buffer.alloc(0) };
  }
  if (headers.get("transfer-encoding") === "chunked") {
    const chunks: Buffer[] = [];
    for (;;) {
      const lineEnd = rest.indexOf("\r\n");
      if (lineEnd < 0) {
        return null;
      }
      const size = parseInt(rest.subarray(0, lineEnd).toString("latin1"), 16);
      if (size === 0) {
        return rest.length >= lineEnd + 4 ? { ...response, chunks, body: Buffer.concat(chunks) } : null;
      }
      if (rest.length < lineEnd + 2 + size + 2) {
        return null;
      }
      chunks.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
      rest = rest.subarray(lineEnd + 2 + size + 2);
    }
  }
  const declared = headers.get("content-length");
  if (declared === undefined) {
    return ended ? { ...response, chunks: null, body: rest } : null;
  }
  const length = Number(declared);
  return rest.length >= length ? { ...response, chunks: null, body: rest.subarray(0, length) } : null;
}

/** HTTP/1.1 over a raw socket, so chunk boundaries and header order are visible. */
async function rawRequest(
  baseUrl: string,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  const body =
    options.body === undefined
      ? null
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body);
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${url.host}`, "Connection: close"];
  const headers = options.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  if (
    body !== null &&
    !Object.keys(headers).some((name) => /^(content-length|transfer-encoding)$/i.test(name))
  ) {
    lines.push(`Content-Length: ${body.length}`);
  }
  const started = performance.now();
  let firstByteMs = -1;
  // Read until the HTTP message is complete: SSE responses set "Connection: keep-alive" themselves, which makes
  // Node keep the socket open after the response even though this request asked to close it.
  return new Promise<RawResponse>((resolveResponse, rejectResponse) => {
    const socket = connect(Number(url.port), url.hostname);
    let data = Buffer.alloc(0);
    socket.on("data", (part: Buffer) => {
      if (firstByteMs < 0) {
        firstByteMs = performance.now() - started;
      }
      data = Buffer.concat([data, part]);
      const response = parseRawResponse(data, method, firstByteMs, false);
      if (response !== null) {
        socket.destroy();
        resolveResponse(response);
      }
    });
    socket.on("end", () => {
      const response = parseRawResponse(data, method, firstByteMs, true);
      if (response === null) {
        rejectResponse(new Error(`incomplete HTTP response: ${data.toString("latin1").slice(0, 200)}`));
      } else {
        resolveResponse(response);
      }
    });
    socket.on("error", rejectResponse);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
    if (body !== null) {
      socket.write(body);
    }
  });
}

/** Several requests, one after the other, on ONE keep-alive connection. */
async function rawKeepAlive(
  baseUrl: string,
  requests: ReadonlyArray<{ method: string; path: string; body?: string }>,
  timeoutMs = 3000,
): Promise<RawResponse[]> {
  const url = new URL(baseUrl);
  const socket = connect(Number(url.port), url.hostname);
  const responses: RawResponse[] = [];
  try {
    for (const request of requests) {
      const body = request.body === undefined ? null : Buffer.from(request.body);
      const label = `${request.method} ${request.path}`;
      const response = await new Promise<RawResponse>((resolveResponse, rejectResponse) => {
        const started = performance.now();
        let data = Buffer.alloc(0);
        const cleanup = (): void => {
          clearTimeout(timer);
          socket.off("data", onData);
          socket.off("close", onClose);
          socket.off("error", fail);
        };
        const fail = (error: Error): void => {
          cleanup();
          rejectResponse(error);
        };
        const onData = (part: Buffer): void => {
          data = Buffer.concat([data, part]);
          const parsed = parseRawResponse(data, request.method, performance.now() - started, false);
          if (parsed !== null) {
            cleanup();
            resolveResponse(parsed);
          }
        };
        const onClose = (): void => fail(new Error(`connection closed during ${label}`));
        const timer = setTimeout(
          () => fail(new Error(`no answer to ${label} in ${timeoutMs} ms`)),
          timeoutMs,
        );
        socket.on("data", onData);
        socket.on("close", onClose);
        socket.on("error", fail);
        const head = [
          `${label} HTTP/1.1`,
          `Host: ${url.host}`,
          "Connection: keep-alive",
          `Content-Length: ${body?.length ?? 0}`,
        ];
        socket.write(`${head.join("\r\n")}\r\n\r\n`, "latin1");
        if (body !== null) {
          socket.write(body);
        }
      });
      responses.push(response);
    }
  } finally {
    socket.destroy();
  }
  return responses;
}

/** Arrival times (ms since `start`) of the content frames and of [DONE] in an SSE body. */
async function sseTimeline(
  res: Response,
  start: number,
): Promise<{ contentAt: number[]; doneAt: number | null }> {
  assert.ok(res.body);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const contentAt: number[] = [];
  let doneAt: number | null = null;
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { contentAt, doneAt };
    }
    const now = performance.now() - start;
    buffer += decoder.decode(value, { stream: true });
    for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (frame === "data: [DONE]") {
        doneAt = now;
      } else if (/"delta":\{"content":"[^"]/.test(frame)) {
        contentAt.push(now);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

describe("wire format", () => {
  let mock: MockServer;
  before(async () => {
    mock = await createMockServer();
  });
  after(async () => {
    await mock.close();
  });
  afterEach(() => mock.reset());

  test("a stream is the role chunk, content chunks, the finish chunk and [DONE], one frame per write", async () => {
    mock.setScenario({ chunkChars: 10 });
    const res = await rawRequest(mock.url, "POST", "/v1/chat/completions", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody(2)),
    });
    assert.equal(res.statusLine, "HTTP/1.1 200 OK");
    assert.deepEqual(
      res.headerLines.filter((line) => !/^(date|transfer-encoding):/i.test(line)),
      ["Content-Type: text/event-stream; charset=utf-8", "Cache-Control: no-cache", "Connection: keep-alive"],
    );
    assert.equal(res.headers.get("transfer-encoding"), "chunked");
    const answer = ["@lang|ko", placeholderLine(1, "ko"), placeholderLine(2, "ko")].join("\n");
    const pieces = splitCodePoints(answer, 10);
    // Frames from the body: Node may merge writes made in the same tick into one HTTP chunk on a busy machine, so the
    // writes are counted on the server (framesWritten, below).
    const frames = sseData(res.body.toString("utf8")).map((frame) => [frame]);
    assert.equal(frames.length, 1 + pieces.length + 2, "role + content + finish + [DONE]");
    const role = frames[0]?.[0] as Json;
    const { id, created } = role;
    assert.match(String(id), /^chatcmpl-[0-9a-f]{32}$/);
    assert.equal(typeof created, "number");
    const envelope = { id, object: "chat.completion.chunk", created, model: MODEL };
    assert.deepEqual(role, {
      ...envelope,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    pieces.forEach((piece, i) => {
      assert.deepEqual(frames[i + 1]?.[0], {
        ...envelope,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      });
    });
    assert.deepEqual(frames.at(-2)?.[0], {
      ...envelope,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    assert.equal(frames.at(-1)?.[0], "[DONE]");
    assert.ok(res.body.toString("utf8").endsWith("data: [DONE]\n\n"));
    assert.ok(!res.body.toString("utf8").includes('"usage"'), "no usage chunk unless requested");

    const record = lastRecord(mock);
    assert.equal(record.outcome, "done");
    assert.equal(record.framesWritten, frames.length, "one frame per write");
    assert.equal(record.n, 2);
    assert.equal(record.model, MODEL);
    assert.equal(record.stream, true);
    assert.deepEqual(record.messageRoles, ["system", "user"]);
    assert.equal(record.systemText, "Translate every numbered region.");
    assert.equal(record.systemChars, record.systemText.length);
    assert.equal(record.imageCount, 1);
    assert.equal(record.imageBytes, PNG_BYTES);
    assert.deepEqual(record.images, [
      { messageIndex: 1, source: "data", mime: "image/png", bytes: PNG_BYTES, sniff: "png", detail: "high" },
    ]);
  });

  test("stream_options.include_usage adds a usage chunk (choices: []) between the finish chunk and [DONE]", async () => {
    const body = chatBody(2, { stream_options: { include_usage: true }, temperature: 0.3 });
    const frames = sseData(await (await post(mock, body)).text());
    const answer = ["@lang|ko", placeholderLine(1, "ko"), placeholderLine(2, "ko")].join("\n");
    const usageFrame = frames.at(-2) as Json;
    assert.deepEqual(usageFrame["choices"], []);
    assert.deepEqual(
      usageFrame["usage"],
      buildUsage(estimatePromptTokens(body["messages"] as unknown[], 1), estimateTokens(answer)),
    );
    assert.equal(
      (frames.at(-3) as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason,
      "stop",
    );
    assert.equal(frames.at(-1), "[DONE]");
    assert.equal(lastRecord(mock).temperature, 0.3);
  });

  test("headers go out after headersDelayMs; the first token follows firstChunkDelayMs later", async () => {
    mock.setScenario({ headersDelayMs: 150, firstChunkDelayMs: 300 });
    const started = performance.now();
    const res = await post(mock, chatBody(1));
    const headersAfter = performance.now() - started;
    assert.ok(headersAfter >= 150, `fetch() resolved after ${headersAfter} ms`);
    assert.ok(headersAfter < 400, `headers did not wait for the first token (${headersAfter} ms)`);
    const { contentAt, doneAt } = await sseTimeline(res, started);
    assert.ok((contentAt[0] ?? 0) >= 450, `first token after ${contentAt[0]} ms`);
    assert.ok(doneAt !== null);
    assert.ok((lastRecord(mock).headersAtMs ?? 0) >= 150);
  });

  test("lateHeaders holds the headers and the role chunk until the first content chunk", async () => {
    mock.setScenario({ lateHeaders: true, headersDelayMs: 100, firstChunkDelayMs: 200 });
    const started = performance.now();
    const res = await post(mock, chatBody(1));
    const resolvedAfter = performance.now() - started;
    assert.ok(resolvedAfter >= 300, `fetch() resolved after ${resolvedAfter} ms`);
    assert.equal(sseData(await res.text()).at(-1), "[DONE]");
    assert.ok((lastRecord(mock).headersAtMs ?? 0) >= 300);

    const raw = await rawRequest(mock.url, "POST", "/v1/chat/completions", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody(1)),
    });
    assert.ok(raw.firstByteMs >= 300, `first byte after ${raw.firstByteMs} ms`);
    assert.match(raw.chunks?.[0]?.toString("utf8") ?? "", /"delta":\{"role":"assistant","content":""\}/);
  });

  test("an empty answer gets the role chunk, the finish chunk and [DONE], after the delay", async () => {
    mock.setScenario({ empty: true, headersDelayMs: 100 });
    const started = performance.now();
    const res = await post(mock, chatBody(3, { stream_options: { include_usage: true } }));
    assert.ok(performance.now() - started >= 100);
    const frames = sseData(await res.text());
    assert.equal(frames.length, 4);
    assert.equal(contentOf(frames), "");
    assert.equal((frames[2] as { usage: { completion_tokens: number } }).usage.completion_tokens, 0);
    assert.equal(frames[3], "[DONE]");
  });

  test("dropAfterChunks ends the stream cleanly but early: no finish chunk, no usage, no [DONE]", async () => {
    mock.setScenario({ chunkChars: 8, dropAfterChunks: 2 });
    const res = await post(mock, chatBody(5, { stream_options: { include_usage: true } }));
    assert.equal(res.status, 200);
    const text = await res.text(); // a clean end of stream, not a network error
    const frames = sseData(text);
    assert.equal(frames.length, 3, "role + 2 content chunks");
    assert.ok(!text.includes("[DONE]"));
    assert.ok(!text.includes('"finish_reason":"stop"'));
    assert.ok(!text.includes('"usage"'));
    assert.equal(contentOf(frames), "@lang|ko\n#1|dialogue|".slice(0, 16));
    assert.equal(lastRecord(mock).outcome, "truncated");

    mock.setScenario({ chunkChars: 1000, dropAfterChunks: 5 });
    const all = sseData(await (await post(mock, chatBody(2))).text());
    assert.equal(all.length, 2, "every line arrived but the stream still ends without [DONE]");
    assert.equal(lastRecord(mock).outcome, "truncated");

    mock.setScenario({ dropAfterChunks: 0 });
    const none = await post(mock, chatBody(2));
    assert.equal(none.status, 200);
    assert.equal(sseData(await none.text()).length, 1, "headers and the role chunk, then the end");
  });

  test("with lateHeaders a stream that stops before any content becomes an HTTP error", async () => {
    mock.setScenario({ lateHeaders: true, dropAfterChunks: 0 });
    const res = await post(mock, chatBody(2));
    assert.equal(res.status, 502);
    assert.deepEqual(await jsonOf(res), expectedError(FAILURES.bad_gateway));
    mock.setScenario({ lateHeaders: true, dropAfterChunks: 0, errorFrame: "overloaded" });
    const overloaded = await post(mock, chatBody(2));
    assert.equal(overloaded.status, 503);
    assert.deepEqual(await jsonOf(overloaded), expectedError(FAILURES.overloaded));
    assert.equal(lastRecord(mock).errorCode, "service_unavailable");
  });

  test("errorFrame sends an in-stream error object where the stream stops, then ends without [DONE]", async () => {
    mock.setScenario({ chunkChars: 1000, errorFrame: "server_error" });
    const frames = sseData(await (await post(mock, chatBody(2))).text());
    assert.equal(frames.length, 3, "role, the whole answer, the error frame");
    assert.deepEqual(frames.at(-1), expectedError(FAILURES.server_error));
    assert.equal(lastRecord(mock).outcome, "stream-error");
    assert.equal(lastRecord(mock).errorCode, "server_error");

    mock.setScenario({
      chunkChars: 4,
      dropAfterChunks: 1,
      errorFrame: { status: 400, message: "filtered", code: "content_filter" },
    });
    const early = sseData(await (await post(mock, chatBody(2))).text());
    assert.deepEqual(early.at(-1), {
      error: { message: "filtered", type: "invalid_request_error", param: null, code: "content_filter" },
    });
    assert.equal(contentOf(early), "@lan");
  });

  test("resetAfterChunks destroys the connection: 0 before the response, k after k content chunks", async () => {
    mock.setScenario({ resetAfterChunks: 0, headersDelayMs: 50 });
    await assert.rejects(post(mock, chatBody(2)), TypeError);
    let record = await settled(mock);
    assert.equal(record.outcome, "reset");
    assert.equal(record.status, 0);
    assert.equal(record.clientAborted, false, "a reset is not a client abort");

    mock.setScenario({ resetAfterChunks: 2, chunkChars: 4 });
    const res = await post(mock, chatBody(2));
    assert.equal(res.status, 200);
    await assert.rejects(res.text(), TypeError);
    record = await settled(mock);
    assert.equal(record.outcome, "reset");
    assert.equal(record.framesWritten, 3, "role + 2 content chunks");
  });

  test("finishReason sets the finish chunk's reason", async () => {
    mock.setScenario({ finishReason: "length" });
    const frames = sseData(await (await post(mock, chatBody(1))).text());
    assert.equal(
      (frames.at(-2) as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason,
      "length",
    );
  });

  test("failBeforeHeaders answers each preset's OpenAI error body with its status", async () => {
    for (const [name, spec] of Object.entries(FAILURES) as Array<[string, FailSpec]>) {
      mock.setScenario({ name, failBeforeHeaders: spec });
      const res = await post(mock, chatBody(1));
      assert.equal(res.status, spec.status, name);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8", name);
      const body = (await jsonOf(res)) as { error: Json };
      assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "param", "type"], name);
      assert.deepEqual(body, expectedError(spec), name);
      const record = lastRecord(mock);
      assert.equal(record.outcome, "error");
      assert.equal(record.errorCode, spec.code ?? spec.type);
      assert.equal(record.scenarioName, name);
    }
    mock.setScenario({ failBeforeHeaders: "rate_limit", headersDelayMs: 120 });
    const started = performance.now();
    const res = await post(mock, chatBody(1));
    assert.ok(performance.now() - started >= 120);
    assert.equal(res.status, 429);
    assert.deepEqual(await jsonOf(res), {
      error: {
        message: "Rate limit reached for requests. Please try again in 2s.",
        type: "requests",
        param: null,
        code: "rate_limit_exceeded",
      },
    });
    mock.setScenario({ failBeforeHeaders: { status: 500, message: "x", body: { detail: "plain body" } } });
    const verbatim = await post(mock, chatBody(1));
    assert.equal(verbatim.status, 500);
    assert.deepEqual(await jsonOf(verbatim), { detail: "plain body" });
  });

  test("stream:false gets one chat.completion object with usage after the whole answer", async () => {
    mock.setScenario({ chunkDelayMs: 20, chunkChars: 30 });
    const started = performance.now();
    const res = await post(mock, chatBody(2, { stream: false }));
    assert.equal(res.status, 200);
    const body = (await jsonOf(res)) as Json;
    const answer = ["@lang|ko", placeholderLine(1, "ko"), placeholderLine(2, "ko")].join("\n");
    assert.ok(performance.now() - started >= 20 * (splitCodePoints(answer, 30).length - 1));
    const messages = chatBody(2)["messages"] as unknown[];
    assert.deepEqual(body, {
      id: body["id"],
      object: "chat.completion",
      created: body["created"],
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: buildUsage(estimatePromptTokens(messages, 1), estimateTokens(answer)),
    });
    mock.setScenario({ dropAfterChunks: 1 });
    const failed = await post(mock, chatBody(2, { stream: false }));
    assert.equal(failed.status, 502, "a mid-answer failure of a non-stream request is an HTTP error");
    await failed.text();
  });

  test("the response echoes the request model; /v1/models lists the configured one", async () => {
    const custom = await createMockServer({ model: "llava:13b" });
    try {
      const frames = sseData(await (await post(custom, chatBody(1, { model: "gpt-4o" }))).text());
      assert.ok(frames.slice(0, -1).every((f) => (f as Json)["model"] === "gpt-4o"));
      assert.equal(custom.model, "llava:13b");
      assert.equal(custom.baseUrl, `${custom.url}/v1`);
      assert.deepEqual(await jsonOf(await fetch(`${custom.baseUrl}/models`)), {
        object: "list",
        data: [{ id: "llava:13b", object: "model", created: 1_700_000_000, owned_by: "mock" }],
      });
      const one = await fetch(`${custom.baseUrl}/models/${encodeURIComponent("llava:13b")}`);
      assert.equal(one.status, 200);
      assert.equal(((await jsonOf(one)) as Json)["id"], "llava:13b");
      const other = await fetch(`${custom.baseUrl}/models/gpt-4o`);
      assert.equal(other.status, 404);
      assert.equal(((await jsonOf(other)) as { error: Json }).error["code"], "model_not_found");
    } finally {
      await custom.close();
    }
  });
});

describe("requests", () => {
  let mock: MockServer;
  before(async () => {
    mock = await createMockServer();
  });
  after(async () => {
    await mock.close();
  });
  afterEach(() => mock.reset());

  function withImage(url: string, role = "user"): Json {
    return { model: MODEL, messages: [{ role, content: [{ type: "image_url", image_url: { url } }] }] };
  }

  function errorOf(body: unknown): Json {
    return (body as { error: Json }).error;
  }

  test("images: data URLs of png/jpeg/gif/webp bytes, remote URLs recorded but never fetched", async () => {
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]).toString(
      "base64",
    );
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1").toString("base64");
    for (const url of [
      PNG_DATA_URL,
      "data:IMAGE/JPEG;base64,/9j/",
      `data:image/webp;base64,${webp}`,
      `data:image/gif;base64,${gif}`,
      "https://cdn.example.invalid/page-01.png",
    ]) {
      const res = await post(mock, withImage(url));
      assert.equal(res.status, 200, url.slice(0, 40));
      await res.text();
    }
    assert.deepEqual(
      mock.requests().map((r) => [r.images[0]?.source, r.images[0]?.mime, r.images[0]?.sniff]),
      [
        ["data", "image/png", "png"],
        ["data", "image/jpeg", "jpeg"],
        ["data", "image/webp", "webp"],
        ["data", "image/gif", "gif"],
        ["url", null, null],
      ],
    );
  });

  test("bad images get 400 with OpenAI codes", async () => {
    const cases: Array<[Json, string | null, RegExp]> = [
      [withImage("ftp://x.invalid/a.png"), "invalid_image_url", /http\(s\) URL or a base64 data URL/],
      [withImage("data:image/png;base64,@@@@"), "invalid_image_url", /Invalid base64/],
      [withImage("data:image/bmp;base64,Qk0AAA=="), "invalid_image_format", /unsupported image/],
      [withImage("data:image/png;base64,AAAA"), "invalid_image_format", /unsupported image/],
      [withImage(PNG_DATA_URL, "system"), "invalid_value", /only allowed for messages with role 'user'/],
    ];
    for (const [body, code, message] of cases) {
      const res = await post(mock, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      const error = errorOf(await jsonOf(res));
      assert.equal(error["type"], "invalid_request_error");
      assert.equal(error["code"], code);
      assert.match(String(error["message"]), message);
      assert.equal(lastRecord(mock).errorCode, code);
    }
  });

  test("other validation errors name the parameter", async () => {
    const cases: Array<[unknown, string | null, string | null]> = [
      [{ messages: [{ role: "user", content: "x" }] }, "missing_required_parameter", "model"],
      [{ model: 5, messages: [{ role: "user", content: "x" }] }, "invalid_type", "model"],
      [{ model: MODEL }, "missing_required_parameter", "messages"],
      [{ model: MODEL, messages: [] }, "invalid_value", "messages"],
      [textBody("x", { stream: "yes" }), "invalid_type", "stream"],
      [textBody("x", { temperature: 3 }), "invalid_value", "temperature"],
      [textBody("x", { n: 2 }), "unsupported_value", "n"],
      [{ model: MODEL, messages: [{ role: "robot", content: "x" }] }, "invalid_value", "messages[0].role"],
      [textBody(5), "invalid_type", "messages[0].content"],
      [textBody([{ type: "text" }]), "invalid_type", "messages[0].content[0].text"],
      [textBody(["plain"]), "invalid_type", "messages[0].content[0]"],
      [textBody([{ type: "input_audio" }]), "invalid_value", "messages[0].content[0].type"],
      [[], "invalid_type", null],
    ];
    for (const [body, code, param] of cases) {
      const res = await post(mock, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const error = errorOf(await jsonOf(res));
      assert.deepEqual([error["code"], error["param"]], [code, param], JSON.stringify(body));
    }
    assert.ok(new MockApiError("x") instanceof Error);
    assert.throws(() => validateChatRequest(null), MockApiError);
    assert.equal(
      validateChatRequest(textBody("hi", { stream_options: { include_usage: true } })).includeUsage,
      true,
    );
  });

  test("invalid or missing JSON is 400 invalid_request_error", async () => {
    const broken = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"messages": [',
    });
    assert.equal(broken.status, 400);
    assert.match(String(errorOf(await jsonOf(broken))["message"]), /could not parse the JSON body/);
    const empty = await fetch(`${mock.baseUrl}/chat/completions`, { method: "POST" });
    assert.equal(empty.status, 400);
    assert.match(String(errorOf(await jsonOf(empty))["message"]), /must be a JSON object/);
  });

  test("a client that gives up halfway through the body does not leave the request pending", async () => {
    const body = Buffer.from(JSON.stringify(chatBody(1)));
    const url = new URL(mock.url);
    const socket = connect(Number(url.port), url.hostname);
    socket.on("error", () => undefined);
    socket.write(
      `POST /v1/chat/completions HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\n\r\n`,
    );
    socket.write(body.subarray(0, body.length >> 1));
    await waitFor(() => mock.requests().some((r) => r.path === "/v1/chat/completions"));
    socket.destroy();
    const record = await settled(mock);
    assert.equal(record.clientAborted, true);
    assert.equal(record.outcome, "aborted");
  });

  test("bodies over maxBodyBytes get 413 request_too_large, after the whole body is read", async () => {
    const small = await createMockServer({ maxBodyBytes: 1000 });
    try {
      const [rejected, next] = await rawKeepAlive(small.url, [
        { method: "POST", path: "/v1/chat/completions", body: JSON.stringify(textBody("x".repeat(2000))) },
        { method: "GET", path: "/v1/models" },
      ]);
      assert.equal(rejected?.status, 413);
      const error = errorOf(JSON.parse(rejected?.body.toString("utf8") ?? "{}"));
      assert.equal(error["code"], "request_too_large");
      assert.equal(next?.status, 200, "the keep-alive connection still answers");
    } finally {
      await small.close();
    }
  });

  test("routing: OpenAI 404 for unknown routes, 405 for other methods, 204 OPTIONS without CORS, HEAD", async () => {
    const missing = await rawRequest(mock.url, "GET", "/v1/nothing-here?x=1");
    assert.equal(missing.status, 404);
    assert.deepEqual(JSON.parse(missing.body.toString("utf8")), {
      error: {
        message: "Invalid URL (GET /v1/nothing-here)",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });
    assert.equal((await rawRequest(mock.url, "GET", "/health")).status, 404);

    const wrongMethod = await rawRequest(mock.url, "GET", "/v1/chat/completions");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    assert.equal(errorOf(JSON.parse(wrongMethod.body.toString("utf8")))["code"], "method_not_allowed");

    const options = await rawRequest(mock.url, "OPTIONS", "/v1/chat/completions");
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("allow"), "POST");
    assert.equal(options.headers.get("access-control-allow-origin"), undefined, "no CORS");
    assert.equal((await rawRequest(mock.url, "OPTIONS", "/v1/models")).headers.get("allow"), "GET, HEAD");

    const get = await rawRequest(mock.url, "GET", "/v1/models/");
    const head = await rawRequest(mock.url, "HEAD", "/v1/models");
    assert.equal(get.status, 200);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), get.headers.get("content-length"));
    assert.equal(head.body.length, 0);
  });

  test("apiKey: /v1 routes need the matching Bearer token; control routes do not", async () => {
    const keyed = await createMockServer({ apiKey: "sk-mock-123" });
    try {
      const noKey = await post(keyed, chatBody(1));
      assert.equal(noKey.status, 401);
      assert.deepEqual(Object.keys(errorOf(await jsonOf(noKey))).sort(), [
        "code",
        "message",
        "param",
        "type",
      ]);
      const wrong = await post(keyed, chatBody(1), { authorization: "Bearer sk-wrong" });
      assert.equal(wrong.status, 401);
      assert.deepEqual(errorOf(await jsonOf(wrong)), {
        message: "Incorrect API key provided.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      });
      assert.equal((await fetch(`${keyed.baseUrl}/models`)).status, 401);
      const ok = await post(keyed, chatBody(1), { authorization: "Bearer sk-mock-123" });
      assert.equal(ok.status, 200);
      await ok.text();
      const models = await fetch(`${keyed.baseUrl}/models`, {
        headers: { Authorization: "bearer sk-mock-123" },
      });
      assert.equal(models.status, 200);
      await models.text();
      assert.equal((await fetch(`${keyed.url}/__requests`)).status, 200);
      assert.deepEqual(
        keyed.requests().map((r) => [r.path, r.status, r.bearer, r.authorized]),
        [
          ["/v1/chat/completions", 401, false, false],
          ["/v1/chat/completions", 401, true, false],
          ["/v1/models", 401, false, false],
          ["/v1/chat/completions", 200, true, true],
          ["/v1/models", 200, true, true],
        ],
      );
      assert.ok(!JSON.stringify(keyed.requests()).includes("sk-mock-123"), "the token is never recorded");
    } finally {
      await keyed.close();
    }
  });

  test("setApiKey rotates the required key; reset() restores the configured one", async () => {
    const keyed = await createMockServer({ apiKey: "sk-mock-123" });
    try {
      const models = async (token: string): Promise<number> => {
        const res = await fetch(`${keyed.baseUrl}/models`, { headers: { Authorization: `Bearer ${token}` } });
        await res.text();
        return res.status;
      };
      keyed.setApiKey("sk-rotated");
      assert.equal(await models("sk-mock-123"), 401);
      assert.equal(await models("sk-rotated"), 200);
      keyed.setApiKey(undefined);
      assert.equal((await fetch(`${keyed.baseUrl}/models`)).status, 200);
      keyed.reset();
      assert.equal(await models("sk-rotated"), 401);
      assert.equal(await models("sk-mock-123"), 200);
    } finally {
      await keyed.close();
    }
  });
});

describe("answers", () => {
  let mock: MockServer;
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ctv-mock-replay-"));
    mock = await createMockServer({ replayDir: dir });
  });
  after(async () => {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => mock.reset());

  async function answerOf(body: unknown, headers: Record<string, string> = {}): Promise<string> {
    return contentOf(sseData(await (await post(mock, body, headers)).text()));
  }

  test("N comes from the last user text; ids 1..N get placeholder lines", async () => {
    const text = await answerOf(chatBody(3));
    assert.equal(
      text,
      ["@lang|ko", placeholderLine(1, "ko"), placeholderLine(2, "ko"), placeholderLine(3, "ko")].join("\n"),
    );
    assert.equal(placeholderLine(2, "ko"), `#2|dialogue||시험 문장 2|${placeholderVi(2)}`);
    mock.setScenario({ lang: "ja" });
    assert.equal(await answerOf(chatBody(1)), `@lang|ja\n#1|dialogue||テスト文 1|${placeholderVi(1)}`);
    mock.setScenario({ lang: "en" });
    assert.equal(await answerOf(textBody("Reply with exactly: @lang|en", { stream: true })), "@lang|en");
  });

  test("missing, duplicate and unknown ids, appended lines and CRLF line ends", async () => {
    mock.setScenario({
      missingIds: [2],
      duplicateIds: [3],
      unknownIds: [0, 9],
      appendLines: ["@term|보르킨|Borkin|tên riêng"],
      lineEnding: "\r\n",
    });
    const lines = (await answerOf(chatBody(3))).split("\r\n");
    assert.deepEqual(lines, [
      "@lang|ko",
      placeholderLine(1, "ko"),
      placeholderLine(3, "ko"),
      `${placeholderLine(3, "ko")} (bản lặp)`,
      placeholderLine(0, "ko"),
      placeholderLine(9, "ko"),
      "@term|보르킨|Borkin|tên riêng",
    ]);
  });

  test("refusal, garbage and verbatim text", async () => {
    mock.setScenario({ refusal: true });
    assert.equal(await answerOf(chatBody(2)), "I'm sorry, but I can't help with translating this image.");
    mock.setScenario({ refusal: "Xin lỗi, tôi không thể dịch nội dung này." });
    assert.equal(await answerOf(chatBody(2)), "Xin lỗi, tôi không thể dịch nội dung này.");
    mock.setScenario({ garbageOnly: true });
    const garbage = await answerOf(chatBody(2));
    assert.ok(garbage.split("\n").every((line) => !/^\s*(?:[-*>]\s*)?(?:assistant:\s*)?[#@]/i.test(line)));
    assert.ok(!/I'?m sorry|I can(?:not|'t) (?:help|assist|translate)|as an AI/i.test(garbage));
    const verbatim = "```\n#1|dialogue||A|B|C\r\n#2|sfx||쾅|RẦM";
    mock.setScenario({ text: verbatim, chunkChars: 3 });
    assert.equal(await answerOf(chatBody(2)), verbatim);
  });

  test("sequence steps apply to successive requests, then the base scenario", async () => {
    mock.setScenario({
      name: "retry-then-ok",
      sequence: [{ failBeforeHeaders: FAILURES.rate_limit }, { failBeforeHeaders: "timeout" }],
    });
    assert.equal((await post(mock, chatBody(1))).status, 429);
    assert.equal((await post(mock, chatBody(1))).status, 504);
    const ok = await post(mock, chatBody(1));
    assert.equal(ok.status, 200);
    await ok.text();
    const validationError = await post(mock, { model: MODEL, messages: [] });
    assert.equal(validationError.status, 400, "validation failures do not consume steps");
    mock.setScenario({ sequence: [{ failBeforeHeaders: FAILURES.rate_limit }] });
    assert.equal((await post(mock, chatBody(1))).status, 429, "setScenario restarts the sequence");
  });

  test("?scenario= overrides a single request", async () => {
    const query = encodeURIComponent(JSON.stringify({ failBeforeHeaders: "forbidden" }));
    const res = await fetch(`${mock.baseUrl}/chat/completions?scenario=${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody(1)),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await jsonOf(res), expectedError(FAILURES.forbidden));
    const bad = await fetch(
      `${mock.baseUrl}/chat/completions?scenario=${encodeURIComponent('{"headerDelayMs":1}')}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chatBody(1)),
      },
    );
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(await jsonOf(bad)), /unknown field \\"headerDelayMs\\"/);
  });

  test("a request rejected for a bad ?scenario= does not use up a sequence step", async () => {
    mock.setScenario({ sequence: [{ failBeforeHeaders: FAILURES.rate_limit }] });
    const bad = await fetch(`${mock.baseUrl}/chat/completions?scenario=${encodeURIComponent("{oops")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody(1)),
    });
    assert.equal(bad.status, 400);
    await bad.text();
    const first = await post(mock, chatBody(1));
    assert.equal(first.status, 429, "step 0 still applies to the next valid request");
    await first.text();
  });

  test("replay streams a recorded transcript byte for byte, one write per recorded frame", async () => {
    const frames = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5.2","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\r\n\r\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5.2","choices":[{"index":0,"delta":{"content":"@lang|ko\\n#1|sfx||쾅|RẦM"},"finish_reason":null}]}\r\n\r\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ];
    const bytes = Buffer.from(frames.join(""), "utf8");
    await writeFile(join(dir, "crlf.sse"), bytes);
    assert.equal(splitSseFrames(bytes).length, 4);
    mock.setScenario({ replayFile: "crlf.sse" });
    const res = await rawRequest(mock.url, "POST", "/v1/chat/completions", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody(1)),
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.ok(res.body.equals(bytes), "byte-exact");
    assert.deepEqual(
      splitSseFrames(res.body).map((frame) => Buffer.from(frame).toString("utf8")),
      frames,
      "the recorded frames, in order",
    );
    assert.equal(lastRecord(mock).outcome, "done");
    assert.equal(lastRecord(mock).framesWritten, 4);

    mock.setScenario({ replayFile: "crlf.sse", dropAfterChunks: 1 });
    const cut = await rawRequest(mock.url, "POST", "/v1/chat/completions", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody(1)),
    });
    // The role frame and one text frame, then a clean end (counted in the body and on the server, not by HTTP chunks).
    assert.equal(splitSseFrames(cut.body).length, 2);
    assert.equal(lastRecord(mock).framesWritten, 2);
    assert.equal(lastRecord(mock).outcome, "truncated");

    mock.setScenario({ replayFile: "crlf.sse" });
    const json = (await jsonOf(await post(mock, chatBody(1, { stream: false })))) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(json.choices[0]?.message.content, "@lang|ko\n#1|sfx||쾅|RẦM");
    assert.equal(json.model, MODEL);
    mock.setScenario({ replayFile: "crlf.sse", dropAfterChunks: 1 });
    assert.equal((await post(mock, chatBody(1, { stream: false }))).status, 502);

    mock.setScenario({ replayFile: "../outside.sse" });
    assert.equal((await post(mock, chatBody(1))).status, 500, "replay files stay inside replayDir");
  });

  test("replay timing and cuts: text frames are paced, cuts only ever fall after a text frame", async () => {
    const frame = (choices: string, extra = ""): string =>
      `data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":2,"model":"gpt-5.2","choices":${choices}${extra}}\n\n`;
    const role = frame('[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]');
    const content = (text: string): string =>
      frame(`[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":null}]`);
    const usage = frame("[]", ',"usage":{"prompt_tokens":1,"completion_tokens":9,"total_tokens":10}');
    const finish = frame('[{"index":0,"delta":{},"finish_reason":"stop"}]');
    const done = "data: [DONE]\n\n";
    const texts = ["@lang|ko\n", "#1|dialogue||보르킨|Borkin đây\n", "#2|sfx||쾅|RẦM"];
    await writeFile(join(dir, "three.sse"), role + texts.map(content).join("") + usage + finish + done);
    await writeFile(join(dir, "no-text.sse"), role + usage + finish + done);
    await writeFile(join(dir, "empty.sse"), "");

    mock.setScenario({
      replayFile: "three.sse",
      headersDelayMs: 100,
      firstChunkDelayMs: 100,
      chunkDelayMs: 200,
    });
    const started = performance.now();
    const res = await post(mock, chatBody(2));
    const headersAt = performance.now() - started;
    const { contentAt, doneAt } = await sseTimeline(res, started);
    const [first = 0, , last = 0] = contentAt;
    assert.ok(headersAt >= 100 && headersAt < 200, `headers after ${headersAt} ms`);
    assert.equal(contentAt.length, 3);
    assert.ok(first >= 200, `first text after ${first} ms`);
    assert.ok(last - first >= 390, `text frames spaced by chunkDelayMs (${last - first} ms)`);
    assert.ok(
      doneAt !== null && doneAt - last < 100,
      `[DONE] ${(doneAt ?? 0) - last} ms after the last text`,
    );

    const cut = async (scenario: Json, replayFile = "three.sse"): Promise<[number, string]> => {
      mock.setScenario({ replayFile, ...scenario });
      const r = await post(mock, chatBody(2));
      return [r.status, await r.text()];
    };
    assert.deepEqual(
      await cut({ dropAfterChunks: 0 }),
      [200, role],
      "eager headers: the role frame, then the end",
    );
    const [lateStatus, lateBody] = await cut({ dropAfterChunks: 0, lateHeaders: true });
    assert.equal(lateStatus, 502, "late headers: nothing was sent, so an HTTP error");
    assert.deepEqual(JSON.parse(lateBody), expectedError(FAILURES.bad_gateway));
    assert.deepEqual(await cut({ dropAfterChunks: 2 }), [
      200,
      role + texts.slice(0, 2).map(content).join(""),
    ]);
    assert.deepEqual(
      await cut({ dropAfterChunks: 9 }),
      [200, role + texts.map(content).join("")],
      "past the last text frame: still no usage, finish or [DONE]",
    );
    assert.equal(lastRecord(mock).outcome, "truncated");
    const [errorStatus, errorBodyText] = await cut({ errorFrame: "server_error" });
    assert.equal(errorStatus, 200);
    assert.equal(
      errorBodyText,
      role +
        texts.map(content).join("") +
        `data: ${JSON.stringify(expectedError(FAILURES.server_error))}\n\n`,
    );
    assert.equal(lastRecord(mock).outcome, "stream-error");
    assert.equal((await cut({ dropAfterChunks: 1, lateHeaders: true }, "no-text.sse"))[0], 502);
    assert.deepEqual(await cut({ lateHeaders: true }, "no-text.sse"), [200, role + usage + finish + done]);

    mock.setScenario({ replayFile: "empty.sse" });
    const empty = await post(mock, chatBody(1));
    assert.equal(empty.status, 500);
    assert.match(await empty.text(), /replay: the file is empty/);
  });
});

describe("oracle mode", () => {
  let mock: MockServer;
  let gtDir: string;
  // Original sentences with made-up canary words (Borkin, Zorvax); simple boxes only.
  const groundTruth = {
    schema: "comic-fixture/1",
    id: "page-a",
    lang: "ko",
    bubbles: [
      { id: "b1", shape: "ellipse", box: [100, 100, 340, 260] },
      { id: "b2", shape: "ellipse", box: [400, 100, 700, 300] },
    ],
    texts: [
      {
        id: 1,
        order: 1,
        bubbleId: "b1",
        type: "dialogue",
        speaker: "Borkin",
        text: "보르킨, 일곱 시에 부두에서 보자.",
        inkBox: [140, 140, 300, 220],
        canaries: ["Borkin", "7"],
      },
      {
        id: 2,
        order: 2,
        bubbleId: "b2",
        type: "narration",
        speaker: null,
        text: "ZORVAX WAITS AT THE PIER.",
        inkBox: [450, 150, 650, 250],
      },
      { id: 3, order: 3, bubbleId: null, type: "sfx", text: "쿵", inkBox: [100, 500, 200, 560] },
      { id: 4, order: 4, bubbleId: null, type: "ignore", text: "p.12", inkBox: [700, 900, 760, 930] },
    ],
  };

  before(async () => {
    gtDir = await mkdtemp(join(tmpdir(), "ctv-mock-gt-"));
    await writeFile(join(gtDir, "page-a.gt.json"), JSON.stringify(groundTruth));
    mock = await createMockServer({ gtDir });
  });
  after(async () => {
    await mock.close();
    await rm(gtDir, { recursive: true, force: true });
  });
  afterEach(() => mock.reset());

  const units: TestUnit[] = [
    { n: 1, src: "page-a", box: { x1: 142, y1: 138, x2: 298, y2: 224 } }, // text box of unit 1
    { n: 2, src: "page-a.png", box: { x1: 402, y1: 104, x2: 698, y2: 296 } }, // bubble box of unit 2
    { n: 3, src: "http://localhost:8081/img/page-a.jpg", box: { x1: 100, y1: 500, x2: 200, y2: 560 } },
    { n: 4, src: "page-a", box: { x1: 700, y1: 900, x2: 760, y2: 930 } }, // ignore unit
    { n: 5, src: "page-a", box: { x1: 0, y1: 1200, x2: 50, y2: 1250 } }, // nothing there
    { n: 6, src: "page-b", box: { x1: 0, y1: 0, x2: 10, y2: 10 } }, // no ground truth
  ];

  test("boxes map to ground-truth units by IoU (text box, else bubble box)", async () => {
    const res = await post(mock, chatBody(6), { [TEST_UNITS_HEADER]: encodeTestUnits(units) });
    const lines = contentOf(sseData(await res.text())).split("\n");
    assert.deepEqual(lines, [
      "@lang|ko",
      "#1|dialogue|Borkin|보르킨, 일곱 시에 부두에서 보자.|VI:câu 1 (Borkin, 7)",
      "#2|narration||ZORVAX WAITS AT THE PIER.|VI:ZORVAX WAITS AT THE PIER.",
      "#3|sfx||쿵|VI:câu 3",
      "#4|ignore|||",
      "#5|ignore|||",
      "#6|ignore|||",
    ]);
    const record = lastRecord(mock);
    assert.deepEqual(record.testUnits, units);
    assert.equal(
      record.headers[TEST_UNITS_HEADER],
      undefined,
      "decoded into testUnits, not kept as a header",
    );
    assert.deepEqual(
      record.oracle?.matched.map((m) => [m.n, m.gtId, m.by]),
      [
        [1, "1", "text"],
        [2, "2", "bubble"],
        [3, "3", "text"],
        [4, "4", "text"],
      ],
    );
    assert.deepEqual(record.oracle?.unmatched, [5, 6]);
    assert.deepEqual(record.oracle?.missingGt, ["page-b"]);
  });

  test("scenario faults apply on top of oracle lines; echo style keeps VI:<original>", async () => {
    mock.setScenario({ missingIds: [2], duplicateIds: [1], unknownIds: [42], oracleVi: "echo" });
    const res = await post(mock, chatBody(3), { [TEST_UNITS_HEADER]: encodeTestUnits(units.slice(0, 3)) });
    assert.deepEqual(contentOf(sseData(await res.text())).split("\n"), [
      "@lang|ko",
      "#1|dialogue|Borkin|보르킨, 일곱 시에 부두에서 보자.|VI:보르킨, 일곱 시에 부두에서 보자.",
      "#1|dialogue|Borkin|보르킨, 일곱 시에 부두에서 보자.|VI:보르킨, 일곱 시에 부두에서 보자. (bản lặp)",
      "#3|sfx||쿵|VI:쿵",
      placeholderLine(42, "ko"),
    ]);
    mock.setScenario({ dropAfterChunks: 1, chunkChars: 12 });
    const cut = sseData(
      await (await post(mock, chatBody(3), { [TEST_UNITS_HEADER]: encodeTestUnits(units) })).text(),
    );
    assert.equal(cut.length, 2);
  });

  test("generator ground truth: nested image behind a server route, singular canary, seam box past the edge", async () => {
    // The shape tools/fixtures/make_fixtures.py writes to <stem>.gt.json (original sentences, invented canary).
    const unit = (extra: Json): Json => ({
      kind: "free",
      texts: [extra["text"]],
      orientation: "h",
      glyphPx: 24,
      speaker: null,
      canary: null,
      translation: null,
      lang: "ko",
      fontPx: 24,
      shape: "rect",
      ...extra,
    });
    const gt = {
      image: "chapter-x/001.jpg",
      width: 400,
      height: 600,
      lang: "ko",
      layout: "strip",
      units: [
        unit({
          id: 1,
          kind: "bubble",
          type: "dialogue",
          bubble: { x1: 40, y1: 40, x2: 360, y2: 200 },
          text: { x1: 90, y1: 80, x2: 310, y2: 160 },
          original: "조르박스, 창고 열쇠 어디 있어?",
          lines: ["조르박스, 창고 열쇠 어디 있어?"],
          canary: "Zorvax",
        }),
        unit({
          id: 2,
          type: "narration",
          bubble: null,
          text: { x1: 100, y1: 540, x2: 300, y2: 600 },
          original: "다음 날 아침.",
          lines: ["다음 날 아침."],
          translation: "Sáng hôm sau.",
          seam: { seamId: "seam-1", part: "upper" },
        }),
      ],
    };
    await mkdir(join(gtDir, "chapter-x"), { recursive: true });
    await writeFile(join(gtDir, "chapter-x", "001.gt.json"), JSON.stringify(gt));
    const nested: TestUnit[] = [
      { n: 1, src: "http://localhost:8081/img/chapter-x/001.jpg", box: { x1: 92, y1: 78, x2: 312, y2: 162 } },
      // A stitched seam unit continues 100 px below this image: IoU 0.375 unless clipped to the image.
      {
        n: 2,
        src: "http://localhost:8081/protected-cookie/chapter-x/001.jpg?variant=b",
        box: { x1: 100, y1: 540, x2: 300, y2: 700 },
      },
    ];
    const res = await post(mock, chatBody(2), { [TEST_UNITS_HEADER]: encodeTestUnits(nested) });
    assert.deepEqual(contentOf(sseData(await res.text())).split("\n"), [
      "@lang|ko",
      "#1|dialogue||조르박스, 창고 열쇠 어디 있어?|VI:câu 1 (Zorvax)",
      "#2|narration||다음 날 아침.|VI:Sáng hôm sau.",
    ]);
    const record = lastRecord(mock);
    assert.deepEqual(record.oracle?.missingGt, []);
    assert.deepEqual(
      record.oracle?.matched.map((m) => [m.n, m.gtId, m.by, m.iou]),
      [
        [1, "1", "text", 0.936],
        [2, "2", "text", 1],
      ],
    );
    assert.deepEqual(groundTruthCandidates("http://localhost:8081/img/chapter-x/001.jpg"), [
      "img/chapter-x/001.jpg",
      "img/chapter-x/001",
      "chapter-x/001.jpg",
      "chapter-x/001",
      "001.jpg",
      "001",
    ]);
    assert.deepEqual(normalizeGroundTruth(gt).size, { w: 400, h: 600 });
  });

  test("a ground-truth file saved with a UTF-8 BOM (Windows PowerShell 5.1) still loads", async () => {
    await writeFile(
      join(gtDir, "page-bom.gt.json"),
      `${String.fromCharCode(0xfeff)}${JSON.stringify(groundTruth)}`,
      "utf8",
    );
    const box = { x1: 450, y1: 150, x2: 650, y2: 250 };
    const res = await post(mock, chatBody(1), {
      [TEST_UNITS_HEADER]: encodeTestUnits([{ n: 1, src: "page-bom.png", box }]),
    });
    assert.deepEqual(contentOf(sseData(await res.text())).split("\n"), [
      "@lang|ko",
      "#1|narration||ZORVAX WAITS AT THE PIER.|VI:ZORVAX WAITS AT THE PIER.",
    ]);
    assert.deepEqual(lastRecord(mock).oracle?.errors, []);
  });

  test("oracleLang answers a unit's refs.<lang> verbatim and keeps VI: for units without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctv-mock-refs-"));
    const box = (x1: number, y1: number, x2: number, y2: number): Json => ({ x1, y1, x2, y2 });
    await writeFile(
      join(dir, "es-page.gt.json"),
      JSON.stringify({
        lang: "es",
        width: 800,
        height: 600,
        units: [
          {
            id: 1,
            type: "dialogue",
            original: "¿CERRASTE LA PUERTA?",
            text: box(100, 100, 300, 160),
            vi: "Cậu khóa cửa chưa?",
            refs: { EN: "Did you lock the door?", fr: "Tu as fermé la porte ?" },
          },
          { id: 2, type: "sfx", original: "¡BUM!", text: box(400, 300, 600, 400), vi: "ẦM!" },
        ],
      }),
    );
    const refsMock = await createMockServer({ gtDir: dir });
    try {
      const two: TestUnit[] = [
        { n: 1, src: "es-page.png", box: { x1: 100, y1: 100, x2: 300, y2: 160 } },
        { n: 2, src: "es-page.png", box: { x1: 400, y1: 300, x2: 600, y2: 400 } },
      ];
      const ask = async (): Promise<string[]> => {
        const res = await post(refsMock, chatBody(2), { [TEST_UNITS_HEADER]: encodeTestUnits(two) });
        return contentOf(sseData(await res.text())).split("\n");
      };
      assert.deepEqual(await ask(), [
        "@lang|es",
        "#1|dialogue||¿CERRASTE LA PUERTA?|VI:Cậu khóa cửa chưa?",
        "#2|sfx||¡BUM!|VI:ẦM!",
      ]);
      refsMock.setScenario({ oracleLang: "en" });
      assert.deepEqual(await ask(), [
        "@lang|es",
        "#1|dialogue||¿CERRASTE LA PUERTA?|Did you lock the door?",
        "#2|sfx||¡BUM!|VI:ẦM!",
      ]);
      assert.throws(() => refsMock.setScenario({ oracleLang: "" }), /oracleLang/);
    } finally {
      await refsMock.close();
      await rm(dir, { recursive: true, force: true });
    }
    const page = normalizeGroundTruth({
      units: [
        { id: "a", type: "dialogue", original: "UNO", text: [0, 0, 10, 10], refs: { en: "One", de: 5 } },
      ],
    });
    const unit = page.units[0];
    assert.ok(unit);
    assert.deepEqual(unit.refs, { en: "One" }, "non-string references are dropped");
    assert.equal(oracleTranslation(unit, "safe", "EN"), "One");
    assert.equal(oracleTranslation(unit, "safe", "fr"), "VI:UNO");
    assert.equal(oracleLine(3, unit, "safe", "en"), "#3|dialogue||UNO|One");
  });

  test("a malformed header is recorded and the answer falls back to N from the prompt", async () => {
    const res = await post(mock, chatBody(2), { [TEST_UNITS_HEADER]: "not base64 json" });
    assert.equal(contentOf(sseData(await res.text())).split("\n").length, 3);
    const record = lastRecord(mock);
    assert.equal(record.testUnits, null);
    assert.match(record.testUnitsError ?? "", /x-ctv-test-units/);
  });

  test("ground truth: fixture texts sharing a bubble form one unit; explicit units are kept", () => {
    const page = normalizeGroundTruth({
      lang: "ja",
      bubbles: [{ id: "b9", box: [0, 0, 400, 400] }],
      texts: [
        { id: 7, order: 2, bubbleId: "b9", type: "dialogue", text: "後半", inkBox: [200, 50, 240, 300] },
        { id: 6, order: 1, bubbleId: "b9", type: "dialogue", text: "前半", inkBox: [260, 50, 300, 300] },
      ],
    });
    assert.equal(page.lang, "ja");
    assert.equal(page.units.length, 1);
    assert.deepEqual(page.units[0]?.text, { x1: 200, y1: 50, x2: 300, y2: 300 });
    assert.equal(page.units[0]?.original, "前半 後半");
    assert.deepEqual(page.units[0]?.bubble, { x1: 0, y1: 0, x2: 400, y2: 400 });
    const explicit = normalizeGroundTruth({
      units: [
        {
          id: "u1",
          type: "sign",
          original: "OPEN|24H",
          text: { x1: 1, y1: 2, x2: 3, y2: 4 },
          translation: "MỞ CỬA",
        },
      ],
    });
    const unit = explicit.units[0];
    assert.ok(unit);
    assert.equal(oracleVi(unit), "VI:MỞ CỬA");
    assert.equal(oracleLine(5, unit), "#5|sign||OPEN/24H|VI:MỞ CỬA", "a | inside a field is replaced");
  });

  test("compactLine: fast mode's #n|type|translation, line endings kept, other lines unchanged", () => {
    assert.equal(compactLine("#3|dialogue|Mina|안녕|Xin chào\n"), "#3|dialogue|Xin chào\n");
    assert.equal(compactLine("#4|ignore|||"), "#4|ignore|");
    assert.equal(compactLine("#5|sfx||쾅|RẦM\r\n"), "#5|sfx|RẦM\r\n");
    assert.equal(compactLine("@lang|ko\n"), "@lang|ko\n");
    assert.equal(compactLine("#6|dialogue|already compact\n"), "#6|dialogue|already compact\n");
    assert.equal(COMPACT_REQUEST, COMPACT_ITEM_LINE, "the mock looks for the extension's own line");
  });
});

describe("latency", () => {
  const profile: LatencyProfile = { t0P50: 60, t0P90: 90, tLineP50: 4, tLineP90: 8, seed: 42 };

  test("sampleLatency is deterministic per (seed, request index) and follows p50/p90", () => {
    assert.deepEqual(sampleLatency(profile, 0, 5), sampleLatency(profile, 0, 5));
    assert.deepEqual(
      sampleLatency(profile, 3, 2).t0Ms,
      sampleLatency(profile, 3, 9).t0Ms,
      "T0 ignores line count",
    );
    assert.notDeepEqual(sampleLatency(profile, 0, 5), sampleLatency(profile, 1, 5));
    assert.notDeepEqual(sampleLatency(profile, 0, 5), sampleLatency({ ...profile, seed: 43 }, 0, 5));
    const big = { t0P50: 10_000, t0P90: 18_000, tLineP50: 800, tLineP90: 1_100, seed: 7 };
    const t0 = Array.from({ length: 4000 }, (_, i) => sampleLatency(big, i, 0).t0Ms).sort((a, b) => a - b);
    const p50 = t0[2000] ?? 0;
    const p90 = t0[3600] ?? 0;
    assert.ok(Math.abs(p50 - 10_000) < 600, `p50 ${p50}`);
    assert.ok(Math.abs(p90 - 18_000) < 1_500, `p90 ${p90}`);
  });

  test("the server waits the sampled T0 before the first token and replays the same plan for the same seed", async () => {
    const mock = await createMockServer({ scenario: { latencyProfile: profile, lateHeaders: true } });
    try {
      const started = performance.now();
      const res = await post(mock, chatBody(3));
      const headersAfter = performance.now() - started;
      await res.text();
      const first = lastRecord(mock).latency;
      assert.ok(first);
      assert.deepEqual(first, sampleLatency(profile, 0, 3), "@lang + 3 lines → 3 line gaps");
      assert.ok(headersAfter >= first.t0Ms, `${headersAfter} ms < T0 ${first.t0Ms}`);
      const second = (await (await post(mock, chatBody(3))).text(), lastRecord(mock).latency);
      assert.deepEqual(second, sampleLatency(profile, 1, 3));

      mock.setScenario({ latencyProfile: profile });
      await (await post(mock, chatBody(3))).text();
      assert.deepEqual(lastRecord(mock).latency, first, "setScenario restarts the request index");
      mock.setScenario({ latencyProfile: { ...profile, seed: 1234 } });
      await (await post(mock, chatBody(3))).text();
      assert.notDeepEqual(lastRecord(mock).latency, first);
    } finally {
      await mock.close();
    }
  });
});

describe("bookkeeping", () => {
  let mock: MockServer;
  before(async () => {
    mock = await createMockServer();
  });
  after(async () => {
    await mock.close();
  });
  afterEach(() => mock.reset());

  test("counts concurrency with 3 parallel requests", async () => {
    mock.setScenario({ headersDelayMs: 150 });
    const bodies = await Promise.all([1, 2, 3].map(async (n) => (await post(mock, chatBody(n))).text()));
    assert.ok(bodies.every((b) => b.endsWith("data: [DONE]\n\n")));
    assert.equal(mock.maxConcurrency(), 3);
    assert.equal(mock.inFlight(), 0);
    const chats = mock.requests().filter((r) => r.path === "/v1/chat/completions");
    assert.deepEqual(chats.map((r) => r.inFlightAtStart).sort(), [1, 2, 3]);
    await (await fetch(`${mock.baseUrl}/models`)).text();
    assert.equal(mock.maxConcurrency(), 3, "/v1/models does not count");
    mock.reset();
    assert.equal(mock.maxConcurrency(), 0);
  });

  test("a client that disconnects does not stop the simulated generation", async () => {
    mock.setScenario({ headersDelayMs: 300 });
    const controller = new AbortController();
    const pending = post(mock, chatBody(1));
    const aborted = fetch(`${mock.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody(1)),
      signal: controller.signal,
    });
    // Abort once both requests are past validation, i.e. generation has started for them.
    await waitFor(() => mock.requests().filter((r) => r.scenarioName !== null).length === 2);
    controller.abort();
    await assert.rejects(aborted);
    await waitFor(() => mock.requests().some((r) => r.clientAborted));
    assert.equal(mock.inFlight(), 2, "the aborted request still occupies the server");
    await (await pending).text();
    await waitFor(() => mock.inFlight() === 0);
    const records = mock.requests();
    assert.equal(records.filter((r) => r.clientAborted).length, 1);
    const abortedRecord = records.find((r) => r.clientAborted);
    assert.ok((abortedRecord?.durationMs ?? 0) >= 300);
    assert.ok((abortedRecord?.clientAbortedAtMs ?? 1000) < 300);
  });

  test("control endpoints over HTTP", async () => {
    const set = await fetch(`${mock.url}/__scenario`, {
      method: "POST",
      body: JSON.stringify({ name: "http", failBeforeHeaders: "content_filter" }),
    });
    assert.equal(set.status, 200);
    assert.equal((await post(mock, chatBody(1))).status, 400);
    const rejected = await fetch(`${mock.url}/__scenario`, { method: "POST", body: '{"chunkChars": 0}' });
    assert.equal(rejected.status, 400);

    await fetch(`${mock.url}/__health`, { method: "POST", body: JSON.stringify({ preset: "unauthorized" }) });
    assert.equal((await fetch(`${mock.baseUrl}/models`)).status, 401);
    await fetch(`${mock.url}/__health`, {
      method: "POST",
      body: JSON.stringify({ data: [{ id: "custom" }] }),
    });
    assert.deepEqual(await jsonOf(await fetch(`${mock.baseUrl}/models`)), { data: [{ id: "custom" }] });
    (mock.health().body as { data: unknown[] }).data.length = 0;
    assert.deepEqual(
      mock.health(),
      { status: 200, body: { data: [{ id: "custom" }] } },
      "health() is a snapshot",
    );

    const listed = (await jsonOf(await fetch(`${mock.url}/__requests`))) as {
      requests: RecordedRequest[];
      maxConcurrency: number;
    };
    assert.deepEqual(
      listed.requests.map((r) => [r.method, r.path, r.status, r.errorCode]),
      [
        ["POST", "/v1/chat/completions", 400, "content_filter"],
        ["GET", "/v1/models", 401, "invalid_api_key"],
        ["GET", "/v1/models", 200, null],
      ],
    );
    assert.equal(listed.maxConcurrency, 1);

    await fetch(`${mock.url}/__mark?id=sw&e=start`);
    const slow = await fetch(`${mock.url}/slow?headersDelayMs=50&bodyGapMs=20&id=run-1`);
    assert.equal(slow.status, 200);
    assert.ok((await slow.text()).endsWith("data: [DONE]\n\n"));
    const marks = (await jsonOf(await fetch(`${mock.url}/__marks`))) as {
      marks: Array<{ id: string; e: string }>;
      slow: Array<{ id: string; aborted: boolean; headersAtMs: number }>;
    };
    assert.deepEqual(
      marks.marks.map((m) => [m.id, m.e]),
      [["sw", "start"]],
    );
    assert.equal(marks.slow[0]?.id, "run-1");
    assert.equal(marks.slow[0]?.aborted, false);
    assert.ok((marks.slow[0]?.headersAtMs ?? 0) >= 50);

    assert.equal((await fetch(`${mock.url}/__reset`, { method: "POST" })).status, 200);
    assert.deepEqual(mock.requests(), []);
    assert.equal(mock.scenario().name, "default");
    assert.equal(mock.health().status, 200);
    assert.equal((await fetch(`${mock.url}/__nope`)).status, 404);
  });

  test("an oversized control body gets 400 and leaves the keep-alive connection usable", async () => {
    const [rejected, next] = await rawKeepAlive(mock.url, [
      { method: "POST", path: "/__scenario", body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }) },
      { method: "GET", path: "/__scenario" },
    ]);
    assert.equal(rejected?.status, 400);
    assert.match(rejected?.body.toString("utf8") ?? "", /control body over 1 MiB/);
    assert.equal(next?.status, 200, "the next request on the same connection is answered");
  });

  test("close() makes the server unreachable and the same port can be served again", async () => {
    const first = await createMockServer();
    await (await fetch(`${first.baseUrl}/models`)).text(); // leaves an idle keep-alive connection
    await first.close();
    await assert.rejects(
      fetch(`${first.baseUrl}/models`),
      TypeError,
      "fetch throws: readiness 'unreachable'",
    );
    const again = await createMockServer({ port: first.port });
    try {
      assert.equal(again.url, first.url);
      const res = await fetch(`${again.baseUrl}/models`);
      assert.equal(res.status, 200);
      await res.text();
    } finally {
      await again.close();
    }
  });

  test("delays past setTimeout's ceiling (about 24.8 days) wait instead of firing after 1 ms", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", onWarning);
    const own = await createMockServer({ scenario: { headersDelayMs: 3_000_000_000 } });
    try {
      await assert.rejects(
        fetch(`${own.url}/slow?headersDelayMs=3000000000&id=long`, { signal: AbortSignal.timeout(250) }),
        { name: "TimeoutError" },
      );
      await assert.rejects(
        fetch(`${own.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chatBody(1)),
          signal: AbortSignal.timeout(250),
        }),
        { name: "TimeoutError" },
      );
      await waitFor(() => own.inFlight() === 1);
      assert.equal(own.marks().slow[0]?.headersAtMs, null);
    } finally {
      await own.close();
      process.off("warning", onWarning);
    }
    assert.deepEqual(
      warnings.filter((name) => name === "TimeoutOverflowWarning"),
      [],
      "no 1 ms timer loop",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The extension's API code against the mock: presets must stand for the classes they are named after.

describe("the extension's API client, error classifier and readiness check against the mock", () => {
  let mock: MockServer;
  before(async () => {
    mock = await createMockServer({ model: MODEL, apiKey: "sk-test" });
  });
  after(async () => {
    await mock.close();
  });
  afterEach(() => mock.reset());

  async function run(
    options: Partial<StreamChatOptions> = {},
  ): Promise<{ lines: string[]; result: unknown }> {
    const lines: string[] = [];
    const result = await streamChat(
      {
        baseUrl: mock.baseUrl,
        apiKey: "sk-test",
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "The attached image has N = 2 numbered regions." }],
          },
        ],
        onLine: (line) => lines.push(line),
        ...options,
      },
      defaultDeps(),
    );
    return { lines, result };
  }

  async function failureCode(options: Partial<StreamChatOptions> = {}): Promise<string> {
    try {
      await run(options);
    } catch (error) {
      assert.ok(error instanceof CtvError, String(error));
      return error.code;
    }
    return "no error";
  }

  test("a complete stream, a truncated one, and timing knobs", async () => {
    const complete = await run();
    assert.deepEqual(complete.lines, ["@lang|ko", placeholderLine(1, "ko"), placeholderLine(2, "ko")]);
    assert.equal((complete.result as { sawDone: boolean }).sawDone, true);
    assert.equal((complete.result as { model: string }).model, MODEL);

    mock.setScenario({ dropAfterChunks: 3, chunkChars: 10 });
    const cut = await run();
    assert.equal((cut.result as { truncated: boolean }).truncated, true);
    assert.deepEqual(cut.lines, ["@lang|ko"], "the unterminated last line is not delivered");

    mock.setScenario({ lateHeaders: true, firstChunkDelayMs: 120 });
    const late = (await run()).result as { ttfbMs: number; firstContentMs: number };
    assert.ok(late.ttfbMs >= 120, `ttfb ${late.ttfbMs}`);
  });

  test("errors: HTTP presets, in-stream error frames, dropped connections, empty answers, the API key", async () => {
    mock.setScenario({ failBeforeHeaders: "rate_limit" });
    assert.equal(await failureCode(), "api.rate_limit");
    mock.setScenario({ errorFrame: "server_error" });
    assert.equal(await failureCode(), "api.upstream");
    mock.setScenario({ errorFrame: "content_filter", dropAfterChunks: 1 });
    assert.equal(await failureCode(), "llm.refused");
    mock.setScenario({ resetAfterChunks: 0 });
    assert.equal(await failureCode(), "api.unreachable");
    mock.setScenario({ resetAfterChunks: 1 });
    assert.equal(await failureCode(), "api.unreachable");
    mock.setScenario({ empty: true });
    assert.equal(await failureCode(), "api.empty");
    mock.setScenario({ refusal: true });
    assert.equal(await failureCode(), "no error", "a refusal sentence is text: the line parser judges it");
    mock.reset();
    assert.equal(await failureCode({ apiKey: "" }), "api.unauthorized");
    assert.equal(await failureCode({ apiKey: "sk-wrong" }), "api.unauthorized");
  });

  test("every FAILURES preset classifies as the error it is named after", () => {
    const expected: Record<FailureName, string> = {
      unauthorized: "api.unauthorized",
      forbidden: "api.unauthorized",
      model_not_found: "api.config",
      no_vision: "api.config",
      bad_request: "api.bad_request",
      context_length: "api.context_length",
      content_filter: "llm.refused",
      too_large: "api.too_large",
      rate_limit: "api.rate_limit",
      insufficient_quota: "api.config",
      server_error: "api.upstream",
      bad_gateway: "api.upstream",
      overloaded: "api.upstream",
      timeout: "api.timeout",
    };
    for (const [name, spec] of Object.entries(FAILURES) as Array<[FailureName, FailSpec]>) {
      assert.equal(classifyHttpError(spec.status, failureBody(spec)).code, expected[name], name);
    }
  });

  test("GET /v1/models presets map to the readiness they stand for", async () => {
    const expected: Record<string, [string, boolean]> = {
      ready: ["ready", false],
      unauthorized: ["unauthorized", true],
      "no-models-route": ["ready", true],
      "server-error": ["unreachable", true],
    };
    for (const preset of HEALTH_PRESETS) {
      mock.setHealth(preset);
      const res = await fetch(`${mock.baseUrl}/models`, { headers: { Authorization: "Bearer sk-test" } });
      const answer = { status: res.status, body: await jsonOf(res) };
      assert.deepEqual(answer, healthResponse(preset, MODEL), preset);
      const reading = readinessFrom(answer, MODEL);
      assert.deepEqual([reading.readiness, reading.cause !== null], expected[preset], preset);
    }
    mock.setHealth("ready");
    assert.match(readinessFrom(mock.health(), "other-model").cause ?? "", /not listed/);
  });
});
