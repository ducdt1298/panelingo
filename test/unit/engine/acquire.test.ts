import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  DEFAULT_REFERRER_POLICY,
  FETCH_TIMEOUT_MS,
  IMAGE_ACCEPT,
  MAX_RETRY_AFTER_MS,
  createAcquirer,
  isAcceptableContentType,
  normalizeReferrerPolicy,
  parseRetryAfter,
  policyReferer,
  refererAttempts,
  refererPageUrl,
  type ImageFetch,
  type ImageFetchInit,
  type ImageFetchResponse,
} from "../../../src/engine/acquire.ts";
import type {
  AcquireContext,
  AcquiredImage,
  CaptureStep,
  Clock,
  CoreDeps,
  FrameInfo,
  ServiceFactories,
} from "../../../src/engine/contracts.ts";
import { silentLogger } from "../../../src/platform/log.ts";
import { onMessageFor } from "../../../src/platform/messaging.ts";
import type { DnrRuleLike } from "../../../src/shared/dnr-rules.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { ImageSubmit } from "../../../src/shared/protocol.ts";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SITE,
  type Settings,
  type SiteSettings,
} from "../../../src/shared/settings.ts";
import { toBase64 } from "../../../src/shared/wire.ts";
import { ensureRefererRule } from "../../../src/sw/dnr.ts";
import { FAKE_EXTENSION_ID, FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";

/* ------------------------------------------------------------------ fixtures */

const READER = "https://reader.example";
const PAGE = `${READER}/series/7/chapter/12?from=list#top`;
/** PAGE as a referrer: no fragment. */
const PAGE_REF = `${READER}/series/7/chapter/12?from=list`;
const CDN = "https://cdn.example.net";
const CDN_HOST = "cdn.example.net";

function filled(head: number[], size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
}

const PNG = filled(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52],
  120,
);
const JPEG = filled([0xff, 0xd8, 0xff, 0xe0, 0, 16], 120);
const HTML = new TextEncoder().encode(
  "<!doctype html><html><head><title>403</title></head><body>Hotlinking is not allowed here.</body></html>",
);

/* ------------------------------------------------------------------ time and turns */

async function turns(n = 60): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(predicate: () => boolean, what: string, max = 3000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

class ManualClock implements Clock {
  t = Date.UTC(2026, 9, 10, 12, 0, 0);
  #seq = 0;
  readonly #timers: Array<{ at: number; seq: number; fn: () => void; live: boolean }> = [];

  readonly now = (): number => this.t;

  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, seq: this.#seq, fn, live: true };
    this.#seq += 1;
    this.#timers.push(timer);
    return () => {
      timer.live = false;
    };
  };

  live(): number {
    return this.#timers.filter((timer) => timer.live).length;
  }

  /** Moves time forward, firing due timers in order and letting deliveries run in between. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await turns(20);
      const due = this.#timers
        .filter((timer) => timer.live && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.t = Math.max(this.t, due.at);
      due.live = false;
      due.fn();
    }
    this.t = target;
    await turns(20);
  }
}

/* ------------------------------------------------------------------ fake network */

interface NetRequest {
  url: string;
  host: string;
  init: ImageFetchInit;
  /** Referer after the session DNR rules (the offscreen document sends none of its own). */
  referer: string | null;
  originRemoved: boolean;
  body: { cancelled: boolean };
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | Uint8Array[];
  /** Final URL after redirects. */
  url?: string;
  /** Headers arrive but the body never ends. */
  stall?: true;
}

type Route = (request: NetRequest) => Reply | Promise<Reply>;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Applies the session modifyHeaders rules like Chrome would for an extension-initiated, non-tab request. */
function dnrHeaders(browser: FakeBrowser, host: string): { referer: string | null; originRemoved: boolean } {
  let referer: string | null = null;
  let originRemoved = false;
  const rules = (browser.sessionRules as unknown as DnrRuleLike[])
    .filter((rule) => rule.condition.initiatorDomains.includes(FAKE_EXTENSION_ID))
    .filter((rule) => rule.condition.tabIds.includes(-1))
    .filter((rule) => (rule.condition.requestDomains ?? []).some((d) => host === d || host.endsWith(`.${d}`)))
    .sort((a, b) => a.priority - b.priority);
  for (const rule of rules) {
    if (rule.action.type !== "modifyHeaders") continue;
    for (const op of rule.action.requestHeaders) {
      if (op.header === "referer") referer = op.operation === "set" ? (op.value ?? "") : null;
      if (op.header === "origin" && op.operation === "remove") originRemoved = true;
    }
  }
  return { referer, originRemoved };
}

function bodyStream(chunks: Uint8Array[], stall: boolean, signal: AbortSignal, state: NetRequest["body"]) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): Promise<void> | void {
      if (signal.aborted) {
        controller.error(abortError());
        return;
      }
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) {
        controller.enqueue(chunk);
        return;
      }
      if (!stall) {
        controller.close();
        return;
      }
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          controller.error(abortError());
          resolve();
        });
      });
    },
    cancel(): void {
      state.cancelled = true;
    },
  });
}

function fakeFetch(browser: FakeBrowser, route: () => Route, log: NetRequest[]): ImageFetch {
  return async (url, init) => {
    const host = new URL(url).hostname;
    const request: NetRequest = { url, host, init, ...dnrHeaders(browser, host), body: { cancelled: false } };
    log.push(request);
    const reply = await new Promise<Reply>((resolve, reject) => {
      if (init.signal.aborted) reject(abortError());
      init.signal.addEventListener("abort", () => reject(abortError()));
      Promise.resolve()
        .then(() => route()(request))
        .then(resolve, reject);
    });
    const chunks = reply.body === undefined ? [] : Array.isArray(reply.body) ? reply.body : [reply.body];
    const response: ImageFetchResponse = {
      status: reply.status ?? 200,
      url: reply.url ?? url,
      headers: new Headers(reply.headers ?? {}),
      body: bodyStream(chunks, reply.stall === true, init.signal, request.body),
    };
    return response;
  };
}

interface Deferred {
  route: Route;
  pending: Array<{ request: NetRequest; reply: (r: Reply) => void }>;
  /** Answers every request that has no reply yet; returns how many. */
  replyAll(reply: Reply): number;
}

/** A route whose replies the test releases. */
function deferredRoute(): Deferred {
  const pending: Deferred["pending"] = [];
  let answered = 0;
  return {
    pending,
    route: (request) => new Promise<Reply>((resolve) => pending.push({ request, reply: resolve })),
    replyAll(reply: Reply): number {
      const open = pending.slice(answered);
      answered = pending.length;
      for (const entry of open) entry.reply(reply);
      return open.length;
    },
  };
}

const ok = (body: Uint8Array = PNG, type = "image/png"): Reply => ({
  status: 200,
  headers: { "content-type": type },
  body,
});

/* ------------------------------------------------------------------ harness */

function frameAt(url: string): FrameInfo {
  const origin = new URL(url).origin;
  return {
    frameKey: "1:0:DOC1",
    tabId: 1,
    frameId: 0,
    documentId: "DOC1",
    url,
    origin,
    siteKey: origin,
    mode: "auto",
    codec: "sc",
    page: { title: "Chapter 12", layout: "webtoon", visible: true, dpr: 1 },
    viewport: null,
    focusSeq: 0,
  };
}

function siteWith(patch: Partial<SiteSettings> = {}): SiteSettings {
  return { ...DEFAULT_SITE, enabled: true, addedAt: 0, ...patch };
}

function settingsWith(edit: (settings: Settings) => void = () => undefined): Settings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  edit(settings);
  return settings;
}

let seq = 0;

function submitOf(src: string, extra: Partial<ImageSubmit> = {}): ImageSubmit {
  seq += 1;
  return {
    imageKey: `${seq}.0`,
    src,
    natural: { w: 800, h: 1200 },
    displayed: { w: 800, h: 1200 },
    element: "img",
    priority: seq,
    pos: { docOrder: seq, srcGen: 0, yTop: seq * 1200 },
    acquire: "url",
    ...extra,
  };
}

interface Harness {
  browser: FakeBrowser;
  engine: FakeContext;
  clock: ManualClock;
  requests: NetRequest[];
  ensures: Array<{ host: string; referer: string | null; removeOrigin: boolean }>;
  /** Number of upcoming sw:dnr-ensure calls that fail. */
  failEnsures: { count: number };
  route: Route;
  acquire(submit: ImageSubmit, ctx?: Partial<AcquireContext>): Promise<AcquiredImage>;
}

let current: FakeBrowser | null = null;

afterEach(() => {
  current?.uninstall();
  current = null;
});

async function harness(
  route: Route,
  base: Partial<AcquireContext> = {},
  capture?: CaptureStep,
): Promise<Harness> {
  const browser = new FakeBrowser();
  current = browser;
  browser.install();
  const sw = await browser.startServiceWorker();
  const ensures: Harness["ensures"] = [];
  const failEnsures = { count: 0 };
  sw.run(() =>
    onMessageFor("sw", {
      "sw:dnr-ensure": async (payload) => {
        ensures.push(payload);
        if (failEnsures.count > 0) {
          failEnsures.count -= 1;
          throw new Error("updateSessionRules failed");
        }
        return { ruleId: await ensureRefererRule(payload.host, payload.referer, payload.removeOrigin) };
      },
    }),
  );
  await sw.run(() =>
    sw.ext.offscreen.createDocument({
      url: "engine/offscreen.html",
      reasons: ["WORKERS"],
      justification: "test",
    }),
  );
  const engine = browser.offscreen;
  assert.ok(engine !== null);
  browser.setDefaultContext(engine);
  const clock = new ManualClock();
  const requests: NetRequest[] = [];
  const h: Harness = {
    browser,
    engine,
    clock,
    requests,
    ensures,
    failEnsures,
    route,
    acquire: (submit, ctx = {}) => {
      const result = engine.run(() =>
        acquirer.acquire(submit, {
          frame: ctx.frame ?? base.frame ?? frameAt(PAGE),
          site: ctx.site ?? base.site ?? siteWith(),
          settings: ctx.settings ?? base.settings ?? settingsWith(),
        }),
      );
      // Tests await every result, sometimes only after advancing the clock past the rejection.
      void result.catch(() => undefined);
      return result;
    },
  };
  const deps: CoreDeps = {
    clock,
    log: silentLogger,
    settings: {
      current: () => DEFAULT_SETTINGS,
      site: () => siteWith(),
      sites: () => ({}),
      apply: () => undefined,
      onChange: () => () => undefined,
    },
  };
  const acquirer = createAcquirer({
    ...deps,
    fetch: fakeFetch(browser, () => h.route, requests),
    ...(capture === undefined ? {} : { capture }),
  });
  return h;
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  check: (error: CtvError) => void = () => undefined,
): Promise<CtvError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CtvError, `expected CtvError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    check(error);
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

function bytesOf(image: AcquiredImage): number[] {
  return [...new Uint8Array(image.bytes)];
}

/* ------------------------------------------------------------------ pure helpers */

test("createAcquirer fits ServiceFactories (fetch and callSw default to the platform ones)", () => {
  const factory: ServiceFactories["createAcquirer"] = createAcquirer;
  assert.equal(typeof factory, "function");
});

describe("Referer policy helpers", () => {
  test("normalizeReferrerPolicy: tokens, legacy keywords, last valid token wins", () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, DEFAULT_REFERRER_POLICY],
      ["", DEFAULT_REFERRER_POLICY],
      ["no-referrer", "no-referrer"],
      [" NO-REFERRER ", "no-referrer"],
      ["never", "no-referrer"],
      ["always", "unsafe-url"],
      ["default", "strict-origin-when-cross-origin"],
      ["origin-when-crossorigin", "origin-when-cross-origin"],
      ["bogus", DEFAULT_REFERRER_POLICY],
      ["constructor", DEFAULT_REFERRER_POLICY],
      ["unsafe-url, bogus", "unsafe-url"],
      ["no-referrer, origin", "origin"],
    ];
    for (const [raw, expected] of cases) assert.equal(normalizeReferrerPolicy(raw), expected, String(raw));
  });

  test("policyReferer follows the Referrer Policy table", () => {
    const page = "https://reader.example/ch/1?p=2";
    const cross = "https://cdn.example.net/1.jpg";
    const same = "https://reader.example/img/1.jpg";
    const downgrade = "http://cdn.example.net/1.jpg";
    const origin = "https://reader.example/";
    const table: Array<[string | undefined, string, string | null]> = [
      [undefined, cross, origin],
      [undefined, same, page],
      [undefined, downgrade, null],
      ["no-referrer", cross, null],
      ["no-referrer", same, null],
      ["unsafe-url", downgrade, page],
      ["no-referrer-when-downgrade", cross, page],
      ["no-referrer-when-downgrade", downgrade, null],
      ["origin", downgrade, origin],
      ["strict-origin", cross, origin],
      ["strict-origin", downgrade, null],
      ["same-origin", cross, null],
      ["same-origin", same, page],
      ["origin-when-cross-origin", cross, origin],
      ["origin-when-cross-origin", same, page],
      ["origin-when-cross-origin", downgrade, origin],
      ["strict-origin-when-cross-origin", cross, origin],
    ];
    for (const [policy, image, expected] of table) {
      assert.equal(policyReferer(page, image, policy), expected, `${String(policy)} → ${image}`);
    }
    assert.equal(policyReferer(null, cross, "unsafe-url"), null);
    // A plain-http reader loading from a loopback dev host is not a downgrade.
    assert.equal(
      policyReferer("http://127.0.0.1:8080/r", "http://localhost:8081/1.png", undefined),
      "http://127.0.0.1:8080/",
    );
    assert.equal(
      policyReferer("https://reader.example/r", "http://localhost:8081/1.png", undefined),
      "https://reader.example/",
    );
  });

  test("refererPageUrl strips fragment and credentials; about: frames use their origin", () => {
    assert.equal(refererPageUrl({ url: PAGE, origin: READER }), PAGE_REF);
    assert.equal(
      refererPageUrl({ url: "https://u:p@reader.example/a#b", origin: READER }),
      "https://reader.example/a",
    );
    assert.equal(refererPageUrl({ url: "about:blank", origin: READER }), `${READER}/`);
    assert.equal(refererPageUrl({ url: "about:srcdoc", origin: "null" }), null);
    assert.equal(
      refererPageUrl({ url: "chrome-extension://x/page.html", origin: "chrome-extension://x" }),
      null,
    );
    const long = `${READER}/x?${"q".repeat(5000)}`;
    assert.equal(
      refererPageUrl({ url: long, origin: READER }),
      `${READER}/`,
      "Chrome caps referrers at 4096",
    );
  });

  test("refererAttempts per site mode", () => {
    const image = `${CDN}/1.jpg`;
    assert.deepEqual(refererAttempts("auto", PAGE_REF, image, undefined, false), [
      { referer: `${READER}/`, removeOrigin: false },
      { referer: PAGE_REF, removeOrigin: true },
    ]);
    assert.deepEqual(refererAttempts("auto", PAGE_REF, image, "no-referrer", false), [
      { referer: null, removeOrigin: false },
      { referer: PAGE_REF, removeOrigin: true },
    ]);
    assert.deepEqual(refererAttempts("auto", PAGE_REF, image, undefined, true), [
      { referer: PAGE_REF, removeOrigin: true },
    ]);
    assert.deepEqual(refererAttempts("page-url", PAGE_REF, image, "no-referrer", false), [
      { referer: PAGE_REF, removeOrigin: false },
    ]);
    assert.deepEqual(refererAttempts("origin", PAGE_REF, image, "unsafe-url", true), [
      { referer: `${READER}/`, removeOrigin: false },
    ]);
    assert.deepEqual(refererAttempts("origin", null, image, undefined, false), [
      { referer: null, removeOrigin: false },
    ]);
  });

  test("parseRetryAfter: seconds, HTTP dates, caps", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    assert.equal(parseRetryAfter(null, now), null);
    assert.equal(parseRetryAfter("3", now), 3000);
    assert.equal(parseRetryAfter(" 10 ", now), 10_000);
    assert.equal(parseRetryAfter("0", now), 0);
    assert.equal(parseRetryAfter(new Date(now + 42_000).toUTCString(), now), 42_000);
    assert.equal(parseRetryAfter(new Date(now - 42_000).toUTCString(), now), 0);
    assert.equal(parseRetryAfter("86400", now), MAX_RETRY_AFTER_MS);
    assert.equal(parseRetryAfter("soon", now), null);
    assert.equal(parseRetryAfter("-5", now), null);
  });

  test("isAcceptableContentType", () => {
    for (const ok of [
      null,
      "",
      "image/jpeg",
      "IMAGE/WEBP; charset=x",
      "application/octet-stream",
      "binary/octet-stream",
    ]) {
      assert.equal(isAcceptableContentType(ok), true, String(ok));
    }
    for (const bad of ["text/html", "application/json", "text/plain; charset=utf-8", "video/mp4"]) {
      assert.equal(isAcceptableContentType(bad), false, bad);
    }
  });
});

/* ------------------------------------------------------------------ engine fetch */

describe("engine fetch with the DNR Referer rule", () => {
  test("auto: attempt 1 carries the page's policy referrer (origin) via the session rule", async () => {
    const h = await harness((request) =>
      request.referer?.startsWith(`${READER}/`) === true ? ok(PNG, "image/jpeg") : { status: 403 },
    );
    const image = await h.acquire(submitOf(`${CDN}/img/p1.png`));
    assert.deepEqual(
      { mime: image.mime, source: image.source, lowRes: image.lowRes, url: image.url },
      { mime: "image/png", source: "url", lowRes: false, url: `${CDN}/img/p1.png` },
      "the magic bytes win over content-type",
    );
    assert.deepEqual(bytesOf(image), [...PNG]);
    assert.deepEqual(h.ensures, [{ host: CDN_HOST, referer: `${READER}/`, removeOrigin: false }]);
    assert.equal(h.requests.length, 1);
    const [request] = h.requests;
    assert.ok(request !== undefined);
    assert.equal(request.referer, `${READER}/`);
    assert.equal(request.originRemoved, false);
    assert.deepEqual(
      { ...request.init, signal: undefined },
      {
        method: "GET",
        credentials: "omit",
        redirect: "follow",
        cache: "default",
        headers: { Accept: IMAGE_ACCEPT },
        signal: undefined,
      },
    );
    assert.equal(h.clock.live(), 0, "the 30 s timer is cancelled");
  });

  test("auto: a full-URL gate gets attempt 2 (page URL, no Origin), then the host starts there", async () => {
    const fullUrlGate: Route = (request) =>
      request.referer !== null && new URL(request.referer).pathname.length > 1
        ? ok()
        : { status: 403, body: HTML };
    const h = await harness(fullUrlGate);
    await h.acquire(submitOf(`${CDN}/protected-full/p1.png`));
    assert.deepEqual(
      h.requests.map((r) => [r.referer, r.originRemoved, r.init.cache]),
      [
        [`${READER}/`, false, "default"],
        [PAGE_REF, true, "no-store"],
      ],
    );
    assert.equal(h.requests[0]?.body.cancelled, true, "the refused body is discarded");
    assert.deepEqual(h.ensures, [
      { host: CDN_HOST, referer: `${READER}/`, removeOrigin: false },
      { host: CDN_HOST, referer: PAGE_REF, removeOrigin: true },
    ]);
    await h.acquire(submitOf(`${CDN}/protected-full/p2.png`));
    assert.equal(h.requests.length, 3, "one request for the next image");
    assert.equal(h.requests[2]?.referer, PAGE_REF);
    assert.equal(h.ensures.length, 2, "the installed rule is reused");
  });

  test("page-url and origin are fixed, and their 403 is final", async () => {
    const h = await harness(() => ({ status: 403 }));
    await rejectsWith(
      h.acquire(submitOf(`${CDN}/a.png`), { site: siteWith({ referer: "page-url" }) }),
      "image.http",
      (e) => {
        assert.equal(e.status, 403);
        assert.equal(e.retryable, false);
      },
    );
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.ensures, [{ host: CDN_HOST, referer: PAGE_REF, removeOrigin: false }]);
    h.route = () => ok();
    await h.acquire(submitOf("https://img.other.example/b.png"), { site: siteWith({ referer: "origin" }) });
    assert.deepEqual(h.ensures[1], { host: "img.other.example", referer: `${READER}/`, removeOrigin: false });
    assert.equal(h.requests[1]?.referer, `${READER}/`);
  });

  test("referrer-policy hints: no-referrer removes the header, unsafe-url sends the page, same-origin is full", async () => {
    const h = await harness(() => ok());
    await h.acquire(submitOf(`${CDN}/a.png`, { refPolicy: "no-referrer" }));
    assert.deepEqual(h.ensures[0], { host: CDN_HOST, referer: null, removeOrigin: false });
    assert.equal(h.requests[0]?.referer, null);
    await h.acquire(submitOf("https://img2.example.net/b.png", { refPolicy: "unsafe-url" }));
    assert.equal(h.requests[1]?.referer, PAGE_REF);
    await h.acquire(submitOf(`${READER}/img/c.png`));
    assert.equal(h.requests[2]?.referer, PAGE_REF, "same-origin requests carry the full URL by default");
  });

  test("sw:dnr-ensure runs once per host and Referer, not per image", async () => {
    const h = await harness(() => ok());
    const pageUrl = { site: siteWith({ referer: "page-url" }) } as const;
    const pageB = `${READER}/series/7/chapter/13`;
    for (const n of [1, 2, 3]) await h.acquire(submitOf(`${CDN}/${n}.png`), pageUrl);
    assert.equal(h.ensures.length, 1);
    await h.acquire(submitOf(`${CDN}/4.png`), { ...pageUrl, frame: frameAt(pageB) });
    await h.acquire(submitOf(`${CDN}/5.png`), pageUrl);
    await h.acquire(submitOf("https://img2.example.net/6.png"), pageUrl);
    assert.deepEqual(
      h.ensures.map((e) => [e.host, e.referer]),
      [
        [CDN_HOST, PAGE_REF],
        [CDN_HOST, pageB],
        [CDN_HOST, PAGE_REF],
        ["img2.example.net", PAGE_REF],
      ],
    );
    assert.deepEqual(
      h.requests.map((r) => r.referer),
      [PAGE_REF, PAGE_REF, PAGE_REF, pageB, PAGE_REF, PAGE_REF],
    );
  });

  test("a different Referer for the same host waits until the current rule's requests have headers", async () => {
    const net = deferredRoute();
    const h = await harness(net.route, { site: siteWith({ referer: "page-url" }) });
    const pageA = `${READER}/a`;
    const pageB = `${READER}/b`;
    const first = h.acquire(submitOf(`${CDN}/1.png`), { frame: frameAt(pageA) });
    await until(() => h.requests.length === 1, "first request");
    const second = h.acquire(submitOf(`${CDN}/2.png`), { frame: frameAt(pageB) });
    await turns(100);
    assert.equal(h.ensures.length, 1, "page B's rule must not replace page A's while A is in flight");
    assert.equal(h.requests.length, 1);
    net.pending[0]?.reply({ status: 200, headers: { "content-type": "image/png" }, body: PNG });
    await until(() => h.requests.length === 2, "second request");
    net.pending[1]?.reply(ok());
    await Promise.all([first, second]);
    assert.deepEqual(
      h.requests.map((r) => r.referer),
      [pageA, pageB],
    );
  });

  test("credentials follow the site setting", async () => {
    const h = await harness(() => ok());
    await h.acquire(submitOf(`${CDN}/a.png`), { site: siteWith({ credentials: "include" }) });
    await h.acquire(submitOf(`${CDN}/b.png`));
    assert.deepEqual(
      h.requests.map((r) => r.init.credentials),
      ["include", "omit"],
    );
  });

  test("a failed sw:dnr-ensure still fetches once; a 401/403 then reports dnr.failed", async () => {
    const h = await harness(() => ok());
    h.failEnsures.count = 1;
    const image = await h.acquire(submitOf(`${CDN}/a.png`));
    assert.equal(image.source, "url");
    assert.equal(h.requests[0]?.referer, null, "no rule was installed");
    await h.acquire(submitOf(`${CDN}/b.png`));
    assert.equal(h.ensures.length, 2, "the failed rule is not cached");
    assert.equal(h.requests[1]?.referer, `${READER}/`);

    h.route = () => ({ status: 403 });
    h.failEnsures.count = 1;
    await rejectsWith(
      h.acquire(submitOf("https://img2.example.net/c.png"), { site: siteWith({ referer: "page-url" }) }),
      "dnr.failed",
      (e) => assert.equal(e.status, 403),
    );
  });
});

describe("response checks", () => {
  const smallCap = settingsWith((s) => {
    s.privacy.maxImageBytes = 1000;
  });

  test("a Content-Length over the cap is refused without reading the body", async () => {
    const h = await harness(() => ({
      status: 200,
      headers: { "content-type": "image/png", "content-length": "1001" },
      body: [PNG, new Uint8Array(881)],
    }));
    await rejectsWith(h.acquire(submitOf(`${CDN}/big.png`), { settings: smallCap }), "image.too_large");
    assert.equal(h.requests[0]?.body.cancelled, true);
  });

  test("a streamed body over the cap is cut off", async () => {
    const h = await harness(() => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: [PNG, new Uint8Array(500), new Uint8Array(500), new Uint8Array(500), new Uint8Array(500)],
    }));
    await rejectsWith(h.acquire(submitOf(`${CDN}/big.png`), { settings: smallCap }), "image.too_large");
    assert.equal(h.requests[0]?.body.cancelled, true, "the rest of the body is cancelled");
    // Exactly at the cap is fine.
    h.route = () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: [PNG, new Uint8Array(880)],
    });
    const image = await h.acquire(submitOf(`${CDN}/fits.png`), { settings: smallCap });
    assert.equal(image.bytes.byteLength, 1000);
  });

  test("content-type and magic bytes", async () => {
    const h = await harness(() => ({ status: 200, headers: { "content-type": "text/html" }, body: HTML }));
    await rejectsWith(h.acquire(submitOf(`${CDN}/a.png`)), "image.not_image", (e) =>
      assert.equal(e.detail, "type"),
    );
    assert.equal(h.requests[0]?.body.cancelled, true);

    h.route = () => ok(JPEG, "application/octet-stream");
    assert.equal((await h.acquire(submitOf(`${CDN}/b.bin`))).mime, "image/jpeg");

    h.route = () => ({ status: 200, body: PNG });
    assert.equal((await h.acquire(submitOf(`${CDN}/c`))).mime, "image/png", "no content-type: sniffed");

    h.route = () => ok(HTML, "image/png");
    await rejectsWith(h.acquire(submitOf(`${CDN}/d.png`)), "image.not_image", (e) =>
      assert.equal(e.detail, "magic"),
    );

    h.route = () => ok(new TextEncoder().encode("nope"), "image/png");
    await rejectsWith(h.acquire(submitOf(`${CDN}/e.png`)), "image.not_image");

    h.route = () => ok(new Uint8Array(0), "image/png");
    await rejectsWith(h.acquire(submitOf(`${CDN}/f.png`)), "image.not_image");
  });

  test("HTTP errors map to image.http with status and retryability", async () => {
    const h = await harness(() => ({ status: 404 }));
    await rejectsWith(h.acquire(submitOf(`${CDN}/a.png`)), "image.http", (e) => {
      assert.equal(e.status, 404);
      assert.equal(e.retryable, false);
      assert.equal(e.retryAfterMs, undefined);
    });
    h.route = () => ({ status: 500 });
    await rejectsWith(h.acquire(submitOf(`${CDN}/b.png`)), "image.http", (e) => {
      assert.equal(e.status, 500);
      assert.equal(e.retryable, true);
    });
    h.route = () => ({ status: 503, headers: { "retry-after": "7" } });
    await rejectsWith(h.acquire(submitOf("https://img2.example.net/c.png")), "image.http", (e) => {
      assert.equal(e.status, 503);
      assert.equal(e.retryAfterMs, 7000);
      assert.equal(e.retryable, true);
    });
  });

  test("network failures and the 30 s timeout are retryable image.http", async () => {
    const h = await harness(() => {
      throw new TypeError("Failed to fetch");
    });
    await rejectsWith(h.acquire(submitOf(`${CDN}/a.png`)), "image.http", (e) => {
      assert.equal(e.detail, "network");
      assert.equal(e.retryable, true);
    });

    h.route = () => new Promise<Reply>(() => undefined);
    const hanging = h.acquire(submitOf(`${CDN}/b.png`));
    await until(() => h.requests.length === 2, "hanging request");
    await h.clock.advance(FETCH_TIMEOUT_MS - 1);
    assert.equal(h.requests[1]?.init.signal.aborted, false);
    await h.clock.advance(1);
    await rejectsWith(hanging, "image.http", (e) => {
      assert.equal(e.detail, "timeout");
      assert.equal(e.retryable, true);
    });
    assert.equal(h.requests[1]?.init.signal.aborted, true);

    h.route = () => ({ status: 200, headers: { "content-type": "image/png" }, body: PNG, stall: true });
    const stalled = h.acquire(submitOf(`${CDN}/c.png`));
    await until(() => h.requests.length === 3, "stalling request");
    await h.clock.advance(FETCH_TIMEOUT_MS);
    await rejectsWith(stalled, "image.http", (e) => assert.equal(e.detail, "timeout"));
    assert.equal(h.clock.live(), 0);
  });
});

describe("url-guard, redirects and altSrcs", () => {
  test("private hosts are blocked before any rule or request; dev fixture hosts are allowed", async () => {
    const h = await harness(() => ok());
    await rejectsWith(h.acquire(submitOf("http://127.0.0.1/x.png")), "image.url_blocked", (e) =>
      assert.equal(e.detail, "private-ip"),
    );
    await rejectsWith(h.acquire(submitOf("http://2130706433:8080/x.png")), "image.url_blocked");
    assert.equal(h.requests.length, 0);
    assert.equal(h.ensures.length, 0);

    const dev = settingsWith((s) => {
      s.privacy.devFixtureHosts = ["127.0.0.1:8080", "localhost:8081"];
    });
    const image = await h.acquire(submitOf("http://localhost:8081/protected/p1.png"), {
      settings: dev,
      frame: frameAt("http://127.0.0.1:8080/protected/?set=ko-p01"),
    });
    assert.equal(image.url, "http://localhost:8081/protected/p1.png");
    assert.deepEqual(h.ensures, [
      { host: "localhost", referer: "http://127.0.0.1:8080/", removeOrigin: false },
    ]);
  });

  test("a redirect to a private host is refused on the final URL", async () => {
    const h = await harness(() => ({ ...ok(), url: "http://10.0.0.5/x.png" }));
    await rejectsWith(h.acquire(submitOf(`${CDN}/redirect?to=x`)), "image.url_blocked", (e) =>
      assert.equal(e.detail, "redirect:private-ip"),
    );
    assert.equal(h.requests[0]?.body.cancelled, true);
    h.route = () => ({ ...ok(), url: `${CDN}/final/x.png` });
    assert.equal((await h.acquire(submitOf(`${CDN}/redirect?to=y`))).url, `${CDN}/final/x.png`);
  });

  test("altSrcs are tried in order when the main src fails", async () => {
    const h = await harness((request) => (request.url.endsWith("/real.png") ? ok() : { status: 404 }));
    const image = await h.acquire(submitOf(`${CDN}/placeholder.gif`, { altSrcs: [`${CDN}/real.png`] }));
    assert.equal(image.url, `${CDN}/real.png`);
    assert.deepEqual(
      h.requests.map((r) => r.url),
      [`${CDN}/placeholder.gif`, `${CDN}/real.png`],
    );

    const fromData = await h.acquire(
      submitOf("data:image/gif;base64,R0lGODlhAQABAAAAACw=", {
        altSrcs: [" ", `${CDN}/real.png`, `${CDN}/real.png`],
      }),
    );
    assert.equal(fromData.url, `${CDN}/real.png`);
    assert.equal(h.requests.length, 3, "data: is never fetched; duplicates and blanks are skipped");

    const relative = await h.acquire(submitOf(`${CDN}/lazy.gif`, { altSrcs: ["../../img/real.png"] }));
    assert.equal(relative.url, `${READER}/series/img/real.png`, "resolved against the frame URL");
    await rejectsWith(
      h.acquire(submitOf("/img/x.png"), { frame: { ...frameAt(PAGE), url: "about:blank" } }),
      "image.url_blocked",
      (e) => assert.equal(e.detail, "malformed", "nothing to resolve against"),
    );

    await rejectsWith(
      h.acquire(submitOf("data:,x", { altSrcs: [`${CDN}/missing.png`, "http://192.168.0.2/x.png"] })),
      "image.http",
      (e) => assert.equal(e.status, 404, "the error of a URL that was fetched wins over 'blocked'"),
    );
    await rejectsWith(h.acquire(submitOf("blob:https://reader.example/1")), "image.url_blocked", (e) =>
      assert.equal(e.detail, "scheme"),
    );
  });
});

describe("politeness", () => {
  test("at most fetchPerHostConcurrency fetches per host; other hosts are not blocked", async () => {
    const net = deferredRoute();
    const h = await harness(net.route);
    const onA = (r: NetRequest): boolean => r.host === CDN_HOST;
    const pending = [1, 2, 3, 4, 5].map((n) => h.acquire(submitOf(`${CDN}/${n}.png`)));
    await until(() => h.requests.length === 2, "two requests");
    await turns(100);
    assert.equal(h.requests.filter(onA).length, 2);

    const other = h.acquire(submitOf("https://img2.example.net/x.png"));
    await until(() => h.requests.length === 3, "the other host");
    net.pending[2]?.reply(ok());
    await other;

    net.pending[0]?.reply(ok());
    await until(() => h.requests.filter(onA).length === 3, "the third request after a slot frees");
    await turns(100);
    assert.equal(h.requests.filter(onA).length, 3, "still two in flight");
    for (let round = 0; round < 20 && h.requests.filter(onA).length < 5; round += 1) {
      net.replyAll(ok());
      await turns(30);
    }
    net.replyAll(ok());
    await Promise.all(pending);
    assert.equal(h.requests.filter(onA).length, 5);
  });

  test("the per-host limit comes from settings", async () => {
    const net = deferredRoute();
    const three = settingsWith((s) => {
      s.discovery.fetchPerHostConcurrency = 3;
    });
    const h = await harness(net.route, { settings: three });
    const pending = [1, 2, 3, 4].map((n) => h.acquire(submitOf(`${CDN}/${n}.png`)));
    await until(() => h.requests.length === 3, "three requests");
    await turns(100);
    assert.equal(h.requests.length, 3);
    net.pending[0]?.reply(ok());
    await until(() => h.requests.length === 4, "the fourth");
    net.replyAll(ok());
    await Promise.all(pending);
  });

  test("prefetch starts are spaced by prefetchSpacingMs; on-screen submits are not", async () => {
    const h = await harness(() => ok());
    const prefetch = [1, 2, 3].map((n) => h.acquire(submitOf(`${CDN}/p${n}.png`, { prefetch: true })));
    await until(() => h.requests.length === 1, "first prefetch");
    await turns(100);
    assert.equal(h.requests.length, 1);
    await h.clock.advance(149);
    assert.equal(h.requests.length, 1);
    await h.clock.advance(1);
    await until(() => h.requests.length === 2, "second prefetch at +150 ms");
    await h.clock.advance(150);
    await until(() => h.requests.length === 3, "third prefetch at +300 ms");
    await Promise.all(prefetch);

    const now = [1, 2].map((n) => h.acquire(submitOf(`${CDN}/u${n}.png`)));
    await until(() => h.requests.length === 5, "both on-screen submits at once");
    await Promise.all(now);
  });

  test("queued on-screen submits go before queued prefetch", async () => {
    const net = deferredRoute();
    const one = settingsWith((s) => {
      s.discovery.fetchPerHostConcurrency = 1;
    });
    const h = await harness(net.route, { settings: one });
    const first = h.acquire(submitOf(`${CDN}/now-1.png`));
    await until(() => h.requests.length === 1, "first");
    const later = h.acquire(submitOf(`${CDN}/ahead.png`, { prefetch: true }));
    await turns(20);
    const urgent = h.acquire(submitOf(`${CDN}/now-2.png`));
    await turns(20);
    net.pending[0]?.reply(ok());
    await until(() => h.requests.length === 2, "next");
    assert.equal(h.requests[1]?.url, `${CDN}/now-2.png`);
    net.pending[1]?.reply(ok());
    await h.clock.advance(150);
    await until(() => h.requests.length === 3, "prefetch last");
    assert.equal(h.requests[2]?.url, `${CDN}/ahead.png`);
    net.pending[2]?.reply(ok());
    await Promise.all([first, later, urgent]);
  });

  test("429 Retry-After: the error carries it and the host backs off", async () => {
    let calls = 0;
    const h = await harness(() => {
      calls += 1;
      return calls === 1 ? { status: 429, headers: { "retry-after": "3" } } : ok();
    });
    await rejectsWith(h.acquire(submitOf(`${CDN}/a.png`)), "image.http", (e) => {
      assert.equal(e.status, 429);
      assert.equal(e.retryAfterMs, 3000);
      assert.equal(e.retryable, true);
    });
    const next = h.acquire(submitOf(`${CDN}/b.png`));
    const elsewhere = h.acquire(submitOf("https://img2.example.net/c.png"));
    await until(() => h.requests.length === 2, "the other host is not delayed");
    await elsewhere;
    await h.clock.advance(2999);
    assert.equal(h.requests.filter((r) => r.host === CDN_HOST).length, 1);
    await h.clock.advance(1);
    await next;
    assert.equal(h.requests.filter((r) => r.host === CDN_HOST).length, 2);
  });

  test("a final 403 backs the host off 2 s, then 5 s; a success resets the steps", async () => {
    const h = await harness(() => ({ status: 403 }), { site: siteWith({ referer: "page-url" }) });
    await rejectsWith(h.acquire(submitOf(`${CDN}/a.png`)), "image.http");
    const second = h.acquire(submitOf(`${CDN}/b.png`));
    await turns(100);
    assert.equal(h.requests.length, 1);
    await h.clock.advance(2000);
    await rejectsWith(second, "image.http");
    assert.equal(h.requests.length, 2);
    h.route = () => ok();
    const third = h.acquire(submitOf(`${CDN}/c.png`));
    await h.clock.advance(4999);
    assert.equal(h.requests.length, 2);
    await h.clock.advance(1);
    await third;
    h.route = () => ({ status: 403 });
    await rejectsWith(h.acquire(submitOf(`${CDN}/d.png`)), "image.http");
    const fifth = h.acquire(submitOf(`${CDN}/e.png`));
    await h.clock.advance(1999);
    assert.equal(h.requests.length, 4, "back to the first step after a success");
    await h.clock.advance(1);
    await rejectsWith(fifth, "image.http");
    assert.equal(h.requests.length, 5);
  });
});

describe("ladder step 1: bytes from the content script", () => {
  test("ArrayBuffer and base64 bytes are capped and sniffed, never fetched", async () => {
    const h = await harness(() => ok());
    const fromBuffer = await h.acquire(
      submitOf(`${CDN}/a.png`, {
        acquire: "bytes",
        bytes: PNG.slice().buffer,
        mime: "image/jpeg",
        source: "cs-fetch",
      }),
    );
    assert.deepEqual(
      { mime: fromBuffer.mime, source: fromBuffer.source, url: fromBuffer.url, lowRes: fromBuffer.lowRes },
      { mime: "image/png", source: "bytes", url: null, lowRes: false },
    );
    const fromB64 = await h.acquire(
      submitOf(`${CDN}/b.jpg`, { acquire: "bytes", bytes: { b64: toBase64(JPEG) }, source: "cs-canvas" }),
    );
    assert.equal(fromB64.mime, "image/jpeg");
    assert.deepEqual(bytesOf(fromB64), [...JPEG]);
    assert.equal(h.requests.length, 0);
    assert.equal(h.ensures.length, 0);
  });

  test("bytes over the cap are refused without a fetch", async () => {
    const h = await harness(() => ok());
    const cap = settingsWith((s) => {
      s.privacy.maxImageBytes = 100;
    });
    await rejectsWith(
      h.acquire(submitOf(`${CDN}/a.png`, { acquire: "bytes", bytes: PNG.slice().buffer }), { settings: cap }),
      "image.too_large",
    );
    assert.equal(h.requests.length, 0);
  });

  test("bytes that are not an image fall back to the engine fetch", async () => {
    const h = await harness(() => ok());
    const image = await h.acquire(submitOf(`${CDN}/a.png`, { acquire: "bytes", bytes: HTML.slice().buffer }));
    assert.equal(image.source, "url");
    assert.equal(h.requests.length, 1);

    await rejectsWith(
      h.acquire(submitOf("data:image/png;base64,AAAA", { acquire: "bytes", bytes: { b64: "*not base64*" } })),
      "image.not_image",
      (e) => assert.equal(e.detail, "bytes", "the step-1 error beats the blocked data: URL"),
    );
  });

  test("acquire 'bytes' without bytes uses the URL", async () => {
    const h = await harness(() => ok());
    assert.equal((await h.acquire(submitOf(`${CDN}/a.png`, { acquire: "bytes" }))).source, "url");
    assert.equal(h.requests.length, 1);
  });

  test("canvases and 'capture' submits never fetch their synthetic src (no capture step here)", async () => {
    const h = await harness(() => ok(HTML, "text/html"));
    const canvasSrc = `${PAGE_REF}#ctv-canvas-3.0`;
    await rejectsWith(
      h.acquire(submitOf(canvasSrc, { element: "canvas", acquire: "capture" })),
      "image.capture_unavailable",
    );
    await rejectsWith(h.acquire(submitOf(canvasSrc, { element: "canvas" })), "image.capture_unavailable");
    await rejectsWith(
      h.acquire(submitOf(`${CDN}/b.png`, { acquire: "capture" })),
      "image.capture_unavailable",
    );
    await rejectsWith(
      h.acquire(submitOf(canvasSrc, { element: "canvas", acquire: "bytes", bytes: HTML.slice().buffer })),
      "image.not_image",
    );
    const fromCanvas = await h.acquire(
      submitOf(canvasSrc, {
        element: "canvas",
        acquire: "bytes",
        bytes: PNG.slice().buffer,
        source: "cs-canvas",
      }),
    );
    assert.equal(fromCanvas.source, "bytes");
    assert.equal(h.requests.length, 0, "the reader page is never downloaded");
  });
});

/** Ladder step 3 double: refuses with `refusal` when set, else returns a lowRes PNG. */
class FakeCapture implements CaptureStep {
  refusalError: CtvError | null = null;
  readonly calls: string[] = [];
  refusal(): CtvError | null {
    return this.refusalError;
  }
  capture(submit: ImageSubmit): Promise<AcquiredImage> {
    this.calls.push(submit.imageKey);
    return Promise.resolve({
      bytes: PNG.slice().buffer,
      mime: "image/png",
      source: "capture",
      lowRes: true,
      url: null,
    });
  }
}

describe("ladder step 3: screen capture", () => {
  test("a canvas without readable bytes is captured; its synthetic src is never fetched", async () => {
    const capture = new FakeCapture();
    const h = await harness(() => ok(HTML, "text/html"), {}, capture);
    const image = await h.acquire(
      submitOf(`${PAGE_REF}#ctv-canvas-1.0`, { element: "canvas", acquire: "capture" }),
    );
    assert.deepEqual([image.source, image.lowRes], ["capture", true]);
    assert.equal(capture.calls.length, 1);
    assert.equal(h.requests.length, 0);
  });

  test("an image whose URLs all fail is captured; a prefetch candidate never is", async () => {
    const capture = new FakeCapture();
    const h = await harness(() => ({ status: 404 }), {}, capture);
    assert.equal((await h.acquire(submitOf(`${CDN}/gone.png`))).source, "capture");
    assert.equal(h.requests.length, 1, "the URL was tried first");
    await rejectsWith(
      h.acquire(submitOf("https://ahead.example.net/a.png", { prefetch: true })),
      "image.http",
    );
    assert.equal(capture.calls.length, 1);
  });

  test("where a capture can never run (site off, subframe) the image keeps the fetch error", async () => {
    const capture = new FakeCapture();
    const h = await harness(() => ({ status: 404 }), {}, capture);
    capture.refusalError = new CtvError("image.capture_blocked", "site off", { detail: "site" });
    await rejectsWith(h.acquire(submitOf(`${CDN}/a.png`)), "image.http");
    capture.refusalError = new CtvError("image.capture_blocked", "hidden tab", { detail: "hidden" });
    await rejectsWith(h.acquire(submitOf(`${CDN}/b.png`)), "image.capture_blocked");
    capture.refusalError = new CtvError("image.capture_unavailable", "off screen", { detail: "offscreen" });
    await rejectsWith(h.acquire(submitOf(`${CDN}/c.png`)), "image.capture_unavailable");
    capture.refusalError = new CtvError("image.capture_blocked", "site off", { detail: "site" });
    await rejectsWith(
      h.acquire(submitOf(`${PAGE_REF}#ctv-canvas-2.0`, { element: "canvas", acquire: "capture" })),
      "image.capture_blocked",
      (e) => assert.equal(e.detail, "site", "a canvas has no other error to show"),
    );
    assert.equal(capture.calls.length, 0);
  });

  test("a host that refused the engine (403) is not fetched again while a capture is possible", async () => {
    const capture = new FakeCapture();
    const h = await harness(() => ({ status: 403 }), { site: siteWith({ referer: "origin" }) }, capture);
    assert.equal((await h.acquire(submitOf(`${CDN}/p1.png`))).source, "capture");
    assert.equal(h.requests.length, 1);
    await h.clock.advance(120_000);
    assert.equal((await h.acquire(submitOf(`${CDN}/p2.png`))).source, "capture");
    assert.equal(h.requests.length, 1, "p2 went straight to the capture");
    capture.refusalError = new CtvError("image.capture_unavailable", "off screen", { detail: "offscreen" });
    await rejectsWith(h.acquire(submitOf(`${CDN}/p3.png`)), "image.capture_unavailable");
    assert.equal(h.requests.length, 1, "off screen: no fetch that would be refused again");
    capture.refusalError = null;
    // Cookies now sent: another credentials policy may get through, so the URL is tried again.
    h.route = () => ok();
    const withCookies = await h.acquire(submitOf(`${CDN}/p4.png`), {
      site: siteWith({ credentials: "include" }),
    });
    assert.equal(withCookies.source, "url");
    assert.equal(h.requests.length, 2);
    assert.equal((await h.acquire(submitOf(`${CDN}/p5.png`))).source, "url", "a success clears the refusal");
  });
});
