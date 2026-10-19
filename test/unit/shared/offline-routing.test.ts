// Offline mode routing, catalog, unit outcomes and settings (src/shared/offline/{routing,catalog,results}.ts,
// src/shared/settings.ts): which models translate a pair (direct, through English, NLLB-200, unsupported), the pinned
// catalog of vendor/models.lock.json, the cache key of stored translations, and the migration of the new settings.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { offlineFiles, readModelsLock } from "../../../scripts/lib/models.ts";
import { parseBuildInfo } from "../../../src/engine/model-files.ts";
import {
  catalogModels,
  downloadBytes,
  modelFiles,
  offlineFileUrl,
  offlineLocalPath,
  parseOfflineFiles,
  type OfflineFile,
} from "../../../src/shared/offline/catalog.ts";
import {
  guessLineType,
  isRepeatedChunk,
  medianGlyph,
  translationOutcome,
} from "../../../src/shared/offline/results.ts";
import {
  NLLB_MODEL,
  NLLB_TARGET,
  OCR_MODEL,
  currentSource,
  planRoute,
  routeModels,
  translationSource,
} from "../../../src/shared/offline/routing.ts";
import { TARGET_LANGUAGES } from "../../../src/shared/languages.ts";
import { DEFAULT_SETTINGS, migrateSettings, offlineBaseUrl } from "../../../src/shared/settings.ts";

const CATALOG = offlineFiles(readModelsLock());
const AVAILABLE = new Set(catalogModels(CATALOG));

describe("language pair routing", () => {
  test("Opus-MT: a direct model when the catalog has one", () => {
    const route = planRoute("ko", "en", "opus-mt", AVAILABLE);
    assert.deepEqual(route, {
      kind: "translate",
      legs: [{ model: "opus-mt-ko-en", source: "ko", target: "en" }],
      label: "offline:opus-mt-ko-en",
    });
    assert.deepEqual(routeModels("ko", route), ["ocr-korean", "opus-mt-ko-en"]);
  });

  test("Opus-MT: through English when both legs exist", () => {
    const route = planRoute("ja", "vi", "opus-mt", AVAILABLE);
    assert.equal(route.kind, "translate");
    assert.ok(route.kind === "translate");
    assert.deepEqual(
      route.legs.map((leg) => leg.model),
      ["opus-mt-ja-en", "opus-mt-en-vi"],
    );
    assert.equal(route.label, "offline:opus-mt-ja-en+opus-mt-en-vi");
    assert.equal(planRoute("es", "fr", "opus-mt", AVAILABLE).kind, "translate");
  });

  test("Opus-MT: unsupported pairs say so (no English leg, regional variants, CJK targets)", () => {
    for (const [source, target] of [
      ["ko", "ja"],
      ["en", "ko"],
      ["en", "pt-br"],
      ["ja", "zh-cn"],
      ["en", "tl"],
    ] as const) {
      const route = planRoute(source, target, "opus-mt", AVAILABLE);
      assert.equal(route.kind, "unsupported", `${source} → ${target}`);
    }
    assert.equal(planRoute("ko", "vi", "opus-mt", new Set(["opus-mt-ko-en"])).kind, "unsupported");
    assert.equal(planRoute("other", "en", "opus-mt", AVAILABLE).kind, "unsupported");
  });

  test("the page already in the target language keeps its text", () => {
    assert.deepEqual(planRoute("en", "en", "opus-mt", AVAILABLE), { kind: "same" });
    assert.deepEqual(planRoute("zh", "zh-tw", "nllb-600m", AVAILABLE), { kind: "same" });
    assert.deepEqual(planRoute("es", "es", "nllb-600m", AVAILABLE), { kind: "same" });
  });

  test("NLLB-200: every target language, one step, FLORES-200 codes", () => {
    for (const language of TARGET_LANGUAGES) {
      assert.ok(NLLB_TARGET[language.code] !== undefined, language.code);
      const route = planRoute("ko", language.code, "nllb-600m", AVAILABLE);
      if (language.code === "ko") {
        assert.equal(route.kind, "same");
        continue;
      }
      assert.ok(route.kind === "translate", language.code);
      assert.equal(route.legs.length, 1);
      assert.equal(route.legs[0]?.source, "kor_Hang");
      assert.equal(route.label, `offline:${NLLB_MODEL}`);
    }
    assert.equal(planRoute("ja", "vi", "nllb-600m", new Set()).kind, "unsupported", "not in the build");
  });

  test("every OCR model and every routed model is in the pinned catalog", () => {
    for (const model of Object.values(OCR_MODEL)) assert.ok(AVAILABLE.has(model), model);
    assert.ok(AVAILABLE.has(NLLB_MODEL));
  });

  test("stored translations count only for the engine that wrote them", () => {
    assert.equal(translationSource("gpt-4o-mini"), "api");
    assert.equal(translationSource(""), "api");
    assert.equal(translationSource("offline:opus-mt-ko-en"), "offline:opus-mt");
    assert.equal(translationSource("offline:opus-mt-ja-en+opus-mt-en-vi"), "offline:opus-mt");
    assert.equal(translationSource("offline:ocr-korean"), "offline:opus-mt");
    assert.equal(translationSource(`offline:${NLLB_MODEL}`), "offline:nllb-600m");
    assert.equal(currentSource("api", "nllb-600m"), "api");
    assert.equal(currentSource("offline", "nllb-600m"), "offline:nllb-600m");
  });
});

describe("offline catalog (vendor/models.lock.json)", () => {
  test("pinned commits, sha256 and sizes; every model complete; never optional for the build", () => {
    assert.ok(CATALOG.length >= 8);
    for (const model of catalogModels(CATALOG)) assert.notEqual(modelFiles(CATALOG, model), null, model);
    const nllb = CATALOG.filter((file) => file.model === NLLB_MODEL);
    assert.ok(nllb.every((file) => file.license === "CC-BY-NC-4.0"));
    assert.ok(downloadBytes(CATALOG, [NLLB_MODEL]) > 800_000_000);
    const pair = downloadBytes(CATALOG, ["opus-mt-ko-en"]);
    assert.ok(pair > 100_000_000 && pair < 140_000_000, String(pair));
  });

  test("URLs are Hugging Face resolve URLs of the pinned revision, or the same path under a mirror", () => {
    const file = CATALOG.find((f) => f.model === "ocr-korean" && f.role === "model") as OfflineFile;
    assert.equal(
      offlineFileUrl(file),
      `https://huggingface.co/${file.repo}/resolve/${file.revision}/inference.onnx`,
    );
    assert.equal(
      offlineFileUrl(file, "http://127.0.0.1:9000/"),
      `http://127.0.0.1:9000/${file.repo}/resolve/${file.revision}/inference.onnx`,
    );
    assert.equal(offlineLocalPath(file), `${file.repo}/${file.revision}/inference.onnx`);
  });

  test("malformed entries are refused (path traversal, unpinned revisions, bad hashes)", () => {
    const good = CATALOG[0] as OfflineFile;
    const bad: Array<Partial<OfflineFile> & Record<string, unknown>> = [
      { path: "../secret" },
      { repo: "no-owner" },
      { repo: "a/b/c" },
      { revision: "main" },
      { sha256: "abc" },
      { bytes: 0 },
      { role: "decoder" },
      { kind: "tts" as never },
      { license: "" },
    ];
    for (const change of bad) {
      assert.throws(
        () => parseOfflineFiles([{ ...good, ...change }]),
        /offline file 0/u,
        JSON.stringify(change),
      );
    }
    assert.throws(() => parseOfflineFiles({}), /not a list/u);
  });

  test("build-info.json carries the catalog; a malformed one is a model_integrity error", () => {
    const info = parseBuildInfo({ buildId: "b", ort: "1.30.0", models: [], offline: CATALOG });
    assert.equal(info.offline?.length, CATALOG.length);
    assert.equal(parseBuildInfo({ buildId: "b", ort: "1.30.0", models: [] }).offline, undefined);
    assert.throws(
      () => parseBuildInfo({ buildId: "b", ort: "1.30.0", models: [], offline: [{ model: "x" }] }),
      (error: unknown) => (error as { code?: string }).code === "detector.model_integrity",
    );
  });
});

describe("unit outcomes", () => {
  test("type from geometry: edge page numbers ignored, balloons dialogue, large free text sfx", () => {
    const units = [{ glyphPx: 30 }, { glyphPx: 28 }, { glyphPx: 32 }, { glyphPx: 90 }];
    const median = medianGlyph(units);
    assert.equal(median, 31);
    assert.equal(guessLineType({ kind: "bubble", glyphPx: 30 }, median), "dialogue");
    assert.equal(guessLineType({ kind: "free", glyphPx: 30 }, median), "narration");
    assert.equal(guessLineType({ kind: "free", glyphPx: 90 }, median), "sfx");
    assert.equal(guessLineType({ kind: "free", glyphPx: 15, edgeSmall: true }, median), "ignore");
  });

  test("onomatopoeia written as a repeated chunk (kept as drawn); two letters or other words are not", () => {
    for (const sfx of ["두근두근", "ドキドキ!", "ゴゴゴ", "哈哈哈", "HAHAHA", "쿵쿵 쿵쿵"]) {
      assert.equal(isRepeatedChunk(sfx), true, sfx);
    }
    const others = [
      "똑똑",
      "谢谢",
      "BOOM!",
      "오늘 휴업",
      "本日休業",
      "가나다 가나다라",
      "",
      "!!!",
      "ba-dum ba-dum",
    ];
    for (const text of others) {
      assert.equal(isRepeatedChunk(text), false, text);
    }
  });

  test("a translation equal to the source keeps the original; an empty one is untranslated", () => {
    assert.equal(translationOutcome("다음 날 아침", "The next morning."), "ok");
    assert.equal(translationOutcome("OK!", "Ok."), "keep-original");
    assert.equal(translationOutcome("12", "12"), "keep-original");
    assert.equal(translationOutcome("!?", "What?"), "keep-original", "no letters: nothing to translate");
    assert.equal(translationOutcome("다음", "  "), "untranslated");
  });
});

describe("settings", () => {
  test("defaults: the API engine, Opus-MT, no mirror", () => {
    assert.equal(DEFAULT_SETTINGS.translate.engine, "api");
    assert.equal(DEFAULT_SETTINGS.translate.offlineModel, "opus-mt");
    assert.equal(DEFAULT_SETTINGS.debug.offlineModelBaseUrl, "");
    const migrated = migrateSettings({});
    assert.equal(migrated.translate.engine, "api");
  });

  test("migration keeps valid values and resets unknown ones", () => {
    const valid = migrateSettings({
      translate: { engine: "offline", offlineModel: "nllb-600m" },
      debug: { offlineModelBaseUrl: "http://127.0.0.1:9000/" },
    });
    assert.equal(valid.translate.engine, "offline");
    assert.equal(valid.translate.offlineModel, "nllb-600m");
    assert.equal(valid.debug.offlineModelBaseUrl, "http://127.0.0.1:9000");
    const invalid = migrateSettings({
      translate: { engine: "cloud", offlineModel: "gpt" },
      debug: { offlineModelBaseUrl: "file:///C:/models" },
    });
    assert.equal(invalid.translate.engine, "api");
    assert.equal(invalid.translate.offlineModel, "opus-mt");
    assert.equal(invalid.debug.offlineModelBaseUrl, "");
    assert.equal(migrateSettings({ translate: { engine: 1 } }).translate.engine, "api");
  });

  test("offlineBaseUrl accepts plain http(s) bases only", () => {
    assert.equal(offlineBaseUrl(" https://mirror.example/models/ "), "https://mirror.example/models");
    for (const bad of ["ftp://x", "http://user:pw@host", "http://host/?q=1", "http://host/#a", "not a url"]) {
      assert.equal(offlineBaseUrl(bad), "", bad);
    }
  });
});
