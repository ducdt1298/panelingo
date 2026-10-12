// Store "logs": the engine's debug ring buffer. Entries are batched (every 1 s or 50 entries); seq is autoIncrement,
// so pruning to the newest `capacity` entries is one range delete, run at start and every 500 writes (safe with
// several writers). Internal failures go to the console only: logging them through the engine logger would feed
// this very store.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { LogRecord } from "../../shared/records.ts";
import type { LogEntry } from "../../shared/types.ts";
import type { Clock, LogStore } from "../contracts.ts";
import { io } from "./io.ts";

export const LOG_BATCH_MS = 1_000;
export const LOG_BATCH_SIZE = 50;
export const LOG_TRIM_EVERY = 500;
/** Entries kept in memory while the database is unwritable (oldest dropped first). */
const MAX_QUEUED = 2_000;

/** Deletes every entry older than the newest `capacity` ones; returns how many. */
export async function trimLogs(db: CtvDatabase, capacity: number): Promise<number> {
  return io("logs.trim", async () => {
    const keep = Math.max(1, Math.floor(capacity));
    const tx = db.transaction("logs", "readwrite");
    const newest = await tx.store.openCursor(null, "prev");
    let deleted = 0;
    if (newest !== null && newest.key - keep >= 1) {
      const range = IDBKeyRange.upperBound(newest.key - keep);
      deleted = await tx.store.count(range);
      if (deleted > 0) await tx.store.delete(range);
    }
    await tx.done;
    return deleted;
  });
}

export interface LogStoreOptions {
  clock: Clock;
  /** settings.debug.logCapacity, read at every trim. */
  capacity: () => number;
  batchMs?: number;
  batchSize?: number;
  trimEvery?: number;
  /** Where internal failures go (default console.warn). */
  report?: (message: string) => void;
}

export interface LogStoreImpl extends LogStore {
  readonly trim: () => Promise<number>;
  /** Entries waiting for the next batch. */
  readonly pending: () => number;
}

function clean(entry: LogEntry): LogEntry {
  // A seq from a caller would become the record key (keyPath "seq").
  const { seq: _seq, ...rest } = entry as LogRecord;
  return rest;
}

export function createLogStore(db: CtvDatabase, options: LogStoreOptions): LogStoreImpl {
  const batchMs = options.batchMs ?? LOG_BATCH_MS;
  const batchSize = options.batchSize ?? LOG_BATCH_SIZE;
  const trimEvery = options.trimEvery ?? LOG_TRIM_EVERY;
  const report =
    options.report ??
    ((message: string): void => {
      console.warn(`[ctv:engine] ${message}`);
    });
  let queue: LogEntry[] = [];
  let writing: LogEntry[] = [];
  let cancelTimer: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();
  let sinceTrim = 0;

  const trim = (): Promise<number> => trimLogs(db, options.capacity());

  const flush = (): Promise<void> => {
    if (cancelTimer !== null) {
      cancelTimer();
      cancelTimer = null;
    }
    const next = chain.then(async () => {
      if (queue.length === 0) return;
      writing = queue;
      queue = [];
      try {
        await io("logs.append", async () => {
          const tx = db.transaction("logs", "readwrite");
          await Promise.all(writing.map((entry) => tx.store.add(entry)));
          await tx.done;
        });
        sinceTrim += writing.length;
      } finally {
        writing = [];
      }
      if (sinceTrim >= trimEvery) {
        sinceTrim = 0;
        await trim();
      }
    });
    chain = next.catch(() => undefined);
    return next;
  };

  const flushQuietly = (): void => {
    flush().catch((error: unknown) => {
      report(`log batch lost: ${String(error)}`);
    });
  };

  return {
    trim,
    pending: () => queue.length,
    append: (entry) => {
      queue.push(clean(entry));
      if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
      // The flush triggered at batchSize takes everything queued by the time it runs.
      if (queue.length === batchSize) {
        flushQuietly();
      } else if (queue.length < batchSize && cancelTimer === null) {
        cancelTimer = options.clock.setTimer(() => {
          cancelTimer = null;
          flushQuietly();
        }, batchMs);
      }
    },
    flush,
    recent: async (limit) => {
      const wanted = Math.max(0, Math.floor(limit));
      if (wanted === 0) return [];
      const stored = await io("logs.recent", async () => {
        const out: LogEntry[] = [];
        let cursor = await db.transaction("logs").store.openCursor(null, "prev");
        while (cursor !== null && out.length < wanted) {
          out.push(cursor.value);
          cursor = await cursor.continue();
        }
        return out.reverse();
      });
      return [...stored, ...writing, ...queue].slice(-wanted);
    },
  };
}
