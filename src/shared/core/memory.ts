// Series memory rules: glossary learning, series profile edits, language votes, chapter summary and history
// selection (docs/ARCHITECTURE.md "Series memory"). PURE.
//
// Glossary states, strongest first: manual (typed or imported by the user) > confirmed (a suggestion the user accepted)
// > learned (an @term the model gave in ≥ settings.memory.termMinSightings distinct packs) > candidate (a fresh @term,
// never sent in a prompt). The model never changes a manual or confirmed rendering: its sightings only count. A
// candidate or learned entry follows the rendering the model gave most often; the others are kept as alternatives.
// @lang votes settle the series language once one language has 2 votes more than any other has (only while the profile
// says "auto"). @sum replaces the chapter summary only from a pack further down the chapter than the one that wrote it.

import { pagePos } from "../ids.ts";
import type { ChapterRecord, GlossaryEntry, TranslationRecord } from "../records.ts";
import type { GlossaryEdit, Lang, LineType, PronounRule, ReadingDir, SeriesProfile } from "../types.ts";
import type { HistoryLine, GlossaryEntry as PromptGlossaryEntry } from "./prompt.ts";

/** Pack ids remembered per entry: distinct packs are counted over this window. */
export const MAX_PACK_IDS = 10;
export const MAX_TERM_CHARS = 80;
export const MAX_NOTE_CHARS = 200;
export const MAX_ALTERNATIVES = 5;
/** Votes the leading language needs (and must lead by) before the series language settles. */
export const LANG_SETTLE_VOTES = 2;
/** Candidates kept per series; the least recently seen go first. */
export const MAX_CANDIDATES = 300;
export const MAX_PRONOUN_RULES = 20;
export const MAX_PRONOUN_CHARS = 40;
export const MAX_SERIES_TITLE_CHARS = 120;
export const MAX_GENRE_CHARS = 100;
export const MAX_SERIES_NOTES_CHARS = 1_000;

export type GlossaryState = GlossaryEntry["state"];
export const GLOSSARY_STATES: readonly GlossaryState[] = ["manual", "confirmed", "learned", "candidate"];
export const SOURCE_LANGS: readonly Lang[] = ["ja", "ko", "zh", "en", "es", "other"];

const STATE_RANK: Readonly<Record<GlossaryState, number>> = {
  manual: 0,
  confirmed: 1,
  learned: 2,
  candidate: 3,
};

/** One line of text: NFC, whitespace collapsed, trimmed, at most `max` characters; "" for anything but a string. */
export function cleanText(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const one = text.normalize("NFC").replace(/\s+/gu, " ").trim();
  const chars = [...one];
  return chars.length <= max ? one : chars.slice(0, max).join("").trim();
}

/** The glossary key of an original term (what entries are stored under). */
export function termKey(original: unknown): string {
  return cleanText(original, MAX_TERM_CHARS);
}

function compareKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Two renderings are the same up to case, width and spacing. */
export function sameRendering(a: string, b: string): boolean {
  return compareKey(a) === compareKey(b);
}

/* ------------------------------------------------------------------ glossary */

export interface TermSighting {
  original: string;
  translation: string;
  note: string;
  packId: string;
  at: number;
}

function countAlternative(entry: GlossaryEntry, translation: string): void {
  const known = entry.alternatives.find((alt) => sameRendering(alt.translation, translation));
  if (known !== undefined) known.count += 1;
  else entry.alternatives.push({ translation, count: 1 });
  entry.alternatives.sort((a, b) => b.count - a.count);
  entry.alternatives.splice(MAX_ALTERNATIVES);
}

/**
 * The entry after the model gave `sighting` (an @term line) in one pack, or null when nothing changes: an empty term,
 * or a pack that already counted (ladder re-asks repeat their terms). A new term is a candidate (learned right away
 * when minPacks ≤ 1).
 */
export function learnTerm(
  seriesKey: string,
  existing: GlossaryEntry | undefined,
  sighting: TermSighting,
  minPacks: number,
): GlossaryEntry | null {
  const orig = termKey(sighting.original);
  const translation = cleanText(sighting.translation, MAX_TERM_CHARS);
  const note = cleanText(sighting.note, MAX_NOTE_CHARS);
  if (orig === "" || translation === "") return null;
  const at = sighting.at;
  if (existing === undefined) {
    return {
      seriesKey,
      orig,
      translation,
      note,
      state: minPacks <= 1 ? "learned" : "candidate",
      sightings: 1,
      packIds: [sighting.packId],
      alternatives: [],
      firstSeenAt: at,
      lastSeenAt: at,
    };
  }
  if (existing.packIds.includes(sighting.packId)) return null;
  const entry: GlossaryEntry = {
    ...existing,
    sightings: existing.sightings + 1,
    packIds: [...existing.packIds, sighting.packId].slice(-MAX_PACK_IDS),
    alternatives: existing.alternatives.map((alt) => ({ ...alt })),
    lastSeenAt: Math.max(existing.lastSeenAt, at),
  };
  const same = sameRendering(existing.translation, translation);
  if (!same) countAlternative(entry, translation);
  // Manual and confirmed renderings are the user's: the model's sighting only counts.
  if (existing.state === "manual" || existing.state === "confirmed") return entry;
  if (same && entry.note === "" && note !== "") entry.note = note;
  const others = entry.alternatives.reduce((sum, alt) => sum + alt.count, 0);
  const mainCount = entry.sightings - others;
  const leader = entry.alternatives[0];
  if (leader !== undefined && leader.count > mainCount) {
    // The model now mostly says something else: follow it, and keep the old rendering as an alternative.
    entry.alternatives = entry.alternatives.filter((alt) => alt !== leader);
    entry.alternatives.push({ translation: entry.translation, count: mainCount });
    entry.alternatives.sort((a, b) => b.count - a.count);
    entry.alternatives.splice(MAX_ALTERNATIVES);
    entry.translation = leader.translation;
    entry.note = sameRendering(leader.translation, translation) ? note : "";
  }
  if (entry.state === "candidate" && new Set(entry.packIds).size >= minPacks) entry.state = "learned";
  return entry;
}

/** A user edit: a manual entry that keeps the sighting history of any entry it replaces; null when incomplete. */
export function manualEntry(
  seriesKey: string,
  existing: GlossaryEntry | undefined,
  edit: GlossaryEdit,
  now: number,
): GlossaryEntry | null {
  const orig = termKey(edit.orig);
  const translation = cleanText(edit.translation, MAX_TERM_CHARS);
  const note = cleanText(edit.note, MAX_NOTE_CHARS);
  if (orig === "" || translation === "") return null;
  if (existing === undefined) {
    return {
      seriesKey,
      orig,
      translation,
      note,
      state: "manual",
      sightings: 0,
      packIds: [],
      alternatives: [],
      firstSeenAt: now,
      lastSeenAt: now,
    };
  }
  return {
    ...existing,
    translation,
    note,
    state: "manual",
    packIds: [...existing.packIds],
    alternatives: existing.alternatives.filter((alt) => !sameRendering(alt.translation, translation)),
  };
}

/** A candidate or learned entry the user accepted; null when there is nothing to confirm. */
export function confirmEntry(existing: GlossaryEntry | undefined): GlossaryEntry | null {
  if (existing === undefined || (existing.state !== "candidate" && existing.state !== "learned")) return null;
  return { ...existing, state: "confirmed", packIds: [...existing.packIds] };
}

/** Strongest state first, then the most recently seen, the most often seen, and the original. */
export function rankEntries(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  return [...entries].sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      b.lastSeenAt - a.lastSeenAt ||
      b.sightings - a.sightings ||
      (a.orig < b.orig ? -1 : a.orig > b.orig ? 1 : 0),
  );
}

/** Glossary lines for the prompt: manual, then confirmed, then learned entries; candidates are never sent. */
export function promptGlossary(entries: readonly GlossaryEntry[]): PromptGlossaryEntry[] {
  return rankEntries(entries).flatMap((entry): PromptGlossaryEntry[] =>
    entry.state === "candidate" || entry.translation === ""
      ? []
      : [
          {
            original: entry.orig,
            translation: entry.translation,
            ...(entry.note === "" ? {} : { note: entry.note }),
            source: entry.state,
          },
        ],
  );
}

/** Originals of the candidates beyond `max`, least recently seen first out. */
export function excessCandidates(entries: readonly GlossaryEntry[], max: number = MAX_CANDIDATES): string[] {
  const candidates = entries
    .filter((entry) => entry.state === "candidate")
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.sightings - a.sightings);
  return candidates.slice(Math.max(0, max)).map((entry) => entry.orig);
}

/**
 * A line uses a glossary term in its original but not the glossary's rendering in its translation. Candidates and
 * one-character terms (too likely to appear inside other words) are not checked.
 */
export function isInconsistent(
  glossary: readonly GlossaryEntry[],
  original: string,
  translation: string,
): boolean {
  const source = compareKey(original);
  const target = compareKey(translation);
  if (source === "" || target === "") return false;
  return glossary.some((entry) => {
    if (entry.state === "candidate") return false;
    const term = compareKey(entry.orig);
    const rendering = compareKey(entry.translation);
    return [...term].length >= 2 && rendering !== "" && source.includes(term) && !target.includes(rendering);
  });
}

/* ------------------------------------------------------------------ series profile */

export function newSeriesProfile(
  seriesKey: string,
  siteKey: string,
  title: string,
  now: number,
): SeriesProfile {
  return {
    seriesKey,
    siteKey,
    title: cleanText(title, MAX_SERIES_TITLE_CHARS),
    lang: "auto",
    langVotes: {},
    readingDir: "auto",
    style: { genre: "", koNames: "romanized", keepJaHonorifics: false },
    pronouns: [],
    summaryEnabled: true,
    notes: "",
    aliases: [],
    createdAt: now,
    updatedAt: now,
    lastReadAt: now,
  };
}

/** One pack's @lang vote; the language settles once a leader has LANG_SETTLE_VOTES and more than any other. */
export function castLangVote(profile: SeriesProfile, lang: Lang, now: number): SeriesProfile {
  const votes: Partial<Record<Lang, number>> = {
    ...profile.langVotes,
    [lang]: (profile.langVotes[lang] ?? 0) + 1,
  };
  let settled = profile.lang;
  if (settled === "auto") {
    const ranked = SOURCE_LANGS.map((code) => [code, votes[code] ?? 0] as const).sort((a, b) => b[1] - a[1]);
    const [first, second] = ranked;
    if (first !== undefined && first[1] >= LANG_SETTLE_VOTES && first[1] > (second?.[1] ?? 0))
      settled = first[0];
  }
  return { ...profile, langVotes: votes, lang: settled, updatedAt: now };
}

/** The fields of a series profile the user may change (en:series-update, glossary import). */
export interface SeriesPatch {
  title?: string;
  lang?: Lang | "auto";
  readingDir?: "auto" | ReadingDir;
  style?: Partial<SeriesProfile["style"]>;
  pronouns?: PronounRule[];
  summaryEnabled?: boolean;
  notes?: string;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A validated patch from untrusted input; null when a patchable field holds a wrong value. Fields the user cannot set
 * (keys, votes, aliases, timestamps) are ignored.
 */
export function sanitizeSeriesPatch(raw: unknown): SeriesPatch | null {
  if (!isPlain(raw)) return null;
  const patch: SeriesPatch = {};
  if (raw["title"] !== undefined) {
    if (typeof raw["title"] !== "string") return null;
    patch.title = cleanText(raw["title"], MAX_SERIES_TITLE_CHARS);
  }
  if (raw["lang"] !== undefined) {
    const lang =
      SOURCE_LANGS.find((code) => code === raw["lang"]) ?? (raw["lang"] === "auto" ? "auto" : null);
    if (lang === null) return null;
    patch.lang = lang;
  }
  if (raw["readingDir"] !== undefined) {
    const dir = raw["readingDir"];
    if (dir !== "auto" && dir !== "ltr" && dir !== "rtl") return null;
    patch.readingDir = dir;
  }
  if (raw["style"] !== undefined) {
    const style = raw["style"];
    if (!isPlain(style)) return null;
    const next: Partial<SeriesProfile["style"]> = {};
    if (style["genre"] !== undefined) {
      if (typeof style["genre"] !== "string") return null;
      next.genre = cleanText(style["genre"], MAX_GENRE_CHARS);
    }
    if (style["koNames"] !== undefined) {
      if (style["koNames"] !== "romanized" && style["koNames"] !== "han-viet") return null;
      next.koNames = style["koNames"];
    }
    if (style["keepJaHonorifics"] !== undefined) {
      if (typeof style["keepJaHonorifics"] !== "boolean") return null;
      next.keepJaHonorifics = style["keepJaHonorifics"];
    }
    patch.style = next;
  }
  if (raw["pronouns"] !== undefined) {
    const rules = raw["pronouns"];
    if (!Array.isArray(rules) || rules.length > MAX_PRONOUN_RULES) return null;
    const out: PronounRule[] = [];
    for (const rule of rules as unknown[]) {
      if (!isPlain(rule)) return null;
      const fields = ["a", "b", "aSelf", "aToB"] as const;
      if (fields.some((field) => typeof rule[field] !== "string")) return null;
      const [a, b, aSelf, aToB] = fields.map((field) => cleanText(rule[field], MAX_PRONOUN_CHARS));
      if (a !== undefined && b !== undefined && a !== "" && b !== "") {
        out.push({ a, b, aSelf: aSelf ?? "", aToB: aToB ?? "" });
      }
    }
    patch.pronouns = out;
  }
  if (raw["summaryEnabled"] !== undefined) {
    if (typeof raw["summaryEnabled"] !== "boolean") return null;
    patch.summaryEnabled = raw["summaryEnabled"];
  }
  if (raw["notes"] !== undefined) {
    if (typeof raw["notes"] !== "string") return null;
    patch.notes = cleanText(raw["notes"], MAX_SERIES_NOTES_CHARS);
  }
  return patch;
}

/** The profile with a sanitized patch applied. Going back to "auto" clears the language votes, so they settle anew. */
export function applySeriesPatch(profile: SeriesProfile, patch: SeriesPatch, now: number): SeriesProfile {
  const next: SeriesProfile = {
    ...profile,
    style: { ...profile.style, ...patch.style },
    pronouns: patch.pronouns === undefined ? profile.pronouns.map((rule) => ({ ...rule })) : patch.pronouns,
    langVotes: { ...profile.langVotes },
    aliases: [...profile.aliases],
    updatedAt: now,
  };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.readingDir !== undefined) next.readingDir = patch.readingDir;
  if (patch.summaryEnabled !== undefined) next.summaryEnabled = patch.summaryEnabled;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.lang !== undefined) {
    if (patch.lang === "auto" && profile.lang !== "auto") next.langVotes = {};
    next.lang = patch.lang;
  }
  return next;
}

/* ------------------------------------------------------------------ chapter: summary and history */

export function newChapter(
  chapterKey: string,
  seriesKey: string | null,
  url: string,
  title: string,
  now: number,
): ChapterRecord {
  return {
    chapterKey,
    seriesKey,
    url,
    title: cleanText(title, MAX_SERIES_TITLE_CHARS),
    summary: "",
    summaryPos: -1,
    lastReadAt: now,
  };
}

function capWords(text: string, max: number): string {
  const words = text.split(" ").filter((word) => word !== "");
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/**
 * The chapter with the summary of a pack at page position `pos`, or null when the pack is not further down the
 * chapter than the one that wrote the stored summary (or the summary is empty).
 */
export function nextSummary(
  chapter: ChapterRecord,
  text: string,
  pos: number,
  maxWords: number,
): ChapterRecord | null {
  const summary = capWords(cleanText(text, 2_000), Math.max(1, maxWords));
  if (summary === "" || pos <= chapter.summaryPos) return null;
  return { ...chapter, summary, summaryPos: pos };
}

/** The text a stored line shows: the manual edit, else an accepted AI translation, else "". */
export function shownTranslation(
  record: Pick<TranslationRecord, "manual" | "manualTranslation" | "status" | "translation">,
): string {
  if (record.manual === 1 && record.manualTranslation !== null) return record.manualTranslation;
  return record.status === "ok" ? record.translation : "";
}

export interface HistoryPage {
  /** Document order of the image in the chapter (PageRecord.orderKey). */
  docOrder: number;
  lines: ReadonlyArray<{
    order: number;
    type: LineType;
    speaker: string;
    original: string;
    translation: string;
  }>;
}

/** Types that say nothing about who says what (no context value). */
const NO_HISTORY: ReadonlySet<LineType> = new Set<LineType>(["sfx", "ignore"]);

/**
 * The last `maxLines` translated lines before page position `before`, in page order then reading order (oldest
 * first). Sound effects, ignored regions and lines without a translation are skipped.
 */
export function historyBefore(
  pages: readonly HistoryPage[],
  before: number,
  maxLines: number,
): HistoryLine[] {
  if (maxLines <= 0) return [];
  const lines: HistoryLine[] = [];
  for (const page of pages) {
    for (const line of page.lines) {
      const pos = pagePos(page.docOrder, line.order);
      if (pos >= before || NO_HISTORY.has(line.type) || line.translation.trim() === "") continue;
      lines.push({ pos, speaker: line.speaker, original: line.original, translation: line.translation });
    }
  }
  lines.sort((a, b) => a.pos - b.pos);
  return lines.slice(-maxLines);
}
