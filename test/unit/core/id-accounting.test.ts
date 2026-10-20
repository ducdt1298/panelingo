import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  compareKey,
  createAccountant,
  isMergeSuspect,
  judgeItem,
  MAX_ADDRESSES,
  MAX_TERMS,
  type Outcome,
} from "../../../src/shared/core/id-accounting.ts";
import { parseLine, type ItemRec, type Rec } from "../../../src/shared/core/line-parser.ts";

/** The item record of a parsed line. */
function item(parsed: Rec): ItemRec {
  assert.equal(parsed.kind, "item");
  return parsed;
}

function rec(
  id: number,
  translation: string,
  original = "원본 문장",
  type: ItemRec["type"] = "dialogue",
): ItemRec {
  return {
    kind: "item",
    id,
    type,
    speaker: "",
    original,
    translation,
    raw: `#${id}|${type}||${original}|${translation}`,
  };
}

function status(outcome: Outcome | undefined): string {
  if (outcome === undefined) {
    return "undefined";
  }
  return outcome.status === "missing" ? `missing:${outcome.reason}` : outcome.status;
}

describe("judgeItem (validation order)", () => {
  const cases: Array<[string, ItemRec, string]> = [
    ["type ignore", rec(1, "", "", "ignore"), "ignore"],
    ["ignore wins over content", rec(1, "Xin chào", "watermark.example", "ignore"), "ignore"],
    ["empty translation", rec(1, "   "), "missing:empty"],
    ["no letters, original has none", rec(1, "...", "…"), "keep-original"],
    ["digits only on both sides", rec(1, "2049", "2049"), "keep-original"],
    ["no letters, original has letters", rec(1, "!!", "쾅"), "missing:no-letters"],
    ["same as original (case, punctuation, spaces)", rec(1, "OK!", "ok"), "keep-original"],
    ["same as original (NFKC full-width)", rec(1, "ＯＫ", "OK"), "keep-original"],
    ["Latin name kept", rec(1, "Zorvik", "ZORVIK"), "keep-original"],
    // Plan §5.10: rule 6 (equal to the original → keep-original) runs before rule 7 (wrong script).
    [
      "echoed Hangul is keep-original (rule 6 before rule 7)",
      rec(1, "비가 와요!", "비가 와요"),
      "keep-original",
    ],
    ["echoed kanji is keep-original", rec(1, "東京", "東京"), "keep-original"],
    [
      "Hangul that is not the original is wrong-script",
      rec(1, "우산이 없어", "비가 와요"),
      "missing:wrong-script",
    ],
    ["more than 3 CJK letters", rec(1, "Đây là cửa hàng 甜品小店 mới mở", "가게"), "missing:wrong-script"],
    ["more than 20% CJK letters", rec(1, "Ừ 好的", "응"), "missing:wrong-script"],
    ["short Han annotation passes", rec(1, "Đây là Mặc Viên (墨园) đó", "这是墨园"), "ok"],
    [
      "Vietnamese refusal about the content",
      rec(1, "Xin lỗi, tôi không thể dịch nội dung này."),
      "missing:refusal",
    ],
    ["English refusal", rec(1, "I'm sorry, but I can't help with that."), "missing:refusal"],
    ["a character saying sorry is dialogue", rec(1, "Xin lỗi, nhưng tôi không thể giúp cậu."), "ok"],
    ["plain translation", rec(1, "Trời mưa rồi."), "ok"],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      assert.equal(status(judgeItem(input)), expected);
    });
  }

  test("compareKey: NFKC, lower case, no punctuation or spaces", () => {
    assert.equal(compareKey(" Ｈｅｌｌｏ, World! "), "helloworld");
    assert.equal(compareKey("“Kai…”"), "kai");
  });
});

describe("createAccountant", () => {
  test("happy path: every id once, [DONE] → complete", () => {
    const acc = createAccountant(3, "ko");
    for (const line of [
      "@lang|ko",
      "#1|dialogue|Zorvik|비가 와요|Trời mưa rồi.",
      "#2|sfx||쾅|RẦM!",
      "#3|ignore|||",
    ]) {
      acc.accept(parseLine(line));
    }
    const out = acc.finish(true);
    assert.deepEqual(out.missing, []);
    assert.equal(out.truncated, false);
    assert.equal(out.partial, false);
    assert.equal(out.idCoverage, 1);
    assert.equal(out.received, 3);
    assert.equal(out.lang, "ko");
    assert.equal(out.langReported, true);
    assert.deepEqual(
      [...out.byId.entries()].map(([id, outcome]) => `${id}:${status(outcome)}`),
      ["1:ok", "2:ok", "3:ignore"],
    );
  });

  test("accept returns the outcome for items and null otherwise", () => {
    const acc = createAccountant(2);
    assert.equal(status(acc.accept(rec(1, "Một")) ?? undefined), "ok");
    assert.equal(acc.accept(rec(1, "lần hai")), null, "duplicate");
    assert.equal(acc.accept(rec(7, "ngoài")), null, "unknown");
    assert.equal(acc.accept(parseLine("@lang|ja")), null);
    assert.equal(acc.accept(parseLine("random prose")), null);
  });

  test("duplicates: first wins; unknown and out-of-range ids are ignored", () => {
    const acc = createAccountant(3);
    const lines: Rec[] = [
      rec(1, "Lần đầu"),
      rec(1, "Lần sau"),
      rec(0, "số không"),
      rec(4, "quá N"),
      rec(999, "rất xa"),
      rec(2, "Hai"),
      rec(2, "Hai lần nữa"),
    ];
    for (const line of lines) {
      acc.accept(line);
    }
    const out = acc.finish(true);
    const first = out.byId.get(1);
    assert.equal(first?.status === "ok" ? first.rec.translation : null, "Lần đầu");
    assert.deepEqual(out.duplicates, [1, 2]);
    assert.deepEqual(out.unknown, [0, 4, 999]);
    assert.deepEqual(out.missing, [3]);
    assert.equal(status(out.byId.get(3)), "missing:absent");
  });

  test("[DONE] with missing ids is partial; no [DONE] is truncated", () => {
    const partial = createAccountant(4);
    partial.accept(rec(1, "Một"));
    partial.accept(rec(3, "Ba"));
    const done = partial.finish(true);
    assert.equal(done.partial, true);
    assert.equal(done.truncated, false);
    assert.deepEqual(done.missing, [2, 4]);
    assert.equal(done.idCoverage, 0.5);

    const cut = createAccountant(2);
    cut.accept(rec(1, "Một"));
    const truncated = cut.finish(false);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.partial, false);
    assert.deepEqual(truncated.missing, [2]);
  });

  test("keep-original and ignore count as resolved in idCoverage", () => {
    const acc = createAccountant(4);
    acc.accept(rec(1, "OK", "OK"));
    acc.accept(rec(2, "", "", "ignore"));
    acc.accept(rec(3, "Ba"));
    acc.accept(rec(4, ""));
    const out = acc.finish(true);
    assert.deepEqual(out.missing, [4]);
    assert.equal(out.idCoverage, 0.75);
  });

  test("suspect-merge: a long translation whose next id is missing", () => {
    const long =
      "Hôm nay trời mưa to quá nên tớ ở nhà đọc truyện và chờ Zorvik gọi điện cho tớ suốt cả buổi chiều.";
    const acc = createAccountant(6);
    acc.accept(rec(1, "Một", "하나"));
    acc.accept(rec(2, long, "비가 와요")); // 3 is missing → suspect
    acc.accept(rec(4, long, "비가 와요")); // 5 present → fine
    acc.accept(rec(5, "Năm", "다섯"));
    acc.accept(rec(6, long, "비가 와요")); // last id → never suspect
    const out = acc.finish(true);
    assert.deepEqual(out.suspects, [2]);
    const suspect = out.byId.get(2);
    assert.equal(suspect?.status === "ok" ? suspect.suspect : null, "merge");
    assert.equal(status(out.byId.get(4)), "ok");
    assert.deepEqual(out.missing, [3]);
    // A translation up to max(60, 4 × original) is not suspicious.
    const short = createAccountant(2);
    short.accept(rec(1, "x".repeat(60), "y"));
    assert.deepEqual(short.finish(true).suspects, []);
    const ratio = createAccountant(2);
    ratio.accept(
      rec(1, "Một câu dài vừa phải cho một bản gốc dài, không có gì đáng ngờ ở đây cả.", "z".repeat(20)),
    );
    assert.deepEqual(ratio.finish(true).suspects, []);
  });

  test("pack-level refusal: no item and refusal text in the junk", () => {
    const acc = createAccountant(3);
    acc.accept(parseLine("I'm sorry, but I can't assist with this request."));
    const out = acc.finish(true);
    assert.equal(out.refusal, true);
    assert.equal(out.received, 0);
    assert.equal(out.junkLines, 1);
    assert.deepEqual(out.missing, [1, 2, 3]);

    const viaArgument = createAccountant(2).finish(false, ["Xin lỗi, tôi không thể hỗ trợ yêu cầu này."]);
    assert.equal(viaArgument.refusal, true, "junk lines passed to finish() count too");

    const withItems = createAccountant(2);
    withItems.accept(rec(1, "Một"));
    withItems.accept(parseLine("I'm sorry for the delay."));
    assert.equal(withItems.finish(true).refusal, false, "never by position: items arrived");
  });

  test("pack-level refusal from a content-filter upstream error", () => {
    const acc = createAccountant(2);
    acc.accept(rec(1, "Một"));
    const filtered = acc.finish(false, [], {
      upstreamError: "The response was filtered due to the prompt triggering the content management policy.",
    });
    assert.equal(filtered.refusal, true);
    assert.equal(
      createAccountant(1).finish(false, [], { upstreamError: "The server had an error (HTTP 503)" }).refusal,
      false,
    );
  });

  test("garbage without refusal is not a refusal", () => {
    const acc = createAccountant(2);
    acc.accept(parseLine("Here is some unrelated text."));
    acc.accept(parseLine("```"));
    const out = acc.finish(true);
    assert.equal(out.refusal, false);
    assert.equal(out.received, 0);
  });

  test("@lang (first wins), srcLang fallback, @term dedupe and cap, @sum (last wins)", () => {
    const acc = createAccountant(1, "ko");
    acc.accept(parseLine("@lang|ja"));
    acc.accept(parseLine("@lang|zh"));
    acc.accept(parseLine("@term|Plimba|Plimba|tên tiệm"));
    acc.accept(parseLine("@term|PLIMBA|Plim|trùng"));
    acc.accept(parseLine("@term||rỗng|bỏ"));
    acc.accept(parseLine("@term|Kestrin||thiếu vi"));
    for (let i = 0; i < 20; i += 1) {
      acc.accept(parseLine(`@term|Tên${i}|Ten${i}|`));
    }
    acc.accept(parseLine("@sum|Bản tóm tắt cũ."));
    acc.accept(parseLine("@sum|Zorvik quên ô ở tiệm Plimba."));
    const out = acc.finish(true);
    assert.equal(out.lang, "ja");
    assert.equal(out.langReported, true);
    assert.equal(out.terms.length, MAX_TERMS);
    assert.deepEqual(out.terms[0], { original: "Plimba", translation: "Plimba", note: "tên tiệm" });
    assert.equal(out.summary, "Zorvik quên ô ở tiệm Plimba.");

    const fallback = createAccountant(1, "ko").finish(true);
    assert.equal(fallback.lang, "ko");
    assert.equal(fallback.langReported, false);
    assert.equal(createAccountant(1, "auto").finish(true).lang, null);
    assert.equal(createAccountant(1).finish(true).summary, null);
  });

  test("a long translation without a transcription (fast mode) is never a merge suspect", () => {
    const long = "Đây là một câu thoại rất dài để thử xem bản dịch có bị nghi là gộp hai ô hay không nhé.";
    assert.equal(isMergeSuspect(item(parseLine(`#1|dialogue|${long}`, true))), false);
    assert.equal(isMergeSuspect(item(parseLine(`#1|dialogue||짧다|${long}`))), true);
  });

  test("@addr: pairs deduped (first wins), incomplete ones dropped, capped", () => {
    const acc = createAccountant(1, "ko");
    acc.accept(parseLine("@addr|Zorvik|Kai|tớ|cậu"));
    acc.accept(parseLine("@addr|zorvik|KAI|ta|ngươi"));
    acc.accept(parseLine("@addr|Kai|Zorvik|tớ|cậu"));
    acc.accept(parseLine("@addr||Kai|tớ|cậu"));
    acc.accept(parseLine("@addr|Mina|Kai||"));
    for (let i = 0; i < 12; i += 1) acc.accept(parseLine(`@addr|A${i}|B|tôi|anh`));
    const out = acc.finish(true);
    assert.equal(out.addresses.length, MAX_ADDRESSES);
    assert.deepEqual(out.addresses.slice(0, 2), [
      { a: "Zorvik", b: "Kai", aSelf: "tớ", aToB: "cậu" },
      { a: "Kai", b: "Zorvik", aSelf: "tớ", aToB: "cậu" },
    ]);
    assert.deepEqual(createAccountant(1).finish(true).addresses, []);
  });

  test("an empty request is fully covered", () => {
    const out = createAccountant(0).finish(true);
    assert.equal(out.idCoverage, 1);
    assert.deepEqual(out.missing, []);
  });
});

describe("judgeItem: the wrong-script check follows the target language", () => {
  test("a correct Japanese, Chinese or Korean translation is ok for its own target", () => {
    assert.equal(status(judgeItem(rec(1, "七時に駅の前で会おう。"), "ja")), "ok");
    assert.equal(status(judgeItem(rec(1, "七点在车站门口见。"), "zh-cn")), "ok");
    assert.equal(status(judgeItem(rec(1, "七點在車站門口見。"), "zh-tw")), "ok");
    assert.equal(status(judgeItem(rec(1, "일곱 시에 보자.", "七時に会おう。"), "ko")), "ok");
    assert.equal(status(judgeItem(rec(1, "OKだよ、Minjunくん！"), "ja")), "ok", "Latin names and words pass");
  });

  test("a script the target does not use is still wrong-script", () => {
    assert.equal(status(judgeItem(rec(1, "우산이 없어", "傘がない"), "ja")), "missing:wrong-script");
    assert.equal(status(judgeItem(rec(1, "傘がないよ", "우산이 없어"), "zh-cn")), "missing:wrong-script");
    assert.equal(status(judgeItem(rec(1, "かさがない", "우산이 없어"), "ko")), "missing:wrong-script");
    assert.equal(status(judgeItem(rec(1, "七点在车站门口见。"), "vi")), "missing:wrong-script");
    assert.equal(
      status(judgeItem(rec(1, "七点在车站门口见。"))),
      "missing:wrong-script",
      "default target vi",
    );
  });

  test("an echo of the original stays keep-original for every target", () => {
    for (const target of ["ja", "zh-tw", "ko", "en"]) {
      assert.equal(status(judgeItem(rec(1, "東京！", "東京"), target)), "keep-original", target);
    }
  });

  test("createAccountant passes its target to every line", () => {
    const ja = createAccountant(1, "ko", "ja");
    const outcome = ja.accept({ ...rec(1, "七時に会おう。", "일곱 시에 보자"), kind: "item", raw: "" });
    assert.equal(status(outcome ?? undefined), "ok");
    const vi = createAccountant(1, "ko");
    assert.equal(
      status(
        vi.accept({ ...rec(1, "七時に会おう。", "일곱 시에 보자"), kind: "item", raw: "" }) ?? undefined,
      ),
      "missing:wrong-script",
    );
  });
});
