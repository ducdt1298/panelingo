// Scenario knobs, error and readiness presets, the seeded latency model and answer generation for the mock.
// Error presets carry the status, type and code that OpenAI-compatible servers really send, so a client's error
// classification is exercised with realistic bodies.

/** An HTTP error answered before any stream byte, as an OpenAI error body (or `body` verbatim). */
export interface FailSpec {
  status: number;
  type: string;
  message: string;
  code?: string | null;
  param?: string | null;
  /** Served verbatim instead of the OpenAI error object (e.g. `{"error":"..."}` or `{"detail":"..."}`). */
  body?: unknown;
}

/**
 * Request latency model T(n) = T0 + n·tLine: T0 is the time to the first token, tLine the time per answer line.
 * Each value is drawn from a log-normal distribution fitted to its p50/p90; the draws of a request depend only on
 * (seed, request index), so a run replays exactly.
 */
export interface LatencyProfile {
  t0P50: number;
  t0P90: number;
  tLineP50: number;
  tLineP90: number;
  seed: number;
}

/** Delays sampled for one request: T0 before the first token, then one gap before each later answer line. */
export interface LatencyPlan {
  t0Ms: number;
  lineMs: number[];
}

/** How the oracle writes the translation field (see oracle.ts oracleVi). */
export type OracleViStyle = "safe" | "echo";

/**
 * What the next chat requests get. Content precedence: failBeforeHeaders, replayFile, empty, text, refusal,
 * garbageOnly, then generated lines (ground-truth lines when the request carries x-ctv-test-units). Id faults
 * (missing, duplicate, unknown) and appendLines apply to generated lines.
 *
 * Timeline of a stream: headersDelayMs, then the headers and the role chunk (held back with lateHeaders), then
 * firstChunkDelayMs (+ the sampled T0) before the first content chunk, chunkDelayMs between content chunks, then
 * the finish chunk, the usage chunk when requested, and `data: [DONE]`. The stream stops early where
 * dropAfterChunks, resetAfterChunks or errorFrame say.
 */
export interface Scenario {
  /** Label stored on every recorded request. */
  name: string;
  /** Wait before the response starts: stream headers, a JSON completion or a JSON error. */
  headersDelayMs: number;
  /**
   * Hold the headers and the role chunk until the first content chunk is ready, as some proxies and local servers
   * do: fetch() then resolves only with the first token. A stream that stops before any content is then answered
   * as an HTTP error instead (errorFrame's status, else 502).
   */
  lateHeaders: boolean;
  /** Wait between the headers and the first content chunk (time to first token). Added to the sampled T0. */
  firstChunkDelayMs: number;
  /** Wait between consecutive content chunks. */
  chunkDelayMs: number;
  /** Code points per content chunk (one chunk = one `delta.content`). */
  chunkChars: number;
  /** Answer with this HTTP error, after headersDelayMs, instead of a completion. */
  failBeforeHeaders: FailSpec | null;
  /**
   * End the stream cleanly but early, without finish chunk, usage or [DONE], after this many content chunks (or after
   * the last one, if fewer). A request with `stream: false` gets an HTTP error instead. In replay mode it counts the
   * recorded content frames.
   */
  dropAfterChunks: number | null;
  /**
   * Destroy the connection after this many content chunks (or after the last one, if fewer); 0 drops it before the
   * response starts, so fetch() itself rejects.
   */
  resetAfterChunks: number | null;
  /**
   * Send an in-stream error frame `data: {"error":{...}}` where the stream stops (after dropAfterChunks content
   * chunks, or after the last one), then end without [DONE].
   */
  errorFrame: FailSpec | null;
  /** finish_reason of the finish chunk ("stop", "length", "content_filter"...). */
  finishReason: string;
  /** Prose and a code fence, no `#`/`@` line. */
  garbageOnly: boolean;
  /** Ids left out of the answer. */
  missingIds: number[];
  /** Ids answered twice: the second line carries a different translation, so "first wins" is observable. */
  duplicateIds: number[];
  /** Extra lines with these ids (outside the requested set), after the requested ones. */
  unknownIds: number[];
  /** `true` (or a custom sentence) answers with a refusal sentence instead of lines. */
  refusal: boolean | string;
  /** No text at all: HTTP 200 with the role chunk, finish chunk and [DONE] only. */
  empty: boolean;
  /** Sampled T0 before the first token and a gap before every later line, seeded by the request index. */
  latencyProfile: LatencyProfile | null;
  /**
   * Stream this recorded .sse file (path relative to replayDir) byte for byte, one write per frame; chunkDelayMs
   * separates content frames.
   */
  replayFile: string | null;
  /** Exact answer text to stream instead of generated lines (CRLF, fences, separators... are kept). */
  text: string | null;
  /** Language on the `@lang` line when no ground truth says otherwise. */
  lang: string;
  /** Lines appended after the `#` lines, e.g. `@term|…` or `@sum|…`. */
  appendLines: string[];
  /** Line separator of the generated answer (the last line never has one). */
  lineEnding: "\n" | "\r\n";
  /** Oracle translation style: "safe" passes the engine's validation, "echo" is `VI:<original>` verbatim. */
  oracleVi: OracleViStyle;
  /**
   * Oracle answers use the ground truth's reference in this language (`refs.<lang>`, verbatim) where a unit has
   * one; null (default) or a unit without one: oracleVi.
   */
  oracleLang: string | null;
  /** Per-request overrides: step k applies to the k-th chat request after setScenario/reset; then the base. */
  sequence: ScenarioStep[];
}

export type ScenarioStep = Partial<Omit<Scenario, "sequence">>;
/** A validated partial scenario (what parseScenarioPatch returns). */
export type ScenarioPatch = Partial<Scenario>;

/** A FAILURES name, or an error whose type defaults to "invalid_request_error". */
export type FailInput = FailureName | (Omit<FailSpec, "type"> & { type?: string });
interface LooseFields {
  failBeforeHeaders?: FailInput | null;
  errorFrame?: FailInput | null;
  /** A profile or a LATENCY_PRESETS name. */
  latencyProfile?: LatencyProfile | keyof typeof LATENCY_PRESETS | null;
  lineEnding?: "\n" | "\r\n" | "lf" | "crlf";
}
export type ScenarioStepInput = Partial<Omit<Scenario, "sequence" | keyof LooseFields>> & LooseFields;
/** What setScenario and the scenario option accept: a patch that may name presets; validated by parseScenarioPatch. */
export type ScenarioInput = ScenarioStepInput & { sequence?: ScenarioStepInput[] };

export function defaultScenario(): Scenario {
  return {
    name: "default",
    headersDelayMs: 0,
    lateHeaders: false,
    firstChunkDelayMs: 0,
    chunkDelayMs: 0,
    chunkChars: 16,
    failBeforeHeaders: null,
    dropAfterChunks: null,
    resetAfterChunks: null,
    errorFrame: null,
    finishReason: "stop",
    garbageOnly: false,
    missingIds: [],
    duplicateIds: [],
    unknownIds: [],
    refusal: false,
    empty: false,
    latencyProfile: null,
    replayFile: null,
    text: null,
    lang: "ko",
    appendLines: [],
    lineEnding: "\n",
    oracleVi: "safe",
    oracleLang: null,
    sequence: [],
  };
}

/** Copy `base` and overwrite every key the patch defines (undefined keys are skipped). */
export function applyScenarioPatch(base: Scenario, patch: ScenarioPatch): Scenario {
  const next = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      next[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
    }
  }
  return next as unknown as Scenario;
}

export function resolveScenario(patch: ScenarioPatch = {}): Scenario {
  return applyScenarioPatch(defaultScenario(), patch);
}

/** Where a stream stops early, and how. */
export interface StreamCut {
  kind: "drop" | "reset" | "error";
  /** Content chunks sent before the cut. */
  after: number;
  /** The in-stream (or, before any content with lateHeaders, HTTP) error of an "error" cut. */
  error: FailSpec | null;
}

/** The cut a scenario asks for, given the number of content chunks the answer has; null for a complete stream. */
export function planCut(scenario: Scenario, contentChunks: number): StreamCut | null {
  const drop = scenario.dropAfterChunks;
  const reset = scenario.resetAfterChunks;
  if (reset !== null && (drop === null || reset <= drop)) {
    return { kind: "reset", after: Math.min(reset, contentChunks), error: null };
  }
  if (drop !== null) {
    return {
      kind: scenario.errorFrame !== null ? "error" : "drop",
      after: Math.min(drop, contentChunks),
      error: scenario.errorFrame,
    };
  }
  if (scenario.errorFrame !== null) {
    return { kind: "error", after: contentChunks, error: scenario.errorFrame };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP errors (OpenAI error bodies)

export const FAILURES = {
  /** Missing or wrong API key. */
  unauthorized: {
    status: 401,
    type: "invalid_request_error",
    code: "invalid_api_key",
    message: "Incorrect API key provided.",
  },
  /** The key is valid but may not use this model or endpoint. */
  forbidden: {
    status: 403,
    type: "invalid_request_error",
    code: "permission_denied",
    message: "You do not have access to this model.",
  },
  model_not_found: {
    status: 404,
    type: "invalid_request_error",
    code: "model_not_found",
    param: "model",
    message: "The model does not exist or you do not have access to it.",
  },
  /** A model without image input. */
  no_vision: {
    status: 400,
    type: "invalid_request_error",
    code: null,
    param: "messages",
    message: "Invalid content type. image_url is only supported by certain models.",
  },
  bad_request: {
    status: 400,
    type: "invalid_request_error",
    code: null,
    message: "Invalid request.",
  },
  context_length: {
    status: 400,
    type: "invalid_request_error",
    code: "context_length_exceeded",
    param: "messages",
    message:
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens. Please reduce the length of the messages.",
  },
  /** Prompt rejected by the provider's content filter (Azure OpenAI style). */
  content_filter: {
    status: 400,
    type: "invalid_request_error",
    code: "content_filter",
    param: "prompt",
    message:
      "The response was filtered due to the prompt triggering the content management policy. Please modify your prompt and retry.",
  },
  too_large: {
    status: 413,
    type: "invalid_request_error",
    code: "request_too_large",
    message: "Request body too large.",
  },
  rate_limit: {
    status: 429,
    type: "requests",
    code: "rate_limit_exceeded",
    message: "Rate limit reached for requests. Please try again in 2s.",
  },
  /** Billing problem: retrying does not help. */
  insufficient_quota: {
    status: 429,
    type: "insufficient_quota",
    code: "insufficient_quota",
    message: "You exceeded your current quota, please check your plan and billing details.",
  },
  server_error: {
    status: 500,
    type: "server_error",
    code: null,
    message: "The server had an error while processing your request. Sorry about that!",
  },
  bad_gateway: {
    status: 502,
    type: "server_error",
    code: "bad_gateway",
    message: "Bad gateway: the upstream connection closed before the response completed.",
  },
  overloaded: {
    status: 503,
    type: "server_error",
    code: "service_unavailable",
    message: "The engine is currently overloaded, please try again later.",
  },
  timeout: {
    status: 504,
    type: "server_error",
    code: "timeout",
    message: "Gateway timeout: the model did not answer in time.",
  },
} as const satisfies Record<string, FailSpec>;

export type FailureName = keyof typeof FAILURES;

export function isFailureName(value: unknown): value is FailureName {
  return typeof value === "string" && Object.hasOwn(FAILURES, value);
}

// ---------------------------------------------------------------------------------------------------------------
// GET /v1/models (readiness check)

export const HEALTH_PRESETS = ["ready", "unauthorized", "no-models-route", "server-error"] as const;
export type HealthPreset = (typeof HEALTH_PRESETS)[number];

export function isHealthPreset(value: unknown): value is HealthPreset {
  return typeof value === "string" && (HEALTH_PRESETS as readonly string[]).includes(value);
}

/** OpenAI's answer to an unknown route. */
export function invalidUrlError(method: string, path: string): FailSpec {
  return {
    status: 404,
    type: "invalid_request_error",
    code: null,
    message: `Invalid URL (${method} ${path})`,
  };
}

/** The model list GET /v1/models serves when ready. */
export function modelsList(model: string): { object: "list"; data: Array<Record<string, unknown>> } {
  return { object: "list", data: [{ id: model, object: "model", created: 1_700_000_000, owned_by: "mock" }] };
}

/**
 * What GET /v1/models answers for a preset: `ready` → 200 with the configured model; `unauthorized` → 401
 * invalid_api_key; `no-models-route` → 404, as servers without the route answer; `server-error` → 500.
 */
export function healthResponse(preset: HealthPreset, model: string): { status: number; body: unknown } {
  switch (preset) {
    case "ready":
      return { status: 200, body: modelsList(model) };
    case "unauthorized":
      return { status: 401, body: failureBody(FAILURES.unauthorized) };
    case "no-models-route":
      return { status: 404, body: failureBody(invalidUrlError("GET", "/v1/models")) };
    case "server-error":
      return { status: 500, body: failureBody(FAILURES.server_error) };
  }
}

/** The body an HTTP error is answered with: `spec.body` verbatim, else the OpenAI error object. */
export function failureBody(spec: FailSpec): unknown {
  if (spec.body !== undefined) {
    return spec.body;
  }
  return {
    error: { message: spec.message, type: spec.type, param: spec.param ?? null, code: spec.code ?? null },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Seeded latency

/** Typical timings: a slow cloud vision model, and a fast one for demos. */
export const LATENCY_PRESETS = {
  cloud: { t0P50: 10_000, t0P90: 18_000, tLineP50: 800, tLineP90: 1_100, seed: 1 },
  fast: { t0P50: 1_200, t0P90: 2_500, tLineP50: 120, tLineP90: 250, seed: 1 },
} as const satisfies Record<string, LatencyProfile>;

/** mulberry32: small, fast, good enough for test timing. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent stream per request index (murmur3 finalizer over seed and index). */
function requestSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const Z90 = 1.2815515655446004;

function standardNormal(rng: () => number): number {
  let u = 0;
  while (u === 0) {
    u = rng();
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Log-normal draw with the given median and 90th percentile, in whole ms, capped at 10 × p90. */
export function sampleLogNormal(rng: () => number, p50: number, p90: number): number {
  const z = standardNormal(rng);
  if (!(p50 > 0)) {
    return 0;
  }
  const sigma = p90 > p50 ? Math.log(p90 / p50) / Z90 : 0;
  return Math.round(Math.min(p50 * Math.exp(sigma * z), Math.max(p50, p90) * 10));
}

/** Delays for the request with this index: T0, then one gap per answer line after the first. */
export function sampleLatency(profile: LatencyProfile, requestIndex: number, lineGaps: number): LatencyPlan {
  const rng = createRng(requestSeed(profile.seed, requestIndex));
  const t0Ms = sampleLogNormal(rng, profile.t0P50, profile.t0P90);
  const lineMs: number[] = [];
  for (let i = 0; i < lineGaps; i++) {
    lineMs.push(sampleLogNormal(rng, profile.tLineP50, profile.tLineP90));
  }
  return { t0Ms, lineMs };
}

// ---------------------------------------------------------------------------------------------------------------
// Answers in the extension's line protocol (`@lang|<code>`, then `#n|type|speaker|original|translation`)

export const DEFAULT_REFUSAL = "I'm sorry, but I can't help with translating this image.";

/** Original prose: no `#`/`@` line and nothing the refusal patterns match. */
export const GARBAGE_LINES: readonly string[] = [
  "Sure, here is what I can see in this picture:",
  "```",
  "A tall page with rounded speech balloons and a wide caption box near the top.",
  "```",
  "The lettering inside the balloons is too small for me to read reliably.",
];

/** Upper bound on N so a typo in a prompt cannot make the mock stream megabytes. */
export const MAX_IDS = 500;

const PLACEHOLDER_ORIGINAL: Record<string, string> = {
  ko: "시험 문장",
  ja: "テスト文",
  zh: "测试句子",
  en: "TEST LINE",
};

export function placeholderOriginal(n: number, lang: string): string {
  return `${PLACEHOLDER_ORIGINAL[lang] ?? PLACEHOLDER_ORIGINAL["ko"] ?? ""} ${n}`;
}

/** Placeholder translation (Vietnamese: "test dialogue line number n"). */
export function placeholderVi(n: number): string {
  return `Câu thoại thử nghiệm số ${n}`;
}

/** `#n|dialogue||<original placeholder>|<translation placeholder>`. */
export function placeholderLine(n: number, lang: string): string {
  return `#${n}|dialogue||${placeholderOriginal(n, lang)}|${placeholderVi(n)}`;
}

/** The repeated line of a duplicate id: same id and fields, a different translation ("repeat" in Vietnamese). */
export function duplicateLine(line: string): string {
  return `${line} (bản lặp)`;
}

/** Read N from the task text ("N = 16"); falls back to "#1 to #16". Null when absent. */
export function readTaskN(text: string): number | null {
  let n: number | null = null;
  for (const match of text.matchAll(/\bN\s*=\s*(\d{1,4})\b/g)) {
    n = Number(match[1]);
  }
  if (n === null) {
    const range = /#1\s+to\s+#(\d{1,4})\b/i.exec(text);
    if (range) {
      n = Number(range[1]);
    }
  }
  return n === null ? null : Math.min(n, MAX_IDS);
}

/** `@lang`, the answer lines for `ids` with the scenario's id faults, then the appended lines. */
export function buildAnswerLines(input: {
  scenario: Scenario;
  lang: string;
  ids: readonly number[];
  lineFor(id: number): string;
}): string[] {
  const { scenario } = input;
  const missing = new Set(scenario.missingIds);
  const duplicates = new Set(scenario.duplicateIds);
  const lines = [`@lang|${input.lang}`];
  for (const id of input.ids) {
    if (missing.has(id)) {
      continue;
    }
    const line = input.lineFor(id);
    lines.push(line);
    if (duplicates.has(id)) {
      lines.push(duplicateLine(line));
    }
  }
  for (const id of scenario.unknownIds) {
    lines.push(placeholderLine(id, input.lang));
  }
  lines.push(...scenario.appendLines);
  return lines;
}

/** Lines → stream segments, each line carrying its separator (the last one carries none). */
export function withLineEndings(lines: readonly string[], ending: string): string[] {
  return lines.map((line, i) => (i < lines.length - 1 ? line + ending : line));
}

/** Split text into lines, each keeping its own terminator (LF, CRLF or CR). */
export function splitLinesKeepEndings(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
}

/** Split into pieces of `size` code points (never inside a surrogate pair). */
export function splitCodePoints(text: string, size: number): string[] {
  const out: string[] = [];
  const step = Math.max(1, Math.floor(size));
  let current = "";
  let count = 0;
  for (const ch of text) {
    current += ch;
    count += 1;
    if (count >= step) {
      out.push(current);
      current = "";
      count = 0;
    }
  }
  if (current) {
    out.push(current);
  }
  return out;
}

export interface Piece {
  text: string;
  /** Wait before this piece; the first piece waits the first-token delay instead (0 here). */
  gapMs: number;
}

/**
 * Content chunks of a generated answer. Without a latency profile the whole text is cut every `chunkChars` code
 * points (a chunk may span two lines, as real token streams do). With one, each line is cut on its own and its first
 * chunk waits that line's sampled gap.
 */
export function planPieces(
  segments: readonly string[],
  scenario: Scenario,
  latency: LatencyPlan | null,
): Piece[] {
  const pieces: Piece[] = [];
  if (latency === null) {
    for (const text of splitCodePoints(segments.join(""), scenario.chunkChars)) {
      pieces.push({ text, gapMs: pieces.length === 0 ? 0 : scenario.chunkDelayMs });
    }
    return pieces;
  }
  segments.forEach((segment, line) => {
    splitCodePoints(segment, scenario.chunkChars).forEach((text, k) => {
      const lineGap = k === 0 && line > 0 ? (latency.lineMs[line - 1] ?? 0) : 0;
      pieces.push({ text, gapMs: pieces.length === 0 ? 0 : scenario.chunkDelayMs + lineGap });
    });
  });
  return pieces;
}

// ---------------------------------------------------------------------------------------------------------------
// JSON → ScenarioPatch (control endpoint, CLI, ?scenario= query)

type Check = (value: unknown, key: string) => unknown;

function fail(key: string, expected: string): never {
  throw new Error(`${key} must be ${expected}`);
}

const numberAtLeast =
  (min: number): Check =>
  (value, key) =>
    typeof value === "number" && Number.isFinite(value) && value >= min
      ? value
      : fail(key, `a number >= ${min}`);

const integerAtLeast =
  (min: number): Check =>
  (value, key) =>
    Number.isInteger(value) && (value as number) >= min ? value : fail(key, `an integer >= ${min}`);

const isBoolean: Check = (value, key) => (typeof value === "boolean" ? value : fail(key, "a boolean"));
const isString: Check = (value, key) => (typeof value === "string" ? value : fail(key, "a string"));
const nonEmptyString: Check = (value, key) =>
  typeof value === "string" && value !== "" ? value : fail(key, "a non-empty string");

const nullable =
  (check: Check): Check =>
  (value, key) =>
    value === null ? null : check(value, key);

const integerList: Check = (value, key) =>
  Array.isArray(value) && value.every((v) => Number.isInteger(v))
    ? [...(value as number[])]
    : fail(key, "an array of integers");

const stringList: Check = (value, key) =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? [...value]
    : fail(key, "an array of strings");

const optionalString = (value: unknown, key: string): string | null =>
  value === undefined || value === null ? null : (isString(value, key) as string);

/** A FAILURES name, or `{status, message, type?, code?, param?, body?}`. */
export function parseFailSpec(value: unknown, key = "failure"): FailSpec {
  if (isFailureName(value)) {
    return FAILURES[value];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(
      key,
      `a FAILURES name (${Object.keys(FAILURES).join(", ")}) or {status, message, type?, code?, param?, body?}`,
    );
  }
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (!Number.isInteger(status) || (status as number) < 400 || (status as number) > 599) {
    return fail(`${key}.status`, "an integer HTTP error status (400-599)");
  }
  const spec: FailSpec = {
    status: status as number,
    type:
      record["type"] === undefined
        ? "invalid_request_error"
        : (isString(record["type"], `${key}.type`) as string),
    message: isString(record["message"], `${key}.message`) as string,
    code: optionalString(record["code"], `${key}.code`),
    param: optionalString(record["param"], `${key}.param`),
  };
  if (record["body"] !== undefined) {
    spec.body = record["body"];
  }
  return spec;
}

function parseLatency(value: unknown, key: string): LatencyProfile {
  if (typeof value === "string" && Object.hasOwn(LATENCY_PRESETS, value)) {
    return { ...LATENCY_PRESETS[value as keyof typeof LATENCY_PRESETS] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(
      key,
      `{t0P50, t0P90, tLineP50, tLineP90, seed} or a LATENCY_PRESETS name (${Object.keys(LATENCY_PRESETS).join(", ")})`,
    );
  }
  const record = value as Record<string, unknown>;
  const nonNegative = numberAtLeast(0);
  return {
    t0P50: nonNegative(record["t0P50"], `${key}.t0P50`) as number,
    t0P90: nonNegative(record["t0P90"], `${key}.t0P90`) as number,
    tLineP50: nonNegative(record["tLineP50"], `${key}.tLineP50`) as number,
    tLineP90: nonNegative(record["tLineP90"], `${key}.tLineP90`) as number,
    seed: integerAtLeast(0)(record["seed"] ?? 1, `${key}.seed`) as number,
  };
}

const FIELDS: Record<keyof Scenario, Check> = {
  name: isString,
  headersDelayMs: numberAtLeast(0),
  lateHeaders: isBoolean,
  firstChunkDelayMs: numberAtLeast(0),
  chunkDelayMs: numberAtLeast(0),
  chunkChars: integerAtLeast(1),
  failBeforeHeaders: nullable(parseFailSpec),
  dropAfterChunks: nullable(integerAtLeast(0)),
  resetAfterChunks: nullable(integerAtLeast(0)),
  errorFrame: nullable(parseFailSpec),
  finishReason: nonEmptyString,
  garbageOnly: isBoolean,
  missingIds: integerList,
  duplicateIds: integerList,
  unknownIds: integerList,
  refusal: (value, key) =>
    typeof value === "boolean" || typeof value === "string" ? value : fail(key, "a boolean or a string"),
  empty: isBoolean,
  latencyProfile: nullable(parseLatency),
  replayFile: nullable(isString),
  text: nullable(isString),
  lang: isString,
  appendLines: stringList,
  lineEnding: (value, key) => {
    if (value === "\n" || value === "lf") return "\n";
    if (value === "\r\n" || value === "crlf") return "\r\n";
    return fail(key, '"\\n" or "\\r\\n"');
  },
  oracleVi: (value, key) => (value === "safe" || value === "echo" ? value : fail(key, '"safe" or "echo"')),
  oracleLang: nullable(nonEmptyString),
  sequence: (value, key) =>
    Array.isArray(value)
      ? (value as unknown[]).map((step, i) =>
          parseScenarioPatch(step, { allowSequence: false, path: `${key}[${i}]` }),
        )
      : fail(key, "an array of scenario patches"),
};

/** Validate untrusted JSON into a patch. Unknown keys are errors, so typos do not silently do nothing. */
export function parseScenarioPatch(
  input: unknown,
  options: { allowSequence?: boolean; path?: string } = {},
): ScenarioPatch {
  const path = options.path ?? "scenario";
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${path} must be a JSON object`);
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(FIELDS, key) || (key === "sequence" && options.allowSequence === false)) {
      throw new Error(`${path}: unknown field "${key}"`);
    }
    if (value === undefined) {
      continue;
    }
    const check = FIELDS[key as keyof Scenario];
    try {
      patch[key] = check(value, key);
    } catch (error) {
      throw new Error(`${path}.${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return patch;
}
