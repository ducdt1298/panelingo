// __TEST__ builds only (main.ts creates the hooks behind `if (__TEST__)`, so dev and prod bundles drop this
// module): a machine-readable summary of the content script for E2E tests, written to
// document.documentElement.dataset.ctvTest (a DOM attribute, so Puppeteer can read it from the main world).

import type { EngineClientState } from "./contracts.ts";

export interface ContentSummary {
  mode: "auto" | "manual";
  client: EngineClientState;
  /** From en:hello; null before the first connection. */
  frameKey: string | null;
  /** imageKey → engine ImageState, or a local stage: tracked (not requested), queued, reading, submitted. */
  images: Record<string, string>;
  /** imageKey → units painted (status ok or manual, with a translation). */
  painted: Record<string, number>;
  paintedTotal: number;
  /** imageKeys whose picture came from a screen capture (img:units lowRes). */
  lowRes: string[];
  /** imageKeys submitted as tier-B prefetch candidates and not asked to be translated yet. */
  prefetch: string[];
  /** imageKey → the element's id attribute, when it has one. */
  ids: Record<string, string>;
  /** imageKey → code of the image's current error, when it has one. */
  errors: Record<string, string>;
  tornDown: boolean;
}

/** What E2E tests parse: the summary plus a sequence number that grows with every write. */
export type PublishedSummary = ContentSummary & { seq: number };

export const TEST_DATASET_KEY = "ctvTest";

export interface TestHooks {
  /** Coalesced: several publishes in one task produce one write. */
  publish(summary: ContentSummary): void;
  /** Writes what is still queued and stops. */
  dispose(): void;
}

export function readSummary(doc: Document): PublishedSummary | null {
  const raw = doc.documentElement.dataset[TEST_DATASET_KEY];
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as PublishedSummary;
  } catch {
    return null;
  }
}

export function createTestHooks(
  doc: Document,
  schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn),
): TestHooks {
  let seq = 0;
  let latest: ContentSummary | null = null;
  let queued = false;
  let disposed = false;

  const write = (): void => {
    queued = false;
    if (disposed || latest === null) return;
    seq += 1;
    const published: PublishedSummary = { ...latest, seq };
    doc.documentElement.dataset[TEST_DATASET_KEY] = JSON.stringify(published);
  };

  return {
    publish(summary) {
      if (disposed) return;
      latest = summary;
      if (queued) return;
      queued = true;
      schedule(write);
    },
    dispose() {
      if (queued) write();
      disposed = true;
    },
  };
}
