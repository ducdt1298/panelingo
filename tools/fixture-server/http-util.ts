// Small node:http helpers shared by the reader and CDN handlers.

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function mimeFor(file: string): string | undefined {
  return MIME[path.extname(file).toLowerCase()];
}

export interface ParsedUrl {
  /** Raw (still percent-encoded) path, always starting with "/". */
  path: string;
  query: URLSearchParams;
  /** Path plus query exactly as received, for logs. */
  raw: string;
}

/** Parses the request target without `new URL()`, which would read "//host/x" as a host. Null for non origin-form targets. */
export function parseTarget(url: string | undefined): ParsedUrl | null {
  const raw = url ?? "";
  if (!raw.startsWith("/")) {
    return null;
  }
  const q = raw.indexOf("?");
  const hash = raw.indexOf("#");
  const end = hash < 0 ? raw.length : hash;
  return {
    path: q < 0 || q > end ? raw.slice(0, end) : raw.slice(0, q),
    query: new URLSearchParams(q < 0 || q > end ? "" : raw.slice(q + 1, end)),
    raw,
  };
}

export function send(
  res: ServerResponse,
  status: number,
  body: string | Uint8Array,
  headers: OutgoingHttpHeaders = {},
): void {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const noBody = status === 204 || status === 304;
  res.writeHead(status, noBody ? headers : { "Content-Length": buf.byteLength, ...headers });
  res.end(noBody ? undefined : buf);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  headers: OutgoingHttpHeaders = {},
): void {
  send(res, status, `${text}\n`, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  send(res, status, `${JSON.stringify(value, null, 2)}\n`, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON that is safe inside a <script type="application/json"> or speculationrules block. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\..*)?$/i;

/**
 * Maps a raw URL sub-path (e.g. "chapter-ko-60/001.jpg") onto `base`. Rejects absolute paths, empty segments,
 * "." and "..", encoded separators, drive letters and NTFS streams (":"), NUL and Windows device names.
 * Returns the absolute path, or null when the path is unsafe.
 */
export function safeJoin(base: string, rawSubPath: string): string | null {
  if (rawSubPath === "") {
    return null;
  }
  const segments: string[] = [];
  for (const rawSegment of rawSubPath.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      seg === "" ||
      seg === "." ||
      seg === ".." ||
      /[/\\:\0]/.test(seg) ||
      WINDOWS_DEVICE.test(seg) ||
      seg.trim() !== seg ||
      seg.endsWith(".")
    ) {
      return null;
    }
    segments.push(seg);
  }
  const resolved = path.resolve(base, ...segments);
  const rel = path.relative(base, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

/** Like safeJoin, and the target must be a regular file whose real path (symlinks resolved) stays inside `base`. */
export async function safeFile(
  base: string,
  rawSubPath: string,
): Promise<{ abs: string; size: number; mtimeMs: number } | null> {
  const abs = safeJoin(base, rawSubPath);
  if (abs === null) {
    return null;
  }
  try {
    const [realBase, realAbs] = await Promise.all([realpath(base), realpath(abs)]);
    const rel = path.relative(realBase, realAbs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return null;
    }
    const st = await stat(realAbs);
    return st.isFile() ? { abs: realAbs, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Reads a request body up to `limit` bytes; throws HttpError(413) beyond it. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > limit) {
      throw new HttpError(413, `body larger than ${limit} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Integer query parameter in [min, max]; `fallback` when absent; HttpError(400) when malformed. */
export function intParam(
  q: URLSearchParams,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number;
export function intParam(
  q: URLSearchParams,
  name: string,
  min: number,
  max: number,
  fallback: null,
): number | null;
export function intParam(
  q: URLSearchParams,
  name: string,
  min: number,
  max: number,
  fallback: number | null,
): number | null {
  const raw = q.get(name);
  if (raw === null || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, `${name} must be an integer in [${min}, ${max}]`);
  }
  const n = Number(raw);
  if (n < min || n > max) {
    throw new HttpError(400, `${name} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

/** Enumerated query parameter; `fallback` when absent; HttpError(400) for other values. */
export function enumParam<T extends string>(
  q: URLSearchParams,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T;
export function enumParam<T extends string>(
  q: URLSearchParams,
  name: string,
  allowed: readonly T[],
  fallback: null,
): T | null;
export function enumParam<T extends string>(
  q: URLSearchParams,
  name: string,
  allowed: readonly T[],
  fallback: T | null,
): T | null {
  const raw = q.get(name);
  if (raw === null || raw === "") {
    return fallback;
  }
  const hit = allowed.find((a) => a === raw);
  if (hit === undefined) {
    throw new HttpError(400, `${name} must be one of ${allowed.join(", ")}`);
  }
  return hit;
}

/** Short browser tag for logs: "Chrome/154", "HeadlessChrome/154", "node", or the first 40 characters. */
export function shortUserAgent(ua: string | undefined): string | null {
  if (ua === undefined || ua === "") {
    return null;
  }
  const m = /\b(HeadlessChrome|Edg|OPR|Firefox|Chrome)\/(\d+)/.exec(ua);
  if (m !== null) {
    return `${m[1]}/${m[2]}`;
  }
  return ua.slice(0, 40);
}

export function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (v === undefined) {
    return null;
  }
  return Array.isArray(v) ? v.join(", ") : v;
}
