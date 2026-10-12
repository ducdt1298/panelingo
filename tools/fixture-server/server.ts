// Two-origin fixture server for tests, E2E runs and manual checks, node:http only.
//   reader  http://127.0.0.1:<readerPort>  fixture pages from <root>/sites, POST /__results/<exp>
//   CDN     http://localhost:<cdnPort>     images from <root>/generated with Referer/cookie gates and /__log
// The hosts differ on purpose: images are cross-site for the page, as on real readers. Routes: README.md.
//
//   const fx = await createFixtureServer({ root: "test/fixtures", readerPort: 0, cdnPort: 0, quiet: true });
//   ... fx.readerUrl, fx.cdnUrl, fx.requests() ...
//   await fx.close();

import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CdnContext } from "./cdn.ts";
import { handleCdn } from "./cdn.ts";
import { createCatalog } from "./fixtures.ts";
import { HttpError, sendText } from "./http-util.ts";
import type { CdnLogEntry } from "./log.ts";
import { RequestLog, isLogRoute } from "./log.ts";
import type { ReaderContext } from "./reader.ts";
import { handleReader } from "./reader.ts";

export type { CdnLogEntry } from "./log.ts";
export { strictCsp } from "./pages.ts";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_ROOT = path.join(REPO_ROOT, "test", "fixtures");
export const DEFAULT_RESULTS_DIR = path.join(REPO_ROOT, "reports", "fixture-results");

export interface FixtureServerOptions {
  /** Fixture root holding sites/ and generated/ (normally test/fixtures). */
  root: string;
  /** Reader bind address and URL host (default 127.0.0.1). The CDN always binds the loopback addresses of localhost. */
  host?: string;
  /** Default 8080; 0 picks a free port. */
  readerPort?: number;
  /** Default 8081; 0 picks a free port. */
  cdnPort?: number;
  /** Where POST /__results/<exp> writes <exp>.json (default reports/fixture-results). */
  resultsDir?: string;
  /** Suppress the per-request console log. */
  quiet?: boolean;
  /** Overrides <root>/sites (page templates). */
  sitesDir?: string;
  /** Overrides <root>/generated (images). */
  generatedDir?: string;
}

export interface FixtureServer {
  readerUrl: string;
  cdnUrl: string;
  readerPort: number;
  cdnPort: number;
  resultsDir: string;
  /** Snapshot of the CDN request log (oldest first). */
  requests(): CdnLogEntry[];
  clearLog(): void;
  close(): Promise<void>;
}

export async function createFixtureServer(opts: FixtureServerOptions): Promise<FixtureServer> {
  const root = path.resolve(opts.root);
  const host = opts.host ?? "127.0.0.1";
  const quiet = opts.quiet ?? false;
  const generatedDir = path.resolve(opts.generatedDir ?? path.join(root, "generated"));
  const sitesDir = path.resolve(opts.sitesDir ?? path.join(root, "sites"));
  const resultsDir = path.resolve(opts.resultsDir ?? DEFAULT_RESULTS_DIR);
  const catalog = createCatalog(generatedDir);
  const closing = new AbortController();
  const log = new RequestLog();

  // URLs are only known after binding; the handlers read them through the shared context objects.
  const reader: ReaderContext = { readerUrl: "", cdnUrl: "", sitesDir, generatedDir, resultsDir, catalog };
  const cdn: CdnContext = {
    readerUrl: "",
    cdnUrl: "",
    sitesDir,
    generatedDir,
    catalog,
    entries: () => log.entries(),
    clear: () => log.clear(),
  };

  const listener =
    (kind: "reader" | "cdn") =>
    (req: IncomingMessage, res: ServerResponse): void => {
      const started = performance.now();
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      const signal = AbortSignal.any([gone.signal, closing.signal]);
      if (kind === "cdn" && !isLogRoute(req.url)) {
        log.record(req, res, Date.now());
      }
      if (!quiet) {
        res.on("close", () => {
          const status = res.headersSent ? String(res.statusCode) : "---";
          const ms = Math.round(performance.now() - started);
          const ref = req.headers.referer ?? "-";
          console.log(`[${kind}] ${status} ${req.method ?? "?"} ${req.url ?? ""} ${ms}ms ref=${ref}`);
        });
      }
      const handled =
        kind === "cdn" ? handleCdn(cdn, req, res, signal) : handleReader(reader, req, res, signal);
      handled.catch((error: unknown) => fail(res, error));
    };

  const readerServer = http.createServer(listener("reader"));
  const readerPort = await listen(readerServer, opts.readerPort ?? 8080, host);
  let cdnBound: { port: number; servers: Server[] };
  try {
    cdnBound = await listenCdn(opts.cdnPort ?? 8081, listener("cdn"));
  } catch (error) {
    await closeServer(readerServer);
    throw error;
  }
  const servers = [readerServer, ...cdnBound.servers];

  const readerUrl = `http://${urlHost(host)}:${readerPort}`;
  const cdnUrl = `http://localhost:${cdnBound.port}`;
  for (const ctx of [reader, cdn]) {
    ctx.readerUrl = readerUrl;
    ctx.cdnUrl = cdnUrl;
  }

  let closed: Promise<void> | null = null;
  return {
    readerUrl,
    cdnUrl,
    readerPort,
    cdnPort: cdnBound.port,
    resultsDir,
    requests: () => cdn.entries(),
    clearLog: () => {
      cdn.clear();
    },
    close: () => {
      closed ??= (async () => {
        closing.abort(); // ends pending ?delay waits
        await Promise.all(servers.map(closeServer));
      })();
      return closed;
    },
  };
}

function fail(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) {
    sendText(
      res,
      error.status,
      `${error.status} ${error.message}`,
      error.status === 413 ? { Connection: "close" } : {},
    );
    return;
  }
  console.error("[fixture-server]", error);
  sendText(res, 500, "500 Internal Server Error");
}

function urlHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "") {
    return "127.0.0.1";
  }
  return host.includes(":") ? `[${host}]` : host;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server has no TCP address"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Binds the CDN on 127.0.0.1 and [::1] with the same port, so "localhost" works whichever address a client
 * tries first (on Windows a refused ::1 connect stalls for ~2 s before falling back).
 */
async function listenCdn(
  port: number,
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; servers: Server[] }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const v4 = http.createServer(onRequest);
    const bound = await listen(v4, port, "127.0.0.1");
    const v6 = http.createServer(onRequest);
    try {
      await listen(v6, bound, "::1");
      return { port: bound, servers: [v4, v6] };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EADDRINUSE") {
        return { port: bound, servers: [v4] }; // no IPv6 loopback here
      }
      await closeServer(v4);
      if (port !== 0) {
        throw new Error(
          `[::1]:${bound} is used by another process, so localhost:${bound} would be ambiguous`,
          {
            cause: error,
          },
        );
      }
    }
  }
  throw new Error("could not bind the CDN on 127.0.0.1 and [::1] with one port");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
