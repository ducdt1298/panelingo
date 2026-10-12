// Rough token estimate for prompt budgets. PURE.
// Latin text ≈ 4 characters per token, Vietnamese ≈ 3 (diacritics split words into more tokens), CJK ≈ 1 per character.

const CJK_CHAR = /[\p{sc=Han}\p{sc=Hangul}\p{sc=Hiragana}\p{sc=Katakana}\u3000-\u303f\uff00-\uffef]/u;
/** Latin letters with diacritics (Latin-1 Supplement, Extended-A/B, Extended Additional: every Vietnamese letter). */
const MARKED_LATIN = /[\u00c0-\u024f\u1e00-\u1eff]/u;
/** A line counts as Vietnamese when at least this share of its Latin words carries a diacritic. */
const VIETNAMESE_WORD_SHARE = 0.25;

/**
 * Estimated token count of `text`. Lines are classified separately, so an English template line and a Vietnamese
 * history line in the same prompt each get their own ratio. Deterministic; always ≥ 0.
 */
export function estimateTokens(text: string): number {
  if (text === "") {
    return 0;
  }
  let total = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    let cjk = 0;
    let other = 0;
    let words = 0;
    let marked = 0;
    for (const word of line.split(/(\s+)/u)) {
      if (word === "") {
        continue;
      }
      let latinChars = 0;
      for (const ch of word) {
        if (CJK_CHAR.test(ch)) {
          cjk += 1;
        } else {
          latinChars += 1;
        }
      }
      other += latinChars;
      if (latinChars > 0 && /\S/u.test(word)) {
        words += 1;
        if (MARKED_LATIN.test(word)) {
          marked += 1;
        }
      }
    }
    const vietnamese = words > 0 && marked / words >= VIETNAMESE_WORD_SHARE;
    total += cjk + other / (vietnamese ? 3 : 4);
  }
  // Line breaks count like Latin characters.
  total += (lines.length - 1) / 4;
  return Math.ceil(total);
}
