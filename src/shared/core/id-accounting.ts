// Id accounting and per-line validation for one request. PURE.
//
// Checks, in this order:
//   id outside 1..N → ignored (unknown) · id already seen → first wins (duplicate) · type ignore → ignore ·
//   vi empty → missing(empty) · vi without letters → keep-original if the original has none either, else
//   missing(no-letters) · vi equals the original after NFKC + casefold + removing punctuation and spaces →
//   keep-original (a resolved outcome: not drawn, not erased, never re-asked) · letters of a script the target does
//   not use (Hangul/Han/Kana for Latin targets, Hangul for Japanese, …; refusal.ts isWrongScript) > 20% of letters or
//   > 3 → missing(wrong-script) · refusal text → missing(refusal) · otherwise ok.
// An echo of the original is keep-original in every script, so a Korean/Japanese/Chinese echo is not re-asked.
// At finish(): an ok vi longer than max(60, 4 × original) whose next id is missing is flagged suspect-merge.

import type { Lang } from "../types.ts";
import type { ItemRec, Rec } from "./line-parser.ts";
import { hasLetter, isContentFilterMessage, isItemRefusal, isRefusalText, isWrongScript } from "./refusal.ts";

export type MissingReason = "absent" | "empty" | "no-letters" | "wrong-script" | "refusal";

export type Outcome =
  | { status: "ok"; rec: ItemRec; suspect?: "merge" }
  | { status: "keep-original"; rec: ItemRec }
  | { status: "ignore"; rec: ItemRec }
  | { status: "missing"; reason: MissingReason; rec?: ItemRec };

export interface Term {
  original: string;
  translation: string;
  note: string;
}

export interface PackOutcome {
  /** Number of ids asked for (labels 1..n). */
  n: number;
  /** Final outcome of every id 1..n (absent ids are missing/absent). */
  byId: ReadonlyMap<number, Outcome>;
  /** Unresolved ids, ascending. */
  missing: number[];
  /** ok ids flagged suspect-merge (their next id is missing), ascending. */
  suspects: number[];
  /** In-range ids that appeared more than once (first occurrence kept). */
  duplicates: number[];
  /** Ids outside 1..n that appeared. */
  unknown: number[];
  /** In-range item records accepted (first occurrences). */
  received: number;
  /** Lines that were not records (and not continuations). */
  junkLines: number;
  /** Whole-pack refusal: no item at all and refusal text in the junk, or a content-filter upstream error. */
  refusal: boolean;
  /** The stream ended without [DONE]. */
  truncated: boolean;
  /** [DONE] arrived but ids are missing (api.partial). */
  partial: boolean;
  /** Source language: the model's @lang, else the caller's srcLang, else null. */
  lang: Lang | null;
  /** True when `lang` came from an @lang line (only these should vote). */
  langReported: boolean;
  terms: Term[];
  summary: string | null;
  /** Resolved ids (ok, keep-original, ignore) / n. */
  idCoverage: number;
}

export interface FinishOptions {
  /** Message of an upstream error (HTTP body or in-stream error frame) that ended the request, if any. */
  upstreamError?: string | null | undefined;
}

export interface Accountant {
  /** Records one parsed record. Returns the item's outcome, or null for non-items, duplicates and unknown ids. */
  accept(rec: Rec): Outcome | null;
  /** Closes the request. `junkLines` are extra junk lines the caller collected elsewhere (optional). */
  finish(sawDone: boolean, junkLines?: readonly string[], options?: FinishOptions): PackOutcome;
}

export const MERGE_MIN_CHARS = 60;
export const MERGE_RATIO = 4;
export const MAX_TERMS = 10;
export const MAX_SUMMARY_CHARS = 1_000;

const STRIP_FOR_COMPARE = /[\p{P}\p{S}\p{Z}\p{C}\s]+/gu;

/** NFKC + lower case + no punctuation, symbols, spaces or control characters (the keep-original comparison key). */
export function compareKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(STRIP_FOR_COMPARE, "");
}

/** Validates one item line on its own (no id bookkeeping); `target` is the TARGET_LANGUAGES code (default "vi"). */
export function judgeItem(rec: ItemRec, target?: string): Outcome {
  if (rec.type === "ignore") {
    return { status: "ignore", rec };
  }
  const vi = rec.translation.trim();
  if (vi === "") {
    return { status: "missing", reason: "empty", rec };
  }
  if (!hasLetter(vi)) {
    return hasLetter(rec.original)
      ? { status: "missing", reason: "no-letters", rec }
      : { status: "keep-original", rec };
  }
  if (compareKey(vi) === compareKey(rec.original)) {
    return { status: "keep-original", rec };
  }
  if (isWrongScript(vi, target)) {
    return { status: "missing", reason: "wrong-script", rec };
  }
  if (isItemRefusal(vi)) {
    return { status: "missing", reason: "refusal", rec };
  }
  return { status: "ok", rec };
}

function charCount(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/** An ok line longer than max(60, 4 × original) characters: maybe two lines merged into one id (suspect-merge). */
export function isMergeSuspect(rec: ItemRec): boolean {
  return charCount(rec.translation) > Math.max(MERGE_MIN_CHARS, MERGE_RATIO * charCount(rec.original));
}

function sorted(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

/**
 * Accounting for one request asking for ids 1..n. `srcLang` is the language the caller assumed, if known; `target`
 * the language translated into (the wrong-script check depends on it).
 */
export function createAccountant(n: number, srcLang?: Lang | "auto" | null, target?: string): Accountant {
  const size = Math.max(0, Math.floor(n));
  const outcomes = new Map<number, Outcome>();
  const duplicates = new Set<number>();
  const unknown = new Set<number>();
  const junk: string[] = [];
  const terms: Term[] = [];
  const termKeys = new Set<string>();
  let reportedLang: Lang | null = null;
  let summary: string | null = null;

  return {
    accept(rec: Rec): Outcome | null {
      switch (rec.kind) {
        case "item": {
          if (!Number.isInteger(rec.id) || rec.id < 1 || rec.id > size) {
            unknown.add(rec.id);
            return null;
          }
          if (outcomes.has(rec.id)) {
            duplicates.add(rec.id);
            return null;
          }
          const outcome = judgeItem(rec, target);
          outcomes.set(rec.id, outcome);
          return outcome;
        }
        case "lang":
          reportedLang ??= rec.lang;
          return null;
        case "term": {
          const key = compareKey(rec.original);
          if (
            rec.original !== "" &&
            rec.translation !== "" &&
            key !== "" &&
            !termKeys.has(key) &&
            terms.length < MAX_TERMS
          ) {
            termKeys.add(key);
            terms.push({ original: rec.original, translation: rec.translation, note: rec.note });
          }
          return null;
        }
        case "sum":
          if (rec.text !== "") {
            summary = rec.text.slice(0, MAX_SUMMARY_CHARS);
          }
          return null;
        case "junk":
          junk.push(rec.raw);
          return null;
      }
    },

    finish(sawDone: boolean, junkLines: readonly string[] = [], options: FinishOptions = {}): PackOutcome {
      const byId = new Map<number, Outcome>();
      for (let id = 1; id <= size; id += 1) {
        byId.set(id, outcomes.get(id) ?? { status: "missing", reason: "absent" });
      }
      const suspects: number[] = [];
      for (let id = 1; id < size; id += 1) {
        const outcome = byId.get(id);
        if (
          outcome?.status === "ok" &&
          byId.get(id + 1)?.status === "missing" &&
          isMergeSuspect(outcome.rec)
        ) {
          byId.set(id, { status: "ok", rec: outcome.rec, suspect: "merge" });
          suspects.push(id);
        }
      }
      const missing: number[] = [];
      for (const [id, outcome] of byId) {
        if (outcome.status === "missing") {
          missing.push(id);
        }
      }
      const allJunk = junkLines.length === 0 ? junk : [...junk, ...junkLines];
      const upstream = options.upstreamError ?? null;
      const refusal =
        (outcomes.size === 0 && allJunk.some((line) => isRefusalText(line))) ||
        (upstream !== null && isContentFilterMessage(upstream));
      const fallbackLang = srcLang === undefined || srcLang === null || srcLang === "auto" ? null : srcLang;
      return {
        n: size,
        byId,
        missing,
        suspects,
        duplicates: sorted(duplicates),
        unknown: sorted(unknown),
        received: outcomes.size,
        junkLines: allJunk.length,
        refusal,
        truncated: !sawDone,
        partial: sawDone && missing.length > 0,
        lang: reportedLang ?? fallbackLang,
        langReported: reportedLang !== null,
        terms: [...terms],
        summary,
        idCoverage: size === 0 ? 1 : (size - missing.length) / size,
      };
    },
  };
}
