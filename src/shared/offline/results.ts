// What the offline engine reports per unit (docs/OFFLINE-MODE.md): the line type guessed from the geometry (no model
// reads the panel), and the outcome of a translation. PURE.

import type { LineType, UnitGeometry } from "../types.ts";

/** Free text whose glyphs are this many times the page's median is a sound effect. */
export const SFX_GLYPH_RATIO = 2;

/** Median glyph height of the units (the page's dialogue size). */
export function medianGlyph(units: readonly Pick<UnitGeometry, "glyphPx">[]): number {
  const sizes = units.map((unit) => unit.glyphPx).sort((a, b) => a - b);
  if (sizes.length === 0) return 0;
  const mid = Math.floor(sizes.length / 2);
  return sizes.length % 2 === 1 ? (sizes[mid] ?? 0) : ((sizes[mid - 1] ?? 0) + (sizes[mid] ?? 0)) / 2;
}

/**
 * Line type from the detector's geometry: page numbers and watermarks at the edge are ignored, text in a balloon is
 * dialogue, free text with very large glyphs a sound effect, other free text narration.
 */
export function guessLineType(
  unit: Pick<UnitGeometry, "kind" | "glyphPx" | "edgeSmall">,
  median: number,
): LineType {
  if (unit.edgeSmall === true) return "ignore";
  if (unit.kind === "bubble") return "dialogue";
  return median > 0 && unit.glyphPx >= SFX_GLYPH_RATIO * median ? "sfx" : "narration";
}

/**
 * Onomatopoeia and mimetic words written as one short chunk repeated ("두근두근", "ドキドキ", "ゴゴゴ", "HAHAHA"):
 * 3 to 8 letters, a chunk of 1 to 3 letters. Two letters are not enough ("똑똑" knock-knock, but also "谢谢" thanks).
 */
export function isRepeatedChunk(text: string): boolean {
  const letters = Array.from(
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}]/gu, ""),
  );
  if (letters.length < 3 || letters.length > 8) return false;
  for (let size = 1; size <= 3; size++) {
    if (letters.length % size !== 0 || letters.length / size < 2) continue;
    if (letters.every((letter, i) => letter === letters[i % size])) return true;
  }
  return false;
}

/** Letters of any script (text made only of digits and punctuation is never translated). */
export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

function comparable(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "");
}

export type OfflineOutcome = "ok" | "keep-original" | "untranslated";

/** A translation identical to its source (apart from case, spaces and punctuation) keeps the original lettering. */
export function translationOutcome(original: string, translation: string): OfflineOutcome {
  if (translation.trim() === "") return "untranslated";
  if (!hasLetters(original) || comparable(translation) === comparable(original)) return "keep-original";
  return "ok";
}
