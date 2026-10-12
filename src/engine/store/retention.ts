// Data removal: TTL retention and the user's en:cache-clear. Manual edits, series profiles, chapter summaries and
// glossary entries in use (manual, confirmed, learned) are never deleted automatically.
//
// Retention: AI translations (manual = 0) not used for settings.cache.translationTtlDays (0 = keep forever) go; a
// translation counts as used while its image record was used too (the pipeline touches images on display). Images
// older than the TTL with no translation left go with their url aliases, units, pages and patches. Glossary
// candidates (model suggestions never confirmed nor learned, so never sent) not seen for the TTL go. Logs are trimmed
// to settings.debug.logCapacity. The run is recorded in kv "retention.lastRunAt".

import type { Logger } from "../../platform/log.ts";
import type { GlossaryEntry } from "../../shared/records.ts";
import type { Settings } from "../../shared/settings.ts";
import { CtvError } from "../../shared/errors.ts";
import type { CtvDatabase } from "../../platform/db-schema.ts";
import type { EngineStores } from "../contracts.ts";
import { deleteAll, io } from "./io.ts";
import { trimLogs } from "./logs.ts";

export const DAY_MS = 86_400_000;

export interface RetentionReport {
  translations: number;
  images: number;
  urls: number;
  units: number;
  pages: number;
  patches: number;
  /** Glossary candidates. */
  candidates: number;
  logs: number;
}

export interface RetentionInput {
  stores: EngineStores;
  settings: Settings;
  now: number;
  log?: Logger;
}

/** Deletes images and everything derived from them (not their translations), counting into `report`. */
function emptyReport(): RetentionReport {
  return { translations: 0, images: 0, urls: 0, units: 0, pages: 0, patches: 0, candidates: 0, logs: 0 };
}

/** Deletes glossary candidates that `drop` selects; returns how many. */
async function dropCandidates(db: CtvDatabase, drop: (entry: GlossaryEntry) => boolean): Promise<number> {
  const tx = db.transaction("glossary", "readwrite");
  let deleted = 0;
  let cursor = await tx.store.openCursor();
  while (cursor !== null) {
    if (cursor.value.state === "candidate" && drop(cursor.value)) {
      await cursor.delete();
      deleted += 1;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}

async function dropImageData(
  db: CtvDatabase,
  contentKeys: readonly string[],
  report: RetentionReport,
): Promise<void> {
  if (contentKeys.length === 0) return;
  const tx = db.transaction(["images", "urls", "units", "pages", "patches"], "readwrite");
  for (const contentKey of contentKeys) {
    if ((await tx.objectStore("images").count(contentKey)) > 0) {
      await tx.objectStore("images").delete(contentKey);
      report.images += 1;
    }
    report.urls += await deleteAll(tx.objectStore("urls").index("byContent").openCursor(contentKey));
    if ((await tx.objectStore("units").count(contentKey)) > 0) {
      await tx.objectStore("units").delete(contentKey);
      report.units += 1;
    }
    report.pages += await deleteAll(tx.objectStore("pages").index("byContent").openCursor(contentKey));
    report.patches += await deleteAll(tx.objectStore("patches").index("byContent").openCursor(contentKey));
  }
  await tx.done;
}

export async function runRetention(input: RetentionInput): Promise<RetentionReport> {
  const { stores, settings, now } = input;
  const db = stores.db;
  const report = emptyReport();
  await stores.translations.flush();
  const ttlDays = settings.cache.translationTtlDays;
  if (ttlDays > 0) {
    const cutoff = now - ttlDays * DAY_MS;
    const expired = IDBKeyRange.upperBound(cutoff, true);
    await io("retention.translations", async () => {
      const tx = db.transaction(["translations", "images"], "readwrite");
      const imageUsed = new Map<string, number>();
      let cursor = await tx.objectStore("translations").index("byLastUsed").openCursor(expired);
      while (cursor !== null) {
        const record = cursor.value;
        if (record.manual === 0) {
          let used = imageUsed.get(record.contentKey);
          if (used === undefined) {
            used = (await tx.objectStore("images").get(record.contentKey))?.lastUsedAt ?? 0;
            imageUsed.set(record.contentKey, used);
          }
          if (used < cutoff) {
            await cursor.delete();
            report.translations += 1;
          }
        }
        cursor = await cursor.continue();
      }
      await tx.done;
    });
    await io("retention.images", async () => {
      const orphans: string[] = [];
      const tx = db.transaction(["images", "translations"], "readonly");
      let cursor = await tx.objectStore("images").index("byLastUsed").openCursor(expired);
      while (cursor !== null) {
        const contentKey = cursor.value.contentKey;
        if ((await tx.objectStore("translations").index("byContent").count(contentKey)) === 0) {
          orphans.push(contentKey);
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      await dropImageData(db, orphans, report);
    });
    report.candidates = await io("retention.glossary", () =>
      dropCandidates(db, (entry) => entry.lastSeenAt < cutoff),
    );
  }
  report.logs = await trimLogs(db, settings.debug.logCapacity);
  await stores.kv.set("retention.lastRunAt", now);
  input.log?.info("retention done", { ...report, ttlDays });
  return report;
}

export type CacheScope = "all" | "site" | "series";

/**
 * en:cache-clear. Clears cached AI data: images, url aliases, units, pages, patches, AI translations and glossary
 * candidates. Manual edits (translations with manual = 1), series profiles, chapter summaries and the glossary entries
 * in use (manual, confirmed and learned) are memory the user built up and stay: before series memory the whole
 * glossary stayed, and only candidates, which never reach a prompt, are pure cache. "series" matches seriesKey === key;
 * "site" matches the seriesKeys of that origin (seriesKey = origin + "|" + series slug). Returns the number of records
 * deleted.
 */
export async function clearCache(stores: EngineStores, scope: CacheScope, key?: string): Promise<number> {
  await stores.translations.flush();
  const db = stores.db;
  if (scope === "all") {
    return io("cache-clear all", async () => {
      const tx = db.transaction(["images", "urls", "units", "pages", "patches", "translations"], "readwrite");
      let deleted = 0;
      for (const name of ["images", "urls", "units", "pages", "patches"] as const) {
        const store = tx.objectStore(name);
        deleted += await store.count();
        await store.clear();
      }
      let cursor = await tx.objectStore("translations").openCursor();
      while (cursor !== null) {
        if (cursor.value.manual === 0) {
          await cursor.delete();
          deleted += 1;
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      return deleted + (await dropCandidates(db, () => true));
    });
  }
  if (key === undefined || key === "") {
    throw new CtvError("engine.internal", `cache-clear ${scope}: a key is required`);
  }
  const matches = (seriesKey: string | null): boolean =>
    seriesKey !== null && (scope === "series" ? seriesKey === key : seriesKey.startsWith(key));
  return io(`cache-clear ${scope}`, async () => {
    const report = emptyReport();
    const tx = db.transaction(["translations", "images"], "readwrite");
    let cursor = await tx.objectStore("translations").openCursor();
    while (cursor !== null) {
      if (cursor.value.manual === 0 && matches(cursor.value.seriesKey)) {
        await cursor.delete();
        report.translations += 1;
      }
      cursor = await cursor.continue();
    }
    const images: string[] = [];
    let imageCursor = await tx.objectStore("images").openCursor();
    while (imageCursor !== null) {
      if (matches(imageCursor.value.seriesKey)) images.push(imageCursor.value.contentKey);
      imageCursor = await imageCursor.continue();
    }
    await tx.done;
    await dropImageData(db, images, report);
    report.candidates = await dropCandidates(db, (entry) => matches(entry.seriesKey));
    return (
      report.translations +
      report.images +
      report.urls +
      report.units +
      report.pages +
      report.patches +
      report.candidates
    );
  });
}
