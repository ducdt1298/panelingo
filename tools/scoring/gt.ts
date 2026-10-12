// Ground-truth units for scoring, read from the fixture JSON written by tools/fixtures.
//
// Accepted documents (boxes are {x1,y1,x2,y2} objects or [x1, y1, x2, y2] arrays, natural px):
// - { units: [{ id, kind: "bubble" | "free", bubble: box | null, text: box, texts?: box[], order?, type?,
//     original? | lines? }] }  — the unit schema (text = union of the unit's text boxes);
// - { bubbles: [{ id, box }], texts: [{ id, order?, bubbleId?, type?, text?, lines?, inkBox | box }] }  — the
//   "comic-fixture/1" schema: texts sharing a bubbleId form one bubble unit, texts without a known bubble are free
//   units.

import { unionAll } from "../../src/shared/geometry.ts";
import type { Box } from "../../src/shared/types.ts";
import { toBox } from "./boxes.ts";
import type { BoxLike } from "./boxes.ts";

export interface GtUnitInput {
  id: string | number;
  kind: "bubble" | "free";
  bubble: BoxLike | null;
  /** Union of the unit's text boxes. */
  text: BoxLike;
  texts?: readonly BoxLike[];
  /** Reading order the extension must reproduce. */
  order?: number;
  type?: string;
  /** Source-language text of the whole unit. */
  original?: string;
}

export interface GtUnit {
  id: string | number;
  kind: "bubble" | "free";
  bubble: Box | null;
  text: Box;
  texts: Box[];
  order?: number;
  type?: string;
  original?: string;
}

export function normalizeGtUnit(u: GtUnitInput): GtUnit {
  const text = toBox(u.text);
  const texts = (u.texts ?? []).map((b) => toBox(b));
  const out: GtUnit = {
    id: u.id,
    kind: u.kind,
    bubble: u.bubble === null ? null : toBox(u.bubble),
    text,
    texts: texts.length > 0 ? texts : [text],
  };
  if (u.order !== undefined) out.order = u.order;
  if (u.type !== undefined) out.type = u.type;
  if (u.original !== undefined) out.original = u.original;
  return out;
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

function readBox(v: unknown): Box | null {
  if (Array.isArray(v)) {
    const a = v as unknown[];
    if (a.length < 4 || !a.slice(0, 4).every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    const [x1, y1, x2, y2] = a as [number, number, number, number];
    return { x1, y1, x2, y2 };
  }
  if (isRec(v)) {
    const { x1, y1, x2, y2 } = v;
    if (
      typeof x1 === "number" &&
      typeof y1 === "number" &&
      typeof x2 === "number" &&
      typeof y2 === "number"
    ) {
      return { x1, y1, x2, y2 };
    }
  }
  return null;
}

function readId(v: unknown): string | number | null {
  return typeof v === "string" || typeof v === "number" ? v : null;
}

function readNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function readOriginal(r: Rec, textField: boolean): string | undefined {
  const direct = readStr(r["original"]) ?? (textField ? readStr(r["text"]) : undefined);
  if (direct !== undefined) return direct;
  const lines = asArray(r["lines"]).filter((l): l is string => typeof l === "string");
  return lines.length > 0 ? lines.join(" ") : undefined;
}

/** Sort key for an optional order: units without one go last. */
function orderKey(order: number | undefined): number {
  return order ?? Number.MAX_SAFE_INTEGER;
}

function withOptional(
  unit: GtUnit,
  order: number | undefined,
  type: string | undefined,
  original: string | undefined,
): GtUnit {
  if (order !== undefined) unit.order = order;
  if (type !== undefined) unit.type = type;
  if (original !== undefined) unit.original = original;
  return unit;
}

function unitFromRecord(r: unknown, index: number): GtUnit | null {
  if (!isRec(r)) return null;
  const texts = asArray(r["texts"])
    .map(readBox)
    .filter((b): b is Box => b !== null);
  const text = readBox(r["text"]) ?? unionAll(texts);
  if (text === null) return null;
  const bubble = readBox(r["bubble"]);
  const kind =
    r["kind"] === "bubble" || r["kind"] === "free" ? r["kind"] : bubble === null ? "free" : "bubble";
  const unit: GtUnit = {
    id: readId(r["id"]) ?? index + 1,
    kind,
    bubble,
    text,
    texts: texts.length > 0 ? texts : [text],
  };
  return withOptional(unit, readNum(r["order"]), readStr(r["type"]), readOriginal(r, false));
}

function unitsFromBubblesAndTexts(bubbleList: unknown[], textList: unknown[]): GtUnit[] {
  const bubbles = new Map<string | number, Box>();
  for (const b of bubbleList) {
    if (!isRec(b)) continue;
    const id = readId(b["id"]);
    const box = readBox(b["box"]);
    if (id !== null && box !== null) bubbles.set(id, box);
  }
  interface Entry {
    box: Box;
    order: number | undefined;
    type: string | undefined;
    original: string | undefined;
  }
  const inBubble = new Map<string | number, Entry[]>();
  const units: GtUnit[] = [];
  textList.forEach((t, index) => {
    if (!isRec(t)) return;
    const box = readBox(t["inkBox"]) ?? readBox(t["box"]);
    if (box === null) return;
    const entry: Entry = {
      box,
      order: readNum(t["order"]),
      type: readStr(t["type"]),
      original: readOriginal(t, true),
    };
    const bubbleId = readId(t["bubbleId"]);
    if (bubbleId !== null && bubbles.has(bubbleId)) {
      inBubble.set(bubbleId, [...(inBubble.get(bubbleId) ?? []), entry]);
      return;
    }
    const unit: GtUnit = {
      id: readId(t["id"]) ?? index + 1,
      kind: "free",
      bubble: null,
      text: box,
      texts: [box],
    };
    units.push(withOptional(unit, entry.order, entry.type, entry.original));
  });
  for (const [id, entries] of inBubble) {
    entries.sort((a, b) => orderKey(a.order) - orderKey(b.order));
    const boxes = entries.map((e) => e.box);
    const orders = entries.map((e) => e.order).filter((o): o is number => o !== undefined);
    const originals = entries.map((e) => e.original).filter((s): s is string => s !== undefined);
    const unit: GtUnit = {
      id,
      kind: "bubble",
      bubble: bubbles.get(id) ?? null,
      text: unionAll(boxes) ?? { x1: 0, y1: 0, x2: 0, y2: 0 },
      texts: boxes,
    };
    units.push(
      withOptional(
        unit,
        orders.length > 0 ? Math.min(...orders) : undefined,
        entries[0]?.type,
        originals.length > 0 ? originals.join(" ") : undefined,
      ),
    );
  }
  return units
    .map((u, i) => ({ u, i }))
    .sort((a, b) => orderKey(a.u.order) - orderKey(b.u.order) || a.i - b.i)
    .map(({ u }) => u);
}

/** GT units of one fixture page (see the module comment for the accepted shapes). */
export function parseGtUnits(doc: unknown): GtUnit[] {
  if (!isRec(doc)) throw new TypeError("parseGtUnits: expected a JSON object");
  if (Array.isArray(doc["units"])) {
    return asArray(doc["units"])
      .map((u, i) => unitFromRecord(u, i))
      .filter((u): u is GtUnit => u !== null);
  }
  if (Array.isArray(doc["texts"]))
    return unitsFromBubblesAndTexts(asArray(doc["bubbles"]), asArray(doc["texts"]));
  throw new TypeError("parseGtUnits: the document has neither units[] nor texts[]");
}
