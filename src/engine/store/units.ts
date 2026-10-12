// Store "units": detector geometry per image (UnitsRecord). Authoritative once translations reference it.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { UnitsRecord } from "../../shared/records.ts";
import type { UnitStore } from "../contracts.ts";
import { io } from "./io.ts";

export function createUnitStore(db: CtvDatabase): UnitStore {
  return {
    get: (contentKey) => io("units.get", () => db.get("units", contentKey)),
    put: (record: UnitsRecord) =>
      io("units.put", async () => {
        await db.put("units", record);
      }),
  };
}
