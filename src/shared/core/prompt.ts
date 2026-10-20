// Chat messages for one translation request (docs/ARCHITECTURE.md "Prompt"). PURE.
//
// Exactly [system, user{text, image_url}]: no history images, no assistant prefill, no tools, so any
// OpenAI-compatible vision endpoint accepts it. The system text depends only on the target language and the series
// (source language, style, glossary, forms of address) and askSummary; everything that changes per pack (summary,
// history, N, crops-only) is in the user text. Rules that only make sense for one target language (Vietnamese
// pronouns, Sino-Vietnamese readings) are added only for that language; CJK targets (Japanese, Chinese, Korean) drop
// the rules about capitals, spell names in their own script, and keep a source already in their language.
// Limits: glossary ≤ 60 entries (manual first, ~900 tokens), forms of address ≤ 10 lines, history ≤ 20 lines with
// originals cut to 60 characters and ~700 tokens (oldest dropped first), summary ≤ 60 words, and a total text cap of
// ~16,000 characters (history trimmed first, then learned glossary entries).

import type { Lang, PronounRule } from "../types.ts";
import { estimateTokens } from "./tokens.ts";

export interface GlossaryEntry {
  original: string;
  translation: string;
  note?: string;
  source: "manual" | "confirmed" | "learned";
}

export interface HistoryLine {
  /** Page-order position (history is passed oldest first). */
  pos: number;
  speaker: string;
  original: string;
  translation: string;
}

export interface StyleProfile {
  genre?: string;
  koNames: "romanized" | "han-viet";
  keepJaHonorifics: boolean;
}

/** The language the translation is written in (src/shared/languages.ts). */
export interface PromptTarget {
  code: string;
  /** English name used in the instructions, e.g. "Vietnamese". */
  name: string;
}

export const VIETNAMESE: PromptTarget = { code: "vi", name: "Vietnamese" };

/** Targets written without letter case (and without the Latin rules about capitals). */
const CJK_TARGETS: ReadonlySet<string> = new Set(["ja", "zh-cn", "zh-tw", "ko"]);

export function isCjkPromptTarget(target: PromptTarget): boolean {
  return CJK_TARGETS.has(target.code);
}

export interface PromptInput {
  /** Language to translate into (default Vietnamese). */
  target?: PromptTarget;
  /** Series language; "auto" (and "other") send every source-language block, Korean first. */
  lang: Lang | "auto";
  /** Number of regions in the image (labels 1..n). */
  n: number;
  mode: "full" | "crops-only";
  style: StyleProfile;
  /** In rank order within each source (selectForPrompt order); manual and confirmed entries are kept first. */
  glossary: readonly GlossaryEntry[];
  /** Oldest first. */
  pronouns: readonly PronounRule[];
  summary?: string | null | undefined;
  /** Validated lines before this pack, page order, oldest first. */
  history: readonly HistoryLine[];
  /** Ask for an @sum line at the end. */
  askSummary: boolean;
}

export interface SystemMessage {
  role: "system";
  content: string;
}
export type UserContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface UserMessage {
  role: "user";
  content: UserContentPart[];
}
export type ChatMessage = SystemMessage | UserMessage;

export interface PromptLimits {
  glossaryEntries: number;
  glossaryTokens: number;
  pronounLines: number;
  pronounTokens: number;
  historyLines: number;
  historyTokens: number;
  historyOriginalChars: number;
  summaryWords: number;
  maxTextChars: number;
}

export const PROMPT_LIMITS: Readonly<PromptLimits> = Object.freeze({
  glossaryEntries: 60,
  glossaryTokens: 900,
  pronounLines: 10,
  pronounTokens: 150,
  historyLines: 20,
  historyTokens: 700,
  historyOriginalChars: 60,
  summaryWords: 60,
  maxTextChars: 16_000,
});

// ---- Template ----

export function systemIntro(target: PromptTarget): string {
  return `You are an expert comic translator. You translate comic text into natural, spoken ${target.name} for a reader who reads the comic in a web browser.`;
}

export const SYSTEM_INPUT = [
  "# Input",
  "The attached image is a composite made by a program.",
  "- LEFT: reduced views of the comic (whole pages, or strips around the text). Every text region has a coloured frame and a number badge.",
  '- RIGHT: an enlarged crop of every numbered region, under a header "#n" in the same colour. Read the text from these crops. Use the left views only to understand the scene: who speaks, to whom, gender, age and mood.',
  "The numbers 1..N follow the reading order. The user message gives N.",
].join("\n");

export function systemOutput(target: PromptTarget): string {
  return [
    "# Output",
    "Plain text lines only. No markdown, no code fences, no explanations.",
    "Line 1: @lang|<ko, ja, zh, en, es or other>   (main language of the source text)",
    "Then exactly one line for each number from 1 to N, in increasing order:",
    "#<n>|<type>|<speaker>|<original>|<translation>",
    "- type: dialogue (speech), thought (inner thought), narration (caption or narrator box), sign (written text in the scene: signs, screens, messages, labels), sfx (sound-effect lettering), ignore (watermark, site logo, URL, credits, page number, or no readable text).",
    `- speaker: the speaker's name if the comic shows it; otherwise a short role in ${target.name} (for example "girl" or "old man", translated); otherwise empty.`,
    "- original: the source text of region n exactly as written, on one line (join its lines with a space; read vertical text top to bottom, columns right to left).",
    `- translation: the ${target.name} translation of region n only, on one line.`,
    "For type ignore, leave original and translation empty.",
    "Hard rules:",
    "- Every number from 1 to N appears exactly once. Never skip a number, never repeat one, never use a number outside 1..N.",
    "- Never merge regions. If one sentence runs across several regions, split the translation across the same regions in the same order, so each line holds only its own part.",
    '- Never put the character "|" inside a field.',
    "After the # lines, for each NEW name or recurring term that is not in the glossary (at most 5):",
    `@term|<original>|<${target.name} rendering>|<short note in ${target.name}>`,
    ...addressOutput(target),
  ].join("\n");
}

/** Targets whose forms of address carry relationship and register (English only has I / you). */
export function asksForAddress(target: PromptTarget): boolean {
  return target.code !== "en";
}

/**
 * @addr lines: how each pair of characters talk to each other, so the extension can keep them the same for the
 * rest of the series (series memory learns them and sends them back as the forms-of-address table).
 */
function addressOutput(target: PromptTarget): string[] {
  if (!asksForAddress(target)) return [];
  return [
    "Then, for each pair of characters who speak to each other in these regions and are not yet in the forms-of-address table (at most 5):",
    `@addr|<speaker>|<listener>|<how the speaker refers to themself>|<how the speaker addresses the listener>   (${target.name} words: pronoun, kinship word or title)`,
    "Use the same names as in the speaker field.",
  ];
}

export function systemAskSummary(target: PromptTarget, words: number = PROMPT_LIMITS.summaryWords): string {
  return `As the very last line: @sum|<the story so far in ${target.name}, at most ${words} words, including this part>`;
}

/** "a" or "an" before an English word (by its first letter: language names start with a vowel sound exactly then). */
export function article(word: string): "a" | "an" {
  return /^[aeiou]/iu.test(word) ? "an" : "a";
}

export const VIETNAMESE_STYLE = [
  "# Vietnamese style",
  "- Write like a good Vietnamese scanlation team: natural, idiomatic, and short enough to fit the bubble. Prefer the shortest natural phrasing.",
  '- Choose xưng hô from the relationship, age, gender and politeness of speaker and listener, and keep it consistent: tôi/anh, tôi/cô, anh/em, chị/em, tớ/cậu, tao/mày, ta/ngươi, con/bố, cháu/ông. Use "bạn" only when it truly fits.',
  '- Keep the emotion and punctuation ("...", "!", "?!"). Sentence case; capitals only for shouting and sfx.',
  "- sfx: a Vietnamese onomatopoeia in capitals (RẦM, BỐP, VÚT, RẮC, LẠCH CẠCH); if none fits, a 1-3 word description in capitals.",
  "- Keep numbers. No translator notes.",
].join("\n");

export function styleBlock(target: PromptTarget): string {
  if (target.code === "vi") return VIETNAMESE_STYLE;
  if (isCjkPromptTarget(target)) {
    return [
      `# ${target.name} style`,
      `- Write like a good ${target.name} scanlation team: natural, idiomatic, and short enough to fit the bubble. Prefer the shortest natural phrasing.`,
      `- Choose forms of address, politeness and register from the relationship, age and status of speaker and listener, and keep them consistent.`,
      `- Keep the emotion and punctuation ("...", "!", "?!"), written with ${target.name} punctuation.`,
      `- sfx: ${article(target.name)} ${target.name} onomatopoeia; if none fits, a 1-3 word description.`,
      "- Keep numbers. No translator notes.",
    ].join("\n");
  }
  return [
    `# ${target.name} style`,
    `- Write like a good ${target.name} scanlation team: natural, idiomatic, and short enough to fit the bubble. Prefer the shortest natural phrasing.`,
    `- Choose forms of address, politeness and register from the relationship, age and status of speaker and listener, and keep them consistent.`,
    '- Keep the emotion and punctuation ("...", "!", "?!"). Sentence case; capitals only for shouting and sfx.',
    `- sfx: ${article(target.name)} ${target.name} onomatopoeia in capitals; if none fits, a 1-3 word description in capitals.`,
    "- Keep numbers. No translator notes.",
  ].join("\n");
}

export const LANGUAGE_RULES_HEADER = "# Language rules";
export const GLOSSARY_HEADER = "# Glossary (always use these renderings)";

/** Explains the lines under the forms-of-address header. */
export const PRONOUNS_LEGEND =
  "speaker -> listener: how the speaker refers to themself / how the speaker addresses the listener. Always use exactly these words for these pairs.";

export function pronounsHeader(target: PromptTarget): string {
  return target.code === "vi" ? "# Xưng hô (keep consistent)" : "# Forms of address (keep consistent)";
}

/** Source-language rules; `vi` lines apply only when translating into Vietnamese. */
export const KOREAN_BLOCK = {
  header: "## Korean",
  names:
    "- Names: Revised Romanization without hyphens, capitalised (민준 -> Minjun, 서연 -> Seoyeon), the same spelling every time, unless the glossary says otherwise.",
  hanViet:
    "- This is a murim/historical story: write names of people, sects and places in Hán Việt (as Vietnamese readers know them), not in romanization.",
  vi: [
    "- Speech level sets xưng hô: 반말 between close peers -> tớ/cậu, or tao/mày when rough; to an older brother or sister figure -> em/anh, em/chị; 존댓말/해요체 to strangers, seniors or customers -> tôi/anh, tôi/cô, em/anh; 합쇼체, military, palace or company speech -> tôi + title (ngài, giám đốc, đội trưởng).",
    "- Titles and kinship words: 오빠/형 -> anh, 언니/누나 -> chị, 선배 -> tiền bối (school or office: anh/chị), 아저씨 -> chú, 아줌마 -> cô/dì, 할아버지 -> ông, -씨 -> anh/chị/cô + name, -님 -> ngài or the title.",
    "- Murim, historical and fantasy settings: Hán Việt for Sino-Korean terms (무림 -> võ lâm, 문파 -> môn phái, 장로 -> trưởng lão, 내공 -> nội công, 검 -> kiếm) and ta/ngươi, huynh/đệ where the register is old-fashioned.",
    "- Interjections: ㅋㅋ -> haha, 헐 -> hả/trời, 아이고 -> ôi trời, 응 -> ừ.",
  ],
  other: [
    "- Speech levels (반말, 존댓말, 합쇼체) set the register and the forms of address of the target language; keep honorific titles (오빠, 선배, -님) as natural equivalents.",
  ],
  common: [
    "- Webtoons put much text outside bubbles: narration boxes, thoughts over the art, phone screens, chat messages, signs and sound effects. Translate all of them and type them correctly.",
  ],
} as const;

export const JAPANESE_BLOCK = {
  header: "## Japanese",
  reading:
    "- Text is usually vertical: read each column top to bottom, columns right to left. Read only the main text; ignore furigana (small kana beside kanji) except to read names.",
  names:
    "- Names: Hepburn without macrons (Shōta -> Shota), the same spelling every time, unless the glossary says otherwise.",
  convertHonorificsVi:
    "- Turn -san, -kun, -chan, -sama, senpai and sensei into Vietnamese xưng hô and titles (senpai -> tiền bối or anh/chị; sensei -> thầy/cô).",
  convertHonorifics:
    "- Turn -san, -kun, -chan, -sama, senpai and sensei into natural forms of address and titles of the target language.",
  keepHonorifics: "- Keep -san, -kun, -chan, -sama, senpai and sensei after names.",
  keigo: "- Keigo versus casual speech sets the register as above. Translate katakana loanwords by meaning.",
} as const;

export const CHINESE_BLOCK = {
  vi: [
    "## Chinese",
    "- Simplified or traditional. Names, places, sects, techniques, ranks and titles: Hán Việt reading (林枫 -> Lâm Phong, 青云宗 -> Thanh Vân Tông, 筑基 -> Trúc Cơ, 师父 -> sư phụ). Never give a name a second, different reading.",
    "- Wuxia, xianxia and historical register: ta/ngươi, huynh/đệ, tỷ/muội, sư phụ/đồ nhi, bổn tọa, lão phu as the speaker would say; modern stories: tôi/anh/em.",
  ].join("\n"),
  other: [
    "## Chinese",
    "- Simplified or traditional. Names and places: pinyin without tone marks (林枫 -> Lin Feng); sects, techniques and ranks: the established translation in the genre, or a meaningful translation. Never give a name a second, different spelling.",
    "- Wuxia, xianxia and historical stories keep an old-fashioned register; modern stories use everyday speech.",
  ].join("\n"),
} as const;

/** "Names: …" for a CJK target: the target's own script, never a romanization. */
export function cjkNamesLine(target: PromptTarget): string {
  const how =
    target.code === "ja"
      ? "in katakana as Japanese readers know them (kanji where the original uses kanji)"
      : target.code === "ko"
        ? "in Hangul as Korean readers know them"
        : `in ${target.name} characters as Chinese readers know them (the usual transliteration for foreign names)`;
  return `- Names: write them ${how}, the same spelling every time, unless the glossary says otherwise.`;
}

/** The source is already in the target's language: keep it (Chinese: in the target's characters), or null. */
export function sameLanguageLine(lang: "ko" | "ja" | "zh", target: PromptTarget): string | null {
  const same =
    (lang === "ja" && target.code === "ja") ||
    (lang === "ko" && target.code === "ko") ||
    (lang === "zh" && (target.code === "zh-cn" || target.code === "zh-tw"));
  if (!same) return null;
  return lang === "zh"
    ? `- The source is already Chinese: keep the wording, written in ${target.name} characters.`
    : `- The source is already ${target.name}: keep it as is (type the lines, copy the text).`;
}

export function englishBlock(target: PromptTarget): string {
  return [
    "## English",
    isCjkPromptTarget(target)
      ? "- Keep names as written. Comic lettering is often ALL CAPITALS: that is not shouting."
      : `- Keep names as written. Comic lettering is often ALL CAPITALS: translate into normal ${target.name} sentence case.`,
    "- Translate idioms and jokes by meaning; keep sarcasm and slang.",
  ].join("\n");
}

export function spanishBlock(target: PromptTarget): string {
  return [
    "## Spanish",
    isCjkPromptTarget(target)
      ? "- Scanlation lettering is often ALL CAPITALS: that is not shouting."
      : `- Scanlation lettering is often ALL CAPITALS: translate into normal ${target.name} sentence case.`,
    target.code === "es"
      ? "- The source is already Spanish: keep it as is (type the lines, copy the text)."
      : `- Drop the inverted marks ¡ ¿ unless ${target.name} uses them. Keep names as written.`,
    `- Map tú/usted and vosotros/ustedes to fitting ${target.name} forms of address for the speakers' relationship.`,
    "- Translate idioms, slang and Latin-American or Spain-specific expressions by meaning.",
  ].join("\n");
}

export const USER_SUMMARY_HEADER = "[Story so far - context only, do not output]";
export const USER_HISTORY_HEADER = "[Earlier lines of this chapter - context only, do not output them]";
export const USER_TASK_HEADER = "[Task]";

export function taskLine(n: number): string {
  return `The attached image has N = ${n} numbered regions. Output @lang, then #1 to #${n}.`;
}

/** Crops-only re-ask: there is no context part; the history then holds the neighbouring regions. */
export function cropsOnlyLine(n: number, hasHistory: boolean): string {
  const first = `This image has no left part: it contains only the enlarged crops #1 to #${n}.`;
  return hasHistory ? `${first} Earlier lines above are the neighbouring regions.` : first;
}

type BlockLang = "ko" | "ja" | "zh" | "en" | "es";
const ALL_BLOCK_LANGS: readonly BlockLang[] = ["ko", "ja", "zh", "en", "es"];

/** One source-language block with its conditional lines resolved for the target language. */
export function languageBlock(
  lang: BlockLang,
  style: StyleProfile,
  target: PromptTarget = VIETNAMESE,
): string {
  const vi = target.code === "vi";
  const cjk = isCjkPromptTarget(target);
  if (lang === "ko") {
    const same = sameLanguageLine("ko", target);
    if (same !== null) return [KOREAN_BLOCK.header, same, ...KOREAN_BLOCK.common].join("\n");
    const lines: string[] = [KOREAN_BLOCK.header, cjk ? cjkNamesLine(target) : KOREAN_BLOCK.names];
    if (vi && style.koNames === "han-viet") lines.push(KOREAN_BLOCK.hanViet);
    lines.push(...(vi ? KOREAN_BLOCK.vi : KOREAN_BLOCK.other), ...KOREAN_BLOCK.common);
    return lines.join("\n");
  }
  if (lang === "ja") {
    const same = sameLanguageLine("ja", target);
    if (same !== null) return [JAPANESE_BLOCK.header, JAPANESE_BLOCK.reading, same].join("\n");
    const honorifics = style.keepJaHonorifics
      ? JAPANESE_BLOCK.keepHonorifics
      : vi
        ? JAPANESE_BLOCK.convertHonorificsVi
        : JAPANESE_BLOCK.convertHonorifics;
    return [
      JAPANESE_BLOCK.header,
      JAPANESE_BLOCK.reading,
      cjk ? cjkNamesLine(target) : JAPANESE_BLOCK.names,
      honorifics,
      JAPANESE_BLOCK.keigo,
    ].join("\n");
  }
  if (lang === "es") return spanishBlock(target);
  if (lang === "zh") {
    if (vi) return CHINESE_BLOCK.vi;
    if (!cjk) return CHINESE_BLOCK.other;
    const same = sameLanguageLine("zh", target);
    return [
      "## Chinese",
      same ?? `- Simplified or traditional. ${cjkNamesLine(target).slice(2)}`,
      "- Wuxia, xianxia and historical stories keep an old-fashioned register; modern stories use everyday speech.",
    ].join("\n");
  }
  return englishBlock(target);
}

/** Language blocks for the series language: one block, or all of them (Korean first) while it is unknown. */
export function languageBlocks(
  lang: Lang | "auto",
  style: StyleProfile,
  target: PromptTarget = VIETNAMESE,
): string[] {
  const langs = lang === "auto" || lang === "other" ? ALL_BLOCK_LANGS : [lang];
  return langs.map((l) => languageBlock(l, style, target));
}

// ---- Text helpers ----

/** Collapses line breaks and runs of whitespace so context text can never break the line structure. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function cutChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** The last `n` items (none for n ≤ 0: slice(-0) would keep them all). */
function lastN<T>(items: readonly T[], n: number): T[] {
  return n <= 0 ? [] : items.slice(-n);
}

function capWords(text: string, max: number): string {
  const words = oneLine(text)
    .split(" ")
    .filter((word) => word !== "");
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

const SOURCE_RANK: Readonly<Record<GlossaryEntry["source"], number>> = {
  manual: 0,
  confirmed: 1,
  learned: 2,
};

function glossaryLine(entry: GlossaryEntry): string {
  const note = oneLine(entry.note ?? "");
  const base = `${oneLine(entry.original)} -> ${oneLine(entry.translation)}`;
  return note === "" ? base : `${base} (${note})`;
}

function pronounLine(rule: PronounRule): string {
  return `${oneLine(rule.a)} -> ${oneLine(rule.b)}: ${oneLine(rule.aSelf)} / ${oneLine(rule.aToB)}`;
}

function historyLine(line: HistoryLine, maxOriginal: number): string {
  const speaker = oneLine(line.speaker);
  const original = cutChars(oneLine(line.original), maxOriginal);
  const translation = oneLine(line.translation);
  const prefix = speaker === "" ? "" : `${speaker}: `;
  return original === "" ? `${prefix}${translation}` : `${prefix}${original} => ${translation}`;
}

interface Selection {
  glossary: GlossaryEntry[];
  pronouns: PronounRule[];
  history: HistoryLine[];
  summary: string;
}

function systemText(input: PromptInput, sel: Selection, limits: PromptLimits): string {
  const target = input.target ?? VIETNAMESE;
  const output = input.askSummary
    ? `${systemOutput(target)}\n${systemAskSummary(target, limits.summaryWords)}`
    : systemOutput(target);
  const genre = oneLine(input.style.genre ?? "");
  const base = styleBlock(target);
  const style = genre === "" ? base : `${base}\nGenre and tone: ${genre}.`;
  const rules = [LANGUAGE_RULES_HEADER, languageBlocks(input.lang, input.style, target).join("\n\n")].join(
    "\n",
  );
  const sections = [systemIntro(target), SYSTEM_INPUT, output, style, rules];
  const tail: string[] = [];
  if (sel.glossary.length > 0) {
    tail.push(GLOSSARY_HEADER, ...sel.glossary.map(glossaryLine));
  }
  if (sel.pronouns.length > 0) {
    tail.push(pronounsHeader(target), PRONOUNS_LEGEND, ...sel.pronouns.map(pronounLine));
  }
  if (tail.length > 0) {
    sections.push(tail.join("\n"));
  }
  return sections.join("\n\n");
}

function userText(input: PromptInput, sel: Selection, limits: PromptLimits): string {
  const blocks: string[] = [];
  if (sel.summary !== "") {
    blocks.push(`${USER_SUMMARY_HEADER}\n${sel.summary}`);
  }
  if (sel.history.length > 0) {
    const lines = sel.history.map((line) => historyLine(line, limits.historyOriginalChars));
    blocks.push([USER_HISTORY_HEADER, ...lines].join("\n"));
  }
  const task = [USER_TASK_HEADER, taskLine(input.n)];
  if (input.mode === "crops-only") {
    task.push(cropsOnlyLine(input.n, sel.history.length > 0));
  }
  blocks.push(task.join("\n"));
  return blocks.join("\n\n");
}

export interface PromptStats {
  systemChars: number;
  userChars: number;
  /** estimateTokens of system + user text (the image is not counted). */
  textTokens: number;
  glossarySent: number;
  glossaryDropped: number;
  pronounsSent: number;
  historySent: number;
  historyDropped: number;
  /** The 16k-character cap removed context. */
  trimmedForSize: boolean;
  /** Still over the cap after trimming (manual/confirmed entries are never dropped): consider a smaller pack. */
  overSize: boolean;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  system: string;
  user: string;
  stats: PromptStats;
}

/** Vision endpoints accept base64 data URLs of JPEG or PNG images. */
const DATA_URL = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]/u;

/** Builds the messages plus what was sent and dropped. Throws RangeError on an invalid n or image URL. */
export function buildPrompt(
  input: PromptInput,
  imageDataUrl: string,
  limitsOverride: Partial<PromptLimits> = {},
): BuiltPrompt {
  if (!Number.isInteger(input.n) || input.n < 1) {
    throw new RangeError(`prompt: n must be a positive integer, got ${input.n}`);
  }
  if (!DATA_URL.test(imageDataUrl)) {
    throw new RangeError("prompt: the image must be a base64 data URL of type image/jpeg or image/png");
  }
  const limits: PromptLimits = { ...PROMPT_LIMITS, ...limitsOverride };

  // Glossary: manual, then confirmed, then learned (stable within each source), at most N entries.
  const ranked = input.glossary
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => oneLine(entry.original) !== "" && oneLine(entry.translation) !== "")
    .sort((a, b) => SOURCE_RANK[a.entry.source] - SOURCE_RANK[b.entry.source] || a.index - b.index)
    .map(({ entry }) => entry);
  const glossary = ranked.slice(0, limits.glossaryEntries);
  const dropLastLearned = (): boolean => {
    for (let i = glossary.length - 1; i >= 0; i -= 1) {
      if (glossary[i]?.source === "learned") {
        glossary.splice(i, 1);
        return true;
      }
    }
    return false;
  };
  while (estimateTokens(glossary.map(glossaryLine).join("\n")) > limits.glossaryTokens && dropLastLearned()) {
    // dropped the lowest-ranked learned entry
  }

  // Forms of address: newest lines win.
  const pronouns = lastN(
    input.pronouns.filter((rule) => oneLine(rule.a) !== "" && oneLine(rule.b) !== ""),
    limits.pronounLines,
  );
  while (pronouns.length > 0 && estimateTokens(pronouns.map(pronounLine).join("\n")) > limits.pronounTokens) {
    pronouns.shift();
  }

  // History: the last N lines, then drop the oldest until under the token budget.
  const history = lastN(
    input.history.filter((line) => oneLine(line.translation) !== ""),
    limits.historyLines,
  );
  const historyTokens = (): number =>
    estimateTokens(history.map((line) => historyLine(line, limits.historyOriginalChars)).join("\n"));
  while (history.length > 0 && historyTokens() > limits.historyTokens) {
    history.shift();
  }

  const summary = input.summary == null ? "" : capWords(input.summary, limits.summaryWords);
  const sel: Selection = { glossary, pronouns, history, summary };

  // Size guard: trim history first, then learned glossary entries.
  let system = systemText(input, sel, limits);
  let user = userText(input, sel, limits);
  let trimmedForSize = false;
  while (system.length + user.length > limits.maxTextChars) {
    if (history.length > 0) {
      history.shift();
      user = userText(input, sel, limits);
    } else if (dropLastLearned()) {
      system = systemText(input, sel, limits);
    } else {
      break;
    }
    trimmedForSize = true;
  }

  const historyInput = input.history.filter((line) => oneLine(line.translation) !== "").length;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ];
  return {
    messages,
    system,
    user,
    stats: {
      systemChars: system.length,
      userChars: user.length,
      textTokens: estimateTokens(`${system}\n${user}`),
      glossarySent: glossary.length,
      glossaryDropped: ranked.length - glossary.length,
      pronounsSent: pronouns.length,
      historySent: history.length,
      historyDropped: historyInput - history.length,
      trimmedForSize,
      overSize: system.length + user.length > limits.maxTextChars,
    },
  };
}

/** [system, user{text, image_url}] for one request. */
export function buildMessages(input: PromptInput, imageDataUrl: string): ChatMessage[] {
  return buildPrompt(input, imageDataUrl).messages;
}
