// Composite builder: pack units → core/packing layout inputs → core/composite-layout (the profile's canvases in
// order) → core/composite-render on the injected Gfx → JPEG.
// Mark n = index + 1 in both modes; crops-only re-asks therefore arrive already renumbered 1..k.
// Size guard: the request body (base64 JPEG plus a prompt allowance) must stay within translate.requestBodyCapMb;
// above it the same canvas is re-encoded once at SHRINK_JPEG_QUALITY. A layout that is not ok, or a body still too
// large, comes back as CompositeFail and the translator splits the pack. Nothing is drawn or encoded for a failed
// layout. Anything else that goes wrong (malformed geometry, a missing decoded image) rejects with a CtvError.

import type { Gfx } from "../shared/gfx.ts";
import { renderComposite } from "../shared/core/composite-render.ts";
import { layoutPack } from "../shared/core/packing.ts";
import { SHRINK_JPEG_QUALITY } from "../shared/core/retry-policy.ts";
import { CtvError, toErrorInfo } from "../shared/errors.ts";
import { toBase64 } from "../shared/wire.ts";
import type {
  CompositeBuilder,
  CompositeFail,
  CompositeOk,
  CompositeRequest,
  CoreDeps,
  PackUnit,
} from "./contracts.ts";

export const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
/** Room left in the body for the prompt text and the JSON around it (16k characters, up to 3 UTF-8 bytes each). */
export const PROMPT_ALLOWANCE_BYTES = 64 * 1024;

/** Approximate POST body size of a request carrying this JPEG. */
export function estimateBodyBytes(jpegBytes: number): number {
  return JPEG_DATA_URL_PREFIX.length + 4 * Math.ceil(jpegBytes / 3) + PROMPT_ALLOWANCE_BYTES;
}

/**
 * x-ctv-test-units value: base64(UTF-8 JSON [{n, src, box}]) with box = the unit's text box in natural px of src,
 * exactly what tools/mock-openai/oracle.ts decodes. Test builds only.
 */
export function encodeTestUnits(units: readonly PackUnit[]): string {
  const list = units.map((unit, index) => {
    const { x1, y1, x2, y2 } = unit.geometry.text;
    return { n: index + 1, src: unit.src, box: { x1, y1, x2, y2 } };
  });
  return toBase64(new TextEncoder().encode(JSON.stringify(list)));
}

export function createComposite(deps: CoreDeps & { gfx: Gfx }): CompositeBuilder {
  const { gfx, clock, log } = deps;

  const build = async (request: CompositeRequest): Promise<CompositeOk | CompositeFail> => {
    const started = clock.now();
    const { units, mode } = request;
    const layout = layoutPack(units, request.profile, request.dir, mode);
    if (!layout.ok) {
      log.debug("composite layout failed", { units: units.length, mode, reason: layout.reason });
      return { ok: false, reason: layout.reason ?? "overflow" };
    }

    const canvas = gfx.createCanvas(layout.W, layout.H);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new CtvError("engine.internal", "composite: no 2d context");
    renderComposite(
      layout,
      (contentKey) => {
        const image = request.images.get(contentKey);
        if (image === undefined) {
          throw new CtvError("engine.internal", `composite: no decoded image for ${contentKey}`);
        }
        return image.bitmap;
      },
      ctx,
    );

    const capBytes = deps.settings.current().translate.requestBodyCapMb * 1024 * 1024;
    let quality = request.jpegQuality;
    let jpeg = await gfx.encodeJpeg(canvas, quality);
    if (estimateBodyBytes(jpeg.byteLength) > capBytes && quality > SHRINK_JPEG_QUALITY) {
      quality = SHRINK_JPEG_QUALITY;
      jpeg = await gfx.encodeJpeg(canvas, quality);
    }
    if (estimateBodyBytes(jpeg.byteLength) > capBytes) {
      // The caller splits the pack, as for a layout that does not fit.
      log.info("composite over the request body cap", { bytes: jpeg.byteLength, capBytes, quality });
      return { ok: false, reason: "too-large" };
    }

    const result: CompositeOk = {
      ok: true,
      jpeg,
      dataUrl: JPEG_DATA_URL_PREFIX + toBase64(jpeg),
      size: { w: layout.W, h: layout.H },
      marks: units.map((unit, index) => ({
        n: index + 1,
        contentKey: unit.contentKey,
        unitKey: unit.unitKey,
      })),
    };
    if (__TEST__) result.testUnits = encodeTestUnits(units);
    log.debug("composite built", {
      units: units.length,
      mode,
      w: layout.W,
      h: layout.H,
      bytes: jpeg.byteLength,
      quality,
      ms: clock.now() - started,
    });
    return result;
  };

  return {
    async build(request: CompositeRequest): Promise<CompositeOk | CompositeFail> {
      try {
        return await build(request);
      } catch (error) {
        if (error instanceof CtvError) throw error;
        throw new CtvError("engine.internal", `composite: ${toErrorInfo(error).message}`, { cause: error });
      }
    },
  };
}
