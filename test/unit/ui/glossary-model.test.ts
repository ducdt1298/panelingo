// Side panel glossary view model (src/ui/sidepanel/glossary-model.ts): grouping, drafts, the settings form and the
// JSON export/import format.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { newSeriesProfile } from "../../../src/shared/core/memory.ts";
import type { GlossaryEntry } from "../../../src/shared/records.ts";
import {
  canConfirm,
  chunks,
  editFromDraft,
  exportFileName,
  exportGlossary,
  GLOSSARY_EXPORT_VERSION,
  groupByState,
  importPatch,
  parseGlossaryImport,
  profileDraft,
  profilePatch,
  seriesLabel,
} from "../../../src/ui/sidepanel/glossary-model.ts";

const SERIES = "https://reader.example|lone-hunter";

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
    packIds: [],
    alternatives: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    ...patch,
  };
}

describe("grouping and actions", () => {
  test("groups follow state order; user entries alphabetically, the model's most frequent first", () => {
    const groups = groupByState([
      entry("다", "candidate", { sightings: 1, lastSeenAt: 9 }),
      entry("나", "manual"),
      entry("라", "learned", { sightings: 2 }),
      entry("가", "manual"),
      entry("마", "candidate", { sightings: 3 }),
      entry("바", "candidate", { sightings: 1, lastSeenAt: 2 }),
    ]);
    assert.deepEqual(
      groups.map((group) => [group.state, group.entries.map((e) => e.orig)]),
      [
        ["manual", ["가", "나"]],
        ["learned", ["라"]],
        ["candidate", ["마", "다", "바"]],
      ],
      "empty states are left out",
    );
    assert.deepEqual(groupByState([]), []);
  });

  test("only suggestions and learned entries can be confirmed", () => {
    assert.equal(canConfirm({ state: "candidate" }), true);
    assert.equal(canConfirm({ state: "learned" }), true);
    assert.equal(canConfirm({ state: "manual" }), false);
    assert.equal(canConfirm({ state: "confirmed" }), false);
  });

  test("editFromDraft trims and needs both the original and the translation", () => {
    assert.deepEqual(editFromDraft({ orig: " 지호 ", translation: " Jiho ", note: "  main  character " }), {
      orig: "지호",
      translation: "Jiho",
      note: "main character",
    });
    assert.equal(editFromDraft({ orig: "", translation: "x", note: "" }), null);
    assert.equal(editFromDraft({ orig: "x", translation: "  ", note: "" }), null);
  });

  test("seriesLabel: the profile title, else the slug, else the site", () => {
    const profile = newSeriesProfile(SERIES, "https://reader.example", "Lone Hunter", 1);
    assert.equal(seriesLabel(SERIES, profile), "Lone Hunter");
    assert.equal(seriesLabel(SERIES, { ...profile, title: " " }), "lone-hunter");
    assert.equal(seriesLabel("https://reader.example|", null), "https://reader.example");
    assert.equal(seriesLabel("odd", null), "odd");
  });

  test("chunks splits an import into calls the engine accepts", () => {
    assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunks([], 2), []);
    assert.deepEqual(chunks([1, 2], 0), [[1], [2]]);
  });
});

describe("series settings form", () => {
  test("defaults without a profile; the patch keeps the stored genre", () => {
    assert.deepEqual(profileDraft(null), {
      lang: "auto",
      koNames: "romanized",
      keepJaHonorifics: false,
      summaryEnabled: true,
    });
    const profile = {
      ...newSeriesProfile(SERIES, "https://reader.example", "Lone Hunter", 1),
      lang: "ko" as const,
      style: { genre: "action", koNames: "han-viet" as const, keepJaHonorifics: true },
      summaryEnabled: false,
    };
    const draft = profileDraft(profile);
    assert.deepEqual(draft, {
      lang: "ko",
      koNames: "han-viet",
      keepJaHonorifics: true,
      summaryEnabled: false,
    });
    assert.deepEqual(profilePatch({ ...draft, lang: "auto" }, profile), {
      lang: "auto",
      style: { genre: "action", koNames: "han-viet", keepJaHonorifics: true },
      summaryEnabled: false,
    });
    assert.deepEqual(profilePatch(profileDraft(null), null).style, {
      genre: "",
      koNames: "romanized",
      keepJaHonorifics: false,
    });
  });
});

describe("export and import", () => {
  const profile = {
    ...newSeriesProfile(SERIES, "https://reader.example", "Lone Hunter", 1),
    lang: "ko" as const,
    pronouns: [{ a: "Jiho", b: "Yuna", aSelf: "tớ", aToB: "cậu" }],
  };
  const entries = [
    entry("헌터", "candidate"),
    entry("지호", "manual", { translation: "Jiho", note: "main character" }),
    entry("던전", "learned", { translation: "hầm ngục" }),
  ];

  test("an export holds the version, the profile and every entry with its state", () => {
    const data = exportGlossary(profile, entries);
    assert.equal(data.version, GLOSSARY_EXPORT_VERSION);
    assert.deepEqual(data.series, profile);
    assert.deepEqual(data.glossary, [
      { orig: "지호", translation: "Jiho", note: "main character", state: "manual" },
      { orig: "던전", translation: "hầm ngục", note: "", state: "learned" },
      { orig: "헌터", translation: "헌터-t", note: "", state: "candidate" },
    ]);
    assert.equal(exportFileName(SERIES, profile), "panelingo-glossary-lone-hunter.json");
    assert.equal(
      exportFileName("https://reader.example|", null),
      "panelingo-glossary-https-reader-example.json",
    );
    assert.equal(exportFileName("https://reader.example|***", null), "panelingo-glossary-series.json");
  });

  test("an import round-trips: entries become manual edits (suggestions skipped), settings carry over", () => {
    const parsed = parseGlossaryImport(JSON.stringify(exportGlossary(profile, entries)));
    assert.deepEqual(parsed, {
      edits: [
        { orig: "지호", translation: "Jiho", note: "main character" },
        { orig: "던전", translation: "hầm ngục", note: "" },
      ],
      patch: {
        lang: "ko",
        readingDir: "auto",
        style: { genre: "", koNames: "romanized", keepJaHonorifics: false },
        pronouns: [{ a: "Jiho", b: "Yuna", aSelf: "tớ", aToB: "cậu" }],
        summaryEnabled: true,
        notes: "",
      },
      skipped: 1,
    });
  });

  test("an import tolerates hand-written files and rejects anything else", () => {
    const handWritten = JSON.stringify({
      version: 1,
      glossary: [
        { orig: "a", translation: "A" },
        { orig: "a", translation: "A2", note: "later wins" },
        { orig: "", translation: "x" },
        "junk",
        { orig: "b", translation: 3 },
      ],
      series: { lang: "klingon" },
    });
    assert.deepEqual(parseGlossaryImport(handWritten), {
      edits: [{ orig: "a", translation: "A2", note: "later wins" }],
      patch: null,
      skipped: 3,
    });
    assert.deepEqual(
      parseGlossaryImport(JSON.stringify({ version: 1, glossary: [], series: { title: "x" } })),
      {
        edits: [],
        patch: null,
        skipped: 0,
      },
    );
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ version: 2, glossary: [] }),
      JSON.stringify({ version: 0, glossary: [] }),
      JSON.stringify({ version: "1", glossary: [] }),
      JSON.stringify({ version: 1, glossary: {} }),
      JSON.stringify({ version: 1 }),
    ]) {
      assert.equal(parseGlossaryImport(bad), null, bad);
    }
  });

  test("importPatch completes a partial style from the current profile", () => {
    assert.deepEqual(importPatch({ style: { koNames: "han-viet" }, lang: "ja" }, profile), {
      lang: "ja",
      style: { genre: "", koNames: "han-viet", keepJaHonorifics: false },
    });
    assert.deepEqual(importPatch({ summaryEnabled: false }, null), { summaryEnabled: false });
    assert.deepEqual(importPatch({ style: { genre: "murim" } }, null).style, {
      genre: "murim",
      koNames: "romanized",
      keepJaHonorifics: false,
    });
  });
});
