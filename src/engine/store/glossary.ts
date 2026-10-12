// Store "glossary" keyed [seriesKey, orig]: manual, confirmed and learned renderings plus the model's candidates
// (src/shared/core/memory.ts has the rules). update() reads and writes several entries in one transaction (all or
// nothing), so learning from a pack can never overwrite a manual entry the user saved in the meantime.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { GlossaryEntry } from "../../shared/records.ts";
import type { GlossaryStore } from "../contracts.ts";
import { atomically, io } from "./io.ts";

/** Every key [seriesKey, orig] of one series: arrays sort after strings, so [seriesKey, []] ends the range. */
function seriesRange(seriesKey: string): IDBKeyRange {
  return IDBKeyRange.bound([seriesKey], [seriesKey, []]);
}

export function createGlossaryStore(db: CtvDatabase): GlossaryStore {
  return {
    forSeries: (seriesKey) => io("glossary.forSeries", () => db.getAll("glossary", seriesRange(seriesKey))),
    put: (entry: GlossaryEntry) =>
      io("glossary.put", async () => {
        await db.put("glossary", entry);
      }),
    delete: (seriesKey, orig) =>
      io("glossary.delete", async () => {
        await db.delete("glossary", [seriesKey, orig]);
      }),
    update: (seriesKey, origs, change) =>
      io("glossary.update", async () => {
        const tx = db.transaction("glossary", "readwrite");
        return atomically(tx, async () => {
          let changed = 0;
          for (const orig of new Set(origs)) {
            const existing = await tx.store.get([seriesKey, orig]);
            const next = change(orig, existing);
            if (next === undefined) continue;
            if (next === null) {
              if (existing === undefined) continue;
              await tx.store.delete([seriesKey, orig]);
            } else {
              await tx.store.put({ ...next, seriesKey, orig });
            }
            changed += 1;
          }
          return changed;
        });
      }),
  };
}
