// Daily privacy counter of composites sent to the AI endpoint (the popup's "Sent N composite images ... today" line).
// Kept in kv "uploads.daily" under the local calendar day; a new day starts from zero.

import type { CoreDeps, EngineStores, UploadCounter } from "./contracts.ts";

/** Local calendar day "YYYY-MM-DD" of an epoch-ms time. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface UploadCounterImpl extends UploadCounter {
  /** Resolves once the stored counter has been read and every recorded upload written. */
  readonly settled: () => Promise<void>;
}

export function createUploads(deps: CoreDeps & { stores: EngineStores }): UploadCounterImpl {
  const { clock, log, stores } = deps;
  let counter = { day: localDay(clock.now()), composites: 0, bytes: 0 };
  let writes: Promise<void> = Promise.resolve();

  const roll = (): void => {
    const day = localDay(clock.now());
    if (day !== counter.day) counter = { day, composites: 0, bytes: 0 };
  };

  const save = (): void => {
    const snapshot = { ...counter };
    writes = writes
      .then(() => stores.kv.set("uploads.daily", snapshot))
      .catch((error: unknown) => {
        log.warn("upload counter not saved", { error: String(error) }, "store.io");
      });
  };

  // Uploads recorded before the stored value arrives are added to it.
  writes = stores.kv
    .get("uploads.daily")
    .then((saved) => {
      if (saved === undefined || saved.day !== counter.day) return;
      const recorded = counter.composites > 0;
      counter = {
        day: saved.day,
        composites: saved.composites + counter.composites,
        bytes: saved.bytes + counter.bytes,
      };
      if (recorded) save();
    })
    .catch((error: unknown) => {
      log.warn("upload counter unreadable", { error: String(error) }, "store.io");
    });

  return {
    record: (bytes) => {
      roll();
      counter.composites += 1;
      counter.bytes += Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
      save();
    },
    today: () => {
      roll();
      return { today: counter.composites, bytesToday: counter.bytes };
    },
    settled: async () => {
      let seen: Promise<void> | null = null;
      while (seen !== writes) {
        seen = writes;
        await seen;
      }
    },
  };
}
