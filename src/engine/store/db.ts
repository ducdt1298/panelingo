// Engine side of IndexedDB "ctv": opens the database (all 12 stores of DB_VERSION 1, src/platform/db-schema.ts) and
// builds one repository per store (urls go with images). The engine is the single writer; UI pages only read.

import { openCtvDb, type CtvDatabase } from "../../platform/db-schema.ts";
import type {
  ChapterStore,
  CoreDeps,
  EngineStores,
  GlossaryStore,
  PageStore,
  SeriesStore,
} from "../contracts.ts";
import { createChapterStore } from "./chapters.ts";
import { createGlossaryStore } from "./glossary.ts";
import { createImageStore } from "./images.ts";
import { createKvStore } from "./kv.ts";
import { createLogStore, type LogStoreImpl } from "./logs.ts";
import { createModelStore } from "./models.ts";
import { createPageStore } from "./pages.ts";
import { createPatchStore } from "./patches.ts";
import { createSeriesStore } from "./series.ts";
import { createTranslationStore, type TranslationStoreImpl } from "./translations.ts";
import { createUnitStore } from "./units.ts";
import { io } from "./io.ts";

export interface OpenStoresOptions {
  /** Opens the database (default openCtvDb). */
  open?: () => Promise<CtvDatabase>;
  translationFlushMs?: number;
  logBatchMs?: number;
}

export interface EngineStoresImpl extends EngineStores {
  readonly translations: TranslationStoreImpl;
  readonly logs: LogStoreImpl;
  readonly series: SeriesStore;
  readonly glossary: GlossaryStore;
  readonly chapters: ChapterStore;
  readonly pages: PageStore;
}

export async function openStores(deps: CoreDeps, options: OpenStoresOptions = {}): Promise<EngineStoresImpl> {
  const { clock, log, settings } = deps;
  const open =
    options.open ??
    ((): Promise<CtvDatabase> =>
      openCtvDb({ onBlocked: () => log.warn("database upgrade blocked by another connection") }));
  const db = await io("db.open", open);
  const translations = createTranslationStore(db, {
    clock,
    log,
    ...(options.translationFlushMs === undefined ? {} : { flushMs: options.translationFlushMs }),
  });
  const logs = createLogStore(db, {
    clock,
    capacity: () => settings.current().debug.logCapacity,
    ...(options.logBatchMs === undefined ? {} : { batchMs: options.logBatchMs }),
  });
  // The ring buffer is pruned at start; a failure only leaves more entries than the capacity.
  logs.trim().catch((error: unknown) => log.warn("log trim failed", { error: String(error) }, "store.io"));
  let closed = false;
  return {
    db,
    images: createImageStore(db),
    units: createUnitStore(db),
    translations,
    kv: createKvStore(db),
    logs,
    models: createModelStore(db),
    patches: createPatchStore(db),
    series: createSeriesStore(db),
    glossary: createGlossaryStore(db),
    chapters: createChapterStore(db),
    pages: createPageStore(db),
    close: async () => {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([translations.flush(), logs.flush()]);
      for (const result of results) {
        if (result.status === "rejected") log.warn("final flush failed", { error: String(result.reason) });
      }
      db.close();
    },
  };
}
