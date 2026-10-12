// Store "patches": per-unit erase results. The PNG patch hides the original lettering pixel by pixel, so a cached
// chapter reopens with the same look without decoding the image again.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { PatchRecord } from "../../shared/records.ts";
import type { PatchStore } from "../contracts.ts";
import { io } from "./io.ts";

export function createPatchStore(db: CtvDatabase): PatchStore {
  return {
    forImage: (contentKey) =>
      io(`patches.forImage ${contentKey}`, () => db.getAllFromIndex("patches", "byContent", contentKey)),
    put: (record: PatchRecord) =>
      io(`patches.put ${record.contentKey}`, async () => {
        await db.put("patches", record);
      }),
  };
}
