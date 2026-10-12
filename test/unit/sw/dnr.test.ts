import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  ALLOW_LAST_ID,
  GUARD_REGEXES,
  REFERER_FIRST_ID,
  REFERER_MAX_RULES,
  buildRefererRule,
} from "../../../src/shared/dnr-rules.ts";
import { clearRefererRules, ensureRefererRule, installGuardRules } from "../../../src/sw/dnr.ts";
import { FAKE_EXTENSION_ID, FakeBrowser, type FakeContext } from "../../support/chrome-fake.ts";

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

/** A local OpenAI-compatible server (e.g. Ollama) the guard must let through. */
const API_ORIGIN = "http://127.0.0.1:11434";

test("guard + allow rules are installed with ids <= 99 and replaced, not duplicated, on reinstall", async () => {
  const first = await sw.run(() => installGuardRules([API_ORIGIN]));
  assert.equal(first.installed, GUARD_REGEXES.length + 1);
  assert.deepEqual(first.unsupported, []);
  await sw.run(() => installGuardRules([API_ORIGIN, "http://127.0.0.1:8080"]));
  const ids = browser.sessionRules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id <= ALLOW_LAST_ID));
  assert.equal(browser.sessionRules.length, GUARD_REGEXES.length + 2);
  assert.deepEqual(
    browser.sessionRules
      .filter((rule) => rule.action.type === "allow")
      .map((rule) => rule.condition.urlFilter),
    ["|http://127.0.0.1:11434/", "|http://127.0.0.1:8080/"],
  );
});

test("regexes Chrome rejects are skipped and reported", async () => {
  const dnr = sw.ext.declarativeNetRequest;
  const original = dnr.isRegexSupported.bind(dnr);
  dnr.isRegexSupported = (options) =>
    options.regex === GUARD_REGEXES[0]
      ? Promise.resolve({ isSupported: false, reason: "memoryLimitExceeded" })
      : original(options);
  const result = await sw.run(() => installGuardRules([]));
  assert.deepEqual(result.unsupported, [GUARD_REGEXES[0]]);
  assert.equal(result.installed, GUARD_REGEXES.length - 1);
});

test("ensureRefererRule is idempotent per host and updates the header in place", async () => {
  await sw.run(() => installGuardRules([API_ORIGIN]));
  const id = await sw.run(() => ensureRefererRule("cdn.example", "https://reader.example/", false));
  assert.ok(id >= REFERER_FIRST_ID);
  assert.equal(await sw.run(() => ensureRefererRule("cdn.example", "https://reader.example/", false)), id);
  const updated = await sw.run(() => ensureRefererRule("cdn.example", "https://reader.example/ch/1", true));
  assert.equal(updated, id, "same host keeps its id");
  const rules = browser.sessionRules.filter((rule) => rule.id >= REFERER_FIRST_ID);
  assert.equal(rules.length, 1);
  assert.deepEqual(
    rules[0],
    buildRefererRule(id, FAKE_EXTENSION_ID, "cdn.example", "https://reader.example/ch/1", true),
  );
  const other = await sw.run(() => ensureRefererRule("img.other.example", null, false));
  assert.notEqual(other, id);
});

test("concurrent calls are serialized: unique ids, no 'unique ID' failures", async () => {
  const hosts = Array.from({ length: 12 }, (_, i) => `cdn${i}.example`);
  const ids = await sw.run(() =>
    Promise.all([...hosts, ...hosts].map((host) => ensureRefererRule(host, `https://${host}/`, false))),
  );
  assert.equal(new Set(ids).size, hosts.length);
  assert.equal(browser.sessionRules.length, hosts.length);
});

test("rule ids come from Chrome after a service-worker restart", async () => {
  const id = await sw.run(() => ensureRefererRule("cdn.example", "https://reader.example/", false));
  const restarted = await browser.restartServiceWorker();
  assert.equal(
    await restarted.run(() => ensureRefererRule("cdn.example", "https://reader.example/", false)),
    id,
  );
  const next = await restarted.run(() => ensureRefererRule("cdn2.example", "https://reader.example/", false));
  assert.equal(next, id + 1);
});

test("over REFERER_MAX_RULES the least recently used host is evicted", async () => {
  // Seed Chrome with a full table directly (thousands of awaited calls would be slow) plus LRU stamps.
  const lru: Record<string, number> = {};
  for (let i = 0; i < REFERER_MAX_RULES; i += 1) {
    const host = `h${i}.example`;
    browser.sessionRules.push(
      buildRefererRule(REFERER_FIRST_ID + i, FAKE_EXTENSION_ID, host, "https://r.example/", false),
    );
    lru[host] = 1000 + i;
  }
  lru["h0.example"] = 5_000_000; // recently used: must survive
  browser.storageSet("session", { "dnr:lru": lru });
  await sw.run(() => ensureRefererRule("new.example", "https://r.example/", false));
  const hosts = new Set(browser.sessionRules.map((rule) => rule.condition.requestDomains?.[0]));
  assert.equal(browser.sessionRules.length, REFERER_MAX_RULES);
  assert.ok(hosts.has("new.example"));
  assert.ok(hosts.has("h0.example"));
  assert.ok(!hosts.has("h1.example"), "oldest stamp evicted");
  const stored = browser.storageGet("session", "dnr:lru") as Record<string, number>;
  assert.equal(stored["h1.example"], undefined);
});

test("clearRefererRules keeps the guard rules", async () => {
  await sw.run(() => installGuardRules([API_ORIGIN]));
  await sw.run(() => ensureRefererRule("a.example", null, false));
  await sw.run(() => ensureRefererRule("b.example", null, true));
  assert.equal(await sw.run(() => clearRefererRules()), 2);
  assert.ok(browser.sessionRules.every((rule) => rule.id <= ALLOW_LAST_ID));
  assert.deepEqual(browser.storageGet("session", "dnr:lru"), {});
});

test("a failed update rejects without breaking later calls", async () => {
  browser.failNext("declarativeNetRequest.updateSessionRules", "Internal error.");
  await assert.rejects(
    sw.run(() => ensureRefererRule("a.example", null, false)),
    /Internal error/,
  );
  const id = await sw.run(() => ensureRefererRule("a.example", null, false));
  assert.equal(id, REFERER_FIRST_ID);
});
