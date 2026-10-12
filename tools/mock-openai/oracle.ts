// Oracle mode: a mock cannot read the composite image, so test builds of the extension send the header
// `x-ctv-test-units` = base64(UTF-8 JSON [{n, src, box}]) describing which unit each number marks. The mock maps
// every box to a ground-truth unit of `<gtDir>/<src>.gt.json` (IoU ≥ 0.5 against its text box, else its bubble box)
// and answers with that unit's type, speaker and original text. Real providers ignore the header.
// The translation is `VI:<reference Vietnamese>` by default; the scenario's `oracleLang` picks a per-language
// reference (`refs.<lang>` in the ground truth) instead, answered verbatim, e.g. for screenshots in English.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { clip, iou, unionAll } from "../../src/shared/geometry.ts";
import type { Box, LineType, Size } from "../../src/shared/types.ts";
import type { OracleViStyle } from "./scenarios.ts";
import { prop } from "./wire.ts";

export const TEST_UNITS_HEADER = "x-ctv-test-units";
export const ORACLE_IOU_MIN = 0.5;

/** One numbered region of a composite: its number, its source image and its box in that image's natural px. */
export interface TestUnit {
  n: number;
  /**
   * Image path relative to gtDir, with or without extension, or the image URL: its path is used, and leading folders
   * that gtDir does not have (a server route such as `/img/`) are skipped. See groundTruthCandidates.
   */
  src: string;
  box: Box;
}

export interface GtUnit {
  id: string;
  type: LineType;
  speaker: string;
  original: string;
  /** Text box (union of the unit's text boxes). */
  text: Box;
  bubble: Box | null;
  /** Tokens the translation must keep (numbers, names). */
  canaries: string[];
  /** Reference translation (`vi` or `translation`), when the ground truth has one. */
  vi: string | null;
  /** Reference translations by lower-case language code (`refs: {"en": "…"}`), used when `oracleLang` asks. */
  refs: Readonly<Record<string, string>>;
}

export interface GtPage {
  file: string;
  lang: string | null;
  /** Image size in natural px when the ground truth states it (tools/fixtures writes `width`/`height`). */
  size: Size | null;
  units: GtUnit[];
}

export interface OracleReport {
  gtDir: string | null;
  matched: Array<{ n: number; gtId: string; by: "text" | "bubble"; iou: number }>;
  /** Numbers answered `#n|ignore|||` (no ground-truth unit at IoU ≥ 0.5, or no ground truth). */
  unmatched: number[];
  /** `src` values without a ground-truth file. */
  missingGt: string[];
  errors: string[];
  lang: string | null;
}

/** Header value for a list of units (what the engine's test hook sends). */
export function encodeTestUnits(units: readonly TestUnit[]): string {
  return Buffer.from(JSON.stringify(units), "utf8").toString("base64");
}

/** Accepts `{x1,y1,x2,y2}` or `[x1,y1,x2,y2]`. */
export function toBox(value: unknown): Box | null {
  const nums = Array.isArray(value)
    ? (value as unknown[])
    : [prop(value, "x1"), prop(value, "y1"), prop(value, "x2"), prop(value, "y2")];
  if (nums.length !== 4 || !nums.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return null;
  }
  const [x1, y1, x2, y2] = nums as [number, number, number, number];
  return { x1, y1, x2, y2 };
}

export function decodeTestUnits(value: string): TestUnit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8"));
  } catch {
    throw new Error(`${TEST_UNITS_HEADER} is not base64-encoded JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${TEST_UNITS_HEADER} must hold a JSON array`);
  }
  return (parsed as unknown[]).map((item, index) => {
    const n = prop(item, "n");
    const src = prop(item, "src");
    const box = toBox(prop(item, "box"));
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new Error(`${TEST_UNITS_HEADER}[${index}].n must be a non-negative integer`);
    }
    if (typeof src !== "string") {
      throw new Error(`${TEST_UNITS_HEADER}[${index}].src must be a string`);
    }
    if (box === null) {
      throw new Error(`${TEST_UNITS_HEADER}[${index}].box must be {x1,y1,x2,y2} or [x1,y1,x2,y2]`);
    }
    return { n, src, box };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Ground truth

const LINE_TYPES = new Set<string>(["dialogue", "thought", "narration", "sign", "sfx", "ignore"]);

interface Entry {
  id: string;
  order: number;
  type: LineType;
  speaker: string;
  original: string;
  text: Box;
  bubble: Box | null;
  bubbleKey: string | null;
  canaries: string[];
  vi: string | null;
  refs: Record<string, string>;
}

/** `refs: {"<lang>": "<reference translation>"}`: string values only, keys trimmed and lower-cased. */
function readRefs(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return out;
  }
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    const lang = key.trim().toLowerCase();
    if (lang !== "" && typeof text === "string" && text.trim() !== "") {
      out[lang] = text;
    }
  }
  return out;
}

function firstBox(item: unknown, keys: readonly string[]): Box | null {
  for (const key of keys) {
    const box = toBox(prop(item, key));
    if (box !== null) {
      return box;
    }
  }
  return null;
}

function firstString(item: unknown, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = prop(item, key);
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function readEntry(item: unknown, index: number, bubbles: ReadonlyMap<string, Box>): Entry | null {
  const text = firstBox(item, ["textBox", "text_box", "inkBox", "ink_box", "text", "box", "bbox"]);
  if (text === null) {
    return null;
  }
  const bubbleId = prop(item, "bubbleId") ?? prop(item, "bubble_id");
  const bubbleKey =
    typeof bubbleId === "string" || typeof bubbleId === "number"
      ? String(bubbleId)
      : bubbleId === null || bubbleId === undefined
        ? null
        : JSON.stringify(bubbleId);
  const lines = prop(item, "lines");
  const joinedLines = Array.isArray(lines)
    ? (lines as unknown[]).filter((l): l is string => typeof l === "string").join(" ")
    : null;
  const type = prop(item, "type");
  // `canaries: string[]` (comic-fixture/1) or the generator's `canary: string | null`.
  const canaryList = prop(item, "canaries");
  const canary = prop(item, "canary");
  const canaries = [
    ...(Array.isArray(canaryList) ? (canaryList as unknown[]) : []),
    ...(typeof canary === "string" ? [canary] : []),
  ].filter((c): c is string => typeof c === "string" && c !== "");
  const order = prop(item, "order");
  const id = prop(item, "id");
  return {
    id: typeof id === "string" || typeof id === "number" ? String(id) : String(index + 1),
    order: typeof order === "number" && Number.isFinite(order) ? order : index + 1,
    type: typeof type === "string" && LINE_TYPES.has(type) ? (type as LineType) : "dialogue",
    speaker: firstString(item, ["speaker"]) ?? "",
    original: firstString(item, ["original", "orig", "text", "source"]) ?? joinedLines ?? "",
    text,
    bubble:
      firstBox(item, ["bubbleBox", "bubble_box", "bubble"]) ??
      (bubbleKey !== null ? (bubbles.get(bubbleKey) ?? null) : null),
    bubbleKey,
    canaries,
    vi: firstString(item, ["vi", "translation", "viRef", "expectedVi"]),
    refs: readRefs(prop(item, "refs")),
  };
}

function mergeEntries(group: readonly Entry[]): GtUnit {
  const first = group[0];
  if (first === undefined) {
    throw new Error("empty ground-truth group");
  }
  const vis = group.map((e) => e.vi).filter((v): v is string => v !== null && v !== "");
  const refs: Record<string, string> = {};
  for (const lang of new Set(group.flatMap((e) => Object.keys(e.refs)))) {
    refs[lang] = group
      .map((e) => e.refs[lang])
      .filter((t): t is string => t !== undefined)
      .join(" ");
  }
  return {
    id: first.id,
    type: first.type,
    speaker: group.find((e) => e.speaker !== "")?.speaker ?? "",
    original: group
      .map((e) => e.original)
      .filter((o) => o !== "")
      .join(" "),
    text: unionAll(group.map((e) => e.text)) ?? first.text,
    bubble: first.bubble,
    canaries: [...new Set(group.flatMap((e) => e.canaries))],
    vi: vis.length > 0 ? vis.join(" ") : null,
    refs,
  };
}

/**
 * Normalize a ground-truth document. Two shapes are read:
 * - `units: [{id, type, speaker, original|text, textBox|text, bubbleBox|bubble|bubbleId, canaries?|canary?, vi?|translation?}]`:
 *   one entry per translation unit (the `<stem>.gt.json` that tools/fixtures/make_fixtures.py writes); an optional
 *   `refs: {"<lang>": "<reference translation>"}` adds references in other languages (see oracleTranslation);
 * - the `comic-fixture/1` schema: `bubbles: [{id, box}]` and
 *   `texts: [{id, order, bubbleId, type, speaker, text, inkBox, canaries}]`; texts sharing a bubble form one unit,
 *   as the engine groups them.
 * Boxes may be `[x1,y1,x2,y2]` or `{x1,y1,x2,y2}`. A top-level `width`/`height` gives the image size.
 */
export function normalizeGroundTruth(raw: unknown, file = "<memory>"): GtPage {
  const bubbles = new Map<string, Box>();
  const rawBubbles = prop(raw, "bubbles");
  for (const bubble of Array.isArray(rawBubbles) ? (rawBubbles as unknown[]) : []) {
    const id = prop(bubble, "id");
    const box = firstBox(bubble, ["box", "bbox"]);
    if ((typeof id === "string" || typeof id === "number") && box !== null) {
      bubbles.set(String(id), box);
    }
  }
  const rawUnits = prop(raw, "units");
  const rawTexts = prop(raw, "texts");
  const explicitUnits = Array.isArray(rawUnits);
  const list = explicitUnits
    ? (rawUnits as unknown[])
    : Array.isArray(rawTexts)
      ? (rawTexts as unknown[])
      : [];
  const entries = list
    .map((item, index) => readEntry(item, index, bubbles))
    .filter((e): e is Entry => e !== null)
    .sort((a, b) => a.order - b.order);

  const groups: Entry[][] = [];
  const byBubble = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!explicitUnits && entry.bubbleKey !== null) {
      const group = byBubble.get(entry.bubbleKey);
      if (group !== undefined) {
        group.push(entry);
        continue;
      }
      const created = [entry];
      byBubble.set(entry.bubbleKey, created);
      groups.push(created);
      continue;
    }
    groups.push([entry]);
  }
  const lang = prop(raw, "lang");
  const w = prop(raw, "width");
  const h = prop(raw, "height");
  const size =
    typeof w === "number" &&
    typeof h === "number" &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0
      ? { w, h }
      : null;
  return {
    file,
    lang: typeof lang === "string" && lang ? lang : null,
    size,
    units: groups.map(mergeEntries),
  };
}

/** JSON.parse that accepts a leading UTF-8 BOM (Windows PowerShell 5.1 writes one with `-Encoding utf8`). */
export function parseJsonFile(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

function looksLikeGroundTruth(raw: unknown): boolean {
  return Array.isArray(prop(raw, "units")) || Array.isArray(prop(raw, "texts"));
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Paths tried for `src` (relative to gtDir, before the `.gt.json`/`.json` suffix), most specific first: the whole
 * path, then the same path without each leading folder, each with and without its extension. A fixture-server URL
 * such as `http://localhost:8081/img/chapter-ko-60/001.jpg` thus reaches `chapter-ko-60/001.gt.json` whatever the
 * route prefix (`/img/`, `/protected/`, `/protected-cookie/`…).
 */
export function groundTruthCandidates(src: string): string[] {
  let path = src.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      // keep the raw string
    }
  }
  path = (path.split(/[?#]/)[0] ?? "").replace(/\\/g, "/");
  const stripExt = (p: string): string => {
    const ext = posix.extname(p);
    return ext ? p.slice(0, -ext.length) : p;
  };
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const rel = segments.slice(i).join("/");
    out.push(rel, stripExt(rel));
  }
  return [...new Set(out.filter((p) => p !== ""))];
}

/** Loads `<dir>/<src>.gt.json` (or a `<src>.json` in the fixture schema), cached by mtime. */
export class GroundTruthStore {
  readonly dir: string;
  readonly #cache = new Map<string, { mtimeMs: number; page: GtPage }>();

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  clear(): void {
    this.#cache.clear();
  }

  /** The page for `src`, or null when no file matches. Throws on unreadable or invalid JSON. */
  async load(src: string): Promise<GtPage | null> {
    for (const candidate of groundTruthCandidates(src)) {
      for (const suffix of [".gt.json", ".json"]) {
        const file = resolve(this.dir, candidate + suffix);
        if (!isInside(this.dir, file)) {
          continue;
        }
        let mtimeMs: number;
        try {
          const info = await stat(file);
          if (!info.isFile()) {
            continue;
          }
          mtimeMs = info.mtimeMs;
        } catch {
          continue;
        }
        const cached = this.#cache.get(file);
        if (cached !== undefined && cached.mtimeMs === mtimeMs) {
          return cached.page;
        }
        let raw: unknown;
        try {
          raw = parseJsonFile(await readFile(file, "utf8"));
        } catch (error) {
          if (suffix === ".json") {
            continue; // any other JSON file: not ground truth
          }
          throw error;
        }
        if (suffix === ".json" && !looksLikeGroundTruth(raw)) {
          continue;
        }
        const page = normalizeGroundTruth(raw, file);
        this.#cache.set(file, { mtimeMs, page });
        return page;
      }
    }
    return null;
  }
}

/** Best ground-truth unit for a box: IoU ≥ 0.5 with its text box, otherwise with its bubble box. */
export function matchGtUnit(
  box: Box,
  units: readonly GtUnit[],
  threshold = ORACLE_IOU_MIN,
): { unit: GtUnit; by: "text" | "bubble"; iou: number } | null {
  for (const by of ["text", "bubble"] as const) {
    let best: GtUnit | null = null;
    let bestIou = 0;
    for (const unit of units) {
      const target = by === "text" ? unit.text : unit.bubble;
      if (target === null) {
        continue;
      }
      const value = iou(box, target);
      if (value > bestIou) {
        best = unit;
        bestIou = value;
      }
    }
    if (best !== null && bestIou >= threshold) {
      return { unit: best, by, iou: bestIou };
    }
  }
  return null;
}

const NON_LATIN_LETTERS = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Oracle translation. "echo" is `VI:<original>` verbatim. "safe" (default) keeps that for Latin originals but uses
 * `VI:câu <gt id>` (+ canaries) when the original has Hangul/Han/Kana, because the engine rejects translations
 * whose letters are > 20 % non-Latin and would otherwise re-ask every ko/ja/zh unit.
 * A reference translation in the ground truth always wins.
 */
export function oracleVi(unit: GtUnit, style: OracleViStyle = "safe"): string {
  if (unit.vi !== null && unit.vi !== "") {
    return `VI:${unit.vi}`;
  }
  if (style === "echo" || !NON_LATIN_LETTERS.test(unit.original)) {
    return `VI:${unit.original}`;
  }
  return `VI:câu ${unit.id}${unit.canaries.length > 0 ? ` (${unit.canaries.join(", ")})` : ""}`;
}

/**
 * The translation field: with `refLang`, the unit's reference in that language (`refs.<refLang>`) verbatim, as a
 * real model would answer into that language; otherwise, or when the unit has none, oracleVi.
 */
export function oracleTranslation(
  unit: GtUnit,
  style: OracleViStyle = "safe",
  refLang: string | null = null,
): string {
  const ref = refLang === null ? undefined : unit.refs[refLang.trim().toLowerCase()];
  return ref !== undefined && ref.trim() !== "" ? ref : oracleVi(unit, style);
}

/** A protocol field on one line, without the `|` separator. */
function field(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replaceAll("|", "/")
    .trim();
}

/** `#n|<type>|<speaker>|<original>|<translation>`, or `#n|ignore|||` for no match and for ignore units. */
export function oracleLine(
  n: number,
  unit: GtUnit | null,
  style: OracleViStyle = "safe",
  refLang: string | null = null,
): string {
  if (unit === null || unit.type === "ignore") {
    return `#${n}|ignore|||`;
  }
  const translation = oracleTranslation(unit, style, refLang);
  return `#${n}|${unit.type}|${field(unit.speaker)}|${field(unit.original)}|${field(translation)}`;
}

/**
 * Lines for every distinct `n` (first occurrence wins), ids in increasing order. Units whose image has no ground
 * truth, or whose box matches nothing, get `#n|ignore|||`. Without a store no line is produced (the caller falls
 * back to placeholders) and the report says why.
 */
export async function answerFromGroundTruth(
  units: readonly TestUnit[],
  store: GroundTruthStore | null,
  style: OracleViStyle,
  refLang: string | null = null,
): Promise<{ ids: number[]; lines: Map<number, string>; report: OracleReport }> {
  const report: OracleReport = {
    gtDir: store?.dir ?? null,
    matched: [],
    unmatched: [],
    missingGt: [],
    errors: [],
    lang: null,
  };
  const lines = new Map<number, string>();
  const ids: number[] = [];
  const seen = new Set<number>();
  const pages = new Map<string, GtPage | null>();
  if (store === null) {
    report.errors.push("gtDir is not configured: answering with placeholders");
  }
  for (const unit of units) {
    if (seen.has(unit.n)) {
      continue;
    }
    seen.add(unit.n);
    ids.push(unit.n);
    if (store === null) {
      continue;
    }
    let page = pages.get(unit.src);
    if (page === undefined) {
      try {
        page = await store.load(unit.src);
        if (page === null) {
          report.missingGt.push(unit.src);
        }
      } catch (error) {
        report.errors.push(`${unit.src}: ${error instanceof Error ? error.message : String(error)}`);
        page = null;
      }
      pages.set(unit.src, page);
    }
    // A seam unit's box extends past the image edge; the ground truth of each image holds only its
    // visible part, so compare what lies inside the image.
    const match =
      page === null
        ? null
        : matchGtUnit(page.size !== null ? clip(unit.box, page.size) : unit.box, page.units);
    if (page !== null && report.lang === null) {
      report.lang = page.lang;
    }
    if (match === null) {
      lines.set(unit.n, oracleLine(unit.n, null, style, refLang));
      report.unmatched.push(unit.n);
      continue;
    }
    lines.set(unit.n, oracleLine(unit.n, match.unit, style, refLang));
    report.matched.push({
      n: unit.n,
      gtId: match.unit.id,
      by: match.by,
      iou: Math.round(match.iou * 1000) / 1000,
    });
  }
  ids.sort((a, b) => a - b);
  return { ids, lines, report };
}
