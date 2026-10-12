// Strict reader of the AI output line protocol (`@lang|…`, `#n|type|speaker|original|translation`, `@term|…`,
// `@sum|…`) for formatCompliance scoring.
// Deliberately stricter than the production line-parser, which tolerates bullets, prefixes and synonyms: this
// measures how well a model follows the format, not how much the product can recover.

import type { LineType } from "../../src/shared/types.ts";

export type OutputRecord =
  | { kind: "item"; n: number; type: LineType; speaker: string; original: string; translation: string }
  | { kind: "lang"; lang: string }
  | { kind: "term"; original: string; translation: string; note: string }
  | { kind: "sum"; text: string };

// `#n|type|speaker|original|translation`: the translation is the last field, so a stray "|" there still parses.
const ITEM = /^#(\d+)\|(dialogue|thought|narration|sign|sfx|ignore)\|([^|]*)\|([^|]*)\|(.*)$/u;
const LANG = /^@lang\|([a-z]{2,5})$/u;
// `@term|original|translation|note`; the note may be missing.
const TERM = /^@term\|([^|]+)\|([^|]+)(?:\|(.*))?$/u;
const SUM = /^@sum\|(.+)$/u;

/** Parses one output line (surrounding whitespace ignored); null when it is not a well-formed record. */
export function parseRecordLine(line: string): OutputRecord | null {
  const s = line.trim();
  let m = ITEM.exec(s);
  if (m !== null) {
    return {
      kind: "item",
      n: Number.parseInt(m[1] ?? "", 10),
      type: (m[2] ?? "dialogue") as LineType,
      speaker: (m[3] ?? "").trim(),
      original: (m[4] ?? "").trim(),
      translation: (m[5] ?? "").trim(),
    };
  }
  m = LANG.exec(s);
  if (m !== null) return { kind: "lang", lang: m[1] ?? "" };
  m = TERM.exec(s);
  if (m !== null) {
    return {
      kind: "term",
      original: (m[1] ?? "").trim(),
      translation: (m[2] ?? "").trim(),
      note: (m[3] ?? "").trim(),
    };
  }
  m = SUM.exec(s);
  if (m !== null) return { kind: "sum", text: (m[1] ?? "").trim() };
  return null;
}

/** Splits a model reply into lines (LF or CRLF). */
export function outputLines(output: string): string[] {
  return output.split(/\r?\n/u);
}
