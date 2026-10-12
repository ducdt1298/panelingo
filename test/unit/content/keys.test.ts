import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPeek, isEditableTarget, peekCode } from "../../../src/content/keys.ts";

interface KeyInit {
  code: string;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** A keyboard-like event (Node has Event but no KeyboardEvent). */
function key(type: "keydown" | "keyup", init: KeyInit): KeyboardEvent {
  const event = new Event(type, { cancelable: true });
  return Object.assign(event, {
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  }) as unknown as KeyboardEvent;
}

/** A window stand-in: an EventTarget with a document that has a visibility state. */
function fakeWindow(): { win: Window; doc: EventTarget & { visibilityState: string } } {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = Object.assign(new EventTarget(), { document: doc }) as unknown as Window;
  return { win, doc };
}

/** A target that looks like an element with this tag (dispatched events report it in composedPath()). */
function element(localName: string, isContentEditable = false): EventTarget {
  return Object.assign(new EventTarget(), { localName, isContentEditable });
}

function run(options: { key?: string; withAlt?: boolean } = {}): {
  win: Window;
  doc: EventTarget & { visibilityState: string };
  calls: boolean[];
  destroy: () => void;
} {
  const { win, doc } = fakeWindow();
  const calls: boolean[] = [];
  const peek = createPeek({
    win,
    key: options.key ?? "Backquote",
    withAlt: options.withAlt ?? false,
    onPeek: (active) => calls.push(active),
  });
  return { win, doc, calls, destroy: () => peek.destroy() };
}

describe("peek at the original", () => {
  test("peekCode: the configured key without Alt/Ctrl/Meta, Alt alone only when enabled", () => {
    assert.equal(peekCode(key("keydown", { code: "Backquote" }), "Backquote", false), "Backquote");
    assert.equal(
      peekCode(key("keydown", { code: "Backquote", shiftKey: true }), "Backquote", false),
      "Backquote",
    );
    assert.equal(peekCode(key("keydown", { code: "Backquote", ctrlKey: true }), "Backquote", false), null);
    assert.equal(peekCode(key("keydown", { code: "Backquote", altKey: true }), "Backquote", false), null);
    assert.equal(peekCode(key("keydown", { code: "KeyA" }), "Backquote", false), null);
    assert.equal(peekCode(key("keydown", { code: "Backquote" }), "", false), null);
    assert.equal(peekCode(key("keydown", { code: "AltLeft", altKey: true }), "", false), null);
    assert.equal(peekCode(key("keydown", { code: "AltLeft", altKey: true }), "", true), "AltLeft");
    assert.equal(
      peekCode(key("keydown", { code: "AltRight", altKey: true, shiftKey: true }), "", true),
      null,
    );
  });

  test("isEditableTarget: inputs, text areas, selects and contenteditable elements", () => {
    for (const [target, editable] of [
      [element("input"), true],
      [element("textarea"), true],
      [element("select"), true],
      [element("div", true), true],
      [element("div"), false],
      [new EventTarget(), false],
    ] as const) {
      const event = key("keydown", { code: "Backquote" });
      target.dispatchEvent(event);
      assert.equal(isEditableTarget(event), editable);
    }
  });

  test("holding the key hides the overlay until it is released; repeats do nothing", () => {
    const { win, calls, destroy } = run();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    win.dispatchEvent(key("keydown", { code: "Backquote", repeat: true }));
    win.dispatchEvent(key("keyup", { code: "KeyA" }));
    assert.deepEqual(calls, [true]);
    win.dispatchEvent(key("keyup", { code: "Backquote" }));
    assert.deepEqual(calls, [true, false]);
    destroy();
  });

  test("keys typed into a text field never peek", () => {
    const { calls, destroy } = run();
    element("input").dispatchEvent(key("keydown", { code: "Backquote" }));
    assert.deepEqual(calls, []);
    destroy();
  });

  test("losing focus or hiding the tab ends a peek", () => {
    const { win, doc, calls, destroy } = run();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    win.dispatchEvent(new Event("blur"));
    assert.deepEqual(calls, [true, false]);
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual(calls, [true, false, true, false]);
    destroy();
  });

  test("Alt peeks when enabled; its keyup is cancelled; another key turns it into a shortcut", () => {
    const { win, calls, destroy } = run({ key: "", withAlt: true });
    win.dispatchEvent(key("keydown", { code: "AltLeft", altKey: true }));
    const up = key("keyup", { code: "AltLeft" });
    win.dispatchEvent(up);
    assert.equal(up.defaultPrevented, true);
    assert.deepEqual(calls, [true, false]);
    win.dispatchEvent(key("keydown", { code: "AltLeft", altKey: true }));
    win.dispatchEvent(key("keydown", { code: "KeyY", altKey: true, shiftKey: true }));
    assert.deepEqual(calls, [true, false, true, false]);
    const late = key("keyup", { code: "AltLeft" });
    win.dispatchEvent(late);
    assert.equal(late.defaultPrevented, false, "a shortcut's Alt keyup is left alone");
    destroy();
  });

  test("destroy ends an active peek and removes the listeners", () => {
    const { win, calls, destroy } = run();
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    destroy();
    assert.deepEqual(calls, [true, false]);
    win.dispatchEvent(key("keydown", { code: "Backquote" }));
    assert.deepEqual(calls, [true, false]);
  });
});

test("isEditableTarget: key events from the bubble popup's (closed) host never peek", () => {
  const host = Object.assign(new EventTarget(), {
    localName: "ctv-popup",
    hasAttribute: (name: string) => name === "data-ctv-popup",
  });
  const event = key("keydown", { code: "Backquote" });
  host.dispatchEvent(event);
  assert.equal(isEditableTarget(event), true);
  const other = Object.assign(new EventTarget(), { localName: "ctv-host", hasAttribute: () => false });
  const plain = key("keydown", { code: "Backquote" });
  other.dispatchEvent(plain);
  assert.equal(isEditableTarget(plain), false);
});
