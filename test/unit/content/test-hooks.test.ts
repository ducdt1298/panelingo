// __TEST__ summary hook: coalesced writes to documentElement.dataset.ctvTest, read back by E2E tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TEST_DATASET_KEY,
  createTestHooks,
  readSummary,
  type ContentSummary,
} from "../../../src/content/test-hooks.ts";

function fakeDocument(): { doc: Document; dataset: Record<string, string> } {
  const dataset: Record<string, string> = {};
  const doc = { documentElement: { dataset } } as unknown as Document;
  return { doc, dataset };
}

function summary(overrides: Partial<ContentSummary> = {}): ContentSummary {
  return {
    mode: "auto",
    client: "idle",
    frameKey: null,
    images: {},
    painted: {},
    paintedTotal: 0,
    lowRes: [],
    prefetch: [],
    ids: {},
    errors: {},
    tornDown: false,
    ...overrides,
  };
}

test("publishes in the same task are coalesced into one write with a growing seq", async () => {
  const { doc, dataset } = fakeDocument();
  const hooks = createTestHooks(doc);
  hooks.publish(summary({ client: "connecting" }));
  hooks.publish(summary({ client: "open", images: { "1.0": "translating" } }));
  assert.equal(dataset[TEST_DATASET_KEY], undefined, "written at the end of the task");
  await Promise.resolve();
  assert.deepEqual(readSummary(doc), {
    ...summary({ client: "open", images: { "1.0": "translating" } }),
    seq: 1,
  });

  hooks.publish(summary({ painted: { "1.0": 2 }, paintedTotal: 2 }));
  await Promise.resolve();
  assert.equal(readSummary(doc)?.seq, 2);
  assert.equal(readSummary(doc)?.paintedTotal, 2);
});

test("dispose writes what is queued and ignores later publishes", () => {
  const scheduled: Array<() => void> = [];
  const { doc } = fakeDocument();
  const hooks = createTestHooks(doc, (fn) => scheduled.push(fn));
  hooks.publish(summary({ tornDown: true, client: "dead" }));
  hooks.dispose();
  assert.equal(readSummary(doc)?.tornDown, true);
  hooks.publish(summary({ client: "open" }));
  for (const fn of scheduled) fn();
  assert.equal(readSummary(doc)?.client, "dead");
  assert.equal(readSummary(doc)?.seq, 1);
});

test("readSummary tolerates a missing or broken attribute", () => {
  const { doc, dataset } = fakeDocument();
  assert.equal(readSummary(doc), null);
  dataset[TEST_DATASET_KEY] = "{broken";
  assert.equal(readSummary(doc), null);
});
