// Store "chapters": one record per chapter (chapterKey = normalized page URL) with the running story summary and the
// page position of the pack that wrote it.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { ChapterRecord } from "../../shared/records.ts";
import type { ChapterStore } from "../contracts.ts";
import { atomically, io } from "./io.ts";

export function createChapterStore(db: CtvDatabase): ChapterStore {
  return {
    get: (chapterKey) => io("chapters.get", () => db.get("chapters", chapterKey)),
    put: (record: ChapterRecord) =>
      io("chapters.put", async () => {
        await db.put("chapters", record);
      }),
    update: (chapterKey, change) =>
      io("chapters.update", async () => {
        const tx = db.transaction("chapters", "readwrite");
        return atomically(tx, async () => {
          const existing = await tx.store.get(chapterKey);
          const next = change(existing);
          if (next === undefined) return existing;
          const record = { ...next, chapterKey };
          await tx.store.put(record);
          return record;
        });
      }),
  };
}
