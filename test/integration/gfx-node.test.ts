// tools/gfx-node.ts (@napi-rs/canvas) end to end: synthetic strips → layout → render → JPEG → decode.
// Set CTV_DUMP_DIR to keep the rendered composites for a visual check.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import type { SKRSContext2D } from "@napi-rs/canvas";
import { layoutComposite } from "../../src/shared/core/composite-layout.ts";
import type { CompositeLayout, CropSpec, Mark, Segment } from "../../src/shared/core/composite-layout.ts";
import { renderComposite } from "../../src/shared/core/composite-render.ts";
import type { CanvasLike, Ctx2DLike, ImageDataLike, LoadedImage } from "../../src/shared/gfx.ts";
import type { Box } from "../../src/shared/types.ts";
import { createNodeGfx, nodeGfx } from "../../tools/gfx-node.ts";

type Assert<T extends true> = T;
export type _NapiCtx = Assert<SKRSContext2D extends Ctx2DLike ? true : false>;

const PROFILE = {
  canvas: [
    { W: 2048, H: 768 },
    { W: 2048, H: 1152 },
  ],
  glyphTarget: { hangul: 30, cjk: 32, latin: 22 },
  glyphMin: { hangul: 20, cjk: 22, latin: 14 },
} as const;

/** Original made-up words only (no real text). */
const BUBBLES = [
  [
    { cx: 260, cy: 420, rx: 190, ry: 110, lines: ["ZORBLE VIX TUM", "KAPLO NERI"] },
    { cx: 560, cy: 1150, rx: 200, ry: 120, lines: ["WUNDA PELO", "SIRAK MOTU FEN", "OLO"] },
    { cx: 300, cy: 1900, rx: 170, ry: 90, lines: ["TEPI ZANKU!"] },
  ],
  [
    { cx: 520, cy: 380, rx: 210, ry: 100, lines: ["MIRAVO QUENTI", "DASU LORP"] },
    { cx: 280, cy: 1250, rx: 180, ry: 110, lines: ["BLENTO KAVI", "PUROSH"] },
    { cx: 520, cy: 2000, rx: 220, ry: 120, lines: ["VEXTA NOLU RIM", "SAPPO TRENKA", "HUMI"] },
  ],
];
const STRIP = { w: 800, h: 2400 };
const FONT_PX = 26;
/** Cap height of Arial Bold at 26 px, the glyph size the detector side would estimate. */
const GLYPH_PX = 19;

function ctx2d(canvas: CanvasLike): Ctx2DLike {
  const ctx = canvas.getContext("2d");
  assert.ok(ctx !== null, "2d context");
  return ctx;
}

function nth<T>(items: readonly T[], i: number): T {
  const item = items[i];
  assert.ok(item !== undefined, `missing item ${i}`);
  return item;
}

/** An abstract 800×2400 strip: gradient, soft discs and white bubbles with lines of made-up words. */
function drawStrip(variant: number): { png: Promise<Uint8Array>; texts: Box[] } {
  const canvas = createCanvas(STRIP.w, STRIP.h);
  const ctx = canvas.getContext("2d");
  const bg = ctx.createLinearGradient(0, 0, 0, STRIP.h);
  bg.addColorStop(0, variant === 0 ? "#cfe3f7" : "#cfe8d5");
  bg.addColorStop(1, variant === 0 ? "#e6d5f2" : "#f4efc4");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, STRIP.w, STRIP.h);
  ctx.fillStyle = variant === 0 ? "#a9b8d6" : "#9fbfa8";
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.arc(120 + 110 * i, 300 + 330 * i, 70 + 10 * i, 0, 2 * Math.PI);
    ctx.fill();
  }
  const texts: Box[] = [];
  for (const b of nth(BUBBLES, variant)) {
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#111111";
    ctx.font = `bold ${FONT_PX}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lineH = 34;
    const y0 = b.cy - ((b.lines.length - 1) * lineH) / 2;
    let w = 0;
    b.lines.forEach((line, i) => {
      ctx.fillText(line, b.cx, y0 + i * lineH);
      w = Math.max(w, ctx.measureText(line).width);
    });
    texts.push({
      x1: Math.floor(b.cx - w / 2),
      y1: Math.floor(y0 - FONT_PX / 2),
      x2: Math.ceil(b.cx + w / 2),
      y2: Math.ceil(y0 + (b.lines.length - 1) * lineH + FONT_PX / 2),
    });
  }
  return { png: canvas.encode("png"), texts };
}

function pixel(img: ImageDataLike, x: number, y: number): [number, number, number] {
  const i = 4 * (Math.floor(y) * img.width + Math.floor(x));
  return [img.data[i] ?? -1, img.data[i + 1] ?? -1, img.data[i + 2] ?? -1];
}

function hexRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function near(a: readonly number[], b: readonly number[], tol: number): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);
}

/** Fraction of the pixels in `b` within `tol` of `rgb`. */
function share(img: ImageDataLike, b: Box, rgb: readonly number[], tol: number): number {
  let hit = 0;
  let total = 0;
  for (let y = b.y1; y < b.y2; y++) {
    for (let x = b.x1; x < b.x2; x++) {
      total++;
      if (near(pixel(img, x, y), rgb, tol)) hit++;
    }
  }
  return total > 0 ? hit / total : 0;
}

function dump(name: string, bytes: Uint8Array): void {
  const dir = process.env["CTV_DUMP_DIR"];
  if (dir !== undefined && dir !== "") writeFileSync(join(dir, name), bytes);
}

async function stripPack(): Promise<{ layout: CompositeLayout; images: Map<string, LoadedImage> }> {
  const images = new Map<string, LoadedImage>();
  const segs: Segment[] = [];
  const marks: Mark[] = [];
  const crops: CropSpec[] = [];
  for (const variant of [0, 1]) {
    const imageId = `strip${variant}`;
    const strip = drawStrip(variant);
    const image = await nodeGfx.loadImage(await strip.png);
    assert.deepEqual([image.width, image.height], [STRIP.w, STRIP.h]);
    images.set(imageId, image);
    segs.push({
      imageId,
      kind: "band",
      src: { x1: 0, y1: 0, x2: STRIP.w, y2: STRIP.h },
      imgW: STRIP.w,
      imgH: STRIP.h,
    });
    for (const text of strip.texts) {
      const n = marks.length + 1;
      marks.push({ n, segment: variant, text });
      crops.push({
        n,
        imageId,
        text,
        bounds: { w: STRIP.w, h: STRIP.h },
        glyphPx: GLYPH_PX,
        script: "latin",
      });
    }
  }
  return { layout: layoutComposite(segs, marks, crops, PROFILE, "ltr", "full"), images };
}

test("PNG and JPEG round trips keep the canvas size", async () => {
  const canvas = nodeGfx.createCanvas(64, 40);
  const ctx = ctx2d(canvas);
  ctx.fillStyle = "#1976D2";
  ctx.fillRect(0, 0, 64, 40);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(16, 10, 32, 20);

  const png = await nodeGfx.encodePng(canvas);
  assert.equal(png.constructor, Uint8Array, "a plain Uint8Array, not a Buffer");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fromPng = await nodeGfx.loadImage(png);
  assert.deepEqual([fromPng.width, fromPng.height], [64, 40]);

  const jpeg = await nodeGfx.encodeJpeg(canvas, 0.9);
  assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...jpeg.subarray(jpeg.length - 2)], [0xff, 0xd9]);
  const fromJpeg = await nodeGfx.loadImage(jpeg);
  assert.deepEqual([fromJpeg.width, fromJpeg.height], [64, 40]);

  // Decoded pixels match what was drawn, within JPEG tolerance.
  const check = nodeGfx.createCanvas(64, 40);
  const cctx = ctx2d(check);
  cctx.drawImage(fromJpeg, 0, 0, 64, 40, 0, 0, 64, 40);
  const img = cctx.getImageData(0, 0, 64, 40);
  assert.ok(near(pixel(img, 4, 4), hexRgb("#1976D2"), 12));
  assert.ok(near(pixel(img, 32, 20), [255, 255, 255], 12));
});

test("getImageData / putImageData round trip through Ctx2DLike", () => {
  const ctx = ctx2d(nodeGfx.createCanvas(8, 8));
  ctx.fillStyle = "#E65100";
  ctx.fillRect(0, 0, 8, 8);
  const img = ctx.getImageData(0, 0, 8, 8);
  assert.deepEqual([img.width, img.height, img.data.length], [8, 8, 256]);
  assert.deepEqual([...pixel(img, 3, 3)], hexRgb("#E65100"));
  img.data.fill(255);
  ctx.putImageData(img, 0, 0);
  assert.deepEqual([...pixel(ctx.getImageData(0, 0, 8, 8), 5, 5)], [255, 255, 255]);
});

test("rejects foreign canvases, bad sizes and bad quality", async () => {
  const gfx = createNodeGfx();
  const foreign: CanvasLike = { width: 4, height: 4, getContext: () => null };
  await assert.rejects(gfx.encodeJpeg(foreign, 0.9), TypeError);
  await assert.rejects(gfx.encodePng(foreign), TypeError);
  await assert.rejects(gfx.encodeJpeg(gfx.createCanvas(4, 4), Number.NaN), RangeError);
  assert.throws(() => gfx.createCanvas(0, 10), RangeError);
  assert.throws(() => gfx.createCanvas(10.5, 10), RangeError);
  await assert.rejects(gfx.loadImage(new Uint8Array(0)));
});

test("renders a Set-of-Mark composite from two synthetic strips into a decodable JPEG", async () => {
  const { layout, images } = await stripPack();
  assert.equal(layout.ok, true, String(layout.reason));
  assert.deepEqual([layout.W, layout.H, layout.context.length, layout.marks.length], [2048, 768, 2, 6]);

  const canvas = nodeGfx.createCanvas(layout.W, layout.H);
  const ctx = ctx2d(canvas);
  renderComposite(
    layout,
    (id) => {
      const image = images.get(id);
      assert.ok(image !== undefined, `unknown source ${id}`);
      return image;
    },
    ctx,
  );
  const drawn = ctx.getImageData(0, 0, layout.W, layout.H);

  // Background, separator and the empty end of the crop area.
  assert.ok(layout.separator !== null);
  const sep = layout.separator;
  assert.deepEqual([...pixel(drawn, sep.x1 + 1, layout.H / 2)], [0, 0, 0]);
  assert.deepEqual([...pixel(drawn, layout.W - 3, layout.H - 3)], [255, 255, 255]);

  // Thumbnails show the strips' gradient (not white), crops show dark letters on a white bubble.
  for (const c of layout.context) {
    const mid = pixel(drawn, (c.dst.x1 + c.dst.x2) / 2, c.dst.y1 + 3);
    assert.ok(!near(mid, [255, 255, 255], 8), `thumbnail ${c.segment} is drawn`);
  }
  for (const c of layout.crops) {
    assert.ok(share(drawn, c.dst, [17, 17, 17], 60) > 0.02, `crop #${c.n} shows letters`);
    assert.ok(share(drawn, c.dst, [255, 255, 255], 6) > 0.3, `crop #${c.n} shows the bubble`);
    // The right end of the header strip is plain palette colour (the label sits at the left).
    assert.deepEqual([...pixel(drawn, c.header.x2 - 3, c.header.y1 + 3)], hexRgb(c.color));
    assert.deepEqual([...pixel(drawn, c.cell.x1, c.cell.y2 - 1)], hexRgb(c.color), "2-px border");
  }

  // Frames are stroked in the mark colour; badges are mostly that colour plus white digits.
  for (const m of layout.marks) {
    const rgb = hexRgb(m.color);
    assert.ok(near(pixel(drawn, m.frame.x1, (m.frame.y1 + m.frame.y2) / 2), rgb, 2), `frame ${m.n}`);
    assert.ok(share(drawn, m.badge, rgb, 24) > 0.08, `badge ${m.n} is coloured`);
    assert.ok(share(drawn, m.badge, [255, 255, 255], 24) > 0.05, `badge ${m.n} has white digits and ring`);
  }

  // JPEG q0.90 decodes back to the composite size with only small differences.
  const jpeg = await nodeGfx.encodeJpeg(canvas, 0.9);
  dump("composite-strips.jpg", jpeg);
  assert.ok(jpeg.length > 20_000 && jpeg.length < 1_500_000, `${jpeg.length} bytes`);
  const decoded = await nodeGfx.loadImage(jpeg);
  assert.deepEqual([decoded.width, decoded.height], [layout.W, layout.H]);
  const back = ctx2d(nodeGfx.createCanvas(layout.W, layout.H));
  back.drawImage(decoded, 0, 0, layout.W, layout.H, 0, 0, layout.W, layout.H);
  const round = back.getImageData(0, 0, layout.W, layout.H);
  let diff = 0;
  for (let i = 0; i < drawn.data.length; i++) diff += Math.abs((drawn.data[i] ?? 0) - (round.data[i] ?? 0));
  const meanDiff = diff / drawn.data.length;
  assert.ok(meanDiff < 3, `mean absolute difference ${meanDiff.toFixed(2)} / 255`);
});

test("renders a crops-only re-ask composite", async () => {
  const strip = drawStrip(1);
  const image = await nodeGfx.loadImage(await strip.png);
  const crops: CropSpec[] = [2, 5].map((n, i) => ({
    n,
    imageId: "strip1",
    text: nth(strip.texts, i),
    bounds: { w: STRIP.w, h: STRIP.h },
    glyphPx: GLYPH_PX,
    script: "latin",
  }));
  const layout = layoutComposite([], [], crops, PROFILE, "ltr", "crops-only");
  assert.equal(layout.ok, true, String(layout.reason));
  assert.deepEqual(
    layout.crops.map((c) => [c.n, c.orig]),
    [
      [1, 2],
      [2, 5],
    ],
  );
  const canvas = nodeGfx.createCanvas(layout.W, layout.H);
  const ctx = ctx2d(canvas);
  renderComposite(layout, () => image, ctx);
  const drawn = ctx.getImageData(0, 0, layout.W, layout.H);
  for (const c of layout.crops)
    assert.deepEqual([...pixel(drawn, c.header.x2 - 3, c.header.y1 + 3)], hexRgb(c.color));
  const jpeg = await nodeGfx.encodeJpeg(canvas, 0.9);
  dump("composite-crops-only.jpg", jpeg);
  const decoded = await nodeGfx.loadImage(jpeg);
  assert.deepEqual([decoded.width, decoded.height], [layout.W, layout.H]);
});
