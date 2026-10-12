// Frame and UI registries: FrameInfo from port.sender, 60 s reconnect grace, replacement, UI watch routing.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFrameRegistry,
  createUiRegistry,
  FRAME_GRACE_MS,
  sanitizePage,
  type FrameRegistry,
} from "../../../src/engine/ports.ts";
import type { EnginePort, EnginePortEntry, UiPort, UiPortEntry } from "../../../src/engine/ready-gate.ts";
import type { FrameSink } from "../../../src/engine/contracts.ts";
import type { EngineToCs, EngineToUi } from "../../../src/shared/protocol.ts";
import { makeProbe } from "../../../src/shared/wire.ts";
import { captureLogger, csHello, ManualClock } from "./store/engine-fakes.ts";

interface FakePortControl<M> {
  sent: M[];
  closes: number;
  /** The other side went away. */
  drop(): void;
  throwOnPost: boolean;
}

function fakePort<M>(): { port: EnginePort & UiPort; control: FakePortControl<M> } {
  let closed = false;
  const handlers: Array<(lastError: string | null) => void> = [];
  const control: FakePortControl<M> = {
    sent: [],
    closes: 0,
    throwOnPost: false,
    drop: () => {
      if (closed) return;
      closed = true;
      for (const handler of handlers) handler(null);
    },
  };
  const port = {
    raw: {},
    codec: "sc",
    get closed() {
      return closed;
    },
    post: (message: M) => {
      if (control.throwOnPost) throw new Error("boom");
      if (closed) return false;
      control.sent.push(message);
      return true;
    },
    on: () => () => undefined,
    request: () => Promise.reject(new Error("unused")),
    onClose: (handler: (lastError: string | null) => void) => {
      handlers.push(handler);
    },
    close: () => {
      if (closed) return;
      control.closes += 1;
      control.drop();
    },
  };
  return { port: port as unknown as EnginePort & UiPort, control };
}

function entry(tabId: number, port: EnginePort, documentId = `DOC${tabId}`): EnginePortEntry {
  const url = `https://reader.example/ch/${tabId}`;
  return {
    kind: "engine",
    port,
    sender: { id: "x", url, frameId: 0, documentId },
    frameKey: `${tabId}:0:${documentId}`,
    tabId,
    frameId: 0,
    documentId,
    url,
    origin: "https://reader.example",
    hello: null,
  };
}

interface Registry {
  clock: ManualClock;
  frames: FrameRegistry;
  events: string[];
  replaced: FrameSink[];
  posts: string[];
}

function registry(): Registry {
  const clock = new ManualClock();
  const events: string[] = [];
  const replaced: FrameSink[] = [];
  const posts: string[] = [];
  const frames = createFrameRegistry({
    clock,
    log: captureLogger().log,
    events: {
      frameGone: (frameKey) => events.push(`gone:${frameKey}`),
      frameReplaced: (frame) => {
        replaced.push(frame);
        events.push(`replaced:${frame.info.frameKey}`);
      },
    },
    defaultMode: (siteKey) => (siteKey === "https://reader.example" ? "manual" : "auto"),
    onPost: (_frame, message) => posts.push(message.type),
    onPortsChanged: () => events.push("ports"),
  });
  return { clock, frames, events, replaced, posts };
}

test("a frame's identity comes from the port entry; cs:hello sets mode, page hints and codec", () => {
  const { frames } = registry();
  const { port } = fakePort<EngineToCs>();
  const frame = frames.open(entry(3, port));
  assert.deepEqual(
    {
      frameKey: frame.info.frameKey,
      tabId: frame.info.tabId,
      siteKey: frame.info.siteKey,
      origin: frame.info.origin,
      mode: frame.info.mode,
      codec: frame.info.codec,
      viewport: frame.info.viewport,
    },
    {
      frameKey: "3:0:DOC3",
      tabId: 3,
      siteKey: "https://reader.example",
      origin: "https://reader.example",
      mode: "manual",
      codec: "sc",
      viewport: null,
    },
  );
  assert.equal(frame.connected, true);
  assert.equal(frames.hello(frame, csHello("auto")), "sc");
  assert.equal(frame.info.mode, "auto");
  assert.equal(frame.info.page.layout, "webtoon");
  assert.ok(frame.info.focusSeq > 0, "a visible frame takes the focus order");
  const b64 = frames.hello(frame, { ...csHello(), probe: {} as never, page: { bogus: true } as never });
  assert.equal(b64, "b64");
  assert.equal(frame.info.codec, "b64");
  assert.equal(port.codec, "b64");
  assert.equal(frame.info.page.layout, "webtoon", "malformed hints keep the previous values");
  const before = frame.info.focusSeq;
  frames.setVisible(frame, false);
  assert.equal(frame.info.page.visible, false);
  assert.equal(frame.info.focusSeq, before);
  frames.setVisible(frame, true);
  assert.ok(frame.info.focusSeq > before);
});

test("post() reaches the current port, learns contentKeys and never throws", () => {
  const { frames, posts } = registry();
  const { port, control } = fakePort<EngineToCs>();
  const frame = frames.open(entry(1, port));
  frame.noteSubmit("7.0", { docOrder: 7, srcGen: 0, yTop: 900 });
  assert.equal(
    frame.post({
      type: "img:units",
      imageKey: "7.0",
      contentKey: "s:77",
      natural: { w: 1, h: 1 },
      units: [],
    }),
    true,
  );
  assert.deepEqual(frame.images.get("7.0"), {
    pos: { docOrder: 7, srcGen: 0, yTop: 900 },
    contentKey: "s:77",
  });
  assert.deepEqual(posts, ["img:units"]);
  frame.forgetImages(["7.0"]);
  assert.equal(frame.images.size, 0);
  control.throwOnPost = true;
  assert.equal(frame.post({ type: "en:closing" }), false);
  control.throwOnPost = false;
  control.drop();
  assert.equal(frame.post({ type: "en:closing" }), false);
  assert.equal(control.sent.length, 1);
});

test("a closed port keeps its frame for 60 s; a reconnect within the grace replaces the port, not the frame", async () => {
  const { clock, frames, events, replaced } = registry();
  const first = fakePort<EngineToCs>();
  const firstEntry = entry(1, first.port);
  const frame = frames.open(firstEntry);
  first.control.drop();
  frames.closed(firstEntry);
  assert.equal(frame.connected, false);
  assert.equal(frame.disconnectedAt, clock.now());
  assert.equal(frames.connectedCount(), 0);
  assert.equal(frame.post({ type: "en:closing" }), false);

  await clock.advance(FRAME_GRACE_MS - 1);
  const second = fakePort<EngineToCs>();
  const again = frames.open(entry(1, second.port));
  assert.equal(again, frame, "same FrameSink object for the pipeline");
  assert.deepEqual(replaced, [frame]);
  assert.equal(frame.connected, true);
  assert.equal(frame.post({ type: "en:closing" }), true);
  assert.equal(second.control.sent.length, 1);
  frames.closed(firstEntry);
  await clock.advance(FRAME_GRACE_MS * 2);
  assert.equal(frame.connected, true, "a late close of the old port is ignored");
  assert.ok(!events.some((event) => event.startsWith("gone:")));
});

test("after the grace the frame is gone for good; a new document is a new frame", async () => {
  const { clock, frames, events } = registry();
  const { port, control } = fakePort<EngineToCs>();
  const first = entry(2, port);
  frames.open(first);
  control.drop();
  frames.closed(first);
  await clock.advance(FRAME_GRACE_MS);
  assert.deepEqual(
    events.filter((event) => event !== "ports"),
    ["gone:2:0:DOC2"],
  );
  assert.equal(frames.get("2:0:DOC2"), undefined);
  const next = frames.open(entry(2, fakePort<EngineToCs>().port, "DOC2-NEW"));
  assert.equal(next.info.frameKey, "2:0:DOC2-NEW");
  assert.ok(!events.some((event) => event.startsWith("replaced:")));
});

test("two live ports for one document: the newest wins and the old one is closed", () => {
  const { frames } = registry();
  const old = fakePort<EngineToCs>();
  const oldEntry = entry(4, old.port);
  const frame = frames.open(oldEntry);
  const fresh = fakePort<EngineToCs>();
  const freshEntry = entry(4, fresh.port);
  frames.open(freshEntry);
  assert.equal(old.control.closes, 1);
  frames.closed(oldEntry);
  assert.equal(frame.connected, true);
  assert.equal(frames.forEntry(oldEntry), undefined);
  assert.equal(frames.forEntry(freshEntry), frame);
});

test("lists, broadcast and closeAll", () => {
  const { frames, events } = registry();
  const ports = [fakePort<EngineToCs>(), fakePort<EngineToCs>(), fakePort<EngineToCs>()];
  frames.open(entry(1, ports[0]!.port));
  frames.open(entry(1, ports[1]!.port, "IFRAME"));
  frames.open(entry(2, ports[2]!.port));
  assert.equal(frames.list().length, 3);
  assert.deepEqual(
    frames
      .byTab(1)
      .map((frame) => frame.info.documentId)
      .sort(),
    ["DOC1", "IFRAME"],
  );
  ports[2]!.control.drop();
  assert.equal(frames.broadcast({ type: "en:closing" }), 2);
  frames.closeAll();
  assert.equal(frames.list().length, 0);
  assert.equal(ports[0]!.control.closes, 1);
  assert.ok(!events.some((event) => event.startsWith("gone:")), "closeAll starts no grace timers");
});

test("sanitizePage keeps only valid hints", () => {
  const fallback = { title: "t", layout: "auto" as const, visible: true, dpr: 1 };
  assert.deepEqual(
    sanitizePage({ title: "x".repeat(900), layout: "paged-rtl", visible: false, dpr: 2 }, fallback),
    {
      title: "x".repeat(500),
      layout: "paged-rtl",
      visible: false,
      dpr: 2,
    },
  );
  assert.deepEqual(sanitizePage({ layout: "spiral", dpr: -1 }, fallback), fallback);
  assert.deepEqual(sanitizePage(null, fallback), fallback);
});

test("UI registry: hello codec and ui:watch routing (global to every watcher, tab-scoped to that tab)", () => {
  const changes: number[] = [];
  const ui = createUiRegistry({ log: captureLogger().log, onPortsChanged: () => changes.push(1) });
  const make = (): { entry: UiPortEntry; control: FakePortControl<EngineToUi> } => {
    const { port, control } = fakePort<EngineToUi>();
    return { entry: { kind: "ui", port, sender: { id: "x" }, hello: null }, control };
  };
  const popup = make();
  const panel = make();
  const idle = make();
  const popupClient = ui.open(popup.entry);
  const panelClient = ui.open(panel.entry);
  ui.open(idle.entry);
  assert.equal(ui.hello(popupClient, { type: "ui:hello", v: 1, probe: makeProbe(), view: "popup" }), "sc");
  ui.watch(popupClient, null);
  ui.watch(panelClient, 9);
  assert.equal(ui.watchers().length, 2);

  ui.post({ type: "tx:reset", tabId: 9 }, 9);
  ui.post({ type: "tx:reset", tabId: 8 }, 8);
  ui.post({ type: "tx:reset", tabId: 0 });
  assert.deepEqual(
    popup.control.sent.map((m) => m.type === "tx:reset" && m.tabId),
    [0],
  );
  assert.deepEqual(
    panel.control.sent.map((m) => m.type === "tx:reset" && m.tabId),
    [9, 0],
  );
  assert.equal(idle.control.sent.length, 0, "not watching: nothing pushed");
  assert.equal(ui.count(), 3);
  ui.closed(panel.entry);
  assert.equal(ui.count(), 2);
  assert.equal(ui.get(panel.entry), undefined);
  ui.closeAll();
  assert.equal(ui.count(), 0);
  assert.equal(popup.control.closes, 1);
  assert.equal(changes.length, 4);
});
