// The content script's connection to the offscreen engine. The Port is opened lazily by the first submit:
// sw:ensure-engine, Port "engine", cs:hello → en:hello with the codec probe, then every pending submit is (re)sent in
// priority order. A lost connection backs off 250 ms … 8 s (±20 %), asks the SW to recreate a wedged engine after 3
// fast failures and gives up after 10 visible minutes. BFCache suspends the client, an invalidated extension context
// kills it for good, and an idle port closes itself so an open chapter tab does not keep the engine alive. Image
// bytes never outlive a failed attempt: the controller re-reads them (deps.reread) when they are needed again.
// An img:retry or unit:retranslate puts its (settled) image back among the pending ones, so the port stays open until
// the engine is done with it again, and a lost connection resubmits it.

import { isContextValid } from "../platform/context.ts";
import type { Logger } from "../platform/log.ts";
import { callSw } from "../platform/messaging.ts";
import { wrapPort, type TypedPort } from "../platform/port.ts";
import type { Clock } from "../shared/clock.ts";
import { jitter } from "../shared/core/retry-policy.ts";
import { CtvError, errorMessage, type ErrorCode, type ErrorInfo } from "../shared/errors.ts";
import {
  PORT_ENGINE,
  PROTOCOL_VERSION,
  type CsToEngine,
  type CsToEngineMap,
  type EngineToCs,
  type EngineToCsMap,
  type ImageSubmit,
  type PageHints,
} from "../shared/protocol.ts";
import type { Codec, ImageState } from "../shared/types.ts";
import { encodeBytes, estimateWireBytes, hardLimitFor, isProbe, makeProbe } from "../shared/wire.ts";
import type { EngineClient, EngineClientState } from "./contracts.ts";

/* ------------------------------------------------------------------ parameters */

export const BACKOFF_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000];
export const BACKOFF_CAP_MS = 8_000;
export const BACKOFF_JITTER = 0.2;
/** A connection that lived this long resets the backoff and the failure window. */
export const STABLE_RESET_MS = 30_000;
/** An attempt that fails this fast while the engine "exists" counts towards a forced recreate. */
export const FAST_FAILURE_MS = 1_000;
export const FAST_FAILURES_FOR_FORCE = 3;
/** Continuous failure (visible time only) before the loop stops with engine.unavailable. */
export const GIVE_UP_MS = 10 * 60_000;
export const HELLO_TIMEOUT_MS = 10_000;
export const ENSURE_TIMEOUT_MS = 15_000;
/** Reconnect delay after en:closing (the SW awaits the close, then creates a new engine). */
export const CLOSING_RETRY_MS = 500;
/** Re-send delay for submits the engine dropped while booting (engine.overloaded). */
export const RESEND_DELAY_MS = 1_000;

/* ------------------------------------------------------------------ injectable environment */

export type PageEvent = "visible" | "hidden" | "bfcache-hide" | "bfcache-show" | "resume";

/** Visibility and page-lifecycle signals (document + window in production, a fake in tests). */
export interface PageLifecycle {
  visible(): boolean;
  subscribe(listener: (event: PageEvent) => void): () => void;
}

export function documentLifecycle(doc: Document, win: Window): PageLifecycle {
  return {
    visible: () => doc.visibilityState === "visible",
    subscribe(listener) {
      const onVisibility = (): void => listener(doc.visibilityState === "visible" ? "visible" : "hidden");
      const onHide = (event: PageTransitionEvent): void => {
        if (event.persisted) listener("bfcache-hide");
      };
      const onShow = (event: PageTransitionEvent): void => {
        if (event.persisted) listener("bfcache-show");
      };
      const onResume = (): void => listener("resume");
      doc.addEventListener("visibilitychange", onVisibility);
      win.addEventListener("pagehide", onHide);
      win.addEventListener("pageshow", onShow);
      doc.addEventListener("resume", onResume);
      return () => {
        doc.removeEventListener("visibilitychange", onVisibility);
        win.removeEventListener("pagehide", onHide);
        win.removeEventListener("pageshow", onShow);
        doc.removeEventListener("resume", onResume);
      };
    },
  };
}

/* ------------------------------------------------------------------ pure decisions */

/** Delay before reconnect attempt `attempt` (0-based): 250 · 2^n ms ± 20 %, never above 8 s. */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)] ?? BACKOFF_CAP_MS;
  return Math.min(BACKOFF_CAP_MS, jitter(base, random, BACKOFF_JITTER));
}

/** Codec after en:hello: structured clone only if both probes survived; announce b64 when ours saw a broken one. */
export function negotiateCodec(hello: { codec: Codec; probe: unknown }): { codec: Codec; announce: boolean } {
  const probeOk = isProbe(hello.probe);
  return { codec: probeOk && hello.codec === "sc" ? "sc" : "b64", announce: !probeOk };
}

/** Errors after which the engine expects the same submit again (it dropped it while booting or closing). */
export const RESEND_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "engine.overloaded",
  "engine.closing",
]);

const TERMINAL_STATES: ReadonlySet<ImageState> = new Set<ImageState>([
  "done",
  "no-text",
  "partial",
  "refused",
  "error",
  "stale",
]);

/** The engine needs nothing more for this image: it is not resubmitted after a reconnect. */
export function isTerminal(state: ImageState, error?: ErrorInfo): boolean {
  if (state === "error" && error !== undefined && RESEND_CODES.has(error.code)) return false;
  return TERMINAL_STATES.has(state);
}

/** The submit without its bytes: the engine fetches the URL itself (ladder step 2). */
export function asUrlSubmit(submit: ImageSubmit): ImageSubmit {
  const { bytes: _bytes, mime: _mime, source: _source, ...rest } = submit;
  return { ...rest, acquire: "url" };
}

function withoutBytes(submit: ImageSubmit): ImageSubmit {
  const { bytes: _bytes, ...rest } = submit;
  return rest;
}

function encodeSubmit(submit: ImageSubmit, codec: Codec): ImageSubmit {
  if (codec !== "b64" || !(submit.bytes instanceof ArrayBuffer)) return submit;
  return { ...submit, bytes: encodeBytes(submit.bytes, "b64") };
}

function isInvalidation(error: unknown): boolean {
  if (error instanceof CtvError) return error.code === "ctx.invalidated";
  return /Extension context invalidated/i.test(errorMessage(error));
}

/* ------------------------------------------------------------------ the client */

export interface EngineClientDeps {
  mode: "auto" | "manual";
  /** cs:hello page hints, read at every connect. */
  pageHints(): PageHints;
  page: PageLifecycle;
  clock: Clock;
  /** [0, 1); drives the backoff jitter. */
  random: () => number;
  log: Logger;
  /** settings.engine.portIdleMin in ms: the port closes after this long with nothing pending. */
  portIdleMs: number;
  /** Rebuilds a submit whose bytes were dropped (re-reads the element); null forgets the image. */
  reread?: (submit: ImageSubmit) => Promise<ImageSubmit | null>;
  /** chrome seams (defaults: callSw sw:ensure-engine, runtime.connect, runtime.id). */
  ensureEngine?: (force: boolean) => Promise<{ created: boolean }>;
  connect?: () => chrome.runtime.Port;
  isContextValid?: () => boolean;
  build?: string;
}

type CsPort = TypedPort<EngineToCsMap, CsToEngineMap>;
type AnyHandler = (message: EngineToCs) => void;

interface Pending {
  readonly key: string;
  /** Carries bytes only until it is posted (or the attempt fails). */
  submit: ImageSubmit;
  /** Connection generation it was posted on; never equal to a later connection's. */
  postedOn: number;
}

/** Settled submits kept so an img:retry / unit:retranslate can make their image pending again. */
export const MAX_SETTLED = 500;

/** Engine messages the client itself reacts to; user handlers of these types run afterwards. */
const INTERNAL_TYPES: readonly (keyof EngineToCsMap)[] = ["en:hello", "en:closing", "img:state", "img:done"];

function ensureViaSw(force: boolean): Promise<{ created: boolean }> {
  return callSw("sw:ensure-engine", force ? { reason: "cs", force: true } : { reason: "cs" }, {
    timeoutMs: ENSURE_TIMEOUT_MS,
  });
}

export function createEngineClient(deps: EngineClientDeps): EngineClient {
  const { clock, log, page } = deps;
  const ensureEngine = deps.ensureEngine ?? ensureViaSw;
  const openPort = deps.connect ?? ((): chrome.runtime.Port => chrome.runtime.connect({ name: PORT_ENGINE }));
  const contextValid = deps.isContextValid ?? isContextValid;
  const build = deps.build ?? __BUILD_ID__;

  let state: EngineClientState = "idle";
  let codec: Codec = "sc";
  let port: CsPort | null = null;
  let portTypes = new Set<string>();
  /** Bumped whenever an attempt or connection is abandoned, so late async results are ignored. */
  let generation = 0;
  /** Generation of the open connection; 0 while not open. */
  let openGeneration = 0;
  let openedAt = 0;
  let attemptStartedAt = 0;
  /** sw:ensure-engine result of the current attempt; null when it failed or is still running. */
  let attemptCreated: boolean | null = null;
  let closingSeen = false;
  let attemptIndex = 0;
  let fastFailures = 0;
  let forceNext = false;
  let gaveUp = false;
  // Failure window, counted in visible time only (give up after 10 min of continuous failure while visible).
  let failingSince: number | null = null;
  let hiddenMs = 0;
  let hiddenAt: number | null = null;
  let cancelRetry: (() => void) | null = null;
  let cancelHello: (() => void) | null = null;
  let cancelIdle: (() => void) | null = null;
  let cancelResend: (() => void) | null = null;

  const pending = new Map<string, Pending>();
  /** imageKey → the last submit of a settled image (without bytes), least recently settled first. */
  const settled = new Map<string, ImageSubmit>();
  const handlers = new Map<string, Set<AnyHandler>>();
  const stateListeners = new Set<(state: EngineClientState) => void>();
  const offPage = page.subscribe(onPageEvent);

  function setState(next: EngineClientState): void {
    if (state === next) return;
    state = next;
    log.debug("engine client state", { state: next });
    for (const listener of [...stateListeners]) {
      try {
        listener(next);
      } catch (error) {
        log.warn("engine client state listener threw", { error: errorMessage(error) });
      }
    }
  }

  function clearTimers(): void {
    cancelRetry?.();
    cancelHello?.();
    cancelIdle?.();
    cancelResend?.();
    cancelRetry = cancelHello = cancelIdle = cancelResend = null;
  }

  /** Closes the current port without treating it as a failure. */
  function dropPort(): void {
    const current = port;
    port = null;
    openGeneration = 0;
    current?.close();
  }

  function stripBytes(): void {
    for (const entry of pending.values()) {
      if (entry.submit.bytes !== undefined) entry.submit = withoutBytes(entry.submit);
    }
  }

  function resetFailures(): void {
    attemptIndex = 0;
    fastFailures = 0;
    failingSince = null;
    hiddenMs = 0;
    hiddenAt = null;
  }

  function failingVisibleMs(now: number): number {
    if (failingSince === null) return 0;
    return now - failingSince - hiddenMs - (hiddenAt === null ? 0 : now - hiddenAt);
  }

  /* ---- connect ---- */

  function startAttempt(): void {
    if (state === "dead") return;
    cancelRetry?.();
    cancelRetry = null;
    if (!contextValid()) {
      shutdown();
      return;
    }
    generation += 1;
    const gen = generation;
    const force = forceNext;
    forceNext = false;
    attemptStartedAt = clock.now();
    attemptCreated = null;
    closingSeen = false;
    setState("connecting");
    runAttempt(gen, force).catch((error: unknown) => {
      log.error("engine connect attempt threw", { error: errorMessage(error) });
      if (gen === generation && state === "connecting") {
        dropPort();
        failed();
      }
    });
  }

  async function runAttempt(gen: number, force: boolean): Promise<void> {
    let created: boolean;
    try {
      created = (await ensureEngine(force)).created;
    } catch (error) {
      if (gen !== generation) return;
      if (isInvalidation(error) || !contextValid()) {
        shutdown();
        return;
      }
      log.info("sw:ensure-engine failed", { error: errorMessage(error) });
      failed();
      return;
    }
    if (gen !== generation) return;
    attemptCreated = created;
    let raw: chrome.runtime.Port;
    try {
      raw = openPort();
    } catch (error) {
      if (isInvalidation(error) || !contextValid()) {
        shutdown();
        return;
      }
      log.info("runtime.connect failed", { error: errorMessage(error) });
      failed();
      return;
    }
    const next = wrapPort<EngineToCsMap, CsToEngineMap>(raw, { ctx: "cs", log });
    port = next;
    portTypes = new Set();
    next.onClose((lastError) => onPortClosed(next, lastError));
    for (const type of [...INTERNAL_TYPES, ...handlers.keys()]) subscribe(next, type);
    cancelHello = clock.setTimer(() => {
      cancelHello = null;
      if (port !== next || state !== "connecting") return;
      log.warn("no en:hello in time", { ms: HELLO_TIMEOUT_MS });
      dropPort();
      failed();
    }, HELLO_TIMEOUT_MS);
    next.post({
      type: "cs:hello",
      v: PROTOCOL_VERSION,
      build,
      probe: makeProbe(),
      mode: deps.mode,
      page: deps.pageHints(),
    });
  }

  function onHello(from: CsPort, hello: EngineToCsMap["en:hello"]): void {
    if (port !== from || state !== "connecting") return;
    cancelHello?.();
    cancelHello = null;
    if (hello.v !== PROTOCOL_VERSION) {
      dropPort();
      giveUp("engine.protocol", `engine protocol ${hello.v}, content script protocol ${PROTOCOL_VERSION}`);
      return;
    }
    const negotiated = negotiateCodec(hello);
    codec = negotiated.codec;
    from.codec = codec;
    if (negotiated.announce) from.post({ type: "cs:codec", codec: "b64" });
    if (codec !== "sc") log.info("engine port uses the base64 codec");
    gaveUp = false;
    openGeneration = generation;
    openedAt = clock.now();
    setState("open");
    sendPending(openGeneration);
  }

  /* ---- (re)submission ---- */

  function prepare(submit: ImageSubmit): ImageSubmit | Promise<ImageSubmit | null> {
    if (submit.acquire !== "bytes" || submit.bytes !== undefined) return submit;
    const reread = deps.reread;
    if (reread === undefined) return asUrlSubmit(submit);
    return reread(submit).catch((error: unknown) => {
      log.warn("re-reading image bytes failed", { imageKey: submit.imageKey, error: errorMessage(error) });
      return asUrlSubmit(submit);
    });
  }

  function postSubmit(entry: Pending): boolean {
    const current = port;
    if (current === null || state !== "open") return false;
    // Estimated before encoding: base64 of an oversized image would be wasted work.
    if (estimateWireBytes({ type: "img:submit", ...entry.submit }, codec) > hardLimitFor(codec)) {
      log.warn("image bytes over the message limit; the engine fetches the URL", { imageKey: entry.key });
      entry.submit = asUrlSubmit(entry.submit);
    }
    const message: CsToEngine = { type: "img:submit", ...encodeSubmit(entry.submit, codec) };
    if (!current.post(message)) return false;
    entry.postedOn = openGeneration;
    entry.submit = withoutBytes(entry.submit);
    return true;
  }

  function sendPending(gen: number): void {
    const entries = [...pending.values()]
      .filter((entry) => entry.postedOn !== gen)
      .sort((a, b) => a.submit.priority - b.submit.priority);
    if (entries.length === 0) {
      armIdle();
      return;
    }
    postInOrder(entries, gen).catch((error: unknown) => {
      log.error("resubmitting images failed", { error: errorMessage(error) });
    });
  }

  /** Bytes are re-read in parallel but posted strictly in priority order. */
  async function postInOrder(entries: readonly Pending[], gen: number): Promise<void> {
    const prepared = entries.map((entry) => ({ entry, ready: prepare(entry.submit) }));
    for (const { entry, ready } of prepared) {
      const submit = await ready;
      if (gen !== openGeneration) return;
      if (pending.get(entry.key) !== entry || entry.postedOn === gen) continue;
      if (submit === null) {
        pending.delete(entry.key);
        continue;
      }
      entry.submit = { ...submit, imageKey: entry.key };
      postSubmit(entry);
    }
    armIdle();
  }

  function scheduleResend(): void {
    if (cancelResend !== null || state !== "open") return;
    cancelResend = clock.setTimer(() => {
      cancelResend = null;
      if (state === "open") sendPending(openGeneration);
    }, RESEND_DELAY_MS);
  }

  /* ---- incoming messages ---- */

  function subscribe(target: CsPort, type: string): void {
    if (target !== port || portTypes.has(type)) return;
    portTypes.add(type);
    target.on(type as keyof EngineToCsMap, (message) => onPortMessage(target, message as EngineToCs));
  }

  function onPortMessage(from: CsPort, message: EngineToCs): void {
    if (port !== from) return;
    if (message.type === "en:hello") onHello(from, message);
    else if (message.type === "en:closing") closingSeen = true;
    else if (message.type === "img:state") onImageState(message.imageKey, message.state, message.error);
    else if (message.type === "img:done") settle(message.imageKey);
    emit(message);
  }

  function emit(message: EngineToCs): void {
    const set = handlers.get(message.type);
    if (set === undefined) return;
    for (const handler of [...set]) {
      try {
        handler(message);
      } catch (error) {
        log.warn("engine message handler threw", { type: message.type, error: errorMessage(error) });
      }
    }
  }

  function onImageState(imageKey: string, imageState: ImageState, error: ErrorInfo | undefined): void {
    const entry = pending.get(imageKey);
    if (entry === undefined) return;
    if (imageState === "error" && error !== undefined && RESEND_CODES.has(error.code)) {
      entry.postedOn = 0;
      scheduleResend();
    } else if (isTerminal(imageState, error)) {
      settle(imageKey);
    } else if (imageState === "waiting" && entry.submit.prefetch === true) {
      // A detected prefetch candidate needs nothing more until the controller asks for its translation.
      settle(imageKey);
    }
  }

  function settle(imageKey: string): void {
    const entry = pending.get(imageKey);
    if (entry === undefined) return;
    pending.delete(imageKey);
    settled.delete(imageKey);
    settled.set(imageKey, withoutBytes(entry.submit));
    if (settled.size > MAX_SETTLED) {
      const oldest = settled.keys().next();
      if (oldest.done !== true) settled.delete(oldest.value);
    }
    if (pending.size === 0) armIdle();
  }

  /** The engine works on a settled image again (img:retry, unit:retranslate posted on this connection). */
  function reopen(imageKey: string): void {
    const submit = settled.get(imageKey);
    if (submit === undefined || pending.has(imageKey)) return;
    settled.delete(imageKey);
    pending.set(imageKey, { key: imageKey, submit, postedOn: openGeneration });
    cancelIdle?.();
    cancelIdle = null;
  }

  /* ---- disconnects, backoff and give-up ---- */

  function onPortClosed(closed: CsPort, lastError: string | null): void {
    if (port !== closed) return;
    port = null;
    const wasOpen = state === "open";
    openGeneration = 0;
    cancelHello?.();
    cancelIdle?.();
    cancelResend?.();
    cancelHello = cancelIdle = cancelResend = null;
    if (state === "dead" || state === "suspended") return;
    if (!contextValid()) {
      shutdown();
      return;
    }
    log.info("engine port closed", { wasOpen, lastError });
    if (wasOpen && clock.now() - openedAt >= STABLE_RESET_MS) resetFailures();
    if (closingSeen) {
      scheduleRetry(CLOSING_RETRY_MS);
      return;
    }
    // Nothing to resend: reconnecting would only recreate an engine nobody needs (lazy connect on the next submit).
    if (pending.size === 0) {
      setState("idle");
      return;
    }
    failed();
  }

  function failed(): void {
    const now = clock.now();
    stripBytes();
    if (failingSince === null) {
      failingSince = now;
      hiddenMs = 0;
      hiddenAt = page.visible() ? null : now;
    }
    const fast = attemptCreated === false && now - attemptStartedAt <= FAST_FAILURE_MS;
    fastFailures = fast ? fastFailures + 1 : 0;
    if (fastFailures >= FAST_FAILURES_FOR_FORCE) {
      fastFailures = 0;
      forceNext = true;
      log.warn("the engine keeps failing right after connecting; asking the SW to recreate it");
    }
    if (failingVisibleMs(now) >= GIVE_UP_MS) {
      giveUp("engine.unavailable", `no engine connection for ${GIVE_UP_MS / 60_000} min`);
      return;
    }
    const delay = backoffDelay(attemptIndex, deps.random);
    attemptIndex += 1;
    scheduleRetry(delay);
  }

  /** Backoff timers run only while the page is visible; becoming visible retries at once. */
  function scheduleRetry(delayMs: number): void {
    cancelRetry?.();
    cancelRetry = null;
    setState("backoff");
    if (page.visible()) cancelRetry = clock.setTimer(retryNow, delayMs);
  }

  function retryNow(): void {
    cancelRetry = null;
    if (state !== "backoff") return;
    if (pending.size === 0) {
      setState("idle");
      return;
    }
    startAttempt();
  }

  /** Stops the loop; the pending images show the error and a user retry (submit) starts again. */
  function giveUp(code: ErrorCode, message: string): void {
    cancelRetry?.();
    cancelRetry = null;
    gaveUp = true;
    resetFailures();
    stripBytes();
    setState("idle");
    log.error("engine connection given up", { code });
    const error: ErrorInfo = { code, message, retryable: false };
    for (const imageKey of [...pending.keys()]) emit({ type: "img:state", imageKey, state: "error", error });
  }

  function armIdle(): void {
    cancelIdle?.();
    cancelIdle = null;
    if (state !== "open" || pending.size > 0) return;
    cancelIdle = clock.setTimer(() => {
      cancelIdle = null;
      if (state !== "open" || pending.size > 0) return;
      log.info("engine port idle; closing it");
      dropPort();
      resetFailures();
      setState("idle");
    }, deps.portIdleMs);
  }

  /* ---- page lifecycle (visibility, BFCache) ---- */

  function onPageEvent(event: PageEvent): void {
    if (state === "dead") return;
    const now = clock.now();
    switch (event) {
      case "hidden":
        if (failingSince !== null && hiddenAt === null) hiddenAt = now;
        if (state === "backoff") {
          cancelRetry?.();
          cancelRetry = null;
        }
        notifyVisibility(false);
        return;
      case "visible":
        if (hiddenAt !== null) {
          hiddenMs += now - hiddenAt;
          hiddenAt = null;
        }
        notifyVisibility(true);
        if (state === "backoff") retryNow();
        return;
      case "bfcache-hide":
        suspend();
        return;
      case "bfcache-show":
        resumeFromCache();
        return;
      case "resume":
        if (state === "backoff" && page.visible()) retryNow();
        return;
    }
  }

  function notifyVisibility(visible: boolean): void {
    if (state === "open" && port !== null) port.post({ type: "cs:visibility", visible });
  }

  /** pagehide persisted: no reconnect attempts while the page sits in the back/forward cache. */
  function suspend(): void {
    if (state === "suspended") return;
    generation += 1;
    clearTimers();
    dropPort();
    stripBytes();
    setState("suspended");
  }

  /** pageshow persisted: reconnect at once and resubmit everything not finished. */
  function resumeFromCache(): void {
    if (state !== "suspended") return;
    gaveUp = false;
    resetFailures();
    if (pending.size === 0) setState("idle");
    else startAttempt();
  }

  /** Permanent: context invalidated or close(). A dead client never retries. */
  function shutdown(): void {
    if (state === "dead") return;
    generation += 1;
    clearTimers();
    dropPort();
    offPage();
    pending.clear();
    settled.clear();
    setState("dead");
    handlers.clear();
    stateListeners.clear();
  }

  const client: EngineClient = {
    get state() {
      return state;
    },
    get codec() {
      return codec;
    },
    submit(submit) {
      if (state === "dead") return;
      const keepBytes = state !== "backoff" && state !== "suspended";
      const entry: Pending = {
        key: submit.imageKey,
        submit: keepBytes ? submit : withoutBytes(submit),
        postedOn: 0,
      };
      pending.set(entry.key, entry);
      cancelIdle?.();
      cancelIdle = null;
      if (state === "open") {
        postSubmit(entry);
        return;
      }
      if (gaveUp) {
        gaveUp = false;
        resetFailures();
      }
      if (state === "idle") startAttempt();
    },
    post(message) {
      if (state === "dead") return false;
      if (message.type === "img:submit") {
        const { type: _type, ...submit } = message;
        client.submit(submit);
        return state === "open";
      }
      if (message.type === "img:priority") {
        for (const item of message.items) {
          const entry = pending.get(item.imageKey);
          if (entry !== undefined) entry.submit = { ...entry.submit, priority: item.priority };
        }
      }
      if (state !== "open" || port === null) return false;
      const sent = port.post(message);
      if (sent && (message.type === "img:retry" || message.type === "unit:retranslate"))
        reopen(message.imageKey);
      return sent;
    },
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<AnyHandler>();
      if (!handlers.has(type)) {
        handlers.set(type, set);
        if (port !== null) subscribe(port, type);
      }
      const fn = handler as AnyHandler;
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    forget(imageKeys) {
      if (state === "dead" || imageKeys.length === 0) return;
      for (const key of imageKeys) {
        pending.delete(key);
        settled.delete(key);
      }
      if (state === "open" && port !== null) port.post({ type: "img:forget", imageKeys: [...imageKeys] });
      if (pending.size === 0) armIdle();
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    close() {
      shutdown();
    },
  };
  return client;
}
