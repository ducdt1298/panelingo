// Gfx port on @napi-rs/canvas 1.0.10 for Node: unit and integration tests and the quality-benchmark tooling.
// Never shipped. Its Skia build and JPEG encoder differ from Chrome's, so compare geometry or pixels with a
// tolerance, never encoded bytes.

import { Canvas, createCanvas, loadImage } from "@napi-rs/canvas";
import type { CanvasLike, Gfx, LoadedImage } from "../src/shared/gfx.ts";

/** Skia's raster limit per side. */
const MAX_SIDE = 32767;

function nativeCanvas(canvas: CanvasLike): Canvas {
  if (canvas instanceof Canvas) return canvas;
  throw new TypeError("gfx-node: the canvas was not created by this Gfx");
}

/** A plain Uint8Array view over napi's Buffer (no copy). */
function bytesOf(buf: Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function createNodeGfx(): Gfx {
  return {
    createCanvas(w: number, h: number): CanvasLike {
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) {
        throw new RangeError(`gfx-node: invalid canvas size ${w}x${h}`);
      }
      return createCanvas(w, h);
    },

    async encodeJpeg(canvas: CanvasLike, quality: number): Promise<Uint8Array> {
      if (!Number.isFinite(quality)) throw new RangeError(`gfx-node: invalid JPEG quality ${quality}`);
      const q = Math.round(Math.min(1, Math.max(0, quality)) * 100);
      return bytesOf(await nativeCanvas(canvas).encode("jpeg", q));
    },

    async encodePng(canvas: CanvasLike): Promise<Uint8Array> {
      return bytesOf(await nativeCanvas(canvas).encode("png"));
    },

    loadImage(bytes: Uint8Array): Promise<LoadedImage> {
      return loadImage(bytes);
    },
  };
}

/** Shared instance; the implementation is stateless. */
export const nodeGfx: Gfx = createNodeGfx();
