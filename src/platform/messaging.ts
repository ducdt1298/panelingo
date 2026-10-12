// One-shot messaging (chrome.runtime.sendMessage / tabs.sendMessage) with the protocol rules: listeners are plain
// functions that return undefined for other targets and never throw; replies are Reply<T> and errors travel as
// ErrorInfo; an optional sender allow-list. The only file that touches runtime.onMessage (enforced by ESLint).

import { CtvError, toErrorInfo, type ErrorInfo } from "../shared/errors.ts";
import {
  isEnvelope,
  makeEnvelope,
  type ApiFor,
  type CsApi,
  type EngineApi,
  type Reply,
  type ReqOf,
  type ResOf,
  type SwApi,
  type Target,
} from "../shared/protocol.ts";

export type Handler<A, K extends keyof A> = (
  payload: ReqOf<A, K>,
  sender: chrome.runtime.MessageSender,
) => ResOf<A, K> | Promise<ResOf<A, K>>;

export type Handlers<A> = { [K in keyof A]?: Handler<A, K> };

type AnyHandler = (payload: unknown, sender: chrome.runtime.MessageSender) => unknown;

export interface ListenOptions {
  /** Sender allow-list: return false to ignore a message silently. */
  allow?: (type: string, sender: chrome.runtime.MessageSender) => boolean;
}

/** Installs the listener for `target`. Returns a function that removes it. */
export function onMessageFor<T extends Target>(
  target: T,
  handlers: Handlers<ApiFor<T>>,
  options: ListenOptions = {},
): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (reply: Reply<unknown>) => void,
  ): true | undefined => {
    if (!isEnvelope(message) || message.target !== target) return undefined;
    const handler = (handlers as Record<string, AnyHandler | undefined>)[message.type];
    if (handler === undefined) return undefined;
    if (options.allow !== undefined && !options.allow(message.type, sender)) return undefined;
    let pending: unknown;
    try {
      pending = handler(message.payload, sender);
    } catch (error) {
      sendResponse({ ok: false, error: toErrorInfo(error) });
      return undefined;
    }
    Promise.resolve(pending).then(
      (data) => sendResponse({ ok: true, data }),
      (error: unknown) => sendResponse({ ok: false, error: toErrorInfo(error) }),
    );
    return true;
  };
  const event = chrome.runtime.onMessage;
  event.addListener(listener);
  return () => event.removeListener(listener);
}

export interface CallOptions {
  timeoutMs?: number;
}

const NO_RECEIVER =
  /Receiving end does not exist|Could not establish connection|message port closed|channel closed/i;
/** Detail of an engine.unavailable CtvError when nobody listens at the other end. */
const NO_RECEIVER_DETAIL = "no receiver";

/**
 * True when a call failed because nothing listens there (no content script in that tab or frame, no engine), as
 * opposed to a timeout, a missing reply or a handler error. Callers inject a content script only in this case.
 */
export function isNoReceiver(error: unknown): boolean {
  return (
    error instanceof CtvError &&
    error.code === "engine.unavailable" &&
    error.message.endsWith(`: ${NO_RECEIVER_DETAIL}`)
  );
}

/** Maps a chrome messaging failure to a CtvError (callers only ever see CtvError). */
function toCallError(error: unknown, what: string): CtvError {
  if (error instanceof CtvError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/Extension context invalidated/i.test(message)) {
    return new CtvError("ctx.invalidated", message, { cause: error });
  }
  if (/Could not serialize/i.test(message)) {
    return new CtvError("engine.protocol", `${what}: ${message}`, { cause: error });
  }
  const detail = NO_RECEIVER.test(message) ? NO_RECEIVER_DETAIL : message;
  return new CtvError("engine.unavailable", `${what}: ${detail}`, { cause: error });
}

function unwrap<R>(reply: unknown, what: string): R {
  if (reply === undefined || reply === null || typeof reply !== "object" || !("ok" in reply)) {
    throw new CtvError("engine.unavailable", `${what}: no reply`);
  }
  const r = reply as Reply<R>;
  if (r.ok) return r.data;
  const info: ErrorInfo = r.error;
  throw CtvError.from(info);
}

async function withTimeout<R>(promise: Promise<R>, timeoutMs: number, what: string): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CtvError("engine.unavailable", `${what}: timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function callRuntime<T extends "sw" | "engine", K extends keyof ApiFor<T> & string>(
  target: T,
  type: K,
  payload: ReqOf<ApiFor<T>, K>,
  timeoutMs: number,
): Promise<ResOf<ApiFor<T>, K>> {
  const what = `${target}:${type}`;
  try {
    const envelope = makeEnvelope(target, type, payload);
    const reply = await withTimeout(
      chrome.runtime.sendMessage<typeof envelope, unknown>(envelope),
      timeoutMs,
      what,
    );
    return unwrap<ResOf<ApiFor<T>, K>>(reply, what);
  } catch (error) {
    throw toCallError(error, what);
  }
}

/** Calls the service worker. Default timeout 10 s (ensure-engine 15 s). */
export function callSw<K extends keyof SwApi>(
  type: K,
  payload: ReqOf<SwApi, K>,
  options: CallOptions = {},
): Promise<ResOf<SwApi, K>> {
  return callRuntime(
    "sw",
    type,
    payload,
    options.timeoutMs ?? (type === "sw:ensure-engine" ? 15_000 : 10_000),
  );
}

/** Calls the offscreen engine. Default timeout 5 s. */
export function callEngine<K extends keyof EngineApi>(
  type: K,
  payload: ReqOf<EngineApi, K>,
  options: CallOptions = {},
): Promise<ResOf<EngineApi, K>> {
  return callRuntime("engine", type, payload, options.timeoutMs ?? 5_000);
}

/** SW → content script of one tab/frame. Default timeout 3 s. */
export async function sendToTab<K extends keyof CsApi>(
  tabId: number,
  type: K,
  payload: ReqOf<CsApi, K>,
  options: CallOptions & { frameId?: number } = {},
): Promise<ResOf<CsApi, K>> {
  const what = `cs:${type}`;
  const sendOptions: chrome.tabs.MessageSendOptions =
    options.frameId === undefined ? {} : { frameId: options.frameId };
  try {
    const envelope = makeEnvelope("cs", type, payload);
    const reply = await withTimeout(
      chrome.tabs.sendMessage<typeof envelope, unknown>(tabId, envelope, sendOptions),
      options.timeoutMs ?? 3_000,
      what,
    );
    return unwrap<ResOf<CsApi, K>>(reply, what);
  } catch (error) {
    throw toCallError(error, what);
  }
}
