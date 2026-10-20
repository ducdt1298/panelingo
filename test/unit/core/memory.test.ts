// Series memory rules (src/shared/core/memory.ts): glossary learning, manual entries, ranking for the prompt,
// consistency flags, series profile patches and language votes, chapter summary and history selection.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ADDRESS_SWITCH_PACKS,
  applySeriesPatch,
  learnAddress,
  MAX_PRONOUN_CHARS,
  MAX_PRONOUN_RULES,
  promptPronouns,
  type AddressSighting,
  castLangVote,
  cleanText,
  confirmEntry,
  excessCandidates,
  historyBefore,
  isInconsistent,
  learnTerm,
  manualEntry,
  MAX_ALTERNATIVES,
  MAX_PACK_IDS,
  MAX_TERM_CHARS,
  newChapter,
  newSeriesProfile,
  nextSummary,
  promptGlossary,
  rankEntries,
  sameRendering,
  sanitizeSeriesPatch,
  shownTranslation,
  termKey,
  type TermSighting,
} from "../../../src/shared/core/memory.ts";
import type { GlossaryEntry } from "../../../src/shared/records.ts";
import type { PronounRule } from "../../../src/shared/types.ts";

const SERIES = "https://reader.example|lone-hunter";

function seen(original: string, translation: string, packId: string, at = 100, note = ""): TermSighting {
  return { original, translation, note, packId, at };
}

/** Feeds sightings in order, as the learner would (one call per pack). */
function learnAll(
  sightings: readonly TermSighting[],
  minPacks = 2,
  start?: GlossaryEntry,
): GlossaryEntry | undefined {
  let entry = start;
  for (const sighting of sightings) entry = learnTerm(SERIES, entry, sighting, minPacks) ?? entry;
  return entry;
}

function entry(
  orig: string,
  state: GlossaryEntry["state"],
  patch: Partial<GlossaryEntry> = {},
): GlossaryEntry {
  return {
    seriesKey: SERIES,
    orig,
    translation: `${orig}-t`,
    note: "",
    state,
    sightings: 1,
    packIds: ["p0"],
    alternatives: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    ...patch,
  };
}

describe("text helpers", () => {
  test("cleanText collapses whitespace, normalizes to NFC and cuts", () => {
    assert.equal(cleanText("  a \n\t b  ", 10), "a b");
    assert.equal(cleanText("é", 10), "é");
    assert.equal(cleanText("abcdef", 3), "abc");
    assert.equal(cleanText(42, 10), "");
    assert.equal(termKey(` ${"가".repeat(200)} `), "가".repeat(MAX_TERM_CHARS));
  });

  test("sameRendering ignores case, width and spacing", () => {
    assert.ok(sameRendering("Han  Jiho", "han jiho"));
    assert.ok(sameRendering("ＡＢＣ", "abc"));
    assert.ok(!sameRendering("Han Jiho", "Han Ji-ho"));
  });
});

describe("learnTerm", () => {
  test("a new @term is a candidate; a second pack makes it learned; the same pack never counts twice", () => {
    const first = learnTerm(SERIES, undefined, seen(" 한지호 ", "Han Jiho", "p1", 10, "MC"), 2);
    assert.deepEqual(first, {
      seriesKey: SERIES,
      orig: "한지호",
      translation: "Han Jiho",
      note: "MC",
      state: "candidate",
      sightings: 1,
      packIds: ["p1"],
      alternatives: [],
      firstSeenAt: 10,
      lastSeenAt: 10,
    });
    assert.ok(first !== null);
    assert.equal(learnTerm(SERIES, first, seen("한지호", "Han Jiho", "p1", 11), 2), null, "same pack");
    const second = learnTerm(SERIES, first, seen("한지호", "han jiho", "p2", 20), 2);
    assert.equal(second?.state, "learned");
    assert.equal(second?.sightings, 2);
    assert.deepEqual(second?.packIds, ["p1", "p2"]);
    assert.equal(second?.lastSeenAt, 20);
    assert.equal(second?.firstSeenAt, 10);
    assert.equal(second?.translation, "Han Jiho", "the stored spelling stays");
  });

  test("termMinSightings: 1 learns at once, 3 needs three distinct packs", () => {
    assert.equal(learnTerm(SERIES, undefined, seen("a", "A", "p1"), 1)?.state, "learned");
    const two = learnAll([seen("a", "A", "p1"), seen("a", "A", "p2")], 3);
    assert.equal(two?.state, "candidate");
    assert.equal(learnAll([seen("a", "A", "p3")], 3, two)?.state, "learned");
  });

  test("empty originals or renderings are ignored", () => {
    assert.equal(learnTerm(SERIES, undefined, seen("", "A", "p1"), 2), null);
    assert.equal(learnTerm(SERIES, undefined, seen("a", "  ", "p1"), 2), null);
  });

  test("pack ids keep the last 10", () => {
    const sightings = Array.from({ length: 14 }, (_, i) => seen("a", "A", `p${i}`, i));
    const learned = learnAll(sightings);
    assert.equal(learned?.sightings, 14);
    assert.equal(learned?.packIds.length, MAX_PACK_IDS);
    assert.equal(learned?.packIds[0], "p4");
  });

  test("manual and confirmed renderings are never changed by the model; sightings still count", () => {
    for (const state of ["manual", "confirmed"] as const) {
      const start = entry("한지호", state, { translation: "Han Ji-ho", note: "user note" });
      const next = learnAll(
        [seen("한지호", "Han Jiho", "p1", 50, "model note"), seen("한지호", "Han Jiho", "p2", 60)],
        2,
        start,
      );
      assert.equal(next?.state, state);
      assert.equal(next?.translation, "Han Ji-ho");
      assert.equal(next?.note, "user note");
      assert.equal(next?.sightings, 3);
      assert.deepEqual(
        next?.alternatives,
        [{ translation: "Han Jiho", count: 2 }],
        "disagreement stays visible",
      );
    }
  });

  test("a candidate follows the rendering the model gives most often", () => {
    const a = seen("민준", "Minjun", "p1", 1, "first");
    const b = (pack: string): TermSighting => seen("민준", "Min-jun", pack, 2, "second");
    const tied = learnAll([a, b("p2")]);
    assert.equal(tied?.translation, "Minjun", "a tie keeps the first rendering");
    assert.deepEqual(tied?.alternatives, [{ translation: "Min-jun", count: 1 }]);
    const switched = learnAll([b("p3")], 2, tied);
    assert.equal(switched?.translation, "Min-jun");
    assert.equal(switched?.note, "second");
    assert.deepEqual(switched?.alternatives, [{ translation: "Minjun", count: 1 }]);
    assert.equal(switched?.state, "learned");
  });

  test("a matching sighting fills an empty note; alternatives are capped", () => {
    const filled = learnAll([seen("a", "A", "p1"), seen("a", "A", "p2", 3, "a note")]);
    assert.equal(filled?.note, "a note");
    const many = learnAll(Array.from({ length: 12 }, (_, i) => seen("a", i === 0 ? "A" : `B${i}`, `p${i}`)));
    assert.ok((many?.alternatives.length ?? 0) <= MAX_ALTERNATIVES);
  });
});

describe("manual entries and confirmation", () => {
  test("manualEntry creates or replaces, keeping the sighting history", () => {
    assert.deepEqual(manualEntry(SERIES, undefined, { orig: " 길드 ", translation: " Hội ", note: "" }, 77), {
      seriesKey: SERIES,
      orig: "길드",
      translation: "Hội",
      note: "",
      state: "manual",
      sightings: 0,
      packIds: [],
      alternatives: [],
      firstSeenAt: 77,
      lastSeenAt: 77,
    });
    const learned = entry("한지호", "learned", {
      sightings: 4,
      alternatives: [
        { translation: "Han Ji-ho", count: 1 },
        { translation: "Jiho", count: 1 },
      ],
    });
    const replaced = manualEntry(
      SERIES,
      learned,
      { orig: "한지호", translation: "Han Ji-ho", note: "MC" },
      90,
    );
    assert.equal(replaced?.state, "manual");
    assert.equal(replaced?.sightings, 4);
    assert.equal(replaced?.firstSeenAt, 1);
    assert.deepEqual(
      replaced?.alternatives,
      [{ translation: "Jiho", count: 1 }],
      "the chosen rendering is no alternative",
    );
    assert.equal(manualEntry(SERIES, undefined, { orig: "a", translation: "", note: "" }, 1), null);
    assert.equal(manualEntry(SERIES, undefined, { orig: " ", translation: "x", note: "" }, 1), null);
  });

  test("confirmEntry accepts candidates and learned entries only", () => {
    assert.equal(confirmEntry(entry("a", "candidate"))?.state, "confirmed");
    assert.equal(confirmEntry(entry("a", "learned"))?.state, "confirmed");
    assert.equal(confirmEntry(entry("a", "manual")), null);
    assert.equal(confirmEntry(entry("a", "confirmed")), null);
    assert.equal(confirmEntry(undefined), null);
  });
});

describe("ranking, prompt glossary and consistency", () => {
  const entries = [
    entry("learned-old", "learned", { lastSeenAt: 1 }),
    entry("candidate", "candidate", { lastSeenAt: 99 }),
    entry("learned-new", "learned", { lastSeenAt: 5, note: "a note" }),
    entry("manual", "manual", { lastSeenAt: 0 }),
    entry("confirmed", "confirmed", { lastSeenAt: 3 }),
  ];

  test("rankEntries: manual, confirmed, learned, candidates; then most recently seen", () => {
    assert.deepEqual(
      rankEntries(entries).map((e) => e.orig),
      ["manual", "confirmed", "learned-new", "learned-old", "candidate"],
    );
  });

  test("promptGlossary never sends candidates and keeps notes only when set", () => {
    assert.deepEqual(promptGlossary(entries), [
      { original: "manual", translation: "manual-t", source: "manual" },
      { original: "confirmed", translation: "confirmed-t", source: "confirmed" },
      { original: "learned-new", translation: "learned-new-t", note: "a note", source: "learned" },
      { original: "learned-old", translation: "learned-old-t", source: "learned" },
    ]);
  });

  test("excessCandidates drops the least recently seen candidates beyond the cap", () => {
    const list = [
      entry("c1", "candidate", { lastSeenAt: 1 }),
      entry("c2", "candidate", { lastSeenAt: 3 }),
      entry("c3", "candidate", { lastSeenAt: 2 }),
      entry("m", "manual", { lastSeenAt: 0 }),
    ];
    assert.deepEqual(excessCandidates(list, 2), ["c1"]);
    assert.deepEqual(excessCandidates(list, 5), []);
  });

  test("isInconsistent: a glossary term in the original without its rendering in the translation", () => {
    const glossary = [
      entry("민준", "manual", { translation: "Minjun" }),
      entry("검", "learned", { translation: "Kiếm" }),
      entry("헌터", "candidate", { translation: "Thợ săn" }),
    ];
    assert.equal(isInconsistent(glossary, "민준아, 가자!", "Min-jun, đi thôi!"), true);
    assert.equal(
      isInconsistent(glossary, "민준아, 가자!", "MINJUN, đi thôi!"),
      false,
      "case does not matter",
    );
    assert.equal(isInconsistent(glossary, "가자!", "Đi thôi!"), false);
    assert.equal(
      isInconsistent(glossary, "검을 들어!", "Cầm gươm lên!"),
      false,
      "one-character terms are not checked",
    );
    assert.equal(isInconsistent(glossary, "헌터다!", "Là thợ!"), false, "candidates are not checked");
    assert.equal(isInconsistent(glossary, "민준", ""), false, "no translation, nothing to compare");
  });
});

describe("series profile", () => {
  test("a new profile starts on auto with summaries on", () => {
    const profile = newSeriesProfile(SERIES, "https://reader.example", "  Lone   Hunter ", 5);
    assert.equal(profile.title, "Lone Hunter");
    assert.equal(profile.lang, "auto");
    assert.equal(profile.summaryEnabled, true);
    assert.deepEqual(profile.style, { genre: "", koNames: "romanized", keepJaHonorifics: false });
    assert.equal(profile.createdAt, 5);
  });

  test("@lang votes settle the language after 2 agreeing packs, never over a set language", () => {
    let profile = newSeriesProfile(SERIES, "https://reader.example", "S", 0);
    profile = castLangVote(profile, "ko", 1);
    assert.equal(profile.lang, "auto", "one vote is not enough");
    profile = castLangVote(profile, "ja", 2);
    profile = castLangVote(profile, "ko", 3);
    assert.equal(profile.lang, "ko");
    assert.deepEqual(profile.langVotes, { ko: 2, ja: 1 });
    assert.equal(profile.updatedAt, 3);

    let tied = newSeriesProfile(SERIES, "https://reader.example", "S", 0);
    for (const lang of ["ko", "ja"] as const) tied = castLangVote(tied, lang, 1);
    assert.equal(tied.lang, "auto", "1:1 does not settle");
    tied = castLangVote({ ...tied, langVotes: { ko: 1, ja: 2 } }, "ko", 2);
    assert.equal(tied.lang, "auto", "2:2 does not settle either");

    const set = castLangVote(castLangVote({ ...tied, lang: "zh", langVotes: {} }, "ko", 1), "ko", 2);
    assert.equal(set.lang, "zh", "a language the user chose stays");
    assert.deepEqual(set.langVotes, { ko: 2 });
  });

  test("sanitizeSeriesPatch keeps user fields, ignores the rest and rejects wrong values", () => {
    assert.deepEqual(
      sanitizeSeriesPatch({
        title: "  T ",
        lang: "ja",
        readingDir: "rtl",
        style: { koNames: "han-viet", keepJaHonorifics: true, genre: " murim " },
        pronouns: [
          { a: "Minjun", b: "Seoyeon", aSelf: "tớ", aToB: "cậu" },
          { a: "", b: "x", aSelf: "", aToB: "" },
        ],
        summaryEnabled: false,
        notes: "n",
        seriesKey: "ignored",
        langVotes: { ko: 9 },
        createdAt: 1,
      }),
      {
        title: "T",
        lang: "ja",
        readingDir: "rtl",
        style: { genre: "murim", koNames: "han-viet", keepJaHonorifics: true },
        pronouns: [{ a: "Minjun", b: "Seoyeon", aSelf: "tớ", aToB: "cậu" }],
        summaryEnabled: false,
        notes: "n",
      },
    );
    assert.deepEqual(sanitizeSeriesPatch({}), {});
    for (const bad of [
      null,
      "x",
      [],
      { lang: "fr" },
      { readingDir: "up" },
      { style: "x" },
      { style: { koNames: "kana" } },
      { style: { keepJaHonorifics: "yes" } },
      { pronouns: "x" },
      { pronouns: [{ a: "a", b: "b" }] },
      { pronouns: Array.from({ length: 21 }, () => ({ a: "a", b: "b", aSelf: "", aToB: "" })) },
      { summaryEnabled: 1 },
      { title: 3 },
      { notes: {} },
    ]) {
      assert.equal(sanitizeSeriesPatch(bad), null, JSON.stringify(bad));
    }
  });

  test("applySeriesPatch merges the style; going back to auto clears the votes", () => {
    const profile = {
      ...newSeriesProfile(SERIES, "https://reader.example", "S", 0),
      lang: "ko" as const,
      langVotes: { ko: 3 },
    };
    const styled = applySeriesPatch(profile, { style: { koNames: "han-viet" } }, 9);
    assert.deepEqual(styled.style, { genre: "", koNames: "han-viet", keepJaHonorifics: false });
    assert.equal(styled.lang, "ko");
    assert.deepEqual(styled.langVotes, { ko: 3 });
    assert.equal(styled.updatedAt, 9);
    const auto = applySeriesPatch(profile, { lang: "auto" }, 10);
    assert.equal(auto.lang, "auto");
    assert.deepEqual(auto.langVotes, {});
    assert.deepEqual(profile.langVotes, { ko: 3 }, "the input is not mutated");
  });

  test("sanitizeSeriesPatch keeps a learned rule learned (the side panel sends every rule back)", () => {
    assert.deepEqual(
      sanitizeSeriesPatch({
        pronouns: [
          {
            a: "Minjun",
            b: "Seoyeon",
            aSelf: "tớ",
            aToB: "cậu",
            source: "learned",
            sightings: 2.7,
            updatedAt: 40,
            packIds: ["p1"],
            pending: { aSelf: "x", aToB: "y", packIds: ["p2"] },
          },
          { a: "Seoyeon", b: "Minjun", aSelf: "tớ", aToB: "cậu", source: "manual" },
          { a: "Jiho", b: "Yuna", aSelf: "anh", aToB: "em", source: "bogus", sightings: "9" },
        ],
      }),
      {
        pronouns: [
          {
            a: "Minjun",
            b: "Seoyeon",
            aSelf: "tớ",
            aToB: "cậu",
            source: "learned",
            sightings: 2,
            updatedAt: 40,
          },
          { a: "Seoyeon", b: "Minjun", aSelf: "tớ", aToB: "cậu", source: "manual" },
          { a: "Jiho", b: "Yuna", aSelf: "anh", aToB: "em" },
        ],
      },
    );
  });
});

describe("forms of address (@addr)", () => {
  const sighting = (packId: string, aSelf: string, aToB: string, at = 1): AddressSighting => ({
    a: "Minjun",
    b: "Seoyeon",
    aSelf,
    aToB,
    packId,
    at,
  });

  test("a new pair is learned at once; the same rendering counts once per request", () => {
    const first = learnAddress([], sighting("p1", "tớ", "cậu", 5));
    assert.deepEqual(first, [
      {
        a: "Minjun",
        b: "Seoyeon",
        aSelf: "tớ",
        aToB: "cậu",
        source: "learned",
        sightings: 1,
        packIds: ["p1"],
        updatedAt: 5,
      },
    ]);
    assert.ok(first !== null);
    assert.equal(
      learnAddress(first, sighting("p1", "tớ", "cậu", 6)),
      null,
      "the same request never counts twice",
    );
    const again = learnAddress(first, { ...sighting("p2", " Tớ ", "cậu", 7), a: "minjun" });
    assert.equal(again?.[0]?.sightings, 2, "names and renderings compare like glossary terms");
    assert.deepEqual(again?.[0]?.packIds, ["p1", "p2"]);
    assert.equal(again?.[0]?.updatedAt, 7);
    assert.equal(again?.[0]?.aSelf, "tớ", "the stored words stay as first written");
  });

  test(`a different rendering replaces a learned one only after ${ADDRESS_SWITCH_PACKS} requests agree`, () => {
    let rules = learnAddress([], sighting("p1", "tớ", "cậu")) ?? [];
    rules = learnAddress(rules, sighting("p2", "anh", "em", 2)) ?? [];
    assert.equal(rules[0]?.aSelf, "tớ", "one odd answer does not flip the pair");
    assert.deepEqual(rules[0]?.pending, { aSelf: "anh", aToB: "em", packIds: ["p2"] });
    assert.equal(
      learnAddress(rules, sighting("p2", "anh", "em", 3)),
      null,
      "the same request again is ignored",
    );
    const odd = learnAddress(rules, sighting("p3", "ta", "ngươi", 3)) ?? [];
    assert.deepEqual(
      odd[0]?.pending,
      { aSelf: "ta", aToB: "ngươi", packIds: ["p3"] },
      "a third rendering restarts",
    );
    rules = learnAddress(rules, sighting("p4", "anh", "em", 4)) ?? [];
    assert.deepEqual(rules, [
      {
        a: "Minjun",
        b: "Seoyeon",
        aSelf: "anh",
        aToB: "em",
        source: "learned",
        sightings: 2,
        packIds: ["p2", "p4"],
        updatedAt: 4,
      },
    ]);
    const confirmed = learnAddress(
      [{ ...rules[0]!, pending: { aSelf: "ta", aToB: "ngươi", packIds: ["p5"] } }],
      sighting("p6", "anh", "em", 6),
    );
    assert.equal(confirmed?.[0]?.pending, undefined, "the current rendering seen again drops the challenger");
  });

  test("a reader's rule is never changed, and empty or self pairs are ignored", () => {
    const manual: PronounRule[] = [{ a: "Minjun", b: "Seoyeon", aSelf: "tôi", aToB: "em" }];
    assert.equal(learnAddress(manual, sighting("p1", "tớ", "cậu")), null, "stored before learning existed");
    assert.equal(learnAddress([{ ...manual[0]!, source: "manual" }], sighting("p1", "tớ", "cậu")), null);
    assert.equal(learnAddress([], { ...sighting("p1", "tớ", "cậu"), b: " " }), null);
    assert.equal(learnAddress([], sighting("p1", "", "")), null);
    assert.equal(learnAddress([], { ...sighting("p1", "tớ", "cậu"), b: "minjun" }), null);
    const reverse = learnAddress(manual, { ...sighting("p1", "em", "anh"), a: "Seoyeon", b: "Minjun" });
    assert.equal(reverse?.length, 2, "the other direction is its own pair");
    assert.equal(
      learnAddress([], { ...sighting("p1", "tớ", "x".repeat(200)) })?.[0]?.aToB.length,
      MAX_PRONOUN_CHARS,
      "fields are cut like the side panel's",
    );
  });

  test(`at most ${MAX_PRONOUN_RULES} rules: the learned rule seen least recently goes, never a reader's`, () => {
    const manual: PronounRule = { a: "M", b: "N", aSelf: "tôi", aToB: "anh", source: "manual" };
    let rules: PronounRule[] = [manual];
    for (let i = 0; i < MAX_PRONOUN_RULES + 3; i += 1) {
      rules =
        learnAddress(rules, { a: `A${i}`, b: "B", aSelf: "tớ", aToB: "cậu", packId: `p${i}`, at: i + 1 }) ??
        [];
    }
    assert.equal(rules.length, MAX_PRONOUN_RULES);
    assert.ok(
      rules.some((rule) => rule.source === "manual"),
      "the reader's rule stays",
    );
    assert.ok(!rules.some((rule) => rule.a === "A0"), "the oldest learned pair went first");
    assert.ok(
      rules.some((rule) => rule.a === `A${MAX_PRONOUN_RULES + 2}`),
      "the newest pair is kept",
    );
  });

  test("promptPronouns: learned rules by last report, then the reader's rules (kept when the prompt is short)", () => {
    const rules: PronounRule[] = [
      { a: "R", b: "S", aSelf: "tôi", aToB: "anh" },
      {
        a: "L2",
        b: "S",
        aSelf: "tớ",
        aToB: "cậu",
        source: "learned",
        updatedAt: 9,
        sightings: 3,
        packIds: ["p"],
      },
      { a: "L1", b: "S", aSelf: "ta", aToB: "ngươi", source: "learned", updatedAt: 2 },
      { a: "M", b: "S", aSelf: "con", aToB: "mẹ", source: "manual" },
    ];
    assert.deepEqual(promptPronouns(rules), [
      { a: "L1", b: "S", aSelf: "ta", aToB: "ngươi" },
      { a: "L2", b: "S", aSelf: "tớ", aToB: "cậu" },
      { a: "R", b: "S", aSelf: "tôi", aToB: "anh" },
      { a: "M", b: "S", aSelf: "con", aToB: "mẹ" },
    ]);
    assert.deepEqual(
      promptPronouns(rules, ["", " l1 "]).map((rule) => rule.a),
      ["L2", "L1", "R", "M"],
      "pairs of the chapter's recent speakers are kept first when the prompt is short of room",
    );
  });
});

describe("chapter summary and history", () => {
  test("nextSummary replaces the summary only from a pack further down the chapter", () => {
    const chapter = newChapter("https://reader.example/c/1", SERIES, "https://reader.example/c/1", "Ch 1", 0);
    assert.equal(chapter.summaryPos, -1);
    const first = nextSummary(chapter, "  Minjun meets\nSeoyeon. ", 2_005, 60);
    assert.deepEqual(first && { summary: first.summary, summaryPos: first.summaryPos }, {
      summary: "Minjun meets Seoyeon.",
      summaryPos: 2_005,
    });
    assert.ok(first !== null);
    assert.equal(nextSummary(first, "Older part.", 1_000, 60), null);
    assert.equal(nextSummary(first, "Same part.", 2_005, 60), null);
    assert.equal(nextSummary(first, "  ", 3_000, 60), null);
    assert.equal(nextSummary(first, "one two three four", 3_000, 2)?.summary, "one two…");
  });

  test("shownTranslation: the manual edit, else an accepted AI line, else nothing", () => {
    assert.equal(
      shownTranslation({ manual: 1, manualTranslation: "edit", status: "manual", translation: "ai" }),
      "edit",
    );
    assert.equal(
      shownTranslation({ manual: 0, manualTranslation: null, status: "ok", translation: "ai" }),
      "ai",
    );
    assert.equal(
      shownTranslation({ manual: 0, manualTranslation: null, status: "error", translation: "ai" }),
      "",
    );
  });

  test("historyBefore: earlier lines in page then reading order, the last N, without sfx and empty lines", () => {
    const line = (order: number, translation: string, type: "dialogue" | "sfx" | "ignore" = "dialogue") => ({
      order,
      type,
      speaker: order === 0 ? "Minjun" : "",
      original: `o${order}`,
      translation,
    });
    const pages = [
      { docOrder: 3, lines: [line(1, "c1"), line(0, "c0"), line(2, "c2")] },
      { docOrder: 1, lines: [line(0, "a0"), line(1, "BOOM", "sfx"), line(2, ""), line(3, "a3", "ignore")] },
      { docOrder: 2, lines: [line(0, "b0")] },
    ];
    const all = historyBefore(pages, 3_002, 10);
    assert.deepEqual(
      all.map((l) => [l.pos, l.translation]),
      [
        [1_000, "a0"],
        [2_000, "b0"],
        [3_000, "c0"],
        [3_001, "c1"],
      ],
    );
    assert.equal(all[0]?.speaker, "Minjun");
    assert.deepEqual(
      historyBefore(pages, 3_002, 2).map((l) => l.translation),
      ["c0", "c1"],
      "the newest lines win",
    );
    assert.deepEqual(historyBefore(pages, 3_002, 0), []);
    assert.deepEqual(historyBefore(pages, 1_000, 5), [], "nothing before the first line");
  });
});
