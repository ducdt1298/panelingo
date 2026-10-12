// Stores "images" (one record per distinct bytes, contentKey = "s:" + sha256) and "urls" (urlKey alias → contentKey,
// looked up before fetching). lastUsedAt drives retention, so touch() writes at most once per hour per image.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { ImageRecord } from "../../shared/records.ts";
import type { ImageStore } from "../contracts.ts";
import { io } from "./io.ts";

export const TOUCH_MIN_INTERVAL_MS = 60 * 60_000;
/** Bound on the in-memory "last touched" map (only a write-skipping hint). */
const TOUCH_MEMORY = 4096;

export interface ImageStoreOptions {
  touchMinIntervalMs?: number;
}

export function createImageStore(db: CtvDatabase, options: ImageStoreOptions = {}): ImageStore {
  const minInterval = options.touchMinIntervalMs ?? TOUCH_MIN_INTERVAL_MS;
  const touched = new Map<string, number>();

  const remember = (contentKey: string, at: number): void => {
    touched.delete(contentKey);
    touched.set(contentKey, at);
    if (touched.size > TOUCH_MEMORY) {
      const oldest = touched.keys().next();
      if (oldest.done !== true) touched.delete(oldest.value);
    }
  };

  return {
    get: (contentKey) => io("images.get", () => db.get("images", contentKey)),
    put: (record: ImageRecord) =>
      io("images.put", async () => {
        await db.put("images", record);
        remember(record.contentKey, record.lastUsedAt);
      }),
    touch: (contentKey, at) =>
      io("images.touch", async () => {
        const last = touched.get(contentKey);
        if (last !== undefined && at - last < minInterval) return;
        const tx = db.transaction("images", "readwrite");
        const record = await tx.store.get(contentKey);
        const write = record !== undefined && at - record.lastUsedAt >= minInterval;
        if (write) await tx.store.put({ ...record, lastUsedAt: at });
        await tx.done;
        // Remember what the record holds, so the next touch can skip the read only when it would not write.
        if (record !== undefined) remember(contentKey, write ? at : record.lastUsedAt);
      }),
    alias: (urlKey) =>
      io("urls.get", async () => {
        const record = await db.get("urls", urlKey);
        return record?.contentKey;
      }),
    putAlias: (urlKey, contentKey, at) =>
      io("urls.put", async () => {
        await db.put("urls", { urlKey, contentKey, lastSeenAt: at });
      }),
  };
}
