// Reader origin (http://127.0.0.1:<port>): fixture pages, their static assets, same-origin images for /canvas/,
// /__fixtures (resolved fixture sets) and POST /__results/<exp>.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import path from "node:path";
import type { Catalog } from "./fixtures.ts";
import { normaliseFmt } from "./fixtures.ts";
import {
  HttpError,
  enumParam,
  mimeFor,
  parseTarget,
  readBody,
  safeFile,
  send,
  sendJson,
  sendText,
} from "./http-util.ts";
import { serveImage } from "./images.ts";
import { imageUrl } from "./pages.ts";
import type { SiteEnv } from "./site.ts";
import { renderIndex, renderSite } from "./site.ts";

export interface ReaderContext extends SiteEnv {
  generatedDir: string;
  resultsDir: string;
  catalog: Catalog;
}

/** Results posted by browser experiments and benchmark scripts; generous, but bounded. */
export const RESULTS_LIMIT = 64 * 1024 * 1024;
const EXPERIMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const SITE = /^\/([a-z0-9][a-z0-9-]*|_shared)(\/.*)?$/;
const STATIC_EXTS = new Set([".js", ".css", ".json", ".svg", ".png", ".jpg", ".webp", ".txt"]);
const ANY_ORIGIN: OutgoingHttpHeaders = { "Access-Control-Allow-Origin": "*" };

export async function handleReader(
  ctx: ReaderContext,
  req: IncomingMessage,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const target = parseTarget(req.url);
  if (target === null) {
    sendText(res, 400, "400 Bad Request: origin-form request target expected");
    return;
  }
  const { path: p, query } = target;
  const method = req.method ?? "GET";

  if (p === "/__results" || p.startsWith("/__results/")) {
    await handleResults(ctx, req, res, p, method);
    return;
  }
  if (method === "OPTIONS") {
    send(res, 204, "", { Allow: "GET, HEAD, OPTIONS" });
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, "405 Method Not Allowed", { Allow: "GET, HEAD, OPTIONS" });
    return;
  }
  if (p === "/favicon.ico") {
    send(res, 204, "", { "Cache-Control": "no-store" });
    return;
  }
  if (p === "/__fixtures") {
    await handleFixtures(ctx, res, query);
    return;
  }
  if (p.startsWith("/img/")) {
    await serveImage({
      req,
      res,
      query,
      base: ctx.generatedDir,
      rawSubPath: p.slice("/img/".length),
      signal,
      readerUrl: ctx.readerUrl,
    });
    return;
  }
  if (p === "/" || p === "/index.html") {
    await renderIndex(ctx, res);
    return;
  }
  const m = SITE.exec(p);
  const site = m?.[1];
  if (m === null || site === undefined || !(await isDir(path.join(ctx.sitesDir, site)))) {
    sendText(res, 404, "404 Not Found");
    return;
  }
  const rest = m[2];
  if (rest === undefined) {
    const search = query.toString();
    send(res, 301, "", {
      Location: `/${site}/${search === "" ? "" : `?${search}`}`,
      "Cache-Control": "no-store",
    });
    return;
  }
  const pageReq = { site, path: p, raw: target.raw, query, servedBy: "reader" as const };
  if (rest === "/" && site !== "_shared") {
    await renderSite(ctx, res, { ...pageReq, file: "index.html" });
    return;
  }
  const sub = rest.slice(1);
  const file = sub === "" ? null : await safeFile(ctx.sitesDir, `${site}/${sub}`);
  if (file !== null && path.extname(file.abs).toLowerCase() === ".html") {
    await renderSite(ctx, res, { ...pageReq, file: sub });
    return;
  }
  if (file !== null && STATIC_EXTS.has(path.extname(file.abs).toLowerCase())) {
    send(res, 200, await readFile(file.abs), {
      "Content-Type": mimeFor(file.abs) ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    return;
  }
  if (site === "spa" && /^\/ch\/\d+\/?$/.test(rest)) {
    // Client-side routes of the SPA fixture: serve the shell, like a framework's history fallback.
    await renderSite(ctx, res, { ...pageReq, file: "index.html" });
    return;
  }
  sendText(res, 404, "404 Not Found");
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function handleResults(
  ctx: ReaderContext,
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  method: string,
): Promise<void> {
  if (method === "OPTIONS") {
    send(res, 204, "", {
      ...ANY_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "content-type",
      "Access-Control-Max-Age": "600",
    });
    return;
  }
  if (method !== "POST") {
    sendText(res, 405, "405 Method Not Allowed: POST a JSON body", { Allow: "POST, OPTIONS", ...ANY_ORIGIN });
    return;
  }
  const exp = decodeSegment(/^\/__results\/([^/]+)$/.exec(p)?.[1]);
  if (exp === null || !EXPERIMENT.test(exp) || exp.includes("..") || WINDOWS_DEVICE.test(exp)) {
    throw new HttpError(400, "experiment name must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}");
  }
  const body = await readBody(req, RESULTS_LIMIT);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  await mkdir(ctx.resultsDir, { recursive: true });
  const file = path.join(ctx.resultsDir, `${exp}.json`);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  sendJson(res, 200, { saved: file }, ANY_ORIGIN);
}

function decodeSegment(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function handleFixtures(
  ctx: ReaderContext,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const set = query.get("set");
  if (set === null) {
    const files = await ctx.catalog.list();
    const sets = await ctx.catalog.names();
    sendJson(res, 200, { dir: ctx.catalog.dir, sets, files: files.map((f) => f.rel) }, ANY_ORIGIN);
    return;
  }
  const prefer = enumParam(query, "prefer", ["single", "sequence"], "single");
  const rawFmt = query.get("fmt");
  const fmt = rawFmt === null ? undefined : (normaliseFmt(rawFmt) ?? undefined);
  const found = await ctx.catalog.resolve(set, { prefer, fmt, requireFmt: query.get("require") === "1" });
  if (found === null) {
    sendJson(res, 404, { error: `no fixture set "${set}" under ${ctx.catalog.dir}` }, ANY_ORIGIN);
    return;
  }
  const images = found.map((im) => ({
    ...im,
    cdn: imageUrl(ctx.cdnUrl, "img", im.file),
    reader: imageUrl(ctx.readerUrl, "img", im.file),
  }));
  sendJson(res, 200, { set, images }, ANY_ORIGIN);
}
