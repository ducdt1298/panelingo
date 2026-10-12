// Small structured logger shared by every context. Sinks: console (always in dev), plus whatever the context adds
// (the engine adds an IndexedDB ring buffer; content scripts batch entries to the engine via cs:log).

import type { LogEntry } from "../shared/types.ts";

export type LogLevel = LogEntry["level"];
export type LogContext = LogEntry["ctx"];
export type LogData = Record<string, string | number | boolean | null>;

export interface Logger {
  debug(msg: string, data?: LogData, code?: string): void;
  info(msg: string, data?: LogData, code?: string): void;
  warn(msg: string, data?: LogData, code?: string): void;
  error(msg: string, data?: LogData, code?: string): void;
  /** A logger that tags every entry with extra fields (frameKey, imageKey, batchId). */
  child(tags: Pick<LogEntry, "frameKey" | "imageKey" | "batchId">): Logger;
}

export type LogSink = (entry: LogEntry) => void;

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerOptions {
  minLevel?: LogLevel;
  sinks?: LogSink[];
  now?: () => number;
}

export function createLogger(ctx: LogContext, options: LoggerOptions = {}): Logger {
  const sinks = options.sinks ?? [consoleSink];
  const now = options.now ?? Date.now;
  const min = ORDER[options.minLevel ?? "info"];

  const make = (tags: Pick<LogEntry, "frameKey" | "imageKey" | "batchId">): Logger => {
    const emit = (level: LogLevel, msg: string, data?: LogData, code?: string): void => {
      if (ORDER[level] < min) return;
      const entry: LogEntry = { t: now(), level, ctx, msg, ...tags };
      if (data !== undefined) entry.data = data;
      if (code !== undefined) entry.code = code;
      for (const sink of sinks) {
        try {
          sink(entry);
        } catch {
          // A broken sink must never break the code that logs.
        }
      }
    };
    return {
      debug: (msg, data, code) => emit("debug", msg, data, code),
      info: (msg, data, code) => emit("info", msg, data, code),
      warn: (msg, data, code) => emit("warn", msg, data, code),
      error: (msg, data, code) => emit("error", msg, data, code),
      child: (more) => make({ ...tags, ...more }),
    };
  };
  return make({});
}

export const consoleSink: LogSink = (entry) => {
  const line = `[ctv:${entry.ctx}] ${entry.msg}`;
  const extra = entry.data === undefined ? [] : [entry.data];
  if (entry.level === "error") console.error(line, ...extra);
  else if (entry.level === "warn") console.warn(line, ...extra);
  else if (entry.level === "info") console.info(line, ...extra);
  else console.debug(line, ...extra);
};

/** A logger that discards everything (tests, or before configuration). */
export const silentLogger: Logger = createLogger("debug", { sinks: [], minLevel: "error" });
