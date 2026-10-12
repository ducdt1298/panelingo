// Renders a fixture site template (test/fixtures/sites/<site>/<file>.html) with the page model from pages.ts.

import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import type { PageEnv, PageRequest } from "./pages.ts";
import { buildPage, renderTemplate } from "./pages.ts";
import { safeFile, send, sendText } from "./http-util.ts";

export interface SiteEnv extends PageEnv {
  sitesDir: string;
}

export async function renderSite(env: SiteEnv, res: ServerResponse, req: PageRequest): Promise<void> {
  const file = await safeFile(env.sitesDir, `${req.site}/${req.file}`);
  if (file === null) {
    sendText(res, 404, `404 Not Found: no template ${req.site}/${req.file}`);
    return;
  }
  const result = await buildPage(env, req);
  if (result.kind === "redirect") {
    send(res, result.status, `Redirecting to ${result.location}\n`, {
      Location: result.location,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return;
  }
  const template = await readFile(file.abs, "utf8");
  send(res, 200, renderTemplate(template, result.vars), {
    "Content-Type": "text/html; charset=utf-8",
    ...result.headers,
  });
}

/** Renders the root index (sites/index.html), which only needs the two origins. */
export async function renderIndex(env: SiteEnv, res: ServerResponse): Promise<void> {
  const file = await safeFile(env.sitesDir, "index.html");
  if (file === null) {
    sendText(res, 404, "404 Not Found: no sites/index.html");
    return;
  }
  const template = await readFile(file.abs, "utf8");
  send(res, 200, renderTemplate(template, { CDN: env.cdnUrl, READER: env.readerUrl }), {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
}
