// Text metrics for the quality benchmarks and tests: grapheme CER and Kendall tau.
// Pure functions; Intl.Segmenter needs full ICU, which Node 24 ships.

export interface NormalizeOptions {
  /** Unicode form applied first (default NFC; NFKC also folds full-width and vertical presentation forms). */
  form?: "NFC" | "NFKC";
  /** Remove all whitespace (default true). */
  stripSpace?: boolean;
  /** Remove punctuation and symbols, Unicode P and S (default true). */
  stripPunct?: boolean;
  /** Lower-case (default true; only matters for cased scripts). */
  caseFold?: boolean;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** User-perceived characters: a Hangul syllable, a letter with its combining marks or an emoji is one unit. */
export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

/** Normalisation applied to both sides before CER. */
export function normalizeForCer(text: string, opts: NormalizeOptions = {}): string {
  let s = text.normalize(opts.form ?? "NFC");
  if (opts.stripSpace ?? true) s = s.replace(/\s+/gu, "");
  if (opts.stripPunct ?? true) s = s.replace(/[\p{P}\p{S}]+/gu, "");
  if (opts.caseFold ?? true) s = s.toLowerCase();
  return s;
}

/** Levenshtein distance (unit costs) between two sequences. */
export function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] ?? 0;
}

/**
 * Character error rate of `pred` against `ref`: Levenshtein over graphemes of the normalised strings divided by the
 * reference length. An empty reference gives 0 for an empty prediction, else 1. Can exceed 1.
 */
export function cer(pred: string, ref: string, opts: NormalizeOptions = {}): number {
  const p = graphemes(normalizeForCer(pred, opts));
  const r = graphemes(normalizeForCer(ref, opts));
  if (r.length === 0) return p.length === 0 ? 0 : 1;
  return levenshtein(p, r) / r.length;
}

/**
 * Kendall tau-a between two orderings of ids, over the ids present in both (first occurrence counts):
 * 1 = same order, −1 = reversed. Fewer than two common ids gives 1.
 */
export function kendallTau<T>(a: readonly T[], b: readonly T[]): number {
  const posB = new Map<T, number>();
  b.forEach((id, i) => {
    if (!posB.has(id)) posB.set(id, i);
  });
  const seen = new Set<T>();
  const ranks: number[] = [];
  for (const id of a) {
    const p = posB.get(id);
    if (p === undefined || seen.has(id)) continue;
    seen.add(id);
    ranks.push(p);
  }
  const n = ranks.length;
  if (n < 2) return 1;
  let score = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) score += Math.sign((ranks[j] ?? 0) - (ranks[i] ?? 0));
  }
  return score / ((n * (n - 1)) / 2);
}
