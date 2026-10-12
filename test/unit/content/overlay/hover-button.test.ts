import assert from "node:assert/strict";
import { test } from "node:test";
import { createHoverButton, hoverButtonVisible } from "../../../../src/content/overlay/hover-button.ts";
import type { HoverInput } from "../../../../src/content/overlay/hover-button.ts";
import { catalogFor, msg, setLocale, uiLocales } from "../../../../src/shared/i18n/index.ts";
import { asFake, fakeDocument } from "../../ui/fake-dom.ts";

test("the label is a first translation, distinct from the retry label, in every locale", () => {
  assert.equal(msg().ui.translateImage, "Translate", "English by default");
  for (const { code: locale } of uiLocales()) {
    const ui = catalogFor(locale).ui;
    assert.notEqual(ui.translateImage.trim(), "", locale);
    assert.notEqual(ui.translateImage, ui.retranslate, locale);
  }
});

test("shown only in manual mode, while hovering an image with no state and nothing painted", () => {
  const base: HoverInput = { mode: "manual", hovering: true, requested: false, state: undefined, painted: 0 };
  assert.equal(hoverButtonVisible(base), true);
  assert.equal(hoverButtonVisible({ ...base, mode: "auto" }), false);
  assert.equal(hoverButtonVisible({ ...base, hovering: false }), false);
  assert.equal(
    hoverButtonVisible({ ...base, requested: true }),
    false,
    "a click hides it until a state arrives",
  );
  assert.equal(hoverButtonVisible({ ...base, painted: 1 }), false);
  for (const state of ["queued", "translating", "done", "no-text", "error", "partial"] as const) {
    assert.equal(hoverButtonVisible({ ...base, state }), false, state);
  }
});

test("createHoverButton: the msg() label, hidden until shown, isolated click and hover callbacks", () => {
  const events: string[] = [];
  const handle = createHoverButton(fakeDocument(), {
    onClick: () => events.push("click"),
    onHover: (over) => events.push(over ? "enter" : "leave"),
  });
  const button = asFake(handle.element);
  assert.equal(button.textContent, msg().ui.translateImage);
  assert.equal(button.className, "hover-btn");
  assert.equal(button["type"], "button");
  assert.equal(button["hidden"], true);
  handle.setVisible(true);
  assert.equal(button["hidden"], false);
  button.dispatch("pointerenter");
  assert.deepEqual(button.fire("click"), { prevented: true, stopped: true });
  button.dispatch("pointerleave");
  assert.deepEqual(events, ["enter", "click", "leave"]);
  handle.setVisible(false);
  assert.equal(button["hidden"], true);
});

test("createHoverButton follows the UI locale (vi), then English again", () => {
  try {
    setLocale("vi");
    const button = asFake(
      createHoverButton(fakeDocument(), { onClick: () => undefined, onHover: () => undefined }).element,
    );
    assert.equal(button.textContent, catalogFor("vi").ui.translateImage);
  } finally {
    setLocale("en");
  }
  const english = asFake(
    createHoverButton(fakeDocument(), { onClick: () => undefined, onHover: () => undefined }).element,
  );
  assert.equal(english.textContent, "Translate");
});
