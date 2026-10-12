// Acquisition ladder step 1, in the content script: read the bytes the page can already read, so the engine never
// downloads them again. data: URLs are decoded here; blob: URLs are fetched in the page's own context (Blob URLs are
// partitioned, the engine cannot read them); same-origin URLs and images the page loaded with a crossorigin attribute
// are fetched like the page would (usually an HTTP cache hit); when that fetch fails, an untainted image or canvas is
// re-encoded as PNG. A cross-origin host without a crossorigin attribute gets ONE CORS probe per page (opted-in sites
// only) because failed probes print console errors on the page. Everything else returns null and the engine fetches
// it (step 2). Never throws.

import { fromBase64 } from "../shared/wire.ts";
import type { ImageElement, LocalBytes, ReadLocalBytes, ReadLocalOptions } from "./contracts.ts";

/** A local read that takes longer than this is not "local": it is aborted. */
export const LOCAL_READ_TIMEOUT_MS = 15_000;
const OCTET_STREAM = "application/octet-stream";

/* ------------------------------------------------------------------ pure helpers */

/** MIME type without parameters, lowercased ("" when absent). */
export function mimeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Types worth handing to the engine (it sniffs the magic bytes anyway). */
export function isImageMime(mime: string): boolean {
  return mime === "" || mime.startsWith("image/") || mime === OCTET_STREAM || mime === "binary/octet-stream";
}

const HEX = /^[0-9a-f]{2}$/i;

/** URL percent-decoding over bytes (non-ASCII characters become their UTF-8 bytes). */
export function percentDecode(text: string): Uint8Array<ArrayBuffer> {
  const input = new TextEncoder().encode(text);
  const out = new Uint8Array(input.length);
  let o = 0;
  for (let i = 0; i < input.length; i += 1) {
    const byte = input[i] ?? 0;
    const pair =
      byte === 0x25 && i + 2 < input.length ? String.fromCharCode(input[i + 1] ?? 0, input[i + 2] ?? 0) : "";
    if (pair !== "" && HEX.test(pair)) {
      out[o] = parseInt(pair, 16);
      i += 2;
    } else {
      out[o] = byte;
    }
    o += 1;
  }
  return out.slice(0, o);
}

export interface DataUrlBytes {
  mime: string;
  bytes: ArrayBuffer;
}

/**
 * Decodes a data: URL (WHATWG fetch "data: URL processor": percent-decoding, then forgiving base64 when the last
 * parameter is ";base64"). null when it is not a data: URL, not an image type, malformed or larger than maxBytes.
 */
export function parseDataUrl(url: string, maxBytes: number): DataUrlBytes | null {
  if (!/^data:/i.test(url)) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const params = url
    .slice(5, comma)
    .split(";")
    .map((part) => part.trim());
  const base64 = params.length > 1 && params[params.length - 1]?.toLowerCase() === "base64";
  const mime = (params[0] ?? "").toLowerCase();
  if (!isImageMime(mime)) return null;
  const body = url.slice(comma + 1);
  // Cheap bound before decoding: percent-encoded text yields at least one byte per 3 characters; the base64 bound
  // (4 characters per byte instead of 4 per 3) is loose on purpose, to tolerate line breaks.
  if (body.length > (maxBytes + 3) * (base64 ? 4 : 3)) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    if (base64) {
      const text = body.includes("%") ? new TextDecoder("latin1").decode(percentDecode(body)) : body;
      bytes = fromBase64(text).slice();
    } else {
      bytes = percentDecode(body);
    }
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
  return { mime: mime === "" ? OCTET_STREAM : mime, bytes: bytes.buffer };
}

export type LocalSourceKind = "data" | "blob" | "same-origin" | "cors-attr" | "cross-origin" | "unsupported";

/**
 * Which step-1 read applies to an <img> source. `pageOrigin` is the frame document's origin (about:blank and srcdoc
 * frames inherit their creator's); `crossOrigin` is img.crossOrigin (null when the attribute is absent).
 */
export function classifyLocalSource(
  src: string,
  baseUrl: string,
  pageOrigin: string,
  crossOrigin: string | null,
): { kind: LocalSourceKind; url: URL | null } {
  // An empty src would resolve to the page itself.
  if (src.trim() === "") return { kind: "unsupported", url: null };
  let url: URL;
  try {
    url = new URL(src, baseUrl);
  } catch {
    return { kind: "unsupported", url: null };
  }
  switch (url.protocol) {
    case "data:":
      return { kind: "data", url };
    case "blob:":
      return { kind: "blob", url };
    case "http:":
    case "https:":
      if (url.origin === pageOrigin) return { kind: "same-origin", url };
      return { kind: crossOrigin === null ? "cross-origin" : "cors-attr", url };
    default:
      return { kind: "unsupported", url };
  }
}

/* ------------------------------------------------------------------ reader */

export interface LocalFetchInit {
  method: "GET";
  /** Readable bytes only: an opaque no-cors response would be useless. */
  mode: "cors";
  credentials: "omit" | "same-origin" | "include";
  cache: "force-cache";
  redirect: "follow";
  signal: AbortSignal;
}

/** The part of a fetch Response the reader uses. */
export interface LocalFetchResponse {
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface LocalReaderDeps {
  fetch(url: string, init: LocalFetchInit): Promise<LocalFetchResponse>;
  /** Serialized origin of the frame's document. */
  pageOrigin(): string;
  /** PNG bytes of the element drawn onto a canvas; null when tainted, empty or not drawable. */
  snapshotPng(element: ImageElement): Promise<ArrayBuffer | null>;
  timeoutMs?: number;
}

export interface LocalReader {
  read: ReadLocalBytes;
}

/** The image is bigger than maxBytes: no canvas fallback either (the engine reports image.too_large). */
const TOO_LARGE = "too-large";

/** Reads the body up to maxBytes. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ArrayBuffer | typeof TOO_LARGE | null> {
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

function discard(response: LocalFetchResponse): void {
  if (response.body !== null && !response.body.locked) void response.body.cancel().catch(() => undefined);
}

export function createLocalReader(deps: LocalReaderDeps): LocalReader {
  const timeoutMs = deps.timeoutMs ?? LOCAL_READ_TIMEOUT_MS;
  /** CORS probe state per cross-origin origin, for the life of this page. */
  const probes = new Map<string, "pending" | "ok" | "failed">();

  async function fetchBytes(
    url: URL,
    credentials: LocalFetchInit["credentials"],
    maxBytes: number,
  ): Promise<LocalBytes | typeof TOO_LARGE | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await deps.fetch(url.href, {
        method: "GET",
        mode: "cors",
        credentials,
        cache: "force-cache",
        redirect: "follow",
        signal: controller.signal,
      });
      const mime = mimeOf(response.headers.get("content-type"));
      if (!response.ok || !isImageMime(mime)) {
        discard(response);
        return null;
      }
      if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
        discard(response);
        return TOO_LARGE;
      }
      const bytes = await readCapped(response.body, maxBytes);
      if (bytes === TOO_LARGE) return TOO_LARGE;
      if (bytes === null || bytes.byteLength === 0) return null;
      return { bytes, mime: mime === "" ? OCTET_STREAM : mime, source: "cs-fetch" };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function snapshot(element: ImageElement, maxBytes: number): Promise<LocalBytes | null> {
    const png = await deps.snapshotPng(element);
    if (png === null || png.byteLength === 0 || png.byteLength > maxBytes) return null;
    return { bytes: png, mime: "image/png", source: "cs-canvas" };
  }

  /** The page's own read, then (only when it failed, not when the image is too big) the canvas snapshot. */
  async function fetchOrSnapshot(
    img: HTMLImageElement,
    url: URL,
    credentials: LocalFetchInit["credentials"],
    maxBytes: number,
  ): Promise<LocalBytes | null> {
    const fetched = await fetchBytes(url, credentials, maxBytes);
    if (fetched === TOO_LARGE) return null;
    return fetched ?? (await snapshot(img, maxBytes));
  }

  async function probe(url: URL, maxBytes: number): Promise<LocalBytes | null> {
    const state = probes.get(url.origin);
    if (state === "pending" || state === "failed") return null;
    if (state === undefined) probes.set(url.origin, "pending");
    const result = await fetchBytes(url, "omit", maxBytes);
    // An oversized answer still proves that CORS works for this origin.
    if (state === undefined) probes.set(url.origin, result === null ? "failed" : "ok");
    return result === TOO_LARGE ? null : result;
  }

  async function readImage(
    img: HTMLImageElement,
    src: string,
    options: ReadLocalOptions,
  ): Promise<LocalBytes | null> {
    const maxBytes = Math.max(0, options.maxBytes);
    const base = img.ownerDocument.baseURI;
    const { kind, url } = classifyLocalSource(src, base, deps.pageOrigin(), img.crossOrigin);
    if (url === null) return null;
    switch (kind) {
      case "data": {
        const parsed = parseDataUrl(url.href, maxBytes);
        return parsed === null ? null : { bytes: parsed.bytes, mime: parsed.mime, source: "cs-fetch" };
      }
      case "blob":
      case "same-origin":
        return await fetchOrSnapshot(img, url, "same-origin", maxBytes);
      case "cors-attr":
        return await fetchOrSnapshot(
          img,
          url,
          img.crossOrigin === "use-credentials" ? "include" : "same-origin",
          maxBytes,
        );
      case "cross-origin":
        return options.corsProbe ? await probe(url, maxBytes) : null;
      case "unsupported":
        return null;
    }
  }

  return {
    async read(element: ImageElement, src: string, options: ReadLocalOptions): Promise<LocalBytes | null> {
      try {
        if (element.localName === "canvas") return await snapshot(element, Math.max(0, options.maxBytes));
        return await readImage(element as HTMLImageElement, src, options);
      } catch {
        return null;
      }
    },
  };
}

/* ------------------------------------------------------------------ browser defaults */

/** Untainted canvas, or a loaded image drawn onto an OffscreenCanvas; a tainted source throws SecurityError → null. */
async function snapshotPng(element: ImageElement): Promise<ArrayBuffer | null> {
  try {
    if (element.localName === "canvas") {
      const canvas = element as HTMLCanvasElement;
      if (canvas.width === 0 || canvas.height === 0) return null;
      const blob = await new Promise<Blob | null>((resolve, reject) => {
        try {
          canvas.toBlob(resolve, "image/png");
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return blob === null ? null : await blob.arrayBuffer();
    }
    const img = element as HTMLImageElement;
    if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) return null;
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(img, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return await blob.arrayBuffer();
  } catch {
    return null;
  }
}

let sharedReader: LocalReader | null = null;

/** contracts.ts ReadLocalBytes on the page's own fetch, origin and canvases; one CORS-probe memory per page. */
export const readLocalBytes: ReadLocalBytes = (element, src, options) => {
  sharedReader ??= createLocalReader({
    fetch: (url, init) => fetch(url, init),
    pageOrigin: () => globalThis.origin,
    snapshotPng,
  });
  return sharedReader.read(element, src, options);
};
