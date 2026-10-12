// Store "kv": single typed values (settings mirror, detector decision, counters), records {k, v} keyed by k.

import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { KvKey, KvMap, KvRecord } from "../../shared/records.ts";
import type { KvStore } from "../contracts.ts";
import { io } from "./io.ts";

export function createKvStore(db: CtvDatabase): KvStore {
  return {
    get: <K extends KvKey>(key: K): Promise<KvMap[K] | undefined> =>
      io(`kv.get ${key}`, async () => {
        const record = await db.get("kv", key);
        return record === undefined ? undefined : (record.v as KvMap[K]);
      }),
    set: <K extends KvKey>(key: K, value: KvMap[K]): Promise<void> =>
      io(`kv.set ${key}`, async () => {
        // KvRecord is a union over keys; this pair is one of its members by construction.
        await db.put("kv", { k: key, v: value } as unknown as KvRecord);
      }),
  };
}
