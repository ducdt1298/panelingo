// cs:* command routing (messages.ts) through the chrome fake: SW → tabs.sendMessage → content handlers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { listenForCommands, type CommandTarget, type TeardownReason } from "../../../src/content/messages.ts";
import { sendToTab } from "../../../src/platform/messaging.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import { makeEnvelope, type Reply } from "../../../src/shared/protocol.ts";
import { FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";

let browser: FakeBrowser;
let sw: FakeContext;
let cs: FakeContext;
let tabId: number;

beforeEach(async () => {
  browser = new FakeBrowser();
  browser.install();
  sw = await browser.startServiceWorker();
  const tab = browser.openTab("https://reader.example/ch-2");
  tabId = tab.id;
  cs = browser.injectContent(tab.id);
});

afterEach(() => {
  browser.uninstall();
});

class RecordingTarget implements CommandTarget {
  visible = true;
  readonly calls: string[] = [];
  readonly teardowns: TeardownReason[] = [];
  found = true;

  toggleOverlay(): boolean {
    this.calls.push("toggle");
    this.visible = !this.visible;
    return this.visible;
  }

  translateVisible(): Promise<number> {
    this.calls.push("visible");
    return Promise.resolve(3);
  }

  translateImage(srcUrl: string, force: boolean): boolean {
    this.calls.push(`image ${srcUrl} ${String(force)}`);
    return this.found;
  }

  teardown(reason: TeardownReason): void {
    this.teardowns.push(reason);
  }
}

test("every cs command reaches the target and answers with its CsApi reply", async () => {
  const target = new RecordingTarget();
  cs.run(() => listenForCommands(target));
  await sw.run(async () => {
    assert.deepEqual(await sendToTab(tabId, "cs:toggle-overlay", {}), { visible: false });
    assert.deepEqual(await sendToTab(tabId, "cs:toggle-overlay", {}), { visible: true });
    assert.deepEqual(await sendToTab(tabId, "cs:translate-visible", {}), { submitted: 3 });
    const srcUrl = "https://cdn.example/p1.jpg";
    assert.deepEqual(await sendToTab(tabId, "cs:translate-image", { srcUrl, force: true }), { found: true });
    target.found = false;
    assert.deepEqual(await sendToTab(tabId, "cs:translate-image", { srcUrl, force: false }), {
      found: false,
    });
    assert.deepEqual(await sendToTab(tabId, "cs:teardown", { reason: "site-disabled" }), {});
  });
  assert.deepEqual(target.calls, [
    "toggle",
    "toggle",
    "visible",
    "image https://cdn.example/p1.jpg true",
    "image https://cdn.example/p1.jpg false",
  ]);
  assert.deepEqual(target.teardowns, ["site-disabled"]);
});

test("a throwing target answers {ok:false}: the SW sees a CtvError, the listener never throws", async () => {
  const target = new RecordingTarget();
  target.translateImage = () => {
    throw new CtvError("image.decode", "cannot read");
  };
  cs.run(() => listenForCommands(target));
  await sw.run(async () => {
    await assert.rejects(
      sendToTab(tabId, "cs:translate-image", { srcUrl: "x", force: false }),
      (error: unknown) => error instanceof CtvError && error.code === "image.decode",
    );
  });
  assert.deepEqual(browser.listenerErrors, []);
});

test("R1: other targets, unknown types and foreign senders get undefined", () => {
  cs.run(() => listenForCommands(new RecordingTarget()));
  const replies: unknown[] = [];
  const respond = (reply?: unknown): void => {
    replies.push(reply);
  };
  const own = browser.senderOf(sw);
  const dispatch = (message: unknown, sender: chrome.runtime.MessageSender): unknown[] =>
    cs.run(() => cs.onMessage.dispatch(message, sender, respond));
  assert.deepEqual(dispatch(makeEnvelope("engine", "en:status", {}), own), [undefined]);
  assert.deepEqual(dispatch({ target: "cs", type: "cs:unknown", v: 1, payload: {} }, own), [undefined]);
  assert.deepEqual(dispatch("hello", own), [undefined]);
  assert.deepEqual(
    dispatch(makeEnvelope("cs", "cs:toggle-overlay", {}), { ...own, id: "another-extension" }),
    [undefined],
  );
  assert.deepEqual(dispatch(makeEnvelope("cs", "cs:toggle-overlay", {}), own), [true]);
});

test("the returned function removes the handlers", async () => {
  const off = cs.run(() => listenForCommands(new RecordingTarget()));
  off();
  await sw.run(async () => {
    await assert.rejects(
      sendToTab(tabId, "cs:toggle-overlay", {}),
      (error: unknown) => error instanceof CtvError && error.code === "engine.unavailable",
    );
  });
});

test("an orphaned content script ignores commands instead of throwing", () => {
  const target = new RecordingTarget();
  cs.run(() => listenForCommands(target));
  browser.invalidateExtension();
  const replies: Array<Reply<unknown> | undefined> = [];
  const result = cs.run(() =>
    cs.onMessage.dispatch(makeEnvelope("cs", "cs:toggle-overlay", {}), { id: browser.extensionId }, (reply) =>
      replies.push(reply as Reply<unknown> | undefined),
    ),
  );
  assert.deepEqual(result, [undefined], "chrome.runtime.id is gone: the sender cannot be ours");
  assert.deepEqual(target.calls, []);
});
