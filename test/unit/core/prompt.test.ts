import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  article,
  buildMessages,
  buildPrompt,
  CHINESE_BLOCK,
  cjkNamesLine,
  englishBlock,
  isCjkPromptTarget,
  JAPANESE_BLOCK,
  KOREAN_BLOCK,
  languageBlock,
  languageBlocks,
  pronounsHeader,
  PROMPT_LIMITS,
  sameLanguageLine,
  spanishBlock,
  styleBlock,
  systemAskSummary,
  systemIntro,
  systemOutput,
  VIETNAMESE,
  VIETNAMESE_STYLE,
  type PromptTarget,
  type GlossaryEntry,
  type HistoryLine,
  type PromptInput,
  type StyleProfile,
} from "../../../src/shared/core/prompt.ts";
import { estimateTokens } from "../../../src/shared/core/tokens.ts";

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
const STYLE: StyleProfile = { koNames: "romanized", keepJaHonorifics: false };

function input(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    lang: "ko",
    n: 3,
    mode: "full",
    style: STYLE,
    glossary: [],
    pronouns: [],
    history: [],
    askSummary: false,
    ...overrides,
  };
}

// Golden: the default Vietnamese target with lang ko, romanized names, no genre, no glossary, no xưng hô, no @sum.
const GOLDEN_SYSTEM_KO = `You are an expert comic translator. You translate comic text into natural, spoken Vietnamese for a reader who reads the comic in a web browser.

# Input
The attached image is a composite made by a program.
- LEFT: reduced views of the comic (whole pages, or strips around the text). Every text region has a coloured frame and a number badge.
- RIGHT: an enlarged crop of every numbered region, under a header "#n" in the same colour. Read the text from these crops. Use the left views only to understand the scene: who speaks, to whom, gender, age and mood.
The numbers 1..N follow the reading order. The user message gives N.

# Output
Plain text lines only. No markdown, no code fences, no explanations.
Line 1: @lang|<ko, ja, zh, en, es or other>   (main language of the source text)
Then exactly one line for each number from 1 to N, in increasing order:
#<n>|<type>|<speaker>|<original>|<translation>
- type: dialogue (speech), thought (inner thought), narration (caption or narrator box), sign (written text in the scene: signs, screens, messages, labels), sfx (sound-effect lettering), ignore (watermark, site logo, URL, credits, page number, or no readable text).
- speaker: the speaker's name if the comic shows it; otherwise a short role in Vietnamese (for example "girl" or "old man", translated); otherwise empty.
- original: the source text of region n exactly as written, on one line (join its lines with a space; read vertical text top to bottom, columns right to left).
- translation: the Vietnamese translation of region n only, on one line.
For type ignore, leave original and translation empty.
Hard rules:
- Every number from 1 to N appears exactly once. Never skip a number, never repeat one, never use a number outside 1..N.
- Never merge regions. If one sentence runs across several regions, split the translation across the same regions in the same order, so each line holds only its own part.
- Never put the character "|" inside a field.
After the # lines, for each NEW name or recurring term that is not in the glossary (at most 5):
@term|<original>|<Vietnamese rendering>|<short note in Vietnamese>

# Vietnamese style
- Write like a good Vietnamese scanlation team: natural, idiomatic, and short enough to fit the bubble. Prefer the shortest natural phrasing.
- Choose xưng hô from the relationship, age, gender and politeness of speaker and listener, and keep it consistent: tôi/anh, tôi/cô, anh/em, chị/em, tớ/cậu, tao/mày, ta/ngươi, con/bố, cháu/ông. Use "bạn" only when it truly fits.
- Keep the emotion and punctuation ("...", "!", "?!"). Sentence case; capitals only for shouting and sfx.
- sfx: a Vietnamese onomatopoeia in capitals (RẦM, BỐP, VÚT, RẮC, LẠCH CẠCH); if none fits, a 1-3 word description in capitals.
- Keep numbers. No translator notes.

# Language rules
## Korean
- Names: Revised Romanization without hyphens, capitalised (민준 -> Minjun, 서연 -> Seoyeon), the same spelling every time, unless the glossary says otherwise.
- Speech level sets xưng hô: 반말 between close peers -> tớ/cậu, or tao/mày when rough; to an older brother or sister figure -> em/anh, em/chị; 존댓말/해요체 to strangers, seniors or customers -> tôi/anh, tôi/cô, em/anh; 합쇼체, military, palace or company speech -> tôi + title (ngài, giám đốc, đội trưởng).
- Titles and kinship words: 오빠/형 -> anh, 언니/누나 -> chị, 선배 -> tiền bối (school or office: anh/chị), 아저씨 -> chú, 아줌마 -> cô/dì, 할아버지 -> ông, -씨 -> anh/chị/cô + name, -님 -> ngài or the title.
- Murim, historical and fantasy settings: Hán Việt for Sino-Korean terms (무림 -> võ lâm, 문파 -> môn phái, 장로 -> trưởng lão, 내공 -> nội công, 검 -> kiếm) and ta/ngươi, huynh/đệ where the register is old-fashioned.
- Interjections: ㅋㅋ -> haha, 헐 -> hả/trời, 아이고 -> ôi trời, 응 -> ừ.
- Webtoons put much text outside bubbles: narration boxes, thoughts over the art, phone screens, chat messages, signs and sound effects. Translate all of them and type them correctly.`;

describe("buildMessages: shape", () => {
  test("exactly [system, user{text, image_url}]", () => {
    const messages = buildMessages(input(), IMAGE);
    assert.equal(messages.length, 2);
    const [system, user] = messages;
    assert.equal(system?.role, "system");
    assert.equal(typeof system?.content, "string");
    assert.equal(user?.role, "user");
    assert.ok(user !== undefined && Array.isArray(user.content));
    assert.deepEqual(
      user.content.map((part) => part.type),
      ["text", "image_url"],
    );
    assert.deepEqual(user.content[1], { type: "image_url", image_url: { url: IMAGE } });
  });

  test("golden: system text for a Korean series", () => {
    assert.equal(buildPrompt(input(), IMAGE).system, GOLDEN_SYSTEM_KO);
  });

  test("golden: user text for a full composite without context", () => {
    assert.equal(
      buildPrompt(input({ n: 12 }), IMAGE).user,
      "[Task]\nThe attached image has N = 12 numbered regions. Output @lang, then #1 to #12.",
    );
  });

  test("golden: user text with summary, history and crops-only", () => {
    const history: HistoryLine[] = [
      { pos: 1, speaker: "Zorvik", original: "비가 와요", translation: "Trời mưa rồi." },
      { pos: 2, speaker: "", original: "쾅", translation: "RẦM!" },
      { pos: 3, speaker: "Kai", original: "", translation: "Đi thôi." },
    ];
    const { user } = buildPrompt(
      input({ n: 2, mode: "crops-only", summary: "Zorvik quên ô ở tiệm Plimba.", history }),
      IMAGE,
    );
    assert.equal(
      user,
      [
        "[Story so far - context only, do not output]",
        "Zorvik quên ô ở tiệm Plimba.",
        "",
        "[Earlier lines of this chapter - context only, do not output them]",
        "Zorvik: 비가 와요 => Trời mưa rồi.",
        "쾅 => RẦM!",
        "Kai: Đi thôi.",
        "",
        "[Task]",
        "The attached image has N = 2 numbered regions. Output @lang, then #1 to #2.",
        "This image has no left part: it contains only the enlarged crops #1 to #2. Earlier lines above are the neighbouring regions.",
      ].join("\n"),
    );
    const bare = buildPrompt(input({ n: 1, mode: "crops-only" }), IMAGE).user;
    assert.ok(bare.endsWith("This image has no left part: it contains only the enlarged crops #1 to #1."));
  });

  test("rejects an invalid n or a non-JPEG/PNG data URL", () => {
    assert.throws(() => buildMessages(input({ n: 0 }), IMAGE), RangeError);
    assert.throws(() => buildMessages(input({ n: 2.5 }), IMAGE), RangeError);
    assert.throws(() => buildMessages(input(), "https://example.invalid/a.jpg"), RangeError);
    assert.throws(() => buildMessages(input(), "data:image/webp;base64,AAAA"), RangeError);
    assert.throws(() => buildMessages(input(), "data:image/jpeg;base64,"), RangeError, "empty payload");
    assert.doesNotThrow(() => buildMessages(input(), "data:image/png;base64,iVBORw0KGgo="));
  });
});

describe("buildMessages: language blocks and conditionals", () => {
  const order = (system: string): string[] => system.split("\n").filter((line) => line.startsWith("## "));

  test("unknown language: every block, Korean first", () => {
    assert.deepEqual(order(buildPrompt(input({ lang: "auto" }), IMAGE).system), [
      "## Korean",
      "## Japanese",
      "## Chinese",
      "## English",
      "## Spanish",
    ]);
    assert.deepEqual(order(buildPrompt(input({ lang: "other" }), IMAGE).system).length, 5);
  });

  test("known language: one block", () => {
    for (const [lang, header] of [
      ["ko", "## Korean"],
      ["ja", "## Japanese"],
      ["zh", "## Chinese"],
      ["en", "## English"],
      ["es", "## Spanish"],
    ] as const) {
      assert.deepEqual(order(buildPrompt(input({ lang }), IMAGE).system), [header], lang);
    }
    assert.ok(buildPrompt(input({ lang: "zh" }), IMAGE).system.endsWith(CHINESE_BLOCK.vi));
    assert.ok(buildPrompt(input({ lang: "en" }), IMAGE).system.endsWith(englishBlock(VIETNAMESE)));
    assert.ok(buildPrompt(input({ lang: "es" }), IMAGE).system.endsWith(spanishBlock(VIETNAMESE)));
  });

  test("Korean Hán Việt names line only for han-viet series", () => {
    const hanViet = "- This is a murim/historical story: write names of people, sects and places in Hán Việt";
    assert.ok(!languageBlock("ko", STYLE).includes(hanViet));
    const block = languageBlock("ko", { ...STYLE, koNames: "han-viet" }).split("\n");
    assert.ok(block[2]?.startsWith(hanViet), "right after the names line");
  });

  test("Japanese honorifics: converted by default, kept on request", () => {
    const convert = languageBlock("ja", STYLE);
    assert.ok(convert.includes("- Turn -san, -kun, -chan, -sama, senpai and sensei into Vietnamese xưng hô"));
    assert.ok(!convert.includes("- Keep -san"));
    const keep = languageBlock("ja", { ...STYLE, keepJaHonorifics: true });
    assert.ok(keep.includes("- Keep -san, -kun, -chan, -sama, senpai and sensei after names."));
    assert.ok(!keep.includes("- Turn -san"));
  });

  test("genre line, @sum request, glossary and xưng hô sections", () => {
    const { system } = buildPrompt(
      input({
        style: { ...STYLE, genre: "murim, hài hước" },
        askSummary: true,
        glossary: [
          { original: "Plimba", translation: "Plimba", note: "tên tiệm bánh", source: "manual" },
          { original: "무림", translation: "võ lâm", source: "learned" },
        ],
        pronouns: [{ a: "Zorvik", b: "Kai", aSelf: "tớ", aToB: "cậu" }],
      }),
      IMAGE,
    );
    assert.ok(
      system.includes(
        "@term|<original>|<Vietnamese rendering>|<short note in Vietnamese>\nAs the very last line: @sum|<the story so far in Vietnamese, at most 60 words, including this part>\n\n# Vietnamese style",
      ),
    );
    assert.ok(
      system.includes(
        "- Keep numbers. No translator notes.\nGenre and tone: murim, hài hước.\n\n# Language rules",
      ),
    );
    assert.ok(
      system.endsWith(
        "\n\n# Glossary (always use these renderings)\nPlimba -> Plimba (tên tiệm bánh)\n무림 -> võ lâm\n# Xưng hô (keep consistent)\nZorvik -> Kai: tớ / cậu",
      ),
    );
    const noSum = buildPrompt(input(), IMAGE).system;
    assert.ok(!noSum.includes("@sum|"));
    assert.ok(!noSum.includes("Genre and tone"));
    assert.ok(!noSum.includes("# Glossary"));
    assert.ok(!noSum.includes("# Xưng hô (keep consistent)"));
  });

  test("the system text does not depend on n, mode, history or summary", () => {
    const a = buildPrompt(input({ n: 3 }), IMAGE).system;
    const b = buildPrompt(
      input({
        n: 16,
        mode: "crops-only",
        summary: "Tóm tắt.",
        history: [{ pos: 1, speaker: "", original: "x", translation: "y" }],
      }),
      IMAGE,
    ).system;
    assert.equal(a, b);
  });

  test("line breaks inside context fields cannot break the structure", () => {
    const { system, user } = buildPrompt(
      input({
        glossary: [{ original: "A\nB", translation: "C\r\nD", note: "e\nf", source: "manual" }],
        summary: "Dòng một\nDòng hai",
        history: [{ pos: 1, speaker: "Kai\n", original: "x\ny", translation: "z\nw" }],
      }),
      IMAGE,
    );
    assert.ok(system.endsWith("A B -> C D (e f)"));
    assert.ok(user.includes("Dòng một Dòng hai"));
    assert.ok(user.includes("Kai: x y => z w"));
  });
});

describe("buildPrompt: limits", () => {
  function glossaryOf(count: number, source: GlossaryEntry["source"], prefix: string): GlossaryEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      original: `${prefix}${i}`,
      translation: `${prefix}vi${i}`,
      source,
    }));
  }

  test("glossary: at most 60 entries, manual then confirmed then learned", () => {
    const glossary = [
      ...glossaryOf(30, "learned", "L"),
      ...glossaryOf(20, "confirmed", "C"),
      ...glossaryOf(25, "manual", "M"),
    ];
    const { system, stats } = buildPrompt(input({ glossary }), IMAGE);
    const lines = system.split("# Glossary (always use these renderings)\n")[1]?.split("\n") ?? [];
    assert.equal(lines.length, 60);
    assert.equal(lines[0], "M0 -> Mvi0");
    assert.equal(lines[25], "C0 -> Cvi0");
    assert.equal(lines[45], "L0 -> Lvi0");
    assert.equal(lines[59], "L14 -> Lvi14");
    assert.equal(stats.glossarySent, 60);
    assert.equal(stats.glossaryDropped, 15);
  });

  test("glossary: learned entries are dropped (lowest rank first) to stay within ~900 tokens", () => {
    const long = (prefix: string, count: number, source: GlossaryEntry["source"]): GlossaryEntry[] =>
      Array.from({ length: count }, (_, i) => ({
        original: `${prefix}${i} ${"word ".repeat(10)}`,
        translation: `${prefix}${i} ${"chữ ".repeat(10)}`,
        source,
      }));
    const glossary = [...long("M", 5, "manual"), ...long("L", 50, "learned")];
    const { system } = buildPrompt(input({ glossary }), IMAGE);
    const lines = system.split("# Glossary (always use these renderings)\n")[1]?.split("\n") ?? [];
    assert.ok(estimateTokens(lines.join("\n")) <= PROMPT_LIMITS.glossaryTokens);
    assert.ok(
      lines.slice(0, 5).every((line) => line.startsWith("M")),
      "manual entries are kept",
    );
    assert.ok(lines.length < 55 && lines.length > 5);
    assert.ok(
      lines[lines.length - 1]?.startsWith(`L${lines.length - 6} `),
      "the highest-ranked learned entries stay",
    );
  });

  test("glossary entries without an original or a translation are skipped", () => {
    const { stats } = buildPrompt(
      input({
        glossary: [
          { original: "", translation: "x", source: "manual" },
          { original: "y", translation: " ", source: "learned" },
        ],
      }),
      IMAGE,
    );
    assert.equal(stats.glossarySent, 0);
  });

  test("xưng hô: at most 10 lines, newest kept", () => {
    const pronouns = Array.from({ length: 14 }, (_, i) => ({
      a: `A${i}`,
      b: `B${i}`,
      aSelf: "tớ",
      aToB: "cậu",
    }));
    const { system, stats } = buildPrompt(input({ pronouns }), IMAGE);
    const lines = system.split("# Xưng hô (keep consistent)\n")[1]?.split("\n") ?? [];
    assert.equal(lines.length, 10);
    assert.equal(lines[0], "A4 -> B4: tớ / cậu");
    assert.equal(lines[9], "A13 -> B13: tớ / cậu");
    assert.equal(stats.pronounsSent, 10);
  });

  test("history: last 20 lines, originals cut to 60 characters", () => {
    const history: HistoryLine[] = Array.from({ length: 25 }, (_, i) => ({
      pos: i,
      speaker: "Kai",
      original: i === 24 ? "가".repeat(80) : `줄 ${i}`,
      translation: `Dòng ${i}`,
    }));
    const { user, stats } = buildPrompt(input({ history }), IMAGE);
    const lines = user.split("\n").filter((line) => line.startsWith("Kai: "));
    assert.equal(lines.length, 20);
    assert.equal(lines[0], "Kai: 줄 5 => Dòng 5");
    assert.equal(lines[19], `Kai: ${"가".repeat(59)}… => Dòng 24`);
    assert.equal(stats.historySent, 20);
    assert.equal(stats.historyDropped, 5);
  });

  test("history: ~700 token cap drops the oldest lines first", () => {
    const history: HistoryLine[] = Array.from({ length: 20 }, (_, i) => ({
      pos: i,
      speaker: "Zorvik",
      original: "가".repeat(60),
      translation: `Câu số ${i} ${"rất dài ".repeat(6)}`,
    }));
    const { user } = buildPrompt(input({ history }), IMAGE);
    const lines = user.split("\n").filter((line) => line.startsWith("Zorvik: "));
    assert.ok(lines.length < 20 && lines.length > 0, String(lines.length));
    assert.ok(estimateTokens(lines.join("\n")) <= PROMPT_LIMITS.historyTokens);
    assert.ok(lines[lines.length - 1]?.includes("Câu số 19 "), "newest line kept");
    assert.ok(lines[0]?.includes(`Câu số ${20 - lines.length} `), "contiguous suffix of the history");
  });

  test("history lines without a translation are not sent", () => {
    const { stats } = buildPrompt(
      input({ history: [{ pos: 1, speaker: "Kai", original: "x", translation: "  " }] }),
      IMAGE,
    );
    assert.equal(stats.historySent, 0);
  });

  test("summary: at most 60 words", () => {
    const words = Array.from({ length: 75 }, (_, i) => `từ${i}`);
    const { user } = buildPrompt(input({ summary: words.join(" ") }), IMAGE);
    const summary = user.split("\n")[1] ?? "";
    assert.equal(summary, `${words.slice(0, 60).join(" ")}…`);
    assert.equal(buildPrompt(input({ summary: "   " }), IMAGE).user.startsWith("[Task]"), true);
    assert.equal(buildPrompt(input({ summary: null }), IMAGE).user.startsWith("[Task]"), true);
  });

  test("size guard: ~16k characters, history trimmed first, then learned glossary entries", () => {
    const glossary: GlossaryEntry[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        original: `Manual${i}`,
        translation: `Thủ công ${i}`,
        note: "ghi chú ".repeat(30),
        source: "manual" as const,
      })),
      ...Array.from({ length: 40 }, (_, i) => ({
        original: `Learned${i}`,
        translation: `Đã học ${i}`,
        note: "ghi chú ".repeat(30),
        source: "learned" as const,
      })),
    ];
    const history: HistoryLine[] = Array.from({ length: 20 }, (_, i) => ({
      pos: i,
      speaker: "Kai",
      original: "x".repeat(60),
      translation: `Dòng ${i} ${"y".repeat(150)}`,
    }));
    const limits = { glossaryTokens: 100_000, historyTokens: 100_000 };
    const loose = buildPrompt(input({ glossary, history }), IMAGE, { ...limits, maxTextChars: 1_000_000 });
    assert.equal(loose.stats.trimmedForSize, false, "under the cap nothing is trimmed");
    const capped = buildPrompt(input({ glossary, history }), IMAGE, limits);
    assert.ok(
      loose.system.length + loose.user.length > PROMPT_LIMITS.maxTextChars,
      "fixture exceeds the default cap",
    );
    assert.ok(
      capped.system.length + capped.user.length <= PROMPT_LIMITS.maxTextChars,
      "default cap: ~16k characters",
    );

    const tight = buildPrompt(input({ glossary, history }), IMAGE, { ...limits, maxTextChars: 9_000 });
    assert.equal(tight.stats.trimmedForSize, true);
    assert.equal(tight.stats.overSize, false);
    assert.equal(loose.stats.overSize, false);
    const impossible = buildPrompt(input({ glossary, history }), IMAGE, { ...limits, maxTextChars: 1_000 });
    assert.equal(impossible.stats.overSize, true, "manual entries alone exceed the cap");
    assert.equal(impossible.stats.historySent, 0);
    assert.equal(impossible.stats.glossarySent, 10);
    assert.ok(tight.system.length + tight.user.length <= 9_000);
    assert.equal(tight.stats.historySent, 0, "history goes first");
    assert.ok(tight.stats.glossarySent < 50 && tight.stats.glossarySent >= 10);
    assert.ok(tight.system.includes("Manual9 -> Thủ công 9"), "manual entries are never trimmed for size");

    const historyOnly = buildPrompt(input({ glossary, history }), IMAGE, {
      ...limits,
      maxTextChars: loose.system.length + loose.user.length - 500,
    });
    assert.equal(historyOnly.stats.glossarySent, 50, "glossary untouched while history can be trimmed");
    assert.ok(historyOnly.stats.historySent > 0 && historyOnly.stats.historySent < 20);
    assert.ok(historyOnly.user.includes("Dòng 19 "), "newest history line kept");
  });

  test("defaults: the canonical limits", () => {
    assert.deepEqual(
      { ...PROMPT_LIMITS },
      {
        glossaryEntries: 60,
        glossaryTokens: 900,
        pronounLines: 10,
        pronounTokens: 150,
        historyLines: 20,
        historyTokens: 700,
        historyOriginalChars: 60,
        summaryWords: 60,
        maxTextChars: 16_000,
      },
    );
  });
});

describe("buildPrompt: target language", () => {
  const ENGLISH: PromptTarget = { code: "en", name: "English" };
  const SPANISH: PromptTarget = { code: "es", name: "Spanish" };
  const FRENCH: PromptTarget = { code: "fr", name: "French" };
  const HAN_VIET: StyleProfile = { koNames: "han-viet", keepJaHonorifics: false };
  /** Words that only belong in a prompt that translates into Vietnamese. */
  const VIETNAMESE_ONLY = ["xưng hô", "Xưng hô", "Hán Việt", "tiền bối", "võ lâm", "RẦM", "Vietnamese"];

  test("the default target is Vietnamese", () => {
    assert.deepEqual(VIETNAMESE, { code: "vi", name: "Vietnamese" });
    assert.equal(
      buildPrompt(input(), IMAGE).system,
      buildPrompt(input({ target: VIETNAMESE }), IMAGE).system,
    );
    assert.deepEqual(languageBlocks("ko", STYLE), [languageBlock("ko", STYLE, VIETNAMESE)]);
  });

  test("intro, output contract and summary request name the target language", () => {
    assert.ok(systemIntro(ENGLISH).includes("into natural, spoken English for a reader"));
    const output = systemOutput(ENGLISH);
    assert.ok(output.includes("Line 1: @lang|<ko, ja, zh, en, es or other>"));
    assert.ok(output.includes("\n#<n>|<type>|<speaker>|<original>|<translation>\n"));
    assert.ok(output.includes("- translation: the English translation of region n only, on one line."));
    assert.ok(output.endsWith("@term|<original>|<English rendering>|<short note in English>"));
    assert.equal(
      systemAskSummary(SPANISH),
      "As the very last line: @sum|<the story so far in Spanish, at most 60 words, including this part>",
    );
    assert.equal(
      systemOutput(FRENCH).replaceAll("French", "<target>"),
      systemOutput(VIETNAMESE).replaceAll("Vietnamese", "<target>"),
      "the same contract for every target",
    );
  });

  test("style: Vietnamese keeps its xưng hô and onomatopoeia rules; other targets get a generic style", () => {
    assert.equal(styleBlock(VIETNAMESE), VIETNAMESE_STYLE);
    assert.ok(VIETNAMESE_STYLE.includes("- Choose xưng hô from the relationship"));
    const english = styleBlock(ENGLISH);
    assert.ok(english.startsWith("# English style\n- Write like a good English scanlation team"));
    assert.ok(english.includes("forms of address, politeness and register"));
    // "an" before a vowel-initial language name, "a" otherwise.
    assert.ok(english.includes("- sfx: an English onomatopoeia in capitals"));
    assert.ok(styleBlock(SPANISH).includes("- sfx: a Spanish onomatopoeia in capitals"));
    for (const name of ["Indonesian", "Italian", "English"]) {
      assert.ok(styleBlock({ code: "xx", name }).includes(`- sfx: an ${name} onomatopoeia`), name);
    }
    assert.ok(styleBlock(FRENCH).includes("- sfx: a French onomatopoeia"));
    assert.equal(article("Turkish"), "a");
    assert.equal(article("Indonesian"), "an");
    assert.ok(english.endsWith("- Keep numbers. No translator notes."));
    for (const word of VIETNAMESE_ONLY) assert.ok(!english.includes(word), word);
  });

  test("forms-of-address header: Xưng hô for Vietnamese, plain English otherwise", () => {
    assert.equal(pronounsHeader(VIETNAMESE), "# Xưng hô (keep consistent)");
    assert.equal(pronounsHeader(ENGLISH), "# Forms of address (keep consistent)");
    assert.equal(pronounsHeader(SPANISH), "# Forms of address (keep consistent)");
  });

  test("Korean: the Vietnamese target keeps the xưng hô and Hán Việt lines, other targets do not", () => {
    const vi = languageBlock("ko", HAN_VIET, VIETNAMESE).split("\n");
    assert.deepEqual(vi, [
      KOREAN_BLOCK.header,
      KOREAN_BLOCK.names,
      KOREAN_BLOCK.hanViet,
      ...KOREAN_BLOCK.vi,
      ...KOREAN_BLOCK.common,
    ]);
    const en = languageBlock("ko", HAN_VIET, ENGLISH).split("\n");
    assert.deepEqual(
      en,
      [KOREAN_BLOCK.header, KOREAN_BLOCK.names, ...KOREAN_BLOCK.other, ...KOREAN_BLOCK.common],
      "a han-viet series still gets romanized names outside Vietnamese",
    );
    for (const word of VIETNAMESE_ONLY) assert.ok(!en.join("\n").includes(word), word);
  });

  test("Japanese honorifics: converted into xưng hô only for a Vietnamese target; kept on request for all", () => {
    assert.ok(languageBlock("ja", STYLE, VIETNAMESE).includes(JAPANESE_BLOCK.convertHonorificsVi));
    const english = languageBlock("ja", STYLE, ENGLISH);
    assert.ok(english.includes(JAPANESE_BLOCK.convertHonorifics));
    assert.ok(!english.includes(JAPANESE_BLOCK.convertHonorificsVi));
    for (const target of [VIETNAMESE, ENGLISH]) {
      const keep = languageBlock("ja", { ...STYLE, keepJaHonorifics: true }, target);
      assert.ok(keep.includes(JAPANESE_BLOCK.keepHonorifics), target.code);
      assert.ok(!keep.includes("- Turn -san"), target.code);
    }
  });

  test("Chinese: Hán Việt readings for Vietnamese, pinyin for other targets", () => {
    assert.equal(languageBlock("zh", STYLE, VIETNAMESE), CHINESE_BLOCK.vi);
    assert.ok(CHINESE_BLOCK.vi.includes("Hán Việt reading (林枫 -> Lâm Phong"));
    assert.equal(languageBlock("zh", STYLE, ENGLISH), CHINESE_BLOCK.other);
    assert.ok(CHINESE_BLOCK.other.includes("pinyin without tone marks (林枫 -> Lin Feng)"));
    assert.ok(!CHINESE_BLOCK.other.includes("Hán Việt"));
  });

  test("English and Spanish source blocks name the target; a Spanish source into Spanish is copied", () => {
    assert.ok(englishBlock(SPANISH).includes("translate into normal Spanish sentence case"));
    assert.equal(languageBlock("en", STYLE, FRENCH), englishBlock(FRENCH));
    const intoSpanish = spanishBlock(SPANISH);
    assert.ok(intoSpanish.includes("The source is already Spanish: keep it as is"));
    assert.ok(!intoSpanish.includes("inverted marks"));
    const intoEnglish = spanishBlock(ENGLISH);
    assert.ok(intoEnglish.includes("Drop the inverted marks ¡ ¿ unless English uses them."));
    assert.ok(intoEnglish.includes("tú/usted and vosotros/ustedes to fitting English forms of address"));
  });

  test("English, Spanish and French targets carry no Vietnamese-only rule, whatever the source language", () => {
    const series = {
      lang: "auto" as const,
      style: HAN_VIET,
      askSummary: true,
      pronouns: [{ a: "Mina", b: "Jun", aSelf: "I", aToB: "you" }],
    };
    for (const target of [ENGLISH, SPANISH, FRENCH]) {
      const { system } = buildPrompt(input({ ...series, target }), IMAGE);
      for (const word of VIETNAMESE_ONLY) assert.ok(!system.includes(word), `${target.code}: ${word}`);
      assert.ok(system.startsWith(systemIntro(target)), target.code);
      assert.ok(system.includes(`\n\n${styleBlock(target)}\n\n# Language rules\n## Korean`), target.code);
      assert.ok(system.includes(`@sum|<the story so far in ${target.name},`), target.code);
      assert.ok(system.endsWith("# Forms of address (keep consistent)\nMina -> Jun: I / you"), target.code);
    }
    const vi = buildPrompt(input({ ...series, target: VIETNAMESE }), IMAGE).system;
    assert.ok(vi.includes(KOREAN_BLOCK.hanViet));
    assert.ok(vi.includes(CHINESE_BLOCK.vi));
    assert.ok(vi.endsWith("# Xưng hô (keep consistent)\nMina -> Jun: I / you"));
  });

  test("the user text does not depend on the target", () => {
    const history: HistoryLine[] = [{ pos: 1, speaker: "Kai", original: "가자", translation: "Let's go." }];
    assert.equal(
      buildPrompt(input({ history, target: ENGLISH }), IMAGE).user,
      buildPrompt(input({ history, target: VIETNAMESE }), IMAGE).user,
    );
  });
});

describe("limits from settings.memory", () => {
  test("zero history or forms-of-address lines send none; the @sum request names the word cap", () => {
    const history: HistoryLine[] = [{ pos: 1, speaker: "Kai", original: "가자", translation: "Let's go." }];
    const pronouns = [{ a: "Mina", b: "Jun", aSelf: "I", aToB: "you" }];
    const none = buildPrompt(input({ history, pronouns }), IMAGE, { historyLines: 0, pronounLines: 0 });
    assert.equal(none.stats.historySent, 0);
    assert.equal(none.stats.pronounsSent, 0);
    assert.ok(!none.user.includes("Let's go."));
    const capped = buildPrompt(input({ askSummary: true }), IMAGE, { summaryWords: 25 });
    assert.ok(capped.system.includes(systemAskSummary(VIETNAMESE, 25)));
    assert.ok(capped.system.includes("at most 25 words"));
    assert.equal(systemAskSummary(VIETNAMESE), systemAskSummary(VIETNAMESE, PROMPT_LIMITS.summaryWords));
  });
});

describe("CJK targets (Japanese, Chinese, Korean)", () => {
  const JA: PromptTarget = { code: "ja", name: "Japanese" };
  const ZH_CN: PromptTarget = { code: "zh-cn", name: "Simplified Chinese" };
  const ZH_TW: PromptTarget = { code: "zh-tw", name: "Traditional Chinese" };
  const KO: PromptTarget = { code: "ko", name: "Korean" };
  const EN: PromptTarget = { code: "en", name: "English" };

  test("the target is named in the intro, the output format and the summary", () => {
    assert.ok(systemIntro(JA).includes("natural, spoken Japanese"));
    assert.ok(
      systemOutput(ZH_TW).includes("- translation: the Traditional Chinese translation of region n only"),
    );
    assert.ok(systemAskSummary(KO).includes("the story so far in Korean"));
    assert.deepEqual([JA, ZH_CN, ZH_TW, KO, EN, VIETNAMESE].map(isCjkPromptTarget), [
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  test("style: no rules about capitals or sentence case for scripts without letter case", () => {
    for (const target of [JA, ZH_CN, ZH_TW, KO]) {
      const style = styleBlock(target);
      assert.ok(
        style.startsWith(`# ${target.name} style
`),
        target.code,
      );
      assert.ok(!/capital|sentence case/iu.test(style), `${target.code}: ${style}`);
      assert.ok(style.includes(`${target.name} onomatopoeia`), target.code);
      assert.ok(style.includes(`written with ${target.name} punctuation`), target.code);
    }
    assert.ok(styleBlock(EN).includes("in capitals"), "Latin targets keep them");
    assert.ok(!englishBlock(JA).includes("sentence case"));
    assert.ok(!spanishBlock(KO).includes("sentence case"));
    assert.ok(englishBlock(EN).includes("English sentence case"));
  });

  test("names are spelled in the target's own script, never romanized", () => {
    assert.ok(cjkNamesLine(JA).includes("katakana"));
    assert.ok(cjkNamesLine(KO).includes("Hangul"));
    assert.ok(cjkNamesLine(ZH_TW).includes("Traditional Chinese characters"));
    const ko = languageBlock("ko", STYLE, JA);
    assert.ok(ko.includes(cjkNamesLine(JA)));
    assert.ok(!ko.includes("Revised Romanization"));
    const ja = languageBlock("ja", STYLE, ZH_CN);
    assert.ok(ja.includes(cjkNamesLine(ZH_CN)));
    assert.ok(!ja.includes("Hepburn"));
    const zh = languageBlock("zh", STYLE, JA);
    assert.ok(zh.includes("katakana") && !zh.includes("pinyin"));
    assert.equal(languageBlock("zh", STYLE, EN), CHINESE_BLOCK.other, "Latin targets unchanged");
  });

  test("a source already in the target's language is kept (Chinese in the target's characters)", () => {
    assert.equal(sameLanguageLine("ja", EN), null);
    assert.equal(sameLanguageLine("ko", JA), null);
    const ja = languageBlock("ja", STYLE, JA);
    assert.ok(ja.includes("The source is already Japanese: keep it as is"));
    assert.ok(!ja.includes("honorific") && !ja.includes("-san"), ja);
    assert.ok(languageBlock("ko", STYLE, KO).includes("The source is already Korean"));
    assert.ok(languageBlock("zh", STYLE, ZH_TW).includes("written in Traditional Chinese characters"));
  });

  test("a whole prompt into Japanese carries the Japanese style and no Vietnamese rules", () => {
    const messages = buildMessages(
      {
        target: JA,
        lang: "ko",
        n: 3,
        mode: "full",
        style: STYLE,
        glossary: [],
        pronouns: [],
        history: [],
        askSummary: false,
      },
      "data:image/jpeg;base64,AA==",
    );
    const content = messages[0]?.content;
    assert.equal(typeof content, "string");
    const system = typeof content === "string" ? content : "";
    assert.ok(system.includes("# Japanese style"));
    assert.ok(!system.includes("xưng hô"));
  });
});
