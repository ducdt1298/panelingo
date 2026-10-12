// Image responses for the CDN routes (/img, /protected*, also the reader's same-origin /img used by /canvas/).
// Query knobs: ?delay=<ms> before the headers, ?status=<code>, ?cors=1|*|origin, ?cache=0|1, ?origin=strict.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as sleepTimer } from "node:timers/promises";
import { IMAGE_EXTS } from "./fixtures.ts";
import {
  HttpError,
  enumParam,
  header,
  intParam,
  mimeFor,
  safeFile,
  safeJoin,
  send,
  sendText,
} from "./http-util.ts";

/** Upper bound for ?delay (10 min); slow AI responses are simulated by tools/mock-openai instead. */
export const MAX_DELAY_MS = 600_000;
export const CORS_VALUES = ["0", "1", "true", "*", "origin"] as const;

/** Returns null when the request may pass, otherwise the reason for a 403. */
export type Gate = (req: IncomingMessage) => string | null;

export interface ImageRequest {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  /** Directory holding the generated images. */
  base: string;
  /** Raw (percent-encoded) path below the route prefix. */
  rawSubPath: string;
  signal: AbortSignal;
  readerUrl: string;
  gate?: Gate;
}

export const GATE_COOKIE = "ctv_gate";

/** /protected/: the Referer must start with "<reader>/" (Chrome's default policy sends exactly "<reader>/"). */
export function refererGate(readerUrl: string): Gate {
  return (req) => {
    const referer = header(req, "referer");
    return referer?.startsWith(`${readerUrl}/`) === true ? null : `Referer must start with ${readerUrl}/`;
  };
}

/** /protected-full/: the Referer must be a full reader page URL, i.e. have a path beyond "/". */
export function fullRefererGate(readerUrl: string): Gate {
  return (req) => {
    const referer = header(req, "referer");
    if (referer?.startsWith(`${readerUrl}/`) === true) {
      try {
        if (new URL(referer).pathname.length > 1) {
          return null;
        }
      } catch {
        // malformed Referer falls through to 403
      }
    }
    return `Referer must be a full page URL under ${readerUrl}/ (origin-only is refused)`;
  };
}

/** /protected-cookie/: needs the ctv_gate=1 cookie that /__set-cookie sets. */
export const cookieGate: Gate = (req) =>
  cookies(header(req, "cookie"))[GATE_COOKIE] === "1"
    ? null
    : `cookie ${GATE_COOKIE}=1 required (see /__set-cookie)`;

export function cookies(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** CORS headers requested by ?cors=; none at all unless asked for. */
export function corsHeaders(query: URLSearchParams, req: IncomingMessage): OutgoingHttpHeaders {
  const cors = enumParam(query, "cors", CORS_VALUES, "0");
  if (cors === "0") {
    return {};
  }
  if (cors === "origin") {
    const origin = header(req, "origin");
    return origin === null
      ? { Vary: "Origin" }
      : { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
  }
  return { "Access-Control-Allow-Origin": "*" };
}

/** Waits `ms`; false when the client went away or the server is closing. */
export async function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) {
    return !signal.aborted;
  }
  try {
    await sleepTimer(ms, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

export async function serveImage(r: ImageRequest): Promise<void> {
  const { req, res, query } = r;
  // Validate every knob before waiting, so a typo fails fast with 400.
  const delay = intParam(query, "delay", 0, MAX_DELAY_MS, 0);
  const status = intParam(query, "status", 200, 599, null);
  const cache = enumParam(query, "cache", ["0", "1"], "0");
  const strictOrigin = enumParam(query, "origin", ["strict"], null) !== null;
  const cors = corsHeaders(query, req);
  if (safeJoin(r.base, r.rawSubPath) === null) {
    throw new HttpError(400, "bad image path");
  }
  if (!(await sleep(delay, r.signal))) {
    return;
  }
  const common: OutgoingHttpHeaders = {
    ...cors,
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Timing-Allow-Origin": "*",
  };
  const denied = r.gate?.(req) ?? null;
  if (denied !== null) {
    sendText(res, 403, `403 Forbidden: ${denied}`, common);
    return;
  }
  const origin = header(req, "origin");
  if (strictOrigin && origin !== null && origin !== r.readerUrl) {
    sendText(res, 403, `403 Forbidden: foreign Origin ${origin} (origin=strict)`, common);
    return;
  }
  const forcedOk = status !== null && status >= 200 && status < 300 && status !== 204 && status !== 205;
  if (status !== null && !forcedOk) {
    sendText(res, status, `ctv fixture: forced status ${status}`, common);
    return;
  }
  const ext = path.extname(r.rawSubPath).slice(1).toLowerCase();
  const file = IMAGE_EXTS.includes(ext) ? await safeFile(r.base, r.rawSubPath) : null;
  if (file === null) {
    sendText(res, 404, "404 Not Found", common);
    return;
  }
  const headers: OutgoingHttpHeaders = {
    ...common,
    "Content-Type": mimeFor(file.abs) ?? "application/octet-stream",
  };
  if (cache === "1") {
    const etag = `"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
    headers["Cache-Control"] = "public, max-age=3600";
    headers["ETag"] = etag;
    headers["Last-Modified"] = new Date(file.mtimeMs).toUTCString();
    if (header(req, "if-none-match") === etag) {
      send(res, 304, "", headers);
      return;
    }
  } else {
    headers["Cache-Control"] = "no-store";
  }
  send(res, status ?? 200, await readFile(file.abs), headers);
}
