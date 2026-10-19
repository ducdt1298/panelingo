// Offline mode model files (docs/OFFLINE-MODE.md): downloaded on first use from their pinned Hugging Face revision
// (or the dev/test mirror of settings.debug.offlineModelBaseUrl), checked against the pinned size and sha256, kept in
// Cache Storage under a key made of the sha256, and read from there afterwards (no network). The "models" integrity
// store remembers which cached files were already hashed, so later engine starts skip hashing hundreds of MB.
//
// Errors: a network failure or an HTTP error status is offline.download (retryable); a size or sha256 mismatch is
// offline.model_integrity (the bad bytes are never kept). Two loads of the same file share one download.

import type { Logger } from "../../platform/log.ts";
import { CtvError, errorMessage } from "../../shared/errors.ts";
import { OFFLINE_CACHE, offlineFileUrl, type OfflineFile } from "../../shared/offline/catalog.ts";
import type { ModelIntegrityRecord } from "../../shared/records.ts";
import type { ModelStore } from "../contracts.ts";

/** ModelIntegrityRecord.verifiedForBuild of offline files (they do not depend on the build). */
export const OFFLINE_VERIFIED = "offline";

/** Cache Storage key of a file: content-addressed, so any mirror or revision with the same bytes shares it. */
export function cacheKey(file: Pick<OfflineFile, "sha256">): string {
  return `https://panelingo.invalid/offline-models/${file.sha256}`;
}

/** ModelStore key of a file. */
export function integrityKey(file: Pick<OfflineFile, "sha256">): string {
  return `offline:${file.sha256}`;
}

export interface BodyReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(reason?: unknown): Promise<void>;
}

/** The part of a fetch Response used here. */
export interface DownloadResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: { getReader(): BodyReaderLike } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type DownloadFetch = (url: string) => Promise<DownloadResponse>;

/** The part of Cache Storage (one opened cache) used here. */
export interface CacheLike {
  match(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | undefined>;
  put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface OfflineModelStoreDeps {
  fetch: DownloadFetch;
  /** The opened cache; null when Cache Storage is unavailable (files are then downloaded on every engine start). */
  openCache: () => Promise<CacheLike | null>;
  integrity: ModelStore;
  /** Base URL of the downloads: Hugging Face, or the dev/test mirror. */
  baseUrl: () => string;
  /** Epoch ms. */
  now: () => number;
  log: Logger;
  /** Lowercase hex sha256; default crypto.subtle. */
  sha256?: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
}

export interface OfflineModelStore {
  /** The verified bytes of a file; `onBytes(n)` reports downloaded bytes as they arrive (0 calls when cached). */
  load(file: OfflineFile, onBytes?: (received: number) => void): Promise<Uint8Array<ArrayBuffer>>;
  /** The file is in the cache (a download is not needed). */
  cached(file: OfflineFile): Promise<boolean>;
}

async function subtleSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cache Storage as CacheLike (the engine's offscreen document and the options page share it). */
export async function openBrowserCache(): Promise<CacheLike | null> {
  if (typeof caches === "undefined") return null;
  const cache = await caches.open(OFFLINE_CACHE);
  return {
    match: async (key) => (await cache.match(key)) ?? undefined,
    put: (key, bytes) =>
      cache.put(
        key,
        new Response(bytes, {
          headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
        }),
      ),
    delete: (key) => cache.delete(key),
  };
}

function downloadError(file: OfflineFile, message: string, status?: number, cause?: unknown): CtvError {
  return new CtvError("offline.download", `${file.repo}/${file.path}: ${message}`, {
    retryable: true,
    detail: file.path,
    ...(status === undefined ? {} : { status }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function integrityError(file: OfflineFile, message: string): CtvError {
  return new CtvError("offline.model_integrity", `${file.repo}/${file.path}: ${message}`, {
    detail: file.path,
  });
}

export function createOfflineModelStore(deps: OfflineModelStoreDeps): OfflineModelStore {
  const hash = deps.sha256 ?? subtleSha256;
  const inFlight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  let cachePromise: Promise<CacheLike | null> | null = null;

  const cache = (): Promise<CacheLike | null> => {
    cachePromise ??= deps.openCache().catch((error: unknown) => {
      deps.log.warn("offline model cache unavailable", { message: errorMessage(error) }, "store.io");
      cachePromise = null;
      return null;
    });
    return cachePromise;
  };

  async function verifiedBefore(file: OfflineFile): Promise<boolean> {
    try {
      const record = await deps.integrity.get(integrityKey(file));
      return (
        record !== undefined &&
        record.ok &&
        record.verifiedForBuild === OFFLINE_VERIFIED &&
        record.sha256 === file.sha256 &&
        record.bytes === file.bytes
      );
    } catch {
      return false;
    }
  }

  async function remember(file: OfflineFile, sha256: string, ok: boolean): Promise<void> {
    const record: ModelIntegrityRecord = {
      file: integrityKey(file),
      sha256,
      bytes: file.bytes,
      verifiedForBuild: OFFLINE_VERIFIED,
      ok,
      verifiedAt: deps.now(),
    };
    try {
      await deps.integrity.put(record);
    } catch (error) {
      deps.log.warn(
        "models store write failed",
        { file: file.path, message: errorMessage(error) },
        "store.io",
      );
    }
  }

  /** The cached bytes when they are complete and verified (hashing them once if no record says so). */
  async function fromCache(file: OfflineFile, opened: CacheLike): Promise<Uint8Array<ArrayBuffer> | null> {
    let buffer: ArrayBuffer;
    try {
      const hit = await opened.match(cacheKey(file));
      if (hit === undefined) return null;
      buffer = await hit.arrayBuffer();
    } catch (error) {
      deps.log.warn(
        "offline model cache read failed",
        { file: file.path, message: errorMessage(error) },
        "store.io",
      );
      return null;
    }
    const bytes = new Uint8Array(buffer);
    if (
      bytes.byteLength === file.bytes &&
      ((await verifiedBefore(file)) || (await hash(bytes)) === file.sha256)
    ) {
      return bytes;
    }
    deps.log.warn("cached offline model is damaged, downloading it again", { file: file.path });
    await opened.delete(cacheKey(file)).catch(() => false);
    return null;
  }

  async function download(
    file: OfflineFile,
    onBytes?: (received: number) => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const url = offlineFileUrl(file, deps.baseUrl());
    const started = deps.now();
    let response: DownloadResponse;
    try {
      response = await deps.fetch(url);
    } catch (error) {
      throw downloadError(file, errorMessage(error), undefined, error);
    }
    if (!response.ok) throw downloadError(file, `HTTP ${response.status}`, response.status);
    const bytes = new Uint8Array(new ArrayBuffer(file.bytes));
    let received = 0;
    try {
      if (response.body === null) {
        const whole = new Uint8Array(await response.arrayBuffer());
        if (whole.byteLength !== file.bytes) {
          throw integrityError(file, `${whole.byteLength} bytes, expected ${file.bytes}`);
        }
        bytes.set(whole);
        received = whole.byteLength;
        onBytes?.(received);
      } else {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;
          if (received + value.byteLength > file.bytes) {
            await reader.cancel().catch(() => undefined);
            throw integrityError(file, `more than the expected ${file.bytes} bytes`);
          }
          bytes.set(value, received);
          received += value.byteLength;
          onBytes?.(received);
        }
      }
    } catch (error) {
      if (error instanceof CtvError) throw error;
      throw downloadError(file, errorMessage(error), undefined, error);
    }
    if (received !== file.bytes) throw integrityError(file, `${received} bytes, expected ${file.bytes}`);
    const actual = await hash(bytes);
    if (actual !== file.sha256) {
      await remember(file, actual, false);
      throw integrityError(file, `sha256 ${actual.slice(0, 12)}… expected ${file.sha256.slice(0, 12)}…`);
    }
    deps.log.info("offline model downloaded", {
      file: `${file.repo}/${file.path}`,
      bytes: file.bytes,
      ms: Math.round(deps.now() - started),
    });
    return bytes;
  }

  async function loadOnce(
    file: OfflineFile,
    onBytes?: (received: number) => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const opened = await cache();
    if (opened !== null) {
      const cached = await fromCache(file, opened);
      if (cached !== null) return cached;
    }
    const bytes = await download(file, onBytes);
    if (opened !== null) {
      try {
        await opened.put(cacheKey(file), bytes);
      } catch (error) {
        deps.log.warn(
          "offline model not cached (it will be downloaded again)",
          { file: file.path, message: errorMessage(error) },
          "store.quota",
        );
      }
    }
    await remember(file, file.sha256, true);
    return bytes;
  }

  return {
    load(file, onBytes) {
      const key = file.sha256;
      let pending = inFlight.get(key);
      if (pending === undefined) {
        pending = loadOnce(file, onBytes).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    },
    async cached(file) {
      const opened = await cache();
      if (opened === null) return false;
      try {
        return (await opened.match(cacheKey(file))) !== undefined;
      } catch {
        return false;
      }
    },
  };
}
