// Engine image acquisition, ladder steps 1–3.
// Step 1: bytes the content script already read (data:, blob:, same-origin, CORS, canvas) are only capped and
// sniffed. Step 2: url-guard → Referer rule via sw:dnr-ensure → fetch from the extension origin with the site's
// credentials policy (omit by default), a 30 s timeout, content-type and byte caps → magic-byte sniff. altSrcs are
// tried in order when a URL fails. Step 3: a screen capture (capture.ts, injected as `capture`) of what the reader
// sees, for canvases without readable bytes and for images whose URLs all failed; never for prefetch candidates
// (not on screen, not loaded). Where a capture can never run (site not enabled, subframe) the image keeps the error
// of step 2. A host that refused the engine (final 401/403) is not fetched again with the same credentials policy
// while a capture is possible.
//
// Referer: "auto" first sends what the page itself would send under its referrer policy, and on 403 retries once
// with the full page URL and no Origin header; "page-url" and "origin" are fixed. The SW keeps ONE rule per host
// (last writer wins), so a fetch that needs a different Referer waits until every fetch using the current rule has
// its response headers; the installed rule is remembered, so sw:dnr-ensure runs once per host and Referer, not once
// per image.
//
// Politeness: at most fetchPerHostConcurrency fetches per host, prefetch starts spaced by prefetchSpacingMs, and a
// per-host backoff after 429, 503 and a final 403.

import { callSw } from "../platform/messaging.ts";
import {
  FORMAT_MIME,
  SNIFF_PREFIX_BYTES,
  couldBeImage,
  sniffImageFormat,
} from "../shared/core/image-header.ts";
import { CtvError, errorMessage, type CtvErrorOptions } from "../shared/errors.ts";
import type { ImageSubmit, ReqOf, ResOf, SwApi } from "../shared/protocol.ts";
import type { SiteSettings } from "../shared/settings.ts";
import type { Bytes } from "../shared/types.ts";
import { checkImageUrl } from "../shared/url-guard.ts";
import { decodeBytes } from "../shared/wire.ts";
import type {
  AcquireContext,
  AcquiredImage,
  CaptureStep,
  Clock,
  CoreDeps,
  FrameInfo,
  ImageAcquirer,
} from "./contracts.ts";

export const FETCH_TIMEOUT_MS = 30_000;
/** Chrome's Accept header for <img>, so a negotiating CDN serves the variant the page got. */
export const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
/** Per-host backoff steps when the response carries no usable Retry-After. */
export const HOST_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];
export const MAX_RETRY_AFTER_MS = 300_000;
/** Chrome replaces a longer referrer by its origin. */
const MAX_REFERER_LENGTH = 4096;

/* ------------------------------------------------------------------ injectable I/O */

export interface ImageFetchInit {
  method: "GET";
  credentials: "omit" | "include";
  redirect: "follow";
  cache: "default" | "no-store";
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** The part of a fetch Response the acquirer reads. */
export interface ImageFetchResponse {
  readonly status: number;
  /** Final URL after redirects ("" when unknown). */
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type ImageFetch = (url: string, init: ImageFetchInit) => Promise<ImageFetchResponse>;

/** The one SW call the acquirer makes; platform/messaging callSw fits. */
export type DnrEnsureCall = (
  type: "sw:dnr-ensure",
  payload: ReqOf<SwApi, "sw:dnr-ensure">,
) => Promise<ResOf<SwApi, "sw:dnr-ensure">>;

export interface AcquirerOverrides {
  /** Default: the global fetch. */
  fetch?: ImageFetch;
  /** Default: callSw from platform/messaging.ts. */
  callSw?: DnrEnsureCall;
  /** Screen-capture fallback; without it step 3 throws image.capture_unavailable. */
  capture?: CaptureStep;
}

/* ------------------------------------------------------------------ Referer policy (pure) */

export interface RefererConfig {
  /** null = no Referer header at all. */
  referer: string | null;
  removeOrigin: boolean;
}

const REFERRER_POLICIES = [
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
] as const;

export type ReferrerPolicyToken = (typeof REFERRER_POLICIES)[number];

/** Chrome's default since 85. */
export const DEFAULT_REFERRER_POLICY: ReferrerPolicyToken = "strict-origin-when-cross-origin";

/** <meta name=referrer> legacy keywords (HTML spec). */
const LEGACY_POLICIES: ReadonlyMap<string, ReferrerPolicyToken> = new Map([
  ["never", "no-referrer"],
  ["always", "unsafe-url"],
  ["default", DEFAULT_REFERRER_POLICY],
  ["origin-when-crossorigin", "origin-when-cross-origin"],
]);

/** img.referrerPolicy or a meta/header value (comma list: the last known token wins); unknown → the default. */
export function normalizeReferrerPolicy(raw: string | undefined): ReferrerPolicyToken {
  let policy = DEFAULT_REFERRER_POLICY;
  for (const token of (raw ?? "").split(",")) {
    const value = token.trim().toLowerCase();
    const known = REFERRER_POLICIES.find((candidate) => candidate === value) ?? LEGACY_POLICIES.get(value);
    if (known !== undefined) policy = known;
  }
  return policy;
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The page URL as a referrer: without fragment and credentials. about:blank / srcdoc frames fall back to their
 * (inherited) origin + "/", opaque or non-http origins to null.
 */
export function refererPageUrl(frame: Pick<FrameInfo, "url" | "origin">): string | null {
  const page = httpUrl(frame.url);
  if (page !== null) {
    page.hash = "";
    page.username = "";
    page.password = "";
    return page.href.length > MAX_REFERER_LENGTH ? `${page.origin}/` : page.href;
  }
  const origin = httpUrl(frame.origin);
  return origin === null ? null : `${origin.origin}/`;
}

/** Secure contexts per the Referrer Policy spec ("potentially trustworthy"), for the downgrade rule. */
function isTrustworthy(url: URL): boolean {
  const host = url.hostname;
  return (
    url.protocol === "https:" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "[::1]"
  );
}

/** What the page's own <img> request would carry under `policy` (W3C Referrer Policy §8.3). */
export function policyReferer(
  pageUrl: string | null,
  imageUrl: string,
  policy: string | undefined,
): string | null {
  const page = pageUrl === null ? null : httpUrl(pageUrl);
  const image = httpUrl(imageUrl);
  if (page === null || image === null) return null;
  const full = page.href;
  const origin = `${page.origin}/`;
  const sameOrigin = page.origin === image.origin;
  const downgrade = isTrustworthy(page) && !isTrustworthy(image);
  switch (normalizeReferrerPolicy(policy)) {
    case "no-referrer":
      return null;
    case "unsafe-url":
      return full;
    case "origin":
      return origin;
    case "same-origin":
      return sameOrigin ? full : null;
    case "origin-when-cross-origin":
      return sameOrigin ? full : origin;
    case "strict-origin":
      return downgrade ? null : origin;
    case "no-referrer-when-downgrade":
      return downgrade ? null : full;
    case "strict-origin-when-cross-origin":
      return sameOrigin ? full : downgrade ? null : origin;
  }
}

/**
 * Referer configs to try in order. "auto": the page's policy, then (on 403) the full page URL without Origin;
 * a host that already needed the second attempt starts there (`escalated`).
 */
export function refererAttempts(
  mode: SiteSettings["referer"],
  pageUrl: string | null,
  imageUrl: string,
  refPolicy: string | undefined,
  escalated: boolean,
): RefererConfig[] {
  switch (mode) {
    case "page-url":
      return [{ referer: pageUrl, removeOrigin: false }];
    case "origin": {
      const page = pageUrl === null ? null : httpUrl(pageUrl);
      return [{ referer: page === null ? null : `${page.origin}/`, removeOrigin: false }];
    }
    case "auto": {
      const full: RefererConfig = { referer: pageUrl, removeOrigin: true };
      if (escalated) return [full];
      return [{ referer: policyReferer(pageUrl, imageUrl, refPolicy), removeOrigin: false }, full];
    }
  }
}

/* ------------------------------------------------------------------ response checks (pure) */

/** image/*, octet-stream or no type at all; the magic bytes decide afterwards. */
export function isAcceptableContentType(value: string | null): boolean {
  const type = (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type === "" ||
    type.startsWith("image/") ||
    type === "application/octet-stream" ||
    type === "binary/octet-stream"
  );
}

/** Retry-After as milliseconds from `now` (delta-seconds or HTTP date), capped; null when absent or invalid. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  // HTTP dates start with a day name; Date.parse alone accepts far too much ("-5" is a year).
  if (!/^[A-Za-z]{3}/.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
}

function contentLength(headers: ImageFetchResponse["headers"]): number | null {
  const raw = headers.get("content-length")?.trim();
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
}

/* ------------------------------------------------------------------ per-host gate */

interface Limits {
  perHost: number;
  spacingMs: number;
}

interface Waiter {
  key: string;
  config: RefererConfig;
  grant: (lease: Lease) => void;
}

interface RuleSlot {
  key: string;
  /** Created by the first lease that needs it, in that lease's own async context. */
  ready: Promise<boolean> | null;
}

interface HostState {
  host: string;
  active: number;
  lastStartAt: number;
  backoffUntil: number;
  backoffStep: number;
  /** The Referer config this engine last installed for the host; null = unknown. */
  rule: RuleSlot | null;
  /** Granted fetches that have not received response headers yet (they still need `rule`). */
  ruleUsers: number;
  /** "auto" Referer: the full-URL attempt was needed here before. */
  escalated: boolean;
  /** Credentials policy under which the host answered a final 401/403; null = never refused. */
  refusedWith: SiteSettings["credentials"] | null;
  urgent: Waiter[];
  prefetch: Waiter[];
  wake: { at: number; cancel: () => void } | null;
}

interface Lease {
  /** Installs the DNR rule once per host and config; false when sw:dnr-ensure failed. */
  ensureRule(): Promise<boolean>;
  /** Response headers arrived (or the fetch failed): another Referer may be installed now. Idempotent. */
  headersReceived(): void;
  /** The fetch is over. Idempotent. */
  release(): void;
}

function ruleKey(config: RefererConfig): string {
  return JSON.stringify([config.referer, config.removeOrigin]);
}

function createHostGate(clock: Clock, ensure: (host: string, config: RefererConfig) => Promise<boolean>) {
  const hosts = new Map<string, HostState>();
  let limits: Limits = { perHost: 2, spacingMs: 150 };

  const stateOf = (host: string): HostState => {
    let state = hosts.get(host);
    if (state === undefined) {
      state = {
        host,
        active: 0,
        lastStartAt: Number.NEGATIVE_INFINITY,
        backoffUntil: 0,
        backoffStep: 0,
        rule: null,
        ruleUsers: 0,
        escalated: false,
        refusedWith: null,
        urgent: [],
        prefetch: [],
        wake: null,
      };
      hosts.set(host, state);
    }
    return state;
  };

  const wakeAt = (s: HostState, at: number): void => {
    if (s.wake !== null && s.wake.at <= at) return;
    s.wake?.cancel();
    const cancel = clock.setTimer(
      () => {
        s.wake = null;
        pump(s);
      },
      Math.max(0, at - clock.now()),
    );
    s.wake = { at, cancel };
  };

  const lease = (s: HostState, rule: RuleSlot, config: RefererConfig): Lease => {
    let waiting = true;
    let released = false;
    const headersReceived = (): void => {
      if (!waiting) return;
      waiting = false;
      s.ruleUsers -= 1;
      pump(s);
    };
    return {
      ensureRule: () => {
        rule.ready ??= ensure(s.host, config).then((ok) => {
          if (!ok && s.rule === rule) s.rule = null;
          return ok;
        });
        return rule.ready;
      },
      headersReceived,
      release: () => {
        if (released) return;
        released = true;
        s.active -= 1;
        if (waiting) headersReceived();
        else pump(s);
      },
    };
  };

  function pump(s: HostState): void {
    for (;;) {
      const queue = s.urgent.length > 0 ? s.urgent : s.prefetch;
      const next = queue[0];
      if (next === undefined || s.active >= limits.perHost) return;
      const now = clock.now();
      if (now < s.backoffUntil) {
        wakeAt(s, s.backoffUntil);
        return;
      }
      // One rule per host: a different Referer waits until the current rule's fetches have their headers.
      if (s.rule !== null && s.rule.key !== next.key && s.ruleUsers > 0) return;
      if (queue === s.prefetch && now < s.lastStartAt + limits.spacingMs) {
        wakeAt(s, s.lastStartAt + limits.spacingMs);
        return;
      }
      queue.shift();
      s.active += 1;
      s.lastStartAt = now;
      if (s.rule === null || s.rule.key !== next.key) s.rule = { key: next.key, ready: null };
      s.ruleUsers += 1;
      next.grant(lease(s, s.rule, next.config));
    }
  }

  return {
    configure(next: Limits): void {
      limits = { perHost: Math.max(1, next.perHost), spacingMs: Math.max(0, next.spacingMs) };
    },
    acquire(host: string, config: RefererConfig, prefetch: boolean): Promise<Lease> {
      const s = stateOf(host);
      return new Promise((resolve) => {
        (prefetch ? s.prefetch : s.urgent).push({ key: ruleKey(config), config, grant: resolve });
        pump(s);
      });
    },
    escalated(host: string): boolean {
      return hosts.get(host)?.escalated ?? false;
    },
    succeeded(host: string, escalatedNow: boolean): void {
      const s = stateOf(host);
      s.backoffStep = 0;
      s.refusedWith = null;
      if (escalatedNow) s.escalated = true;
    },
    refused(host: string, credentials: SiteSettings["credentials"]): void {
      stateOf(host).refusedWith = credentials;
    },
    refusedWith(host: string): SiteSettings["credentials"] | null {
      return hosts.get(host)?.refusedWith ?? null;
    },
    /** Starts (or extends) the host's backoff; returns the delay applied. */
    backoff(host: string, retryAfterMs: number | null): number {
      const s = stateOf(host);
      const step = HOST_BACKOFF_MS[Math.min(s.backoffStep, HOST_BACKOFF_MS.length - 1)] ?? 0;
      s.backoffStep += 1;
      const delay = Math.min(retryAfterMs ?? step, MAX_RETRY_AFTER_MS);
      s.backoffUntil = Math.max(s.backoffUntil, clock.now() + delay);
      return delay;
    },
    /** A 403 may mean the rule was evicted in the SW: install it again next time. */
    forgetRule(host: string): void {
      const s = hosts.get(host);
      if (s !== undefined && s.ruleUsers === 0) s.rule = null;
    },
  };
}

/* ------------------------------------------------------------------ acquirer */

type AttemptOutcome =
  | { kind: "image"; image: AcquiredImage; ensured: boolean }
  | { kind: "status"; status: number; retryAfterMs: number | null; ensured: boolean };

function blocked(reason: string): CtvError {
  return new CtvError("image.url_blocked", `image URL blocked (${reason})`, { detail: reason });
}

function notImage(message: string, detail: string): CtvError {
  return new CtvError("image.not_image", message, { detail });
}

function tooLarge(bytes: number, cap: number): CtvError {
  return new CtvError("image.too_large", `image has more than ${cap} bytes (${bytes})`, { detail: "bytes" });
}

function transportError(error: unknown, timedOut: boolean): CtvError {
  if (error instanceof CtvError) return error;
  if (timedOut) {
    return new CtvError("image.http", `image fetch timed out after ${FETCH_TIMEOUT_MS} ms`, {
      retryable: true,
      detail: "timeout",
      cause: error,
    });
  }
  return new CtvError("image.http", `image fetch failed: ${errorMessage(error)}`, {
    retryable: true,
    detail: "network",
    cause: error,
  });
}

function statusError(status: number, retryAfterMs: number | null, ensureFailed: boolean): CtvError {
  if (ensureFailed && (status === 401 || status === 403)) {
    return new CtvError("dnr.failed", `HTTP ${status} while the Referer rule could not be installed`, {
      status,
      retryable: true,
    });
  }
  const options: CtvErrorOptions = { status, retryable: status === 408 || status === 429 || status >= 500 };
  if (retryAfterMs !== null) options.retryAfterMs = retryAfterMs;
  return new CtvError("image.http", `image HTTP ${status}`, options);
}

/** Lazy-load attributes (data-src, ...) may be relative: resolve them like the page would; the guard runs after. */
function resolveAgainst(url: string, pageUrl: string): string {
  try {
    return new URL(url, pageUrl).href;
  } catch {
    return url;
  }
}

/** First error of a URL that was actually fetched; "blocked" only when no URL got that far. */
function pickError(errors: readonly CtvError[]): CtvError | undefined {
  return errors.find((error) => error.code !== "image.url_blocked") ?? errors[0];
}

/** Step 1: bytes read by the content script. */
export function acquiredFromBytes(value: Bytes, maxBytes: number): AcquiredImage {
  let bytes: ArrayBuffer;
  try {
    bytes = decodeBytes(value);
  } catch (error) {
    throw new CtvError("image.not_image", `undecodable image bytes: ${errorMessage(error)}`, {
      detail: "bytes",
      cause: error,
    });
  }
  if (bytes.byteLength > maxBytes) throw tooLarge(bytes.byteLength, maxBytes);
  const format = sniffImageFormat(new Uint8Array(bytes));
  if (format === null) throw notImage("content-script bytes are not a supported image", "bytes");
  return { bytes, mime: FORMAT_MIME[format], source: "bytes", lowRes: false, url: null };
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk.subarray(0, Math.min(chunk.byteLength, total - at)), at);
    at += chunk.byteLength;
    if (at >= total) break;
  }
  return out;
}

/** Streams the body with a running byte cap and an early magic-byte check. */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  abort: () => void,
  timedOut: () => boolean,
): Promise<ArrayBuffer> {
  if (body === null) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let checked = false;
  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        throw transportError(error, timedOut());
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) throw tooLarge(total, maxBytes);
      chunks.push(result.value);
      if (!checked && total >= SNIFF_PREFIX_BYTES) {
        checked = true;
        if (!couldBeImage(concat(chunks, SNIFF_PREFIX_BYTES)))
          throw notImage("response is not an image", "magic");
      }
    }
  } catch (error) {
    abort();
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  return concat(chunks, total).buffer;
}

function discard(response: ImageFetchResponse): void {
  if (response.body !== null && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

export function createAcquirer(deps: CoreDeps & AcquirerOverrides): ImageAcquirer {
  const fetchImage: ImageFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const ensureCall: DnrEnsureCall = deps.callSw ?? callSw;
  const capture = deps.capture;
  const { clock, log } = deps;

  const gate = createHostGate(clock, async (host, config) => {
    try {
      await ensureCall("sw:dnr-ensure", { host, referer: config.referer, removeOrigin: config.removeOrigin });
      return true;
    } catch (error) {
      // dnr.failed: fetch once without the rule; a 401/403 then reports dnr.failed.
      log.warn("sw:dnr-ensure failed", { host, error: errorMessage(error) }, "dnr.failed");
      return false;
    }
  });

  async function fetchOnce(
    url: string,
    host: string,
    config: RefererConfig,
    options: { prefetch: boolean; retry: boolean; ctx: AcquireContext; allowHosts: readonly string[] },
  ): Promise<AttemptOutcome> {
    const lease = await gate.acquire(host, config, options.prefetch);
    const controller = new AbortController();
    let timedOut = false;
    let cancelTimer: (() => void) | null = null;
    try {
      const ensured = await lease.ensureRule();
      cancelTimer = clock.setTimer(() => {
        timedOut = true;
        controller.abort();
      }, FETCH_TIMEOUT_MS);
      let response: ImageFetchResponse;
      try {
        response = await fetchImage(url, {
          method: "GET",
          credentials: options.ctx.site.credentials,
          redirect: "follow",
          // A retry must not be answered from a cached refusal.
          cache: options.retry ? "no-store" : "default",
          headers: { Accept: IMAGE_ACCEPT },
          signal: controller.signal,
        });
      } catch (error) {
        throw transportError(error, timedOut);
      } finally {
        lease.headersReceived();
      }
      const finalUrl = response.url === "" ? url : response.url;
      if (finalUrl !== url) {
        const recheck = checkImageUrl(finalUrl, { allowHosts: options.allowHosts });
        if (!recheck.ok) {
          discard(response);
          throw blocked(`redirect:${recheck.reason}`);
        }
      }
      if (response.status < 200 || response.status > 299) {
        discard(response);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), clock.now());
        return { kind: "status", status: response.status, retryAfterMs, ensured };
      }
      if (!isAcceptableContentType(response.headers.get("content-type"))) {
        discard(response);
        throw notImage(`content-type ${response.headers.get("content-type") ?? ""} is not an image`, "type");
      }
      const maxBytes = options.ctx.settings.privacy.maxImageBytes;
      const declared = contentLength(response.headers);
      if (declared !== null && declared > maxBytes) {
        discard(response);
        throw tooLarge(declared, maxBytes);
      }
      const bytes = await readBody(
        response.body,
        maxBytes,
        () => controller.abort(),
        () => timedOut,
      );
      const format = sniffImageFormat(new Uint8Array(bytes));
      if (format === null) throw notImage("response is not a supported image", "magic");
      const image: AcquiredImage = {
        bytes,
        mime: FORMAT_MIME[format],
        source: "url",
        lowRes: false,
        url: finalUrl,
      };
      return { kind: "image", image, ensured };
    } finally {
      cancelTimer?.();
      lease.release();
    }
  }

  async function fetchUrl(url: string, submit: ImageSubmit, ctx: AcquireContext): Promise<AcquiredImage> {
    const allowHosts = __DEV__ || __TEST__ ? ctx.settings.privacy.devFixtureHosts : [];
    const checked = checkImageUrl(url, { allowHosts });
    if (!checked.ok) throw blocked(checked.reason);
    const host = new URL(checked.url).hostname;
    const auto = ctx.site.referer === "auto";
    const attempts = refererAttempts(
      ctx.site.referer,
      refererPageUrl(ctx.frame),
      checked.url,
      submit.refPolicy,
      gate.escalated(host),
    );
    let ensureFailed = false;
    for (const [index, config] of attempts.entries()) {
      const outcome = await fetchOnce(checked.url, host, config, {
        prefetch: submit.prefetch === true && index === 0,
        retry: index > 0,
        ctx,
        allowHosts,
      });
      if (!outcome.ensured) ensureFailed = true;
      if (outcome.kind === "image") {
        gate.succeeded(host, auto && index > 0);
        return outcome.image;
      }
      const { status } = outcome;
      if (status === 403 && index + 1 < attempts.length) {
        log.debug("image 403, retrying with the full page URL and no Origin", { host }, "image.http");
        continue;
      }
      let retryAfterMs: number | null = null;
      if (status === 429 || status === 503) retryAfterMs = gate.backoff(host, outcome.retryAfterMs);
      else if (status === 403) {
        gate.backoff(host, null);
        gate.forgetRule(host);
      }
      if (status === 401 || status === 403) gate.refused(host, ctx.site.credentials);
      throw statusError(status, retryAfterMs, ensureFailed);
    }
    // refererAttempts never returns an empty list.
    throw new CtvError("engine.internal", "no Referer attempt");
  }

  /** Every URL's host refused the engine under this credentials policy: a capture is the only way left. */
  function skipFetch(urls: readonly string[], submit: ImageSubmit, ctx: AcquireContext): boolean {
    if (capture === undefined || submit.prefetch === true || urls.length === 0) return false;
    return urls.every((url) => {
      try {
        return gate.refusedWith(new URL(url).hostname) === ctx.site.credentials;
      } catch {
        return false;
      }
    });
  }

  /** Ladder step 3; `cause` is the error of steps 1–2, shown instead when a capture can never run here. */
  async function step3(
    submit: ImageSubmit,
    ctx: AcquireContext,
    cause: CtvError | undefined,
  ): Promise<AcquiredImage> {
    const unsupported =
      cause ??
      new CtvError("image.capture_unavailable", "screen capture is not supported", { detail: "unsupported" });
    if (capture === undefined || submit.prefetch === true) throw unsupported;
    const refusal = capture.refusal(submit, ctx);
    if (refusal !== null) {
      const never =
        refusal.code === "image.capture_blocked" && (refusal.detail === "site" || refusal.detail === "frame");
      throw never && cause !== undefined ? cause : refusal;
    }
    return capture.capture(submit, ctx);
  }

  return {
    async acquire(submit: ImageSubmit, ctx: AcquireContext): Promise<AcquiredImage> {
      gate.configure({
        perHost: ctx.settings.discovery.fetchPerHostConcurrency,
        spacingMs: ctx.settings.discovery.prefetchSpacingMs,
      });
      const errors: CtvError[] = [];
      if (submit.acquire === "bytes" && submit.bytes !== undefined) {
        try {
          return acquiredFromBytes(submit.bytes, ctx.settings.privacy.maxImageBytes);
        } catch (error) {
          // Unreadable bytes (e.g. an HTML error page read same-origin): the engine fetch may still work.
          if (!(error instanceof CtvError) || error.code !== "image.not_image") throw error;
          errors.push(error);
        }
      }
      // A canvas's src is a synthetic page URL (discovery canvasSrc): fetching it would only download the reader
      // page, so only a screen capture can read a canvas without bytes.
      if (submit.element === "canvas" || submit.acquire === "capture") return step3(submit, ctx, errors[0]);
      const urls = [
        ...new Set(
          [submit.src, ...(submit.altSrcs ?? [])]
            .map((url) => url.trim())
            .filter((url) => url !== "")
            .map((url) => resolveAgainst(url, ctx.frame.url)),
        ),
      ];
      if (skipFetch(urls, submit, ctx)) {
        const refusal = capture?.refusal(submit, ctx) ?? null;
        if (refusal === null) return step3(submit, ctx, undefined);
        // Off screen: fetching would only be refused again. Blocked: the fetch error says more.
        if (refusal.code === "image.capture_unavailable") throw refusal;
      }
      for (const url of urls) {
        try {
          return await fetchUrl(url, submit, ctx);
        } catch (error) {
          if (!(error instanceof CtvError)) throw error;
          errors.push(error);
          log.debug("image URL failed", { code: error.code, status: error.status ?? null });
        }
      }
      return step3(submit, ctx, pickError(errors) ?? blocked("malformed"));
    },
  };
}
