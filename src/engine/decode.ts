// Content keys and guarded decoding.
//
// contentKey = "s:" + SHA-256 of the exact bytes. decode() refuses oversized inputs twice: by byte count, then by the
// pixel count read from the file header BEFORE createImageBitmap allocates (a 64 MP bitmap already holds 245 MiB),
// and once more on the decoded size for headers it cannot read. Header sniffing lives in shared/core/image-header.ts,
// which the acquirer also uses as its magic-byte check (response headers are never trusted alone).

import { FORMAT_MIME, readImageSize, sniffImageFormat } from "../shared/core/image-header.ts";
import { CtvError, errorMessage } from "../shared/errors.ts";
import { toHex } from "../shared/ids.ts";
import type { Size } from "../shared/types.ts";
import type { AcquiredImage, CoreDeps, DecodedImage, DecodeLimits, ImageDecoder } from "./contracts.ts";

export interface DecoderOverrides {
  /** Default: the global createImageBitmap. */
  createImageBitmap?: (blob: Blob, options: ImageBitmapOptions) => Promise<ImageBitmap>;
  /** SHA-256 of the bytes. Default: crypto.subtle.digest. */
  digest?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
}

/** Orientation from EXIF, no premultiplication (erase reads alpha), colours as <img> shows them. */
export const BITMAP_OPTIONS: ImageBitmapOptions = {
  imageOrientation: "from-image",
  premultiplyAlpha: "none",
  colorSpaceConversion: "default",
};

function tooLarge(message: string, detail: "bytes" | "pixels"): CtvError {
  return new CtvError("image.too_large", message, { detail });
}

export function createDecoder(deps: CoreDeps & DecoderOverrides): ImageDecoder {
  const bitmapOf = deps.createImageBitmap ?? ((blob, options) => createImageBitmap(blob, options));
  const digest = deps.digest ?? ((bytes) => crypto.subtle.digest("SHA-256", bytes));

  return {
    async contentKeyOf(bytes: ArrayBuffer): Promise<string> {
      return `s:${toHex(await digest(bytes))}`;
    },

    async decode(image: AcquiredImage, contentKey: string, limits: DecodeLimits): Promise<DecodedImage> {
      const { bytes } = image;
      if (bytes.byteLength > limits.maxImageBytes) {
        throw tooLarge(`image has ${bytes.byteLength} bytes (cap ${limits.maxImageBytes})`, "bytes");
      }
      const head = new Uint8Array(bytes);
      const header = readImageSize(head);
      if (header !== null && header.w * header.h > limits.maxImagePixels) {
        throw tooLarge(`image is ${header.w}x${header.h} (cap ${limits.maxImagePixels} px)`, "pixels");
      }
      const format = sniffImageFormat(head);
      const type = format === null ? image.mime : FORMAT_MIME[format];
      let bitmap: ImageBitmap;
      try {
        bitmap = await bitmapOf(new Blob([bytes], { type }), BITMAP_OPTIONS);
      } catch (error) {
        throw new CtvError("image.decode", `createImageBitmap failed for ${type}`, {
          cause: error,
          detail: errorMessage(error),
        });
      }
      const size: Size = { w: bitmap.width, h: bitmap.height };
      if (size.w <= 0 || size.h <= 0) {
        bitmap.close();
        throw new CtvError("image.decode", "decoded image is empty");
      }
      if (size.w * size.h > limits.maxImagePixels) {
        bitmap.close();
        throw tooLarge(`decoded image is ${size.w}x${size.h} (cap ${limits.maxImagePixels} px)`, "pixels");
      }
      if (header === null) {
        deps.log.debug("decoded without a readable header", { type, w: size.w, h: size.h });
      }
      let released = false;
      return {
        contentKey,
        size,
        bitmap,
        release(): void {
          if (released) return;
          released = true;
          bitmap.close();
        },
      };
    },
  };
}
