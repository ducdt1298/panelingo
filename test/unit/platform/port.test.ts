import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createLogger, type Logger } from "../../../src/platform/log.ts";
import { wrapPort, type TypedPort } from "../../../src/platform/port.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { CsToEngineMap, EngineToCsMap } from "../../../src/shared/protocol.ts";
import type { LogEntry } from "../../../src/shared/types.ts";
import { isProbe, makeProbe } from "../../../src/shared/wire.ts";
import { CHROME_ERRORS, FakeBrowser, type FakeContext, type FakePort } from "../../support/chrome-fake.ts";

type CsSide = TypedPort<EngineToCsMap, CsToEngineMap>;
type EngineSide = TypedPort<CsToEngineMap, EngineToCsMap>;

let browser: FakeBrowser;
let engine: FakeContext;
let logs: LogEntry[];
let log: Logger;

beforeEach(async () => {
  browser = new FakeBrowser();
  browser.install();
  const sw = await browser.startServiceWorker();
  await sw.run(() =>
    sw.ext.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "test" }),
  );
  assert.ok(browser.offscreen !== null);
  engine = browser.offscreen;
  logs = [];
  log = createLogger("debug", { minLevel: "debug", sinks: [(entry) => logs.push(entry)] });
});

afterEach(() => {
  browser.uninstall();
});

function asPort(port: FakePort): chrome.runtime.Port {
  return port as unknown as chrome.runtime.Port;
}

/** Engine accepts "engine" ports and hands each wrapped port to `onPort`. */
function listen(onPort: (port: EngineSide) => void): void {
  engine.onConnect.addListener((raw) => {
    onPort(wrapPort<CsToEngineMap, EngineToCsMap>(asPort(raw), { ctx: "engine", log }));
  });
}

function connectFromContent(): CsSide {
  const tab = browser.openTab("https://reader.example/1");
  const cs = browser.injectContent(tab.id);
  return cs.run(() =>
    wrapPort<EngineToCsMap, CsToEngineMap>(chrome.runtime.connect({ name: "engine" }), { ctx: "cs", log }),
  );
}

function hello(): CsToEngineMap["cs:hello"] {
  return {
    v: 1,
    build: "test",
    probe: makeProbe(),
    mode: "auto",
    page: { title: "t", layout: "webtoon", visible: true, dpr: 1 },
  };
}

test("messages flow both ways; posts made before the connection is up are delivered in order", async () => {
  const received: string[] = [];
  let probeKept = false;
  listen((port) => {
    port.on("cs:hello", (message) => {
      probeKept = isProbe(message.probe);
      received.push(message.type);
    });
    port.on("cs:heartbeat", () => received.push("cs:heartbeat"));
  });
  const cs = connectFromContent();
  assert.equal(cs.post({ type: "cs:hello", ...hello() }), true);
  assert.equal(cs.post({ type: "cs:heartbeat" }), true);
  await browser.settle();
  assert.deepEqual(received, ["cs:hello", "cs:heartbeat"]);
  assert.equal(probeKept, true);
});

test("request() resolves with the reply carrying its reqId and ignores other replies", async () => {
  // The engine answers cap:ready with a stray cap:done first, then the one for the same reqId.
  engine.onConnect.addListener((raw) => {
    raw.onMessage.addListener((message) => {
      const m = message as { type: string; reqId?: string };
      if (m.type === "cap:ready") {
        raw.postMessage({ type: "cap:done", reqId: "someone-else" });
        raw.postMessage({ type: "cap:done", reqId: m.reqId });
      }
    });
  });
  const cs = connectFromContent();
  const reply = await cs.request(
    "cap:ready",
    { rect: { left: 0, top: 0, width: 10, height: 10 }, viewport: { w: 800, h: 600 }, dpr: 1 },
    ["cap:done"],
    1000,
  );
  assert.equal(reply.type, "cap:done");
  assert.match(reply.reqId, /^cs-[0-9a-z]+-/);
});

test("request() times out as engine.protocol and fails fast as engine.closing when the port closes", async () => {
  const engineSides: EngineSide[] = [];
  listen((port) => engineSides.push(port));
  const cs = connectFromContent();
  const rect = { left: 0, top: 0, width: 1, height: 1 };
  await assert.rejects(
    cs.request("cap:ready", { rect, viewport: { w: 1, h: 1 }, dpr: 1 }, ["cap:done"], 20),
    (error: unknown) => error instanceof CtvError && error.code === "engine.protocol",
  );
  const pending = cs.request("cap:ready", { rect, viewport: { w: 1, h: 1 }, dpr: 1 }, ["cap:done"], 5000);
  await browser.settle();
  engineSides[0]?.close();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CtvError && error.code === "engine.closing",
  );
});

test("onClose fires once with lastError when nobody listens; post() then returns false without throwing", async () => {
  engine.destroy();
  const cs = connectFromContent();
  const closes: Array<string | null> = [];
  cs.onClose((lastError) => closes.push(lastError));
  await browser.settle();
  assert.deepEqual(closes, [CHROME_ERRORS.noReceiver]);
  assert.equal(cs.closed, true);
  assert.equal(cs.post({ type: "cs:heartbeat" }), false);
  const late: Array<string | null> = [];
  cs.onClose((lastError) => late.push(lastError));
  assert.deepEqual(late, [null], "a handler added after close runs immediately");
});

test("the remote side closing fires onClose without lastError; close() is idempotent", async () => {
  const engineSides: EngineSide[] = [];
  listen((port) => engineSides.push(port));
  const cs = connectFromContent();
  const closes: Array<string | null> = [];
  cs.onClose((lastError) => closes.push(lastError));
  await browser.settle();
  engine.destroy();
  await browser.settle();
  assert.deepEqual(closes, [null]);
  cs.close();
  cs.close();
  assert.equal(closes.length, 1);
});

test("R7: a message over the codec's hard limit is dropped with a warning; soft limit only warns", () => {
  listen(() => undefined);
  const cs = connectFromContent();
  cs.codec = "b64";
  // 7 MiB of bytes is ~9.3 MiB as base64: over the 8 MiB b64 hard limit.
  const big = new ArrayBuffer(7 * 1024 * 1024);
  assert.equal(cs.post({ type: "cs:log", entries: [], pad: big } as never), false);
  assert.ok(logs.some((entry) => entry.msg === "message over the hard limit dropped"));
  cs.codec = "sc";
  const nine = new ArrayBuffer(9 * 1024 * 1024);
  assert.equal(cs.post({ type: "cs:log", entries: [], pad: nine } as never), true);
  assert.ok(logs.some((entry) => entry.msg === "message over the soft limit"));
});

test("a throwing handler is logged and does not stop the other handlers", async () => {
  const hits: string[] = [];
  listen((port) => {
    port.on("cs:heartbeat", () => {
      throw new Error("bad handler");
    });
    port.on("cs:heartbeat", () => hits.push("second"));
  });
  const cs = connectFromContent();
  cs.post({ type: "cs:heartbeat" });
  await browser.settle();
  assert.deepEqual(hits, ["second"]);
  assert.ok(logs.some((entry) => entry.msg === "port handler threw"));
});

test("unsubscribe stops delivery; malformed messages are ignored", async () => {
  const hits: number[] = [];
  let off: (() => void) | undefined;
  engine.onConnect.addListener((raw) => {
    const port = wrapPort<CsToEngineMap, EngineToCsMap>(asPort(raw), { ctx: "engine", log });
    off = port.on("cs:heartbeat", () => hits.push(1));
  });
  const tab = browser.openTab("https://reader.example/2");
  const cs = browser.injectContent(tab.id);
  const raw = cs.run(() => chrome.runtime.connect({ name: "engine" }));
  raw.postMessage({ type: "cs:heartbeat" });
  raw.postMessage({ notype: true });
  raw.postMessage("text");
  await browser.settle();
  off?.();
  raw.postMessage({ type: "cs:heartbeat" });
  await browser.settle();
  assert.deepEqual(hits, [1]);
});

test("post() never throws, even when the raw port does", () => {
  const raw = {
    name: "engine",
    postMessage: () => {
      throw new Error(CHROME_ERRORS.disconnectedPort);
    },
    disconnect: () => undefined,
    onMessage: { addListener: () => undefined },
    onDisconnect: { addListener: () => undefined },
  } as unknown as chrome.runtime.Port;
  const port = wrapPort<EngineToCsMap, CsToEngineMap>(raw, { ctx: "cs", log });
  const closes: Array<string | null> = [];
  port.onClose((lastError) => closes.push(lastError));
  assert.equal(port.post({ type: "cs:heartbeat" }), false);
  assert.equal(port.closed, true);
  assert.deepEqual(closes, [CHROME_ERRORS.disconnectedPort]);
});
