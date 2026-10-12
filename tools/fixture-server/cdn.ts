// CDN origin (http://localhost:<port>, a different site from the reader on purpose): images with hotlink gates,
// redirects, the gate cookie, the cross-origin frames for /iframe/ and /capture/iframe.html, and the request log.

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import {
  HttpError,
  enumParam,
  header,
  intParam,
  parseTarget,
  send,
  sendJson,
  sendText,
} from "./http-util.ts";
import type { Gate } from "./images.ts";
import { GATE_COOKIE, cookieGate, corsHeaders, fullRefererGate, refererGate, serveImage } from "./images.ts";
import type { CdnLogEntry } from "./log.ts";
import type { SiteEnv } from "./site.ts";
import { renderSite } from "./site.ts";

export interface CdnContext extends SiteEnv {
  generatedDir: string;
  entries(): CdnLogEntry[];
  clear(): number;
}

const IMAGE_ROUTE = /^\/(img|protected|protected-full|protected-cookie)\/(.*)$/;
const REDIRECT_CODES = [301, 302, 303, 307, 308];

/** /frame/capture/<set>.html: the capture-only canvas page of sites/capture/, on the CDN origin. */
const CAPTURE_FRAME = /^\/frame\/capture\/([A-Za-z0-9][A-Za-z0-9._-]*\.html)$/;

export async function handleCdn(
  ctx: CdnContext,
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
  const anyOrigin: OutgoingHttpHeaders = { "Access-Control-Allow-Origin": "*" };

  if (p === "/__log") {
    if (method !== "GET" && method !== "HEAD") {
      sendText(res, 405, "405 Method Not Allowed", { Allow: "GET, HEAD", ...anyOrigin });
      return;
    }
    sendJson(res, 200, ctx.entries(), anyOrigin);
    return;
  }
  if (p === "/__log/clear") {
    if (method !== "POST") {
      sendText(res, 405, "405 Method Not Allowed: POST to clear", { Allow: "POST", ...anyOrigin });
      return;
    }
    sendJson(res, 200, { cleared: ctx.clear() }, anyOrigin);
    return;
  }
  if (method === "OPTIONS") {
    preflight(req, res, query);
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

  const route = IMAGE_ROUTE.exec(p);
  if (route !== null) {
    const kind = route[1];
    const gate: Gate | undefined =
      kind === "protected"
        ? refererGate(ctx.readerUrl)
        : kind === "protected-full"
          ? fullRefererGate(ctx.readerUrl)
          : kind === "protected-cookie"
            ? cookieGate
            : undefined;
    await serveImage({
      req,
      res,
      query,
      base: ctx.generatedDir,
      rawSubPath: route[2] ?? "",
      signal,
      readerUrl: ctx.readerUrl,
      ...(gate === undefined ? {} : { gate }),
    });
    return;
  }

  const captureFrame = CAPTURE_FRAME.exec(p)?.[1];
  if (captureFrame !== undefined) {
    // A capture-only canvas page served cross-origin (sites/capture/<set>.html), for reader-iframe captures.
    await renderSite(ctx, res, {
      site: "capture",
      file: captureFrame,
      path: p,
      raw: target.raw,
      query,
      servedBy: "cdn",
    });
    return;
  }

  switch (p) {
    case "/redirect":
      redirect(req, res, query);
      return;
    case "/__set-cookie":
      setCookie(ctx.readerUrl, req, res, query);
      return;
    case "/__clear-cookie":
      sendText(res, 200, `${GATE_COOKIE} cleared`, {
        "Set-Cookie": `${GATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
        ...corsHeaders(query, req),
      });
      return;
    case "/frame": {
      const search = query.toString();
      send(res, 301, "", {
        Location: `/frame/${search === "" ? "" : `?${search}`}`,
        "Cache-Control": "no-store",
      });
      return;
    }
    case "/frame/":
    case "/frame/index.html":
      // Cross-origin frame of /iframe/ (template sites/iframe/frame.html), images same-origin on the CDN.
      await renderSite(ctx, res, {
        site: "iframe",
        file: "frame.html",
        path: p,
        raw: target.raw,
        query,
        servedBy: "cdn",
      });
      return;
    default:
      sendText(res, 404, "404 Not Found");
  }
}

function preflight(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const cors = corsHeaders(query, req);
  if (Object.keys(cors).length === 0 || !("Access-Control-Allow-Origin" in cors)) {
    send(res, 204, "", { Allow: "GET, HEAD, OPTIONS", ...cors });
    return;
  }
  send(res, 204, "", {
    ...cors,
    Allow: "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": header(req, "access-control-request-headers") ?? "",
    "Access-Control-Max-Age": "0",
  });
}

/** GET /redirect?to=<url>[&status=301|302|303|307|308]: used to check that guards also apply after redirects. */
function redirect(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const to = query.get("to");
  let ok = false;
  if (to !== null && to.startsWith("/") && !to.startsWith("//") && !to.includes("\\")) {
    ok = true;
  } else if (to !== null) {
    try {
      const url = new URL(to);
      ok = url.protocol === "http:" || url.protocol === "https:";
    } catch {
      ok = false;
    }
  }
  if (to === null || !ok) {
    throw new HttpError(400, "to must be an absolute http(s) URL or a path starting with /");
  }
  const status = intParam(query, "status", 300, 399, 302);
  if (!REDIRECT_CODES.includes(status)) {
    throw new HttpError(400, `status must be one of ${REDIRECT_CODES.join(", ")}`);
  }
  send(res, status, `Redirecting to ${to}\n`, {
    Location: to,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(query, req),
  });
}

/**
 * GET /__set-cookie[?samesite=lax|none][&next=<reader URL>] sets ctv_gate=1 for /protected-cookie/.
 *   lax (default): enough for the point of the route, which is that extension fetches with credentials:'omit'
 *     get 403 (and 'include' gets 200: extension requests with host permissions count as same-site). The reader
 *     page's own cross-site <img> requests do not carry a Lax cookie, so they get 403 as well.
 *   none: SameSite=None; Secure. Secure normally needs https, but Chrome treats http://localhost as potentially
 *     trustworthy: on Chrome 154 the cookie is stored and sent on the reader's cross-site image requests (while
 *     third-party cookies are allowed, the default). /webtoon/?protected=cookie uses this.
 * With next (a reader URL) the answer is a 302 to it: a top-level hop that sets the cookie first-party.
 */
function setCookie(
  readerUrl: string,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): void {
  const sameSite = enumParam(query, "samesite", ["lax", "none"], "lax");
  const attrs = sameSite === "none" ? "SameSite=None; Secure" : "SameSite=Lax";
  const cookie = `${GATE_COOKIE}=1; Path=/; HttpOnly; ${attrs}`;
  const next = query.get("next");
  if (next !== null) {
    if (!next.startsWith(`${readerUrl}/`)) {
      throw new HttpError(400, `next must start with ${readerUrl}/`);
    }
    send(res, 302, `Redirecting to ${next}\n`, {
      Location: next,
      "Set-Cookie": cookie,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return;
  }
  sendText(res, 200, `${GATE_COOKIE}=1 set (${attrs})`, { "Set-Cookie": cookie, ...corsHeaders(query, req) });
}
