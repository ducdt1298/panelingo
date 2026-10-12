// Graphics port shared by the engine (OffscreenCanvas, src/engine/pixels.ts) and Node tools (@napi-rs/canvas,
// tools/gfx-node.ts). PURE: types only, no runtime code, no DOM or Node types.
//
// The interfaces are the subset of the 2D canvas API that pure cores draw with (composite-render, erase-core).
// They are written so that the browser's CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D and
// @napi-rs/canvas's SKRSContext2D are assignable to them unchanged:
// - members are declared as methods (bivariant parameters), never as function-typed properties;
// - style properties accept the union the platforms expose (pure code only writes CSS colour strings);
// - string-literal unions repeat the DOM ones exactly.
// Never compare encoded bytes across implementations (Skia builds differ); compare geometry or pixels with a
// tolerance.

/** Pixels in RGBA order, row-major, 4 bytes per pixel (the shape of DOM ImageData). */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Anything a Gfx can draw from: a decoded image (ImageBitmap in Chrome, Image in Node) or a canvas created by the
 * same Gfx. Opaque to pure code, which only hands it back to `Ctx2DLike.drawImage`.
 */
export type ImageSourceLike = object;

/** A decoded image with its natural size. */
export type LoadedImage = ImageSourceLike & { readonly width: number; readonly height: number };

export type TextAlignLike = "center" | "end" | "left" | "right" | "start";
export type TextBaselineLike = "alphabetic" | "bottom" | "hanging" | "ideographic" | "middle" | "top";
export type LineJoinLike = "bevel" | "miter" | "round";
export type SmoothingQualityLike = "high" | "low" | "medium";

export interface TextMetricsLike {
  readonly width: number;
}

/** The 2D context subset used by pure drawing code. Coordinates are canvas pixels. */
export interface Ctx2DLike {
  /** Pure code writes CSS colour strings only; platforms may hold gradients or patterns here. */
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineJoin: LineJoinLike;
  /** CSS font shorthand, e.g. "bold 20px Arial, Helvetica, sans-serif". */
  font: string;
  textAlign: TextAlignLike;
  textBaseline: TextBaselineLike;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: SmoothingQualityLike;

  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;

  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  closePath(): void;
  fill(): void;
  stroke(): void;

  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): TextMetricsLike;

  /** Copies the source rectangle (sx, sy, sw, sh) of `image` into the destination rectangle (dx, dy, dw, dh). */
  drawImage(
    image: ImageSourceLike,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;

  save(): void;
  restore(): void;

  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike;
  /** `imageData` must come from getImageData() of a context of the same implementation. */
  putImageData(imageData: ImageDataLike, dx: number, dy: number): void;
}

/** A drawing surface created by a Gfx (OffscreenCanvas in Chrome, Canvas in Node). */
export interface CanvasLike {
  readonly width: number;
  readonly height: number;
  getContext(contextId: "2d"): Ctx2DLike | null;
}

/** Platform graphics: one implementation per environment, injected into engine code and tools. */
export interface Gfx {
  createCanvas(w: number, h: number): CanvasLike;
  /** JPEG bytes; `quality` in [0, 1] as in OffscreenCanvas.convertToBlob. Only canvases from this Gfx. */
  encodeJpeg(canvas: CanvasLike, quality: number): Promise<Uint8Array>;
  /** PNG bytes. Only canvases from this Gfx. */
  encodePng(canvas: CanvasLike): Promise<Uint8Array>;
  /** Decodes PNG/JPEG/WebP bytes. */
  loadImage(bytes: Uint8Array): Promise<LoadedImage>;
}
