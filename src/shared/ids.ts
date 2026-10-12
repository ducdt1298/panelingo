// Stable identifiers shared by every context. PURE: no platform globals.

import type { Box } from "./types.ts";

/** Grid of unitKeyOf, in natural px. */
export const UNIT_KEY_GRID = 4;
/** Units reserved per image by pagePos: orders 0..999. */
export const PAGE_POS_STRIDE = 1000;
/** Prefix of the unitKey part of a seam unit's store key. */
export const SEAM_KEY_PREFIX = "seam:";
/** Characters of the lower image's contentKey kept in a seam unit key. */
export const SEAM_LOWER_CHARS = 16;

const utf8 = new TextEncoder();

/** Lowercase hex of the bytes (contentKey "s:" + sha256 hex, model sha256 checks, nonces). */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (const byte of view) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** 32-bit FNV-1a over the UTF-8 bytes of `text`, as 8 lowercase hex digits. Fast and stable, not cryptographic. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Stable key of a unit box (use `bubble ?? text`): every coordinate divided by 4 and rounded, joined with ":".
 * Re-running the same detector on the same bytes gives the same key; boxes that move by a pixel usually keep it.
 */
export function unitKeyOf(b: Box): string {
  return [b.x1, b.y1, b.x2, b.y2].map((v) => String(Math.round(v / UNIT_KEY_GRID))).join(":");
}

/** Engine-side frame identity, derived from `port.sender`: `${tabId}:${frameId}:${documentId}`. */
export function frameKeyOf(tabId: number, frameId: number, documentId: string): string {
  return `${tabId}:${frameId}:${documentId}`;
}

/**
 * unitKey part of a seam unit's store key: `'seam:' + first 16 chars of contentKeyLower + ':' + unitKey`.
 * The record lives under the UPPER image (`[contentKeyUpper, seamUnitKey(...)]`, see seamStoreKey), so the upper key
 * is not repeated in the string; a different or reordered lower neighbour gives a different key.
 */
export function seamUnitKey(contentKeyUpper: string, contentKeyLower: string, unitKey: string): string {
  return `${SEAM_KEY_PREFIX}${contentKeyLower.slice(0, SEAM_LOWER_CHARS)}:${unitKey}`;
}

/** Full store key `[contentKeyUpper, seamUnitKey]` of a unit that crosses the edge between two touching images. */
export function seamStoreKey(
  contentKeyUpper: string,
  contentKeyLower: string,
  unitKey: string,
): [string, string] {
  return [contentKeyUpper, seamUnitKey(contentKeyUpper, contentKeyLower, unitKey)];
}

export function isSeamUnitKey(key: string): boolean {
  return key.startsWith(SEAM_KEY_PREFIX);
}

/**
 * Global page-order key: `docOrder * 1000 + order`. `order` is clamped to 0..999 so an image with more units
 * never overlaps the next image (the extra units then tie, and stable sorts keep their relative order).
 */
export function pagePos(docOrder: number, order: number): number {
  return docOrder * PAGE_POS_STRIDE + Math.min(Math.max(order, 0), PAGE_POS_STRIDE - 1);
}

let reqSeq = 0;

/** Port request id (`ReqId`) `${ctx}-${seq}-${rand}`; `random` is injectable for tests. */
export function newReqId(ctx: string, random: () => number = () => Math.random()): string {
  reqSeq = reqSeq >= Number.MAX_SAFE_INTEGER ? 1 : reqSeq + 1;
  const rand = Math.floor(random() * 0x100000000)
    .toString(36)
    .padStart(7, "0");
  return `${ctx}-${reqSeq.toString(36)}-${rand}`;
}
