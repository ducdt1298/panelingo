// Erase patches: for each unit, a PNG that paints the background model over exactly the original glyph pixels
// (core/erase-core computeErase), so the translation sits on clean art while balloon outlines, panel borders and
// drawings stay untouched. When a clean erase cannot be guaranteed the result is a "box": the content script then
// draws a translucent plate over the TEXT area only (never over the whole balloon).
//
// It also measures the lettering from the pixels (core/glyph glyphPxFromGray): the overlay sizes the translation
// from it, so the translated text looks as big as the original instead of filling the balloon.

import type { Logger } from "../platform/log.ts";
import { balloonInterior, isFlatBoxInterior, solidPatch } from "../shared/core/bubble-interior.ts";
import { computeErase, eraseReadBox, type EraseResult } from "../shared/core/erase-core.ts";
import { glyphPxFromGray } from "../shared/core/glyph.ts";
import { grayFromRgba } from "../shared/core/slicer.ts";
import type { Gfx, ImageDataLike } from "../shared/gfx.ts";
import type { Box, RGB, Size, UnitGeometry } from "../shared/types.ts";
import type { DecodedImage, EraseOutput, Eraser } from "./contracts.ts";

export interface EraserDeps {
  gfx: Gfx;
  log: Logger;
  /** Yields between units (default a 0 ms timer). */
  yieldTask?: () => Promise<void>;
}

interface Capture {
  unit: UnitGeometry;
  read: Box;
  pixels: ImageDataLike | null;
}

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Median pixel glyph size over the unit's text boxes, inside a crop whose top-left is `read`. */
export function measureGlyph(pixels: ImageDataLike, read: Box, unit: UnitGeometry): number {
  if (pixels.width === 0 || pixels.height === 0) return unit.glyphPx;
  const gray = grayFromRgba(pixels.data, pixels.width, pixels.height);
  const boxes = unit.texts.length > 0 ? unit.texts : [unit.text];
  const sizes: number[] = [];
  for (const b of boxes) {
    const local: Box = { x1: b.x1 - read.x1, y1: b.y1 - read.y1, x2: b.x2 - read.x1, y2: b.y2 - read.y1 };
    if (local.x2 - local.x1 < 2 || local.y2 - local.y1 < 2) continue;
    sizes.push(glyphPxFromGray(gray, pixels.width, pixels.height, local, unit.orientation));
  }
  if (sizes.length === 0) return unit.glyphPx;
  const measured = median(sizes);
  // The pixel profile cannot exceed one text line; keep the geometry estimate when the pixels say nothing useful.
  return measured > 0 && Number.isFinite(measured) ? measured : unit.glyphPx;
}

function plain(
  result: EraseResult,
  glyphPx: number,
  interior: Box | null,
  fill: RGB | null,
  rectLike: boolean,
): EraseOutput {
  return {
    interior,
    rectLike,
    kind: result.kind,
    rect: { ...result.rect },
    // A plate without a background model takes the balloon colour (a brown sign stays brown, not white).
    bg: result.bg ?? fill,
    textColor: result.textColor,
    png: null,
    glyphPx,
  };
}

/**
 * Yields to the event loop through a MessageChannel: the offscreen document is a hidden page, where Chrome throttles
 * chained timers to one per second, so setTimeout(0) between units would make each unit take a second.
 */
export function messageYield(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** The read box on whole pixels (detector boxes are fractional; drawImage must not resample the crop). */
function pixelBox(b: Box, size: Size): Box {
  return {
    x1: Math.max(0, Math.floor(b.x1)),
    y1: Math.max(0, Math.floor(b.y1)),
    x2: Math.min(size.w, Math.ceil(b.x2)),
    y2: Math.min(size.h, Math.ceil(b.y2)),
  };
}

export function createEraser(deps: EraserDeps): Eraser {
  const yieldTask = deps.yieldTask ?? messageYield;

  function capture(image: DecodedImage, unit: UnitGeometry, glyphHint: number): Capture {
    const read = pixelBox(
      eraseReadBox({ text: unit.text, bubble: unit.bubble, glyphPx: glyphHint }, image.size),
      image.size,
    );
    const w = read.x2 - read.x1;
    const h = read.y2 - read.y1;
    if (w <= 0 || h <= 0) return { unit, read, pixels: null };
    const canvas = deps.gfx.createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return { unit, read, pixels: null };
    ctx.drawImage(image.bitmap, read.x1, read.y1, w, h, 0, 0, w, h);
    return { unit, read, pixels: ctx.getImageData(0, 0, w, h) };
  }

  async function encode(patch: ImageDataLike): Promise<ArrayBuffer> {
    const canvas = deps.gfx.createCanvas(patch.width, patch.height);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("no 2d context for the erase patch");
    const target = ctx.getImageData(0, 0, patch.width, patch.height);
    target.data.set(patch.data);
    ctx.putImageData(target, 0, 0);
    const png = await deps.gfx.encodePng(canvas);
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  }

  async function compute(c: Capture, size: Size, others: readonly Box[]): Promise<EraseOutput> {
    const fallback: EraseOutput = {
      kind: "box",
      rect: { ...c.unit.text },
      bg: null,
      textColor: BLACK,
      png: null,
      glyphPx: c.unit.glyphPx,
      interior: null,
      rectLike: false,
    };
    if (c.pixels === null) return fallback;
    const glyphPx = measureGlyph(c.pixels, c.read, c.unit);
    const origin = { x: c.read.x1, y: c.read.y1 };
    // The detector's bubble box often reaches past the outline: erase and fit inside the outline instead.
    const found =
      c.unit.bubble === null ? null : balloonInterior(c.pixels, origin, c.unit.text, c.unit.bubble);
    const interior = found?.box ?? null;
    const fill = found?.fill ?? null;
    const rectLike = found?.rectLike ?? false;
    const started = performance.now();
    const result = computeErase({
      pixels: c.pixels,
      origin,
      image: size,
      unit: {
        text: c.unit.text,
        bubble: interior,
        glyphPx,
        elliptical:
          found !== null &&
          !found.rectLike &&
          found.snapped.left &&
          found.snapped.right &&
          found.snapped.top &&
          found.snapped.bottom,
      },
      others,
    });
    deps.log.debug("erase result", {
      unitKey: c.unit.unitKey,
      kind: result.kind,
      reason: result.kind === "box" ? result.reason : "",
      ms: Math.round(performance.now() - started),
      glyphPx,
      text: `${c.unit.text.x1},${c.unit.text.y1},${c.unit.text.x2},${c.unit.text.y2}`,
      bubble:
        c.unit.bubble === null
          ? ""
          : `${c.unit.bubble.x1},${c.unit.bubble.y1},${c.unit.bubble.x2},${c.unit.bubble.y2}`,
    });
    if (result.kind === "box" && result.reason !== "transparent" && found !== null && fill !== null) {
      if (isFlatBoxInterior(c.pixels, origin, found, c.unit.text)) {
        // Text filling a caption or sign box: paint its whole interior in the balloon colour (the frame stays).
        const rect: Box = {
          x1: Math.ceil(found.box.x1),
          y1: Math.ceil(found.box.y1),
          x2: Math.floor(found.box.x2),
          y2: Math.floor(found.box.y2),
        };
        const png = await encode(solidPatch(rect.x2 - rect.x1, rect.y2 - rect.y1, fill));
        deps.log.debug("erase flat fill", {
          unitKey: c.unit.unitKey,
          reason: result.reason,
          bytes: png.byteLength,
        });
        const textColor: RGB = 0.299 * fill[0] + 0.587 * fill[1] + 0.114 * fill[2] >= 128 ? BLACK : WHITE;
        return { interior, rectLike, kind: "mask", rect, bg: fill, textColor, png, glyphPx };
      }
    }
    if (result.kind !== "mask") return plain(result, glyphPx, interior, fill, rectLike);
    const encodeStart = performance.now();
    const png = await encode(result.patch);
    deps.log.debug("erase patch encoded", {
      unitKey: c.unit.unitKey,
      ms: Math.round(performance.now() - encodeStart),
      bytes: png.byteLength,
    });
    return { ...plain(result, glyphPx, interior, fill, rectLike), png };
  }

  return {
    start(image, units) {
      const size = { w: image.size.w, h: image.size.h };
      const captures = units.map((unit) => {
        try {
          return capture(image, unit, unit.glyphPx);
        } catch (error) {
          deps.log.warn("erase read failed", { unitKey: unit.unitKey, error: String(error) });
          return { unit, read: unit.text, pixels: null } satisfies Capture;
        }
      });
      const out = new Map<string, Promise<EraseOutput>>();
      let chain: Promise<unknown> = Promise.resolve();
      for (const c of captures) {
        const others = units.filter((u) => u.unitKey !== c.unit.unitKey).map((u) => u.text);
        const run = chain.then(async () => {
          await yieldTask();
          try {
            return await compute(c, size, others);
          } catch (error) {
            deps.log.warn("erase failed", { unitKey: c.unit.unitKey, error: String(error) });
            return {
              kind: "box",
              rect: { ...c.unit.text },
              bg: null,
              textColor: BLACK,
              png: null,
              glyphPx: c.unit.glyphPx,
              interior: null,
              rectLike: false,
            } satisfies EraseOutput;
          }
        });
        chain = run;
        out.set(c.unit.unitKey, run);
      }
      return out;
    },
  };
}
