// Port "engine" handlers: every CsToEngine message maps to the pipeline, FrameInfo or the LogStore, after validation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCsHandler,
  MAX_LOG_ENTRIES_PER_MESSAGE,
  parseCaptureReply,
  parseImageSubmit,
  parseViewport,
  sanitizeLogEntry,
  type CsHandler,
} from "../../../src/engine/handlers-cs.ts";
import type { CaptureReply } from "../../../src/engine/capture.ts";
import { createFrameRegistry, type FrameHandle } from "../../../src/engine/ports.ts";
import type { EnginePort, EnginePortEntry } from "../../../src/engine/ready-gate.ts";
import type { CsToEngine, EngineToCs } from "../../../src/shared/protocol.ts";
import type { LogEntry } from "../../../src/shared/types.ts";
import {
  captureLogger,
  csHello,
  imageSubmit,
  ManualClock,
  memoryStores,
  recordingPipeline,
  type MemoryStores,
  type RecordingPipeline,
} from "./store/engine-fakes.ts";

interface Rig {
  handle: CsHandler;
  frame: FrameHandle;
  port: EnginePort;
  sent: EngineToCs[];
  pipeline: RecordingPipeline;
  stores: MemoryStores;
  entries: LogEntry[];
  hellos: number;
}

function rig(capture?: { receive(frameKey: string, reply: CaptureReply): void }): Rig {
  const clock = new ManualClock();
  const { log, entries } = captureLogger();
  const sent: EngineToCs[] = [];
  const port = {
    raw: {},
    codec: "sc",
    closed: false,
    post: (message: EngineToCs) => {
      sent.push(message);
      return true;
    },
    on: () => () => undefined,
    request: () => Promise.reject(new Error("unused")),
    onClose: () => undefined,
    close: () => undefined,
  } as unknown as EnginePort;
  const frames = createFrameRegistry({
    clock,
    log,
    events: { frameGone: () => undefined, frameReplaced: () => undefined },
  });
  const portEntry: EnginePortEntry = {
    kind: "engine",
    port,
    sender: { id: "x", url: "https://reader.example/ch/1", frameId: 0, documentId: "D" },
    frameKey: "5:0:D",
    tabId: 5,
    frameId: 0,
    documentId: "D",
    url: "https://reader.example/ch/1",
    origin: "https://reader.example",
    hello: null,
  };
  const frame = frames.open(portEntry);
  const pipeline = recordingPipeline();
  const stores = memoryStores();
  const state: Rig = {
    frame,
    port,
    sent,
    pipeline,
    stores,
    entries,
    hellos: 0,
    handle: () => undefined,
  };
  state.handle = createCsHandler({
    log,
    frames,
    pipeline,
    logs: stores.logs,
    now: () => clock.now(),
    onHello: () => {
      state.hellos += 1;
    },
    ...(capture === undefined ? {} : { capture }),
  });
  return state;
}

const send = (r: Rig, message: object): void => r.handle(r.frame, message as CsToEngine);

test("img:submit: a clean copy goes to pipeline.submit with the frame as its sink", () => {
  const r = rig();
  send(r, { ...imageSubmit(1), bogus: "x", prefetch: false, altSrcs: ["https://a/1.jpg", 3, ""] });
  const call = r.pipeline.calls[0];
  assert.equal(call?.kind, "submit");
  assert.ok(call?.kind === "submit");
  assert.equal(call.frameKey, "5:0:D");
  assert.deepEqual(call.submit, {
    imageKey: "1.0",
    src: "https://cdn.example/ch1/1.jpg",
    natural: { w: 800, h: 2_000 },
    displayed: { w: 800, h: 2_000 },
    element: "img",
    priority: 1,
    pos: { docOrder: 1, srcGen: 0, yTop: 2_000 },
    acquire: "url",
    altSrcs: ["https://a/1.jpg"],
  });
  assert.equal(r.pipeline.sinks[0], r.frame);
  assert.deepEqual(r.frame.images.get("1.0")?.pos, { docOrder: 1, srcGen: 0, yTop: 2_000 });
});

test("parseImageSubmit keeps valid optional fields and rejects broken required ones", () => {
  const bytes = new ArrayBuffer(4);
  const full = parseImageSubmit({
    ...imageSubmit(2),
    natural: null,
    element: "canvas",
    acquire: "bytes",
    bytes,
    mime: "image/png",
    source: "cs-canvas",
    refPolicy: "strict-origin-when-cross-origin",
    strip: { stripId: "s1", index: 2 },
    prefetch: true,
    force: true,
  });
  assert.equal(full?.natural, null);
  assert.equal(full?.bytes, bytes);
  assert.equal(full?.source, "cs-canvas");
  assert.deepEqual(full?.strip, { stripId: "s1", index: 2 });
  assert.equal(full?.prefetch, true);
  assert.equal(full?.force, true);
  assert.deepEqual(parseImageSubmit({ ...imageSubmit(2), acquire: "bytes", bytes: { b64: "AAEC" } })?.bytes, {
    b64: "AAEC",
  });
  assert.equal(
    parseImageSubmit({ ...imageSubmit(2), bytes })?.bytes,
    undefined,
    "bytes only with acquire bytes",
  );
  for (const broken of [
    { ...imageSubmit(3), pos: { docOrder: "1" } },
    { ...imageSubmit(3), element: "video" },
    { ...imageSubmit(3), acquire: "bytes" },
    { ...imageSubmit(3), natural: { w: -1, h: 1 } },
    { ...imageSubmit(3), displayed: undefined },
    { ...imageSubmit(3), imageKey: "" },
    { ...imageSubmit(3), src: "x".repeat(9_000) },
    { ...imageSubmit(3), priority: Number.NaN },
    null,
    "img",
  ]) {
    assert.equal(parseImageSubmit(broken), null, JSON.stringify(broken));
  }
});

test("an invalid submit is answered with img:state error engine.protocol and never reaches the pipeline", () => {
  const r = rig();
  send(r, { ...imageSubmit(1), element: "video" });
  send(r, { ...imageSubmit(1), imageKey: 42 });
  assert.equal(r.pipeline.calls.length, 0);
  assert.equal(r.sent.length, 1);
  const state = r.sent[0];
  assert.ok(state?.type === "img:state");
  assert.equal(state.imageKey, "1.0");
  assert.equal(state.state, "error");
  assert.equal(state.error?.code, "engine.protocol");
});

test("priority, forget, retry and edit map to the pipeline with the frame's key", async () => {
  const r = rig();
  send(r, imageSubmit(1));
  send(r, {
    type: "img:priority",
    items: [{ imageKey: "1.0", priority: 5 }, { imageKey: 3 }, { imageKey: "2.0", priority: Number.NaN }],
  });
  send(r, { type: "img:priority", items: "nope" });
  send(r, { type: "img:forget", imageKeys: ["1.0", 7, ""] });
  send(r, { type: "img:forget", imageKeys: [] });
  send(r, { type: "img:retry", imageKey: "1.0" });
  send(r, { type: "img:retry", imageKey: "1.0", unitKey: "4:5:6:7" });
  send(r, { type: "img:retry" });
  send(r, { type: "unit:edit", imageKey: "1.0", unitKey: "4:5:6:7", translation: "Chào cậu" });
  send(r, { type: "unit:edit", imageKey: "1.0", unitKey: "4:5:6:7", translation: null });
  send(r, { type: "unit:edit", imageKey: "1.0", unitKey: "4:5:6:7", translation: 5 });
  assert.deepEqual(r.pipeline.calls.slice(1), [
    { kind: "priority", frameKey: "5:0:D", items: [{ imageKey: "1.0", priority: 5 }] },
    { kind: "forget", frameKey: "5:0:D", imageKeys: ["1.0"] },
    { kind: "retry", frameKey: "5:0:D", imageKey: "1.0", unitKey: undefined },
    { kind: "retry", frameKey: "5:0:D", imageKey: "1.0", unitKey: "4:5:6:7" },
    {
      kind: "edit",
      target: { frameKey: "5:0:D", imageKey: "1.0" },
      unitKey: "4:5:6:7",
      translation: "Chào cậu",
    },
    { kind: "edit", target: { frameKey: "5:0:D", imageKey: "1.0" }, unitKey: "4:5:6:7", translation: null },
  ]);
  assert.equal(r.frame.images.has("1.0"), false, "forgotten images leave the transcript bookkeeping");

  r.pipeline.edit = () => Promise.reject(new Error("store down"));
  send(r, { type: "unit:edit", imageKey: "1.0", unitKey: "u", translation: "x" });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(r.entries.some((entry) => entry.msg === "unit:edit failed"));
});

test("frame state: codec, same-origin cs:page, visibility, viewport; no-ops and hello", () => {
  const r = rig();
  send(r, { type: "cs:codec", codec: "b64" });
  assert.equal(r.frame.info.codec, "b64");
  assert.equal(r.port.codec, "b64");

  send(r, { type: "cs:page", url: "https://reader.example/ch/2", title: "Chapter 2" });
  assert.equal(r.frame.info.url, "https://reader.example/ch/2");
  assert.equal(r.frame.info.page.title, "Chapter 2");
  send(r, { type: "cs:page", url: "https://evil.example/ch/2", title: "x" });
  send(r, { type: "cs:page", url: "not a url", title: "x" });
  assert.equal(r.frame.info.url, "https://reader.example/ch/2");
  assert.equal(
    r.entries.filter((entry) => entry.msg === "cs:page ignored: not the frame's origin").length,
    2,
  );

  send(r, { type: "cs:visibility", visible: false });
  assert.equal(r.frame.info.page.visible, false);
  send(r, {
    type: "cs:viewport",
    scrollY: 10,
    innerHeight: 900,
    secondsPerScreen: 3.5,
    onScreen: ["1.0", 2],
  });
  assert.deepEqual(r.frame.info.viewport, {
    scrollY: 10,
    innerHeight: 900,
    secondsPerScreen: 3.5,
    onScreen: ["1.0"],
  });
  send(r, { type: "cs:viewport", scrollY: "x" });
  assert.equal(r.frame.info.viewport?.scrollY, 10);
  assert.equal(parseViewport(null), null);
  send(r, { type: "cs:visibility", visible: "yes" });
  // Visibility and viewport changes re-rank the queue at once (empty priority list); invalid ones do not.
  assert.deepEqual(
    r.pipeline.calls.filter((call) => call.kind === "priority"),
    [
      { kind: "priority", frameKey: "5:0:D", items: [] },
      { kind: "priority", frameKey: "5:0:D", items: [] },
    ],
  );

  send(r, { type: "cs:heartbeat" });
  send(r, { type: "unit:overflow", imageKey: "1.0", unitKey: "u", overflow: true });
  send(r, {
    type: "cap:ready",
    reqId: "r",
    rect: { left: 0, top: 0, width: 1, height: 1 },
    viewport: { w: 1, h: 1 },
    dpr: 1,
  });
  send(r, { type: "cap:fail", reqId: "r", reason: "hidden" });
  send(r, csHello());
  assert.equal(r.hellos, 1);
  assert.deepEqual(
    r.pipeline.calls.map((call) => call.kind),
    ["priority", "priority"],
    "only the two re-rank nudges: no-ops and hello never reach the pipeline",
  );
  assert.equal(r.sent.length, 0);
});

test("cs:log: at most 50 entries per message, tagged ctx cs + frameKey, data kept flat and bounded", () => {
  const r = rig();
  const entries = Array.from({ length: 60 }, (_, i) => ({
    t: i,
    level: i === 0 ? "error" : "loud",
    ctx: "engine",
    msg: `cs ${i}`,
    frameKey: "spoofed",
    data: { n: i, ok: true, nested: { x: 1 }, text: "y".repeat(900) },
    seq: 9,
  }));
  send(r, { type: "cs:log", entries: [null, ...entries] });
  const logs = r.stores.data.logs;
  assert.equal(logs.length, MAX_LOG_ENTRIES_PER_MESSAGE - 1, "the first slot was invalid");
  assert.equal(logs[0]?.level, "error");
  assert.equal(logs[1]?.level, "info", "unknown levels become info");
  assert.ok(logs.every((entry) => entry.ctx === "cs" && entry.frameKey === "5:0:D"));
  assert.deepEqual(Object.keys(logs[0]?.data ?? {}).sort(), ["n", "ok", "text"]);
  assert.equal((logs[0]?.data?.text as string).length, 500);
  assert.equal("seq" in (logs[0] ?? {}), false);
  send(r, { type: "cs:log", entries: "nope" });
  assert.equal(r.stores.data.logs.length, MAX_LOG_ENTRIES_PER_MESSAGE - 1);
  assert.equal(sanitizeLogEntry({ msg: 3 }, "f", 1), null);
  assert.equal(sanitizeLogEntry({ msg: "m", t: "x" }, "f", 77)?.t, 77);
});

test("unit:retranslate (bubble popup): that unit of the image's content in the frame's tab, else a retry", () => {
  const r = rig();
  send(r, imageSubmit(1));
  send(r, { type: "unit:retranslate", imageKey: "1.0", unitKey: "4:5:6:7" });
  r.frame.post({
    type: "img:units",
    imageKey: "1.0",
    contentKey: "c-1",
    natural: { w: 800, h: 2_000 },
    units: [],
  });
  send(r, { type: "unit:retranslate", imageKey: "1.0", unitKey: "4:5:6:7" });
  send(r, { type: "unit:retranslate", imageKey: "1.0" });
  send(r, { type: "unit:retranslate", imageKey: 7, unitKey: "u" });
  assert.deepEqual(r.pipeline.calls.slice(1), [
    { kind: "retry", frameKey: "5:0:D", imageKey: "1.0", unitKey: "4:5:6:7" },
    { kind: "retranslate", scope: { tabId: 5, contentKey: "c-1", unitKey: "4:5:6:7" } },
  ]);
  assert.equal(r.entries.filter((entry) => entry.msg === "invalid unit:retranslate").length, 2);
});

test("cap:ready / cap:fail: validated, then handed to the capture sessions with the frame's key", () => {
  const replies: Array<[string, CaptureReply]> = [];
  const r = rig({ receive: (frameKey, reply) => replies.push([frameKey, reply]) });
  const ready = {
    type: "cap:ready",
    reqId: "cap-1",
    rect: { left: 40, top: 53.5, width: 1200, height: 800 },
    viewport: { w: 1280, h: 900 },
    dpr: 2,
    extra: "dropped",
  };
  send(r, ready);
  send(r, { type: "cap:fail", reqId: "cap-1", reason: "moved" });
  send(r, { type: "cap:fail", reqId: "cap-1", reason: "bogus" });
  send(r, { ...ready, dpr: 0 });
  send(r, { ...ready, viewport: { w: 0, h: 900 } });
  send(r, { ...ready, rect: { left: 0, top: 0, width: -1, height: 5 } });
  send(r, { ...ready, reqId: "" });
  assert.deepEqual(replies, [
    [
      "5:0:D",
      {
        type: "cap:ready",
        reqId: "cap-1",
        rect: { left: 40, top: 53.5, width: 1200, height: 800 },
        viewport: { w: 1280, h: 900 },
        dpr: 2,
      },
    ],
    ["5:0:D", { type: "cap:fail", reqId: "cap-1", reason: "moved" }],
  ]);
  assert.equal(r.entries.filter((e) => e.msg === "invalid capture reply").length, 5);
  assert.equal(parseCaptureReply({ type: "cap:fail", reqId: "x", reason: "not-visible" })?.type, "cap:fail");
  assert.deepEqual(parseCaptureReply({ type: "cap:fail", reqId: "x", reason: "frame" }), {
    type: "cap:fail",
    reqId: "x",
    reason: "frame",
  });
  const clip = { left: 100, top: 50, width: 600, height: 400 };
  assert.deepEqual(parseCaptureReply({ ...ready, clip }), {
    type: "cap:ready",
    reqId: "cap-1",
    rect: { left: 40, top: 53.5, width: 1200, height: 800 },
    viewport: { w: 1280, h: 900 },
    dpr: 2,
    clip,
  });
  assert.equal(parseCaptureReply({ ...ready, clip: { left: 0, top: 0, width: -5, height: 1 } }), null);
  assert.equal(parseCaptureReply({ type: "img:submit", reqId: "x" }), null);
  assert.equal(parseCaptureReply(null), null);
});
