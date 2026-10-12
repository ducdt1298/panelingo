// Port "engine" handlers: every CsToEngine message of a registered frame.
// Content scripts run inside untrusted pages: payloads are validated and copied field by field before they reach the
// pipeline, and page identity always comes from port.sender (FrameInfo), never from the message.

import type { Logger } from "../platform/log.ts";
import type { CsToEngine, CsToEngineMap, ImageSubmit, ViewportInfo } from "../shared/protocol.ts";
import type { LogEntry, PagePos, RectCss, Size } from "../shared/types.ts";
import { isBytes } from "../shared/wire.ts";
import type { CaptureReply } from "./capture.ts";
import type { LogStore, Pipeline } from "./contracts.ts";
import type { FrameHandle, FrameRegistry } from "./ports.ts";
import type { CsHello } from "./ready-gate.ts";

export const MAX_LOG_ENTRIES_PER_MESSAGE = 50;
const MAX_KEY = 200;
const MAX_URL = 8_192;
const MAX_LIST = 2_000;
const MAX_ALT_SRCS = 16;
const MAX_MANUAL_TEXT = 10_000;
const LEVELS: ReadonlyArray<LogEntry["level"]> = ["debug", "info", "warn", "error"];

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_KEY;
}

function sizeOf(value: unknown): Size | null {
  if (!isRecord(value)) return null;
  const { w, h } = value;
  return isFiniteNumber(w) && isFiniteNumber(h) && w >= 0 && h >= 0 ? { w, h } : null;
}

function posOf(value: unknown): PagePos | null {
  if (!isRecord(value)) return null;
  const { docOrder, srcGen, yTop } = value;
  return isFiniteNumber(docOrder) && isFiniteNumber(srcGen) && isFiniteNumber(yTop)
    ? { docOrder, srcGen, yTop }
    : null;
}

function keyList(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isKey).slice(0, MAX_LIST) : [];
}

/** A clean ImageSubmit from an untrusted img:submit, or null when a required field is missing or malformed. */
export function parseImageSubmit(value: unknown): ImageSubmit | null {
  if (!isRecord(value)) return null;
  const { imageKey, src, element, acquire, priority } = value;
  if (!isKey(imageKey) || typeof src !== "string" || src === "" || src.length > MAX_URL) return null;
  const natural = value.natural === null || value.natural === undefined ? null : sizeOf(value.natural);
  if (natural === null && value.natural !== null && value.natural !== undefined) return null;
  const displayed = sizeOf(value.displayed);
  const pos = posOf(value.pos);
  if (displayed === null || pos === null || !isFiniteNumber(priority)) return null;
  if (element !== "img" && element !== "canvas") return null;
  if (acquire !== "url" && acquire !== "bytes" && acquire !== "capture") return null;
  const submit: ImageSubmit = { imageKey, src, natural, displayed, element, priority, pos, acquire };
  if (acquire === "bytes") {
    if (!isBytes(value.bytes)) return null;
    submit.bytes = value.bytes;
  }
  if (Array.isArray(value.altSrcs)) {
    const alt = (value.altSrcs as unknown[])
      .filter((url): url is string => typeof url === "string" && url !== "" && url.length <= MAX_URL)
      .slice(0, MAX_ALT_SRCS);
    if (alt.length > 0) submit.altSrcs = alt;
  }
  if (isRecord(value.strip) && isKey(value.strip.stripId) && isFiniteNumber(value.strip.index)) {
    submit.strip = { stripId: value.strip.stripId, index: value.strip.index };
  }
  if (typeof value.mime === "string" && value.mime.length <= 100) submit.mime = value.mime;
  if (value.source === "cs-fetch" || value.source === "cs-canvas") submit.source = value.source;
  if (typeof value.refPolicy === "string" && value.refPolicy.length <= 100)
    submit.refPolicy = value.refPolicy;
  if (value.prefetch === true) submit.prefetch = true;
  if (value.force === true) submit.force = true;
  return submit;
}

function rectOf(value: unknown): RectCss | null {
  if (!isRecord(value)) return null;
  const { left, top, width, height } = value;
  return isFiniteNumber(left) &&
    isFiniteNumber(top) &&
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    width >= 0 &&
    height >= 0
    ? { left, top, width, height }
    : null;
}

const CAP_FAIL_REASONS: ReadonlyArray<CsToEngineMap["cap:fail"]["reason"]> = [
  "not-visible",
  "hidden",
  "timeout",
  "moved",
  "frame",
];

/** A clean cap:ready / cap:fail, or null when malformed. */
export function parseCaptureReply(value: unknown): CaptureReply | null {
  if (!isRecord(value) || !isKey(value.reqId)) return null;
  const reqId = value.reqId;
  if (value.type === "cap:fail") {
    const reason = CAP_FAIL_REASONS.find((candidate) => candidate === value.reason);
    return reason === undefined ? null : { type: "cap:fail", reqId, reason };
  }
  if (value.type !== "cap:ready") return null;
  const rect = rectOf(value.rect);
  const viewport = sizeOf(value.viewport);
  const dpr = value.dpr;
  if (rect === null || viewport === null || viewport.w <= 0 || viewport.h <= 0) return null;
  if (!isFiniteNumber(dpr) || dpr <= 0 || dpr > 16) return null;
  if (value.clip === undefined) return { type: "cap:ready", reqId, rect, viewport, dpr };
  const clip = rectOf(value.clip);
  return clip === null ? null : { type: "cap:ready", reqId, rect, viewport, dpr, clip };
}

export function parseViewport(value: unknown): ViewportInfo | null {
  if (!isRecord(value)) return null;
  const { scrollY, innerHeight, secondsPerScreen } = value;
  if (!isFiniteNumber(scrollY) || !isFiniteNumber(innerHeight) || !isFiniteNumber(secondsPerScreen))
    return null;
  return { scrollY, innerHeight, secondsPerScreen, onScreen: keyList(value.onScreen) };
}

/** A content log entry as stored: ctx "cs", tagged with the frame, flat bounded data. */
export function sanitizeLogEntry(raw: unknown, frameKey: string, now: number): LogEntry | null {
  if (!isRecord(raw) || typeof raw.msg !== "string") return null;
  const level = LEVELS.find((candidate) => candidate === raw.level) ?? "info";
  const entry: LogEntry = {
    t: isFiniteNumber(raw.t) ? raw.t : now,
    level,
    ctx: "cs",
    msg: raw.msg.slice(0, 2_000),
    frameKey,
  };
  if (typeof raw.code === "string") entry.code = raw.code.slice(0, 100);
  if (typeof raw.imageKey === "string") entry.imageKey = raw.imageKey.slice(0, MAX_KEY);
  if (typeof raw.batchId === "string") entry.batchId = raw.batchId.slice(0, MAX_KEY);
  if (isRecord(raw.data)) {
    const data: Record<string, string | number | boolean | null> = {};
    let kept = 0;
    for (const [key, value] of Object.entries(raw.data)) {
      if (kept >= 30) break;
      if (typeof value === "string") data[key.slice(0, 64)] = value.slice(0, 500);
      else if (isFiniteNumber(value) || typeof value === "boolean" || value === null)
        data[key.slice(0, 64)] = value;
      else continue;
      kept += 1;
    }
    entry.data = data;
  }
  return entry;
}

export interface CsHandlerDeps {
  log: Logger;
  frames: FrameRegistry;
  pipeline: Pipeline;
  logs: LogStore;
  now: () => number;
  /** cs:hello once ready: the runtime registers it and answers en:hello with the current status. */
  onHello: (frame: FrameHandle, hello: CsHello) => void;
  /** Screen-capture sessions (ladder step 3); without it cap:ready / cap:fail are ignored. */
  capture?: { receive(frameKey: string, reply: CaptureReply): void };
}

export type CsHandler = (frame: FrameHandle, message: CsToEngine) => void;

export function createCsHandler(deps: CsHandlerDeps): CsHandler {
  const { log, frames, pipeline } = deps;

  const reject = (frame: FrameHandle, imageKey: unknown, what: string): void => {
    log.warn("invalid message from a frame", { frameKey: frame.info.frameKey, what });
    if (isKey(imageKey)) {
      frame.post({
        type: "img:state",
        imageKey,
        state: "error",
        error: { code: "engine.protocol", message: `invalid ${what}`, retryable: false },
      });
    }
  };

  return (frame, message) => {
    const frameKey = frame.info.frameKey;
    switch (message.type) {
      case "cs:hello":
        deps.onHello(frame, message);
        return;
      case "cs:codec":
        if (message.codec === "b64") frames.setCodec(frame, "b64");
        return;
      case "cs:page": {
        let origin: string | null = null;
        if (typeof message.url === "string" && message.url.length <= MAX_URL) {
          try {
            origin = new URL(message.url).origin;
          } catch {
            origin = null;
          }
        }
        if (origin === null || origin !== frame.info.origin) {
          log.warn("cs:page ignored: not the frame's origin", { frameKey });
          return;
        }
        frame.info.url = message.url;
        if (typeof message.title === "string") {
          frame.info.page = { ...frame.info.page, title: message.title.slice(0, 500) };
        }
        return;
      }
      // The queue reads tab ranking and on-screen urgency at dispatch: an empty priority() re-ranks it now.
      case "cs:visibility":
        if (typeof message.visible === "boolean") {
          frames.setVisible(frame, message.visible);
          pipeline.priority(frameKey, []);
        }
        return;
      case "cs:viewport": {
        const viewport = parseViewport(message);
        if (viewport !== null) {
          frame.info.viewport = viewport;
          pipeline.priority(frameKey, []);
        }
        return;
      }
      case "cs:heartbeat":
        return;
      case "img:submit": {
        const submit = parseImageSubmit(message);
        if (submit === null) {
          reject(frame, message.imageKey, "img:submit");
          return;
        }
        frame.noteSubmit(submit.imageKey, submit.pos);
        pipeline.submit(frame, submit);
        return;
      }
      case "img:priority": {
        const items = Array.isArray(message.items)
          ? (message.items as unknown[])
              .filter(
                (item): item is { imageKey: string; priority: number } =>
                  isRecord(item) && isKey(item.imageKey) && isFiniteNumber(item.priority),
              )
              .slice(0, MAX_LIST)
              .map((item) => ({ imageKey: item.imageKey, priority: item.priority }))
          : [];
        if (items.length > 0) pipeline.priority(frameKey, items);
        return;
      }
      case "img:forget": {
        const imageKeys = keyList(message.imageKeys);
        if (imageKeys.length === 0) return;
        frame.forgetImages(imageKeys);
        pipeline.forget(frameKey, imageKeys);
        return;
      }
      case "img:retry":
        if (!isKey(message.imageKey)) return;
        pipeline.retry(frameKey, message.imageKey, isKey(message.unitKey) ? message.unitKey : undefined);
        return;
      case "unit:edit": {
        const { imageKey, unitKey, translation } = message;
        const validVi =
          translation === null || (typeof translation === "string" && translation.length <= MAX_MANUAL_TEXT);
        if (!isKey(imageKey) || !isKey(unitKey) || !validVi) {
          log.warn("invalid unit:edit", { frameKey });
          return;
        }
        pipeline.edit({ frameKey, imageKey }, unitKey, translation).catch((error: unknown) => {
          log.warn("unit:edit failed", { frameKey, error: String(error) });
        });
        return;
      }
      case "unit:retranslate": {
        const { imageKey, unitKey } = message;
        if (!isKey(imageKey) || !isKey(unitKey)) {
          log.warn("invalid unit:retranslate", { frameKey });
          return;
        }
        // Scoped to this frame's tab and the image's content; without a known content (no result posted yet)
        // only a failed unit can run again.
        const contentKey = frame.images.get(imageKey)?.contentKey ?? null;
        if (contentKey === null) pipeline.retry(frameKey, imageKey, unitKey);
        else pipeline.retranslate({ tabId: frame.info.tabId, contentKey, unitKey });
        return;
      }
      case "unit:overflow":
        log.debug("unit overflow", {
          frameKey,
          imageKey: String(message.imageKey).slice(0, MAX_KEY),
          unitKey: String(message.unitKey).slice(0, MAX_KEY),
          overflow: message.overflow === true,
        });
        return;
      case "cap:ready":
      case "cap:fail": {
        const reply = parseCaptureReply(message);
        if (reply === null) {
          log.warn("invalid capture reply", { frameKey, type: message.type });
          return;
        }
        if (deps.capture === undefined) log.debug("no capture session", { frameKey, type: message.type });
        else deps.capture.receive(frameKey, reply);
        return;
      }
      case "cs:log": {
        const entries = Array.isArray(message.entries) ? (message.entries as unknown[]) : [];
        const now = deps.now();
        for (const raw of entries.slice(0, MAX_LOG_ENTRIES_PER_MESSAGE)) {
          const entry = sanitizeLogEntry(raw, frameKey, now);
          if (entry !== null) deps.logs.append(entry);
        }
        return;
      }
    }
  };
}
