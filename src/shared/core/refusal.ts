// Refusal, content-filter and wrong-script detection for model output. PURE.
//
// Two strengths of refusal matching:
// - isRefusalText(): all the patterns. Used on junk lines when a pack produced no item at all (pack-level refusal),
//   where any match is conclusive because nothing in the reply is a translation.
// - isItemRefusal(): used on one translation. A character may legitimately say "Xin lỗi, tôi không thể giúp cậu"
//   ("Sorry, I can't help you"), so the Vietnamese "I cannot help" phrases only count when the text also talks about
//   the request, the content or the AI; "tôi không thể dịch" (I cannot translate) and the English phrases always count.
// The patterns are best guesses; extend them as real refusals are observed.

const EN_REFUSAL: readonly RegExp[] = [
  /\bI(?:['’]?m| am) sorry\b/iu,
  // "I can't", "I cannot", "I am unable to", "I'm unable to", "I'm not able to", "I won't be able to" + the task verb.
  /\bI(?: can(?:not|['’]t| not)|(?:['’]m| am) (?:unable|not able) to| won['’]t be able to) (?:help|assist|translate|comply|provide|process|fulfil)/iu,
  /\bas an AI\b/iu,
  /\bAI language model\b/iu,
  /\bcontent (?:policy|filter)/iu,
];

const VI_REFUSAL: readonly RegExp[] = [
  /xin lỗi,?\s+(?:nhưng\s+)?tôi không thể/iu,
  /tôi không thể\s+(?:hỗ trợ|giúp|dịch)/iu,
];

const VI_CANNOT_TRANSLATE = /tôi không thể\s+dịch/iu;
/** Words a refusal uses to talk about the task rather than the story. */
const VI_META = /yêu cầu|nội dung|hình ảnh|văn bản|chính sách|trợ lý/iu;
/** Case-sensitive: lower-case "ai" is the Vietnamese word for "who". */
const VI_META_AI = /\bAI\b/u;

/**
 * Upstream content-filter markers: Azure OpenAI's content management policy, OpenRouter moderation ("Your input was
 * flagged", "requires moderation"), Gemini safety blocks.
 */
const CONTENT_FILTER =
  /content[_\s-]?filter|ResponsibleAIPolicyViolation|content management policy|input was flagged|flagged_input|requires moderation|PROHIBITED_CONTENT|blocked (?:due to|by) safety/iu;

const LETTER = /\p{L}/u;
const CJK_LETTER = /[\p{sc=Hangul}\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;
const LATIN_LETTER = /\p{sc=Latin}/u;

/** Refusal patterns (English and Vietnamese) or a content-filter marker anywhere in `text`. */
export function isRefusalText(text: string): boolean {
  const t = text.normalize("NFC");
  return EN_REFUSAL.some((re) => re.test(t)) || VI_REFUSAL.some((re) => re.test(t)) || CONTENT_FILTER.test(t);
}

/** Stricter check for a single translation (see the file header). */
export function isItemRefusal(text: string): boolean {
  const t = text.normalize("NFC");
  if (EN_REFUSAL.some((re) => re.test(t)) || CONTENT_FILTER.test(t) || VI_CANNOT_TRANSLATE.test(t)) {
    return true;
  }
  return VI_REFUSAL.some((re) => re.test(t)) && (VI_META.test(t) || VI_META_AI.test(t));
}

/** True when an upstream error message (or code/type) names a content filter or responsible-AI block. */
export function isContentFilterMessage(text: string): boolean {
  return CONTENT_FILTER.test(text);
}

export interface ScriptStats {
  /** Letters (\p{L}). */
  letters: number;
  /** Hangul, Han, Hiragana and Katakana letters. */
  cjk: number;
  /** Latin-script letters, including every Vietnamese letter. */
  latin: number;
}

export function scriptStats(text: string): ScriptStats {
  const stats: ScriptStats = { letters: 0, cjk: 0, latin: 0 };
  for (const ch of text) {
    if (!LETTER.test(ch)) {
      continue;
    }
    stats.letters += 1;
    if (CJK_LETTER.test(ch)) {
      stats.cjk += 1;
    } else if (LATIN_LETTER.test(ch)) {
      stats.latin += 1;
    }
  }
  return stats;
}

/** True when `text` contains at least one letter. */
export function hasLetter(text: string): boolean {
  return LETTER.test(text);
}

const HANGUL = /\p{sc=Hangul}/u;
const KANA = /[\p{sc=Hiragana}\p{sc=Katakana}]/u;

/** Letters of `text` in `script` (a regex of one character). */
function countLetters(text: string, script: RegExp): number {
  let count = 0;
  for (const ch of text) if (script.test(ch)) count += 1;
  return count;
}

/**
 * Letters that do not belong in a translation into `target` (a TARGET_LANGUAGES code): for Latin-script targets
 * Hangul, Han and Kana; for Japanese Hangul; for Chinese Hangul and Kana; for Korean Kana (Han stays allowed in
 * Japanese and Korean text, Latin in every target: names, "OK", units).
 */
function foreignLetters(text: string, target: string): number {
  switch (target) {
    case "ja":
      return countLetters(text, HANGUL);
    case "zh-cn":
    case "zh-tw":
      return countLetters(text, HANGUL) + countLetters(text, KANA);
    case "ko":
      return countLetters(text, KANA);
    default:
      return scriptStats(text).cjk;
  }
}

/**
 * Wrong script for a translation into `target` (default Vietnamese): letters of a script the target does not use
 * (foreignLetters) make up more than 20% of the letters, or more than 3 of them appear. A short annotation such as
 * "Lâm Phong (林枫)" passes; a correct Japanese, Chinese or Korean translation is never "wrong" for its own target.
 */
export function isWrongScript(text: string, target = "vi"): boolean {
  const { letters } = scriptStats(text);
  const foreign = foreignLetters(text, target);
  return foreign > 3 || (letters > 0 && foreign / letters > 0.2);
}
