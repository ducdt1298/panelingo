// CDN request log, readable in-process (requests()) and over HTTP (GET /__log).

import type { IncomingMessage, ServerResponse } from "node:http";
import { header, shortUserAgent } from "./http-util.ts";

export interface CdnLogEntry {
  /** Arrival time, ms since the epoch. */
  t: number;
  method: string;
  /** Path and query as received. */
  path: string;
  referer: string | null;
  origin: string | null;
  cookie: string | null;
  secFetchSite: string | null;
  secFetchMode: string | null;
  secFetchDest: string | null;
  userAgentShort: string | null;
  /** Response status; null while pending (e.g. ?delay) or when the client went away before the headers. */
  status: number | null;
}

/** Oldest entries are dropped beyond this many (a 200-image soak run stays far below). */
export const LOG_LIMIT = 5000;

interface Slot {
  entry: CdnLogEntry;
  /** Live response until it closes; its status is read from here so it is exact as soon as headers are out. */
  res: ServerResponse | null;
}

export class RequestLog {
  #slots: Slot[] = [];

  record(req: IncomingMessage, res: ServerResponse, now: number): void {
    const slot: Slot = {
      entry: {
        t: now,
        method: req.method ?? "GET",
        path: req.url ?? "",
        referer: header(req, "referer"),
        origin: header(req, "origin"),
        cookie: header(req, "cookie"),
        secFetchSite: header(req, "sec-fetch-site"),
        secFetchMode: header(req, "sec-fetch-mode"),
        secFetchDest: header(req, "sec-fetch-dest"),
        userAgentShort: shortUserAgent(req.headers["user-agent"]),
        status: null,
      },
      res,
    };
    this.#slots.push(slot);
    if (this.#slots.length > LOG_LIMIT) {
      this.#slots.splice(0, this.#slots.length - LOG_LIMIT);
    }
    res.once("close", () => {
      slot.entry.status = statusOf(res);
      slot.res = null;
    });
  }

  entries(): CdnLogEntry[] {
    return this.#slots.map(({ entry, res }) => ({
      ...entry,
      status: res === null ? entry.status : statusOf(res),
    }));
  }

  clear(): number {
    const n = this.#slots.length;
    this.#slots = [];
    return n;
  }
}

/** writeHead() sets headersSent synchronously, before any byte can reach the client. */
function statusOf(res: ServerResponse): number | null {
  return res.headersSent ? res.statusCode : null;
}

/** The log's own endpoints are not logged, so reading the log never changes it. */
export function isLogRoute(url: string | undefined): boolean {
  const p = (url ?? "").split("?")[0];
  return p === "/__log" || p === "/__log/clear";
}
