// IndexedDB schema for database "ctv". All 12 stores exist from version 1 (pages, chapters, series and glossary hold
// the series memory). The engine is the single writer; UI pages read.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  ChapterRecord,
  GlossaryEntry,
  ImageRecord,
  KvRecord,
  LogRecord,
  ModelIntegrityRecord,
  PageRecord,
  PatchRecord,
  SeriesRecord,
  TranslationRecord,
  UnitsRecord,
  UrlAliasRecord,
} from "../shared/records.ts";
import { DB_VERSION } from "../shared/versions.ts";

export const DB_NAME = "ctv";

export interface CtvDB extends DBSchema {
  images: { key: string; value: ImageRecord; indexes: { byLastUsed: number; bySeries: string } };
  urls: { key: string; value: UrlAliasRecord; indexes: { byContent: string } };
  units: { key: string; value: UnitsRecord };
  translations: {
    key: [string, string];
    value: TranslationRecord;
    indexes: { byContent: string; bySeriesUpdated: [string, number]; byManual: number; byLastUsed: number };
  };
  patches: { key: [string, string]; value: PatchRecord; indexes: { byContent: string; byLastUsed: number } };
  pages: {
    key: [string, string];
    value: PageRecord;
    indexes: { byChapterOrder: [string, number]; byContent: string };
  };
  chapters: { key: string; value: ChapterRecord; indexes: { bySeries: string; byLastRead: number } };
  series: { key: string; value: SeriesRecord; indexes: { bySite: string; byLastRead: number } };
  glossary: {
    key: [string, string];
    value: GlossaryEntry;
    indexes: { bySeriesRecency: [string, number]; bySeriesState: [string, string] };
  };
  kv: { key: string; value: KvRecord };
  models: { key: string; value: ModelIntegrityRecord };
  logs: { key: number; value: LogRecord; indexes: { byTime: number } };
}

export type CtvDatabase = IDBPDatabase<CtvDB>;

export const STORE_NAMES = [
  "images",
  "urls",
  "units",
  "translations",
  "patches",
  "pages",
  "chapters",
  "series",
  "glossary",
  "kv",
  "models",
  "logs",
] as const;

/** Creates every store and index of schema version 1. */
export function createV1(db: IDBPDatabase<CtvDB>): void {
  const images = db.createObjectStore("images", { keyPath: "contentKey" });
  images.createIndex("byLastUsed", "lastUsedAt");
  images.createIndex("bySeries", "seriesKey");

  const urls = db.createObjectStore("urls", { keyPath: "urlKey" });
  urls.createIndex("byContent", "contentKey");

  db.createObjectStore("units", { keyPath: "contentKey" });

  const translations = db.createObjectStore("translations", { keyPath: ["contentKey", "unitKey"] });
  translations.createIndex("byContent", "contentKey");
  translations.createIndex("bySeriesUpdated", ["seriesKey", "updatedAt"]);
  translations.createIndex("byManual", "manual");
  translations.createIndex("byLastUsed", "lastUsedAt");

  const patches = db.createObjectStore("patches", { keyPath: ["contentKey", "unitKey"] });
  patches.createIndex("byContent", "contentKey");
  patches.createIndex("byLastUsed", "lastUsedAt");

  const pages = db.createObjectStore("pages", { keyPath: ["chapterKey", "contentKey"] });
  pages.createIndex("byChapterOrder", ["chapterKey", "orderKey"]);
  pages.createIndex("byContent", "contentKey");

  const chapters = db.createObjectStore("chapters", { keyPath: "chapterKey" });
  chapters.createIndex("bySeries", "seriesKey");
  chapters.createIndex("byLastRead", "lastReadAt");

  const series = db.createObjectStore("series", { keyPath: "seriesKey" });
  series.createIndex("bySite", "siteKey");
  series.createIndex("byLastRead", "lastReadAt");

  const glossary = db.createObjectStore("glossary", { keyPath: ["seriesKey", "orig"] });
  glossary.createIndex("bySeriesRecency", ["seriesKey", "lastSeenAt"]);
  glossary.createIndex("bySeriesState", ["seriesKey", "state"]);

  db.createObjectStore("kv", { keyPath: "k" });
  db.createObjectStore("models", { keyPath: "file" });

  const logs = db.createObjectStore("logs", { keyPath: "seq", autoIncrement: true });
  logs.createIndex("byTime", "t");
}

export interface OpenOptions {
  /** Called when another connection blocks an upgrade (logged by callers). */
  onBlocked?: () => void;
}

/** Opens (and if needed creates/upgrades) the database. Connections close themselves on versionchange. */
export async function openCtvDb(options: OpenOptions = {}): Promise<CtvDatabase> {
  const db = await openDB<CtvDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) createV1(database);
    },
    blocked() {
      options.onBlocked?.();
    },
    blocking() {
      db.close();
    },
  });
  return db;
}
