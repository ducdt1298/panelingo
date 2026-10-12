import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TranscriptItem } from "../../../src/shared/types.ts";
import {
  canEdit,
  canRetranslate,
  canRevert,
  editPayload,
  groupPages,
  itemKey,
  transcriptText,
} from "../../../src/ui/sidepanel/sidepanel-model.ts";

function item(patch: Partial<TranscriptItem>): TranscriptItem {
  return {
    contentKey: "s:aaa",
    unitKey: "u1",
    pageOrder: 0,
    order: 0,
    type: "dialogue",
    speaker: "",
    original: "안녕",
    translation: "Hello",
    status: "ok",
    manual: false,
    flags: [],
    ...patch,
  };
}

describe("side panel model", () => {
  test("itemKey tells lines of different images apart even with the same unit key", () => {
    assert.notEqual(itemKey(item({ contentKey: "s:a" })), itemKey(item({ contentKey: "s:b" })));
    assert.equal(itemKey(item({})), itemKey(item({ translation: "changed" })));
  });

  test("groupPages: pages in document order, lines in reading order", () => {
    const groups = groupPages([
      item({ pageOrder: 1, order: 1, unitKey: "b2" }),
      item({ pageOrder: 0, order: 2, unitKey: "a3" }),
      item({ pageOrder: 1, order: 0, unitKey: "b1" }),
      item({ pageOrder: 0, order: 0, unitKey: "a1" }),
      item({ pageOrder: 0, order: 0, unitKey: "a0" }),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.pageOrder, g.items.map((i) => i.unitKey)]),
      [
        [0, ["a0", "a1", "a3"]],
        [1, ["b1", "b2"]],
      ],
    );
    assert.deepEqual(groupPages([]), []);
  });

  test("lines in flight or ignored cannot be edited or retranslated", () => {
    for (const status of ["pending", "translating", "ignored"] as const) {
      assert.equal(canEdit(item({ status })), false, status);
      assert.equal(canRetranslate(item({ status })), false, status);
    }
    for (const status of [
      "ok",
      "manual",
      "keep-original",
      "untranslated",
      "refused",
      "error",
      "stale",
    ] as const) {
      assert.equal(canEdit(item({ status })), true, status);
      assert.equal(canRetranslate(item({ status })), true, status);
    }
  });

  test("only manual edits can be reverted", () => {
    assert.equal(canRevert(item({ manual: true, status: "manual" })), true);
    assert.equal(canRevert(item({})), false);
  });

  test("editPayload: trimmed new text, null clears a manual edit, undefined when nothing changed", () => {
    assert.equal(editPayload(item({}), "  Hi there  "), "Hi there");
    assert.equal(editPayload(item({}), "Hello "), undefined);
    assert.equal(editPayload(item({}), "   "), undefined);
    assert.equal(editPayload(item({ manual: true, status: "manual", translation: "Mine" }), ""), null);
  });

  test("transcriptText: one block per page with speakers, skipping empty and ignored lines", () => {
    const text = transcriptText(
      groupPages([
        item({ pageOrder: 0, order: 0, unitKey: "a", speaker: "Mina", translation: "Hi." }),
        item({ pageOrder: 0, order: 1, unitKey: "b", translation: "Bye." }),
        item({ pageOrder: 0, order: 2, unitKey: "c", translation: "", status: "untranslated" }),
        item({ pageOrder: 2, order: 0, unitKey: "d", translation: "BOOM", status: "ignored" }),
        item({ pageOrder: 3, order: 0, unitKey: "e", translation: "The end." }),
      ]),
      (n) => `Page ${n}`,
    );
    assert.equal(text, "Page 1\nMina: Hi.\nBye.\n\nPage 4\nThe end.");
  });
});
