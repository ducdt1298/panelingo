// Header-only image size sniffing for the fixture server (PNG, JPEG incl. EXIF orientation, GIF, WebP, AVIF).
// Pages carry width/height attributes so lazy strips have their real height before the bytes arrive.

export type ImageType = "png" | "jpeg" | "gif" | "webp" | "avif";

export interface ImageSize {
  w: number;
  h: number;
  type: ImageType;
}

/** Bytes worth reading before sniffing; JPEG callers retry with the whole file when the SOF marker lies further in. */
export const SNIFF_BYTES = 256 * 1024;

export function sniffImageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes)) {
    return sized(
      view.byteLength >= 24 ? u32be(view, 16) : 0,
      view.byteLength >= 24 ? u32be(view, 20) : 0,
      "png",
    );
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(view);
  }
  if (ascii(bytes, 0, 4) === "GIF8" && view.byteLength >= 10) {
    return sized(view.getUint16(6, true), view.getUint16(8, true), "gif");
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return webpSize(bytes, view);
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    return avifSize(bytes, view);
  }
  return null;
}

function sized(w: number, h: number, type: ImageType): ImageSize | null {
  return w > 0 && h > 0 ? { w, h, type } : null;
}

function isPng(b: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return sig.every((v, i) => b[i] === v) && ascii(b, 12, 4) === "IHDR";
}

function ascii(b: Uint8Array, at: number, len: number): string {
  if (at + len > b.length) {
    return "";
  }
  let s = "";
  for (let i = at; i < at + len; i++) {
    s += String.fromCharCode(b[i] ?? 0);
  }
  return s;
}

function u32be(v: DataView, at: number): number {
  return v.getUint32(at, false);
}

function jpegSize(v: DataView): ImageSize | null {
  let orientation = 1;
  let i = 2;
  while (i + 4 <= v.byteLength) {
    if (v.getUint8(i) !== 0xff) {
      return null;
    }
    const marker = v.getUint8(i + 1);
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2; // standalone marker without a length field
      continue;
    }
    const len = v.getUint16(i + 2, false);
    if (len < 2) {
      return null;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > v.byteLength) {
        return null;
      }
      const h = v.getUint16(i + 5, false);
      const w = v.getUint16(i + 7, false);
      // EXIF orientations 5..8 rotate by 90 degrees, and browsers apply them (image-orientation: from-image).
      return orientation >= 5 && orientation <= 8 ? sized(h, w, "jpeg") : sized(w, h, "jpeg");
    }
    if (marker === 0xda) {
      return null; // start of scan before any SOF
    }
    if (marker === 0xe1) {
      orientation = exifOrientation(v, i + 4, len - 2) ?? orientation;
    }
    i += 2 + len;
  }
  return null;
}

function exifOrientation(v: DataView, start: number, len: number): number | null {
  const end = Math.min(v.byteLength, start + len);
  if (start + 14 > end) {
    return null;
  }
  // "Exif\0\0" then a TIFF header.
  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  if (!exif.every((b, k) => v.getUint8(start + k) === b)) {
    return null;
  }
  const tiff = start + 6;
  const order = v.getUint16(tiff, false);
  if (order !== 0x4949 && order !== 0x4d4d) {
    return null;
  }
  const le = order === 0x4949;
  const ifd = tiff + v.getUint32(tiff + 4, le);
  if (ifd + 2 > end) {
    return null;
  }
  const count = v.getUint16(ifd, le);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) {
      return null;
    }
    if (v.getUint16(entry, le) === 0x0112) {
      return v.getUint16(entry + 8, le);
    }
  }
  return null;
}

function webpSize(b: Uint8Array, v: DataView): ImageSize | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && v.byteLength >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      return null;
    }
    return sized(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff, "webp");
  }
  if (chunk === "VP8L" && v.byteLength >= 25) {
    if (b[20] !== 0x2f) {
      return null;
    }
    const bits = v.getUint32(21, true);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, "webp");
  }
  if (chunk === "VP8X" && v.byteLength >= 30) {
    const w = 1 + (v.getUint16(24, true) | (v.getUint8(26) << 16));
    const h = 1 + (v.getUint16(27, true) | (v.getUint8(29) << 16));
    return sized(w, h, "webp");
  }
  return null;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function boxes(b: Uint8Array, v: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = v.getUint32(at, false);
    const type = ascii(b, at + 4, 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) {
        break;
      }
      size = Number(v.getBigUint64(at + 8, false));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) {
      break;
    }
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

/** AVIF/HEIF: the largest `ispe` (image spatial extents) property in meta/iprp/ipco is the primary image size. */
function avifSize(b: Uint8Array, v: DataView): ImageSize | null {
  const ftyp = boxes(b, v, 0, v.byteLength).find((x) => x.type === "ftyp");
  if (ftyp === undefined) {
    return null;
  }
  const brands: string[] = [];
  for (let at = ftyp.start; at + 4 <= ftyp.end; at += 4) {
    if (at !== ftyp.start + 4) {
      brands.push(ascii(b, at, 4)); // skip minor_version
    }
  }
  if (!brands.includes("avif") && !brands.includes("avis")) {
    return null;
  }
  let best: ImageSize | null = null;
  const walk = (start: number, end: number): void => {
    for (const box of boxes(b, v, start, end)) {
      if (box.type === "meta") {
        walk(box.start + 4, box.end); // FullBox: skip version and flags
      } else if (box.type === "iprp" || box.type === "ipco") {
        walk(box.start, box.end);
      } else if (box.type === "ispe" && box.start + 12 <= box.end) {
        const w = v.getUint32(box.start + 4, false);
        const h = v.getUint32(box.start + 8, false);
        if (best === null || w * h > best.w * best.h) {
          best = sized(w, h, "avif") ?? best;
        }
      }
    }
  };
  walk(0, v.byteLength);
  return best;
}
