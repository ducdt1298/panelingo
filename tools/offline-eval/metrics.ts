// Scoring for tools/offline-eval (docs/OFFLINE-MODE.md): OCR character error rate against the fixtures' ground
// truth, chrF of the translations against the parallel reference lines, and the summary tables. Pure functions.
//
// References: test/fixtures/sentences/<lang>.json hold parallel lines (same id across ko/ja/zh/en/es) and a
// Vietnamese reference (`vi`); a unit's English reference is the English line with its id, its Vietnamese one the
// ground truth's `vi`.

import { cer, matchUnits } from "../scoring/score-core.ts";
import type { GtUnitInput } from "../scoring/score-core.ts";
import type { Box, UnitGeometry } from "../../src/shared/types.ts";

export interface SentenceLine {
  id: string;
  text: string;
  vi?: string;
}

export interface GroundTruthUnit {
  id: number;
  kind: "bubble" | "free";
  type: string;
  bubble: Box | null;
  text: Box;
  original: string;
  vi: string | null;
}

/** Whitespace-insensitive key of a line (ground truth joins CJK lines with spaces, the sentence files do not). */
export function lineKey(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "");
}

/** The sentence id of a ground-truth original in its language's sentence file, or null. */
export function sentenceId(original: string, lines: readonly SentenceLine[]): string | null {
  const key = lineKey(original);
  return lines.find((line) => lineKey(line.text) === key)?.id ?? null;
}

/**
 * Sentence-level chrF (Popović 2015, as sacreBLEU computes it): character n-grams of order 1..6 without spaces,
 * precision and recall averaged over the orders, F-beta with beta 2; ×100. Case-insensitive here (the English
 * references are all-capital lettering). Empty hypothesis or reference: 0 (both empty: 100).
 */
export function chrF(hypothesis: string, reference: string, order = 6, beta = 2): number {
  const prep = (text: string): string[] => [...text.normalize("NFC").toLowerCase().replace(/\s+/gu, "")];
  const hyp = prep(hypothesis);
  const ref = prep(reference);
  if (hyp.length === 0 || ref.length === 0) return hyp.length === ref.length ? 100 : 0;
  const grams = (chars: readonly string[], n: number): Map<string, number> => {
    const out = new Map<string, number>();
    for (let i = 0; i + n <= chars.length; i++) {
      const gram = chars.slice(i, i + n).join("");
      out.set(gram, (out.get(gram) ?? 0) + 1);
    }
    return out;
  };
  let precision = 0;
  let recall = 0;
  let orders = 0;
  for (let n = 1; n <= order; n++) {
    const h = grams(hyp, n);
    const r = grams(ref, n);
    const hTotal = [...h.values()].reduce((a, b) => a + b, 0);
    const rTotal = [...r.values()].reduce((a, b) => a + b, 0);
    if (hTotal === 0 || rTotal === 0) continue;
    let match = 0;
    for (const [gram, count] of h) match += Math.min(count, r.get(gram) ?? 0);
    precision += match / hTotal;
    recall += match / rTotal;
    orders += 1;
  }
  if (orders === 0) return 0;
  precision /= orders;
  recall /= orders;
  if (precision + recall === 0) return 0;
  const b2 = beta * beta;
  return (100 * (1 + b2) * precision * recall) / (b2 * precision + recall);
}

/** One engine unit as read from the engine's stores after a run. */
export interface EngineUnit {
  geometry: Pick<UnitGeometry, "unitKey" | "bubble" | "text" | "order">;
  status: string;
  type: string;
  original: string;
  translation: string;
  model: string;
}

export interface UnitRow {
  gtId: number;
  type: string;
  gtOriginal: string;
  /** null when no engine unit matched the ground-truth unit (not detected). */
  ocr: string | null;
  cer: number;
  status: string | null;
  translation: string | null;
  reference: string | null;
  chrF: number | null;
}

/**
 * Pairs ground-truth units with engine units (tools/scoring matchUnits), scores OCR (CER on graphemes, spaces and
 * punctuation ignored, case-folded; an undetected unit counts as CER 1) and the translation (chrF against the
 * reference). Units of type "ignore" (page numbers) are left out.
 */
export function scoreUnits(
  gt: readonly GroundTruthUnit[],
  engine: readonly EngineUnit[],
  reference: (unit: GroundTruthUnit) => string | null,
): UnitRow[] {
  const scored = gt.filter((unit) => unit.type !== "ignore");
  const inputs: GtUnitInput[] = scored.map((unit) => ({
    id: unit.id,
    kind: unit.kind,
    bubble: unit.bubble,
    text: unit.text,
  }));
  const { matches } = matchUnits(
    engine.map((unit) => unit.geometry),
    inputs,
  );
  return scored.map((unit, index) => {
    const match = matches.find((m) => m.gtIndex === index);
    const found = match === undefined ? undefined : engine[match.predIndex];
    const ref = reference(unit);
    const translated = found !== undefined && found.status === "ok" ? found.translation : null;
    return {
      gtId: unit.id,
      type: unit.type,
      gtOriginal: unit.original,
      ocr: found?.original ?? null,
      cer: found === undefined ? 1 : Math.min(1, cer(found.original, unit.original)),
      status: found?.status ?? null,
      translation: found === undefined ? null : found.status === "ok" ? found.translation : found.original,
      reference: ref,
      chrF: ref === null || found === undefined ? null : chrF(translated ?? found.original, ref),
    };
  });
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function fixed(value: number | null, digits = 1): string {
  return value === null ? "–" : value.toFixed(digits);
}

/** A markdown table (cells escaped for "|"). */
export function markdownTable(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const cell = (text: string): string => text.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
  return [
    `| ${header.map(cell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}
