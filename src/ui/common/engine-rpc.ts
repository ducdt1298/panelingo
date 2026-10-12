// UI pages → engine. One-shot en:* calls either start the engine first (explicit user actions such as clearing the
// cache) or run only when it already exists (status views must never start it). Port "ui" carries live en:status
// pushes; it reconnects after a drop only while the engine still runs.

import type { Logger } from "../../platform/log.ts";
import { callEngine, callSw, type CallOptions } from "../../platform/messaging.ts";
import { wrapPort, type TypedPort } from "../../platform/port.ts";
import { CtvError, errorMessage } from "../../shared/errors.ts";
import {
  PORT_UI,
  PROTOCOL_VERSION,
  type EngineApi,
  type EngineToUiMap,
  type ReqOf,
  type ResOf,
  type UiToEngineMap,
} from "../../shared/protocol.ts";
import type { EngineStatus } from "../../shared/types.ts";
import { makeProbe } from "../../shared/wire.ts";

export type UiView = UiToEngineMap["ui:hello"]["view"];
type UiPort = TypedPort<EngineToUiMap, UiToEngineMap>;

/** Whether the offscreen engine runs (asks the service worker; never starts it). */
export async function engineRunning(): Promise<boolean> {
  try {
    return (await callSw("sw:engine-state", {})).exists;
  } catch {
    return false;
  }
}

/** Starts the engine when needed, then calls it: only for explicit user actions. */
export async function callEngineEnsured<K extends keyof EngineApi>(
  type: K,
  payload: ReqOf<EngineApi, K>,
  options: CallOptions = {},
): Promise<ResOf<EngineApi, K>> {
  await callSw("sw:ensure-engine", { reason: "ui" });
  return callEngine(type, payload, options);
}

/** Calls the engine only when it already runs; null when it does not (or vanished meanwhile). */
export async function callEngineIfRunning<K extends keyof EngineApi>(
  type: K,
  payload: ReqOf<EngineApi, K>,
  options: CallOptions = {},
): Promise<ResOf<EngineApi, K> | null> {
  if (!(await engineRunning())) return null;
  try {
    return await callEngine(type, payload, options);
  } catch (error) {
    if (error instanceof CtvError && error.code === "engine.unavailable") return null;
    throw error;
  }
}

export interface WatchOptions {
  view: UiView;
  /** null = global status only. */
  tabId: number | null;
  log: Logger;
  onStatus(status: EngineStatus): void;
  /** Transcript lines of the watched tab changed (tx:delta) or were dropped (tx:reset). */
  onTranscript?(tabId: number): void;
  /** The port is gone and will not reconnect (engine closed, protocol mismatch, retries used up). */
  onGone?(): void;
  /** Wait before each reconnect attempt; the attempt only happens while the engine still runs. */
  retryDelaysMs?: readonly number[];
  running?: () => Promise<boolean>;
}

export interface EngineWatch {
  stop(): void;
}

export const WATCH_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000];

/** Port "ui" with ui:hello → en:hello → ui:watch, then en:status pushes until stop(). */
export function watchEngine(options: WatchOptions): EngineWatch {
  const delays = options.retryDelaysMs ?? WATCH_RETRY_DELAYS_MS;
  const running = options.running ?? engineRunning;
  let stopped = false;
  let attempt = 0;
  let port: UiPort | null = null;

  const gone = (): void => {
    if (stopped) return;
    stopped = true;
    options.onGone?.();
  };

  const reconnect = async (): Promise<void> => {
    const delay = delays[attempt];
    attempt += 1;
    if (delay === undefined) {
      gone();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (stopped) return;
    if (await running()) connect();
    else gone();
  };

  const connect = (): void => {
    if (stopped) return;
    let current: UiPort;
    try {
      current = wrapPort<EngineToUiMap, UiToEngineMap>(chrome.runtime.connect({ name: PORT_UI }), {
        ctx: "ui",
        log: options.log,
      });
    } catch (error) {
      options.log.warn("ui port connect failed", {
        error: errorMessage(error),
      });
      gone();
      return;
    }
    port = current;
    current.on("en:hello", (message) => {
      if (message.v !== PROTOCOL_VERSION) {
        options.log.warn("engine protocol mismatch", { engine: message.v, ui: PROTOCOL_VERSION });
        gone();
        current.close();
        return;
      }
      attempt = 0;
      current.codec = message.codec;
      current.post({ type: "ui:watch", tabId: options.tabId });
    });
    current.on("en:status", (message) => options.onStatus(message.status));
    current.on("tx:delta", (message) => options.onTranscript?.(message.tabId));
    current.on("tx:reset", (message) => options.onTranscript?.(message.tabId));
    current.onClose(() => {
      if (port === current) port = null;
      if (!stopped) void reconnect();
    });
    current.post({ type: "ui:hello", v: PROTOCOL_VERSION, probe: makeProbe(), view: options.view });
  };

  connect();
  return {
    stop() {
      stopped = true;
      port?.close();
      port = null;
    },
  };
}
