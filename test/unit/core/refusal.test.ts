import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hasLetter,
  isContentFilterMessage,
  isItemRefusal,
  isRefusalText,
  isWrongScript,
  scriptStats,
} from "../../../src/shared/core/refusal.ts";

describe("isRefusalText (pack level, B.7.2 patterns)", () => {
  const refusals = [
    "I'm sorry, but I can't help with that.",
    "I’m sorry, I cannot translate this image.",
    "Im sorry",
    "I am sorry, I can not assist with this request.",
    "I can't assist with that.",
    "I'm unable to assist with that.",
    "I’m unable to help with this request.",
    "I'm not able to translate this image.",
    "I am not able to help.",
    "I won't be able to process this.",
    "As an AI, I must decline.",
    "This request violates the content policy.",
    "Xin lỗi, nhưng tôi không thể giúp với yêu cầu này.",
    "Xin lỗi tôi không thể làm điều đó.",
    "Tôi không thể hỗ trợ việc này.",
    "TÔI KHÔNG THỂ DỊCH",
    "The response was filtered: content_filter",
  ];
  for (const text of refusals) {
    test(`refusal: ${text}`, () => {
      assert.equal(isRefusalText(text), true);
    });
  }

  test("decomposed (NFD) Vietnamese still matches", () => {
    assert.equal(isRefusalText("Xin lỗi, nhưng tôi không thể giúp.".normalize("NFD")), true);
  });

  const ordinary = ["Trời mưa rồi.", "Zorvik đâu rồi?", "Sorry!", "I can help you.", "Tôi có thể giúp cậu."];
  for (const text of ordinary) {
    test(`not a refusal: ${text}`, () => {
      assert.equal(isRefusalText(text), false);
    });
  }
});

describe("isItemRefusal (single translation, stricter)", () => {
  test("English refusals and 'cannot translate' always count", () => {
    assert.equal(isItemRefusal("I'm sorry, but I can't help with that."), true);
    assert.equal(isItemRefusal("Xin lỗi, tôi không thể dịch đoạn này."), true);
    assert.equal(isItemRefusal("Bị chặn bởi content filter"), true);
  });

  test("Vietnamese 'cannot help' needs a reference to the request, the content or the AI", () => {
    assert.equal(isItemRefusal("Xin lỗi, nhưng tôi không thể hỗ trợ yêu cầu này."), true);
    assert.equal(isItemRefusal("Tôi không thể giúp với nội dung này."), true);
    assert.equal(isItemRefusal("Xin lỗi, là một AI tôi không thể giúp."), true);
    assert.equal(isItemRefusal("Xin lỗi, nhưng tôi không thể giúp cậu."), false);
    assert.equal(isItemRefusal("Xin lỗi, tôi không thể giúp ai cả."), false, "lower-case 'ai' means 'who'");
  });
});

describe("isContentFilterMessage", () => {
  test("Azure OpenAI content-filter markers", () => {
    for (const text of [
      "content_filter",
      "Content filter triggered",
      "ResponsibleAIPolicyViolation",
      "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
    ]) {
      assert.equal(isContentFilterMessage(text), true, text);
    }
    assert.equal(isContentFilterMessage("upstream_503"), false);
    assert.equal(isContentFilterMessage("context_length_exceeded"), false);
  });
});

describe("script statistics", () => {
  test("scriptStats counts letters, CJK and Latin", () => {
    assert.deepEqual(scriptStats("Ừ, 好的! 123"), { letters: 3, cjk: 2, latin: 1 });
    assert.deepEqual(scriptStats("ㅋㅋ ドン"), { letters: 4, cjk: 4, latin: 0 });
    assert.deepEqual(scriptStats("..."), { letters: 0, cjk: 0, latin: 0 });
  });

  test("hasLetter", () => {
    assert.equal(hasLetter("?!..."), false);
    assert.equal(hasLetter("2049"), false);
    assert.equal(hasLetter("RẦM"), true);
    assert.equal(hasLetter("쾅"), true);
  });

  test("isWrongScript: > 3 CJK letters or > 20% of the letters", () => {
    assert.equal(isWrongScript("Trời mưa rồi."), false);
    assert.equal(isWrongScript("Đây là Mặc Viên (墨园) đó"), false, "2 of 16 letters");
    assert.equal(isWrongScript("Một hai ba bốn năm sáu bảy tám (甜品小店)"), true, "4 CJK letters");
    assert.equal(isWrongScript("Ừ 好的"), true, "2 of 3 letters");
    assert.equal(isWrongScript("ハイ"), true);
    assert.equal(isWrongScript("!!!"), false);
  });
});

describe("isWrongScript per target", () => {
  test("Latin targets reject Hangul, Han and Kana; CJK targets only the scripts they do not use", () => {
    assert.equal(isWrongScript("七時に駅の前で会おう。", "en"), true);
    assert.equal(isWrongScript("七時に駅の前で会おう。", "ja"), false);
    assert.equal(isWrongScript("七点在车站门口见。", "zh-cn"), false);
    assert.equal(isWrongScript("七時に駅の前で会おう。", "zh-cn"), true, "kana in a Chinese translation");
    assert.equal(isWrongScript("일곱 시에 역 앞에서 보자.", "ko"), false);
    assert.equal(isWrongScript("일곱 시에 역 앞에서 보자.", "ja"), true, "Hangul in a Japanese translation");
    assert.equal(isWrongScript("七時に会おう", "ko"), true, "kana in a Korean translation");
    assert.equal(isWrongScript("約束(約束)は七時", "ko"), false, "Han is allowed in Korean text");
    assert.equal(isWrongScript("Trời mưa rồi."), false, "the default target is Vietnamese");
  });
});
