// Side panel view model: pure helpers over the engine's transcript (en:transcript), kept apart from the DOM so they
// can be unit tested.

import type { TranscriptItem, UnitStatus } from "../../shared/types.ts";

export interface PageGroup {
  /** 0-based page position in the tab (document order). */
  pageOrder: number;
  items: TranscriptItem[];
}

/** Statuses whose line is still on its way: no edit or retranslation until the request settles. */
const IN_FLIGHT: ReadonlySet<UnitStatus> = new Set<UnitStatus>(["pending", "translating"]);

/** Stable identity of a line across refreshes. */
export function itemKey(item: Pick<TranscriptItem, "contentKey" | "unitKey">): string {
  return `${item.contentKey}\u0000${item.unitKey}`;
}

/** Lines grouped by page, pages in document order and lines in reading order. */
export function groupPages(items: readonly TranscriptItem[]): PageGroup[] {
  const pages = new Map<number, TranscriptItem[]>();
  for (const item of items) {
    const page = pages.get(item.pageOrder);
    if (page === undefined) pages.set(item.pageOrder, [item]);
    else page.push(item);
  }
  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageOrder, lines]) => ({
      pageOrder,
      items: [...lines].sort((a, b) => a.order - b.order || a.unitKey.localeCompare(b.unitKey)),
    }));
}

/** Manual edits are allowed once the line settled and the reader can see what the bubble said. */
export function canEdit(item: TranscriptItem): boolean {
  return !IN_FLIGHT.has(item.status) && item.status !== "ignored";
}

export function canRetranslate(item: TranscriptItem): boolean {
  return !IN_FLIGHT.has(item.status) && item.status !== "ignored";
}

/** A manual edit can be dropped to go back to the AI translation. */
export function canRevert(item: TranscriptItem): boolean {
  return item.manual;
}

/**
 * The edit to send for a draft: null clears a manual edit (an emptied box), a trimmed string replaces the
 * translation, and undefined means nothing changed.
 */
export function editPayload(item: TranscriptItem, draft: string): string | null | undefined {
  const next = draft.trim();
  if (next === "") return item.manual ? null : undefined;
  return next === item.translation.trim() ? undefined : next;
}

/** Plain-text export of the transcript: one block per page, "speaker: translation" per line. */
export function transcriptText(groups: readonly PageGroup[], pageLabel: (n: number) => string): string {
  const blocks: string[] = [];
  for (const group of groups) {
    const lines = group.items
      .filter((item) => item.translation.trim() !== "" && item.status !== "ignored")
      .map((item) =>
        item.speaker.trim() === "" ? item.translation : `${item.speaker}: ${item.translation}`,
      );
    if (lines.length > 0) blocks.push([pageLabel(group.pageOrder + 1), ...lines].join("\n"));
  }
  return blocks.join("\n\n");
}
