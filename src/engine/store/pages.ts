// Store "pages": the images of a chapter keyed [chapterKey, contentKey], ordered by orderKey (the image's document
// order), so the chapter history reads earlier lines in page order. Derived from images: retention and en:cache-clear
// delete a page with its image.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { PageRecord } from "../../shared/records.ts";
import type { PageStore } from "../contracts.ts";
import { io } from "./io.ts";

export function createPageStore(db: CtvDatabase): PageStore {
  return {
    forChapter: (chapterKey) =>
      io("pages.forChapter", () =>
        db.getAllFromIndex(
          "pages",
          "byChapterOrder",
          IDBKeyRange.bound([chapterKey, Number.NEGATIVE_INFINITY], [chapterKey, Number.POSITIVE_INFINITY]),
        ),
      ),
    put: (record: PageRecord) =>
      io("pages.put", async () => {
        await db.put("pages", record);
      }),
  };
}
