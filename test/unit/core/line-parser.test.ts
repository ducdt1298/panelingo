import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createLineParser,
  createLineSplitter,
  normalizeLang,
  normalizeType,
  parseLine,
  type ItemRec,
  type Rec,
} from "../../../src/shared/core/line-parser.ts";

function item(rec: Rec): ItemRec {
  assert.equal(rec.kind, "item", `expected an item, got ${JSON.stringify(rec)}`);
  return rec;
}

function parseAll(lines: readonly string[]): Rec[] {
  const recs: Rec[] = [];
  const parser = createLineParser((rec) => recs.push(rec));
  for (const line of lines) {
    parser.push(line);
  }
  parser.end();
  return recs;
}

describe("parseLine", () => {
  test("a full item record", () => {
    assert.deepEqual(parseLine("#3|dialogue|Zorvik|비가 와요|Trời mưa rồi."), {
      kind: "item",
      id: 3,
      type: "dialogue",
      speaker: "Zorvik",
      original: "비가 와요",
      translation: "Trời mưa rồi.",
      raw: "#3|dialogue|Zorvik|비가 와요|Trời mưa rồi.",
    });
  });

  test("splits only on the first 4 separators: a | inside the translation is kept", () => {
    const rec = item(parseLine("#2|sign||A|B|Một | hai | ba"));
    assert.equal(rec.original, "A");
    assert.equal(rec.translation, "B|Một | hai | ba");
  });

  test("fields are trimmed and spaces around the id are allowed", () => {
    const rec = item(parseLine("  # 12 | thought |  Kai |  원본  |  Ừ, đi thôi.  "));
    assert.equal(rec.id, 12);
    assert.equal(rec.type, "thought");
    assert.equal(rec.speaker, "Kai");
    assert.equal(rec.original, "원본");
    assert.equal(rec.translation, "Ừ, đi thôi.");
  });

  test("tolerated prefixes: bullets, quote marks and 'Assistant:'", () => {
    for (const line of [
      "- #1|dialogue||A|B",
      "* #1|dialogue||A|B",
      "> #1|dialogue||A|B",
      "• #1|dialogue||A|B",
    ]) {
      assert.equal(item(parseLine(line)).id, 1, line);
    }
    assert.equal(item(parseLine("Assistant: #4|sfx||쾅|RẦM!")).translation, "RẦM!");
    assert.equal(item(parseLine("assistant:#4|sfx||쾅|RẦM!")).id, 4);
    assert.equal(parseLine("@lang|ko").kind, "lang");
    assert.equal(parseLine("- Assistant: @lang|ja").kind, "lang");
  });

  test("full-width id digits and marks are normalised (NFKC on the id only)", () => {
    const rec = item(parseLine("＃１２｜dialogue||！？|Hả?!"));
    assert.equal(rec.id, 12);
    assert.equal(rec.original, "！？", "fields keep their full-width characters");
    const bars = item(parseLine("#3｜sign｜｜看板｜Biển hiệu"));
    assert.equal(bars.type, "sign");
    assert.equal(bars.original, "看板");
    assert.equal(bars.translation, "Biển hiệu");
  });

  test("4-field repair: speaker omitted when the last field is Latin and the third is not", () => {
    const rec = item(parseLine("#5|dialogue|비가 와요|Trời mưa rồi."));
    assert.equal(rec.speaker, "");
    assert.equal(rec.original, "비가 와요");
    assert.equal(rec.translation, "Trời mưa rồi.");
    const latin = item(parseLine("#6|dialogue|Kai|Hello there"));
    assert.equal(latin.speaker, "Kai", "both Latin: read positionally");
    assert.equal(latin.original, "Hello there");
    assert.equal(latin.translation, "");
  });

  test("short records read positionally with an empty translation", () => {
    const rec = item(parseLine("#7|dialogue"));
    assert.equal(rec.type, "dialogue");
    assert.equal(rec.translation, "");
    assert.equal(item(parseLine("#8|")).type, "dialogue");
  });

  test("type synonyms; unknown types become dialogue", () => {
    const cases: Array<[string, string]> = [
      ["speech", "dialogue"],
      ["Dialog", "dialogue"],
      ["monologue", "thought"],
      ["inner", "thought"],
      ["caption", "narration"],
      ["text", "sign"],
      ["screen", "sign"],
      ["sound", "sfx"],
      ["onomatopoeia", "sfx"],
      ["Sound_Effect", "sfx"],
      ["skip", "ignore"],
      ["none", "ignore"],
      ["watermark", "ignore"],
      ["no text", "ignore"],
      ["whisper", "dialogue"],
      ["", "dialogue"],
      // Decorated types are read by their first word (an SFX typed as dialogue would be erased in P3).
      ["sfx (sound-effect lettering)", "sfx"],
      ["ignore (watermark)", "ignore"],
      ["narration box", "narration"],
      ["sign/label", "sign"],
      ["text message", "sign"],
      ["thought bubble", "thought"],
      ["whisper (quiet)", "dialogue"],
    ];
    for (const [word, type] of cases) {
      assert.equal(normalizeType(word), type, word);
    }
    assert.equal(item(parseLine("#1|SFX||쿵|BỊCH")).type, "sfx");
  });

  test("control lines: @lang, @term, @sum and @summary", () => {
    assert.deepEqual(parseLine("@lang|ko"), { kind: "lang", lang: "ko", raw: "@lang|ko" });
    assert.equal((parseLine("@lang: Korean") as { lang: string }).lang, "ko");
    assert.equal((parseLine("@LANG|zh-CN") as { lang: string }).lang, "zh");
    assert.equal((parseLine("@lang|vi") as { lang: string }).lang, "other");
    // Spanish sources (Spain and Latin American scanlations), however the model names them.
    for (const word of ["es", "Spanish", "español", "Espanol", "es-419", "ES-MX"]) {
      assert.equal((parseLine(`@lang|${word}`) as { lang: string }).lang, "es", word);
    }
    assert.equal(parseLine("@lang|").kind, "junk");
    assert.deepEqual(parseLine("@term|Plimba|Plimba|tên tiệm | bánh"), {
      kind: "term",
      original: "Plimba",
      translation: "Plimba",
      note: "tên tiệm | bánh",
      raw: "@term|Plimba|Plimba|tên tiệm | bánh",
    });
    assert.deepEqual(parseLine("@sum|Zorvik quên ô."), {
      kind: "sum",
      text: "Zorvik quên ô.",
      raw: "@sum|Zorvik quên ô.",
    });
    assert.equal((parseLine("@summary: Kai đi lạc.") as { text: string }).text, "Kai đi lạc.");
    assert.equal(parseLine("@note|x").kind, "junk");
    assert.deepEqual(parseLine("@addr| Zorvik |Kai|tớ|cậu | bạn"), {
      kind: "addr",
      a: "Zorvik",
      b: "Kai",
      aSelf: "tớ",
      aToB: "cậu | bạn",
      raw: "@addr| Zorvik |Kai|tớ|cậu | bạn",
    });
    assert.deepEqual(parseLine("@address|Kai|Zorvik|tớ"), {
      kind: "addr",
      a: "Kai",
      b: "Zorvik",
      aSelf: "tớ",
      aToB: "",
      raw: "@address|Kai|Zorvik|tớ",
    });
  });

  test("prose, headings and malformed ids are junk", () => {
    for (const line of [
      "Here are the translations:",
      "# Output",
      "#1234|dialogue||a|b",
      "#x|dialogue||a|b",
      "#3 dialogue a b",
      "1|dialogue||a|b",
    ]) {
      assert.deepEqual(parseLine(line), { kind: "junk", raw: line }, line);
    }
  });

  test("NFC: decomposed Vietnamese is composed", () => {
    const decomposed = "Tro\u031b\u0300i mu\u031ba ro\u0302\u0300i";
    assert.equal(item(parseLine(`#1|dialogue||x|${decomposed}`)).translation, decomposed.normalize("NFC"));
  });

  test("normalizeLang", () => {
    assert.equal(normalizeLang(" JA "), "ja");
    assert.equal(normalizeLang("jp"), "ja");
    assert.equal(normalizeLang("zh_TW"), "zh");
    assert.equal(normalizeLang("en (English)"), "en");
    assert.equal(normalizeLang("ko-KR"), "ko");
    assert.equal(normalizeLang("tlh"), "other");
    assert.equal(normalizeLang("  "), null);
  });
});

describe("createLineSplitter", () => {
  test("splits streamed deltas on LF and CRLF and returns the unterminated tail", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    for (const delta of ["@lang|ko\r", "\n#1|dia", "logue||a|b\n\n#2|si", "gn||c|d\r\n#3|sfx||쾅|RẦ"]) {
      splitter.push(delta);
    }
    assert.deepEqual(lines, ["@lang|ko", "#1|dialogue||a|b", "", "#2|sign||c|d"]);
    assert.equal(splitter.tail(), "#3|sfx||쾅|RẦ");
    assert.equal(splitter.end(), "#3|sfx||쾅|RẦ");
    assert.equal(splitter.end(), "", "end() resets");
  });

  test("a CR before the end of the stream is stripped from the tail", () => {
    const splitter = createLineSplitter(() => undefined);
    splitter.push("#1|x||a|b\r");
    assert.equal(splitter.end(), "#1|x||a|b");
  });
});

describe("createLineParser", () => {
  test("items are committed when the next record arrives, or at end", () => {
    const recs: Rec[] = [];
    const parser = createLineParser((rec) => recs.push(rec));
    parser.push("@lang|ko");
    assert.equal(recs.length, 1);
    parser.push("#1|dialogue||a|Một");
    assert.equal(recs.length, 1, "pending until the next line");
    parser.push("#2|dialogue||b|Hai");
    assert.equal(recs.length, 2);
    parser.end();
    assert.deepEqual(
      recs.map((rec) => (rec.kind === "item" ? rec.id : rec.kind)),
      ["lang", 1, 2],
    );
  });

  test("continuation: up to 2 short junk lines extend the previous translation", () => {
    const recs = parseAll([
      "#1|dialogue|Kai|긴 문장|Hôm nay trời",
      "mưa rất to",
      "nên tớ ở nhà.",
      "và một dòng thứ ba",
      "#2|dialogue||x|Hai",
    ]);
    const first = item(recs[0] ?? { kind: "junk", raw: "" });
    assert.equal(first.translation, "Hôm nay trời mưa rất to nên tớ ở nhà.");
    assert.equal(first.raw, "#1|dialogue|Kai|긴 문장|Hôm nay trời\nmưa rất to\nnên tớ ở nhà.");
    assert.deepEqual(recs[1], { kind: "junk", raw: "và một dòng thứ ba" });
    assert.equal(item(recs[2] ?? { kind: "junk", raw: "" }).id, 2);
  });

  test("continuation fills an empty translation; notes, long lines, refusals and English chatter are not continuations", () => {
    const recs = parseAll([
      "#1|dialogue||원본|",
      "Xin chào",
      "#2|dialogue||원본|Chào cậu",
      "Note: đây là lời chào",
      "#3|dialogue||원본|Chào cậu",
      "x".repeat(201),
      "#4|dialogue||원본|Chào cậu",
      "Hope this helps you!",
      "#5|dialogue||원본|Chào cậu",
      "(Lưu ý: tên riêng giữ nguyên)",
      "#6|ignore|||",
      "rác",
      "#7|dialogue||원본|Chào cậu",
      "I'm sorry, but I can't help with that.",
    ]);
    const items = recs.filter((rec): rec is ItemRec => rec.kind === "item");
    assert.deepEqual(
      items.map((rec) => rec.translation),
      ["Xin chào", "Chào cậu", "Chào cậu", "Chào cậu", "Chào cậu", "", "Chào cậu"],
    );
    assert.equal(recs.filter((rec) => rec.kind === "junk").length, 6);
  });

  test("separator lines and malformed records are never glued into a translation", () => {
    const recs = parseAll([
      "#1|dialogue||원본|Xin chào",
      "---",
      "#2|dialogue||원본|Chào cậu",
      "***",
      "#3|dialogue||원본|Đi thôi",
      "2. #4|dialogue|Kai|안녕|Chào nhé",
      "#5|dialogue||원본|Ừ",
      "`#6|dialogue||원본|Được`",
    ]);
    const items = recs.filter((rec): rec is ItemRec => rec.kind === "item");
    assert.deepEqual(
      items.map((rec) => `${rec.id}:${rec.translation}`),
      ["1:Xin chào", "2:Chào cậu", "3:Đi thôi", "5:Ừ"],
    );
    assert.deepEqual(
      recs.filter((rec) => rec.kind === "junk").map((rec) => rec.raw),
      ["---", "***", "2. #4|dialogue|Kai|안녕|Chào nhé", "`#6|dialogue||원본|Được`"],
    );
  });

  test("decomposed (NFD) lines are judged like composed ones", () => {
    const recs = parseAll([
      "#1|dialogue||원본|Hôm nay trời",
      "mưa rất to".normalize("NFD"),
      "#2|dialogue||원본|Chào cậu",
      "Lưu ý: tên riêng giữ nguyên".normalize("NFD"),
    ]);
    const items = recs.filter((rec): rec is ItemRec => rec.kind === "item");
    assert.deepEqual(
      items.map((rec) => rec.translation),
      ["Hôm nay trời mưa rất to", "Chào cậu"],
    );
    assert.equal(recs.filter((rec) => rec.kind === "junk").length, 1, "the NFD note stays junk");
  });

  test("a blank line ends the continuation window", () => {
    const recs = parseAll(["#1|dialogue||a|Một", "", "tiếp theo"]);
    assert.equal(item(recs[0] ?? { kind: "junk", raw: "" }).translation, "Một");
    assert.deepEqual(recs[1], { kind: "junk", raw: "tiếp theo" });
  });

  test("code-fence lines are skipped, the lines inside are parsed", () => {
    const recs = parseAll(["```text", "@lang|ja", "#1|dialogue||はい|Vâng", "```", "#2|sfx||ドン|ĐÙNG"]);
    assert.deepEqual(
      recs.map((rec) => (rec.kind === "item" ? `${rec.id}:${rec.translation}` : rec.kind)),
      ["lang", "1:Vâng", "2:ĐÙNG"],
    );
  });

  test("<think> blocks are skipped, inline or across lines", () => {
    const recs = parseAll([
      "<think>",
      "#9|dialogue||nope|không được tính",
      "still thinking</think>",
      "@lang|ko",
      "<think>short</think>#1|dialogue||a|Một",
      "#2|dialogue||b|Hai <think>hidden",
      "#3|dialogue||c|không",
      "</THINK> #3|dialogue||c|Ba",
    ]);
    assert.deepEqual(
      recs.map((rec) => (rec.kind === "item" ? `${rec.id}:${rec.translation}` : rec.kind)),
      ["lang", "1:Một", "2:Hai", "3:Ba"],
    );
  });

  test("a closing think tag without an opening one drops the reasoning before it on that line", () => {
    const recs = parseAll([
      "#1|dialogue||a|Một",
      "so the second region is a sign</think>#2|sign||b|Hai",
      "</thinking>",
      "#3|dialogue||c|Ba",
    ]);
    assert.deepEqual(
      recs.map((rec) => (rec.kind === "item" ? `${rec.id}:${rec.translation}` : rec.kind)),
      ["1:Một", "2:Hai", "3:Ba"],
    );
  });

  test("CRLF lines from the splitter parse cleanly", () => {
    const recs: Rec[] = [];
    const parser = createLineParser((rec) => recs.push(rec));
    const splitter = createLineSplitter((line) => parser.push(line));
    splitter.push("@lang|en\r\n#1|dialogue|Kai|HELLO|Xin chào\r\n#2|sign||EXIT|Lối ra\r\n");
    parser.end();
    assert.deepEqual(
      recs.map((rec) => (rec.kind === "item" ? rec.translation : rec.kind)),
      ["lang", "Xin chào", "Lối ra"],
    );
  });

  test("a partial last line is not parsed until it is pushed", () => {
    const recs: Rec[] = [];
    const parser = createLineParser((rec) => recs.push(rec));
    const splitter = createLineSplitter((line) => parser.push(line));
    splitter.push("#1|dialogue||a|Một\n#2|dialogue||b|Ha");
    parser.end();
    assert.deepEqual(
      recs.map((rec) => (rec.kind === "item" ? rec.id : rec.kind)),
      [1],
    );
    assert.equal(splitter.end(), "#2|dialogue||b|Ha");
  });

  test("prose around the records stays junk and does not break items", () => {
    const recs = parseAll([
      "Sure! Here is the translation.",
      "@lang|zh",
      "#1|narration||三年后|Ba năm sau",
      "#2|dialogue|Kestrin|师父|Sư phụ!",
      "@term|师父|sư phụ|thầy dạy võ",
      "@sum|Kestrin gặp lại sư phụ.",
    ]);
    assert.deepEqual(
      recs.map((rec) => rec.kind),
      ["junk", "lang", "item", "item", "term", "sum"],
    );
  });
});
