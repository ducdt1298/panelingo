// Store "series": one profile per series (SeriesProfile: source language, style, forms of address, @lang votes).
// User data: neither retention nor en:cache-clear deletes it.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { SeriesRecord } from "../../shared/records.ts";
import type { SeriesStore } from "../contracts.ts";
import { atomically, io } from "./io.ts";

export function createSeriesStore(db: CtvDatabase): SeriesStore {
  return {
    get: (seriesKey) => io("series.get", () => db.get("series", seriesKey)),
    put: (record: SeriesRecord) =>
      io("series.put", async () => {
        await db.put("series", record);
      }),
    all: () => io("series.all", () => db.getAll("series")),
    update: (seriesKey, change) =>
      io("series.update", async () => {
        const tx = db.transaction("series", "readwrite");
        return atomically(tx, async () => {
          const existing = await tx.store.get(seriesKey);
          const next = change(existing);
          if (next === undefined) return existing;
          const record = { ...next, seriesKey };
          await tx.store.put(record);
          return record;
        });
      }),
  };
}
