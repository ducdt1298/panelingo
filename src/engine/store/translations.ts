// Store "translations" keyed [contentKey, unitKey]. Writes are queued and flushed every 2 s in one transaction;
// reads overlay the queue, so callers always see their own writes.
//
// Who wrote a record is told by its `manual` flag (manual edits always win):
// - manual = 1 is a USER write: manualTranslation holds the edit and wins as given. manualTranslation = null means
//   "revert to the AI text"; the store keeps it as manual = 0.
// - manual = 0 is an AI write: when the stored record holds a manual edit, the edit (manualTranslation, manual,
//   status) is kept and only the AI fields underneath are refreshed, so a late or re-run AI result never erases what
//   the user typed.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { Logger } from "../../platform/log.ts";
import type { TranslationRecord } from "../../shared/records.ts";
import type { Clock, TranslationStore } from "../contracts.ts";
import { io } from "./io.ts";

export const TRANSLATION_FLUSH_MS = 2_000;

/** The record that results from writing `incoming` over `existing` (see the header). Pure and idempotent. */
export function mergeTranslation(
  existing: TranslationRecord | undefined,
  incoming: TranslationRecord,
): TranslationRecord {
  if (incoming.manual === 1) {
    if (incoming.manualTranslation !== null) return { ...incoming };
    const status =
      incoming.status === "manual"
        ? incoming.translation.trim() === ""
          ? "untranslated"
          : "ok"
        : incoming.status;
    return { ...incoming, manual: 0, manualTranslation: null, status };
  }
  if (existing !== undefined && existing.manual === 1 && existing.manualTranslation !== null) {
    return {
      ...incoming,
      manualTranslation: existing.manualTranslation,
      manual: 1,
      status: existing.status,
      lastUsedAt: Math.max(existing.lastUsedAt, incoming.lastUsedAt),
    };
  }
  return { ...incoming };
}

export interface TranslationStoreOptions {
  clock: Clock;
  log: Logger;
  flushMs?: number;
}

export interface TranslationStoreImpl extends TranslationStore {
  /** Records waiting for the next flush. */
  readonly pending: () => number;
}

const keyOf = (record: Pick<TranslationRecord, "contentKey" | "unitKey">): string =>
  `${record.contentKey}\u0000${record.unitKey}`;

export function createTranslationStore(
  db: CtvDatabase,
  options: TranslationStoreOptions,
): TranslationStoreImpl {
  const flushMs = options.flushMs ?? TRANSLATION_FLUSH_MS;
  let queue: TranslationRecord[] = [];
  /** The batch being written (still overlaid on reads until it commits). */
  let writing: TranslationRecord[] = [];
  let cancelTimer: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();

  const write = async (batch: TranslationRecord[]): Promise<void> => {
    const tx = db.transaction("translations", "readwrite");
    const merged = new Map<string, TranslationRecord>();
    for (const record of batch) {
      const key = keyOf(record);
      const existing = merged.get(key) ?? (await tx.store.get([record.contentKey, record.unitKey]));
      merged.set(key, mergeTranslation(existing, record));
    }
    for (const record of merged.values()) await tx.store.put(record);
    await tx.done;
  };

  /** Writes the queue after any write in progress; a failed batch is dropped (and reported to the caller). */
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
        await io("translations.flush", () => write(writing));
      } finally {
        writing = [];
      }
    });
    chain = next.catch(() => undefined);
    return next;
  };

  const flushLater = (): void => {
    if (cancelTimer !== null) return;
    cancelTimer = options.clock.setTimer(() => {
      cancelTimer = null;
      flush().catch((error: unknown) => {
        options.log.warn("translation batch lost", { error: String(error) }, "store.io");
      });
    }, flushMs);
  };

  return {
    pending: () => queue.length,
    put: (record) => {
      queue.push({ ...record });
      flushLater();
    },
    flush,
    forImage: async (contentKey) => {
      const stored = await io("translations.forImage", () =>
        db.getAllFromIndex("translations", "byContent", contentKey),
      );
      const byKey = new Map<string, TranslationRecord>(stored.map((record) => [keyOf(record), record]));
      for (const record of [...writing, ...queue]) {
        if (record.contentKey !== contentKey) continue;
        const key = keyOf(record);
        byKey.set(key, mergeTranslation(byKey.get(key), record));
      }
      return [...byKey.values()];
    },
  };
}
