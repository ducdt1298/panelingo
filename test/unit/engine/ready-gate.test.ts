// ReadyGate (A.5 L1): hello/ping/prepare-close while booting, ordered buffering, overflow, drain, fail, R3/R5.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  placeholderStatus,
  type GateDispatch,
  type PortEntry,
  type ReadyGate,
} from "../../../src/engine/ready-gate.ts";
import { callEngine } from "../../../src/platform/messaging.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import { isProbe, makeProbe } from "../../../src/shared/wire.ts";
import type { FakeBrowser, FakeBrowserOptions, FakeContext } from "../../support/chrome-fake.ts";
import {
  captureLogger,
  connectContent,
  connectUi,
  createOffscreen,
  csHello,
  imageSubmit,
  installGate,
  startBrowser,
} from "./store/engine-fakes.ts";

let current: FakeBrowser | null = null;

afterEach(() => {
  current?.uninstall();
  current = null;
});

interface Setup {
  browser: FakeBrowser;
  sw: FakeContext;
  engine: FakeContext;
  gate: ReadyGate;
}

async function setup(
  options: FakeBrowserOptions = {},
  limits = { msgs: 500, bytes: 64 << 20 },
): Promise<Setup> {
  const { browser, sw } = await startBrowser(options);
  current = browser;
  await createOffscreen(sw);
  const engine = browser.offscreen;
  assert.ok(engine !== null);
  const gate = installGate(engine, captureLogger().log, limits);
  return { browser, sw, engine, gate };
}

function label(entry: PortEntry): string {
  return entry.kind === "engine" ? `tab${entry.tabId}` : "ui";
}

/** A runtime stand-in that records every dispatched event in one ordered list. */
function recorder(): GateDispatch & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    portOpened: (entry) => events.push(`open:${label(entry)}`),
    portClosed: (entry) => events.push(`close:${label(entry)}`),
    engineMessage: (entry, message) =>
      events.push(
        `${label(entry)}:${message.type}${message.type === "img:submit" ? `:${message.imageKey}` : ""}`,
      ),
    uiMessage: (_entry, message) => events.push(`ui:${message.type}`),
    handlers: {
      "en:status": () => {
        events.push("call:en:status");
        return placeholderStatus("ready");
      },
      "en:retranslate": (payload) => {
        events.push(`call:en:retranslate:${payload.tabId}`);
        return { queued: 1 };
      },
      "en:ping": (payload) => ({ probe: payload.probe, phase: "ready" }),
    },
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<CtvError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CtvError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  return assert.fail(`expected ${code}`);
}

test("booting: hello is answered at once, everything else is buffered and replayed in arrival order", async () => {
  const { browser, engine, gate } = await setup();
  const a = connectContent(browser, "https://reader.example/a");
  const b = connectContent(browser, "https://reader.example/b");
  a.post(csHello());
  a.post(imageSubmit(1));
  b.post(csHello());
  b.post(imageSubmit(2));
  a.post(imageSubmit(3));
  await browser.settle();

  const hello = a.of("en:hello")[0];
  assert.ok(hello !== undefined);
  assert.equal(hello.v, PROTOCOL_VERSION);
  assert.equal(hello.codec, "sc");
  assert.equal(hello.frameKey, `${a.tabId}:0:${a.ctx.documentId}`);
  assert.equal(isProbe(hello.probe), true);
  assert.equal((hello.status as { phase: string }).phase, "booting");
  assert.equal(b.of("en:hello").length, 1);

  const popup = browser.openExtensionPage("popup", "ui/popup.html");
  const call = popup.run(() => callEngine("en:retranslate", { tabId: 7 }));
  await browser.settle();
  assert.equal(gate.mode(), "booting");
  assert.deepEqual(gate.stats(), { mode: "booting", buffered: 6, overflowed: 0, ports: 2 });

  const dispatch = recorder();
  engine.run(() => gate.drain(dispatch));
  assert.deepEqual(await call, { queued: 1 });
  assert.deepEqual(dispatch.events, [
    `open:tab${a.tabId}`,
    `open:tab${b.tabId}`,
    `tab${a.tabId}:img:submit:1.0`,
    `tab${a.tabId}:img:submit:3.0`,
    `tab${b.tabId}:img:submit:2.0`,
    "call:en:retranslate:7",
  ]);

  // Ready: direct dispatch, including a new hello (the runtime answers it from now on).
  a.post(imageSubmit(4));
  a.post(csHello());
  await browser.settle();
  assert.deepEqual(dispatch.events.slice(-2), [`tab${a.tabId}:img:submit:4.0`, `tab${a.tabId}:cs:hello`]);
  assert.equal(a.of("en:hello").length, 1, "the gate no longer answers hello itself");
  assert.equal(gate.mode(), "ready");
  assert.equal(gate.stats().buffered, 0);
});

test("en:ping and en:prepare-close are answered while booting; the SW channel keeps ArrayBuffers", async () => {
  const { browser, sw } = await setup();
  const ping = await sw.run(() => callEngine("en:ping", { probe: makeProbe() }));
  assert.equal(ping.phase, "booting");
  assert.equal(isProbe(ping.probe), true);
  assert.deepEqual(await sw.run(() => callEngine("en:prepare-close", {})), { ok: false });
  await browser.settle();
});

test("R5 allow-list: settings and close only from the SW, UI operations only from /ui/ pages, ping from anyone", async () => {
  const { browser, sw, engine, gate } = await setup();
  const popup = browser.openExtensionPage("popup", "ui/popup.html");
  const other = browser.openExtensionPage("options", "elsewhere/page.html");
  const tab = browser.openTab("https://reader.example/1");
  const cs = browser.injectContent(tab.id);
  const allow = (type: string, ctx: FakeContext): boolean =>
    engine.run(() => gate.allow(type, browser.senderOf(ctx)));

  assert.equal(allow("en:settings", sw), true);
  assert.equal(allow("en:prepare-close", sw), true);
  assert.equal(allow("en:settings", popup), false);
  assert.equal(allow("en:prepare-close", cs), false);
  assert.equal(allow("en:status", popup), true);
  assert.equal(allow("en:cache-clear", popup), true);
  assert.equal(allow("en:status", sw), false);
  assert.equal(allow("en:status", other), false);
  assert.equal(allow("en:status", cs), false);
  assert.equal(allow("en:ping", cs), true);
  assert.equal(allow("en:ping", sw), true);
  const foreign = { ...browser.senderOf(sw), id: "someotherextensionidxxxxxxxxxxxx" };
  assert.equal(
    engine.run(() => gate.allow("en:ping", foreign)),
    false,
  );

  // A refused message is never answered: the caller sees engine.unavailable.
  await rejectsWith(
    popup.run(() => callEngine("en:settings", { settings: DEFAULT_SETTINGS, sites: {} }, { timeoutMs: 200 })),
    "engine.unavailable",
  );
});

test("a full port buffer answers submits with engine.overloaded and drops other messages", async () => {
  const { browser, engine, gate } = await setup({}, { msgs: 3, bytes: 64 << 20 });
  const a = connectContent(browser, "https://reader.example/a");
  a.post(csHello());
  for (let i = 1; i <= 5; i += 1) a.post(imageSubmit(i));
  a.post({ type: "cs:heartbeat" });
  await browser.settle();
  const states = a.of("img:state");
  assert.deepEqual(
    states.map((message) => [message.imageKey, message.state, (message.error as { code: string }).code]),
    [
      ["4.0", "error", "engine.overloaded"],
      ["5.0", "error", "engine.overloaded"],
    ],
  );
  assert.equal((states[0]?.error as { retryable: boolean }).retryable, true);
  assert.equal(gate.stats().overflowed, 3);
  const dispatch = recorder();
  engine.run(() => gate.drain(dispatch));
  assert.deepEqual(
    dispatch.events.slice(1),
    [1, 2, 3].map((i) => `tab${a.tabId}:img:submit:${i}.0`),
  );
});

test("the byte cap counts payloads: a large bytes submit overflows", async () => {
  const { browser, gate } = await setup({}, { msgs: 500, bytes: 4_000 });
  const a = connectContent(browser, "https://reader.example/a");
  a.post(imageSubmit(1));
  a.post(imageSubmit(2, { acquire: "bytes", bytes: new ArrayBuffer(8_000), mime: "image/png" }));
  await browser.settle();
  assert.deepEqual(
    a.of("img:state").map((message) => message.imageKey),
    ["2.0"],
  );
  assert.equal(gate.stats().buffered, 2, "open + the small submit");
});

test("fail(): pending and later requests get engine.internal, hello and ping report phase failed", async () => {
  const { browser, sw, engine, gate } = await setup();
  const a = connectContent(browser, "https://reader.example/a");
  a.post(csHello());
  a.post(imageSubmit(1));
  const popup = browser.openExtensionPage("popup", "ui/popup.html");
  const pending = popup.run(() => callEngine("en:status", {}));
  await browser.settle();

  engine.run(() => gate.fail(new Error("database is broken")));
  const error = await rejectsWith(pending, "engine.internal");
  assert.match(error.message, /database is broken/);
  await browser.settle();
  const failedState = a.of("img:state")[0];
  assert.equal((failedState?.error as { code: string }).code, "engine.internal");
  assert.equal((a.of("en:status")[0]?.status as { phase: string }).phase, "failed");

  const late = connectContent(browser, "https://reader.example/b");
  late.post(csHello());
  late.post(imageSubmit(9));
  await browser.settle();
  assert.equal((late.of("en:hello")[0]?.status as { phase: string }).phase, "failed");
  assert.equal(late.of("img:state")[0]?.imageKey, "9.0");
  assert.equal((await sw.run(() => callEngine("en:ping", { probe: makeProbe() }))).phase, "failed");
  assert.deepEqual(await sw.run(() => callEngine("en:prepare-close", {})), { ok: true });
  await rejectsWith(
    popup.run(() => callEngine("en:status", {})),
    "engine.internal",
  );
  assert.equal(gate.mode(), "failed");
});

test("R3: ports with other names, tab-less engine ports and foreign ui ports are ignored, never disconnected", async () => {
  const { browser, gate } = await setup();
  const stranger = connectContent(browser, "https://reader.example/a", "devtools-bridge");
  const page = browser.openExtensionPage("options", "ui/options.html");
  const tabless = page.run(() => chrome.runtime.connect({ name: "engine" }));
  const fakeUi = connectContent(browser, "https://reader.example/b", "ui");
  stranger.post({ type: "cs:hello" });
  fakeUi.post({ type: "ui:hello", v: 1, probe: makeProbe(), view: "popup" });
  await browser.settle();
  assert.equal(gate.stats().ports, 0);
  assert.equal(stranger.port.connected, true);
  assert.deepEqual(stranger.disconnects, []);
  assert.equal(fakeUi.port.connected, true);
  assert.equal(fakeUi.received.length, 0);
  assert.equal((tabless as unknown as { connected: boolean }).connected, true);
});

test("a port that closes while booting is replayed as open, messages, close", async () => {
  const { browser, engine, gate } = await setup();
  const a = connectContent(browser, "https://reader.example/a");
  a.post(csHello());
  a.post(imageSubmit(1));
  await browser.settle();
  a.ctx.run(() => a.port.disconnect());
  await browser.settle();
  const dispatch = recorder();
  engine.run(() => gate.drain(dispatch));
  assert.deepEqual(dispatch.events, [
    `open:tab${a.tabId}`,
    `tab${a.tabId}:img:submit:1.0`,
    `close:tab${a.tabId}`,
  ]);
  assert.equal(gate.stats().ports, 0);
});

test("JSON-only channels negotiate base64; ui:hello is answered while booting and ui:watch waits", async () => {
  const { browser, engine, gate } = await setup({ serialization: "json" });
  const a = connectContent(browser, "https://reader.example/a");
  a.post(csHello());
  const ui = connectUi(browser);
  ui.post({ type: "ui:hello", v: PROTOCOL_VERSION, probe: makeProbe(), view: "popup" });
  ui.post({ type: "ui:watch", tabId: null });
  await browser.settle();
  assert.equal(a.of("en:hello")[0]?.codec, "b64");
  assert.equal(ui.of("en:hello")[0]?.codec, "b64");
  const dispatch = recorder();
  engine.run(() => gate.drain(dispatch));
  assert.deepEqual(dispatch.events, [`open:tab${a.tabId}`, "open:ui", "ui:ui:watch"]);
  engine.run(() => gate.drain(recorder()));
  assert.equal(gate.mode(), "ready", "a second drain is ignored");
});
