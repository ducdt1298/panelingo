// A local mirror of the offline mode models for E2E runs and tools/offline-eval: serves the files of the "offline"
// group of vendor/models.lock.json from .cache/offline-models (npm run fetch-models -- --offline) under the same
// paths as Hugging Face (/<repo>/resolve/<revision>/<path>), so a test build with debug.offlineModelBaseUrl pointing
// here downloads, verifies and caches them exactly as it would from Hugging Face. Only pinned files are served.

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { offlineFiles, readModelsLock } from "../../scripts/lib/models.ts";
import { offlineLocalPath, type OfflineFile } from "../../src/shared/offline/catalog.ts";
import { ROOT } from "./chrome.ts";

export const OFFLINE_CACHE_DIR = path.join(ROOT, ".cache", "offline-models");

export interface OfflineMirror {
  /** Base URL for settings.debug.offlineModelBaseUrl. */
  baseUrl: string;
  /** Paths requested so far (repo/resolve/revision/path), oldest first. */
  requests(): string[];
  close(): Promise<void>;
}

/** Every pinned offline file. */
export function offlineCatalog(): OfflineFile[] {
  return offlineFiles(readModelsLock());
}

/** Local path of a pinned file in .cache/offline-models. */
export function cachedPath(file: OfflineFile): string {
  return path.join(OFFLINE_CACHE_DIR, ...offlineLocalPath(file).split("/"));
}

/** The files of these models that are missing (or have the wrong size) in .cache/offline-models. */
export function missingFiles(models: readonly string[]): OfflineFile[] {
  const wanted = new Set(models);
  return offlineCatalog().filter((file) => {
    if (!wanted.has(file.model)) return false;
    const local = cachedPath(file);
    return !existsSync(local) || statSync(local).size !== file.bytes;
  });
}

export async function startOfflineMirror(): Promise<OfflineMirror> {
  const byUrlPath = new Map<string, OfflineFile>();
  for (const file of offlineCatalog())
    byUrlPath.set(`/${file.repo}/resolve/${file.revision}/${file.path}`, file);
  const log: string[] = [];
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url ?? "/", "http://mirror").pathname);
    const file = byUrlPath.get(urlPath);
    log.push(urlPath);
    if (request.method !== "GET" || file === undefined || !existsSync(cachedPath(file))) {
      response.writeHead(404, { "content-type": "text/plain" }).end("not a cached pinned offline model file");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(file.bytes),
      "access-control-allow-origin": "*",
    });
    createReadStream(cachedPath(file)).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => [...log],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
