// src/engine/translator.ts with a scripted fake transport (OpenAI-shaped SSE and recorded gpt-5.2 transcripts), a
// manual clock, a fake ApiHealth and a fake composite builder. No network.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { TransportInit, TransportResponse } from "../../../src/engine/api-client.ts";
import { encodeTestUnits, JPEG_DATA_URL_PREFIX } from "../../../src/engine/composite.ts";
import type {
  ApiHealth,
  Clock,
  CompositeBuilder,
  CompositeFail,
  CompositeOk,
  CompositeRequest,
  PackMemory,
  PackReport,
  PackUnit,
  ServiceFactories,
  SettingsSource,
  TranslatePack,
  UnitResult,
} from "../../../src/engine/contracts.ts";
import {
  CONTEXT_NEIGHBOURS,
  createTranslator,
  FAST_JPEG_QUALITY,
  MAX_PAUSES_PER_REQUEST,
  promptTarget,
  type TranslatorDeps,
} from "../../../src/engine/translator.ts";
import { createLogger } from "../../../src/platform/log.ts";
import type { HealthReading } from "../../../src/shared/core/health.ts";
import {
  COMPACT_ITEM_LINE,
  cropsOnlyLine,
  GLOSSARY_HEADER,
  KOREAN_BLOCK,
  pronounsHeader,
  PRONOUNS_LEGEND,
  systemAskSummary,
  systemIntro,
  USER_HISTORY_HEADER,
  USER_SUMMARY_HEADER,
  VIETNAMESE,
  VIETNAMESE_STYLE,
  type ChatMessage,
  type PromptTarget,
} from "../../../src/shared/core/prompt.ts";
import { UNAUTHORIZED_PROBE_MS } from "../../../src/shared/core/retry-policy.ts";
import { createChatStreamDecoder } from "../../../src/shared/core/sse.ts";
import { CtvError, type ErrorInfo } from "../../../src/shared/errors.ts";
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from "../../../src/shared/settings.ts";
import type { LogEntry, UnitGeometry } from "../../../src/shared/types.ts";
import { toBase64 } from "../../../src/shared/wire.ts";
import { decodeTestUnits } from "../../../tools/mock-openai/oracle.ts";

// Compile-time contract: the factory fits ServiceFactories (its extra deps are optional).
type Assert<T extends true> = T;
export type _FactoryFits = Assert<
  typeof createTranslator extends ServiceFactories["createTranslator"] ? true : false
>;

const SSE_DIR = new URL("../../fixtures/sse/", import.meta.url);
/** Never a real provider: the transport below is fake and asserts this prefix. */
const BASE_URL = "http://api.invalid/v1";
const API_KEY = "sk-test";
const JPEG = Uint8Array.from({ length: 1000 }, (_, i) => (i < 3 ? ([0xff, 0xd8, 0xff][i] ?? 0) : i % 251));

// ---- Time ----

async function idle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

class ManualClock implements Clock {
  t = 1_000_000;
  private seq = 0;
  private readonly timers: Array<{ at: number; ms: number; seq: number; fn: () => void; live: boolean }> = [];

  readonly now = (): number => this.t;

  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, ms, seq: this.seq, fn, live: true };
    this.seq += 1;
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  /** Delays (ms) of the timers still pending. */
  pending(): number[] {
    return this.timers.filter((timer) => timer.live).map((timer) => timer.ms);
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await idle();
      const due = this.timers
        .filter((timer) => timer.live && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.t = due.at;
      due.live = false;
      due.fn();
    }
    this.t = target;
    await idle();
  }
}

// ---- Fakes: health, composite, settings ----

class FakeHealth implements ApiHealth {
  ready = true;
  /** report() pauses (like the real monitor for network, key and configuration errors). */
  pauseOnReport = true;
  reports: ErrorInfo[] = [];
  waits = 0;
  private waiters: Array<() => void> = [];

  reading(): HealthReading {
    return {
      readiness: this.ready ? "ready" : "unreachable",
      model: DEFAULT_SETTINGS.api.model,
      cause: null,
    };
  }
  sendable(): boolean {
    return this.ready;
  }
  whenSendable(): Promise<void> {
    this.waits += 1;
    return this.ready ? Promise.resolve() : new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  report(error: ErrorInfo): void {
    this.reports.push(error);
    if (this.pauseOnReport) this.ready = false;
  }
  checkedAt(): number {
    return 0;
  }
  resume(): void {
    this.ready = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
  setBusy(): void {}
  refresh(): Promise<HealthReading> {
    return Promise.resolve(this.reading());
  }
  onChange(): () => void {
    return () => undefined;
  }
  stop(): void {}
}

interface BuildCall {
  mode: CompositeRequest["mode"];
  units: string[];
  quality: number;
  profile: string;
}

class FakeComposite implements CompositeBuilder {
  calls: BuildCall[] = [];
  failWhen: (request: CompositeRequest) => CompositeFail["reason"] | null = () => null;
  throwWhen: (request: CompositeRequest) => boolean = () => false;

  build(request: CompositeRequest): Promise<CompositeOk | CompositeFail> {
    this.calls.push({
      mode: request.mode,
      units: request.units.map((u) => u.src),
      quality: request.jpegQuality,
      profile: request.profile.id,
    });
    if (this.throwWhen(request)) return Promise.reject(new CtvError("engine.internal", "composite exploded"));
    const reason = this.failWhen(request);
    if (reason !== null) return Promise.resolve({ ok: false, reason });
    return Promise.resolve({
      ok: true,
      jpeg: JPEG,
      dataUrl: JPEG_DATA_URL_PREFIX + toBase64(JPEG),
      size: { w: 2048, h: 768 },
      marks: request.units.map((u, i) => ({ n: i + 1, contentKey: u.contentKey, unitKey: u.unitKey })),
      testUnits: encodeTestUnits(request.units),
    });
  }
}

function settingsSource(settings: Settings): SettingsSource {
  return {
    current: () => settings,
    site: () => {
      throw new Error("not used");
    },
    sites: () => ({}),
    apply: () => undefined,
    onChange: () => () => undefined,
  };
}

// ---- The pack: ko-p01's nine units (ground-truth text; the images are never read) ----

const KO = [
  { type: "narration", original: "다음 날 아침", translation: "Sáng hôm sau" },
  {
    type: "dialogue",
    original: "일곱 시에 역 앞에서 보자.",
    translation: "Bảy giờ gặp nhau trước nhà ga nhé.",
  },
  {
    type: "dialogue",
    original: "이 지도엔 마을 절반밖에 없잖아!",
    translation: "Tấm bản đồ này chỉ có một nửa thị trấn thôi!",
  },
  {
    type: "thought",
    original: "비가 그칠 때까지 기다릴까…",
    translation: "Hay là đợi mưa tạnh rồi hẵng đi…",
  },
  { type: "sign", original: "오늘 휴업", translation: "Hôm nay nghỉ" },
  { type: "sfx", original: "쾅!", translation: "ẦM!" },
  {
    type: "dialogue",
    original: "서둘러, 가게가 십 분 뒤에 닫아!",
    translation: "Nhanh lên, mười phút nữa cửa hàng đóng cửa rồi!",
  },
  { type: "dialogue", original: "잠깐, 지갑을 두고 왔어!", translation: "Khoan đã, mình quên ví rồi!" },
  { type: "ignore", original: "12", translation: "" },
] as const;

function packUnit(i: number): PackUnit {
  const text = { x1: 100, y1: 100 + 150 * i, x2: 300, y2: 160 + 150 * i };
  const geometry: UnitGeometry = {
    unitKey: `k${i + 1}`,
    kind: "bubble",
    bubble: null,
    text,
    texts: [text],
    orientation: "h",
    glyphPx: 28,
    order: i,
  };
  return {
    contentKey: "s:page",
    unitKey: `k${i + 1}`,
    geometry,
    imageSize: { w: 1200, h: 1800 },
    script: "hangul",
    src: `u${i + 1}`,
  };
}

function makePack(count: number = KO.length, extra: Partial<TranslatePack> = {}): TranslatePack {
  return {
    packId: "pack-1",
    frameKey: "7:0:doc",
    seriesKey: null,
    lang: "ko",
    dir: "ltr",
    units: Array.from({ length: count }, (_, i) => packUnit(i)),
    urgent: false,
    images: new Map(),
    ...extra,
  };
}

// ---- Transport: OpenAI-shaped SSE, JSON errors, recorded transcripts ----

const ENVELOPE = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 1_760_000_000,
  model: "gpt-4o-mini-2024-07-18",
};
const encoder = new TextEncoder();

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function contentFrame(text: string): string {
  return frame({ ...ENVELOPE, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

function endFrames(): string[] {
  return [
    frame({
      ...ENVELOPE,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
    frame({ ...ENVELOPE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ];
}

/** Role chunk, the text in 24-character content chunks, then usage, stop and [DONE] unless cut. */
function sseFrames(text: string, done = true): string[] {
  const frames = [
    frame({ ...ENVELOPE, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
  ];
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 24) frames.push(contentFrame(chars.slice(i, i + 24).join("")));
  if (done) frames.push(...endFrames());
  return frames;
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
    headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
    body,
    text: () => Promise.resolve(text),
  };
}

function streamOf(frames: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

function sse(text: string, done = true): TransportResponse {
  return response(200, streamOf(sseFrames(text, done)));
}

/** An OpenAI-compatible JSON error returned before any SSE byte: {"error":{"message","type","code"}}. */
interface FailSpec {
  status: number;
  message: string;
  type?: string;
  code?: string;
}

/** Error answers in the shapes OpenAI-compatible providers send (messages shortened). */
const FAILURES = {
  invalid_api_key: {
    status: 401,
    type: "invalid_request_error",
    code: "invalid_api_key",
    message: "Incorrect API key provided: sk-test***.",
  },
  forbidden: {
    status: 403,
    type: "invalid_request_error",
    code: "unsupported_country_region_territory",
    message: "Country, region, or territory not supported",
  },
  rate_limit: {
    status: 429,
    type: "requests",
    code: "rate_limit_exceeded",
    message: "Rate limit reached for gpt-4o-mini on requests per min (RPM).",
  },
  insufficient_quota: {
    status: 429,
    type: "insufficient_quota",
    code: "insufficient_quota",
    message: "You exceeded your current quota, please check your plan and billing details.",
  },
  context_length: {
    status: 400,
    type: "invalid_request_error",
    code: "context_length_exceeded",
    message: "This model's maximum context length is 128000 tokens.",
  },
  content_filter: {
    status: 400,
    type: "invalid_request_error",
    code: "content_filter",
    message: "The response was filtered due to the prompt triggering the content management policy.",
  },
  no_vision: {
    status: 400,
    type: "invalid_request_error",
    message: "Invalid content type. image_url is only supported by certain models.",
  },
  model_not_found: {
    status: 404,
    type: "invalid_request_error",
    code: "model_not_found",
    message: "The model `gpt-9` does not exist or you do not have access to it.",
  },
  bad_request: {
    status: 400,
    type: "invalid_request_error",
    code: "invalid_value",
    message: "Invalid value for 'messages'.",
  },
  too_large: { status: 413, message: "Request Entity Too Large" },
  entity_too_large: { status: 500, type: "internal_error", message: "request entity too large" },
  server_error: {
    status: 500,
    type: "server_error",
    message: "The server had an error while processing your request.",
  },
  bad_gateway: { status: 502, type: "server_error", message: "Bad gateway" },
  gateway_timeout: { status: 504, type: "timeout", message: "Gateway timeout" },
} as const satisfies Record<string, FailSpec>;

function failure(spec: FailSpec): TransportResponse {
  const { status, ...error } = spec;
  return response(
    status,
    null,
    { "content-type": "application/json; charset=utf-8" },
    JSON.stringify({ error }),
  );
}

const connectionRefused = (): Promise<TransportResponse> =>
  Promise.reject(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }));

interface ControlledBody {
  stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  close(): void;
}

function controlledBody(): ControlledBody {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const ctl = (): ReadableStreamDefaultController<Uint8Array> => {
    assert.ok(controller !== null);
    return controller;
  };
  return { stream, push: (text) => ctl().enqueue(encoder.encode(text)), close: () => ctl().close() };
}

function fixtureFrames(name: string): string[] {
  return readFileSync(new URL(name, SSE_DIR), "utf8").split(/(?<=\n\n)/u);
}

/** One request as the transport saw it. */
interface Sent {
  url: string;
  init: TransportInit;
  system: string;
  user: string;
  n: number;
  cropsOnly: boolean;
  /** Unit src behind each label (from x-ctv-test-units). */
  units: string[];
}

type Responder = (req: Sent) => TransportResponse | Promise<TransportResponse>;

function parseSent(url: string, init: TransportInit): Sent {
  const body = JSON.parse(init.body) as { messages: ChatMessage[] };
  const [system, user] = body.messages;
  assert.ok(system?.role === "system" && user?.role === "user");
  const text = user.content.find((part) => part.type === "text");
  assert.ok(text?.type === "text");
  const header = init.headers["x-ctv-test-units"];
  assert.ok(header !== undefined, "x-ctv-test-units is sent in test builds");
  return {
    url,
    init,
    system: system.content,
    user: text.text,
    n: Number(/N = (\d+)/u.exec(text.text)?.[1] ?? Number.NaN),
    cropsOnly: text.text.includes("This image has no left part"),
    units: decodeTestUnits(header).map((u) => u.src),
  };
}

/** `#label|type||original|translation` for unit src "u<i>" (the ground-truth answer; the translation may be replaced). */
function koLine(src: string, label: number, translation?: string): string {
  const entry = KO[Number(src.slice(1)) - 1];
  assert.ok(entry !== undefined, `unknown unit ${src}`);
  if (entry.type === "ignore") return `#${label}|ignore|||`;
  return `#${label}|${entry.type}||${entry.original}|${translation ?? entry.translation}`;
}

type Policy = (src: string, label: number) => string | null;
const good: Policy = (src, label) => koLine(src, label);

function answerText(req: Sent, policy: Policy): string {
  const lines = ["@lang|ko"];
  req.units.forEach((src, i) => {
    const line = policy(src, i + 1);
    if (line !== null) lines.push(line);
  });
  return `${lines.join("\n")}\n`;
}

/** Answers every label through `policy` (null leaves the label out). */
function answer(policy: Policy = good, done = true): Responder {
  return (req) => sse(answerText(req, policy), done);
}

// ---- Harness ----

interface Harness {
  clock: ManualClock;
  health: FakeHealth;
  composite: FakeComposite;
  settings: Settings;
  sent: Sent[];
  uploads: number[];
  caps: Array<{ value: number; forMs: number }>;
  results: UnitResult[];
  logs: LogEntry[];
  /** From now on uploads.record() throws (a broken kv write). */
  breakUploads(): void;
  translate(pack?: TranslatePack, onUnit?: (result: UnitResult) => void): Promise<PackReport>;
}

function setup(responders: Responder[], tweak: (settings: Settings) => void = () => undefined): Harness {
  const settings = migrateSettings(undefined);
  settings.api.baseUrl = BASE_URL;
  settings.api.apiKey = API_KEY;
  // Pinned: "auto" would follow the machine's navigator.languages. The ground-truth answers are Vietnamese.
  settings.translate.targetLang = "vi";
  tweak(settings);
  const clock = new ManualClock();
  const health = new FakeHealth();
  const composite = new FakeComposite();
  const sent: Sent[] = [];
  const uploads: number[] = [];
  const caps: Array<{ value: number; forMs: number }> = [];
  const results: UnitResult[] = [];
  const logs: LogEntry[] = [];
  const queue = [...responders];
  let uploadsBroken = false;
  const deps: TranslatorDeps = {
    clock,
    log: createLogger("engine", { sinks: [(entry) => logs.push(entry)], minLevel: "debug" }),
    settings: settingsSource(settings),
    health,
    composite,
    uploads: {
      record: (bytes) => {
        if (uploadsBroken) throw new Error("kv write failed");
        uploads.push(bytes);
      },
      today: () => ({ today: 0, bytesToday: 0 }),
    },
    random: () => 0.5,
    onConcurrencyCap: (cap) => caps.push(cap),
    transport: (url, init) => {
      assert.ok(url.startsWith(BASE_URL), `unexpected API URL ${url}`);
      const req = parseSent(url, init);
      sent.push(req);
      const next = queue.shift();
      assert.ok(next !== undefined, `unexpected request #${sent.length}`);
      return Promise.resolve(next(req));
    },
  };
  const translator = createTranslator(deps);
  return {
    clock,
    health,
    composite,
    settings,
    sent,
    uploads,
    caps,
    results,
    logs,
    breakUploads: () => {
      uploadsBroken = true;
    },
    translate: (pack = makePack(), onUnit) =>
      translator.translate(pack, (result) => {
        results.push(result);
        onUnit?.(result);
      }),
  };
}

function byKey(results: readonly UnitResult[]): Map<string, UnitResult> {
  const map = new Map<string, UnitResult>();
  for (const r of results) {
    assert.ok(!map.has(r.unitKey), `onUnit fired twice for ${r.unitKey}`);
    map.set(r.unitKey, r);
  }
  return map;
}

function statuses(results: readonly UnitResult[]): string[] {
  return [...byKey(results).values()].sort((a, b) => a.unitKey.localeCompare(b.unitKey)).map((r) => r.status);
}

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

const ALL_OK = ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ignored"];

// ---- Tests ----

describe("translator: streaming and replay", () => {
  test("a recorded gpt-5.2 transcript: nine units in one request, delivered while the stream is open", async () => {
    const body = controlledBody();
    const h = setup([() => response(200, body.stream)]);
    const done = h.translate();
    const state = track(done);
    await idle();
    const frames = fixtureFrames("gpt52-020-page-ko-p01.sse");
    const cut = Math.floor(frames.length * 0.6);
    for (const f of frames.slice(0, cut)) body.push(f);
    await idle();
    assert.ok(h.results.length >= 3, `units arrive before the stream ends (got ${h.results.length})`);
    assert.equal(state.settled, false);
    for (const f of frames.slice(cut)) body.push(f);
    body.close();
    const report = await done;

    assert.deepEqual(statuses(h.results), ALL_OK);
    const units = byKey(h.results);
    assert.deepEqual(units.get("k1"), {
      contentKey: "s:page",
      unitKey: "k1",
      status: "ok",
      type: "narration",
      speaker: "",
      original: "다음 날 아침",
      translation: "Sáng hôm sau",
      lang: "ko",
      // The configured model id, not the one the recorded chunks name ("azure-gpt-5.2"): units stream out first.
      model: DEFAULT_SETTINGS.api.model,
    });
    assert.equal(units.get("k9")?.translation, "");
    assert.deepEqual(report, {
      packId: "pack-1",
      requests: 1,
      missing: [],
      error: null,
      model: DEFAULT_SETTINGS.api.model,
      lang: "ko",
      firstLineMs: 0,
      totalMs: 0,
      uploadedBytes: JPEG.byteLength,
      // No @term or @sum in this transcript; the reported @lang votes for the series language.
      learning: { terms: [], addresses: [], summary: null, lang: "ko" },
    });
    assert.deepEqual(h.uploads, [JPEG.byteLength]);
    assert.equal(h.health.waits, 1);
  });

  test("every recorded transcript is handled: one request, exactly one result per unit", async () => {
    const files = readdirSync(SSE_DIR).filter((name) => name.endsWith(".sse"));
    assert.ok(files.length >= 15);
    for (const name of files) {
      const raw = readFileSync(new URL(name, SSE_DIR), "utf8");
      let text = "";
      const decoder = createChatStreamDecoder((t) => {
        text += t;
      });
      decoder.push(raw);
      decoder.end();
      const ids = new Set([...text.matchAll(/^#(\d+)\|/gmu)].map((m) => Number(m[1])));
      const n = Math.min(KO.length, Math.max(1, ids.size));
      const h = setup([() => response(200, streamOf(raw.split(/(?<=\n\n)/u)))], (s) => {
        s.translate.maxLadderRequestsPerPack = 0;
        s.translate.maxHttpRetriesPerRequest = 0;
      });
      const report = await h.translate(makePack(n));
      assert.equal(report.requests, 1, name);
      assert.equal(byKey(h.results).size, n, name);
    }
  });

  test("an onUnit that throws is logged and the pack goes on", async () => {
    const h = setup([answer()]);
    const report = await h.translate(makePack(), () => {
      throw new Error("renderer broke");
    });
    assert.equal(h.results.length, KO.length);
    assert.equal(report.error, null);
    assert.ok(h.logs.some((entry) => entry.msg === "onUnit threw"));
  });

  test("a failing upload counter or concurrency callback is logged, never taken for a failed request", async () => {
    const h = setup([() => failure(FAILURES.rate_limit), answer()]);
    h.breakUploads();
    const done = h.translate();
    await h.clock.advance(2_000);
    const report = await done;
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(report.requests, 2);
    assert.equal(report.uploadedBytes, 2 * JPEG.byteLength, "the pack's own counter still counts");
    assert.ok(h.logs.some((entry) => entry.msg === "uploads.record threw"));
  });

  test("a broken dependency still ends with one result per unit and a report, never a rejection", async () => {
    const h = setup([]);
    h.health.whenSendable = () => Promise.reject(new Error("health monitor crashed"));
    const report = await h.translate();
    assert.equal(report.error?.code, "engine.internal");
    assert.deepEqual(statuses(h.results), Array(9).fill("error"));
    assert.ok(h.logs.some((entry) => entry.msg === "translator failed"));
  });

  test("an empty pack resolves at once without a request", async () => {
    const h = setup([]);
    const report = await h.translate(makePack(0));
    assert.equal(report.requests, 0);
    assert.deepEqual(h.results, []);
  });
});

/** Fast mode's compact answer line for a unit: #n|type|translation. */
function koCompact(src: string, label: number): string {
  const entry = KO[Number(src.slice(1)) - 1];
  assert.ok(entry !== undefined, `unknown unit ${src}`);
  return entry.type === "ignore" ? `#${label}|ignore|` : `#${label}|${entry.type}|${entry.translation}`;
}

describe("translator: fast mode", () => {
  const MEMORY: PackMemory = {
    lang: null,
    style: { genre: "", koNames: "romanized", keepJaHonorifics: false },
    glossary: [{ original: "지호", translation: "Jiho", source: "manual" }],
    pronouns: [{ a: "Jiho", b: "Yuna", aSelf: "tớ", aToB: "cậu" }],
    history: [{ pos: 1_000, speaker: "Jiho", original: "어제 봤지?", translation: "Hôm qua thấy chưa?" }],
    summary: "Jiho and Yuna go to the market.",
    askSummary: true,
  };
  const fast = (s: Settings): void => {
    s.translate.fastMode = true;
  };

  test("the compact contract: type and translation only, no history, no learning lines; names still sent", async () => {
    const h = setup([(req) => sse(answerText(req, koCompact))], fast);
    const report = await h.translate(makePack(KO.length, { memory: MEMORY }));
    const req = h.sent[0];
    assert.ok(req !== undefined);
    assert.ok(req.system.includes(COMPACT_ITEM_LINE));
    assert.ok(!req.system.includes("#<n>|<type>|<speaker>|<original>|<translation>"));
    assert.ok(
      !req.system.includes("@term|") && !req.system.includes("@addr|") && !req.system.includes("@sum|"),
    );
    assert.ok(req.system.includes("지호 -> Jiho"), "the glossary keeps names right");
    assert.ok(req.system.includes("Jiho -> Yuna: tớ / cậu"), "and the forms of address");
    assert.ok(!req.user.includes(USER_HISTORY_HEADER), "no chapter history");
    assert.ok(req.user.includes(USER_SUMMARY_HEADER), "the short summary stays");
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(h.results.find((r) => r.status === "ok")?.original, "", "no transcription");
    assert.deepEqual(report.learning?.terms, []);
    assert.equal(report.learning?.summary, null);
    assert.equal(h.composite.calls[0]?.quality, FAST_JPEG_QUALITY, "a lighter composite");
  });

  test("a full answer is still read in fast mode", async () => {
    const h = setup([answer()], fast);
    await h.translate();
    assert.deepEqual(statuses(h.results), ALL_OK);
  });
});

describe("translator: requests", () => {
  test("baseUrl, API key, model and temperature from settings; test units; prompt for the pack language", async () => {
    const h = setup([answer(), answer()]);
    const report = await h.translate();
    const req = h.sent[0];
    assert.ok(req !== undefined);
    assert.equal(req.url, `${BASE_URL}/chat/completions`);
    assert.equal(req.init.method, "POST");
    assert.equal(req.init.headers["Authorization"], `Bearer ${API_KEY}`);
    assert.equal(req.init.cache, "no-store");
    assert.equal(req.init.credentials, "omit");
    const body = JSON.parse(req.init.body) as { model?: unknown; temperature?: unknown; stream?: unknown };
    assert.equal(body.model, DEFAULT_SETTINGS.api.model);
    assert.equal(body.temperature, DEFAULT_SETTINGS.api.temperature);
    assert.equal(body.stream, true);
    assert.deepEqual(req.units, ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9"]);
    assert.equal(req.n, 9);
    assert.equal(req.cropsOnly, false);
    assert.ok(req.system.includes("## Korean") && !req.system.includes("## Japanese"));
    assert.deepEqual(h.composite.calls[0], {
      mode: "full",
      units: ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9"],
      quality: 0.9,
      profile: "gpt4o",
    });
    assert.equal(report.model, DEFAULT_SETTINGS.api.model, "the configured id, not the stream's");
    assert.notEqual(ENVELOPE.model, DEFAULT_SETTINGS.api.model);

    const auto = setup([answer()]);
    await auto.translate(makePack(KO.length, { lang: "auto" }));
    const system = auto.sent[0]?.system ?? "";
    assert.ok(
      ["## Korean", "## Japanese", "## Chinese", "## English"].every((block) => system.includes(block)),
    );
  });

  test("a model that rejects the temperature is asked again at once without it, and from then on", async () => {
    const rejected = {
      status: 400,
      type: "invalid_request_error",
      code: "unsupported_value",
      message:
        "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
    };
    const h = setup([() => failure(rejected), answer(), answer()]);
    const report = await h.translate();
    const temperatures = (): unknown[] =>
      h.sent.map((req) => (JSON.parse(req.init.body) as Record<string, unknown>)["temperature"]);
    assert.deepEqual(temperatures(), [DEFAULT_SETTINGS.api.temperature, undefined]);
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(report.error, null);
    assert.equal(report.requests, 2);
    assert.ok(h.logs.some((entry) => /rejects the temperature/u.test(entry.msg)));
    await h.translate();
    assert.deepEqual(temperatures(), [DEFAULT_SETTINGS.api.temperature, undefined, undefined], "remembered");

    const other = setup([() => failure(FAILURES.bad_request)]);
    const failed = await other.translate();
    assert.equal(other.sent.length, 1, "any other bad request is not retried");
    assert.equal(failed.error?.code, "api.bad_request");
  });

  test("no API key: no Authorization header; a null temperature is left out; the profile follows the model", async () => {
    const h = setup([answer()], (s) => {
      s.api.apiKey = "";
      s.api.temperature = null;
      s.api.model = "gemini-2.5-flash";
    });
    const report = await h.translate();
    const req = h.sent[0];
    assert.ok(req !== undefined);
    assert.equal(req.init.headers["Authorization"], undefined);
    const body = JSON.parse(req.init.body) as Record<string, unknown>;
    assert.equal(body["model"], "gemini-2.5-flash");
    assert.equal(Object.hasOwn(body, "temperature"), false);
    assert.equal(h.composite.calls[0]?.profile, "gemini");
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(report.error, null);
    // The configured model labels the report and every unit (the health reading still names another model).
    assert.notEqual(h.health.reading().model, "gemini-2.5-flash");
    assert.equal(report.model, "gemini-2.5-flash");
    assert.ok(h.results.every((result) => result.model === "gemini-2.5-flash"));

    const gpt5 = setup([answer()], (s) => {
      s.api.model = "openai/gpt-5.2";
    });
    await gpt5.translate();
    assert.equal(gpt5.composite.calls[0]?.profile, "gpt5");
  });

  test("the watchdogs come from settings.api", async () => {
    const gate = Promise.withResolvers<TransportResponse>();
    const h = setup([() => gate.promise], (s) => {
      s.api.firstByteTimeoutMs = 20_000;
      s.api.totalTimeoutMs = 90_000;
    });
    const done = h.translate();
    await idle();
    assert.equal(h.sent.length, 1);
    assert.deepEqual(
      h.clock.pending().sort((a, b) => a - b),
      [20_000, 90_000],
    );
    const req = h.sent[0];
    assert.ok(req !== undefined);
    gate.resolve(answer()(req));
    const report = await done;
    assert.equal(report.requests, 1);
    assert.deepEqual(statuses(h.results), ALL_OK);
  });

  test("whenSendable() is awaited before every request", async () => {
    const h = setup([answer()]);
    h.health.ready = false;
    const done = h.translate();
    await idle();
    assert.equal(h.sent.length, 0);
    h.health.resume();
    await done;
    assert.equal(h.sent.length, 1);
  });
});

describe("translator: target language", () => {
  const ENGLISH: PromptTarget = { code: "en", name: "English" };
  const withTarget = (targetLang: string, locale = "auto"): Settings => {
    const settings = migrateSettings(undefined);
    settings.translate.targetLang = targetLang;
    settings.ui.locale = locale;
    return settings;
  };

  test("an explicit targetLang wins over the UI locale and the browser languages", () => {
    assert.deepEqual(promptTarget(withTarget("vi", "en"), ["de-DE"]), VIETNAMESE);
    assert.deepEqual(promptTarget(withTarget("es"), ["vi-VN"]), { code: "es", name: "Spanish" });
    assert.deepEqual(promptTarget(withTarget("pt-BR"), []), { code: "pt-br", name: "Brazilian Portuguese" });
    assert.deepEqual(promptTarget(withTarget("en", "vi"), ["vi-VN"]), ENGLISH);
  });

  test('"auto" follows the UI locale when one is chosen, else the browser languages', () => {
    assert.deepEqual(promptTarget(withTarget("auto", "vi"), ["de-DE", "en-US"]), VIETNAMESE);
    assert.deepEqual(promptTarget(withTarget("auto", "en"), ["vi-VN"]), ENGLISH);
    assert.deepEqual(promptTarget(withTarget("auto"), ["de-DE", "en-US"]), { code: "de", name: "German" });
    assert.deepEqual(
      promptTarget(withTarget("auto"), ["nl-NL", "fr-CA"]),
      { code: "fr", name: "French" },
      "the first supported browser language, region ignored",
    );
    assert.deepEqual(promptTarget(withTarget("auto"), ["pt_PT"]), {
      code: "pt-br",
      name: "Brazilian Portuguese",
    });
    assert.deepEqual(
      promptTarget(withTarget(""), ["it-IT"]),
      { code: "it", name: "Italian" },
      "empty = auto",
    );
  });

  test("fallback to English: nothing supported, no browser languages, or an unknown setting", () => {
    assert.deepEqual(promptTarget(withTarget("auto"), ["nl-NL", "sv-SE", "th-TH"]), ENGLISH);
    assert.deepEqual(promptTarget(withTarget("auto"), []), ENGLISH);
    assert.deepEqual(promptTarget(withTarget("xx"), []), ENGLISH);
    assert.deepEqual(
      promptTarget(withTarget("xx"), ["id-ID"]),
      { code: "id", name: "Indonesian" },
      "an unsupported setting falls back like auto",
    );
  });

  test("CJK targets: named for the prompt; Chinese browser languages go by script", () => {
    assert.deepEqual(promptTarget(withTarget("ja"), []), { code: "ja", name: "Japanese" });
    assert.deepEqual(promptTarget(withTarget("auto"), ["ko-KR"]), { code: "ko", name: "Korean" });
    assert.deepEqual(promptTarget(withTarget("auto"), ["zh-CN"]), {
      code: "zh-cn",
      name: "Simplified Chinese",
    });
    assert.deepEqual(promptTarget(withTarget("auto"), ["zh-HK"]), {
      code: "zh-tw",
      name: "Traditional Chinese",
    });
    assert.deepEqual(promptTarget(withTarget("auto", "zh-tw"), ["en-US"]), {
      code: "zh-tw",
      name: "Traditional Chinese",
    });
  });

  test("without an explicit list the browser languages come from navigator.languages", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { languages: ["tr-TR", "en-US"] },
      configurable: true,
    });
    try {
      assert.deepEqual(promptTarget(withTarget("auto")), { code: "tr", name: "Turkish" });
      assert.deepEqual(promptTarget(withTarget("auto", "vi")), VIETNAMESE, "a chosen UI locale still wins");
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  test("the request prompt is written for the resolved target language", async () => {
    const es = setup([answer()], (s) => {
      s.translate.targetLang = "es";
    });
    await es.translate();
    const spanish = es.sent[0]?.system ?? "";
    assert.ok(spanish.includes(systemIntro({ code: "es", name: "Spanish" })));
    assert.ok(spanish.includes("# Spanish style"));
    assert.ok(!spanish.includes("Vietnamese"));

    const vi = setup([answer()]);
    await vi.translate();
    const vietnamese = vi.sent[0]?.system ?? "";
    assert.ok(vietnamese.includes(systemIntro(VIETNAMESE)));
    assert.ok(vietnamese.includes(VIETNAMESE_STYLE));

    const auto = setup([answer()], (s) => {
      s.translate.targetLang = "auto";
      s.ui.locale = "en";
    });
    await auto.translate();
    const english = auto.sent[0]?.system ?? "";
    assert.ok(english.includes(systemIntro({ code: "en", name: "English" })));
    assert.ok(!english.includes(VIETNAMESE_STYLE));
  });
});

describe("translator: id ladder", () => {
  test("truncated stream: valid lines stay; missing ids re-asked crops-only with neighbour context", async () => {
    const h = setup([
      (req) => {
        const text = answerText(req, (src, label) => (label <= 6 ? good(src, label) : null));
        return sse(`${text}#7|dialogue||서둘러`, false);
      },
      answer(),
    ]);
    const report = await h.translate();
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(report.requests, 2);
    const reask = h.sent[1];
    assert.ok(reask !== undefined);
    assert.equal(reask.cropsOnly, true);
    assert.equal(reask.n, 3);
    assert.deepEqual(reask.units, ["u7", "u8", "u9"]);
    assert.equal(h.composite.calls[1]?.mode, "crops-only");
    assert.ok(reask.user.includes(cropsOnlyLine(3, true)));
    // Up to two accepted lines on each side: units 5 and 6 (4 is three away).
    assert.equal(CONTEXT_NEIGHBOURS, 2);
    assert.ok(reask.user.includes("오늘 휴업 => Hôm nay nghỉ"));
    assert.ok(reask.user.includes("쾅! => ẦM!"));
    assert.ok(!reask.user.includes(KO[3].translation));
    assert.equal(byKey(h.results).get("k7")?.translation, KO[6].translation);
  });

  test("partial ([DONE] but an id missing) runs the same ladder", async () => {
    const h = setup([answer((src, label) => (label === 4 ? null : good(src, label))), answer()]);
    const report = await h.translate();
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.deepEqual(h.sent[1]?.units, ["u4"]);
    assert.equal(h.sent[1]?.cropsOnly, true);
    assert.equal(report.requests, 2);
    assert.deepEqual(report.missing, []);
  });

  test("too many missing ids: split by position (≤ 2 levels), then untranslated; ≤ 1 + 4 requests", async () => {
    const stubborn = new Set(["u2", "u3", "u5", "u6", "u8"]);
    // Stubborn units always come back in Korean (wrong script), so they stay missing.
    const policy: Policy = (src, label) =>
      stubborn.has(src) ? koLine(src, label, "아직 번역하지 않았습니다") : good(src, label);
    const h = setup([answer(policy), answer(policy), answer(policy), answer(policy), answer(policy)]);
    const report = await h.translate();
    assert.deepEqual(
      h.composite.calls.map((c) => [c.mode, c.units.join(",")]),
      [
        ["full", "u1,u2,u3,u4,u5,u6,u7,u8,u9"],
        ["full", "u2,u3,u5"],
        ["full", "u6,u8"],
        ["full", "u2,u3"],
        ["full", "u5"],
      ],
    );
    assert.equal(report.requests, 5);
    const units = byKey(h.results);
    for (const src of stubborn) {
      const result = units.get(`k${src.slice(1)}`);
      assert.equal(result?.status, "untranslated");
      assert.equal(result.translation, "");
      assert.notEqual(result.original, "", "the original read by the model is kept");
    }
    assert.deepEqual(report.missing, ["k2", "k3", "k5", "k6", "k8"]);
    assert.equal(report.error, null);
  });

  test("a re-asked single unit that is still missing is never sent again unchanged", async () => {
    const policy: Policy = (src, label) => (src === "u4" ? koLine(src, label, "그대로") : good(src, label));
    const h = setup([answer(policy), answer(policy)]);
    const report = await h.translate();
    assert.equal(report.requests, 2);
    assert.equal(byKey(h.results).get("k4")?.status, "untranslated");
  });

  test("garbage (no item line) → one full retry counted in the ladder, then the normal ladder", async () => {
    const garbage =
      "Sure, here is what I can see in this picture:\n```\nA tall page.\n```\nThe lettering is too small.\n";
    const once = setup([() => sse(garbage), answer()]);
    const report = await once.translate();
    assert.deepEqual(statuses(once.results), ALL_OK);
    assert.equal(report.requests, 2);
    assert.deepEqual(once.composite.calls[1]?.units.length, 9);
    assert.equal(once.composite.calls[1]?.mode, "full");

    const twice = setup([() => sse(garbage), () => sse(garbage), answer(), answer()]);
    const second = await twice.translate();
    assert.deepEqual(statuses(twice.results), ALL_OK);
    assert.equal(second.requests, 4);
    assert.deepEqual(
      twice.composite.calls.slice(2).map((c) => c.units.join(",")),
      ["u1,u2,u3,u4,u5", "u6,u7,u8,u9"],
    );
  });

  test("keep-original: an echo of the original is resolved, not drawn and never re-asked", async () => {
    const h = setup([
      answer((src, label) => (src === "u5" ? koLine(src, label, "오늘 휴업") : good(src, label))),
    ]);
    const report = await h.translate();
    assert.equal(report.requests, 1);
    const unit = byKey(h.results).get("k5");
    assert.equal(unit?.status, "keep-original");
    assert.equal(unit.translation, "");
    assert.equal(unit.original, "오늘 휴업");
    assert.deepEqual(report.missing, []);
  });

  test("wrong script (Hangul in the translation) is missing and re-asked", async () => {
    const h = setup([
      answer((src, label) => (src === "u2" ? koLine(src, label, "일곱 시에 보자") : good(src, label))),
      answer(),
    ]);
    const report = await h.translate();
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(byKey(h.results).get("k2")?.translation, KO[1].translation);
    assert.deepEqual(h.sent[1]?.units, ["u2"]);
    assert.equal(report.requests, 2);
  });

  test("ladder budget 0: missing ids end untranslated after a single request", async () => {
    const h = setup([answer((src, label) => (label === 3 ? null : good(src, label)))], (s) => {
      s.translate.maxLadderRequestsPerPack = 0;
    });
    const report = await h.translate();
    assert.equal(report.requests, 1);
    assert.deepEqual(report.missing, ["k3"]);
  });
});

describe("translator: suspect merges", () => {
  const LONG =
    "Tấm bản đồ này chỉ có một nửa thị trấn thôi, hay là đợi mưa tạnh rồi hẵng đi tìm đường khác nhé";

  test("a long line before a missing id is held, re-asked, and delivered once with the cleaner line", async () => {
    const h = setup([
      answer((src, label) =>
        label === 4 ? null : src === "u3" ? koLine(src, label, LONG) : good(src, label),
      ),
      answer(),
    ]);
    const report = await h.translate();
    assert.deepEqual(h.sent[1]?.units, ["u3", "u4"]);
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(byKey(h.results).get("k3")?.translation, KO[2].translation);
    assert.equal(report.requests, 2);
  });

  test("a held line keeps its valid translation when the ladder brings nothing better", async () => {
    const policy3: Policy = (src, label) =>
      src === "u3" ? koLine(src, label, "원문 그대로입니다") : good(src, label);
    const h = setup([
      answer((src, label) =>
        label === 4 ? null : src === "u3" ? koLine(src, label, LONG) : good(src, label),
      ),
      answer(policy3),
      answer(policy3),
    ]);
    await h.translate();
    const unit = byKey(h.results).get("k3");
    assert.equal(unit?.status, "ok");
    assert.equal(unit.translation, LONG);
    assert.equal(byKey(h.results).get("k4")?.status, "ok");
  });

  test("a long line is released as soon as its next id arrives", async () => {
    const body = controlledBody();
    const h = setup([() => response(200, body.stream)]);
    const done = h.translate();
    await idle();
    const req = h.sent[0];
    assert.ok(req !== undefined);
    const lines = answerText(req, (src, label) =>
      src === "u3" ? koLine(src, label, LONG) : good(src, label),
    )
      .split("\n")
      .slice(0, 6); // @lang, #1..#5: #4 arrives, so #3 is not a suspect; #5 commits #4
    for (const f of sseFrames(`${lines.join("\n")}\n`, false)) body.push(f);
    await idle();
    assert.equal(byKey(h.results).get("k3")?.translation, LONG);
    body.push(contentFrame(`${answerText(req, good).split("\n").slice(6).join("\n")}`));
    for (const f of endFrames()) body.push(f);
    body.close();
    await done;
    assert.deepEqual(statuses(h.results), ALL_OK);
  });
});

describe("translator: refusals", () => {
  test("whole-pack refusal: every unit refused, no retry, report.error llm.refused", async () => {
    const h = setup([() => sse("I'm sorry, but I can't help with translating this image.")]);
    const report = await h.translate();
    assert.equal(report.requests, 1);
    assert.deepEqual(statuses(h.results), Array(9).fill("refused"));
    assert.equal(report.error?.code, "llm.refused");
    assert.equal(report.missing.length, 9);
  });

  test("a content filter in the HTTP error body is a refusal: never retried, never paused", async () => {
    const h = setup([() => failure(FAILURES.content_filter)]);
    const report = await h.translate();
    assert.equal(report.requests, 1);
    assert.deepEqual(statuses(h.results), Array(9).fill("refused"));
    assert.equal(report.error?.code, "llm.refused");
    assert.deepEqual(h.health.reports, []);
  });

  test("an item-level refusal is final while the other ids are accepted", async () => {
    const h = setup([
      answer((src, label) =>
        src === "u3" ? koLine(src, label, "I'm sorry, I can't translate this.") : good(src, label),
      ),
    ]);
    const report = await h.translate();
    assert.equal(report.requests, 1);
    const unit = byKey(h.results).get("k3");
    assert.equal(unit?.status, "refused");
    assert.equal(unit.original, KO[2].original);
    assert.equal(report.error?.code, "llm.refused");
    assert.deepEqual(report.missing, ["k3"]);
  });

  test("splitOnRefusal (opt-in) splits a refused pack once to isolate the refused part", async () => {
    const refusal = (): TransportResponse => sse("I'm sorry, but I can't help with translating this image.");
    const h = setup([refusal, answer(), refusal], (s) => {
      s.translate.splitOnRefusal = true;
    });
    const report = await h.translate();
    assert.equal(report.requests, 3);
    assert.deepEqual(statuses(h.results), [
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "refused",
      "refused",
      "refused",
      "refused",
    ]);
  });
});

describe("translator: HTTP errors", () => {
  test("429: 2 s then 5 s backoff (seeded jitter), queue concurrency 1 for 10 min, then it goes through", async () => {
    const h = setup([() => failure(FAILURES.rate_limit), () => failure(FAILURES.rate_limit), answer()]);
    const done = h.translate();
    await idle();
    assert.equal(h.sent.length, 1);
    assert.ok(h.clock.pending().includes(2_000));
    await h.clock.advance(1_999);
    assert.equal(h.sent.length, 1);
    await h.clock.advance(1);
    assert.equal(h.sent.length, 2);
    assert.ok(h.clock.pending().includes(5_000));
    await h.clock.advance(5_000);
    const report = await done;
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(report.requests, 3);
    assert.deepEqual(h.caps, [
      { value: 1, forMs: 600_000 },
      { value: 1, forMs: 600_000 },
    ]);
    assert.equal(h.uploads.length, 3, "requests the endpoint received count as uploads");
  });

  test("429 on every attempt: the request fails after 2 retries and its units carry the error", async () => {
    const h = setup([
      () => failure(FAILURES.rate_limit),
      () => failure(FAILURES.rate_limit),
      () => failure(FAILURES.rate_limit),
    ]);
    const done = h.translate();
    await h.clock.advance(10_000);
    const report = await done;
    assert.equal(report.requests, 3);
    assert.deepEqual(statuses(h.results), Array(9).fill("error"));
    assert.equal(report.error?.code, "api.rate_limit");
    assert.equal(report.missing.length, 9);
  });

  test("500 / 502 back off and retry; maxHttpRetriesPerRequest 0 fails at once", async () => {
    for (const spec of [FAILURES.server_error, FAILURES.bad_gateway]) {
      const h = setup([() => failure(spec), answer()]);
      const done = h.translate();
      await idle();
      assert.ok(h.clock.pending().includes(2_000), String(spec.status));
      await h.clock.advance(2_000);
      const report = await done;
      assert.equal(report.requests, 2, String(spec.status));
      assert.deepEqual(statuses(h.results), ALL_OK);
      assert.deepEqual(h.caps, []);
    }
    const none = setup([() => failure(FAILURES.bad_gateway)], (s) => {
      s.translate.maxHttpRetriesPerRequest = 0;
    });
    const report = await none.translate();
    assert.equal(report.requests, 1);
    assert.equal(report.error?.code, "api.upstream");
  });

  test("504 gateway timeout counts as a timeout: one retry 120 s later, concurrency 1 for 5 min", async () => {
    const h = setup([() => failure(FAILURES.gateway_timeout), answer()]);
    const done = h.translate();
    await idle();
    assert.deepEqual(h.caps, [{ value: 1, forMs: 300_000 }]);
    assert.ok(h.clock.pending().includes(120_000));
    await h.clock.advance(119_999);
    assert.equal(h.sent.length, 1);
    await h.clock.advance(1);
    const report = await done;
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(report.error, null);
  });

  test("401 invalid_api_key: reported to health; one probe after 60 s, sent only once health allows it", async () => {
    const h = setup([() => failure(FAILURES.invalid_api_key), answer()]);
    const done = h.translate();
    await idle();
    assert.deepEqual(
      h.health.reports.map((r) => r.code),
      ["api.unauthorized"],
    );
    assert.ok(h.clock.pending().includes(UNAUTHORIZED_PROBE_MS));
    await h.clock.advance(UNAUTHORIZED_PROBE_MS);
    assert.equal(h.sent.length, 1, "nothing is sent while paused");
    h.health.resume();
    const report = await done;
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(report.error, null);
  });

  test("401: a health that resumes early does not cut the 60 s probe delay short", async () => {
    const h = setup([() => failure(FAILURES.invalid_api_key), answer()]);
    const done = h.translate();
    await idle();
    await h.clock.advance(UNAUTHORIZED_PROBE_MS / 2);
    h.health.resume();
    await idle();
    assert.equal(h.sent.length, 1);
    await h.clock.advance(UNAUTHORIZED_PROBE_MS / 2 - 1);
    assert.equal(h.sent.length, 1);
    await h.clock.advance(1);
    const report = await done;
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(h.results), ALL_OK);
  });

  test("401 / 403 while health stays ready: one probe 60 s later, then the request fails until the user acts", async () => {
    for (const spec of [FAILURES.invalid_api_key, FAILURES.forbidden]) {
      const h = setup([() => failure(spec), () => failure(spec)]);
      h.health.pauseOnReport = false;
      const done = h.translate();
      await idle();
      assert.ok(h.clock.pending().includes(UNAUTHORIZED_PROBE_MS));
      await h.clock.advance(UNAUTHORIZED_PROBE_MS);
      const report = await done;
      assert.equal(report.requests, 2, String(spec.status));
      assert.deepEqual(
        h.health.reports.map((r) => r.code),
        ["api.unauthorized", "api.unauthorized"],
      );
      assert.equal(report.error?.code, "api.unauthorized");
      assert.equal(report.error.status, spec.status);
      assert.deepEqual(statuses(h.results), Array(9).fill("error"));
    }
  });

  test("a /models that keeps saying ready while every connection fails: at most 3 pauses, then error", async () => {
    const h = setup(Array.from({ length: 1 + MAX_PAUSES_PER_REQUEST }, () => connectionRefused));
    h.health.pauseOnReport = false;
    const report = await h.translate();
    assert.equal(report.requests, 1 + MAX_PAUSES_PER_REQUEST);
    assert.equal(report.error?.code, "api.unreachable");
    assert.equal(h.health.reports.length, 1 + MAX_PAUSES_PER_REQUEST);
    assert.deepEqual(statuses(h.results), Array(9).fill("error"));
    assert.deepEqual(h.uploads, [], "nothing reached the endpoint");
  });

  test("a model the endpoint rejects (no image input, unknown model, no quota): api.config reported, failed at once", async () => {
    for (const spec of [FAILURES.no_vision, FAILURES.model_not_found, FAILURES.insufficient_quota]) {
      const h = setup([() => failure(spec)]);
      const report = await h.translate();
      assert.equal(report.requests, 1, spec.message);
      assert.equal(report.error?.code, "api.config", spec.message);
      assert.deepEqual(
        h.health.reports.map((r) => r.code),
        ["api.config"],
      );
      assert.deepEqual(statuses(h.results), Array(9).fill("error"));
      assert.deepEqual(h.clock.pending(), []);
    }

    const bad = setup([() => failure(FAILURES.bad_request)]);
    const badReport = await bad.translate();
    assert.equal(badReport.requests, 1);
    assert.equal(badReport.error?.code, "api.bad_request");
    assert.deepEqual(bad.health.reports, [], "a bad request does not pause the queue");
    assert.deepEqual(statuses(bad.results), Array(9).fill("error"));
  });

  test("413 / 500 entity too large: rebuilt at q0.80, then split into halves", async () => {
    const h = setup([
      () => failure(FAILURES.too_large),
      () => failure(FAILURES.entity_too_large),
      answer(),
      answer(),
    ]);
    const report = await h.translate();
    assert.deepEqual(
      h.composite.calls.map((c) => [c.quality, c.units.length]),
      [
        [0.9, 9],
        [0.8, 9],
        [0.9, 5],
        [0.9, 4],
      ],
    );
    assert.equal(report.requests, 4);
    assert.deepEqual(statuses(h.results), ALL_OK);
  });

  test("400 context_length_exceeded: split into halves at once, without a retry", async () => {
    const h = setup([() => failure(FAILURES.context_length), answer(), answer()]);
    const report = await h.translate();
    assert.equal(report.requests, 3);
    assert.deepEqual(
      h.composite.calls.map((c) => c.units.length),
      [9, 5, 4],
    );
    assert.deepEqual(h.clock.pending(), [], "no backoff timer");
    assert.deepEqual(statuses(h.results), ALL_OK);

    const single = setup([() => failure(FAILURES.context_length)]);
    const alone = await single.translate(makePack(1));
    assert.equal(alone.requests, 1, "a single unit cannot be split: it fails");
    assert.equal(alone.error?.code, "api.context_length");
    assert.deepEqual(statuses(single.results), ["error"]);
  });

  test("first-byte watchdog timeout: one retry 120 s later, watchdogs ×1.5, concurrency 1 for 5 min", async () => {
    const never = (): Promise<TransportResponse> => new Promise<TransportResponse>(() => undefined);
    const h = setup([never, never]);
    const done = h.translate();
    await idle();
    assert.ok(h.clock.pending().includes(180_000) && h.clock.pending().includes(600_000));
    await h.clock.advance(180_000);
    assert.deepEqual(h.caps, [{ value: 1, forMs: 300_000 }]);
    assert.ok(h.clock.pending().includes(120_000));
    await h.clock.advance(120_000);
    assert.equal(h.sent.length, 2);
    assert.ok(h.clock.pending().includes(270_000) && h.clock.pending().includes(900_000));
    await h.clock.advance(270_000);
    const report = await done;
    assert.equal(report.requests, 2);
    assert.equal(report.error?.code, "api.timeout");
    assert.equal(h.uploads.length, 2, "a request the endpoint may be working on counts as an upload");
  });

  test("empty answers: one full retry (ladder), then the ladder splits the pack", async () => {
    const empty = (): TransportResponse => response(200, streamOf(sseFrames("")));
    const h = setup([empty, empty, answer(), answer()]);
    const done = h.translate();
    await idle();
    assert.ok(h.clock.pending().includes(3_000));
    await h.clock.advance(3_000);
    const report = await done;
    assert.equal(report.requests, 4);
    assert.deepEqual(
      h.composite.calls.map((c) => c.units.length),
      [9, 5, 4],
    );
    assert.deepEqual(statuses(h.results), ALL_OK);
  });

  test("an empty answer after the pack's full retry was spent goes straight to the ladder", async () => {
    const garbage = "Here is a description of the page.\n";
    const empty = (): TransportResponse => response(200, streamOf(sseFrames("")));
    const h = setup([() => sse(garbage), empty, answer(), answer()]);
    const report = await h.translate();
    assert.equal(report.requests, 4);
    assert.deepEqual(
      h.composite.calls.map((c) => c.units.length),
      [9, 9, 5, 4],
    );
    assert.deepEqual(h.clock.pending(), []);
    assert.deepEqual(statuses(h.results), ALL_OK);
  });

  test("a stream that dies after some lines keeps them; only the missing ids go on after the backoff", async () => {
    const h = setup([
      (req) => {
        const text = answerText(req, (src, label) => (label <= 6 ? good(src, label) : null));
        const frames = sseFrames(text, false);
        frames.push(frame({ error: { message: "upstream stream failed", type: "upstream_error" } }));
        return response(200, streamOf(frames));
      },
      answer(),
    ]);
    const done = h.translate();
    await idle();
    assert.equal(h.results.length, 6, "the six valid lines are delivered right away");
    await h.clock.advance(2_000);
    const report = await done;
    assert.deepEqual(h.sent[1]?.units, ["u7", "u8", "u9"]);
    assert.equal(h.sent[1]?.cropsOnly, true);
    assert.equal(report.requests, 2);
    assert.deepEqual(statuses(h.results), ALL_OK);
  });

  test("a connection that fails before any byte pauses through health and is not counted as an upload", async () => {
    const h = setup([connectionRefused, answer()]);
    const done = h.translate();
    await idle();
    assert.deepEqual(
      h.health.reports.map((r) => r.code),
      ["api.unreachable"],
    );
    h.health.resume();
    const report = await done;
    assert.equal(report.requests, 2);
    assert.deepEqual(h.uploads, [JPEG.byteLength]);
    assert.equal(report.uploadedBytes, JPEG.byteLength);
  });
});

describe("translator: connection lost mid-stream", () => {
  test("the delivered lines stay; health pauses the queue and the missing ids wait for it", async () => {
    const h = setup([
      (req) => {
        const frames = sseFrames(
          answerText(req, (src, label) => (label <= 6 ? good(src, label) : null)),
          false,
        );
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = frames[i];
            i += 1;
            if (next === undefined) controller.error(new TypeError("network error"));
            else controller.enqueue(encoder.encode(next));
          },
        });
        return response(200, body);
      },
      answer(),
    ]);
    const done = h.translate();
    await idle();
    assert.equal(h.results.length, 6);
    assert.deepEqual(
      h.health.reports.map((r) => r.code),
      ["api.unreachable"],
    );
    assert.equal(h.sent.length, 1, "the re-ask waits while health is paused");
    h.health.resume();
    const report = await done;
    assert.deepEqual(h.sent[1]?.units, ["u7", "u8", "u9"]);
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.equal(h.uploads.length, 2, "the dropped request had reached the endpoint");
    assert.equal(report.error, null);
  });
});

describe("translator: composites", () => {
  test("a composite that cannot be laid out is split before anything is sent (halves count as ladder)", async () => {
    const h = setup([answer(), answer(), answer()]);
    h.composite.failWhen = (request) => (request.units.length > 4 ? "overflow" : null);
    const report = await h.translate();
    assert.deepEqual(
      h.composite.calls.map((c) => c.units.join(",")),
      ["u1,u2,u3,u4,u5,u6,u7,u8,u9", "u1,u2,u3,u4,u5", "u1,u2,u3", "u4,u5", "u6,u7,u8,u9"],
    );
    assert.equal(report.requests, 3);
    assert.deepEqual(statuses(h.results), ALL_OK);
  });

  test("a unit that cannot be composed even alone ends untranslated without a request", async () => {
    const h = setup([]);
    h.composite.failWhen = () => "glyph";
    const report = await h.translate(makePack(1));
    assert.equal(report.requests, 0);
    assert.deepEqual(statuses(h.results), ["untranslated"]);
  });

  test("a composite build error fails its units with engine.internal", async () => {
    const h = setup([]);
    h.composite.throwWhen = () => true;
    const report = await h.translate();
    assert.equal(report.requests, 0);
    assert.equal(report.error?.code, "engine.internal");
    assert.deepEqual(statuses(h.results), Array(9).fill("error"));
  });
});

describe("translator: series memory", () => {
  const MEMORY: PackMemory = {
    lang: null,
    style: { genre: "", koNames: "han-viet", keepJaHonorifics: false },
    glossary: [
      { original: "지호", translation: "Jiho", note: "main character", source: "manual" },
      { original: "유나", translation: "Yuna", source: "learned" },
    ],
    pronouns: [{ a: "Jiho", b: "Yuna", aSelf: "tớ", aToB: "cậu" }],
    history: [{ pos: 1_000, speaker: "Jiho", original: "어제 봤지?", translation: "Hôm qua thấy chưa?" }],
    summary: "Jiho and Yuna go to the market.",
    askSummary: true,
  };
  const memoryPack = (): TranslatePack => makePack(KO.length, { memory: MEMORY });

  test("glossary, forms of address and style go in the system text; summary and history in the user text", async () => {
    const h = setup([
      (req) =>
        sse(
          `${answerText(req, good)}@term|지갑|ví|đồ vật\n@addr|Yuna|Jiho|tớ|cậu\n@addr|Yuna|Jiho|mình|bạn\n@addr|Jiho||tôi|\n@sum|They forgot the wallet.\n`,
        ),
    ]);
    const report = await h.translate(memoryPack());
    const req = h.sent[0];
    assert.ok(req !== undefined);
    assert.ok(req.system.includes(`${GLOSSARY_HEADER}\n지호 -> Jiho (main character)\n유나 -> Yuna`));
    assert.ok(
      req.system.includes(`${pronounsHeader(VIETNAMESE)}\n${PRONOUNS_LEGEND}\nJiho -> Yuna: tớ / cậu`),
    );
    assert.ok(req.system.includes(KOREAN_BLOCK.hanViet), "the series name style");
    assert.ok(req.system.includes(systemAskSummary(VIETNAMESE, DEFAULT_SETTINGS.memory.summaryMaxWords)));
    assert.ok(req.user.includes(`${USER_SUMMARY_HEADER}\nJiho and Yuna go to the market.`));
    assert.ok(req.user.includes(`${USER_HISTORY_HEADER}\nJiho: 어제 봤지? => Hôm qua thấy chưa?`));
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.deepEqual(report.learning, {
      terms: [{ original: "지갑", translation: "ví", note: "đồ vật" }],
      addresses: [{ a: "Yuna", b: "Jiho", aSelf: "tớ", aToB: "cậu" }],
      summary: "They forgot the wallet.",
      lang: "ko",
    });
  });

  test("a crops-only re-ask keeps glossary and summary but sends neighbours, not history, and asks no @sum", async () => {
    const h = setup([
      (req) =>
        sse(
          `${answerText(req, (src, label) => (label <= 6 ? good(src, label) : null))}@term|지갑|ví|\n@sum|First part.\n`,
          false,
        ),
      (req) => sse(`${answerText(req, good)}@term|지갑|cái ví|\n@term|가게|cửa hàng|\n@sum|Ignored.\n`),
    ]);
    const report = await h.translate(memoryPack());
    const reask = h.sent[1];
    assert.ok(reask?.cropsOnly === true);
    assert.ok(reask.system.includes("지호 -> Jiho"));
    assert.ok(!reask.system.includes("@sum|"), "only full requests ask for a summary");
    assert.ok(reask.user.includes(USER_SUMMARY_HEADER));
    assert.ok(reask.user.includes("쾅! => ẦM!"), "neighbouring lines");
    assert.ok(!reask.user.includes("Hôm qua thấy chưa?"), "no chapter history");
    assert.deepEqual(statuses(h.results), ALL_OK);
    assert.deepEqual(report.learning, {
      terms: [
        { original: "지갑", translation: "ví", note: "" },
        { original: "가게", translation: "cửa hàng", note: "" },
      ],
      addresses: [],
      summary: "First part.",
      lang: "ko",
    });
  });

  test("settings.memory limits what is sent; without memory nothing is sent and no summary is asked", async () => {
    const h = setup([answer()], (s) => {
      s.memory.glossaryInPrompt = 1;
      s.memory.historyMaxLines = 0;
      s.memory.summaryMaxWords = 3;
    });
    await h.translate(memoryPack());
    const req = h.sent[0];
    assert.ok(req !== undefined);
    assert.ok(req.system.includes("지호 -> Jiho") && !req.system.includes("유나 -> Yuna"));
    assert.ok(!req.user.includes(USER_HISTORY_HEADER));
    assert.ok(req.user.includes(`${USER_SUMMARY_HEADER}\nJiho and Yuna…`));
    assert.ok(req.system.includes("at most 3 words"));

    const plain = setup([answer()]);
    await plain.translate();
    const bare = plain.sent[0];
    assert.ok(bare !== undefined);
    assert.ok(!bare.system.includes(GLOSSARY_HEADER) && !bare.system.includes("@sum|"));
    assert.ok(!bare.user.includes(USER_SUMMARY_HEADER) && !bare.user.includes(USER_HISTORY_HEADER));
  });

  test("a pack that never got an answer reports no learning", async () => {
    const h = setup([() => failure(FAILURES.no_vision)]);
    const report = await h.translate(memoryPack());
    assert.equal(report.learning, undefined);
  });
});
