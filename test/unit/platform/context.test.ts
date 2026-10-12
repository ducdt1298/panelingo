import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { contextTag, contextTagFor, extensionOrigin, isContextValid } from "../../../src/platform/context.ts";
import { FAKE_EXTENSION_ID, FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";

const ORIGIN = `chrome-extension://${FAKE_EXTENSION_ID}`;

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

test("isContextValid: true while attached, false for orphans and without any chrome context", () => {
  const tab = browser.openTab("https://reader.example/1");
  const cs = browser.injectContent(tab.id);
  assert.equal(cs.run(isContextValid), true);
  assert.equal(sw.run(isContextValid), true);
  browser.invalidateExtension();
  assert.equal(cs.run(isContextValid), false, "orphaned content script after a reload");
  assert.equal(isContextValid(), false, "no current context: chrome access throws");
});

test("extensionOrigin has no trailing slash and is empty once invalidated", () => {
  const tab = browser.openTab("https://reader.example/1");
  const cs = browser.injectContent(tab.id);
  assert.equal(sw.run(extensionOrigin), ORIGIN);
  assert.equal(cs.run(extensionOrigin), ORIGIN);
  browser.invalidateExtension();
  assert.equal(cs.run(extensionOrigin), "");
});

test("contextTagFor maps extension documents by path and everything else to cs", () => {
  assert.equal(contextTagFor(`${ORIGIN}/sw.js`, ORIGIN), "sw");
  assert.equal(contextTagFor(`${ORIGIN}/engine/offscreen.html`, ORIGIN), "engine");
  assert.equal(contextTagFor(`${ORIGIN}/ui/popup.html`, ORIGIN), "popup");
  assert.equal(contextTagFor(`${ORIGIN}/ui/options.html#privacy`, ORIGIN), "options");
  assert.equal(contextTagFor(`${ORIGIN}/ui/sidepanel.html?tab=3`, ORIGIN), "sidepanel");
  assert.equal(contextTagFor(`${ORIGIN}/ui/debug.html`, ORIGIN), "debug");
  assert.equal(contextTagFor(`${ORIGIN}/somewhere/else.html`, ORIGIN), "debug");
  assert.equal(contextTagFor("https://reader.example/ui/popup.html", ORIGIN), "cs");
  assert.equal(contextTagFor(`${ORIGIN}/ui/popup.html`, ""), "cs", "invalidated context");
  assert.equal(contextTagFor("about:blank", ORIGIN), "cs");
});

test("contextTag reads the current location (Node has none: content-script default)", () => {
  assert.equal(sw.run(contextTag), "cs");
});
