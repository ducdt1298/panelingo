// The offline pack translator (src/engine/offline/translator.ts) against fake ORT sessions on a synthetic page drawn
// with tools/gfx-node.ts: per-unit results through onUnit (ok, keep-original, ignored, error), types from geometry,
// the model label, the language vote, a pivot through English, unsupported pairs and failed downloads, the status,
// and that every ORT call goes through the shared lock. seq2seq.ts generate() is checked with and without a cache.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createNodeGfx } from "../../../tools/gfx-node.ts";
import type { DecodedImage, PackUnit, TranslatePack, UnitResult } from "../../../src/engine/contracts.ts";
import {
  cleanText,
  createOfflineTranslator,
  mtInput,
  reopen,
  tidyTranslation,
} from "../../../src/engine/offline/translator.ts";
import type { OfflineModelStore } from "../../../src/engine/offline/model-store.ts";
import { createLocalMtRunner, type MtRunner } from "../../../src/engine/offline/mt-runner.ts";
import type { OfflineOrt, OfflineSession, OfflineTensor } from "../../../src/engine/offline/ort.ts";
import { generate, seq2seqConfig, type Seq2SeqModel } from "../../../src/engine/offline/seq2seq.ts";
import { createLogger, type LogSink } from "../../../src/platform/log.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { CanvasLike } from "../../../src/shared/gfx.ts";
import type { OfflineFile, OfflineRole } from "../../../src/shared/offline/catalog.ts";
import { loadTokenizer } from "../../../src/shared/offline/tokenizer.ts";
import { DEFAULT_SETTINGS, type Settings } from "../../../src/shared/settings.ts";
import type { Box, LogEntry, UnitGeometry } from "../../../src/shared/types.ts";

const gfx = createNodeGfx();
const TOKENIZER = readFileSync(new URL("../../fixtures/offline/tokenizer-unigram.json", import.meta.url));
const CONFIG = JSON.stringify({
  decoder_attention_heads: 2,
  d_model: 8,
  decoder_start_token_id: 9,
  eos_token_id: 0,
  pad_token_id: 9,
});
/** Recognizer dictionary: class 1 = 가, 2 = 日, 3 = !, 4 = 나, ... */
const DICT = ["가", "日", "!", "나", "다", "라"];
const DICT_YML = [
  "PostProcess:",
  "  name: CTCLabelDecode",
  "  character_dict:",
  ...DICT.map((c) => `  - ${c}`),
].join("\n");

/* ------------------------------------------------------------------ catalog and model files */

const ROLES: Record<"ocr" | "mt", OfflineRole[]> = {
  ocr: ["model", "dict"],
  mt: ["encoder", "decoder", "tokenizer", "config"],
};

function catalogEntries(model: string, kind: "ocr" | "mt"): OfflineFile[] {
  return ROLES[kind].map((role) => ({
    model,
    kind,
    role,
    repo: `test/${model}`,
    revision: "0123456789abcdef0123456789abcdef01234567",
    path: role,
    license: "Apache-2.0",
    bytes: 10,
    sha256: "0".repeat(64),
  }));
}

const CATALOG: OfflineFile[] = [
  ...catalogEntries("ocr-korean", "ocr"),
  ...catalogEntries("ocr-cjk", "ocr"),
  ...catalogEntries("opus-mt-ko-en", "mt"),
  ...catalogEntries("opus-mt-en-vi", "mt"),
];

function fileBytes(file: OfflineFile): Uint8Array<ArrayBuffer> {
  const text =
    file.role === "dict"
      ? DICT_YML
      : file.role === "config"
        ? CONFIG
        : file.role === "tokenizer"
          ? TOKENIZER.toString("utf8")
          : `${file.model}.${file.role}`;
  return new Uint8Array(new TextEncoder().encode(text));
}

/* ------------------------------------------------------------------ fake ORT */

interface FakeTensor extends OfflineTensor {
  readonly type: string;
}

const tensor = (type: string, data: unknown, dims: readonly number[]): FakeTensor => ({ type, data, dims });

/** Glyph count of one recognizer input row: dark runs along the middle line of the R plane (BGR plane 2). */
function glyphsInRow(data: Float32Array, n: number, width: number): number {
  const plane = 48 * width;
  const base = n * 3 * plane + 2 * plane + 24 * width;
  let runs = 0;
  let inRun = false;
  for (let x = 0; x < width; x++) {
    const dark = (data[base + x] ?? 0) < -0.5;
    if (dark && !inRun) runs += 1;
    inRun = dark;
  }
  return runs;
}

interface FakeWorld {
  calls: string[];
  locked: number;
  /** Translation scripts: source unknown-word count → target ids, per MT model. */
  scripts: Record<string, (words: number) => number[]>;
  /** Text per glyph count for each recognizer; confidence per recognizer. */
  ocr: Record<string, { text: (glyphs: number) => string; confidence: number }>;
}

function ocrSession(world: FakeWorld, model: string): OfflineSession {
  return {
    inputNames: ["x"],
    outputNames: ["out"],
    run(feeds) {
      world.calls.push(`${model}.run`);
      const x = feeds["x"] as FakeTensor;
      const [N, , , W] = x.dims as [number, number, number, number];
      const steps = 12;
      const classes = DICT.length + 2;
      const out = new Float32Array(N * steps * classes);
      const spec = world.ocr[model] ?? { text: () => "", confidence: 0.9 };
      for (let n = 0; n < N; n++) {
        const text = [...spec.text(glyphsInRow(x.data as Float32Array, n, W))];
        for (let t = 0; t < steps; t++) {
          // Characters on even steps, blanks between them (so repeats survive the CTC collapse).
          const char = t % 2 === 0 ? text[t / 2] : undefined;
          const cls = char === undefined ? 0 : DICT.indexOf(char) + 1;
          const row = (n * steps + t) * classes;
          out.fill((1 - spec.confidence) / (classes - 1), row, row + classes);
          out[row + cls] = cls === 0 ? 0.99 : spec.confidence;
        }
      }
      return Promise.resolve({ out: tensor("float32", out, [N, steps, classes]) });
    },
    release: () => Promise.resolve(),
  };
}

function encoderSession(world: FakeWorld, model: string, rows: number[][]): OfflineSession {
  return {
    inputNames: ["input_ids", "attention_mask"],
    outputNames: ["last_hidden_state"],
    run(feeds) {
      world.calls.push(`${model}.encoder`);
      const ids = feeds["input_ids"] as FakeTensor;
      const [B, S] = ids.dims as [number, number];
      rows.length = 0;
      for (let b = 0; b < B; b++) {
        rows.push([...(ids.data as BigInt64Array).subarray(b * S, (b + 1) * S)].map(Number));
      }
      return Promise.resolve({
        last_hidden_state: tensor("float32", new Float32Array(B * S * 8), [B, S, 8]),
      });
    },
    release: () => Promise.resolve(),
  };
}

function decoderSession(world: FakeWorld, model: string, rows: number[][], merged: boolean): OfflineSession {
  const past = merged
    ? ["decoder.key", "decoder.value", "encoder.key", "encoder.value"].map((k) => `past_key_values.0.${k}`)
    : [];
  return {
    inputNames: [
      "encoder_attention_mask",
      "input_ids",
      "encoder_hidden_states",
      ...past,
      ...(merged ? ["use_cache_branch"] : []),
    ],
    outputNames: ["logits"],
    run(feeds) {
      world.calls.push(`${model}.decoder`);
      const ids = feeds["input_ids"] as FakeTensor;
      const [B, T] = ids.dims as [number, number];
      const vocab = 23;
      const pastLength = merged ? ((feeds["past_key_values.0.decoder.key"] as FakeTensor).dims[2] ?? 0) : 0;
      const logits = new Float32Array(B * T * vocab);
      const script = world.scripts[model] ?? (() => []);
      for (let b = 0; b < B; b++) {
        const words = (rows[b] ?? []).filter((id) => id === 1).length;
        const target = script(words);
        // Position of the token predicted after the last input position: tokens already generated.
        const generated = merged ? pastLength + T - 1 : T - 1;
        const next = target[generated] ?? 0;
        logits[(b * T + T - 1) * vocab + next] = 10;
      }
      const out: Record<string, OfflineTensor> = { logits: tensor("float32", logits, [B, T, vocab]) };
      if (merged) {
        const S = (feeds["encoder_hidden_states"] as FakeTensor).dims[1] ?? 1;
        out["present.0.decoder.key"] = tensor("float32", new Float32Array(0), [B, 2, pastLength + T, 4]);
        out["present.0.decoder.value"] = tensor("float32", new Float32Array(0), [B, 2, pastLength + T, 4]);
        // The cached branch's encoder outputs are placeholders: generate() must keep the first ones.
        const encoderLength = pastLength === 0 ? S : 0;
        out["present.0.encoder.key"] = tensor("float32", new Float32Array(0), [B, 2, encoderLength, 4]);
        out["present.0.encoder.value"] = tensor("float32", new Float32Array(0), [B, 2, encoderLength, 4]);
        if (pastLength > 0) {
          assert.equal(
            (feeds["past_key_values.0.encoder.key"] as FakeTensor).dims[2],
            S,
            "encoder past kept",
          );
        }
      }
      return Promise.resolve(out);
    },
    release: () => Promise.resolve(),
  };
}

function fakeOrt(world: FakeWorld): OfflineOrt {
  const encoderRows = new Map<string, number[][]>();
  return {
    createSession(bytes) {
      const [model = "", role = ""] = new TextDecoder().decode(bytes).split(".");
      world.calls.push(`${model}.${role}.create`);
      if (role === "model") return Promise.resolve(ocrSession(world, model));
      const rows = encoderRows.get(model) ?? [];
      encoderRows.set(model, rows);
      if (role === "encoder") return Promise.resolve(encoderSession(world, model, rows));
      return Promise.resolve(decoderSession(world, model, rows, true));
    },
    float32: (data, dims) => tensor("float32", data, dims),
    int64: (data, dims) => tensor("int64", data, dims),
    bool: (data, dims) => tensor("bool", data, dims),
  };
}

/* ------------------------------------------------------------------ the page */

/** Black squares of side `g` (gap 5) in lines; returns the boxes. */
function glyphLine(
  ctx: ReturnType<CanvasLike["getContext"]>,
  x: number,
  y: number,
  count: number,
  g = 20,
): void {
  for (let i = 0; i < count; i++) ctx?.fillRect(x + i * (g + 5), y, g, g);
}

function geometry(
  unitKey: string,
  order: number,
  text: Box,
  extra: Partial<UnitGeometry> = {},
): UnitGeometry {
  return {
    unitKey,
    kind: "bubble",
    bubble: null,
    text,
    texts: [text],
    orientation: "h",
    glyphPx: 20,
    order,
    ...extra,
  };
}

function page(): { image: DecodedImage; units: PackUnit[] } {
  const canvas = gfx.createCanvas(400, 300);
  const ctx = canvas.getContext("2d");
  assert.ok(ctx !== null);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 400, 300);
  ctx.fillStyle = "#000000";
  glyphLine(ctx, 50, 50, 3); // unit A, line 1
  glyphLine(ctx, 50, 80, 4); // unit A, line 2
  glyphLine(ctx, 210, 50, 2); // unit B
  glyphLine(ctx, 360, 280, 1, 10); // unit C: a page number at the edge
  ctx.fillRect(200, 150, 60, 60); // unit D: two huge glyphs (a sound effect)
  ctx.fillRect(270, 150, 60, 60);
  const size = { w: 400, h: 300 };
  const units: PackUnit[] = [
    geometry("a", 0, { x1: 45, y1: 45, x2: 150, y2: 105 }),
    geometry("b", 1, { x1: 205, y1: 45, x2: 260, y2: 75 }),
    geometry("c", 2, { x1: 356, y1: 276, x2: 374, y2: 294 }, { kind: "free", glyphPx: 10, edgeSmall: true }),
    geometry("d", 3, { x1: 195, y1: 145, x2: 335, y2: 215 }, { kind: "free", glyphPx: 60 }),
  ].map((g) => ({
    contentKey: "s:page",
    unitKey: g.unitKey,
    geometry: g,
    imageSize: size,
    script: "hangul",
    src: "p.png",
  }));
  const image: DecodedImage = {
    contentKey: "s:page",
    size,
    bitmap: canvas as unknown as ImageBitmap,
    release: () => undefined,
  };
  return { image, units };
}

/* ------------------------------------------------------------------ harness */

interface Harness {
  world: FakeWorld;
  logs: LogEntry[];
  results: UnitResult[];
  settings: Settings;
  translator: ReturnType<typeof createOfflineTranslator>;
  run(lang?: TranslatePack["lang"]): ReturnType<ReturnType<typeof createOfflineTranslator>["translate"]>;
}

function harness(
  options: {
    models?: Partial<OfflineModelStore>;
    target?: string;
    /** Wraps the in-process runner (e.g. to make it "isolated" or to fail). */
    mtRunner?: (inner: MtRunner) => MtRunner;
  } = {},
): Harness {
  const world: FakeWorld = {
    calls: [],
    locked: 0,
    scripts: {
      // Two words → "hello world!", one → "hello".
      "opus-mt-ko-en": (words) => (words >= 2 ? [4, 7, 8] : [4]),
      "opus-mt-en-vi": () => [7],
    },
    ocr: {
      "ocr-korean": { text: (n) => (n <= 1 ? "!" : "가나다라".slice(0, n)), confidence: 0.95 },
      "ocr-cjk": { text: (n) => "日".repeat(n), confidence: 0.4 },
    },
  };
  const logs: LogEntry[] = [];
  const sink: LogSink = (entry) => logs.push(entry);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.translate.engine = "offline";
  settings.translate.targetLang = options.target ?? "en";
  const models: OfflineModelStore = {
    load: (file) => Promise.resolve(fileBytes(file)),
    cached: () => Promise.resolve(true),
    ...options.models,
  };
  // One fake ORT for the translation runner: its encoder and decoder sessions share the encoder's rows.
  const mtOrt = fakeOrt(world);
  const timers: Array<() => void> = [];
  const translator = createOfflineTranslator({
    clock: {
      now: () => 0,
      setTimer: (fn) => {
        timers.push(fn);
        return () => undefined;
      },
    },
    log: createLogger("engine", { sinks: [sink], minLevel: "debug" }),
    settings: {
      current: () => settings,
      site: () => ({ ...DEFAULT_SETTINGS_SITE }),
      sites: () => ({}),
      apply: () => undefined,
      onChange: () => () => undefined,
    },
    gfx,
    stores: { models: { get: () => Promise.resolve(undefined), put: () => Promise.resolve() } },
    exclusive: async (fn) => {
      world.locked += 1;
      return await fn();
    },
    catalog: () => Promise.resolve(CATALOG),
    detectorBackend: () => "wasm",
    getURL: (path) => `chrome-extension://test/${path}`,
    platform: {
      loadOrt: () => Promise.resolve(fakeOrt(world)),
      models,
      now: () => 0,
      ...(options.mtRunner === undefined
        ? {}
        : {
            mtRunner: options.mtRunner(
              createLocalMtRunner({
                getOrt: () => Promise.resolve(mtOrt),
                exclusive: async (fn) => {
                  world.locked += 1;
                  return await fn();
                },
              }),
            ),
          }),
    },
  });
  const results: UnitResult[] = [];
  return {
    world,
    logs,
    results,
    settings,
    translator,
    run: (lang = "ko") => {
      const { image, units } = page();
      return translator.translate(
        {
          packId: "pk-1",
          frameKey: "1:0:d",
          seriesKey: null,
          lang,
          dir: "ltr",
          units,
          urgent: false,
          images: new Map([[image.contentKey, image]]),
        },
        (result) => results.push(result),
      );
    },
  };
}

const DEFAULT_SETTINGS_SITE = {
  enabled: true,
  mode: "auto" as const,
  includeSubdomains: false,
  credentials: "omit" as const,
  referer: "auto" as const,
  sourceLang: "auto" as const,
  layout: "auto" as const,
  extraFrameOrigins: [],
  prefetchAhead: true,
  addedAt: 0,
};

function byKey(results: readonly UnitResult[]): Record<string, UnitResult> {
  return Object.fromEntries(results.map((r) => [r.unitKey, r]));
}

describe("offline pack translation", () => {
  test("OCR, translation and per-unit outcomes; every unit exactly once; nothing uploaded", async () => {
    const h = harness();
    const report = await h.run();
    const r = byKey(h.results);
    assert.equal(h.results.length, 4);
    assert.deepEqual(
      [r["a"]?.status, r["a"]?.original, r["a"]?.translation, r["a"]?.type],
      ["ok", "가나다 가나다라", "hello world!", "dialogue"],
    );
    assert.deepEqual([r["b"]?.status, r["b"]?.translation], ["ok", "hello"]);
    assert.deepEqual([r["c"]?.status, r["c"]?.type], ["ignored", "ignore"], "edge page number");
    assert.deepEqual(
      [r["d"]?.status, r["d"]?.original, r["d"]?.translation, r["d"]?.type],
      ["keep-original", "가나", "", "sfx"],
    );
    assert.ok(
      h.results.every((x) => x.model === "offline:opus-mt-ko-en" && x.speaker === "" && x.lang === "ko"),
    );
    assert.deepEqual(
      { model: report.model, error: report.error, requests: report.requests, up: report.uploadedBytes },
      { model: "offline:opus-mt-ko-en", error: null, requests: 0, up: 0 },
    );
    assert.deepEqual(report.missing, []);
    assert.equal(report.learning, undefined, "the language was known: nothing to learn");
    assert.equal(h.translator.state().state, "ready");
    assert.deepEqual(h.translator.state().active, ["ocr-korean", "opus-mt-ko-en"]);
  });

  test("a balloon whose text is a repeated chunk (onomatopoeia) keeps its lettering as a sound effect", async () => {
    const h = harness();
    h.world.ocr["ocr-korean"] = {
      text: (n) => (n === 2 ? "가나가나" : n <= 1 ? "!" : "가나다라".slice(0, n)),
      confidence: 0.95,
    };
    await h.run();
    const r = byKey(h.results);
    assert.deepEqual(
      [r["b"]?.status, r["b"]?.original, r["b"]?.translation, r["b"]?.type],
      ["keep-original", "가나가나", "", "sfx"],
    );
    assert.equal(r["a"]?.status, "ok");
  });

  test("every ORT call (create and run) goes through the engine's lock", async () => {
    const h = harness();
    await h.run();
    const ortCalls = h.world.calls.length;
    assert.ok(ortCalls > 0);
    assert.equal(h.world.locked, ortCalls);
  });

  test("an unknown page language is voted from a few lines (Hangul here) and reported for learning", async () => {
    const h = harness();
    const report = await h.run("auto");
    assert.equal(report.lang, "ko");
    assert.deepEqual(report.learning, { terms: [], summary: null, lang: "ko" });
    assert.ok(h.world.calls.includes("ocr-cjk.run") && h.world.calls.includes("ocr-korean.run"));
    assert.equal(byKey(h.results)["a"]?.translation, "hello world!");
  });

  test("a pair without a direct model goes through English (two legs, one label)", async () => {
    const h = harness({ target: "vi" });
    const report = await h.run();
    assert.equal(report.model, "offline:opus-mt-ko-en+opus-mt-en-vi");
    const r = byKey(h.results);
    assert.deepEqual([r["a"]?.status, r["a"]?.translation], ["ok", "world"]);
    assert.ok(h.world.calls.includes("opus-mt-en-vi.encoder"));
  });

  test("the page already in the target language keeps its text without a translation model", async () => {
    const h = harness({ target: "ko" });
    const report = await h.run();
    const r = byKey(h.results);
    assert.deepEqual([r["a"]?.status, r["a"]?.original], ["keep-original", "가나다 가나다라"]);
    assert.equal(report.model, "offline:ocr-korean");
    assert.ok(!h.world.calls.some((call) => call.startsWith("opus-mt")));
  });

  test("an unsupported pair fails every unit with offline.pair_unsupported (nothing erased)", async () => {
    const h = harness({ target: "ja" });
    const report = await h.run();
    assert.equal(report.error?.code, "offline.pair_unsupported");
    assert.ok(h.results.every((r) => r.status === "error" && r.translation === ""));
    assert.equal(report.missing.length, 4);
    assert.equal(h.translator.state().state, "failed");
    assert.equal(h.translator.state().error, "offline.pair_unsupported");
  });

  test("a failed download fails the pack with offline.download; a later pack loads again", async () => {
    let fail = true;
    const h = harness({
      models: {
        load: (file) =>
          fail && file.role === "encoder"
            ? Promise.reject(new CtvError("offline.download", "HTTP 503", { retryable: true }))
            : Promise.resolve(fileBytes(file)),
      },
    });
    const report = await h.run();
    assert.equal(report.error?.code, "offline.download");
    // Units that needed no translation keep their outcome; the others fail without a translation.
    const failed = byKey(h.results);
    assert.deepEqual(
      ["a", "b", "c", "d"].map((key) => failed[key]?.status),
      ["error", "error", "ignored", "keep-original"],
    );
    assert.deepEqual(report.missing, ["a", "b"]);
    fail = false;
    h.results.length = 0;
    const again = await h.run();
    assert.equal(again.error, null);
    assert.equal(byKey(h.results)["a"]?.status, "ok");
  });

  test("download progress shows in the status while files are fetched", async () => {
    let seen: ReturnType<ReturnType<typeof createOfflineTranslator>["state"]> | null = null;
    const h = harness({
      models: {
        cached: () => Promise.resolve(false),
        load: (file, onBytes) => {
          onBytes?.(5);
          seen ??= h.translator.state();
          return Promise.resolve(fileBytes(file));
        },
      },
    });
    await h.run();
    assert.ok(seen !== null);
    const status = seen as ReturnType<typeof h.translator.state>;
    assert.equal(status.state, "downloading");
    assert.ok(status.download !== null && status.download.done === 5 && status.download.total === 20);
    assert.equal(h.translator.state().download, null);
    await h.translator.release();
    assert.deepEqual([h.translator.state().state, h.translator.state().active], ["idle", []]);
  });
});

describe("seq2seq generate", () => {
  const tokenizer = loadTokenizer(JSON.parse(TOKENIZER.toString("utf8")));
  const config = seq2seqConfig(JSON.parse(CONFIG));

  for (const merged of [true, false]) {
    test(`greedy decoding of a padded batch ${merged ? "with" : "without"} a key/value cache`, async () => {
      const world: FakeWorld = {
        calls: [],
        locked: 0,
        scripts: { m: (w) => (w >= 2 ? [4, 7, 8] : [4]) },
        ocr: {},
      };
      const rows: number[][] = [];
      const model: Seq2SeqModel = {
        encoder: encoderSession(world, "m", rows),
        decoder: decoderSession(world, "m", rows, merged),
        config,
        tokenizer,
      };
      const ort = fakeOrt(world);
      const out = await generate(
        ort,
        model,
        (session, feeds) => session.run(feeds),
        [
          [3, 1, 3, 1, 0],
          [3, 1, 0],
        ],
        {
          prefix: [],
          maxNew: () => 10,
        },
      );
      assert.deepEqual(out, [[4, 7, 8], [4]]);
      assert.equal(tokenizer.decode(out[0] ?? []), "hello world!");
    });
  }

  test("length limit and the no-repeat rule stop runaway output", async () => {
    const world: FakeWorld = {
      calls: [],
      locked: 0,
      scripts: { m: () => [4, 4, 4, 4, 4, 4, 4, 4] },
      ocr: {},
    };
    const rows: number[][] = [];
    const model: Seq2SeqModel = {
      encoder: encoderSession(world, "m", rows),
      decoder: decoderSession(world, "m", rows, true),
      config,
      tokenizer,
    };
    const out = await generate(fakeOrt(world), model, (s, f) => s.run(f), [[3, 1, 0]], {
      prefix: [],
      maxNew: () => 5,
      noRepeatNgram: 2,
    });
    // After "4" the bigram (4, 4) may appear once; the fake only scores 4, so the next best (id 0 = </s>) ends it.
    assert.deepEqual(out, [[4, 4]]);
    const capped = await generate(fakeOrt(world), model, (s, f) => s.run(f), [[3, 1, 0]], {
      prefix: [],
      maxNew: () => 3,
      noRepeatNgram: 0,
    });
    assert.deepEqual(capped, [[4, 4, 4]]);
  });

  test("config.json: heads, head size, special ids; missing fields fail", () => {
    assert.deepEqual(config, { heads: 2, headDim: 4, decoderStartId: 9, eosId: 0, padId: 9, suppress: [9] });
    assert.throws(() => seq2seqConfig({ d_model: 8 }), /decoder_attention_heads/u);
  });
});

describe("translation input", () => {
  test("all-capital lettering in sentence case; a full stop added when nothing closes the sentence", () => {
    assert.deepEqual(mtInput("THE NEXT MORNING", "en"), { text: "The next morning.", closed: true });
    assert.deepEqual(mtInput("WAIT, I FORGOT!", "en"), { text: "Wait, I forgot!", closed: false });
    assert.deepEqual(mtInput("翌朝", "ja"), { text: "翌朝。", closed: true });
    assert.deepEqual(mtInput("다음 날 아침", "ko"), { text: "다음 날 아침.", closed: true });
    assert.equal(reopen("Sáng hôm sau."), "Sáng hôm sau");
    assert.equal(reopen("Sáng hôm sau!"), "Sáng hôm sau!");
  });

  test("tidyTranslation drops the subtitle dash the source did not have", () => {
    assert.equal(tidyTranslation("- I'm off today", "本日休業"), "I'm off today");
    assert.equal(
      tidyTranslation("— Đã quá nửa thời gian rồi.", "이번엔 반반 내자."),
      "Đã quá nửa thời gian rồi.",
    );
    assert.equal(tidyTranslation("- Who's there?", "- 누구야?"), "- Who's there?");
    assert.equal(tidyTranslation("Well-known", "유명한"), "Well-known");
  });

  test("cleanText: single spaces, and the Spanish ¡ the Latin recognizer reads as i", () => {
    assert.equal(cleanText("  iESTE   MAPA ", "es"), "¡ESTE MAPA");
    assert.equal(cleanText("iPhone", "en"), "iPhone");
    assert.equal(
      cleanText("상자는 내가 들게.너는 문 좀 열어 줘.", "ko"),
      "상자는 내가 들게. 너는 문 좀 열어 줘.",
    );
    assert.equal(cleanText("WAIT...?", "en"), "WAIT...?");
    assert.equal(cleanText("七時に駅の前で会おう。待って", "ja"), "七時に駅の前で会おう。待って");
  });
});

describe("offline translation memory (the translation worker)", () => {
  /** An isolated runner over the in-process one that records unloads and resets and can fail generation. */
  function recording(failures: Array<Error | null>): {
    wrap: (inner: MtRunner) => MtRunner;
    unloads: string[];
    resets: string[];
  } {
    const unloads: string[] = [];
    const resets: string[] = [];
    const wrap = (inner: MtRunner): MtRunner => ({
      ...inner,
      isolated: true,
      heapBytes: () => 500_000_000,
      async generate(model, config, inputs, prefix) {
        const failure = failures.shift() ?? null;
        if (failure !== null) throw failure;
        return await inner.generate(model, config, inputs, prefix);
      },
      async unload(model) {
        unloads.push(model);
        await inner.unload(model);
      },
      async reset(reason) {
        resets.push(reason);
        await inner.reset(reason);
      },
    });
    return { wrap, unloads, resets };
  }

  test("a pivot pair, then a direct one: the model no longer needed is unloaded first", async () => {
    const r = recording([]);
    const h = harness({ target: "vi", mtRunner: r.wrap });
    await h.run();
    assert.deepEqual(h.translator.state().active, ["ocr-korean", "opus-mt-ko-en", "opus-mt-en-vi"]);
    h.settings.translate.targetLang = "en";
    h.results.length = 0;
    await h.run();
    assert.deepEqual(r.unloads, ["opus-mt-en-vi"]);
    assert.deepEqual(h.translator.state().active, ["ocr-korean", "opus-mt-ko-en"]);
    assert.equal(byKey(h.results)["a"]?.status, "ok");
    assert.deepEqual(h.translator.state().heap, { engine: 0, translation: 500_000_000 });
  });

  test("out of memory: the pack fails with offline.out_of_memory (nothing erased), the runner restarts, the next pack works", async () => {
    const r = recording([new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded")]);
    const h = harness({ mtRunner: r.wrap });
    const failed = await h.run();
    assert.equal(failed.error?.code, "offline.out_of_memory");
    assert.equal(failed.error?.retryable, true);
    const r1 = byKey(h.results);
    assert.deepEqual([r1["a"]?.status, r1["b"]?.status, r1["c"]?.status], ["error", "error", "ignored"]);
    assert.deepEqual(r.resets, ["offline.out_of_memory"]);
    assert.equal(h.translator.state().state, "failed");
    assert.equal(h.translator.state().error, "offline.out_of_memory");
    h.results.length = 0;
    const next = await h.run();
    assert.equal(next.error, null);
    assert.equal(byKey(h.results)["a"]?.translation, "hello world!");
  });

  test("a model out of memory twice in a row is refused without loading it again, until release()", async () => {
    const oom = (): Error => new Error("RuntimeError: Aborted(OOM)");
    const r = recording([oom(), oom()]);
    const h = harness({ mtRunner: r.wrap });
    await h.run();
    await h.run();
    const creates = h.world.calls.filter(
      (call) => call.startsWith("opus-mt-ko-en.") && call.endsWith(".create"),
    );
    const refused = await h.run();
    assert.equal(refused.error?.code, "offline.out_of_memory");
    assert.equal(refused.error?.retryable, false, "not retried on its own");
    assert.equal(
      h.world.calls.filter((call) => call.startsWith("opus-mt-ko-en.") && call.endsWith(".create")).length,
      creates.length,
      "no new session",
    );
    await h.translator.release();
    h.results.length = 0;
    assert.equal((await h.run()).error, null);
  });

  test("an unexpected runner failure (worker crashed) drops the models and fails the pack with offline.run", async () => {
    const r = recording([
      new CtvError("offline.run", "translation worker: worker crashed", { retryable: true }),
    ]);
    const h = harness({ mtRunner: r.wrap });
    const failed = await h.run();
    assert.equal(failed.error?.code, "offline.run");
    assert.equal(r.resets.length, 1);
    assert.deepEqual(h.translator.state().active, ["ocr-korean"]);
  });
});
