// The overlay's privacy card (first upload before the one-time notice was confirmed): texts from msg(), isolated
// buttons, and clicks on the card never reach the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivacyNotice } from "../../../../src/content/overlay/notice.ts";
import { catalogFor, msg, setLocale } from "../../../../src/shared/i18n/index.ts";
import { asFake, fakeDocument, type FakeElement } from "../../ui/fake-dom.ts";

function card(calls: string[] = []): FakeElement {
  return asFake(
    createPrivacyNotice(fakeDocument(), {
      onAccept: () => calls.push("accept"),
      onDecline: () => calls.push("decline"),
    }),
  );
}

function partOf(root: FakeElement, className: string): FakeElement | undefined {
  return root.findAll("div").find((el) => el.className === className);
}

test("English by default: dialog title, body and the two buttons (decline first)", () => {
  const notice = card();
  assert.equal(notice.className, "notice");
  assert.equal(notice.getAttribute("role"), "dialog");
  assert.equal(notice.getAttribute("aria-label"), msg().ui.privacyTitle);
  assert.equal(partOf(notice, "title")?.textContent, "Before images are sent to the AI");
  assert.equal(partOf(notice, "body")?.textContent, msg().ui.privacyBody);
  assert.deepEqual(
    notice.findAll("button").map((button) => [button.className, button.textContent]),
    [
      ["decline", msg().ui.privacyDecline],
      ["accept", msg().ui.privacyAccept],
    ],
  );
});

test("accept and decline call their handler; the clicks never reach the page", () => {
  const calls: string[] = [];
  const notice = card(calls);
  const [decline, accept] = notice.findAll("button");
  assert.deepEqual(accept?.fire("click"), { prevented: true, stopped: true });
  assert.deepEqual(decline?.fire("click"), { prevented: true, stopped: true });
  assert.deepEqual(calls, ["accept", "decline"]);
  assert.deepEqual(notice.fire("click"), { prevented: true, stopped: true }, "the card itself is isolated");
  assert.equal(notice.fire("pointerdown").stopped, true);
  assert.deepEqual(calls, ["accept", "decline"], "a click on the card is not a decision");
});

test("follows the UI locale (vi), then English again", () => {
  const vi = catalogFor("vi");
  try {
    setLocale("vi");
    const notice = card();
    assert.equal(notice.getAttribute("aria-label"), vi.ui.privacyTitle);
    assert.equal(partOf(notice, "title")?.textContent, vi.ui.privacyTitle);
    assert.equal(partOf(notice, "body")?.textContent, vi.ui.privacyBody);
    assert.deepEqual(
      notice.findAll("button").map((button) => button.textContent),
      [vi.ui.privacyDecline, vi.ui.privacyAccept],
    );
  } finally {
    setLocale("en");
  }
  assert.equal(partOf(card(), "title")?.textContent, msg().ui.privacyTitle);
});
