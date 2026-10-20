// Output line grammar of the translation protocol. PURE.
//
//   @lang|<ko|ja|zh|en|other>
//   #<n>|<type>|<speaker>|<original>|<vietnamese>        (split on the first 4 "|", so a "|" inside vi is kept)
//   #<n>|<type>|<vietnamese>                             (fast mode's compact answers; a full record is still read)
//   @term|<original>|<vietnamese>|<note>
//   @sum|<summary>   or   @summary|<summary>
//
// Only lines starting with "#" or "@" are records, after tolerated noise ("- ", "* ", "> ", "• ", "Assistant:").
// <think>…</think> blocks and code-fence lines are skipped (a closing tag without an opening one drops the text before
// it on its line). A short junk line right after an item continues its vi (at most 2 lines; never a separator such as
// "---", a note, a refusal or a malformed record), so an item is committed when the next record arrives, or at the end.

import type { Lang, LineType } from "../types.ts";
import { isRefusalText, scriptStats } from "./refusal.ts";

export interface ItemRec {
  kind: "item";
  id: number;
  type: LineType;
  speaker: string;
  original: string;
  translation: string;
  /** Source line(s) as received; continuation lines are joined with "\n". */
  raw: string;
}
export interface LangRec {
  kind: "lang";
  lang: Lang;
  raw: string;
}
export interface TermRec {
  kind: "term";
  original: string;
  translation: string;
  note: string;
  raw: string;
}
export interface SumRec {
  kind: "sum";
  text: string;
  raw: string;
}
/** @addr|<speaker>|<listener>|<how the speaker refers to themself>|<how the speaker addresses the listener> */
export interface AddrRec {
  kind: "addr";
  a: string;
  b: string;
  aSelf: string;
  aToB: string;
  raw: string;
}
/** Anything else: kept for refusal detection and debug logs. */
export interface JunkRec {
  kind: "junk";
  raw: string;
}
export type Rec = ItemRec | LangRec | TermRec | SumRec | AddrRec | JunkRec;

const TYPE_WORDS: ReadonlyArray<readonly [LineType, readonly string[]]> = [
  ["dialogue", ["dialogue", "dialog", "speech", "talk", "spoken"]],
  ["thought", ["thought", "thoughts", "monologue", "inner", "inner monologue", "inner thought"]],
  ["narration", ["narration", "narrator", "narrative", "caption"]],
  ["sign", ["sign", "signs", "text", "screen", "label", "message"]],
  ["sfx", ["sfx", "sound", "sounds", "sound effect", "sound effects", "onomatopoeia"]],
  [
    "ignore",
    ["ignore", "ignored", "skip", "none", "watermark", "credit", "credits", "url", "page number", "no text"],
  ],
];
const TYPE_MAP: ReadonlyMap<string, LineType> = new Map(
  TYPE_WORDS.flatMap(([type, words]) => words.map((word) => [word, type] as const)),
);

const LANG_WORDS: ReadonlyArray<readonly [Lang, readonly string[]]> = [
  ["ko", ["ko", "kr", "kor", "korean", "ko-kr", "한국어"]],
  ["ja", ["ja", "jp", "jpn", "japanese", "ja-jp", "日本語"]],
  [
    "zh",
    ["zh", "cn", "zho", "chi", "chinese", "zh-cn", "zh-tw", "zh-hk", "zh-hans", "zh-hant", "中文", "中国语"],
  ],
  ["en", ["en", "eng", "english", "en-us", "en-gb"]],
  ["es", ["es", "spa", "spanish", "español", "espanol", "es-es", "es-419", "es-mx"]],
  ["other", ["other", "unknown"]],
];
const LANG_MAP: ReadonlyMap<string, Lang> = new Map(
  LANG_WORDS.flatMap(([lang, words]) => words.map((word) => [word, lang] as const)),
);

const LEADING_INVISIBLE = /^[\ufeff\u200b-\u200d\u2060]+/u;
const TOLERATED_PREFIX = /^\s*(?:[-*>•]\s*)?(?:assistant\s*:\s*)?/iu;
const ITEM_HEAD = /^#\s*(\d{1,3})\s*$/u;
const CONTROL_HEAD = /^@\s*(lang|language|term|sum|summary|addr|address)\s*$/iu;
const FENCE = /^\s*(?:```|~~~)/u;
const THINK_OPEN = /<think(?:ing)?>/iu;
const THINK_CLOSE = /<\/think(?:ing)?>/iu;
const NOTE_LIKE = /^\s*[([*_]*\s*(?:notes?|lưu ý|chú thích|ghi chú|explanation|giải thích)(?![\p{L}\p{N}])/iu;
const NON_ASCII_LETTER = /[^\P{L}a-zA-Z]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** An item record inside a line ("1. #2|…", "`#2|…`", "</think>#2|…"): a malformed record, never prose. */
const EMBEDDED_ITEM = /[#＃]\s*[0-9０-９]{1,3}\s*[|｜]/u;

/**
 * Type word → LineType, with synonyms; a decorated type ("sfx (sound)", "narration box", "sign/label",
 * "ignore (watermark)") is read by its first word; unknown words become "dialogue".
 */
export function normalizeType(word: string): LineType {
  const key = word
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, " ");
  const exact = TYPE_MAP.get(key);
  if (exact !== undefined) {
    return exact;
  }
  const head = /^\p{L}+/u.exec(key)?.[0];
  return (head === undefined ? undefined : TYPE_MAP.get(head)) ?? "dialogue";
}

/** Language code or name → Lang ("other" for unrecognised values, null when empty). */
export function normalizeLang(value: string): Lang | null {
  const token =
    value
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/_/gu, "-")
      .split(/[\s,;:()|/[\]]+/u)
      .find((part) => part !== "") ?? "";
  if (token === "") {
    return null;
  }
  return LANG_MAP.get(token) ?? "other";
}

function stripNoise(line: string): string {
  return line.replace(LEADING_INVISIBLE, "").replace(TOLERATED_PREFIX, "");
}

/** Index of the first "|" or full-width "｜", or -1. */
function firstSeparator(text: string, extra = ""): number {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "|" || ch === "\uff5c" || (extra !== "" && ch !== undefined && extra.includes(ch))) {
      return i;
    }
  }
  return -1;
}

/** Splits on the first `maxSplits` occurrences of `sep`; the last part keeps any further separators. */
function splitFirst(text: string, sep: string, maxSplits: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (parts.length < maxSplits) {
    const i = text.indexOf(sep, start);
    if (i < 0) {
      break;
    }
    parts.push(text.slice(start, i));
    start = i + sep.length;
  }
  parts.push(text.slice(start));
  return parts;
}

/** Field separator for the rest of a record: "|", or "｜" when the model used only full-width bars. */
function fieldSeparator(rest: string): string {
  return !rest.includes("|") && rest.includes("\uff5c") ? "\uff5c" : "|";
}

function looksLatin(text: string): boolean {
  const { letters, latin } = scriptStats(text);
  return letters > 0 && latin * 2 >= letters;
}

function parseItem(text: string, raw: string, compact: boolean): ItemRec | null {
  const sep = firstSeparator(text);
  if (sep < 0) {
    return null;
  }
  const head = ITEM_HEAD.exec(text.slice(0, sep).normalize("NFKC"));
  if (head === null) {
    return null;
  }
  const id = Number.parseInt(head[1] ?? "", 10);
  const rest = text.slice(sep + 1);
  const fields = splitFirst(rest, fieldSeparator(rest), 3).map((field) => field.trim().normalize("NFC"));
  if (compact && fields.length < 4) {
    // "#n|type|translation": everything after the type is the translation (a "|" inside it is kept).
    const [type = "", translation = ""] = splitFirst(rest, fieldSeparator(rest), 1).map((field) =>
      field.trim().normalize("NFC"),
    );
    return { kind: "item", id, type: normalizeType(type), speaker: "", original: "", translation, raw };
  }
  const type = fields[0] ?? "";
  let speaker = fields[1] ?? "";
  let original = fields[2] ?? "";
  let vi = fields[3] ?? "";
  if (fields.length === 3 && looksLatin(original) && !looksLatin(speaker)) {
    // "#n|type|original|vi": the speaker was left out (the last field is Vietnamese, the one before it is not).
    vi = original;
    original = speaker;
    speaker = "";
  }
  return { kind: "item", id, type: normalizeType(type), speaker, original, translation: vi, raw };
}

function parseControl(text: string, raw: string): LangRec | TermRec | SumRec | AddrRec | null {
  const sep = firstSeparator(text, ":\uff1a");
  if (sep < 0) {
    return null;
  }
  const head = CONTROL_HEAD.exec(text.slice(0, sep).normalize("NFKC"));
  if (head === null) {
    return null;
  }
  const key = (head[1] ?? "").toLowerCase();
  const body = text.slice(sep + 1);
  if (key === "lang" || key === "language") {
    const lang = normalizeLang(body);
    return lang === null ? null : { kind: "lang", lang, raw };
  }
  if (key === "term") {
    const [original = "", vi = "", note = ""] = splitFirst(body, fieldSeparator(body), 2).map((field) =>
      field.trim().normalize("NFC"),
    );
    return { kind: "term", original, translation: vi, note, raw };
  }
  if (key === "addr" || key === "address") {
    const [a = "", b = "", aSelf = "", aToB = ""] = splitFirst(body, fieldSeparator(body), 3).map((field) =>
      field.trim().normalize("NFC"),
    );
    return { kind: "addr", a, b, aSelf, aToB, raw };
  }
  return { kind: "sum", text: body.trim().normalize("NFC"), raw };
}

/**
 * Parses one complete line (no line break). Stateless: think blocks, fences and continuations need the parser.
 * compact: item records are fast mode's #n|type|translation (full records are still read as such).
 */
export function parseLine(line: string, compact = false): Rec {
  const text = stripNoise(line);
  const first = text.charAt(0);
  if (first === "#" || first === "\uff03") {
    const item = parseItem(text, line, compact);
    if (item !== null) {
      return item;
    }
  } else if (first === "@" || first === "\uff20") {
    const control = parseControl(first === "@" ? text : `@${text.slice(1)}`, line);
    if (control !== null) {
      return control;
    }
  }
  return { kind: "junk", raw: line };
}

export interface LineSplitter {
  /** Feeds streamed text; every complete line (LF or CRLF) goes to onLine without its terminator. */
  push(text: string): void;
  /** The unterminated text so far (not consumed). */
  tail(): string;
  /** Returns the unterminated tail and resets. The caller decides whether to trust it. */
  end(): string;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let buffer = "";
  return {
    push(text: string): void {
      buffer += text;
      let start = 0;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n", start)) {
        const line = stripCr(buffer.slice(start, i));
        start = i + 1;
        onLine(line);
      }
      if (start > 0) {
        buffer = buffer.slice(start);
      }
    },
    tail: (): string => stripCr(buffer),
    end(): string {
      const rest = stripCr(buffer);
      buffer = "";
      return rest;
    },
  };
}

export interface LineParser {
  /** One complete content line (from createLineSplitter). */
  push(line: string): void;
  /** End of the output: commits the pending item. */
  end(): void;
}

export const MAX_CONTINUATION_LINES = 2;
export const MAX_CONTINUATION_CHARS = 200;

function asciiWordCount(text: string): number {
  return text.split(/\s+/u).filter((word) => /[a-z]/iu.test(word)).length;
}

/** Can `line` (a junk line) continue the vi of `item`? */
function isContinuation(line: string, item: ItemRec): boolean {
  const text = line.normalize("NFC").trim();
  if (text === "" || item.type === "ignore" || [...text].length > MAX_CONTINUATION_CHARS) {
    return false;
  }
  if (!LETTER_OR_DIGIT.test(text)) {
    return false; // a separator such as "---" or "***", never part of a translation
  }
  const first = stripNoise(text).charAt(0);
  if (
    first === "#" ||
    first === "@" ||
    first === "\uff03" ||
    first === "\uff20" ||
    EMBEDDED_ITEM.test(text)
  ) {
    return false; // a malformed record, not prose
  }
  if (NOTE_LIKE.test(text) || isRefusalText(text)) {
    return false;
  }
  // English chatter after a Vietnamese line ("Hope this helps!") is not part of the translation.
  if (NON_ASCII_LETTER.test(item.translation) && !NON_ASCII_LETTER.test(text) && asciiWordCount(text) >= 3) {
    return false;
  }
  return true;
}

export function createLineParser(onRec: (rec: Rec) => void, options: { compact?: boolean } = {}): LineParser {
  const compact = options.compact === true;
  let inThink = false;
  let pending: ItemRec | null = null;
  let continuations = 0;

  const commit = (): void => {
    if (pending !== null) {
      const item = pending;
      pending = null;
      continuations = 0;
      onRec(item);
    }
  };

  const take = (line: string): void => {
    if (line.trim() === "" || FENCE.test(line)) {
      commit();
      return;
    }
    const rec = parseLine(line, compact);
    if (rec.kind === "junk") {
      if (pending !== null && continuations < MAX_CONTINUATION_LINES && isContinuation(line, pending)) {
        const text = line.trim().normalize("NFC");
        pending = {
          ...pending,
          translation: pending.translation === "" ? text : `${pending.translation} ${text}`,
          raw: `${pending.raw}\n${line}`,
        };
        continuations += 1;
        if (continuations >= MAX_CONTINUATION_LINES) {
          commit();
        }
        return;
      }
      commit();
      onRec(rec);
      return;
    }
    commit();
    if (rec.kind === "item") {
      pending = rec;
      continuations = 0;
      return;
    }
    onRec(rec);
  };

  return {
    push(line: string): void {
      let text = line;
      for (;;) {
        if (inThink) {
          const close = THINK_CLOSE.exec(text);
          if (close === null) {
            return;
          }
          inThink = false;
          text = text.slice(close.index + close[0].length);
          if (text.trim() === "") {
            return;
          }
          continue;
        }
        const open = THINK_OPEN.exec(text);
        const close = THINK_CLOSE.exec(text);
        if (close !== null && (open === null || close.index < open.index)) {
          // A closing tag whose opening tag never came (it may be stripped upstream): the text before it on this
          // line is reasoning, not output.
          commit();
          text = text.slice(close.index + close[0].length);
          if (text.trim() === "") {
            return;
          }
          continue;
        }
        if (open === null) {
          take(text);
          return;
        }
        const before = text.slice(0, open.index);
        if (before.trim() !== "") {
          take(before);
        }
        commit();
        inThink = true;
        text = text.slice(open.index + open[0].length);
      }
    },
    end(): void {
      commit();
      inThink = false;
    },
  };
}
