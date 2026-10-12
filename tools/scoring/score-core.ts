// Scoring core for the quality benchmarks: detector recall, LLM output (format compliance, id mapping, text
// accuracy) and reading order. Node tool built on the shipped pure geometry (src/shared).
//
// Conventions: a ratio with an empty denominator is 1 ("nothing to find"), except formatCompliance of an empty
// reply (0) and mappingAccuracy when ids were sent but none came back (0).

import { contain, height, inflate, iou, union, width } from "../../src/shared/geometry.ts";
import type { SlicePlan } from "../../src/shared/core/slicer.ts";
import type { Box, DetClass, Detection, UnitGeometry } from "../../src/shared/types.ts";
import { coveredFraction, greedyMatch, ratio } from "./boxes.ts";
import { normalizeGtUnit } from "./gt.ts";
import type { GtUnit, GtUnitInput } from "./gt.ts";
import { outputLines, parseRecordLine } from "./output-format.ts";
import { cer, kendallTau } from "./text-metrics.ts";
import type { NormalizeOptions } from "./text-metrics.ts";

export { coveredFraction, greedyMatch, toBox, unionCoverArea } from "./boxes.ts";
export type { BoxLike, MatchPair } from "./boxes.ts";
export { normalizeGtUnit, parseGtUnits } from "./gt.ts";
export type { GtUnit, GtUnitInput } from "./gt.ts";
export { outputLines, parseRecordLine } from "./output-format.ts";
export type { OutputRecord } from "./output-format.ts";
export { cer, graphemes, kendallTau, levenshtein, normalizeForCer } from "./text-metrics.ts";
export type { NormalizeOptions } from "./text-metrics.ts";

// ---------------------------------------------------------------------------------------------------------------
// Unit matching

/** A predicted unit (engine UnitGeometry or anything with bubble/text), or a bare box (e.g. a rendered overlay). */
export type PredictedUnit = Pick<UnitGeometry, "bubble" | "text"> & Partial<Pick<UnitGeometry, "order">>;

export interface UnitMatchRules {
  /** A predicted bubble matches a GT bubble at IoU ≥ this. */
  bubbleIou?: number;
  /** Or the predicted text box covers ≥ this fraction of the GT text box (e.g. 0.6 lenient, 0.8 strict) ... */
  textContain?: number;
  /** ... while lying ≥ this fraction inside the GT unit (bubble ∪ text, or text inflated by half its short side). */
  predInside?: number;
}

export const UNIT_MATCH_DEFAULTS = { bubbleIou: 0.5, textContain: 0.6, predInside: 0.5 } as const;

export interface UnitMatch {
  gtIndex: number;
  gtId: string | number;
  predIndex: number;
  by: "bubble" | "text";
  score: number;
}

export interface Tally {
  gt: number;
  matched: number;
  recall: number;
}

export interface UnitMatchResult {
  matches: UnitMatch[];
  recallByClass: { bubble: number; free: number; all: number };
  tally: { bubble: Tally; free: Tally; all: Tally };
  precision: number;
  unmatched: { gt: Array<string | number>; pred: number[] };
}

function isBox(p: PredictedUnit | Box): p is Box {
  return "x1" in p;
}

function gtOuter(g: GtUnit): Box {
  if (g.bubble !== null) return union(g.bubble, g.text);
  return inflate(g.text, Math.max(4, 0.5 * Math.min(width(g.text), height(g.text))));
}

/**
 * One-to-one greedy matching of predicted units to GT units. A pair qualifies by bubble IoU when both have a bubble
 * (a bare box is tried as a bubble too); otherwise by text containment with the "inside the GT unit" guard, so one
 * huge box cannot claim a unit. Pairs are ranked by their score (IoU or containment), best first.
 */
export function matchUnits(
  predicted: ReadonlyArray<PredictedUnit | Box>,
  gtUnits: ReadonlyArray<GtUnitInput>,
  rules: UnitMatchRules = {},
): UnitMatchResult {
  const bubbleIou = rules.bubbleIou ?? UNIT_MATCH_DEFAULTS.bubbleIou;
  const textContain = rules.textContain ?? UNIT_MATCH_DEFAULTS.textContain;
  const predInside = rules.predInside ?? UNIT_MATCH_DEFAULTS.predInside;
  const gt = gtUnits.map((u) => normalizeGtUnit(u));
  const preds = predicted.map((p) =>
    isBox(p) ? { bubble: p, text: p } : { bubble: p.bubble, text: p.text },
  );

  const best = new Map<string, { by: "bubble" | "text"; score: number }>();
  const pairs = greedyMatch(gt.length, preds.length, (gi, pi) => {
    const g = gt[gi];
    const p = preds[pi];
    if (g === undefined || p === undefined) return null;
    let found: { by: "bubble" | "text"; score: number } | null = null;
    if (g.bubble !== null && p.bubble !== null) {
      const s = iou(p.bubble, g.bubble);
      if (s >= bubbleIou) found = { by: "bubble", score: s };
    }
    if (found === null) {
      const c = contain(g.text, p.text);
      if (c >= textContain && contain(p.text, gtOuter(g)) >= predInside) found = { by: "text", score: c };
    }
    if (found === null) return null;
    best.set(`${gi}:${pi}`, found);
    return found.score;
  });

  const matches: UnitMatch[] = pairs.map((pair) => {
    const g = gt[pair.gt] as GtUnit;
    return {
      gtIndex: pair.gt,
      gtId: g.id,
      predIndex: pair.pred,
      by: best.get(`${pair.gt}:${pair.pred}`)?.by ?? "text",
      score: pair.score,
    };
  });
  const matchedGt = new Set(matches.map((m) => m.gtIndex));
  const matchedPred = new Set(matches.map((m) => m.predIndex));
  const tallyOf = (kind: "bubble" | "free" | null): Tally => {
    const idx = [...gt.keys()].filter((i) => kind === null || gt[i]?.kind === kind);
    const matched = idx.filter((i) => matchedGt.has(i)).length;
    return { gt: idx.length, matched, recall: ratio(matched, idx.length) };
  };
  const tally = { bubble: tallyOf("bubble"), free: tallyOf("free"), all: tallyOf(null) };
  return {
    matches,
    recallByClass: { bubble: tally.bubble.recall, free: tally.free.recall, all: tally.all.recall },
    tally,
    precision: ratio(matches.length, preds.length),
    unmatched: {
      gt: gt.filter((_, i) => !matchedGt.has(i)).map((g) => g.id),
      pred: [...preds.keys()].filter((i) => !matchedPred.has(i)),
    },
  };
}

/**
 * Kendall tau between the predicted reading order (UnitGeometry.order, else array index) and the GT order
 * (GtUnit.order, else array index), over the matched units.
 */
export function readingOrderTau(
  predicted: ReadonlyArray<PredictedUnit | Box>,
  gtUnits: ReadonlyArray<GtUnitInput>,
  rules: UnitMatchRules = {},
): { tau: number; matched: number } {
  const { matches } = matchUnits(predicted, gtUnits, rules);
  const predKey = (i: number): number => {
    const p = predicted[i];
    return p !== undefined && !isBox(p) && p.order !== undefined ? p.order : i;
  };
  const gtKey = (i: number): number => gtUnits[i]?.order ?? i;
  const byPred = [...matches]
    .sort((a, b) => predKey(a.predIndex) - predKey(b.predIndex) || a.predIndex - b.predIndex)
    .map((m) => m.gtIndex);
  const byGt = [...matches]
    .sort((a, b) => gtKey(a.gtIndex) - gtKey(b.gtIndex) || a.gtIndex - b.gtIndex)
    .map((m) => m.gtIndex);
  return { tau: kendallTau(byPred, byGt), matched: matches.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Detector recall

export interface DetectorScoreOptions {
  /** Bubble boxes match at IoU ≥ this. */
  bubbleIou?: number;
  /** Text boxes match at IoU ≥ this (GT ink boxes are tighter than detector boxes). */
  textIou?: number;
  /** A GT unit is found when the union of predicted text boxes covers ≥ this fraction of its text. */
  unitContain?: number;
  /**
   * GT boxes the two text classes are matched against. "unit" (default): one box per GT unit, its `text` (the ink
   * box of the whole block), because the detector boxes a text block, not its lines (one "inkBox" per text in the
   * comic-fixture/1 schema, where several text entries of one bubble are unioned). "lines": every box of `texts`; the
   * generated fixtures write one box per rendered line there, so a correct block-level detection of a 3-line bubble matches none.
   */
  textGt?: "unit" | "lines";
}

export const DETECTOR_SCORE_DEFAULTS = {
  bubbleIou: 0.5,
  textIou: 0.3,
  unitContain: 0.6,
  textGt: "unit",
} as const;

export interface ClassScore {
  gt: number;
  pred: number;
  matched: number;
  recall: number;
  precision: number;
  /** Mean IoU of the matched pairs (0 without matches). */
  meanIou: number;
}

export interface DetectorScores {
  bubble: ClassScore;
  text_bubble: ClassScore;
  text_free: ClassScore;
  /** Both text classes pooled, class-agnostic. */
  text: ClassScore;
  units: { gt: number; found: number; recall: number };
}

function classScore(preds: readonly Box[], gts: readonly Box[], minIou: number): ClassScore {
  const pairs = greedyMatch(gts.length, preds.length, (g, p) => {
    const a = gts[g];
    const b = preds[p];
    if (a === undefined || b === undefined) return null;
    const s = iou(a, b);
    return s >= minIou ? s : null;
  });
  const sum = pairs.reduce((acc, pair) => acc + pair.score, 0);
  return {
    gt: gts.length,
    pred: preds.length,
    matched: pairs.length,
    recall: ratio(pairs.length, gts.length),
    precision: ratio(pairs.length, preds.length),
    meanIou: pairs.length > 0 ? sum / pairs.length : 0,
  };
}

/**
 * Detector quality on one page against GT units: greedy one-to-one IoU matching per class (GT bubbles → bubble,
 * text of bubble units → text_bubble, text of free units → text_free; see `textGt`), the pooled text score, and unit
 * recall (union coverage of each unit's line boxes, so it does not depend on how the detector splits a block).
 */
export function detectorRecall(
  dets: readonly Detection[],
  gtUnits: ReadonlyArray<GtUnitInput>,
  opts: DetectorScoreOptions = {},
): DetectorScores {
  const bubbleIou = opts.bubbleIou ?? DETECTOR_SCORE_DEFAULTS.bubbleIou;
  const textIou = opts.textIou ?? DETECTOR_SCORE_DEFAULTS.textIou;
  const unitContain = opts.unitContain ?? DETECTOR_SCORE_DEFAULTS.unitContain;
  const textGt = opts.textGt ?? DETECTOR_SCORE_DEFAULTS.textGt;
  const gt = gtUnits.map((u) => normalizeGtUnit(u));
  const predOf = (cls: DetClass): Box[] => dets.filter((d) => d.cls === cls).map((d) => d.box);
  const textBoxesOf = (g: GtUnit): Box[] => (textGt === "lines" ? g.texts : [g.text]);
  const gtBubbles = gt.flatMap((g) => (g.bubble === null ? [] : [g.bubble]));
  const gtTextBubble = gt.filter((g) => g.kind === "bubble").flatMap(textBoxesOf);
  const gtTextFree = gt.filter((g) => g.kind === "free").flatMap(textBoxesOf);
  const predTexts = dets.filter((d) => d.cls !== "bubble").map((d) => d.box);
  const found = gt.filter((g) => coveredFraction(g.texts, predTexts) >= unitContain).length;
  return {
    bubble: classScore(predOf("bubble"), gtBubbles, bubbleIou),
    text_bubble: classScore(predOf("text_bubble"), gtTextBubble, textIou),
    text_free: classScore(predOf("text_free"), gtTextFree, textIou),
    text: classScore(predTexts, [...gtTextBubble, ...gtTextFree], textIou),
    units: { gt: gt.length, found, recall: ratio(found, gt.length) },
  };
}

/**
 * Slice edges that cut through boxes (a good slice plan cuts through none): internal edges of the plan and
 * how many (edge, box) pairs have the edge strictly inside the box along the slicing axis.
 */
export function sliceCutHits(
  plan: SlicePlan,
  boxes: readonly Box[],
): { edges: number; cutEdges: number; hits: number } {
  if (plan.axis === "none") return { edges: 0, cutEdges: 0, hits: 0 };
  const vertical = plan.axis === "vertical";
  const positions: number[] = [];
  plan.slices.forEach((s, i) => {
    if (i > 0) positions.push(vertical ? s.y : s.x);
    if (i < plan.slices.length - 1) positions.push(vertical ? s.y + s.h : s.x + s.w);
  });
  let hits = 0;
  let cutEdges = 0;
  for (const p of positions) {
    const n = boxes.filter((b) => (vertical ? b.y1 < p && p < b.y2 : b.x1 < p && p < b.x2)).length;
    hits += n;
    if (n > 0) cutEdges++;
  }
  return { edges: positions.length, cutEdges, hits };
}

// ---------------------------------------------------------------------------------------------------------------
// LLM output

/** A unit as numbered in one request: label n and its GT source text. */
export interface SentUnit {
  n: number;
  original: string;
  /** GT line type; an "ignore" unit answered with type ignore counts as correctly mapped. */
  type?: string;
}

export interface TextScoreOptions {
  /** Line #n maps correctly when CER(original, GT n) ≤ this ... */
  maxCer?: number;
  /** ... and no other sent unit matches its original strictly better (otherwise it counts as swapped). */
  requireArgmin?: boolean;
  normalize?: NormalizeOptions;
}

export const TEXT_SCORE_DEFAULTS = { maxCer: 0.3, requireArgmin: true } as const;

export interface IdScore {
  n: number;
  /** CER against GT unit n (0 for an ignore/ignore pair). */
  cer: number;
  ok: boolean;
  /** Label of the sent unit whose text matches this line best. */
  bestN: number;
}

export interface TextScores {
  /** Non-empty lines of the reply. */
  lines: number;
  validLines: number;
  /** validLines / lines (0 for an empty reply). */
  formatCompliance: number;
  lang: string | null;
  sent: number;
  /** Valid item ids in order of first appearance (any id, sent or not). */
  returnedIds: number[];
  idCoverage: number;
  missingIds: number[];
  extraIds: number[];
  duplicateIds: number[];
  /** Sent ids that came back and were judged. */
  mapped: number;
  mappedOk: number;
  mappingAccuracy: number;
  swappedIds: number[];
  /** Mean CER over judged lines, ignore/ignore pairs excluded (0 when none). */
  meanCer: number;
  perId: IdScore[];
}

/**
 * Scores one model reply for one request: format compliance (strict contract, output-format.ts), id coverage with
 * missing, extra and duplicate ids (first occurrence wins), mapping accuracy (line #n's original against GT unit n
 * by grapheme CER, with the argmin swap check) and mean CER.
 */
export function textScores(
  output: string,
  sent: readonly SentUnit[],
  opts: TextScoreOptions = {},
): TextScores {
  const maxCer = opts.maxCer ?? TEXT_SCORE_DEFAULTS.maxCer;
  const requireArgmin = opts.requireArgmin ?? TEXT_SCORE_DEFAULTS.requireArgmin;
  const norm = opts.normalize ?? {};

  let lines = 0;
  let validLines = 0;
  let lang: string | null = null;
  const firstById = new Map<number, { type: string; original: string }>();
  const returnedIds: number[] = [];
  const duplicateIds: number[] = [];
  for (const line of outputLines(output)) {
    if (line.trim() === "") continue;
    lines++;
    const rec = parseRecordLine(line);
    if (rec === null) continue;
    validLines++;
    if (rec.kind === "lang") lang ??= rec.lang;
    if (rec.kind !== "item") continue;
    if (firstById.has(rec.n)) {
      if (!duplicateIds.includes(rec.n)) duplicateIds.push(rec.n);
      continue;
    }
    firstById.set(rec.n, { type: rec.type, original: rec.original });
    returnedIds.push(rec.n);
  }

  const sentById = new Map(sent.map((s) => [s.n, s]));
  const perId: IdScore[] = [];
  const swappedIds: number[] = [];
  let cerSum = 0;
  let cerCount = 0;
  for (const n of returnedIds) {
    const gt = sentById.get(n);
    const rec = firstById.get(n);
    if (gt === undefined || rec === undefined) continue;
    if (gt.type === "ignore" && rec.type === "ignore") {
      perId.push({ n, cer: 0, ok: true, bestN: n });
      continue;
    }
    const own = cer(rec.original, gt.original, norm);
    let bestN = n;
    let bestCer = own;
    for (const other of sent) {
      if (other.n === n) continue;
      const c = cer(rec.original, other.original, norm);
      if (c < bestCer) {
        bestCer = c;
        bestN = other.n;
      }
    }
    const ok = own <= maxCer && (!requireArgmin || bestN === n);
    if (!ok && bestN !== n && bestCer <= maxCer) swappedIds.push(n);
    perId.push({ n, cer: own, ok, bestN });
    cerSum += own;
    cerCount++;
  }

  const mapped = perId.length;
  const mappedOk = perId.filter((p) => p.ok).length;
  const missingIds = sent.map((s) => s.n).filter((n) => !firstById.has(n));
  return {
    lines,
    validLines,
    formatCompliance: ratio(validLines, lines, 0),
    lang,
    sent: sent.length,
    returnedIds,
    idCoverage: ratio(sent.length - missingIds.length, sent.length),
    missingIds,
    extraIds: returnedIds.filter((n) => !sentById.has(n)),
    duplicateIds,
    mapped,
    mappedOk,
    mappingAccuracy: ratio(mappedOk, mapped, sent.length === 0 ? 1 : 0),
    swappedIds,
    meanCer: cerCount > 0 ? cerSum / cerCount : 0,
    perId,
  };
}
