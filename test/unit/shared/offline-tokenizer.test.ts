// Offline mode tokenizer (src/shared/offline/tokenizer.ts): tokenizer.json Unigram (Marian / Opus-MT) and BPE
// (NLLB-200) models, normalizers, pre-tokenizers and the Metaspace decoder, on two small synthetic tokenizer.json
// fixtures (test/fixtures/offline). When the pinned files are in .cache/offline-models (npm run fetch-models --
// --offline) the real tokenizers are checked too: NLLB-200 against the ids of the reference sentence in the
// transformers test suite, Marian against an exhaustive search for the best segmentation.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { loadTokenizer, cleanUpSpaces, type Tokenizer } from "../../../src/shared/offline/tokenizer.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/offline/${name}`, import.meta.url), "utf8"));

const CACHE = new URL("../../../.cache/offline-models/", import.meta.url);
const MARIAN_KO_EN = new URL(
  "Xenova/opus-mt-ko-en/d9fa1ac6008242100fecb4fff9b0a5917a1be81f/tokenizer.json",
  CACHE,
);
const NLLB = new URL(
  "Xenova/nllb-200-distilled-600M/261c31d1a5732c67cdd16d80e8d6088507c7ccea/tokenizer.json",
  CACHE,
);

describe("Unigram (Marian-style tokenizer.json)", () => {
  const tok = loadTokenizer(fixture("tokenizer-unigram.json"));

  test("words get a ▁ prefix and the most probable pieces", () => {
    assert.deepEqual(tok.tokenize("hello world!"), ["▁hello", "▁world", "!"]);
    assert.deepEqual(tok.encode("hello world!"), [4, 7, 8]);
    assert.deepEqual(tok.encode("안녕하세요"), [19, 20]);
    assert.deepEqual(tok.encode("  hello   world! "), [4, 7, 8], "whitespace runs split words only");
  });

  test("unknown characters become one <unk> (the vocabulary's, not the export's wrong unk_id)", () => {
    assert.equal(tok.unkId, 1);
    assert.deepEqual(tok.encode("x"), [3, 1]);
    assert.deepEqual(tok.encode("xyz"), [3, 1], "consecutive unknowns are fused");
    assert.deepEqual(tok.encode("hello xyz!"), [4, 3, 1, 8]);
  });

  test("special tokens in the text are never matched (no control-token injection from OCR)", () => {
    assert.ok(!tok.encode("</s>").includes(0));
    assert.ok(!tok.encode("<pad>").includes(9));
    assert.deepEqual(tok.encode(""), []);
  });

  test("decode: ▁ to spaces without the first, special tokens skipped; round trip", () => {
    assert.equal(tok.decode([4, 7, 8]), "hello world!");
    assert.equal(tok.decode([4, 0, 9]), "hello");
    for (const text of ["hello world!", "안녕하세요", "hello world."]) {
      assert.equal(tok.decode(tok.encode(text)), text, text);
    }
    assert.equal(tok.tokenToId("▁world"), 7);
    assert.equal(tok.idToToken(8), "!");
    assert.ok(tok.specialIds.has(0) && tok.specialIds.has(9) && !tok.specialIds.has(4));
  });

  test("the segmentation is the best one (exhaustive search)", () => {
    for (const word of ["▁hello", "▁world!", "▁helloworld", "▁안녕하세요", "▁hellxo"]) {
      assert.equal(
        viterbiScore(tok, fixture("tokenizer-unigram.json"), word),
        bestScore(fixture("tokenizer-unigram.json"), word),
        word,
      );
    }
  });
});

describe("BPE (NLLB-style tokenizer.json)", () => {
  const tok = loadTokenizer(fixture("tokenizer-bpe.json"));

  test("merges apply by rank, inside each ▁-word", () => {
    assert.deepEqual(tok.tokenize("abc"), ["▁ab", "c"]);
    assert.deepEqual(tok.encode("abc"), [10, 7]);
    assert.deepEqual(tok.encode("a"), [8]);
    assert.deepEqual(tok.encode("c ab"), [13, 10]);
  });

  test("normalizer: runs of spaces collapse; unknown characters fuse into one <unk>", () => {
    assert.deepEqual(tok.encode("a  b"), [8, 4, 6]);
    assert.deepEqual(tok.encode("xy"), [4, 3]);
    assert.deepEqual(tok.encode("a xy"), [8, 4, 3]);
  });

  test("language codes are special: never produced from text, dropped when decoding", () => {
    assert.equal(tok.tokenToId("eng_Latn"), 14);
    assert.ok(!tok.encode("eng_Latn").includes(14));
    assert.equal(tok.decode([15, 10, 7, 2]), "abc");
    assert.equal(tok.decode(tok.encode("abc a c")), "abc a c");
  });
});

test("cleanUpSpaces removes spaces before punctuation and in English contractions", () => {
  assert.equal(cleanUpSpaces("Wait , I do n't know !"), "Wait, I don't know!");
  assert.equal(cleanUpSpaces("it 's here ."), "it's here.");
});

test("unsupported tokenizer.json parts fail loudly", () => {
  assert.throws(() => loadTokenizer({}), /no model/u);
  assert.throws(() => loadTokenizer({ model: { type: "WordPiece", vocab: {} } }), /unsupported model/u);
  const base = fixture("tokenizer-bpe.json") as Record<string, unknown>;
  assert.throws(
    () => loadTokenizer({ ...base, normalizer: { type: "Lowercase2" } }),
    /unsupported normalizer/u,
  );
  assert.throws(
    () => loadTokenizer({ ...base, pre_tokenizer: { type: "ByteLevel" } }),
    /unsupported pre_tokenizer/u,
  );
});

describe("real tokenizers (when cached in .cache/offline-models)", () => {
  test(
    "NLLB-200: the reference sentence of the transformers test suite, with eng_Latn first and </s> last",
    { skip: existsSync(NLLB) ? false : "run npm run fetch-models -- --offline=nllb-200-distilled-600m" },
    () => {
      const tok = loadTokenizer(JSON.parse(readFileSync(NLLB, "utf8")));
      const ids = [
        tok.tokenToId("eng_Latn"),
        ...tok.encode("UN Chief Says There Is No Military Solution in Syria"),
        tok.tokenToId("</s>"),
      ];
      assert.deepEqual(
        ids,
        [256047, 16297, 134408, 8165, 248066, 14734, 950, 1135, 105721, 3573, 83, 27352, 108, 49486, 2],
      );
      assert.equal(tok.decode(ids), "UN Chief Says There Is No Military Solution in Syria");
      // The precompiled normalizer (SentencePiece nmt_nfkc): full-width and compatibility forms.
      assert.deepEqual(tok.encode("ＵＮ"), tok.encode("UN"));
      assert.deepEqual(tok.encode("ﾃｽﾄ"), tok.encode("テスト"));
      assert.equal(
        tok.decode(tok.encode("Bảy giờ gặp nhau trước nhà ga nhé.")),
        "Bảy giờ gặp nhau trước nhà ga nhé.",
      );
    },
  );

  test(
    "Marian ko-en: pieces, ids and the best segmentation of Korean comic lines",
    { skip: existsSync(MARIAN_KO_EN) ? false : "run npm run fetch-models -- --offline=opus-mt-ko-en" },
    () => {
      const json: unknown = JSON.parse(readFileSync(MARIAN_KO_EN, "utf8"));
      const tok = loadTokenizer(json);
      assert.deepEqual(tok.tokenize("다음 날 아침"), ["▁다음", "▁날", "▁아침"]);
      assert.deepEqual(tok.encode("다음 날 아침"), [1032, 571, 3547]);
      assert.deepEqual(tok.encode("잠깐, 지갑을 두고 왔어!"), [3070, 3, 21347, 51, 3840, 7231, 28]);
      assert.equal(tok.tokenToId("</s>"), 0);
      assert.equal(tok.tokenToId("<pad>"), 65000);
      for (const word of ["▁지갑을", "▁없잖아!", "▁기다릴까", "▁the", "▁morning."]) {
        assert.equal(viterbiScore(tok, json, word), bestScore(json, word), word);
      }
      assert.equal(tok.decode(tok.encode("The next morning.")), "The next morning.");
    },
  );
});

/* ------------------------------------------------------------------ an independent reference for Unigram */

type Vocab = Array<[string, number]>;

function vocabOf(json: unknown): Vocab {
  return (json as { model: { vocab: Vocab } }).model.vocab;
}

/** Score of the tokenizer's segmentation of one pre-token (unknown pieces at min score - 10). */
function viterbiScore(tok: Tokenizer, json: unknown, word: string): number {
  const vocab = vocabOf(json);
  const min = Math.min(...vocab.map(([, s]) => s));
  const pieces = tok.encode(word.replace(/^▁/u, ""));
  return pieces.reduce((sum, id) => sum + (id === tok.unkId ? min - 10 : (vocab[id]?.[1] ?? 0)), 0);
}

/**
 * Best total score over every segmentation of `word` into vocabulary pieces (special tokens excluded), a single
 * unknown character allowed where no single-character piece exists. Consecutive unknowns count once each here but
 * are fused into one token by the tokenizer, so words with several unknowns are not compared.
 */
function bestScore(json: unknown, word: string): number {
  const vocab = vocabOf(json);
  const special = new Set(["</s>", "<unk>", "<pad>", "<s>"]);
  const scores = new Map<string, number>();
  for (const [piece, score] of vocab) if (!special.has(piece) && !scores.has(piece)) scores.set(piece, score);
  const min = Math.min(...vocab.map(([, s]) => s));
  const chars = [...word];
  const memo = new Map<number, number>();
  const best = (start: number): number => {
    if (start === chars.length) return 0;
    const known = memo.get(start);
    if (known !== undefined) return known;
    let result = Number.NEGATIVE_INFINITY;
    for (let end = start + 1; end <= chars.length; end++) {
      const piece = chars.slice(start, end).join("");
      const score = scores.get(piece);
      if (score !== undefined) result = Math.max(result, score + best(end));
    }
    if (!scores.has(chars[start] ?? "")) result = Math.max(result, min - 10 + best(start + 1));
    memo.set(start, result);
    return result;
  };
  return best(0);
}
