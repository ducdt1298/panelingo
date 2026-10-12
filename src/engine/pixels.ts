// Chrome implementation of the Gfx port (src/shared/gfx.ts) for the offscreen engine. Node code uses
// tools/gfx-node.ts; this one is exercised in Chrome (E2E).
//
// Encoding goes through a DOM <canvas> and toDataURL(), which encodes synchronously. OffscreenCanvas.convertToBlob
// (and canvas.toBlob) schedule the encode as an idle task, and the offscreen document is a hidden page that only gets
// to run it when the 1 s idle timeout fires: every composite and erase patch would wait a second.

import type { CanvasLike, Gfx, LoadedImage } from "../shared/gfx.ts";
import { fromBase64 } from "../shared/wire.ts";

/** Chrome's canvas limit per side. */
const MAX_SIDE = 32_767;

/** A Blob part view: Blob rejects views over a SharedArrayBuffer, so those are copied. */
function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
}

type NativeCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Bytes of a data: URL produced by toDataURL. */
export function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0 || !url.slice(0, comma).endsWith(";base64")) {
    throw new Error("pixels: the canvas could not be encoded");
  }
  return fromBase64(url.slice(comma + 1));
}

export function createChromeGfx(): Gfx {
  const canvases = new WeakMap<object, NativeCanvas>();
  const dom = typeof document !== "undefined";

  const native = (canvas: CanvasLike): NativeCanvas => {
    const own = canvases.get(canvas);
    if (own === undefined) throw new TypeError("pixels: the canvas was not created by this Gfx");
    return own;
  };

  const encode = async (canvas: CanvasLike, type: string, quality?: number): Promise<Uint8Array> => {
    const own = native(canvas);
    if (own instanceof OffscreenCanvas) {
      const options: ImageEncodeOptions = quality === undefined ? { type } : { type, quality };
      const blob = await own.convertToBlob(options);
      return new Uint8Array(await blob.arrayBuffer());
    }
    return dataUrlBytes(own.toDataURL(type, quality));
  };

  return {
    createCanvas(w: number, h: number): CanvasLike {
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) {
        throw new RangeError(`pixels: invalid canvas size ${w}x${h}`);
      }
      let canvas: NativeCanvas;
      if (dom) {
        canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
      } else {
        canvas = new OffscreenCanvas(w, h);
      }
      canvases.set(canvas, canvas);
      return canvas;
    },

    async encodeJpeg(canvas: CanvasLike, quality: number): Promise<Uint8Array> {
      if (!Number.isFinite(quality)) throw new RangeError(`pixels: invalid JPEG quality ${quality}`);
      return await encode(canvas, "image/jpeg", Math.min(1, Math.max(0, quality)));
    },

    async encodePng(canvas: CanvasLike): Promise<Uint8Array> {
      return await encode(canvas, "image/png");
    },

    async loadImage(bytes: Uint8Array): Promise<LoadedImage> {
      return await createImageBitmap(new Blob([blobPart(bytes)]));
    },
  };
}
