import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ServiceFactories } from "../../../src/engine/contracts.ts";
import { createChromeGfx, dataUrlBytes } from "../../../src/engine/pixels.ts";
import type { CanvasLike, Gfx } from "../../../src/shared/gfx.ts";

// Node has neither OffscreenCanvas nor createImageBitmap: minimal stand-ins record how pixels.ts drives them.
// Real rendering is exercised in Chrome (E2E); tools/gfx-node.ts covers the drawing cores in Node.

const ENCODED: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xdb],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
};

class FakeOffscreenCanvas {
  static created: FakeOffscreenCanvas[] = [];
  readonly width: number;
  readonly height: number;
  readonly encodes: ImageEncodeOptions[] = [];
  readonly context = { kind: "2d" };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    FakeOffscreenCanvas.created.push(this);
  }

  getContext(id: string): object | null {
    return id === "2d" ? this.context : null;
  }

  convertToBlob(options: ImageEncodeOptions = {}): Promise<Blob> {
    this.encodes.push(options);
    const type = options.type ?? "image/png";
    return Promise.resolve(new Blob([Uint8Array.from(ENCODED[type] ?? [])], { type }));
  }
}

const bitmaps: Blob[] = [];
const globals = globalThis as Record<string, unknown>;

beforeEach(() => {
  FakeOffscreenCanvas.created = [];
  bitmaps.length = 0;
  globals.OffscreenCanvas = FakeOffscreenCanvas;
  globals.createImageBitmap = (blob: Blob): Promise<{ width: number; height: number }> => {
    bitmaps.push(blob);
    return Promise.resolve({ width: 3, height: 2 });
  };
});

afterEach(() => {
  delete globals.OffscreenCanvas;
  delete globals.createImageBitmap;
});

test("createCanvas returns an OffscreenCanvas of the requested size with a 2d context", () => {
  const gfx: Gfx = createChromeGfx();
  const canvas = gfx.createCanvas(2048, 768);
  assert.equal(FakeOffscreenCanvas.created.length, 1);
  assert.equal(canvas, FakeOffscreenCanvas.created[0]);
  assert.equal(canvas.width, 2048);
  assert.equal(canvas.height, 768);
  assert.notEqual(canvas.getContext("2d"), null);
});

test("createCanvas rejects sizes Chrome cannot allocate", () => {
  const gfx = createChromeGfx();
  for (const [w, h] of [
    [0, 10],
    [10, 0],
    [1.5, 10],
    [32_768, 1],
    [Number.NaN, 1],
  ] as const) {
    assert.throws(() => gfx.createCanvas(w, h), RangeError, `${w}x${h}`);
  }
  assert.equal(gfx.createCanvas(32_767, 1).width, 32_767);
});

test("encodeJpeg and encodePng go through convertToBlob with the right type and clamped quality", async () => {
  const gfx = createChromeGfx();
  const canvas = gfx.createCanvas(4, 4);
  const jpeg = await gfx.encodeJpeg(canvas, 0.9);
  assert.deepEqual([...jpeg], ENCODED["image/jpeg"]);
  const png = await gfx.encodePng(canvas);
  assert.deepEqual([...png], ENCODED["image/png"]);
  await gfx.encodeJpeg(canvas, 7);
  await gfx.encodeJpeg(canvas, -1);
  const fake = FakeOffscreenCanvas.created[0];
  assert.ok(fake !== undefined);
  assert.deepEqual(fake.encodes, [
    { type: "image/jpeg", quality: 0.9 },
    { type: "image/png" },
    { type: "image/jpeg", quality: 1 },
    { type: "image/jpeg", quality: 0 },
  ]);
  await assert.rejects(gfx.encodeJpeg(canvas, Number.NaN), RangeError);
});

test("only canvases created by the same Gfx can be encoded", async () => {
  const gfx = createChromeGfx();
  const other = createChromeGfx().createCanvas(2, 2);
  const lookalike: CanvasLike = { width: 2, height: 2, getContext: () => null };
  await assert.rejects(gfx.encodePng(other), TypeError);
  await assert.rejects(gfx.encodeJpeg(lookalike, 0.9), TypeError);
});

test("loadImage decodes a Blob of the bytes with createImageBitmap", async () => {
  const gfx = createChromeGfx();
  const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const image = await gfx.loadImage(data);
  assert.deepEqual({ width: image.width, height: image.height }, { width: 3, height: 2 });
  assert.equal(bitmaps.length, 1);
  assert.deepEqual([...new Uint8Array(await bitmaps[0]!.arrayBuffer())], [...data]);

  // A view over part of a larger buffer only contributes its own bytes.
  const backing = Uint8Array.from([9, 9, 1, 2, 3, 9]);
  await gfx.loadImage(backing.subarray(2, 5));
  assert.deepEqual([...new Uint8Array(await bitmaps[1]!.arrayBuffer())], [1, 2, 3]);

  // Views over shared memory are copied (Blob refuses them in Chrome).
  const shared = new Uint8Array(new SharedArrayBuffer(3));
  shared.set([4, 5, 6]);
  await gfx.loadImage(shared);
  assert.deepEqual([...new Uint8Array(await bitmaps[2]!.arrayBuffer())], [4, 5, 6]);
});

test("createChromeGfx fits ServiceFactories.createGfx", () => {
  const factory: ServiceFactories["createGfx"] = createChromeGfx;
  assert.equal(typeof factory, "function");
});

test("with a DOM (the offscreen document) canvases are <canvas> elements encoded synchronously by toDataURL", async () => {
  const calls: Array<[string, number | undefined]> = [];
  class FakeCanvasElement {
    width = 0;
    height = 0;
    getContext(): object {
      return {};
    }
    toDataURL(type: string, quality?: number): string {
      calls.push([type, quality]);
      return `data:${type};base64,${Buffer.from(ENCODED[type] ?? []).toString("base64")}`;
    }
  }
  const holder = globalThis as { document?: unknown };
  const previous = holder.document;
  holder.document = { createElement: () => new FakeCanvasElement() };
  try {
    const gfx = createChromeGfx();
    const canvas = gfx.createCanvas(4, 3);
    assert.deepEqual([canvas.width, canvas.height], [4, 3]);
    assert.deepEqual([...(await gfx.encodeJpeg(canvas, 1.7))], ENCODED["image/jpeg"]);
    assert.deepEqual([...(await gfx.encodePng(canvas))], ENCODED["image/png"]);
    assert.deepEqual(calls, [
      ["image/jpeg", 1],
      ["image/png", undefined],
    ]);
  } finally {
    holder.document = previous;
  }
});

test("dataUrlBytes decodes base64 data URLs and rejects anything else", () => {
  assert.deepEqual([...dataUrlBytes("data:image/png;base64,iVBORw==")], [0x89, 0x50, 0x4e, 0x47]);
  assert.throws(() => dataUrlBytes("data:,"), /could not be encoded/);
  assert.throws(() => dataUrlBytes("data:image/png,raw"), /could not be encoded/);
});
