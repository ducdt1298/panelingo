// Store "models": integrity of the shipped detector files (sha256 verified once per build).

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { ModelIntegrityRecord } from "../../shared/records.ts";
import type { ModelStore } from "../contracts.ts";
import { io } from "./io.ts";

export function createModelStore(db: CtvDatabase): ModelStore {
  return {
    get: (file) => io(`models.get ${file}`, () => db.get("models", file)),
    put: (record: ModelIntegrityRecord) =>
      io(`models.put ${record.file}`, async () => {
        await db.put("models", record);
      }),
  };
}
