// Image file headers without decoding. PURE.
// sniffImageFormat reads the magic bytes (the acquirer never trusts Content-Type alone), couldBeImage rejects a
// download early from its first bytes, and readImageSize gives the pixel count BEFORE createImageBitmap allocates.

import type { Size } from "../types.ts";

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "avif" | "bmp";

export const FORMAT_MIME: Readonly<Record<ImageFormat, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** Enough bytes for couldBeImage(); a full AVIF brand list may need more (sniffImageFormat on the whole file). */
export const SNIFF_PREFIX_BYTES = 64;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** BITMAPCOREHEADER, OS/2 v2 (16/64) and BITMAPINFOHEADER..V5 sizes. */
const BMP_DIB_SIZES: ReadonlySet<number> = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

function ascii(b: Uint8Array, at: number, length: number): string {
  if (at < 0 || at + length > b.length) return "";
  let text = "";
  for (let i = at; i < at + length; i += 1) text += String.fromCharCode(b[i] ?? 0);
  return text;
}

function viewOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function isAvif(b: Uint8Array, view: DataView): boolean {
  if (b.length < 16 || ascii(b, 4, 4) !== "ftyp") return false;
  const boxEnd = Math.min(view.getUint32(0, false), b.length);
  // major brand at 8, minor version at 12, compatible brands from 16
  for (let at = 8; at + 4 <= boxEnd; at += at === 8 ? 8 : 4) {
    const brand = ascii(b, at, 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

function isBmp(b: Uint8Array, view: DataView): boolean {
  return b.length >= 26 && ascii(b, 0, 2) === "BM" && BMP_DIB_SIZES.has(view.getUint32(14, true));
}

/** Format from magic bytes: JPEG, PNG, GIF, WebP, AVIF (ftyp brand avif/avis) or BMP; null otherwise. */
export function sniffImageFormat(b: Uint8Array): ImageFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && PNG_SIGNATURE.every((value, i) => b[i] === value)) return "png";
  const gif = ascii(b, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  const view = viewOf(b);
  if (isAvif(b, view)) return "avif";
  if (isBmp(b, view)) return "bmp";
  return null;
}

/**
 * Early check on the first SNIFF_PREFIX_BYTES of a download: false only when no supported format can start this way
 * (an ISO-BMFF "ftyp" box is accepted until its brands are known).
 */
export function couldBeImage(prefix: Uint8Array): boolean {
  return sniffImageFormat(prefix) !== null || ascii(prefix, 4, 4) === "ftyp";
}

function sized(w: number, h: number): Size | null {
  return w > 0 && h > 0 ? { w, h } : null;
}

function jpegSize(b: Uint8Array, view: DataView): Size | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI or start of scan before any frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    const length = view.getUint16(i + 2, false);
    if (length < 2) return null;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (i + 9 > b.length) return null;
      return sized(view.getUint16(i + 7, false), view.getUint16(i + 5, false));
    }
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array, view: DataView): Size | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }
  if (chunk === "VP8L" && b.length >= 25) {
    if (b[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X" && b.length >= 30) {
    const w = 1 + (view.getUint16(24, true) | ((b[26] ?? 0) << 16));
    const h = 1 + (view.getUint16(27, true) | ((b[29] ?? 0) << 16));
    return sized(w, h);
  }
  return null;
}

interface BoxSpan {
  type: string;
  start: number;
  end: number;
}

function boxesIn(b: Uint8Array, view: DataView, start: number, end: number): BoxSpan[] {
  const out: BoxSpan[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at, false);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(view.getBigUint64(at + 8, false));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    out.push({ type: ascii(b, at + 4, 4), start: at + header, end: at + size });
    at += size;
  }
  return out;
}

/** AVIF: the largest `ispe` property in meta/iprp/ipco (thumbnails and alpha planes are not larger). */
function avifSize(b: Uint8Array, view: DataView): Size | null {
  let best: Size | null = null;
  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 4) return;
    for (const box of boxesIn(b, view, start, end)) {
      if (box.type === "meta")
        walk(box.start + 4, box.end, depth + 1); // FullBox: version + flags
      else if (box.type === "iprp" || box.type === "ipco") walk(box.start, box.end, depth + 1);
      else if (box.type === "ispe" && box.start + 12 <= box.end) {
        const size = sized(view.getUint32(box.start + 4, false), view.getUint32(box.start + 8, false));
        if (size !== null && (best === null || size.w * size.h > best.w * best.h)) best = size;
      }
    }
  };
  walk(0, b.length, 0);
  return best;
}

function bmpSize(view: DataView): Size | null {
  if (view.getUint32(14, true) === 12) return sized(view.getUint16(18, true), view.getUint16(20, true));
  return sized(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
}

/**
 * Pixel size from the file header without decoding, or null when the header is unknown or truncated. JPEG EXIF
 * rotation is ignored: the pixel count is the same, and createImageBitmap applies the orientation.
 */
export function readImageSize(b: Uint8Array): Size | null {
  const view = viewOf(b);
  switch (sniffImageFormat(b)) {
    case "png":
      return b.length >= 24 && ascii(b, 12, 4) === "IHDR"
        ? sized(view.getUint32(16, false), view.getUint32(20, false))
        : null;
    case "jpeg":
      return jpegSize(b, view);
    case "gif":
      return b.length >= 10 ? sized(view.getUint16(6, true), view.getUint16(8, true)) : null;
    case "webp":
      return webpSize(b, view);
    case "avif":
      return avifSize(b, view);
    case "bmp":
      return bmpSize(view);
    case null:
      return null;
  }
}
