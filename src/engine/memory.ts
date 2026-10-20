// Series memory service: the prompt context of a pack (series profile, glossary, earlier lines of the chapter,
// running summary) and what its answers teach (@term candidates, @sum, @lang votes). The rules live in
// src/shared/core/memory.ts; this module only reads and writes the stores. Memory never blocks translation: without
// the stores, with settings.memory.enabled off or after a store failure (logged), packs go without context.
//
// History: the images of a chapter are noted as pages (store "pages", orderKey = document order) when their packs
// are sent; a pack's history is the stored lines before its first unit, read from the nearest earlier page backwards
// until settings.memory.historyMaxLines lines are found. Learning runs one pack at a time, in a queue.

import type { Logger } from "../platform/log.ts";
import {
  castLangVote,
  excessCandidates,
  historyBefore,
  learnAddress,
  learnTerm,
  promptPronouns,
  newChapter,
  newSeriesProfile,
  nextSummary,
  promptGlossary,
  shownTranslation,
  termKey,
  type HistoryPage,
} from "../shared/core/memory.ts";
import type { Term } from "../shared/core/id-accounting.ts";
import type { HistoryLine } from "../shared/core/prompt.ts";
import { PAGE_POS_STRIDE, pagePos } from "../shared/ids.ts";
import type { ChapterRecord, SeriesRecord } from "../shared/records.ts";
import type { PronounRule } from "../shared/types.ts";
import { SERIES_KEY_SEPARATOR, seriesTitleOf } from "../shared/series-key.ts";
import type {
  ChapterStore,
  Clock,
  EngineStores,
  GlossaryStore,
  MemoryScope,
  PackLearning,
  PackMemory,
  PageStore,
  SeriesMemory,
  SeriesStore,
  SettingsSource,
} from "./contracts.ts";

/** Series and chapter lastReadAt are written at most this often. */
export const TOUCH_INTERVAL_MS = 60_000;
/** Earlier pages read at most per history lookup (nearest first). */
export const HISTORY_MAX_PAGES = 12;
/** Pages remembered as already stored (only a write-skipping hint). */
const PAGE_MEMORY = 4096;

export interface SeriesMemoryDeps {
  clock: Clock;
  log: Logger;
  settings: SettingsSource;
  stores: EngineStores;
}

interface MemoryStores {
  series: SeriesStore;
  glossary: GlossaryStore;
  chapters: ChapterStore;
  pages: PageStore;
}

function slugOf(seriesKey: string): string {
  const at = seriesKey.indexOf(SERIES_KEY_SEPARATOR);
  return at < 0 ? seriesKey : seriesKey.slice(at + 1);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export function createSeriesMemory(deps: SeriesMemoryDeps): SeriesMemory {
  const { clock, log, settings, stores } = deps;
  /** `${chapterKey}\0${contentKey}` → orderKey already stored. */
  const pagesStored = new Map<string, number>();
  let chain: Promise<void> = Promise.resolve();

  const memoryStores = (): MemoryStores | null => {
    const { series, glossary, chapters, pages } = stores;
    return series === undefined || glossary === undefined || chapters === undefined || pages === undefined
      ? null
      : { series, glossary, chapters, pages };
  };

  const freshProfile = (scope: MemoryScope, now: number): SeriesRecord =>
    newSeriesProfile(
      scope.seriesKey,
      scope.siteKey,
      seriesTitleOf(scope.title, slugOf(scope.seriesKey)),
      now,
    );

  /** The series profile, created on first sight; lastReadAt follows reading (at most once a minute). */
  async function ensureSeries(st: MemoryStores, scope: MemoryScope, now: number): Promise<SeriesRecord> {
    const stored = await st.series.get(scope.seriesKey);
    if (stored !== undefined && now - stored.lastReadAt < TOUCH_INTERVAL_MS) return stored;
    const next = await st.series.update(scope.seriesKey, (existing) =>
      existing === undefined ? freshProfile(scope, now) : { ...existing, lastReadAt: now },
    );
    return next ?? freshProfile(scope, now);
  }

  async function ensureChapter(st: MemoryStores, scope: MemoryScope, now: number): Promise<ChapterRecord> {
    const stored = await st.chapters.get(scope.chapterKey);
    if (stored !== undefined && now - stored.lastReadAt < TOUCH_INTERVAL_MS) return stored;
    const fresh = newChapter(scope.chapterKey, scope.seriesKey, scope.url, scope.title, now);
    const next = await st.chapters.update(scope.chapterKey, (existing) =>
      existing === undefined ? fresh : { ...existing, lastReadAt: now },
    );
    return next ?? fresh;
  }

  async function notePage(
    st: MemoryStores,
    scope: MemoryScope,
    contentKey: string,
    docOrder: number,
    now: number,
  ): Promise<void> {
    const key = `${scope.chapterKey}\u0000${contentKey}`;
    if (pagesStored.get(key) === docOrder) return;
    await st.pages.put({
      chapterKey: scope.chapterKey,
      contentKey,
      seriesKey: scope.seriesKey,
      orderKey: docOrder,
      urlPath: pathOf(scope.url),
      seenAt: now,
    });
    pagesStored.delete(key);
    pagesStored.set(key, docOrder);
    if (pagesStored.size > PAGE_MEMORY) {
      const oldest = pagesStored.keys().next();
      if (oldest.done !== true) pagesStored.delete(oldest.value);
    }
  }

  /** Stored lines before page position `before`, from the nearest earlier page backwards until there are enough. */
  async function history(
    st: MemoryStores,
    chapterKey: string,
    before: number,
    maxLines: number,
  ): Promise<HistoryLine[]> {
    if (maxLines <= 0) return [];
    const lastDoc = Math.floor(before / PAGE_POS_STRIDE);
    const pages = (await st.pages.forChapter(chapterKey))
      .filter((page) => page.orderKey <= lastDoc)
      .slice(-HISTORY_MAX_PAGES)
      .reverse();
    const sources: HistoryPage[] = [];
    let found = 0;
    for (const page of pages) {
      const [units, records] = await Promise.all([
        stores.units.get(page.contentKey),
        stores.translations.forImage(page.contentKey),
      ]);
      const orders = new Map((units?.units ?? []).map((unit) => [unit.unitKey, unit.order]));
      const lines: HistoryPage["lines"][number][] = [];
      for (const record of records) {
        const order = orders.get(record.unitKey);
        const translation = shownTranslation(record);
        if (order === undefined || translation === "") continue;
        lines.push({
          order,
          type: record.type,
          speaker: record.speaker,
          original: record.original,
          translation,
        });
        if (pagePos(page.orderKey, order) < before) found += 1;
      }
      sources.push({ docOrder: page.orderKey, lines });
      if (found >= maxLines) break;
    }
    return historyBefore(sources, before, maxLines);
  }

  async function context(
    scope: MemoryScope,
    pack: { contentKey: string; docOrder: number; pos: number },
  ): Promise<PackMemory | null> {
    const memory = settings.current().memory;
    const st = memoryStores();
    if (!memory.enabled || st === null) return null;
    try {
      const now = clock.now();
      const [profile, chapter] = await Promise.all([
        ensureSeries(st, scope, now),
        ensureChapter(st, scope, now),
      ]);
      await notePage(st, scope, pack.contentKey, pack.docOrder, now);
      const [entries, lines] = await Promise.all([
        st.glossary.forSeries(scope.seriesKey),
        history(st, scope.chapterKey, pack.pos, memory.historyMaxLines),
      ]);
      const summaryOn = profile.summaryEnabled && memory.summaryMaxWords > 0;
      return {
        lang: profile.lang === "auto" ? null : profile.lang,
        style: {
          genre: profile.style.genre,
          koNames: profile.style.koNames,
          keepJaHonorifics: profile.style.keepJaHonorifics,
        },
        glossary: promptGlossary(entries).slice(0, Math.max(0, memory.glossaryInPrompt)),
        pronouns: promptPronouns(
          profile.pronouns,
          lines.map((line) => line.speaker),
        ),
        history: lines,
        summary: summaryOn && chapter.summary !== "" ? chapter.summary : null,
        askSummary: summaryOn,
      };
    } catch (error) {
      log.warn("series memory unavailable, sending without context", { error: String(error) }, "store.io");
      return null;
    }
  }

  async function learnNow(
    scope: MemoryScope,
    pack: { packId: string; pos: number; learning: PackLearning },
  ): Promise<void> {
    const memory = settings.current().memory;
    const st = memoryStores();
    if (!memory.enabled || st === null) return;
    const now = clock.now();
    const { terms, summary, lang } = pack.learning;
    const addresses = pack.learning.addresses ?? [];
    if (terms.length > 0) {
      const byKey = new Map<string, Term>();
      for (const term of terms) {
        const key = termKey(term.original);
        if (key !== "" && !byKey.has(key)) byKey.set(key, term);
      }
      const written = await st.glossary.update(scope.seriesKey, [...byKey.keys()], (orig, existing) => {
        const term = byKey.get(orig);
        if (term === undefined) return undefined;
        const sighting = { ...term, packId: pack.packId, at: now };
        return learnTerm(scope.seriesKey, existing, sighting, memory.termMinSightings) ?? undefined;
      });
      if (written > 0) {
        const drop = excessCandidates(await st.glossary.forSeries(scope.seriesKey));
        if (drop.length > 0) await st.glossary.update(scope.seriesKey, drop, () => null);
      }
    }
    if (addresses.length > 0) {
      await st.series.update(scope.seriesKey, (existing) => {
        const profile = existing ?? freshProfile(scope, now);
        let rules: PronounRule[] = profile.pronouns;
        let changed = false;
        for (const address of addresses) {
          const next = learnAddress(rules, { ...address, packId: pack.packId, at: now });
          if (next !== null) {
            rules = next;
            changed = true;
          }
        }
        return changed
          ? { ...profile, pronouns: rules, updatedAt: now }
          : existing === undefined
            ? profile
            : undefined;
      });
    }
    if (summary !== null && memory.summaryMaxWords > 0) {
      const profile = await st.series.get(scope.seriesKey);
      if (profile?.summaryEnabled !== false) {
        await st.chapters.update(scope.chapterKey, (existing) => {
          const chapter =
            existing ?? newChapter(scope.chapterKey, scope.seriesKey, scope.url, scope.title, now);
          return nextSummary(chapter, summary, pack.pos, memory.summaryMaxWords) ?? undefined;
        });
      }
    }
    if (lang !== null) {
      await st.series.update(scope.seriesKey, (existing) =>
        castLangVote(existing ?? freshProfile(scope, now), lang, now),
      );
    }
  }

  return {
    context,
    learn: (scope, pack) => {
      const run = chain.then(() => learnNow(scope, pack));
      chain = run.catch((error: unknown) => {
        log.warn("series memory learning failed", { error: String(error) }, "store.io");
      });
      return chain;
    },
    idle: () => chain,
    cacheCleared: () => {
      pagesStored.clear();
    },
  };
}
