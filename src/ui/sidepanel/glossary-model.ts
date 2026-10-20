// Glossary view model (side panel): pure helpers over en:glossary-list and the JSON export/import format, kept apart
// from the DOM so they can be unit tested. The file is {version, series, glossary[]}; an import adds its entries to
// the current tab's series as manual entries (suggestions are skipped) and applies the file's series settings.

import {
  addressKey,
  cleanText,
  GLOSSARY_STATES,
  MAX_NOTE_CHARS,
  MAX_PRONOUN_CHARS,
  MAX_PRONOUN_RULES,
  MAX_TERM_CHARS,
  sanitizeSeriesPatch,
  type GlossaryState,
  type SeriesPatch,
} from "../../shared/core/memory.ts";
import type { GlossaryEntry } from "../../shared/records.ts";
import { SERIES_KEY_SEPARATOR } from "../../shared/series-key.ts";
import type { GlossaryEdit, Lang, PronounRule, SeriesProfile } from "../../shared/types.ts";

export const GLOSSARY_EXPORT_VERSION = 1;
/** Entries per en:glossary-upsert call while importing (the engine takes up to 500). */
export const IMPORT_CHUNK = 200;

export interface StateGroup {
  state: GlossaryState;
  entries: GlossaryEntry[];
}

/** One exported entry: everything needed to rebuild it in another series or browser. */
export interface ExportedEntry {
  orig: string;
  translation: string;
  note: string;
  state: GlossaryState;
}

export interface GlossaryExport {
  version: number;
  series: SeriesProfile | null;
  glossary: ExportedEntry[];
}

export interface GlossaryImport {
  /** Manual entries to save, one per original (the last one in the file wins). */
  edits: GlossaryEdit[];
  /** Series settings from the file (language, style, forms of address, summary, notes), or null. */
  patch: SeriesPatch | null;
  /** Suggestions and malformed entries left out. */
  skipped: number;
}

/** The series-settings form. */
export interface ProfileDraft {
  lang: Lang | "auto";
  koNames: SeriesProfile["style"]["koNames"];
  keepJaHonorifics: boolean;
  summaryEnabled: boolean;
}

function byOrig(a: GlossaryEntry, b: GlossaryEntry): number {
  return a.orig.localeCompare(b.orig);
}

/**
 * Non-empty groups in state order (manual, confirmed, learned, candidates). The user's entries read alphabetically;
 * the model's most frequent first.
 */
export function groupByState(entries: readonly GlossaryEntry[]): StateGroup[] {
  return GLOSSARY_STATES.flatMap((state): StateGroup[] => {
    const group = entries.filter((entry) => entry.state === state);
    if (group.length === 0) return [];
    const sorted =
      state === "manual" || state === "confirmed"
        ? group.sort(byOrig)
        : group.sort((a, b) => b.sightings - a.sightings || b.lastSeenAt - a.lastSeenAt || byOrig(a, b));
    return [{ state, entries: sorted }];
  });
}

/** Suggestions and learned entries can be confirmed (manual and confirmed ones already are). */
export function canConfirm(entry: Pick<GlossaryEntry, "state">): boolean {
  return entry.state === "candidate" || entry.state === "learned";
}

/** A complete edit from form fields, or null when the original or the translation is missing. */
export function editFromDraft(draft: {
  orig: string;
  translation: string;
  note: string;
}): GlossaryEdit | null {
  const orig = cleanText(draft.orig, MAX_TERM_CHARS);
  const translation = cleanText(draft.translation, MAX_TERM_CHARS);
  if (orig === "" || translation === "") return null;
  return { orig, translation, note: cleanText(draft.note, MAX_NOTE_CHARS) };
}

/* ------------------------------------------------------------------ forms of address */

export interface AddressDraft {
  a: string;
  b: string;
  aSelf: string;
  aToB: string;
}

/** A learned rule (reported by the AI); anything else is the reader's and the AI never changes it. */
export function isLearnedAddress(rule: Pick<PronounRule, "source">): boolean {
  return rule.source === "learned";
}

/** The reader's rules first (by speaker), then the learned ones, most recently reported first. */
export function addressRows(rules: readonly PronounRule[]): PronounRule[] {
  const mine = rules
    .filter((rule) => !isLearnedAddress(rule))
    .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  const learned = rules.filter(isLearnedAddress).sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0));
  return [...mine, ...learned];
}

/** The reader's rule from form fields, or null without both names and at least one form of address. */
export function addressFromDraft(draft: AddressDraft): PronounRule | null {
  const [a, b, aSelf, aToB] = [draft.a, draft.b, draft.aSelf, draft.aToB].map((field) =>
    cleanText(field, MAX_PRONOUN_CHARS),
  );
  if (a === undefined || b === undefined || aSelf === undefined || aToB === undefined) return null;
  if (a === "" || b === "" || (aSelf === "" && aToB === "")) return null;
  return { a, b, aSelf, aToB, source: "manual" };
}

/**
 * The rules with `rule` saved: it replaces the rule of the same pair, or is added. When the list is full the learned
 * rule reported least recently makes room; null when only the reader's rules are left.
 */
export function withAddress(rules: readonly PronounRule[], rule: PronounRule): PronounRule[] | null {
  const key = addressKey(rule);
  const next = rules.filter((other) => addressKey(other) !== key);
  next.push(rule);
  while (next.length > MAX_PRONOUN_RULES) {
    const learned = next.filter(isLearnedAddress).sort((x, y) => (x.updatedAt ?? 0) - (y.updatedAt ?? 0))[0];
    if (learned === undefined) return null;
    next.splice(next.indexOf(learned), 1);
  }
  return next;
}

export function withoutAddress(
  rules: readonly PronounRule[],
  rule: Pick<PronounRule, "a" | "b">,
): PronounRule[] {
  const key = addressKey(rule);
  return rules.filter((other) => addressKey(other) !== key);
}

/** The settings form for a series (defaults while it has no profile yet). */
export function profileDraft(series: SeriesProfile | null): ProfileDraft {
  return {
    lang: series?.lang ?? "auto",
    koNames: series?.style.koNames ?? "romanized",
    keepJaHonorifics: series?.style.keepJaHonorifics ?? false,
    summaryEnabled: series?.summaryEnabled ?? true,
  };
}

/** The en:series-update patch for a saved form; the genre of the stored style is kept. */
export function profilePatch(draft: ProfileDraft, series: SeriesProfile | null): Partial<SeriesProfile> {
  return {
    lang: draft.lang,
    style: {
      genre: series?.style.genre ?? "",
      koNames: draft.koNames,
      keepJaHonorifics: draft.keepJaHonorifics,
    },
    summaryEnabled: draft.summaryEnabled,
  };
}

/** An imported settings patch as en:series-update takes it: a partial style is completed from the current one. */
export function importPatch(patch: SeriesPatch, series: SeriesProfile | null): Partial<SeriesProfile> {
  const { style, ...rest } = patch;
  if (style === undefined) return { ...rest };
  const current = series?.style ?? { genre: "", koNames: "romanized", keepJaHonorifics: false };
  return { ...rest, style: { ...current, ...style } };
}

/** A display title: the profile's, else the slug of the key, else the site. */
export function seriesLabel(seriesKey: string, series: SeriesProfile | null): string {
  const title = series?.title.trim() ?? "";
  if (title !== "") return title;
  const at = seriesKey.indexOf(SERIES_KEY_SEPARATOR);
  const slug = at < 0 ? "" : seriesKey.slice(at + 1);
  return slug !== "" ? slug : at < 0 ? seriesKey : seriesKey.slice(0, at);
}

export function exportGlossary(
  series: SeriesProfile | null,
  entries: readonly GlossaryEntry[],
): GlossaryExport {
  return {
    version: GLOSSARY_EXPORT_VERSION,
    series,
    glossary: groupByState(entries).flatMap((group) =>
      group.entries.map((entry) => ({
        orig: entry.orig,
        translation: entry.translation,
        note: entry.note,
        state: entry.state,
      })),
    ),
  };
}

/** "panelingo-glossary-<series>.json" with a file-system-safe series part. */
export function exportFileName(seriesKey: string, series: SeriesProfile | null): string {
  const name = seriesLabel(seriesKey, series)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return `panelingo-glossary-${name === "" ? "series" : name}.json`;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings a file may carry over to another series (never its key, title, votes or dates). */
const PORTABLE: ReadonlyArray<keyof SeriesPatch> = [
  "lang",
  "readingDir",
  "style",
  "pronouns",
  "summaryEnabled",
  "notes",
];

/** Reads an exported file; null when it is not a glossary export this version understands. */
export function parseGlossaryImport(text: string): GlossaryImport | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlain(data) || !Array.isArray(data["glossary"])) return null;
  const version = data["version"];
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > GLOSSARY_EXPORT_VERSION
  ) {
    return null;
  }
  const edits = new Map<string, GlossaryEdit>();
  let skipped = 0;
  for (const item of data["glossary"] as unknown[]) {
    const edit = isPlain(item) && item["state"] !== "candidate" ? editFromDraft(fields(item)) : null;
    if (edit === null) skipped += 1;
    else edits.set(edit.orig, edit);
  }
  let patch: SeriesPatch | null = null;
  const series = data["series"];
  if (isPlain(series)) {
    const portable = Object.fromEntries(
      PORTABLE.filter((key) => key in series).map((key) => [key, series[key]]),
    );
    patch = sanitizeSeriesPatch(portable);
    if (patch !== null && Object.keys(patch).length === 0) patch = null;
  }
  return { edits: [...edits.values()], patch, skipped };
}

function fields(item: Record<string, unknown>): { orig: string; translation: string; note: string } {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return { orig: text(item["orig"]), translation: text(item["translation"]), note: text(item["note"]) };
}

/** `items` in slices of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
