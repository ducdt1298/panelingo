// Series memory end to end: the real pipeline, translator and series memory over in-memory stores, with a scripted
// OpenAI-shaped transport (no network). Three images of one chapter are translated one after another: each request
// carries the lines and summary learned so far, and an @term given in two packs becomes a glossary entry.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TransportInit, TransportResponse } from "../../../src/engine/api-client.ts";
import { JPEG_DATA_URL_PREFIX } from "../../../src/engine/composite.ts";
import type {
  AcquiredImage,
  CompositeBuilder,
  DecodedImage,
  DetectionResult,
  FrameInfo,
  FrameSink,
  ImageAcquirer,
  ImageDecoder,
  TextDetector,
} from "../../../src/engine/contracts.ts";
import { createSeriesMemory } from "../../../src/engine/memory.ts";
import { createPipeline } from "../../../src/engine/pipeline.ts";
import { createSettingsCache } from "../../../src/engine/settings-cache.ts";
import { createTranslator } from "../../../src/engine/translator.ts";
import {
  GLOSSARY_HEADER,
  USER_HISTORY_HEADER,
  USER_SUMMARY_HEADER,
  type ChatMessage,
} from "../../../src/shared/core/prompt.ts";
import type { EngineToCs } from "../../../src/shared/protocol.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import type { UnitGeometry } from "../../../src/shared/types.ts";
import { toBase64 } from "../../../src/shared/wire.ts";
import {
  captureLogger,
  fakeHealth,
  fakeUploads,
  flushTurns,
  ManualClock,
  memoryStores,
} from "./store/engine-fakes.ts";

const PAGE_URL = "https://reader.example/manga/lone-hunter/chapter-3";
const SERIES = "https://reader.example|lone-hunter";
const CHAPTER = "https://reader.example/manga/lone-hunter/chapter-3";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);

/** The source lines of each image (contentKey "s:" + label), in reading order. */
const PAGES: Record<string, ReadonlyArray<readonly [original: string, translation: string]>> = {
  p1: [
    ["지호야!", "Jiho ơi!"],
    ["어디 가?", "Đi đâu thế?"],
  ],
  p2: [["던전에.", "Vào hầm ngục."]],
  p3: [["조심해, 지호.", "Cẩn thận nhé, Jiho."]],
};
/** What the model adds after the # lines of each image. */
const EXTRA: Record<string, string> = {
  p1: "@term|지호|Jiho|nhân vật chính\n@sum|Jiho meets Yuna in town.\n",
  p2: "@term|지호|Jiho|\n@term|던전|hầm ngục|\n@sum|Jiho heads for the dungeon.\n",
  p3: "@sum|Jiho enters the dungeon.\n",
};

function unitsOf(label: string): UnitGeometry[] {
  return (PAGES[label] ?? []).map((_, order) => {
    const text = { x1: 100, y1: 100 + order * 200, x2: 300, y2: 160 + order * 200 };
    return {
      unitKey: `${label}-u${order}`,
      kind: "bubble",
      bubble: null,
      text,
      texts: [text],
      orientation: "h",
      glyphPx: 24,
      order,
    };
  });
}

function sse(text: string): TransportResponse {
  const encoder = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return {
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body,
    text: () => Promise.resolve(""),
  };
}

interface Sent {
  label: string;
  system: string;
  user: string;
}

test("each request carries the chapter's earlier lines, summary and learned terms; @term lines become a glossary", async () => {
  const clock = new ManualClock();
  const { log } = captureLogger();
  const settings = createSettingsCache({ clock });
  const configured = structuredClone(DEFAULT_SETTINGS);
  configured.api.baseUrl = "http://api.invalid/v1";
  configured.translate.targetLang = "vi";
  configured.privacy.ackUploadNoticeAt = 1;
  settings.apply(configured, {});
  const stores = memoryStores();
  const health = fakeHealth("ready");
  const sent: Sent[] = [];
  /** Label of the image the next request is about (set by the composite). */
  let current = "";

  const composite: CompositeBuilder = {
    build: (request) => {
      current = (request.units[0]?.contentKey ?? "").slice(2);
      return Promise.resolve({
        ok: true,
        jpeg: JPEG,
        dataUrl: JPEG_DATA_URL_PREFIX + toBase64(JPEG),
        size: { w: 1024, h: 768 },
        marks: request.units.map((unit, i) => ({
          n: i + 1,
          contentKey: unit.contentKey,
          unitKey: unit.unitKey,
        })),
      });
    },
  };
  const transport = (url: string, init: TransportInit): Promise<TransportResponse> => {
    assert.ok(url.startsWith("http://api.invalid/v1"));
    const [system, user] = (JSON.parse(init.body) as { messages: ChatMessage[] }).messages;
    assert.ok(system?.role === "system" && user?.role === "user");
    const text = user.content.find((part) => part.type === "text");
    sent.push({ label: current, system: system.content, user: text?.type === "text" ? text.text : "" });
    const lines = (PAGES[current] ?? []).map(
      ([original, translation], i) => `#${i + 1}|dialogue||${original}|${translation}`,
    );
    return Promise.resolve(sse(`@lang|ko\n${lines.join("\n")}\n${EXTRA[current] ?? ""}`));
  };
  const translator = createTranslator({
    clock,
    log,
    settings,
    health,
    composite,
    uploads: fakeUploads(),
    transport,
  });

  const acquirer: ImageAcquirer = {
    acquire: (submit) => {
      const label = submit.src.split("/").at(-1) ?? "";
      const image: AcquiredImage = {
        bytes: new TextEncoder().encode(label).buffer,
        mime: "image/png",
        source: "url",
        lowRes: false,
        url: submit.src,
      };
      return Promise.resolve(image);
    },
  };
  const decoder: ImageDecoder = {
    contentKeyOf: (bytes) => Promise.resolve(`s:${new TextDecoder().decode(bytes)}`),
    decode: (_image, contentKey) => {
      const decoded: DecodedImage = {
        contentKey,
        size: { w: 800, h: 1200 },
        bitmap: { width: 800, height: 1200, close: () => undefined },
        release: () => undefined,
      };
      return Promise.resolve(decoded);
    },
  };
  const detector: TextDetector = {
    state: () => ({ backend: "wasm", state: "ready", canary: "skipped" }),
    detect: (image): Promise<DetectionResult> =>
      Promise.resolve({
        backend: "wasm",
        detectorVersion: "v4s:test",
        slices: [{ y1: 0, y2: image.size.h }],
        rawDetections: [],
        units: unitsOf(image.contentKey.slice(2)),
        timings: { inferMs: [1], totalMs: 1 },
      }),
    unitsFrom: () => [],
    warmup: () => Promise.resolve(),
    release: () => Promise.resolve(),
  };
  const memory = createSeriesMemory({ clock, log, settings, stores });
  const pipeline = createPipeline({
    clock,
    log,
    settings,
    stores,
    health,
    acquirer,
    decoder,
    detector,
    translator,
    ui: { post: () => undefined },
    memory,
  });
  const info: FrameInfo = {
    frameKey: "1:0:doc",
    tabId: 1,
    frameId: 0,
    documentId: "doc",
    url: PAGE_URL,
    origin: "https://reader.example",
    siteKey: "https://reader.example",
    mode: "auto",
    codec: "sc",
    page: { title: "Lone Hunter - Chapter 3", layout: "webtoon", visible: true, dpr: 1 },
    viewport: null,
    focusSeq: 1,
  };
  const frame: FrameSink = { info, connected: true, post: (_message: EngineToCs) => true };

  const read = async (label: string, docOrder: number): Promise<void> => {
    pipeline.submit(frame, {
      imageKey: `${docOrder}.0`,
      src: `https://cdn.example/${label}`,
      natural: { w: 800, h: 1200 },
      displayed: { w: 800, h: 1200 },
      element: "img",
      priority: docOrder,
      pos: { docOrder, srcGen: 0, yTop: docOrder * 1200 },
      acquire: "url",
    });
    await flushTurns(60);
    await memory.idle();
  };

  // Image 1: nothing known yet.
  await read("p1", 1);
  assert.equal(sent.length, 1);
  assert.ok(!sent[0]?.system.includes(GLOSSARY_HEADER));
  assert.ok(!sent[0]?.user.includes(USER_HISTORY_HEADER) && !sent[0]?.user.includes(USER_SUMMARY_HEADER));
  assert.ok(sent[0]?.system.includes("@sum|<the story so far in Vietnamese"), "a summary is asked for");
  assert.deepEqual(
    (await stores.glossary.forSeries(SERIES)).map((e) => [e.orig, e.state]),
    [["지호", "candidate"]],
  );
  assert.equal((await stores.chapters.get(CHAPTER))?.summary, "Jiho meets Yuna in town.");
  assert.equal((await stores.series.get(SERIES))?.title, "Lone Hunter");

  // Image 2: the lines and summary of image 1; the candidate is not sent yet.
  await read("p2", 2);
  const second = sent[1];
  assert.equal(second?.label, "p2");
  assert.ok(second?.user.includes(`${USER_SUMMARY_HEADER}\nJiho meets Yuna in town.`));
  assert.ok(second?.user.includes(`${USER_HISTORY_HEADER}\n지호야! => Jiho ơi!\n어디 가? => Đi đâu thế?`));
  assert.ok(!second?.system.includes(GLOSSARY_HEADER), "candidates are never sent");
  assert.deepEqual(
    (await stores.glossary.forSeries(SERIES)).map((e) => [e.orig, e.state]),
    [
      ["던전", "candidate"],
      ["지호", "learned"],
    ],
    "seen in two packs: learned",
  );
  assert.equal((await stores.series.get(SERIES))?.lang, "ko", "two @lang votes settled the series language");

  // Image 3: the learned term, every earlier line in page order and the newest summary.
  await read("p3", 3);
  const third = sent[2];
  assert.equal(third?.label, "p3");
  assert.ok(third?.system.includes(`${GLOSSARY_HEADER}\n지호 -> Jiho (nhân vật chính)`));
  assert.ok(!third?.system.includes("던전 -> hầm ngục"));
  assert.ok(
    third?.user.includes(
      `${USER_HISTORY_HEADER}\n지호야! => Jiho ơi!\n어디 가? => Đi đâu thế?\n던전에. => Vào hầm ngục.`,
    ),
  );
  assert.ok(third?.user.includes(`${USER_SUMMARY_HEADER}\nJiho heads for the dungeon.`));
  assert.equal((await stores.chapters.get(CHAPTER))?.summary, "Jiho enters the dungeon.");
  assert.deepEqual(
    (await stores.pages.forChapter(CHAPTER)).map((page) => [page.contentKey, page.orderKey]),
    [
      ["s:p1", 1],
      ["s:p2", 2],
      ["s:p3", 3],
    ],
  );
  // Every stored line carries its series.
  const records = await stores.translations.forImage("s:p3");
  assert.deepEqual(
    records.map((record) => [record.seriesKey, record.translation]),
    [[SERIES, "Cẩn thận nhé, Jiho."]],
  );
});
