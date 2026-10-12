import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { catalogFor, msg, setLocale } from "../../../src/shared/i18n/index.ts";
import {
  applyBadge,
  BADGE_COLORS,
  BADGE_INTERVAL_MS,
  clearConsentHint,
  createBadgeController,
  showConsentHint,
  type BadgeRequest,
} from "../../../src/sw/badge.ts";
import { startBrowser, stopBrowser, until } from "./sw-helpers.ts";

afterEach(async () => {
  await stopBrowser();
  setLocale("en");
});

function harness(): {
  applied: Array<{ at: number; request: BadgeRequest }>;
  advance(ms: number): void;
  set(request: BadgeRequest): void;
} {
  let now = 10_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const applied: Array<{ at: number; request: BadgeRequest }> = [];
  const controller = createBadgeController({
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ at: now + ms, fn });
    },
    apply: (request) => {
      applied.push({ at: now, request });
      return Promise.resolve();
    },
  });
  return {
    applied,
    set: (request) => controller.set(request),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next === undefined || next.at > until) break;
        timers.shift();
        now = next.at;
        next.fn();
      }
      now = until;
    },
  };
}

test("at most one update per second per tab: first at once, the newest value at the end of the window", () => {
  const badge = harness();
  badge.set({ tabId: 1, text: "1", tone: "busy" });
  badge.set({ tabId: 1, text: "2", tone: "busy" });
  badge.set({ tabId: 1, text: "3", tone: "busy" });
  badge.set({ tabId: 2, text: "!", tone: "error" });
  assert.deepEqual(
    badge.applied.map((entry) => [entry.at, entry.request.tabId, entry.request.text]),
    [
      [10_000, 1, "1"],
      [10_000, 2, "!"],
    ],
  );
  badge.advance(BADGE_INTERVAL_MS);
  assert.deepEqual(badge.applied.at(-1), { at: 11_000, request: { tabId: 1, text: "3", tone: "busy" } });
  assert.equal(badge.applied.length, 3, "the intermediate '2' was dropped");
  badge.advance(5_000);
  badge.set({ tabId: 1, text: "4", tone: "warn" });
  assert.equal(badge.applied.length, 4, "a quiet tab updates immediately again");
});

test("identical values are not re-sent; a pending value equal to what is shown is dropped", () => {
  const badge = harness();
  badge.set({ tabId: null, text: "5", tone: "busy" });
  badge.advance(2_000);
  badge.set({ tabId: null, text: "5", tone: "busy" });
  assert.equal(badge.applied.length, 1);
  badge.set({ tabId: null, text: "6", tone: "busy" });
  badge.set({ tabId: null, text: "7", tone: "busy" });
  badge.set({ tabId: null, text: "6", tone: "busy" });
  badge.advance(1_000);
  assert.deepEqual(
    badge.applied.map((entry) => entry.request.text),
    ["5", "6"],
    "7 superseded; the final 6 equals what is shown",
  );
  badge.advance(2_000);
  badge.set({ tabId: null, text: "ignored", tone: "none" });
  badge.set({ tabId: null, text: "", tone: "none" });
  assert.deepEqual(badge.applied.at(-1)?.request.tone, "none");
  assert.equal(badge.applied.length, 3);
});

test("applyBadge: text and colour per tab; none clears; null is the global badge", async () => {
  const { browser, sw } = await startBrowser();
  await sw.run(() => applyBadge({ tabId: 4, text: "12", tone: "busy" }));
  assert.deepEqual(browser.badges.get("4"), { text: "12", color: BADGE_COLORS.busy, title: "" });
  await sw.run(() => applyBadge({ tabId: 4, text: "x", tone: "none" }));
  assert.equal(browser.badges.get("4")?.text, "");
  await sw.run(() => applyBadge({ tabId: null, text: "!", tone: "error" }));
  assert.deepEqual(browser.badges.get("global"), { text: "!", color: BADGE_COLORS.error, title: "" });
});

test("consent hint: '!' badge plus a title pointing at the popup; cleared when the site is enabled", async () => {
  const { browser, sw } = await startBrowser();
  await sw.run(() => showConsentHint(41));
  await until(() => browser.badges.get("41")?.text === "!", "hint badge");
  assert.equal(browser.badges.get("41")?.title, msg().popup.consentHint);
  assert.equal(msg().popup.consentHint, catalogFor("en").popup.consentHint, "English by default");
  await sw.run(() => clearConsentHint(41));
  assert.equal(browser.badges.get("41")?.title, msg().ui.appName);
});

test("the consent hint title follows the active UI locale", async () => {
  const { browser, sw } = await startBrowser();
  setLocale("vi");
  await sw.run(() => showConsentHint(42));
  assert.equal(browser.badges.get("42")?.title, catalogFor("vi").popup.consentHint);
  assert.notEqual(catalogFor("vi").popup.consentHint, catalogFor("en").popup.consentHint);
});
