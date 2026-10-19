// Turns translation units into packs, one request each, on top of core/packing.ts (even packs of at most boxBudget
// units in reading order, never a split unit, shrunk until the composite lays out). The units may come from several
// consecutive images of one frame (the pipeline gathers them), in document order then reading order; the composite
// layout shows each image as a page thumbnail or a webtoon band.

import type { ModelProfileLike } from "../shared/core/composite-layout.ts";
import { layoutPack, packUnits } from "../shared/core/packing.ts";
import { pagePos } from "../shared/ids.ts";
import type { ReadingDir, Script, Size, UnitGeometry } from "../shared/types.ts";
import type { PackUnit } from "./contracts.ts";

export interface PackPolicy {
  /** Units per request (core/packing resolveBoxBudget). */
  boxBudget: number;
  /** Cap on the first pack when its head image is on screen (settings.translate.urgentPackMax), or null. */
  urgentMax: number | null;
  /** Every pack must lay out on this profile's canvases (full mode); omit for budget-only packing. */
  layout?: { profile: ModelProfileLike; dir: ReadingDir };
}

export interface PackPlan {
  /** Requests in send order, each in reading order. A unit is never split. */
  packs: PackUnit[][];
  /**
   * edgeSmall units (page numbers, watermarks) that found no room in a pack of normal units: they never start a
   * request on their own and are resolved as "ignored" without an upload.
   */
  skipped: PackUnit[];
}

export type PackPlanner = (units: readonly PackUnit[], policy: PackPolicy) => PackPlan;

export interface Batcher {
  plan(units: readonly PackUnit[], policy: PackPolicy): PackPlan;
}

function fitsLayout(units: readonly PackUnit[], policy: PackPolicy): boolean {
  if (policy.layout === undefined) return true;
  try {
    return layoutPack(units, policy.layout.profile, policy.layout.dir, "full").ok;
  } catch {
    return false;
  }
}

/**
 * Default planner: normal units go through core/packing (the first pack capped at urgentMax when given); edgeSmall
 * units then ride along where a pack still has room and still lays out, last pack first (they read last).
 */
export function planPacks(units: readonly PackUnit[], policy: PackPolicy): PackPlan {
  const normal = units.filter((u) => u.geometry.edgeSmall !== true);
  const small = units.filter((u) => u.geometry.edgeSmall === true);
  if (normal.length === 0) return { packs: [], skipped: [...small] };

  const budget = Math.max(1, Math.floor(policy.boxBudget));
  const head = policy.urgentMax === null ? null : Math.min(budget, Math.max(1, Math.floor(policy.urgentMax)));
  const layout = policy.layout === undefined ? {} : { layout: policy.layout };
  const packs: PackUnit[][] = [];
  const caps: number[] = [];
  const add = (list: readonly PackUnit[], cap: number): void => {
    if (list.length === 0) return;
    for (const pack of packUnits(list, { boxBudget: cap, ...layout })) {
      packs.push(pack);
      caps.push(cap);
    }
  };
  if (head === null) {
    add(normal, budget);
  } else {
    add(normal.slice(0, head), head);
    add(normal.slice(head), budget);
  }

  const skipped: PackUnit[] = [];
  for (const unit of small) {
    let placed = false;
    for (let p = packs.length - 1; p >= 0 && !placed; p -= 1) {
      const pack = packs[p];
      if (pack === undefined || pack.length >= (caps[p] ?? 0)) continue;
      const grown = [...pack, unit];
      if (!fitsLayout(grown, policy)) continue;
      packs[p] = grown;
      placed = true;
    }
    if (!placed) skipped.push(unit);
  }
  return { packs, skipped };
}

export function createBatcher(planner: PackPlanner = planPacks): Batcher {
  return {
    plan: (units, policy) => planner(units, policy),
  };
}

export interface PackImage {
  contentKey: string;
  /** Natural (decoded) size of the image. */
  size: Size;
  /** Absolute image URL (x-ctv-test-units in test builds). */
  src: string;
  script: Script;
  /** Document order of the image on its page (PackUnit.pos). */
  docOrder?: number;
}

/** PackUnits of one image's units, sorted by reading order. */
export function toPackUnits(image: PackImage, units: readonly UnitGeometry[]): PackUnit[] {
  return [...units]
    .sort((a, b) => a.order - b.order)
    .map((geometry) => ({
      contentKey: image.contentKey,
      unitKey: geometry.unitKey,
      geometry,
      imageSize: { w: image.size.w, h: image.size.h },
      script: image.script,
      src: image.src,
      ...(image.docOrder === undefined ? {} : { pos: pagePos(image.docOrder, geometry.order) }),
    }));
}
