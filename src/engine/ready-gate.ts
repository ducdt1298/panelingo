// ReadyGate. Chrome resolves offscreen.createDocument after the first load, so content scripts may connect before the
// runtime exists. main.ts therefore registers, synchronously and before any await or import(), the single onConnect
// listener (adopt) and onMessageFor("engine", gate.handlers, {allow}). While booting the gate answers cs:hello /
// ui:hello with en:hello (phase "booting"), en:ping and en:prepare-close, and buffers every other port or one-shot
// message in arrival order (per-port caps; an overflowing img:submit gets img:state error engine.overloaded). drain()
// replays the buffer into the runtime and switches to direct dispatch; fail() answers everything with
// engine.internal. Kept small: it is part of the eager main chunk.

import { createLogger, type Logger } from "../platform/log.ts";
import type { Handlers } from "../platform/messaging.ts";
import { wrapPort, type TypedPort } from "../platform/port.ts";
import { profileForModel } from "../shared/core/model-profile.ts";
import { CtvError, toErrorInfo, type ErrorInfo } from "../shared/errors.ts";
import { frameKeyOf } from "../shared/ids.ts";
import {
  PORT_ENGINE,
  PORT_UI,
  PROTOCOL_VERSION,
  type CsToEngine,
  type CsToEngineMap,
  type EngineApi,
  type EngineToCsMap,
  type EngineToUiMap,
  type UiToEngine,
  type UiToEngineMap,
} from "../shared/protocol.ts";
import { DEFAULT_SETTINGS } from "../shared/settings.ts";
import type { Bytes, EnginePhase, EngineStatus } from "../shared/types.ts";
import { codecFromProbe, estimateWireBytes, makeProbe } from "../shared/wire.ts";

export type EnginePort = TypedPort<CsToEngineMap, EngineToCsMap>;
export type UiPort = TypedPort<UiToEngineMap, EngineToUiMap>;
export type CsHello = Extract<CsToEngine, { type: "cs:hello" }>;
export type UiHello = Extract<UiToEngine, { type: "ui:hello" }>;

/** An adopted content-script port. Identity comes from port.sender, never from what the page sends. */
export interface EnginePortEntry {
  readonly kind: "engine";
  readonly port: EnginePort;
  readonly sender: chrome.runtime.MessageSender;
  /** `${tabId}:${frameId}:${documentId}` */
  readonly frameKey: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
  /** port.sender.url */
  readonly url: string;
  /** sender.origin when known (about:blank / srcdoc frames carry their creator's origin), else the URL's origin. */
  readonly origin: string;
  /** The cs:hello the gate answered while booting; the runtime registers the frame from it. */
  hello: CsHello | null;
}

/** An adopted extension-page port (popup, side panel, options, debug). */
export interface UiPortEntry {
  readonly kind: "ui";
  readonly port: UiPort;
  readonly sender: chrome.runtime.MessageSender;
  hello: UiHello | null;
}

export type PortEntry = EnginePortEntry | UiPortEntry;

/** The runtime side of the gate, handed over by drain(). */
export interface GateDispatch {
  readonly portOpened: (entry: PortEntry) => void;
  readonly engineMessage: (entry: EnginePortEntry, message: CsToEngine) => void;
  readonly uiMessage: (entry: UiPortEntry, message: UiToEngine) => void;
  readonly portClosed: (entry: PortEntry) => void;
  /** en:* one-shots once ready (en:ping and en:prepare-close included). */
  readonly handlers: Handlers<EngineApi>;
}

export interface ReadyGateOptions {
  /** Buffered messages per port while booting (main.ts: 500). */
  maxMsgsPerPort: number;
  /** Buffered bytes per port while booting (main.ts: 64 MiB). */
  maxBytesPerPort: number;
  log?: Logger;
}

export type GateMode = "booting" | "ready" | "failed";

export interface GateStats {
  mode: GateMode;
  /** Items waiting for drain(). */
  buffered: number;
  /** Messages refused because a port's buffer was full. */
  overflowed: number;
  /** Adopted ports still open. */
  ports: number;
}

export interface ReadyGate {
  /** Called by main.ts for every runtime.onConnect port; names other than "engine"/"ui" are ignored, never closed. */
  readonly adopt: (raw: chrome.runtime.Port) => void;
  /** For onMessageFor("engine"). */
  readonly handlers: Handlers<EngineApi>;
  /** Per-type sender allow-list for onMessageFor("engine"). */
  readonly allow: (type: string, sender: chrome.runtime.MessageSender) => boolean;
  /** Replays the buffer in arrival order into `dispatch`, then dispatches directly. Once only. */
  readonly drain: (dispatch: GateDispatch) => void;
  /** The runtime could not start: phase "failed", every pending and later request gets engine.internal. */
  readonly fail: (error: unknown) => void;
  readonly mode: () => GateMode;
  /** Switches the gate (and the ports it wraps) to the runtime's logger. */
  readonly setLogger: (log: Logger) => void;
  readonly stats: () => GateStats;
}

/** EngineStatus while no runtime can describe itself (booting or failed). */
export function placeholderStatus(phase: EnginePhase): EngineStatus {
  return {
    phase,
    build: __BUILD_ID__,
    api: { readiness: "unknown", model: null, cause: null, checkedAt: 0 },
    detector: { backend: "none", state: "unloaded", canary: "pending" },
    queue: {
      queued: 0,
      inFlight: 0,
      urgentInFlight: 0,
      done: 0,
      failed: 0,
      pausedBy: null,
      concurrency: DEFAULT_SETTINGS.api.concurrency,
      boxBudget: DEFAULT_SETTINGS.translate.boxBudget ?? profileForModel(null).boxBudget,
    },
    uploads: { today: 0, bytesToday: 0 },
  };
}

/** Every one-shot the engine answers; a missing key is a compile error. */
const ENGINE_TYPES: Readonly<Record<keyof EngineApi, true>> = {
  "en:settings": true,
  "en:prepare-close": true,
  "en:ping": true,
  "en:status": true,
  "en:transcript": true,
  "en:edit-unit": true,
  "en:retranslate": true,
  "en:glossary-list": true,
  "en:glossary-upsert": true,
  "en:glossary-delete": true,
  "en:glossary-confirm": true,
  "en:series-update": true,
  "en:jump-to": true,
  "en:cache-clear": true,
};

/** Only the service worker may push settings or close the engine. */
const SW_ONLY: ReadonlySet<string> = new Set(["en:settings", "en:prepare-close"]);

type AnyHandler = (payload: unknown, sender: chrome.runtime.MessageSender) => unknown;

type QueueItem =
  | { kind: "open"; entry: PortEntry }
  | { kind: "close"; entry: PortEntry }
  | { kind: "engine"; entry: EnginePortEntry; message: CsToEngine }
  | { kind: "ui"; entry: UiPortEntry; message: UiToEngine }
  | {
      kind: "call";
      type: keyof EngineApi;
      payload: unknown;
      sender: chrome.runtime.MessageSender;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    };

function hasType(message: unknown): message is { type: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { type?: unknown }).type === "string"
  );
}

function originOf(sender: chrome.runtime.MessageSender, url: string): string {
  if (typeof sender.origin === "string" && sender.origin !== "" && sender.origin !== "null")
    return sender.origin;
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

/** A logger that forwards to whatever logger the gate currently uses (wrapPort keeps the one it was given). */
function forwardingLogger(get: () => Logger): Logger {
  return {
    debug: (msg, data, code) => get().debug(msg, data, code),
    info: (msg, data, code) => get().info(msg, data, code),
    warn: (msg, data, code) => get().warn(msg, data, code),
    error: (msg, data, code) => get().error(msg, data, code),
    child: (tags) => get().child(tags),
  };
}

export function createReadyGate(options: ReadyGateOptions): ReadyGate {
  let log: Logger = options.log ?? createLogger("engine");
  const portLog = forwardingLogger(() => log);
  let mode: GateMode = "booting";
  let dispatch: GateDispatch | null = null;
  let failure: ErrorInfo | null = null;
  const queue: QueueItem[] = [];
  const usage = new Map<PortEntry, { count: number; bytes: number; warned: boolean }>();
  const open = new Set<PortEntry>();
  let overflowed = 0;
  let extensionBase: string | null = null;

  const guarded = (what: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      log.error("runtime dispatch threw", { what, error: String(error) });
    }
  };

  const failedError = (): CtvError =>
    CtvError.from(
      failure ?? { code: "engine.internal", message: "engine failed to start", retryable: false },
    );

  const callRuntime = (
    type: keyof EngineApi,
    payload: unknown,
    sender: chrome.runtime.MessageSender,
  ): unknown => {
    const handler = (dispatch?.handlers as Record<string, AnyHandler | undefined> | undefined)?.[type];
    if (handler === undefined) throw new CtvError("engine.internal", `${type}: no handler`);
    return handler(payload, sender);
  };

  const replay = (item: QueueItem): void => {
    const target = dispatch;
    if (target === null) return;
    switch (item.kind) {
      case "open":
        guarded("open", () => target.portOpened(item.entry));
        break;
      case "close":
        guarded("close", () => target.portClosed(item.entry));
        break;
      case "engine":
        guarded(item.message.type, () => target.engineMessage(item.entry, item.message));
        break;
      case "ui":
        guarded(item.message.type, () => target.uiMessage(item.entry, item.message));
        break;
      case "call":
        try {
          Promise.resolve(callRuntime(item.type, item.payload, item.sender)).then(item.resolve, item.reject);
        } catch (error) {
          item.reject(error);
        }
        break;
    }
  };

  /** Port events: buffered while booting, dispatched once ready, dropped after a failure. */
  const emit = (item: QueueItem): void => {
    if (mode === "booting") queue.push(item);
    else if (mode === "ready") replay(item);
  };

  const failSubmit = (entry: EnginePortEntry, message: CsToEngine, error: ErrorInfo): void => {
    if (message.type !== "img:submit" || typeof message.imageKey !== "string") return;
    entry.port.post({ type: "img:state", imageKey: message.imageKey, state: "error", error });
  };

  const buffer = (entry: PortEntry, item: QueueItem, message: { type: string }): void => {
    const size = estimateWireBytes(message, entry.port.codec);
    const used = usage.get(entry) ?? { count: 0, bytes: 0, warned: false };
    if (used.count + 1 > options.maxMsgsPerPort || used.bytes + size > options.maxBytesPerPort) {
      overflowed += 1;
      if (!used.warned) {
        used.warned = true;
        log.warn("boot buffer full, dropping messages", { kind: entry.kind, type: message.type });
      }
      usage.set(entry, used);
      if (entry.kind === "engine" && item.kind === "engine") {
        failSubmit(entry, item.message, {
          code: "engine.overloaded",
          message: "the engine is starting and its buffer is full; resubmit",
          retryable: true,
        });
      }
      return;
    }
    used.count += 1;
    used.bytes += size;
    usage.set(entry, used);
    queue.push(item);
  };

  const helloPhase = (): EnginePhase => (mode === "failed" ? "failed" : "booting");

  const onEngineMessage = (entry: EnginePortEntry, message: unknown): void => {
    if (!hasType(message)) return;
    const typed = message as CsToEngine;
    if (mode === "ready") {
      replay({ kind: "engine", entry, message: typed });
      return;
    }
    if (typed.type === "cs:hello") {
      entry.hello = typed;
      const codec = codecFromProbe(typed.probe);
      entry.port.codec = codec;
      entry.port.post({
        type: "en:hello",
        v: PROTOCOL_VERSION,
        build: __BUILD_ID__,
        probe: makeProbe(),
        codec,
        frameKey: entry.frameKey,
        status: placeholderStatus(helloPhase()),
      });
      if (typed.v !== PROTOCOL_VERSION) log.warn("content protocol mismatch", { v: typed.v });
      return;
    }
    if (mode === "failed") {
      failSubmit(entry, typed, failedError().toInfo());
      return;
    }
    // The codec switch matters for anything posted before drain; the runtime also sees it on replay.
    if (typed.type === "cs:codec") entry.port.codec = "b64";
    buffer(entry, { kind: "engine", entry, message: typed }, typed);
  };

  const onUiMessage = (entry: UiPortEntry, message: unknown): void => {
    if (!hasType(message)) return;
    const typed = message as UiToEngine;
    if (mode === "ready") {
      replay({ kind: "ui", entry, message: typed });
      return;
    }
    if (typed.type === "ui:hello") {
      entry.hello = typed;
      const codec = codecFromProbe(typed.probe);
      entry.port.codec = codec;
      entry.port.post({ type: "en:hello", v: PROTOCOL_VERSION, probe: makeProbe(), codec });
      return;
    }
    if (mode === "failed") return;
    buffer(entry, { kind: "ui", entry, message: typed }, typed);
  };

  const track = (entry: PortEntry, raw: chrome.runtime.Port, onMessage: (message: unknown) => void): void => {
    open.add(entry);
    raw.onMessage.addListener((message: unknown) => {
      onMessage(message);
    });
    entry.port.onClose(() => {
      open.delete(entry);
      usage.delete(entry);
      emit({ kind: "close", entry });
    });
    emit({ kind: "open", entry });
  };

  const base = (): string | null => {
    if (extensionBase === null) {
      try {
        extensionBase = chrome.runtime.getURL("");
      } catch {
        return null;
      }
    }
    return extensionBase;
  };

  const adopt = (raw: chrome.runtime.Port): void => {
    try {
      const sender = raw.sender;
      if (raw.name === PORT_ENGINE) {
        const tabId = sender?.tab?.id;
        const frameId = sender?.frameId;
        if (sender === undefined || typeof tabId !== "number" || typeof frameId !== "number") {
          log.warn("engine port without a tab ignored", { url: sender?.url ?? null });
          return;
        }
        const documentId = sender.documentId ?? "";
        const url = sender.url ?? "";
        const entry: EnginePortEntry = {
          kind: "engine",
          port: wrapPort<CsToEngineMap, EngineToCsMap>(raw, { ctx: "engine", log: portLog }),
          sender,
          frameKey: frameKeyOf(tabId, frameId, documentId),
          tabId,
          frameId,
          documentId,
          url,
          origin: originOf(sender, url),
          hello: null,
        };
        track(entry, raw, (message) => onEngineMessage(entry, message));
      } else if (raw.name === PORT_UI) {
        const prefix = base();
        if (sender === undefined || prefix === null || !(sender.url ?? "").startsWith(`${prefix}ui/`)) {
          log.warn("ui port from outside the extension pages ignored", { url: sender?.url ?? null });
          return;
        }
        const entry: UiPortEntry = {
          kind: "ui",
          port: wrapPort<UiToEngineMap, EngineToUiMap>(raw, { ctx: "engine", log: portLog }),
          sender,
          hello: null,
        };
        track(entry, raw, (message) => onUiMessage(entry, message));
      }
      // Any other name belongs to someone else: never disconnect it (a disconnect() by any receiver kills the channel).
    } catch (error) {
      log.error("adopting a port failed", { error: String(error) });
    }
  };

  const answer = (type: keyof EngineApi, payload: unknown, sender: chrome.runtime.MessageSender): unknown => {
    if (mode === "ready") return callRuntime(type, payload, sender);
    if (type === "en:ping") {
      const probe = (payload as { probe?: Bytes } | null)?.probe ?? makeProbe();
      return { probe, phase: helloPhase() };
    }
    // A failed engine is useless: let the SW close it so the next ensure starts a fresh one.
    if (type === "en:prepare-close") return { ok: mode === "failed" };
    if (mode === "failed") throw failedError();
    return new Promise((resolve, reject) => {
      queue.push({ kind: "call", type, payload, sender, resolve, reject });
    });
  };

  const handlers = Object.fromEntries(
    (Object.keys(ENGINE_TYPES) as Array<keyof EngineApi>).map((type) => [
      type,
      (payload: unknown, sender: chrome.runtime.MessageSender) => answer(type, payload, sender),
    ]),
  ) as Handlers<EngineApi>;

  const allow = (type: string, sender: chrome.runtime.MessageSender): boolean => {
    const prefix = base();
    let ownId: string | undefined;
    try {
      ownId = chrome.runtime.id;
    } catch {
      return false;
    }
    if (prefix === null || sender.id !== ownId) return false;
    const url = sender.url ?? "";
    if (SW_ONLY.has(type)) return url === `${prefix}sw.js`;
    if (type === "en:ping") return true;
    return url.startsWith(`${prefix}ui/`);
  };

  const drain = (next: GateDispatch): void => {
    if (mode !== "booting") {
      log.warn("drain ignored", { mode });
      return;
    }
    dispatch = next;
    mode = "ready";
    usage.clear();
    // Events raised while replaying (a port the runtime refuses and closes) dispatch directly.
    for (const item of queue.splice(0)) replay(item);
  };

  const fail = (error: unknown): void => {
    if (mode === "failed") return;
    const info = toErrorInfo(error);
    failure = {
      code: "engine.internal",
      message: `engine failed to start: ${info.message}`,
      retryable: false,
      ...(info.code === "engine.internal" ? {} : { detail: info.code }),
    };
    log.error("engine boot failed", { error: info.message, code: info.code });
    mode = "failed";
    dispatch = null;
    for (const item of queue.splice(0)) {
      if (item.kind === "call") item.reject(failedError());
      else if (item.kind === "engine") failSubmit(item.entry, item.message, failure);
    }
    for (const entry of open) {
      if (entry.kind === "engine")
        entry.port.post({ type: "en:status", status: placeholderStatus("failed") });
    }
  };

  return {
    adopt,
    handlers,
    allow,
    drain,
    fail,
    mode: () => mode,
    setLogger: (next) => {
      log = next;
    },
    stats: () => ({ mode, buffered: queue.length, overflowed, ports: open.size }),
  };
}
