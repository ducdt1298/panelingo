import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { estimateTokens } from "../../../src/shared/core/tokens.ts";

describe("estimateTokens (B.5.4: Latin chars/4, Vietnamese chars/3, CJK 1 per char)", () => {
  test("empty text", () => {
    assert.equal(estimateTokens(""), 0);
  });

  test("Latin text: 4 characters per token, rounded up", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens("Keep numbers. No translator notes."), Math.ceil(34 / 4));
  });

  test("CJK: one token per character", () => {
    assert.equal(estimateTokens("비가와요"), 4);
    assert.equal(estimateTokens("三年后"), 3);
    assert.equal(estimateTokens("ドン"), 2);
    assert.equal(estimateTokens("。、！"), 3, "CJK and full-width punctuation");
  });

  test("Vietnamese lines: 3 characters per token", () => {
    const line = "Hôm nay trời mưa to quá";
    assert.equal(estimateTokens(line), Math.ceil(line.length / 3));
    // Unaccented words in a Vietnamese line still count at the Vietnamese rate.
    const mixed = "Xin chao cac ban, tớ là Zorvik";
    assert.equal(estimateTokens(mixed), Math.ceil(mixed.length / 3));
  });

  test("an English line with one accented loan word stays Latin", () => {
    const line = "The café on the corner sells bread and cakes";
    assert.equal(estimateTokens(line), Math.ceil(line.length / 4));
  });

  test("mixed CJK and Vietnamese in one line", () => {
    // "Zorvik: " + "비가 와요" + " => " + "Trời mưa rồi."
    const line = "Zorvik: 비가 와요 => Trời mưa rồi.";
    const cjk = 4;
    const rest = [...line].length - cjk;
    assert.equal(estimateTokens(line), Math.ceil(cjk + rest / 3));
  });

  test("lines are classified separately and line breaks count", () => {
    const english = "Plain text lines only.";
    const vietnamese = "Trời mưa rồi, về nhà thôi.";
    const both = `${english}\n${vietnamese}`;
    assert.equal(estimateTokens(both), Math.ceil(english.length / 4 + vietnamese.length / 3 + 1 / 4));
  });

  test("monotonic in practice: more text, more tokens", () => {
    let previous = 0;
    let text = "";
    for (let i = 0; i < 50; i += 1) {
      text += i % 2 === 0 ? "Zorvik đi chợ. " : "비가 와요. ";
      const tokens = estimateTokens(text);
      assert.ok(tokens >= previous);
      previous = tokens;
    }
  });
});
