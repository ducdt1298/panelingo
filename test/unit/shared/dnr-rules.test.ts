import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GUARD_REGEXES,
  REFERER_FIRST_ID,
  TAB_ID_NONE,
  buildGuardRules,
  buildRefererRule,
  nextRefererId,
  normalizeOrigin,
  refererRuleHost,
  sameRefererAction,
} from "../../../src/shared/dnr-rules.ts";

const EXT = "abcdefghijklmnopabcdefghijklmnop";

describe("guard regexes (D-026)", () => {
  const blocked = (url: string): boolean => GUARD_REGEXES.some((re) => new RegExp(re, "i").test(url));
  const cases: Array<[string, boolean]> = [
    ["http://127.0.0.1:8099/x", true],
    ["http://127.0.0.1/", true],
    ["https://10.0.0.5/img.png", true],
    ["http://0.0.0.0:1234/v1", true],
    ["http://192.168.1.10/", true],
    ["http://169.254.169.254/latest/meta-data", true],
    ["http://172.16.0.1/", true],
    ["http://172.31.255.255/", true],
    ["http://100.64.0.1/", true],
    ["http://100.127.1.1/", true],
    ["http://[::1]:8080/", true],
    ["http://localhost:8081/img", true],
    ["http://cdn.localhost/a.png", true],
    // Public hosts that only look similar must pass.
    ["https://10.example.com/a.png", false],
    ["https://0.gravatar.com/avatar", false],
    ["http://172.15.0.1/", false],
    ["http://172.32.0.1/", false],
    ["http://100.63.0.1/", false],
    ["http://100.128.0.1/", false],
    ["https://cdn.example.com/localhost/a.png", false],
    ["https://localhostcdn.example.com/a.png", false],
  ];
  for (const [url, expected] of cases) {
    test(`${expected ? "blocks" : "allows"} ${url}`, () => assert.equal(blocked(url), expected));
  }
});

test("guard rules: 6 block rules (priority 1) then allow rules (priority 2), all scoped to the extension", () => {
  const rules = buildGuardRules(EXT, ["http://127.0.0.1:1234/v1", "127.0.0.1:8080", "http://127.0.0.1:1234"]);
  assert.deepEqual(
    rules.map((r) => [r.id, r.priority, r.action.type]),
    [
      [1, 1, "block"],
      [2, 1, "block"],
      [3, 1, "block"],
      [4, 1, "block"],
      [5, 1, "block"],
      [6, 1, "block"],
      [10, 2, "allow"],
      [11, 2, "allow"],
    ],
  );
  assert.deepEqual(
    rules.slice(6).map((r) => r.condition.urlFilter),
    ["|http://127.0.0.1:1234/", "|http://127.0.0.1:8080/"],
  );
  for (const rule of rules) {
    assert.deepEqual(rule.condition.initiatorDomains, [EXT]);
    assert.deepEqual(rule.condition.tabIds, [TAB_ID_NONE]);
  }
});

test("referer rule: set or remove referer, optionally remove origin, priority 3", () => {
  const set = buildRefererRule(1000, EXT, "cdn.example.com", "https://reader.example/ch/1", true);
  assert.equal(set.priority, 3);
  assert.deepEqual(set.action, {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "referer", operation: "set", value: "https://reader.example/ch/1" },
      { header: "origin", operation: "remove" },
    ],
  });
  assert.deepEqual(set.condition, {
    requestDomains: ["cdn.example.com"],
    initiatorDomains: [EXT],
    tabIds: [-1],
  });
  const remove = buildRefererRule(1001, EXT, "cdn.example.com", null, false);
  assert.deepEqual(remove.action, {
    type: "modifyHeaders",
    requestHeaders: [{ header: "referer", operation: "remove" }],
  });
  assert.equal(sameRefererAction(set, remove), false);
  assert.equal(
    sameRefererAction(set, buildRefererRule(1002, EXT, "x", "https://reader.example/ch/1", true)),
    true,
  );
  assert.throws(() => buildRefererRule(5, EXT, "h", null, false), /below/);
});

test("ids are rebuilt from the existing rules", () => {
  assert.equal(nextRefererId([]), REFERER_FIRST_ID);
  assert.equal(nextRefererId([1, 2, 10, 1000, 1003]), 1004);
  assert.equal(refererRuleHost({ id: 1000, condition: { requestDomains: ["a.example"] } }), "a.example");
  assert.equal(refererRuleHost({ id: 3, condition: { requestDomains: ["a.example"] } }), null);
});

test("origins are normalized", () => {
  assert.equal(normalizeOrigin("http://127.0.0.1:1234/v1/chat"), "http://127.0.0.1:1234");
  assert.equal(normalizeOrigin("localhost:8081"), "http://localhost:8081");
  assert.equal(normalizeOrigin("HTTPS://CDN.Example.com"), "https://cdn.example.com");
});
