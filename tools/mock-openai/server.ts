// Mock of an OpenAI-compatible vision chat API for tests, E2E runs and offline demos. node:http only.
//
// API routes (base URL `<url>/v1`):
//   GET|HEAD /v1/models             the configured model as {object:"list", data:[{id, object:"model", ...}]}, or
//                                   the answer of a readiness preset ("health")
//   GET|HEAD /v1/models/<id>        the model object, or 404 model_not_found
//   POST     /v1/chat/completions   SSE chat.completion.chunk frames + `data: [DONE]`; one JSON chat.completion
//                                   when `stream` is not true
// With `apiKey` set, every /v1 route requires `Authorization: Bearer <apiKey>` (else 401 invalid_api_key). Errors use
// the OpenAI shape {"error":{"message","type","param","code"}}. Unknown routes get 404, known routes with another
// method 405; OPTIONS answers 204 with Allow but no CORS headers. The response `model` echoes the request's.
//
// The scenario (scenarios.ts) shapes every chat answer: timing, late headers, errors, silent truncation, dropped
// connections, in-stream error frames, garbage, id faults, refusals, empty answers, replays of recorded .sse files.
// Oracle mode answers from ground truth when the request carries x-ctv-test-units (oracle.ts). Every request is
// recorded (bodies summarized, never kept). Like most providers, a client disconnect does not cancel the simulated
// generation, so in-flight counts include it.
//
// Mock-only routes: GET|POST /__scenario, GET|POST /__health, GET /__requests, POST /__reset, GET|POST /__mark,
// GET /__marks, and GET|POST /slow?headersDelayMs=&bodyGapMs=&id= (a one-word stream with controllable gaps, to
// observe how long a browser keeps a request alive).

import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  answerFromGroundTruth,
  COMPACT_REQUEST,
  compactLine,
  decodeTestUnits,
  GroundTruthStore,
  TEST_UNITS_HEADER,
  type OracleReport,
  type TestUnit,
} from "./oracle.ts";
import {
  bearerToken,
  checkBearer,
  DEFAULT_MAX_BODY_BYTES,
  drainRequest,
  header,
  MockApiError,
  readJsonBody,
  unauthorizedError,
  validateChatRequest,
  type ValidatedChat,
  type ValidatedImage,
} from "./request.ts";
import {
  applyScenarioPatch,
  buildAnswerLines,
  DEFAULT_REFUSAL,
  FAILURES,
  failureBody,
  GARBAGE_LINES,
  healthResponse,
  invalidUrlError,
  isHealthPreset,
  parseScenarioPatch,
  placeholderLine,
  planCut,
  planPieces,
  readTaskN,
  resolveScenario,
  sampleLatency,
  splitLinesKeepEndings,
  withLineEndings,
  type FailSpec,
  type HealthPreset,
  type LatencyPlan,
  type Piece,
  type Scenario,
  type ScenarioInput,
  type StreamCut,
} from "./scenarios.ts";
import {
  buildUsage,
  contentChunk,
  contentOfFrames,
  contentToText,
  DEFAULT_MODEL,
  DONE_FRAME,
  estimatePromptTokens,
  estimateTokens,
  finishChunk,
  newCompletion,
  nonStreamBody,
  prop,
  replayWrites,
  roleChunk,
  sendJson,
  splitSseFrames,
  sseFrame,
  SSE_HEADERS,
  usageChunk,
  type CompletionMeta,
  type Usage,
} from "./wire.ts";

export interface MockServerOptions {
  /** Default 127.0.0.1. */
  host?: string;
  /** 0 (ephemeral) in tests; the CLI defaults to 4925. */
  port?: number;
  /** Model listed by GET /v1/models (default "mock-vision"). */
  model?: string;
  /** When set, /v1 routes require `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Request body limit; larger bodies get 413 (default 50 MiB). */
  maxBodyBytes?: number;
  /** Ground truth for oracle mode (e.g. test/fixtures/generated). */
  gtDir?: string;
  /** Recorded .sse transcripts for `replayFile` (e.g. test/fixtures/sse). */
  replayDir?: string;
  /** Initial scenario; reset() returns to it. */
  scenario?: ScenarioInput;
  /** Initial GET /v1/models preset, or a payload served verbatim with 200 (default "ready"); reset() returns to it. */
  health?: HealthPreset | object;
  /** One line per finished request (the CLI passes console.log). */
  log?: (line: string) => void;
}

export type RequestOutcome =
  /** Still running. */
  | "pending"
  /** Complete success: a stream with [DONE], or a 2xx JSON response. */
  | "done"
  /** A stream that ended cleanly without [DONE]. */
  | "truncated"
  /** A stream that ended with an in-stream error frame. */
  | "stream-error"
  /** An HTTP error response. */
  | "error"
  /** The mock destroyed the connection on purpose (resetAfterChunks). */
  | "reset"
  /** The mock was closed mid-request, or the client left while uploading the body. */
  | "aborted";

export type RecordedImage = ValidatedImage;

export interface RecordedRequest {
  /** Arrival order since start/reset, from 1. */
  seq: number;
  /** Date.now() at arrival. */
  t: number;
  method: string;
  path: string;
  /** Raw query string including "?", or "". */
  query: string;
  /** Headers of interest: content-type, accept, origin, user-agent, sec-fetch-*, access-control-request-*... */
  headers: Record<string, string>;
  /** An `Authorization: Bearer` header was sent (the token itself is never recorded). */
  bearer: boolean;
  /** Passed the apiKey check (always true when no apiKey is configured; false before the check ran). */
  authorized: boolean;
  /** Decoded x-ctv-test-units. */
  testUnits: TestUnit[] | null;
  testUnitsError: string | null;
  bodyBytes: number;
  stream: boolean | null;
  /** The `model` the client sent. */
  model: string | null;
  temperature: number | null;
  messageRoles: string[];
  systemChars: number;
  /** System and developer message text joined by line breaks, first SYSTEM_TEXT_LIMIT characters. */
  systemText: string;
  userTextChars: number;
  imageCount: number;
  imageBytes: number;
  images: RecordedImage[];
  /** N read from the last user text ("N = 16"). */
  n: number | null;
  /** Chat requests in flight right after this one arrived, itself included (0 for other routes). */
  inFlightAtStart: number;
  scenarioName: string | null;
  /** HTTP status sent (0 before the response starts, and for a reset before it). */
  status: number;
  /** Arrival → response headers. */
  headersAtMs: number | null;
  /** Arrival → end of the simulated work (it continues after a client disconnect). */
  durationMs: number | null;
  outcome: RequestOutcome;
  /** Body writes: one per SSE frame. */
  framesWritten: number;
  /** error.code (or error.type) of an HTTP error or in-stream error frame. */
  errorCode: string | null;
  latency: LatencyPlan | null;
  oracle: OracleReport | null;
  clientAborted: boolean;
  clientAbortedAtMs: number | null;
}

export interface MarksReport {
  marks: Array<{ id: string; e: string; t: number }>;
  slow: Array<{
    id: string;
    t: number;
    headersDelayMs: number;
    bodyGapMs: number;
    headersAtMs: number | null;
    endedAtMs: number | null;
    aborted: boolean;
    abortedAtMs: number | null;
  }>;
}

export interface HealthAnswer {
  status: number;
  body: unknown;
}

export interface MockServer {
  /** e.g. http://127.0.0.1:53211 */
  readonly url: string;
  /** `${url}/v1`: what a client takes as its base URL. */
  readonly baseUrl: string;
  readonly port: number;
  /** The configured model (listed by GET /v1/models). */
  readonly model: string;
  close(): Promise<void>;
  /**
   * Replace the scenario (defaults + patch) and restart its `sequence` and latency request index. Throws on unknown
   * fields or invalid values, like POST /__scenario.
   */
  setScenario(scenario: ScenarioInput): void;
  scenario(): Scenario;
  /** A preset, or a payload GET /v1/models serves verbatim with 200. */
  setHealth(health: HealthPreset | object): void;
  /** Replace the key /v1 routes require (undefined or "" = none), as a provider rotating keys; reset() restores it. */
  setApiKey(apiKey: string | undefined): void;
  /** Snapshot of what GET /v1/models answers right now (before the apiKey check). */
  health(): HealthAnswer;
  /** Snapshot of the recorded requests. */
  requests(): RecordedRequest[];
  /** Highest number of concurrent POST /v1/chat/completions seen since start/reset. */
  maxConcurrency(): number;
  inFlight(): number;
  marks(): MarksReport;
  /** Forget requests and marks, return to the initial scenario and health. In-flight requests keep running. */
  reset(): void;
}

const MAX_RECORDS = 5000;
/** Characters of system text kept per recorded request. */
export const SYSTEM_TEXT_LIMIT = 64 * 1024;
const CONTROL_BODY_LIMIT = 1024 * 1024;
/** setTimeout's ceiling: a longer delay fires after 1 ms (with a TimeoutOverflowWarning) instead of waiting. */
const MAX_TIMER_MS = 2_147_483_647;

type Route = "models" | "model" | "chat";
const ROUTES: ReadonlyArray<{ route: Route; pattern: RegExp; allow: readonly string[] }> = [
  { route: "models", pattern: /^\/v1\/models\/?$/, allow: ["GET", "HEAD"] },
  { route: "model", pattern: /^\/v1\/models\/([^/]+)\/?$/, allow: ["GET", "HEAD"] },
  { route: "chat", pattern: /^\/v1\/chat\/completions\/?$/, allow: ["POST"] },
];

const INTERESTING_HEADER = /^(?:sec-fetch-|access-control-request-)/;
const PLAIN_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "accept",
  "origin",
  "user-agent",
]);

type HealthState = { kind: "preset"; preset: HealthPreset } | { kind: "payload"; payload: unknown };

function toHealthState(health: HealthPreset | object): HealthState {
  if (typeof health === "string") {
    if (!isHealthPreset(health)) {
      throw new Error(`unknown health preset "${String(health)}"`);
    }
    return { kind: "preset", preset: health };
  }
  return { kind: "payload", payload: structuredClone(health) };
}

/** POST /__health body: `{"preset": "<name>"}` or `"<name>"`; any other object is served verbatim. */
function healthFromJson(body: unknown): HealthPreset | object {
  if (isHealthPreset(body)) {
    return body;
  }
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const keys = Object.keys(body);
    if (keys.length === 1 && keys[0] === "preset") {
      const preset = prop(body, "preset");
      if (!isHealthPreset(preset)) {
        throw new Error(`unknown health preset ${JSON.stringify(preset)}`);
      }
      return preset;
    }
    return body;
  }
  throw new Error("health must be a preset name, {preset}, or a payload object");
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait at least `ms` (re-arming when a timer fires early) unless `signal` aborts first, which rejects. Delays beyond
 * setTimeout's ceiling are split, so `1e10` (or Infinity) waits that long instead of firing after 1 ms.
 */
async function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!(ms > 0)) {
    return;
  }
  const start = performance.now();
  let left = ms;
  while (left > 0) {
    await delay(Math.min(Math.ceil(left), MAX_TIMER_MS), undefined, { signal });
    left = ms - (performance.now() - start);
  }
}

function pickHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && (INTERESTING_HEADER.test(name) || PLAIN_HEADERS.has(name))) {
      out[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return out;
}

async function readControlJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Read to the end even past the limit. Leaving the loop early destroys the request mid-body: the 400 still goes
  // out marked keep-alive, but the connection never answers its next request (the client then gets ECONNRESET).
  for await (const part of req) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    size += buf.length;
    if (size <= CONTROL_BODY_LIMIT) {
      chunks.push(buf);
    }
  }
  if (size > CONTROL_BODY_LIMIT) {
    throw new Error("control body over 1 MiB");
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text === "" ? {} : (JSON.parse(text) as unknown);
}

function sendControl(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

interface Exchange {
  req: IncomingMessage;
  res: ServerResponse;
  rec: RecordedRequest;
  started: number;
  /** The mock itself closed the connection (reset or shutdown): not a client abort. */
  closedByServer: boolean;
  /** Settles once the last body write reached the socket. */
  flushed: Promise<void>;
}

interface AnswerPlan {
  meta: CompletionMeta;
  /** Headers → first content chunk. */
  firstDelayMs: number;
  pieces: Piece[];
  usage: Usage;
  includeUsage: boolean;
  cut: StreamCut | null;
  fullText: string;
  finishReason: string;
}

export async function createMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const host = opts.host ?? "127.0.0.1";
  const configuredModel = opts.model ?? DEFAULT_MODEL;
  let apiKey = opts.apiKey;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const gtStore = opts.gtDir !== undefined ? new GroundTruthStore(opts.gtDir) : null;
  const replayDir = opts.replayDir !== undefined ? resolve(opts.replayDir) : null;
  const log = opts.log;
  const initialScenario = resolveScenario(parseScenarioPatch(opts.scenario ?? {}));
  const initialHealth = toHealthState(opts.health ?? "ready");

  let scenario = initialScenario;
  let scenarioIndex = 0;
  let health = initialHealth;
  let records: RecordedRequest[] = [];
  let seq = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let marks: MarksReport = { marks: [], slow: [] };
  let slowCounter = 0;
  let closed = false;
  const closing = new AbortController();

  const server = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
    handle(req, res).catch((error: unknown) => {
      log?.(`mock-openai: handler failed: ${errorMessage(error)}`);
      if (!res.headersSent) {
        sendJson(req, res, 500, failureBody({ ...FAILURES.server_error, message: errorMessage(error) }));
      } else if (!res.writableEnded) {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(opts.port ?? 0, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${port}`;

  // ------------------------------------------------------------------------------------------------------------
  // helpers

  async function sleepAtLeast(ms: number): Promise<void> {
    await sleepFor(ms, closing.signal);
  }

  function currentHealth(): HealthAnswer {
    return health.kind === "preset"
      ? healthResponse(health.preset, configuredModel)
      : { status: 200, body: health.payload };
  }

  function elapsed(ex: Exchange): number {
    return Math.round(performance.now() - ex.started);
  }

  function markHeaders(ex: Exchange): void {
    ex.rec.status = ex.res.statusCode;
    ex.rec.headersAtMs = elapsed(ex);
  }

  function usable(res: ServerResponse): boolean {
    return !res.destroyed && !res.writableEnded;
  }

  function respondJson(
    ex: Exchange,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    if (usable(ex.res) && !ex.res.headersSent) {
      sendJson(ex.req, ex.res, status, body, headers);
      markHeaders(ex);
    } else {
      ex.rec.status = status;
      ex.rec.headersAtMs = elapsed(ex);
    }
    ex.rec.outcome = status >= 400 ? "error" : "done";
  }

  function respondError(ex: Exchange, spec: FailSpec, headers: Record<string, string> = {}): void {
    ex.rec.errorCode = spec.code ?? spec.type;
    respondJson(ex, spec.status, failureBody(spec), headers);
  }

  function respondApiError(ex: Exchange, error: MockApiError): void {
    respondError(ex, {
      status: error.status,
      type: error.type,
      message: error.message,
      code: error.code,
      param: error.param,
    });
  }

  function write(ex: Exchange, data: string | Uint8Array): void {
    ex.rec.framesWritten += 1;
    if (usable(ex.res)) {
      ex.flushed = new Promise((resolveWrite) => {
        ex.res.write(data, () => resolveWrite());
      });
    }
  }

  function startStream(ex: Exchange): void {
    ex.res.statusCode = 200;
    if (usable(ex.res) && !ex.res.headersSent) {
      for (const [name, value] of SSE_HEADERS) {
        ex.res.setHeader(name, value);
      }
    }
    markHeaders(ex);
  }

  function end(ex: Exchange, outcome: RequestOutcome): void {
    if (usable(ex.res)) {
      ex.res.end();
    }
    ex.rec.outcome = outcome;
  }

  /**
   * Destroy the connection mid-request, as a crashed server or a dropped network does. What was written goes out
   * first: destroying a socket discards writes it has not flushed yet.
   */
  async function resetConnection(ex: Exchange): Promise<void> {
    ex.closedByServer = true;
    ex.rec.outcome = "reset";
    if (ex.res.destroyed) {
      return;
    }
    await Promise.race([ex.flushed, once(ex.res, "close")]);
    ex.res.destroy();
  }

  function newRecord(req: IncomingMessage, path: string, query: string): RecordedRequest {
    seq += 1;
    const rec: RecordedRequest = {
      seq,
      t: Date.now(),
      method: req.method ?? "GET",
      path,
      query,
      headers: pickHeaders(req),
      bearer: bearerToken(req) !== null,
      authorized: false,
      testUnits: null,
      testUnitsError: null,
      bodyBytes: 0,
      stream: null,
      model: null,
      temperature: null,
      messageRoles: [],
      systemChars: 0,
      systemText: "",
      userTextChars: 0,
      imageCount: 0,
      imageBytes: 0,
      images: [],
      n: null,
      inFlightAtStart: 0,
      scenarioName: null,
      status: 0,
      headersAtMs: null,
      durationMs: null,
      outcome: "pending",
      framesWritten: 0,
      errorCode: null,
      latency: null,
      oracle: null,
      clientAborted: false,
      clientAbortedAtMs: null,
    };
    records.push(rec);
    if (records.length > MAX_RECORDS) {
      records.shift();
    }
    return rec;
  }

  function newExchange(req: IncomingMessage, res: ServerResponse, path: string, query: string): Exchange {
    const ex: Exchange = {
      req,
      res,
      rec: newRecord(req, path, query),
      started: performance.now(),
      closedByServer: false,
      flushed: Promise.resolve(),
    };
    res.on("close", () => {
      if (!res.writableFinished && !ex.closedByServer && !closing.signal.aborted) {
        ex.rec.clientAborted = true;
        ex.rec.clientAbortedAtMs = elapsed(ex);
      }
    });
    return ex;
  }

  function nextScenario(query: URLSearchParams): { scenario: Scenario; index: number } {
    // Parse the override first: a request rejected for a bad ?scenario= must not use up a sequence step.
    const raw = query.get("scenario");
    const override =
      raw === null ? null : parseScenarioPatch(JSON.parse(raw) as unknown, { allowSequence: false });
    const index = scenarioIndex;
    scenarioIndex += 1;
    let effective = scenario;
    const step = scenario.sequence[index];
    if (step !== undefined) {
      effective = applyScenarioPatch(effective, step);
    }
    if (override !== null) {
      effective = applyScenarioPatch(effective, override);
    }
    return { scenario: effective, index };
  }

  // ------------------------------------------------------------------------------------------------------------
  // routing

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? "/";
    const cut = raw.search(/[?#]/);
    const path = cut === -1 ? raw : raw.slice(0, cut);
    const query = cut === -1 || raw[cut] === "#" ? "" : raw.slice(cut).replace(/#.*$/, "");
    if (path.startsWith("/__")) {
      await handleControl(req, res, path, new URLSearchParams(query));
      return;
    }
    if (/^\/slow\/?$/.test(path)) {
      await handleSlow(req, res, path, query);
      return;
    }
    await handleApi(req, res, path, query);
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: string,
  ): Promise<void> {
    const ex = newExchange(req, res, path, query);
    const method = req.method ?? "GET";
    const route = ROUTES.find((r) => r.pattern.test(path));
    const isChat = route?.route === "chat" && method === "POST";
    if (isChat) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      ex.rec.inFlightAtStart = inFlight;
    }
    try {
      const body = await readJsonBody(req, maxBodyBytes);
      ex.rec.bodyBytes = body.bytes;
      if (route === undefined) {
        respondError(ex, invalidUrlError(method, path));
        return;
      }
      const allow = route.allow.join(", ");
      if (method === "OPTIONS") {
        if (usable(res)) {
          res.writeHead(204, { Allow: allow });
          res.end();
        }
        markHeaders(ex);
        ex.rec.outcome = "done";
        return;
      }
      if (!route.allow.includes(method)) {
        respondError(
          ex,
          {
            status: 405,
            type: "invalid_request_error",
            code: "method_not_allowed",
            message: `Method ${method} is not allowed on ${path}; use ${allow}.`,
          },
          { Allow: allow },
        );
        return;
      }
      const auth = checkBearer(req, apiKey);
      ex.rec.authorized = auth === "ok";
      if (auth !== "ok") {
        respondApiError(ex, unauthorizedError(auth));
        return;
      }
      if (route.route === "models") {
        const answer = currentHealth();
        if (answer.status >= 400) {
          const code = prop(prop(answer.body, "error"), "code") ?? prop(prop(answer.body, "error"), "type");
          ex.rec.errorCode = typeof code === "string" ? code : null;
        }
        respondJson(ex, answer.status, answer.body);
        return;
      }
      if (route.route === "model") {
        const id = decodeURIComponent(route.pattern.exec(path)?.[1] ?? "");
        const listed = currentHealth();
        const known = listed.status === 200 && id === configuredModel;
        if (known) {
          respondJson(ex, 200, { id, object: "model", created: 1_700_000_000, owned_by: "mock" });
        } else {
          respondError(ex, {
            ...FAILURES.model_not_found,
            message: `The model '${id}' does not exist or you do not have access to it.`,
          });
        }
        return;
      }
      if (body.kind === "too-large") {
        respondError(ex, {
          ...FAILURES.too_large,
          message: `Request body too large: ${body.bytes} bytes (limit ${maxBodyBytes}).`,
        });
        return;
      }
      if (body.kind === "invalid-json") {
        respondError(ex, {
          status: 400,
          type: "invalid_request_error",
          code: null,
          message: `We could not parse the JSON body of your request: ${body.message}`,
        });
        return;
      }
      await handleChat(ex, body.kind === "json" ? body.value : undefined, new URLSearchParams(query));
    } catch (error) {
      if (closing.signal.aborted) {
        ex.closedByServer = true;
        ex.rec.outcome = "aborted";
        if (!res.destroyed) {
          res.destroy();
        }
        return;
      }
      if (!req.complete) {
        // The client gave up while uploading the body.
        ex.rec.outcome = "aborted";
        return;
      }
      log?.(`mock-openai: ${errorMessage(error)}`);
      if (!res.headersSent) {
        respondError(ex, { ...FAILURES.server_error, message: errorMessage(error) });
      } else {
        ex.rec.outcome = "aborted";
        res.destroy();
      }
    } finally {
      if (isChat) {
        inFlight -= 1;
      }
      ex.rec.durationMs = elapsed(ex);
      log?.(
        `${ex.rec.method} ${ex.rec.path} → ${ex.rec.status} ${ex.rec.outcome} ${ex.rec.durationMs} ms` +
          (ex.rec.scenarioName !== null ? ` [${ex.rec.scenarioName}]` : ""),
      );
    }
  }

  async function handleChat(ex: Exchange, body: unknown, query: URLSearchParams): Promise<void> {
    const { req, rec } = ex;
    let chat: ValidatedChat;
    try {
      chat = validateChatRequest(body);
    } catch (error) {
      if (error instanceof MockApiError) {
        respondApiError(ex, error);
        return;
      }
      throw error;
    }

    let lastUser = -1;
    const systemTexts: string[] = [];
    chat.messages.forEach((message, index) => {
      const role = prop(message, "role");
      const text = contentToText(prop(message, "content"));
      if (role === "system" || role === "developer") {
        rec.systemChars += text.length;
        systemTexts.push(text);
      } else if (role === "user") {
        rec.userTextChars += text.length;
        lastUser = index;
      }
    });
    rec.systemText = systemTexts.join("\n").slice(0, SYSTEM_TEXT_LIMIT);
    // Validated above: every role is one of the supported strings.
    rec.messageRoles = chat.messages.map((message) => prop(message, "role") as string);
    rec.stream = chat.stream;
    rec.model = chat.model;
    rec.temperature = chat.temperature;
    rec.images = chat.images.map((image) => ({ ...image }));
    rec.imageCount = chat.images.length;
    rec.imageBytes = chat.images.reduce((sum, image) => sum + image.bytes, 0);
    rec.n = readTaskN(lastUser >= 0 ? contentToText(prop(chat.messages[lastUser], "content")) : "");

    let effective: { scenario: Scenario; index: number };
    try {
      effective = nextScenario(query);
    } catch (error) {
      respondError(ex, {
        status: 400,
        type: "invalid_request_error",
        code: "mock_scenario",
        message: `invalid ?scenario=: ${errorMessage(error)}`,
      });
      return;
    }
    const sc = effective.scenario;
    rec.scenarioName = sc.name;

    const unitsHeader = header(req, TEST_UNITS_HEADER);
    let testUnits: TestUnit[] | null = null;
    if (unitsHeader !== undefined) {
      try {
        testUnits = decodeTestUnits(unitsHeader);
        rec.testUnits = testUnits;
      } catch (error) {
        rec.testUnitsError = errorMessage(error);
      }
    }

    const meta = newCompletion(chat.model);
    if (sc.failBeforeHeaders !== null) {
      await sleepAtLeast(sc.headersDelayMs);
      respondError(ex, sc.failBeforeHeaders);
      return;
    }
    if (sc.replayFile !== null) {
      await replay(ex, sc, effective.index, chat, meta);
      return;
    }

    const built = await buildAnswer(sc, rec.n, testUnits);
    // A request in the extension's fast mode gets the compact #n|type|translation lines it asked for.
    const answer = rec.systemText.includes(COMPACT_REQUEST)
      ? { ...built, segments: built.segments.map(compactLine) }
      : built;
    rec.oracle = answer.report;
    const latency =
      sc.latencyProfile !== null
        ? sampleLatency(sc.latencyProfile, effective.index, Math.max(0, answer.segments.length - 1))
        : null;
    rec.latency = latency;
    const pieces = planPieces(answer.segments, sc, latency);
    const fullText = answer.segments.join("");
    const plan: AnswerPlan = {
      meta,
      firstDelayMs: sc.firstChunkDelayMs + (latency?.t0Ms ?? 0),
      pieces,
      usage: buildUsage(estimatePromptTokens(chat.messages, chat.images.length), estimateTokens(fullText)),
      includeUsage: chat.includeUsage,
      cut: planCut(sc, pieces.length),
      fullText,
      finishReason: sc.finishReason,
    };
    if (chat.stream) {
      await streamAnswer(ex, sc, plan);
    } else {
      await bufferedAnswer(ex, sc, plan);
    }
  }

  async function buildAnswer(
    sc: Scenario,
    n: number | null,
    testUnits: TestUnit[] | null,
  ): Promise<{ segments: string[]; report: OracleReport | null }> {
    if (sc.empty) {
      return { segments: [], report: null };
    }
    if (sc.text !== null) {
      return { segments: splitLinesKeepEndings(sc.text), report: null };
    }
    if (sc.refusal === true || (typeof sc.refusal === "string" && sc.refusal !== "")) {
      return { segments: [typeof sc.refusal === "string" ? sc.refusal : DEFAULT_REFUSAL], report: null };
    }
    if (sc.garbageOnly) {
      return { segments: withLineEndings(GARBAGE_LINES, sc.lineEnding), report: null };
    }
    let ids: number[];
    let lang = sc.lang;
    let report: OracleReport | null = null;
    let oracleLines = new Map<number, string>();
    if (testUnits !== null) {
      const oracle = await answerFromGroundTruth(testUnits, gtStore, sc.oracleVi, sc.oracleLang);
      report = oracle.report;
      ids = oracle.ids;
      oracleLines = oracle.lines;
      lang = oracle.report.lang ?? lang;
    } else {
      ids = Array.from({ length: n ?? 0 }, (_, i) => i + 1);
    }
    const lines = buildAnswerLines({
      scenario: sc,
      lang,
      ids,
      lineFor: (id) => oracleLines.get(id) ?? placeholderLine(id, lang),
    });
    return { segments: withLineEndings(lines, sc.lineEnding), report };
  }

  /** Where a stream stops early: a reset, an HTTP error (nothing sent yet), an error frame, or a silent end. */
  async function stopEarly(ex: Exchange, cut: StreamCut, started: boolean): Promise<void> {
    if (cut.kind === "reset") {
      await resetConnection(ex);
      return;
    }
    if (!started) {
      respondError(ex, cut.error ?? FAILURES.bad_gateway);
      return;
    }
    if (cut.kind === "error" && cut.error !== null) {
      ex.rec.errorCode = cut.error.code ?? cut.error.type;
      write(ex, sseFrame(failureBody(cut.error)));
      end(ex, "stream-error");
      return;
    }
    end(ex, "truncated");
  }

  async function streamAnswer(ex: Exchange, sc: Scenario, plan: AnswerPlan): Promise<void> {
    const { cut } = plan;
    const count = cut === null ? plan.pieces.length : cut.after;
    await sleepAtLeast(sc.headersDelayMs);
    if (cut?.kind === "reset" && cut.after === 0) {
      await resetConnection(ex);
      return;
    }
    let started = false;
    const start = (): void => {
      if (!started) {
        started = true;
        startStream(ex);
        write(ex, roleChunk(plan.meta));
      }
    };
    if (!sc.lateHeaders) {
      start();
    }
    await sleepAtLeast(plan.firstDelayMs);
    for (const [i, piece] of plan.pieces.slice(0, count).entries()) {
      if (i > 0) {
        await sleepAtLeast(piece.gapMs);
      }
      start();
      write(ex, contentChunk(plan.meta, piece.text));
    }
    if (cut !== null) {
      await stopEarly(ex, cut, started);
      return;
    }
    start();
    write(ex, finishChunk(plan.meta, plan.finishReason));
    if (plan.includeUsage) {
      write(ex, usageChunk(plan.meta, plan.usage));
    }
    write(ex, DONE_FRAME);
    end(ex, "done");
  }

  /** stream:false: nothing is sent before the whole answer is ready. */
  async function bufferedAnswer(ex: Exchange, sc: Scenario, plan: AnswerPlan): Promise<void> {
    const { cut } = plan;
    const count = cut === null ? plan.pieces.length : cut.after;
    await sleepAtLeast(sc.headersDelayMs + plan.firstDelayMs);
    for (const piece of plan.pieces.slice(1, count)) {
      await sleepAtLeast(piece.gapMs);
    }
    if (cut !== null) {
      await stopEarly(ex, cut, false);
      return;
    }
    respondJson(ex, 200, nonStreamBody(plan.meta, plan.fullText, plan.usage, plan.finishReason));
  }

  async function readReplayFile(name: string): Promise<Buffer> {
    if (replayDir === null) {
      throw new Error("replayDir is not configured");
    }
    const file = resolve(replayDir, name);
    if (!isInside(replayDir, file)) {
      throw new Error(`replay file must be inside ${replayDir}`);
    }
    return readFile(file);
  }

  /**
   * A recorded transcript, byte for byte, one write per frame. Timing follows the scenario: the headers and the
   * frames before the first content frame go out after headersDelayMs (with lateHeaders, together with the first
   * content frame), firstChunkDelayMs (+ T0) precedes the first content frame, chunkDelayMs separates content frames,
   * and the frames after the last one (finish, usage, [DONE]) follow at once. Cuts count content frames.
   */
  async function replay(
    ex: Exchange,
    sc: Scenario,
    index: number,
    chat: ValidatedChat,
    meta: CompletionMeta,
  ): Promise<void> {
    let frames: Uint8Array[];
    try {
      frames = splitSseFrames(await readReplayFile(sc.replayFile ?? ""));
      if (frames.length === 0) {
        throw new Error("the file is empty");
      }
    } catch (error) {
      respondError(ex, {
        status: 500,
        type: "server_error",
        code: "mock_replay",
        message: `replay: ${errorMessage(error)}`,
      });
      return;
    }
    const writes = replayWrites(frames);
    const latency = sc.latencyProfile !== null ? sampleLatency(sc.latencyProfile, index, 0) : null;
    ex.rec.latency = latency;
    const firstDelayMs = sc.firstChunkDelayMs + (latency?.t0Ms ?? 0);
    const contentCount = writes.filter((w) => w.content).length;
    const cut = planCut(sc, contentCount);

    if (!chat.stream) {
      const count = cut === null ? contentCount : cut.after;
      await sleepAtLeast(sc.headersDelayMs + firstDelayMs + Math.max(0, count - 1) * sc.chunkDelayMs);
      if (cut !== null) {
        await stopEarly(ex, cut, false);
        return;
      }
      const text = contentOfFrames(frames);
      const usage = buildUsage(estimatePromptTokens(chat.messages, chat.images.length), estimateTokens(text));
      respondJson(ex, 200, nonStreamBody(meta, text, usage));
      return;
    }

    await sleepAtLeast(sc.headersDelayMs);
    if (cut?.kind === "reset" && cut.after === 0) {
      await resetConnection(ex);
      return;
    }
    const firstContent = writes.findIndex((w) => w.content);
    const leadingEnd = firstContent === -1 ? writes.length : firstContent;
    let started = false;
    const start = (): void => {
      if (!started) {
        started = true;
        startStream(ex);
        for (const w of writes.slice(0, leadingEnd)) {
          write(ex, w.bytes);
        }
      }
    };
    if (!sc.lateHeaders) {
      start();
    }
    await sleepAtLeast(firstDelayMs);
    let sent = 0;
    for (const w of writes.slice(leadingEnd)) {
      if (cut !== null && sent >= cut.after) {
        break;
      }
      if (w.content && sent > 0) {
        await sleepAtLeast(sc.chunkDelayMs);
      }
      start();
      write(ex, w.bytes);
      if (w.content) {
        sent += 1;
      }
    }
    if (cut !== null) {
      await stopEarly(ex, cut, started);
      return;
    }
    start();
    end(ex, writes.at(-1)?.done === true ? "done" : "truncated");
  }

  // ------------------------------------------------------------------------------------------------------------
  // mock-only endpoints

  async function handleSlow(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: string,
  ): Promise<void> {
    const params = new URLSearchParams(query);
    const num = (name: string): number => {
      const value = Number(params.get(name) ?? 0);
      return Number.isFinite(value) && value > 0 ? value : 0;
    };
    slowCounter += 1;
    const run: MarksReport["slow"][number] = {
      id: params.get("id") ?? `slow-${slowCounter}`,
      t: Date.now(),
      headersDelayMs: num("headersDelayMs"),
      bodyGapMs: num("bodyGapMs"),
      headersAtMs: null,
      endedAtMs: null,
      aborted: false,
      abortedAtMs: null,
    };
    marks.slow.push(run);
    const ex = newExchange(req, res, path, query);
    const clientGone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        run.aborted = true;
        run.abortedAtMs = elapsed(ex);
        clientGone.abort();
      }
    });
    const signal = AbortSignal.any([closing.signal, clientGone.signal]);
    const wait = (ms: number): Promise<void> => sleepFor(ms, signal);
    const meta = newCompletion(configuredModel);
    try {
      await drainRequest(req);
      await wait(run.headersDelayMs);
      startStream(ex);
      write(ex, roleChunk(meta));
      run.headersAtMs = elapsed(ex);
      await wait(run.bodyGapMs);
      write(ex, contentChunk(meta, "ok"));
      write(ex, finishChunk(meta));
      write(ex, DONE_FRAME);
      end(ex, "done");
      run.endedAtMs = elapsed(ex);
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      ex.rec.outcome = "aborted";
      if (!res.destroyed) {
        res.destroy();
      }
    } finally {
      ex.rec.durationMs = elapsed(ex);
    }
  }

  async function handleControl(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: URLSearchParams,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const route = path.replace(/\/+$/, "");
    try {
      if (route === "/__scenario" && method === "GET") {
        sendControl(res, 200, { scenario });
      } else if (route === "/__scenario" && method === "POST") {
        api.setScenario((await readControlJson(req)) as ScenarioInput); // validated by setScenario
        sendControl(res, 200, { ok: true, scenario });
      } else if (route === "/__health" && method === "GET") {
        sendControl(res, 200, { health: currentHealth() });
      } else if (route === "/__health" && method === "POST") {
        api.setHealth(healthFromJson(await readControlJson(req)));
        sendControl(res, 200, { ok: true, health: currentHealth() });
      } else if (route === "/__requests" && method === "GET") {
        sendControl(res, 200, { requests: api.requests(), maxConcurrency: maxInFlight, inFlight });
      } else if (route === "/__reset" && method === "POST") {
        await drainRequest(req);
        api.reset();
        sendControl(res, 200, { ok: true });
      } else if (route === "/__mark" && (method === "GET" || method === "POST")) {
        const body = method === "POST" ? await readControlJson(req) : {};
        const id = query.get("id") ?? prop(body, "id");
        const e = query.get("e") ?? prop(body, "e");
        const text = (value: unknown): string =>
          typeof value === "string"
            ? value
            : value === undefined || value === null
              ? ""
              : JSON.stringify(value);
        marks.marks.push({ id: text(id), e: text(e), t: Date.now() });
        sendControl(res, 200, { ok: true });
      } else if (route === "/__marks" && method === "GET") {
        sendControl(res, 200, api.marks());
      } else {
        await drainRequest(req);
        sendControl(res, 404, { error: `unknown control endpoint ${method} ${path}` });
      }
    } catch (error) {
      await drainRequest(req);
      if (!res.headersSent) {
        sendControl(res, 400, { error: errorMessage(error) });
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // API

  const api: MockServer = {
    url,
    baseUrl: `${url}/v1`,
    port,
    model: configuredModel,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      closing.abort();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
    setScenario(input) {
      scenario = resolveScenario(parseScenarioPatch(input));
      scenarioIndex = 0;
    },
    scenario: () => structuredClone(scenario),
    setHealth(next) {
      health = toHealthState(next);
    },
    setApiKey(next) {
      apiKey = next;
    },
    health: () => structuredClone(currentHealth()),
    requests: () => structuredClone(records),
    maxConcurrency: () => maxInFlight,
    inFlight: () => inFlight,
    marks: () => structuredClone(marks),
    reset() {
      records = [];
      seq = 0;
      maxInFlight = inFlight;
      scenario = initialScenario;
      scenarioIndex = 0;
      health = initialHealth;
      apiKey = opts.apiKey;
      marks = { marks: [], slow: [] };
      gtStore?.clear();
    },
  };
  return api;
}

export {
  encodeTestUnits,
  decodeTestUnits,
  TEST_UNITS_HEADER,
  type TestUnit,
  type GtPage,
  type GtUnit,
} from "./oracle.ts";
export { MockApiError } from "./request.ts";
export {
  FAILURES,
  HEALTH_PRESETS,
  LATENCY_PRESETS,
  failureBody,
  healthResponse,
  modelsList,
  sampleLatency,
  type FailSpec,
  type FailureName,
  type HealthPreset,
  type LatencyPlan,
  type LatencyProfile,
  type FailInput,
  type Scenario,
  type ScenarioInput,
  type ScenarioPatch,
} from "./scenarios.ts";
export { DEFAULT_MODEL } from "./wire.ts";
