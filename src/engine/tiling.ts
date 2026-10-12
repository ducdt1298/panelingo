// Detector slicing and per-slice inference for one decoded image.
//
// size → slice plan (core/slicer; quiet rows from pixels of the search windows only, when enabled) → per slice, one
// after another: the region stretched to 640×640 on white, planar RGB / 255, one model run with orig_target_sizes =
// [w, h] of the slice → raw detections (score ≥ 0.15) offset into image px → units (core/units-build). The model call
// is injected: detector.ts owns ORT and the mutex around every run.
//
// Production stretches with createImageBitmap(resizeQuality "high") then draws on white ("bitmap-high"). The canary
// is rasterised exactly as its reference was recorded: one drawImage with the default smoothing, no background
// ("draw-low"). Node tests use the Gfx implementation of the same two modes.

import { DETECTOR_INPUT, inputLength, rgbaToNchw } from "../shared/core/detector-io.ts";
import { decodeDetectorOutput } from "../shared/core/detections.ts";
import type { DetectorOutput, SliceDetections } from "../shared/core/detections.ts";
import {
  grayFromRgba,
  planSlices,
  quietColsFromGray,
  quietRowsFromGray,
  sliceSearchWindows,
} from "../shared/core/slicer.ts";
import type { Slice, SlicePlan } from "../shared/core/slicer.ts";
import { buildUnitGeometry, flattenParts, sliceOptionsOf } from "../shared/core/units-build.ts";
import type { GeometryParams } from "../shared/core/units-build.ts";
import type { CanvasLike, Ctx2DLike, Gfx, ImageDataLike, ImageSourceLike } from "../shared/gfx.ts";
import type { Detection, Size, UnitGeometry } from "../shared/types.ts";
import type { DetectOptions } from "./contracts.ts";

export type ResizeMode = "bitmap-high" | "draw-low";

/** A decoded image the pixel helpers can draw from. */
export interface TileSource {
  readonly source: ImageSourceLike;
  readonly size: Size;
}

export interface DecodedPixels extends TileSource {
  close(): void;
}

/** Pixel access for detection; one implementation per environment. */
export interface TilePixels {
  /** `rect` of `source` stretched to side × side RGBA (no aspect ratio kept). */
  stretch(source: ImageSourceLike, rect: Slice, side: number, mode: ResizeMode): Promise<ImageDataLike>;
  /** `rect` of `source` at 1:1 on white (quiet-row flags). */
  region(source: ImageSourceLike, rect: Slice): Promise<ImageDataLike>;
  /** Decodes PNG/JPEG/WebP bytes with default options (canary page). */
  decode(bytes: Uint8Array<ArrayBuffer>): Promise<DecodedPixels>;
}

/** One model run: planar input of 640² and orig_target_sizes [w, h] → raw output (owned arrays). */
export type TileRunner = (input: Float32Array, target: Size) => Promise<DetectorOutput>;

export interface TilingDeps {
  pixels: TilePixels;
  run: TileRunner;
  /** Monotonic ms for timings. */
  now(): number;
  /** Reused planar input (3 × 640 × 640); allocated when absent. */
  input?: Float32Array;
}

export interface TilingResult {
  plan: SlicePlan;
  /** Every slice's detections with score ≥ 0.15, image px, slice order (UnitsRecord.rawDetections). */
  rawDetections: Detection[];
  /** Units with scoreMin applied, reading order (order === index). */
  units: UnitGeometry[];
  /** session.run time per slice. */
  inferMs: number[];
}

function checkSize(data: ImageDataLike, w: number, h: number): ImageDataLike {
  if (data.width !== w || data.height !== h) {
    throw new RangeError(`pixels: got ${data.width}×${data.height}, expected ${w}×${h}`);
  }
  return data;
}

/** Per-row (tall image) or per-column (wide image) quiet flags; 0 outside the slicer's search windows. */
export async function quietFlags(
  image: TileSource,
  params: GeometryParams,
  pixels: TilePixels,
): Promise<{ rowQuiet: Uint8Array } | { colQuiet: Uint8Array }> {
  const { w, h } = image.size;
  const vertical = h >= w;
  const flags = new Uint8Array(vertical ? h : w);
  for (const win of sliceSearchWindows(image.size, sliceOptionsOf(params))) {
    const len = win.end - win.start;
    if (len <= 0) continue;
    const rect: Slice = vertical ? { x: 0, y: win.start, w, h: len } : { x: win.start, y: 0, w: len, h };
    const data = checkSize(await pixels.region(image.source, rect), rect.w, rect.h);
    const gray = grayFromRgba(data.data, rect.w, rect.h);
    flags.set(
      vertical ? quietRowsFromGray(gray, rect.w, rect.h) : quietColsFromGray(gray, rect.w, rect.h),
      win.start,
    );
  }
  return vertical ? { rowQuiet: flags } : { colQuiet: flags };
}

/** The slice plan of one image; quiet rows only when params.quietRows (off by default). */
export async function planImageSlices(
  image: TileSource,
  params: GeometryParams,
  pixels: TilePixels,
): Promise<SlicePlan> {
  const options = sliceOptionsOf(params);
  if (!params.quietRows) return planSlices(image.size, options);
  return planSlices(image.size, { ...options, ...(await quietFlags(image, params, pixels)) });
}

/** Runs the model on every slice, strictly one after another. */
export async function detectSlices(
  image: TileSource,
  slices: readonly Slice[],
  deps: TilingDeps,
): Promise<{ parts: SliceDetections[]; inferMs: number[] }> {
  const input = deps.input ?? new Float32Array(inputLength());
  const parts: SliceDetections[] = [];
  const inferMs: number[] = [];
  for (const slice of slices) {
    const rgba = checkSize(
      await deps.pixels.stretch(image.source, slice, DETECTOR_INPUT, "bitmap-high"),
      DETECTOR_INPUT,
      DETECTOR_INPUT,
    );
    rgbaToNchw(rgba.data, DETECTOR_INPUT, DETECTOR_INPUT, input);
    const started = deps.now();
    const out = await deps.run(input, { w: slice.w, h: slice.h });
    inferMs.push(deps.now() - started);
    parts.push({ slice, dets: decodeDetectorOutput(out, slice) });
  }
  return { parts, inferMs };
}

/** Plan → per-slice runs → raw detections → units. */
export async function runTiling(
  image: TileSource,
  options: DetectOptions,
  deps: TilingDeps,
): Promise<TilingResult> {
  const plan = await planImageSlices(image, options.slice, deps.pixels);
  const { parts, inferMs } = await detectSlices(image, plan.slices, deps);
  const rawDetections = flattenParts(parts);
  const units = buildUnitGeometry(rawDetections, plan.slices, image.size, {
    scoreMin: options.scoreMin,
    dir: options.dir,
  });
  return { plan, rawDetections, units, inferMs };
}

/* ------------------------------------------------------------------ pixel implementations */

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("pixels: no 2d context");
  return ctx;
}

/** Chrome: OffscreenCanvas + createImageBitmap (offscreen document). */
export function browserTilePixels(): TilePixels {
  let square: OffscreenCanvas | null = null;
  return {
    async stretch(source, rect, side, mode) {
      if (mode === "draw-low") {
        // How the canary reference was recorded, kept identical: fresh canvas, one drawImage, default (low) smoothing.
        const ctx = context2d(new OffscreenCanvas(side, side));
        ctx.drawImage(source as CanvasImageSource, rect.x, rect.y, rect.w, rect.h, 0, 0, side, side);
        return ctx.getImageData(0, 0, side, side);
      }
      if (square === null || square.width !== side) square = new OffscreenCanvas(side, side);
      const ctx = context2d(square);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, side, side);
      const tile = await createImageBitmap(source as ImageBitmapSource, rect.x, rect.y, rect.w, rect.h, {
        resizeWidth: side,
        resizeHeight: side,
        resizeQuality: "high",
      });
      try {
        ctx.drawImage(tile, 0, 0);
      } finally {
        tile.close();
      }
      return ctx.getImageData(0, 0, side, side);
    },
    region(source, rect) {
      const ctx = context2d(new OffscreenCanvas(rect.w, rect.h));
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rect.w, rect.h);
      ctx.drawImage(source as CanvasImageSource, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      return Promise.resolve(ctx.getImageData(0, 0, rect.w, rect.h));
    },
    async decode(bytes) {
      const bitmap = await createImageBitmap(new Blob([bytes]));
      return { source: bitmap, size: { w: bitmap.width, h: bitmap.height }, close: () => bitmap.close() };
    },
  };
}

function gfxContext(canvas: CanvasLike): Ctx2DLike {
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("pixels: no 2d context");
  return ctx;
}

/** Any Gfx (Node tests on @napi-rs/canvas; Chrome when createImageBitmap is missing). */
export function gfxTilePixels(gfx: Gfx): TilePixels {
  return {
    stretch(source, rect, side, mode) {
      const ctx = gfxContext(gfx.createCanvas(side, side));
      if (mode === "bitmap-high") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, side, side);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = mode === "bitmap-high" ? "high" : "low";
      ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, side, side);
      return Promise.resolve(ctx.getImageData(0, 0, side, side));
    },
    region(source, rect) {
      const ctx = gfxContext(gfx.createCanvas(rect.w, rect.h));
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rect.w, rect.h);
      ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      return Promise.resolve(ctx.getImageData(0, 0, rect.w, rect.h));
    },
    async decode(bytes) {
      const image = await gfx.loadImage(bytes);
      return { source: image, size: { w: image.width, h: image.height }, close: () => undefined };
    },
  };
}

/** Chrome APIs when present (production and canary paths), else the Gfx. */
export function defaultTilePixels(gfx: Gfx): TilePixels {
  return typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function"
    ? browserTilePixels()
    : gfxTilePixels(gfx);
}
