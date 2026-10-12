// The chrome fake must behave like Chrome where our code depends on it; these tests pin that behaviour.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CHROME_ERRORS, FakeBrowser, re2Supported, type FakeContext } from "../../support/chrome-fake.ts";

let browser: FakeBrowser;
let sw: FakeContext;

beforeEach(async () => {
  browser = new FakeBrowser();
  browser.install();
  sw = await browser.startServiceWorker();
});

afterEach(() => {
  browser.uninstall();
});

test("globalThis.chrome follows the current context across awaits and timers", async () => {
  const popup = browser.openExtensionPage("popup", "popup.html");
  const tab = browser.openTab("https://a.example/");
  const cs = browser.injectContent(tab.id);
  const seen: string[] = [];
  await popup.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    seen.push(typeof chrome.tabs);
  });
  await cs.run(async () => {
    await Promise.resolve();
    seen.push(typeof (chrome as { tabs?: unknown }).tabs);
  });
  assert.deepEqual(seen, ["object", "undefined"], "content scripts have no chrome.tabs");
  assert.throws(() => chrome.runtime.id, /no current context/);
});

test("runtime.sendMessage never reaches content scripts nor the sender itself", async () => {
  const tab = browser.openTab("https://a.example/");
  const cs = browser.injectContent(tab.id);
  const hits: string[] = [];
  cs.onMessage.addListener(() => hits.push("cs"));
  sw.onMessage.addListener(() => hits.push("sw"));
  await assert.rejects(
    sw.run(() => chrome.runtime.sendMessage({ x: 1 })),
    new RegExp(CHROME_ERRORS.noReceiver.replace(/\./g, "\\.")),
  );
  await assert.rejects(
    cs.run(() => chrome.runtime.sendMessage({ x: 1 })),
    /message port closed/,
    "listener exists but does not answer",
  );
  assert.deepEqual(hits, ["sw"]);
});

test("only one offscreen document; concurrent createDocument calls reject; getContexts sees it", async () => {
  const create = (): Promise<void> =>
    sw.run(() =>
      sw.ext.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "x" }),
    );
  const results = await Promise.allSettled([create(), create(), create()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const contexts = await sw.run(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }));
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.documentUrl, browser.url("offscreen.html"));
  await sw.run(() => chrome.offscreen.closeDocument());
  await assert.rejects(
    sw.run(() => chrome.offscreen.closeDocument()),
    /No current offscreen document/,
  );
});

test("storage is shared, JSON-serialized and fires onChanged in every allowed context", async () => {
  const tab = browser.openTab("https://a.example/");
  const cs = browser.injectContent(tab.id);
  const changes: string[] = [];
  sw.storageOnChanged.addListener((_changes, area) => changes.push(`sw:${area}`));
  cs.storageOnChanged.addListener((_changes, area) => changes.push(`cs:${area}`));
  await sw.run(() => chrome.storage.local.set({ a: { n: 1, buf: new ArrayBuffer(2) } }));
  await sw.run(() => chrome.storage.session.set({ s: 1 }));
  await browser.settle();
  assert.deepEqual(changes.sort(), ["cs:local", "sw:local", "sw:session"]);
  assert.deepEqual(await cs.run(() => chrome.storage.local.get("a")), { a: { n: 1, buf: {} } });
  await assert.rejects(
    cs.run(() => chrome.storage.session.get("s")),
    /Access to storage is not allowed/,
  );
  assert.deepEqual(await sw.run(() => chrome.storage.local.get({ missing: 5 })), { missing: 5 });
});

test("DNR session rules: atomic updates, unique ids, RE2 regex check", async () => {
  const rule = (id: number, regexFilter: string): chrome.declarativeNetRequest.Rule => ({
    id,
    priority: 1,
    action: { type: "block" },
    condition: { regexFilter },
  });
  await sw.run(() =>
    chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule(1, "^https?://10\\.")] }),
  );
  await assert.rejects(
    sw.run(() =>
      chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule(2, "^a"), rule(1, "^b")] }),
    ),
    /unique ID/,
  );
  assert.equal(browser.sessionRules.length, 1, "a failed update changes nothing");
  assert.equal(re2Supported("^(?!x)y"), false);
  assert.equal(re2Supported("(a)\\1"), false);
  assert.equal(re2Supported("^https?://(127\\.|10\\.)"), true);
});

test("sidePanel.open needs the user gesture of the command listener (synchronous call only)", async () => {
  const outcomes: string[] = [];
  sw.commandsOnCommand.addListener((command) => {
    chrome.sidePanel.open({ windowId: 1 }).then(
      () => outcomes.push(`${command}:sync-ok`),
      () => outcomes.push(`${command}:sync-fail`),
    );
    void Promise.resolve().then(() =>
      chrome.sidePanel.open({ windowId: 1 }).then(
        () => outcomes.push(`${command}:late-ok`),
        () => outcomes.push(`${command}:late-fail`),
      ),
    );
  });
  browser.fireCommand("open-side-panel");
  await browser.settle();
  assert.deepEqual(outcomes.sort(), ["open-side-panel:late-fail", "open-side-panel:sync-ok"]);
});

test("captureVisibleTab enforces 2 calls per second", async () => {
  let now = 1000;
  browser.uninstall();
  browser = new FakeBrowser({ now: () => now });
  browser.install();
  sw = await browser.startServiceWorker();
  await sw.run(() => chrome.tabs.captureVisibleTab());
  await sw.run(() => chrome.tabs.captureVisibleTab());
  await assert.rejects(
    sw.run(() => chrome.tabs.captureVisibleTab()),
    /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/,
  );
  now += 1000;
  await sw.run(() => chrome.tabs.captureVisibleTab());
});

test("windows.get / getLastFocused: the last focused window is focused, states default to normal", async () => {
  const tab = browser.openTab("https://reader.example/");
  browser.openTab("https://other.example/", { windowId: 2 });
  const own = await sw.run(() => chrome.windows.get(tab.windowId));
  assert.deepEqual([own.id, own.focused, own.state], [1, true, "normal"]);
  browser.lastFocusedWindow = 2;
  browser.windowStates.set(1, "minimized");
  assert.equal((await sw.run(() => chrome.windows.getLastFocused())).id, 2);
  const after = await sw.run(() => chrome.windows.get(1));
  assert.deepEqual([after.focused, after.state], [false, "minimized"]);
  await assert.rejects(
    sw.run(() => chrome.windows.get(42)),
    /No window with id: 42/,
  );
});

test("failNext injects one failure into a named API", async () => {
  browser.failNext("storage.local.set", "QUOTA_BYTES quota exceeded");
  await assert.rejects(
    sw.run(() => chrome.storage.local.set({ a: 1 })),
    /QUOTA_BYTES/,
  );
  await sw.run(() => chrome.storage.local.set({ a: 1 }));
  assert.equal(browser.storageGet("local", "a"), 1);
});

test("registered content scripts: duplicate and nonexistent ids are errors", async () => {
  const script: chrome.scripting.RegisteredContentScript = {
    id: "ctv-main",
    js: ["content.js"],
    matches: ["https://a.example/*"],
    allFrames: true,
  };
  await sw.run(() => chrome.scripting.registerContentScripts([script]));
  await assert.rejects(
    sw.run(() => chrome.scripting.registerContentScripts([script])),
    /Duplicate script ID/,
  );
  await assert.rejects(
    sw.run(() => chrome.scripting.unregisterContentScripts({ ids: ["nope"] })),
    /Nonexistent script ID/,
  );
  await sw.run(() => chrome.scripting.unregisterContentScripts({ ids: ["ctv-main"] }));
  assert.equal(browser.registeredScripts.size, 0);
});
