// Streaming client for any OpenAI-compatible endpoint: POST {baseUrl}/chat/completions with stream:true, read the
// SSE body, deliver complete content lines as they arrive (docs/ARCHITECTURE.md "Translation").
//
// Portable: only web-standard APIs (ReadableStream, TextDecoder, AbortController). The transport, clock and timers
// are injected, so Node tools can pass a node:http transport (undici's 300 s timeouts would cut slow local servers)
// and unit tests a fake one.
//
// Policy:
// - No caller AbortSignal: in-flight requests are never cancelled (providers keep working, and bill, anyway). Only a
//   watchdog aborts, to free the socket: first byte, idle time between body chunks and total time (settings.api).
//   Proxies and local servers may send the response headers only with the first token, so "first byte" can be long.
// - Non-2xx → CtvError from classifyHttpError; transport failure → classifyFetchError; watchdog → api.timeout.
// - [DONE] is required: without it the result is `truncated` (lines already delivered stay valid; the unterminated
//   last line is never delivered). [DONE] does not prove completeness either: the caller still counts ids.
// - No content at all → api.empty. An in-stream error frame → api.upstream (llm.refused for content filters).

import { CtvError, type CtvErrorOptions, type ErrorInfo } from "../shared/errors.ts";
import { classifyFetchError, classifyHttpError } from "../shared/core/api-errors.ts";
import { createLineSplitter } from "../shared/core/line-parser.ts";
import type { ChatMessage } from "../shared/core/prompt.ts";
import { isContentFilterMessage } from "../shared/core/refusal.ts";
import { createChatStreamDecoder } from "../shared/core/sse.ts";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Header read only by the mock server's oracle mode (test builds); real providers ignore unknown headers. */
export const TEST_UNITS_HEADER = "x-ctv-test-units";
export const DEFAULT_TIMEOUTS = Object.freeze({ firstByteMs: 180_000, idleMs: 60_000, totalMs: 600_000 });

export interface TransportInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Aborted only by a watchdog. */
  signal: AbortSignal;
  cache: "no-store";
  credentials: "omit";
}

/** The part of a fetch Response the client uses. */
export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type Transport = (url: string, init: TransportInit) => Promise<TransportResponse>;

export interface ApiClientDeps {
  transport: Transport;
  /** Monotonic milliseconds. */
  now: () => number;
  /** Runs fn after ms; returns a cancel function. */
  setTimer: (fn: () => void, ms: number) => () => void;
}

export interface StreamChatOptions {
  /** Base URL including the version path, e.g. "https://api.openai.com/v1" or "http://127.0.0.1:11434/v1". */
  baseUrl: string;
  /** Sent as "Authorization: Bearer <apiKey>" when not empty. */
  apiKey?: string;
  model: string;
  /** Omitted from the body when undefined or null (provider default). */
  temperature?: number | null;
  messages: readonly ChatMessage[];
  /** Each complete content line, without its line break, in stream order. */
  onLine: (line: string) => void;
  /** Raw content deltas (debug ring buffer, bench). */
  onDelta?: (text: string) => void;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Multiplies the three timeouts (×1.5 for the retry after a timeout). */
  watchdogFactor?: number;
  /** Base64 JSON of the composite's boxes, sent as x-ctv-test-units. Pass only in test builds. */
  testUnits?: string;
}

export interface StreamChatResult {
  sawDone: boolean;
  /** The stream ended without [DONE]: keep the delivered lines and run the ladder for missing ids. */
  truncated: boolean;
  /** Usually "stop"; not evidence of completeness (proxies may cut the stream without saying so). */
  finishReason: string | null;
  usage: unknown;
  /** Model id the provider reports in the chunks (may differ from the requested one). */
  model: string | null;
  /** Send → response headers. */
  ttfbMs: number;
  /** Send → first content delta, or null. */
  firstContentMs: number | null;
  totalMs: number;
  /** Unterminated last line that was NOT delivered (only when truncated). */
  tail: string;
  /** Data frames received (including [DONE]) and how many were not JSON. */
  frames: number;
  invalidFrames: number;
  contentChars: number;
}

type Watchdog = "first_byte" | "idle" | "total";
/** ReadableStreamReadResult<Uint8Array>, spelled so that it also resolves without the DOM lib (Node bench). */
type ByteRead = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
}

export function requestHeaders(apiKey?: string, testUnits?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (apiKey !== undefined && apiKey.trim() !== "") {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }
  if (testUnits !== undefined && testUnits !== "") {
    headers[TEST_UNITS_HEADER] = testUnits;
  }
  return headers;
}

/** The JSON body of one streamed request. */
export function requestBody(options: Pick<StreamChatOptions, "model" | "temperature" | "messages">): string {
  const body: Record<string, unknown> = { model: options.model, stream: true, messages: options.messages };
  if (options.temperature !== undefined && options.temperature !== null)
    body["temperature"] = options.temperature;
  return JSON.stringify(body);
}

/** fetch + performance.now + setTimeout (extension pages, offscreen document). */
export function defaultDeps(): ApiClientDeps {
  return {
    transport: (url, init) => fetch(url, init),
    now: () => performance.now(),
    setTimer: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  };
}

function errorFrom(info: ErrorInfo, cause?: unknown): CtvError {
  const options: CtvErrorOptions = { retryable: info.retryable };
  if (info.status !== undefined) {
    options.status = info.status;
  }
  if (info.detail !== undefined) {
    options.detail = info.detail;
  }
  if (info.retryAfterMs !== undefined) {
    options.retryAfterMs = info.retryAfterMs;
  }
  if (cause !== undefined) {
    options.cause = cause;
  }
  return new CtvError(info.code, info.message, options);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const noop = (): void => undefined;

/** One streamed chat completion. Resolves on a normal (possibly truncated) end; rejects with a CtvError otherwise. */
export async function streamChat(options: StreamChatOptions, deps: ApiClientDeps): Promise<StreamChatResult> {
  const factor = options.watchdogFactor ?? 1;
  const limits: Record<Watchdog, number> = {
    first_byte: (options.firstByteTimeoutMs ?? DEFAULT_TIMEOUTS.firstByteMs) * factor,
    idle: (options.idleTimeoutMs ?? DEFAULT_TIMEOUTS.idleMs) * factor,
    total: (options.totalTimeoutMs ?? DEFAULT_TIMEOUTS.totalMs) * factor,
  };
  const controller = new AbortController();
  const init: TransportInit = {
    method: "POST",
    headers: requestHeaders(options.apiKey, options.testUnits),
    body: requestBody(options),
    signal: controller.signal,
    cache: "no-store",
    credentials: "omit",
  };

  const started = deps.now();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timedOut: CtvError | null = null;
  let settled = false;
  let rejectWatchdog: (error: CtvError) => void = noop;
  const watchdog = new Promise<never>((_resolve, reject) => {
    rejectWatchdog = reject;
  });
  watchdog.catch(noop);

  const fire = (kind: Watchdog): void => {
    if (settled || timedOut !== null) {
      return;
    }
    const seconds = Math.round(limits[kind] / 1000);
    const message =
      kind === "first_byte"
        ? `no response from the API within ${seconds} s`
        : kind === "idle"
          ? `the API stream was idle for ${seconds} s`
          : `the request exceeded ${seconds} s`;
    const error = new CtvError("api.timeout", message, { retryable: true, detail: kind });
    timedOut = error;
    rejectWatchdog(error); // first, so a read that cancel() resolves cannot win the race
    controller.abort(error);
    if (reader !== null) {
      reader.cancel(error).catch(noop);
    }
  };
  const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, watchdog]);
  const failIfTimedOut = (): void => {
    if (timedOut !== null) {
      throw timedOut;
    }
  };

  const cancelTotal = deps.setTimer(() => fire("total"), limits.total);
  let cancelPhase = deps.setTimer(() => fire("first_byte"), limits.first_byte);
  const armIdle = (): void => {
    cancelPhase();
    cancelPhase = deps.setTimer(() => fire("idle"), limits.idle);
  };
  let drained = false;

  try {
    let response: TransportResponse;
    try {
      const pending = deps.transport(chatCompletionsUrl(options.baseUrl), init);
      // A response that arrives after a watchdog fired is released at once.
      pending.then((late) => {
        if (timedOut !== null) {
          late.body?.cancel().catch(noop);
        }
      }, noop);
      response = await race(pending);
    } catch (error) {
      failIfTimedOut();
      throw errorFrom(classifyFetchError(error), error);
    }
    failIfTimedOut();
    const ttfbMs = deps.now() - started;
    armIdle();

    if (response.status < 200 || response.status > 299) {
      let text = "";
      try {
        text = await race(response.text());
      } catch {
        failIfTimedOut(); // an unreadable error body still classifies by status
      }
      failIfTimedOut();
      drained = true;
      throw errorFrom(classifyHttpError(response.status, text === "" ? null : parseJson(text)));
    }

    let contentChars = 0;
    let hasText = false;
    let firstContentMs: number | null = null;
    let received = false;
    const splitter = createLineSplitter((line) => options.onLine(line));
    const decoder = createChatStreamDecoder((text) => {
      if (firstContentMs === null) {
        firstContentMs = deps.now() - started;
      }
      contentChars += text.length;
      hasText ||= /\S/u.test(text);
      options.onDelta?.(text);
      splitter.push(text);
    });

    const contentType = response.headers.get("content-type") ?? "";
    let sawDone = false;
    let nonStreamBody = false;
    let nonStreamFinish: string | null = null;
    let nonStreamUsage: unknown = null;
    if (/application\/json/iu.test(contentType)) {
      // A non-stream completion (only if the server ignored stream:true): a complete JSON body counts as [DONE].
      let text: string;
      try {
        text = await race(response.text());
      } catch (error) {
        failIfTimedOut();
        throw errorFrom(classifyFetchError(error), error);
      }
      failIfTimedOut();
      drained = true;
      const body = parseJson(text);
      const choice: unknown = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
      const message = isRecord(choice) ? choice.message : undefined;
      const content = isRecord(message) && typeof message.content === "string" ? message.content : null;
      if (content === null) {
        throw new CtvError("api.protocol", "unexpected JSON response from the API", {
          retryable: true,
        });
      }
      nonStreamBody = true;
      received = text.length > 0;
      nonStreamFinish =
        isRecord(choice) && typeof choice.finish_reason === "string" ? choice.finish_reason : null;
      nonStreamUsage = isRecord(body) ? (body.usage ?? null) : null;
      if (content !== "") {
        firstContentMs = deps.now() - started;
        contentChars = content.length;
        hasText = /\S/u.test(content);
        options.onDelta?.(content);
        splitter.push(content);
      }
      sawDone = true;
    } else if (response.body !== null) {
      // Streaming UTF-8 decode (a character split across chunks waits for the next chunk).
      const utf8 = new TextDecoder();
      reader = response.body.getReader();
      for (;;) {
        let chunk: ByteRead;
        try {
          chunk = await race(reader.read());
        } catch (error) {
          failIfTimedOut();
          throw errorFrom(classifyFetchError(error), error);
        }
        failIfTimedOut();
        if (chunk.done) {
          drained = true;
          decoder.push(utf8.decode());
          break;
        }
        armIdle();
        if (chunk.value.byteLength > 0) {
          received = true;
          decoder.push(utf8.decode(chunk.value, { stream: true }));
        }
        if (decoder.state.sawDone || decoder.state.error !== null) {
          break;
        }
      }
      decoder.end();
      sawDone = decoder.state.sawDone;
    } else {
      drained = true;
    }

    const state = decoder.state;
    if (state.error !== null) {
      const { message, code, type } = state.error;
      const refused = isContentFilterMessage([message, code ?? "", type ?? ""].join(" "));
      throw new CtvError(refused ? "llm.refused" : "api.upstream", message, {
        retryable: !refused,
        detail: code ?? "in_stream_error",
      });
    }
    if (!hasText) {
      if (received && !nonStreamBody && state.frames === 0) {
        throw new CtvError("api.protocol", "the response is not an SSE stream", { retryable: true });
      }
      throw new CtvError("api.empty", "the model returned no text", {
        retryable: true,
        detail: sawDone ? "done" : "no_done",
      });
    }

    let tail = splitter.end();
    if (sawDone && tail !== "") {
      options.onLine(tail);
      tail = "";
    }
    return {
      sawDone,
      truncated: !sawDone,
      finishReason: nonStreamBody ? nonStreamFinish : state.finishReason,
      usage: nonStreamBody ? nonStreamUsage : state.usage,
      model: state.model,
      ttfbMs,
      firstContentMs,
      totalMs: deps.now() - started,
      tail,
      frames: state.frames,
      invalidFrames: state.invalidFrames,
      contentChars,
    };
  } finally {
    settled = true;
    cancelTotal();
    cancelPhase();
    if (!drained && reader !== null) {
      // Stopped at [DONE], on an error frame or on a consumer exception: discard the rest of the body. Only a
      // watchdog aborts the request itself.
      reader.cancel().catch(noop);
    }
  }
}
