import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { AcquiredImage, CoreDeps, ServiceFactories } from "../../../src/engine/contracts.ts";
import { BITMAP_OPTIONS, createDecoder, type DecoderOverrides } from "../../../src/engine/decode.ts";
import { silentLogger } from "../../../src/platform/log.ts";
import {
  FORMAT_MIME,
  couldBeImage,
  readImageSize,
  sniffImageFormat,
  type ImageFormat,
} from "../../../src/shared/core/image-header.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import { DEFAULT_SETTINGS, type Settings, type SiteSettings } from "../../../src/shared/settings.ts";

const ROOT = new URL("../../../", import.meta.url);
const CANARY = new URL("assets/canary/canary-01.png", ROOT);
const GENERATED = new URL("test/fixtures/generated/", ROOT);
const NO_FIXTURES = existsSync(GENERATED) ? false : "test/fixtures/generated is missing (npm run fixtures)";

/* ------------------------------------------------------------------ byte builders */

function bytes(...parts: Array<number[] | string | Uint8Array>): Uint8Array<ArrayBuffer> {
  const arrays = parts.map((part) =>
    typeof part === "string" ? Uint8Array.from(part, (c) => c.charCodeAt(0)) : Uint8Array.from(part),
  );
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

const u16be = (v: number): number[] => [(v >> 8) & 255, v & 255];
const u16le = (v: number): number[] => [v & 255, (v >> 8) & 255];
const u24le = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const u32be = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u32le = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

function png(w: number, h: number): Uint8Array<ArrayBuffer> {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    "IHDR",
    u32be(w),
    u32be(h),
    [8, 6, 0, 0, 0, 0, 0, 0, 0],
  );
}

function webp(chunk: string, payload: number[]): Uint8Array<ArrayBuffer> {
  return bytes("RIFF", u32le(payload.length + 12), "WEBP", chunk, u32le(payload.length), payload);
}

const vp8 = (w: number, h: number): Uint8Array<ArrayBuffer> =>
  webp("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h), 0, 0]);
const vp8l = (w: number, h: number): Uint8Array<ArrayBuffer> =>
  webp("VP8L", [0x2f, ...u32le(((w - 1) | ((h - 1) << 14)) >>> 0), 0]);
const vp8x = (w: number, h: number): Uint8Array<ArrayBuffer> =>
  webp("VP8X", [0x10, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);

function bmp(w: number, h: number, dibSize: number): Uint8Array<ArrayBuffer> {
  const dims = dibSize === 12 ? [...u16le(w), ...u16le(h)] : [...u32le(w), ...u32le(h >>> 0)];
  return bytes("BM", u32le(1000), [0, 0, 0, 0], u32le(54), u32le(dibSize), dims, new Uint8Array(32));
}

function jpeg(w: number, h: number, sof = 0xc0, extra: number[] = []): Uint8Array<ArrayBuffer> {
  const app0 = [
    0xff,
    0xe0,
    ...u16be(16),
    ...Array.from("JFIF\0", (c) => c.charCodeAt(0)),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ];
  const dqt = [0xff, 0xdb, ...u16be(4), 0, 0];
  const frame = [0xff, sof, ...u16be(11), 8, ...u16be(h), ...u16be(w), 1, 1, 0x11, 0];
  return bytes([0xff, 0xd8], app0, extra, dqt, frame, [0xff, 0xda, 0, 2]);
}

function box(type: string, ...payload: Array<number[] | Uint8Array>): Uint8Array<ArrayBuffer> {
  const body = bytes(...payload);
  return bytes(u32be(body.length + 8), type, body);
}

function avif(major: string, compatible: string[], sizes: Array<[number, number]>): Uint8Array<ArrayBuffer> {
  const ftyp = box("ftyp", bytes(major, u32be(0), ...compatible));
  const ispes = sizes.map(([w, h]) => box("ispe", [0, 0, 0, 0], u32be(w), u32be(h)));
  const meta = box("meta", [0, 0, 0, 0], box("hdlr", new Uint8Array(24)), box("iprp", box("ipco", ...ispes)));
  return bytes(ftyp, meta, box("mdat", [1, 2, 3]));
}

async function encoded(
  format: "png" | "jpeg" | "webp" | "avif" | "gif",
  w: number,
  h: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#c33";
  ctx.fillRect(1, 1, Math.max(1, w >> 1), Math.max(1, h >> 1));
  switch (format) {
    case "png":
      return Uint8Array.from(await canvas.encode("png"));
    case "avif":
      return Uint8Array.from(await canvas.encode("avif"));
    case "gif":
      return Uint8Array.from(await canvas.encode("gif", 80));
    case "jpeg":
    case "webp":
      return Uint8Array.from(await canvas.encode(format, 80));
  }
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/* ------------------------------------------------------------------ deps */

function settingsSource(): CoreDeps["settings"] {
  return {
    current: (): Settings => DEFAULT_SETTINGS,
    site: (): SiteSettings => ({ ...DEFAULT_SITE_FOR_TESTS }),
    sites: () => ({}),
    apply: () => undefined,
    onChange: () => () => undefined,
  };
}

const DEFAULT_SITE_FOR_TESTS: SiteSettings = {
  enabled: true,
  mode: "auto",
  includeSubdomains: false,
  credentials: "omit",
  referer: "auto",
  sourceLang: "auto",
  layout: "auto",
  extraFrameOrigins: [],
  prefetchAhead: true,
  addedAt: 0,
};

function coreDeps(): CoreDeps {
  return {
    clock: { now: () => 0, setTimer: () => () => undefined },
    log: silentLogger,
    settings: settingsSource(),
  };
}

interface FakeBitmapRecord {
  blobs: Blob[];
  options: ImageBitmapOptions[];
  closed: number;
}

function fakeBitmaps(
  size: { w: number; h: number } | Error,
): DecoderOverrides & { record: FakeBitmapRecord } {
  const record: FakeBitmapRecord = { blobs: [], options: [], closed: 0 };
  return {
    record,
    createImageBitmap: (blob, options) => {
      record.blobs.push(blob);
      record.options.push(options);
      if (size instanceof Error) return Promise.reject(size);
      const bitmap: ImageBitmap = {
        width: size.w,
        height: size.h,
        close: () => {
          record.closed += 1;
        },
      };
      return Promise.resolve(bitmap);
    },
  };
}

function acquired(data: Uint8Array<ArrayBuffer>, mime = "image/png"): AcquiredImage {
  return { bytes: data.slice().buffer, mime, source: "url", lowRes: false, url: "https://cdn.example.com/x" };
}

const LIMITS = { maxImageBytes: 32 * 1024 * 1024, maxImagePixels: 64_000_000 };

async function rejectsWith(promise: Promise<unknown>, code: string, detail?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CtvError, `expected CtvError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (detail !== undefined) assert.equal(error.detail, detail);
    return true;
  });
}

/* ------------------------------------------------------------------ tests */

test("createDecoder fits ServiceFactories", () => {
  const factory: ServiceFactories["createDecoder"] = createDecoder;
  assert.equal(typeof factory(coreDeps()).decode, "function");
});

describe("sniffing and header sizes on real files", () => {
  test("canary-01.png (assets, always present)", () => {
    const data = new Uint8Array(readFileSync(CANARY));
    assert.equal(sniffImageFormat(data), "png");
    assert.deepEqual(readImageSize(data), { w: 800, h: 1200 });
  });

  const generated: ReadonlyArray<[string, ImageFormat]> = [
    ["ko-p01.png", "png"],
    ["ko-strip01-s1.webp", "webp"],
    ["ko-strip01-s2.webp", "webp"],
    ["chapter-ko-200/001.jpg", "jpeg"],
    ["chapter-ko-60/002.jpg", "jpeg"],
    ["ko-seam01/ko-seam01-2.png", "png"],
  ];
  for (const [file, format] of generated) {
    test(`${file} matches its ground-truth size`, { skip: NO_FIXTURES }, () => {
      const data = new Uint8Array(readFileSync(new URL(file, GENERATED)));
      const gt = JSON.parse(
        readFileSync(new URL(file.replace(/\.(png|webp|jpg)$/, ".gt.json"), GENERATED), "utf8"),
      ) as { width: number; height: number };
      assert.equal(sniffImageFormat(data), format);
      assert.deepEqual(readImageSize(data), { w: gt.width, h: gt.height });
    });
  }

  test("encoder output (Skia): PNG, JPEG with ICC, WebP VP8X, AVIF, GIF", async () => {
    const cases: Array<["png" | "jpeg" | "webp" | "avif" | "gif", ImageFormat]> = [
      ["png", "png"],
      ["jpeg", "jpeg"],
      ["webp", "webp"],
      ["avif", "avif"],
      ["gif", "gif"],
    ];
    for (const [encoder, format] of cases) {
      const data = await encoded(encoder, 37, 23);
      assert.equal(sniffImageFormat(data), format, encoder);
      assert.deepEqual(readImageSize(data), { w: 37, h: 23 }, encoder);
      assert.equal(couldBeImage(data.subarray(0, 64)), true, encoder);
    }
  });
});

describe("sniffing and header sizes on built headers", () => {
  const cases: ReadonlyArray<[string, Uint8Array, ImageFormat | null, { w: number; h: number } | null]> = [
    ["PNG", png(1200, 1800), "png", { w: 1200, h: 1800 }],
    ["PNG cut before IHDR data", png(10, 10).subarray(0, 20), "png", null],
    ["PNG signature without IHDR", bytes(png(5, 5).subarray(0, 12), "IDAT", new Uint8Array(12)), "png", null],
    ["GIF87a", bytes("GIF87a", u16le(320), u16le(240), [0, 0, 0]), "gif", { w: 320, h: 240 }],
    ["GIF89a", bytes("GIF89a", u16le(1), u16le(65535), [0, 0, 0]), "gif", { w: 1, h: 65535 }],
    ["GIF with zero width", bytes("GIF89a", u16le(0), u16le(9), [0, 0, 0]), "gif", null],
    ["WebP VP8", vp8(800, 2560), "webp", { w: 800, h: 2560 }],
    ["WebP VP8 bad start code", webp("VP8 ", [0x30, 1, 0, 0x9d, 0x01, 0x2b, 0, 0, 0, 0, 0, 0]), "webp", null],
    ["WebP VP8L", vp8l(16383, 2), "webp", { w: 16383, h: 2 }],
    ["WebP VP8L bad signature", webp("VP8L", [0x2e, 0, 0, 0, 0, 0]), "webp", null],
    ["WebP VP8X", vp8x(800, 30000), "webp", { w: 800, h: 30000 }],
    ["WebP unknown chunk", webp("ALPH", [0, 0, 0, 0]), "webp", null],
    ["JPEG baseline", jpeg(1080, 7200), "jpeg", { w: 1080, h: 7200 }],
    ["JPEG progressive", jpeg(640, 480, 0xc2), "jpeg", { w: 640, h: 480 }],
    ["JPEG with fill bytes and RST", jpeg(33, 44, 0xc1, [0xff, 0xff, 0xff, 0xd0]), "jpeg", { w: 33, h: 44 }],
    ["JPEG DHT before SOF", jpeg(7, 9, 0xc0, [0xff, 0xc4, ...u16be(2)]), "jpeg", { w: 7, h: 9 }],
    ["JPEG scan before frame", bytes([0xff, 0xd8, 0xff, 0xda, 0, 2]), "jpeg", null],
    ["JPEG garbage after SOI", bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0x12, 0x34, 0, 0]), "jpeg", null],
    ["JPEG zero height (DNL)", jpeg(100, 0), "jpeg", null],
    ["BMP info header", bmp(640, 480, 40), "bmp", { w: 640, h: 480 }],
    ["BMP top-down", bmp(64, -32, 124), "bmp", { w: 64, h: 32 }],
    ["BMP core header", bmp(300, 200, 12), "bmp", { w: 300, h: 200 }],
    ["BM text, not a DIB", bytes("BM is not a bitmap header at all......"), null, null],
    ["AVIF", avif("avif", ["mif1", "miaf"], [[2048, 768]]), "avif", { w: 2048, h: 768 }],
    [
      "AVIF by compatible brand, thumbnail ignored",
      avif(
        "mif1",
        ["avif"],
        [
          [160, 60],
          [4000, 1500],
        ],
      ),
      "avif",
      {
        w: 4000,
        h: 1500,
      },
    ],
    ["AVIF sequence brand", avif("avis", [], [[10, 20]]), "avif", { w: 10, h: 20 }],
    ["AVIF without ispe", avif("avif", [], []), "avif", null],
    ["HEIC is not supported", avif("heic", ["mif1"], [[10, 10]]), null, null],
    ["HTML", bytes("<!doctype html><html><body>403 Forbidden</body></html>"), null, null],
    ["empty", new Uint8Array(0), null, null],
  ];
  for (const [name, data, format, size] of cases) {
    test(name, () => {
      assert.equal(sniffImageFormat(data), format);
      assert.deepEqual(readImageSize(data), size);
    });
  }

  test("AVIF boxes with 64-bit sizes and a to-end-of-file size", () => {
    const ftyp = box("ftyp", bytes("avif", u32be(0), "mif1"));
    const payload = bytes(
      [0, 0, 0, 0],
      box("iprp", box("ipco", box("ispe", [0, 0, 0, 0], u32be(9), u32be(8)))),
    );
    const meta64 = bytes(u32be(1), "meta", u32be(0), u32be(payload.length + 16), payload);
    assert.deepEqual(readImageSize(bytes(ftyp, meta64)), { w: 9, h: 8 });
    const metaToEnd = bytes(u32be(0), "meta", payload);
    assert.deepEqual(readImageSize(bytes(ftyp, metaToEnd)), { w: 9, h: 8 });
    const truncated = bytes(ftyp, u32be(400), "meta", payload);
    assert.equal(readImageSize(truncated), null, "a box running past the end is ignored");
  });

  test("couldBeImage keeps an ftyp prefix until its brands are known", () => {
    assert.equal(couldBeImage(bytes(u32be(200), "ftyp", "mif1", u32be(0), "miaf", "MA1A")), true);
    assert.equal(couldBeImage(bytes("<html><head><title>x</title></head>")), false);
    assert.equal(couldBeImage(png(1, 1).subarray(0, 8)), true);
  });

  test("FORMAT_MIME covers every format", () => {
    assert.deepEqual(Object.keys(FORMAT_MIME).sort(), ["avif", "bmp", "gif", "jpeg", "png", "webp"]);
    for (const mime of Object.values(FORMAT_MIME)) assert.match(mime, /^image\/[a-z]+$/);
  });
});

describe("contentKeyOf", () => {
  const decoder = createDecoder(coreDeps());

  test("known SHA-256 vectors", async () => {
    assert.equal(
      await decoder.contentKeyOf(new TextEncoder().encode("abc").buffer),
      "s:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.equal(
      await decoder.contentKeyOf(new ArrayBuffer(0)),
      "s:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("matches node:crypto on the canary bytes", async () => {
    const data = new Uint8Array(readFileSync(CANARY));
    assert.equal(await decoder.contentKeyOf(data.slice().buffer), `s:${sha256(data)}`);
  });

  test("uses an injected digest", async () => {
    const custom = createDecoder({
      ...coreDeps(),
      digest: () => Promise.resolve(Uint8Array.from([0, 15, 255]).buffer),
    });
    assert.equal(await custom.contentKeyOf(new ArrayBuffer(4)), "s:000fff");
  });
});

describe("decode", () => {
  test("decodes with the sniffed type and the B.1.4 options; release() closes once", async () => {
    const fake = fakeBitmaps({ w: 1200, h: 1800 });
    const decoder = createDecoder({ ...coreDeps(), ...fake });
    const image = await decoder.decode(acquired(png(1200, 1800), "image/jpeg"), "s:abc", LIMITS);
    assert.equal(image.contentKey, "s:abc");
    assert.deepEqual(image.size, { w: 1200, h: 1800 });
    assert.equal(fake.record.blobs.length, 1);
    assert.equal(fake.record.blobs[0]?.type, "image/png", "magic bytes win over the declared mime");
    assert.equal(fake.record.blobs[0]?.size, png(1200, 1800).length);
    assert.deepEqual(fake.record.options[0], BITMAP_OPTIONS);
    image.release();
    image.release();
    assert.equal(fake.record.closed, 1);
  });

  test("rejects too many bytes before decoding", async () => {
    const fake = fakeBitmaps({ w: 1, h: 1 });
    const decoder = createDecoder({ ...coreDeps(), ...fake });
    await rejectsWith(
      decoder.decode(acquired(png(10, 10)), "s:x", { maxImageBytes: 20, maxImagePixels: 1e6 }),
      "image.too_large",
      "bytes",
    );
    assert.equal(fake.record.blobs.length, 0);
  });

  test("rejects too many pixels from the header before decoding", async () => {
    const fake = fakeBitmaps({ w: 1, h: 1 });
    const decoder = createDecoder({ ...coreDeps(), ...fake });
    for (const data of [
      png(8000, 8001),
      vp8x(800, 80_001),
      jpeg(10_000, 6_401),
      avif("avif", [], [[9000, 9000]]),
    ]) {
      await rejectsWith(decoder.decode(acquired(data), "s:x", LIMITS), "image.too_large", "pixels");
    }
    assert.equal(fake.record.blobs.length, 0);
    // Exactly at the cap is fine.
    await decoder.decode(acquired(png(8000, 8000)), "s:x", LIMITS);
    assert.equal(fake.record.blobs.length, 1);
  });

  test("an unreadable header is decoded, then checked on the bitmap size", async () => {
    const odd = bytes([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 2, 3]);
    const big = fakeBitmaps({ w: 10_000, h: 10_000 });
    await rejectsWith(
      createDecoder({ ...coreDeps(), ...big }).decode(acquired(odd, "image/jpeg"), "s:x", LIMITS),
      "image.too_large",
      "pixels",
    );
    assert.equal(big.record.closed, 1, "the oversized bitmap is closed");

    const empty = fakeBitmaps({ w: 0, h: 0 });
    await rejectsWith(
      createDecoder({ ...coreDeps(), ...empty }).decode(acquired(odd, "image/jpeg"), "s:x", LIMITS),
      "image.decode",
    );
    assert.equal(empty.record.closed, 1);

    const unknown = fakeBitmaps({ w: 5, h: 5 });
    const image = await createDecoder({ ...coreDeps(), ...unknown }).decode(
      acquired(bytes("not an image header"), "image/x-icon"),
      "s:x",
      LIMITS,
    );
    assert.equal(unknown.record.blobs[0]?.type, "image/x-icon", "no magic: the acquirer's mime is used");
    assert.deepEqual(image.size, { w: 5, h: 5 });
  });

  test("createImageBitmap failures become image.decode", async () => {
    const failing = fakeBitmaps(new Error("The source image could not be decoded."));
    const decoder = createDecoder({ ...coreDeps(), ...failing });
    await assert.rejects(decoder.decode(acquired(png(4, 4)), "s:x", LIMITS), (error: unknown) => {
      assert.ok(error instanceof CtvError);
      assert.equal(error.code, "image.decode");
      assert.match(error.detail ?? "", /could not be decoded/);
      return true;
    });
  });

  test("end to end on real bytes with a Skia-backed bitmap factory", async () => {
    const decoder = createDecoder({
      ...coreDeps(),
      createImageBitmap: async (blob) => {
        const image = await loadImage(Buffer.from(await blob.arrayBuffer()));
        const bitmap: ImageBitmap = { width: image.width, height: image.height, close: () => undefined };
        return bitmap;
      },
    });
    const data = new Uint8Array(readFileSync(CANARY));
    const key = await decoder.contentKeyOf(data.slice().buffer);
    const image = await decoder.decode(acquired(data), key, LIMITS);
    assert.deepEqual(image.size, { w: 800, h: 1200 });
    assert.equal(image.contentKey, `s:${sha256(data)}`);
    image.release();
  });
});
