import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLogger } from "../../../src/platform/log.ts";
import {
  CLEAR_BADGE,
  badgeFor,
  createBadgeFeed,
  progressOf,
  type BadgeRequest,
} from "../../../src/engine/badge-feed.ts";

function feed(): { sent: BadgeRequest[]; badges: ReturnType<typeof createBadgeFeed> } {
  const sent: BadgeRequest[] = [];
  const badges = createBadgeFeed({
    log: createLogger("engine", { minLevel: "error", sinks: [] }),
    send: (request) => {
      sent.push(request);
      return Promise.resolve({});
    },
  });
  return { sent, badges };
}

describe("toolbar badge feed", () => {
  test("progressOf and progress(tabId): every frame's images of the tab, by state", () => {
    assert.deepEqual(progressOf([]), { total: 0, working: 0, paused: 0, failed: 0 });
    assert.deepEqual(progressOf(["done", "no-text", "queued", "translating", "paused", "error"]), {
      total: 6,
      working: 2,
      paused: 1,
      failed: 1,
    });
    const { badges } = feed();
    badges.observe(3, "f1", "a", "done");
    badges.observe(3, "f1", "b", "translating");
    badges.observe(3, "f2", "c", "queued");
    badges.observe(4, "g", "d", "error");
    assert.deepEqual(badges.progress(3), { total: 3, working: 2, paused: 0, failed: 0 });
    badges.observe(3, "f1", "b", "done");
    badges.forgetFrame("f2");
    assert.deepEqual(badges.progress(3), { total: 2, working: 0, paused: 0, failed: 0 });
    assert.deepEqual(badges.progress(99), { total: 0, working: 0, paused: 0, failed: 0 });
  });

  test("badgeFor: images in progress are counted; pauses and errors win; settled tabs clear", () => {
    assert.deepEqual(badgeFor([]), CLEAR_BADGE);
    assert.deepEqual(badgeFor(["done", "no-text", "partial", "refused", "stale"]), CLEAR_BADGE);
    assert.deepEqual(badgeFor(["queued", "translating", "done", "detecting"]), { text: "3", tone: "busy" });
    assert.deepEqual(badgeFor(["translating", "paused"]), { text: "!", tone: "warn" });
    assert.deepEqual(badgeFor(["paused", "error", "translating"]), { text: "!", tone: "error" });
    assert.deepEqual(badgeFor(Array.from({ length: 120 }, () => "waiting" as const)), {
      text: "99+",
      tone: "busy",
    });
  });

  test("sends only changes, per tab", () => {
    const { sent, badges } = feed();
    badges.observe(7, "f1", "a", "queued");
    badges.observe(7, "f1", "a", "detecting");
    badges.observe(7, "f1", "b", "queued");
    badges.observe(9, "f2", "a", "translating");
    badges.observe(7, "f1", "a", "done");
    badges.observe(7, "f1", "b", "done");
    assert.deepEqual(sent, [
      { tabId: 7, text: "1", tone: "busy" },
      { tabId: 7, text: "2", tone: "busy" },
      { tabId: 9, text: "1", tone: "busy" },
      { tabId: 7, text: "1", tone: "busy" },
      { tabId: 7, text: "", tone: "none" },
    ]);
  });

  test("a tab that never showed a badge is not cleared; tabs without an id are ignored", () => {
    const { sent, badges } = feed();
    badges.observe(3, "f", "a", "done");
    badges.observe(-1, "g", "a", "queued");
    assert.deepEqual(sent, []);
  });

  test("a frame that goes away no longer counts", () => {
    const { sent, badges } = feed();
    badges.observe(5, "top", "a", "translating");
    badges.observe(5, "iframe", "b", "error");
    badges.forgetFrame("iframe");
    badges.forgetFrame("top");
    badges.forgetFrame("unknown");
    assert.deepEqual(sent, [
      { tabId: 5, text: "1", tone: "busy" },
      { tabId: 5, text: "!", tone: "error" },
      { tabId: 5, text: "1", tone: "busy" },
      { tabId: 5, text: "", tone: "none" },
    ]);
  });

  test("a failing sw:badge call is swallowed", async () => {
    const badges = createBadgeFeed({
      log: createLogger("engine", { minLevel: "error", sinks: [] }),
      send: () => Promise.reject(new Error("no service worker")),
    });
    badges.observe(1, "f", "a", "queued");
    await new Promise((resolve) => setImmediate(resolve));
  });
});
