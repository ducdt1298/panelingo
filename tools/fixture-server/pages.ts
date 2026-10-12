// Reader page models. Each fixture site is test/fixtures/sites/<site>/index.html (plus page scripts); the server
// fills {{PLACEHOLDERS}} with values built here. Image markup is rendered server-side, like a real reader, and the
// same data is embedded as JSON (#ctv-fixture-data) for the page scripts and for E2E assertions.

import type { Catalog, FixtureImage, Prefer } from "./fixtures.ts";
import { isSetName, normaliseFmt } from "./fixtures.ts";
import { HttpError, enumParam, escapeHtml, intParam, jsonForScript } from "./http-util.ts";
import { CORS_VALUES, MAX_DELAY_MS } from "./images.ts";

const REFERRER_POLICIES = [
  "no-referrer",
  "no-referrer-when-downgrade",
  "origin",
  "origin-when-cross-origin",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
] as const;
const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original"] as const;

export type ImageRoute = "img" | "protected" | "protected-full" | "protected-cookie";
export type ServedBy = "reader" | "cdn";

export interface PageEnv {
  readerUrl: string;
  cdnUrl: string;
  catalog: Catalog;
}

export interface PageRequest {
  site: string;
  /** Template file inside the site directory. */
  file: string;
  /** Raw request path (percent-encoded), e.g. "/spa/ch/2". */
  path: string;
  /** Raw path + query, used to rebuild self URLs. */
  raw: string;
  query: URLSearchParams;
  servedBy: ServedBy;
}

export type PageResult =
  | { kind: "page"; vars: Record<string, string>; headers: Record<string, string> }
  | { kind: "redirect"; status: number; location: string };

interface ImageView {
  file: string;
  src: string;
  w: number | null;
  h: number | null;
}

type PageBuilder = (env: PageEnv, req: PageRequest) => Promise<PageResult>;

/** Page builders by site directory; each one owns its defaults (set, lazy mode, ...). */
const SITES: Readonly<Record<string, PageBuilder>> = {
  paged: buildPaged,
  webtoon: buildWebtoon,
  seam: buildSeam,
  webp: buildWebp,
  srcset: buildSrcset,
  protected: buildProtected,
  "protected-full": buildProtected,
  infinite: buildChapters,
  spa: buildChapters,
  canvas: buildCanvas,
  csp: buildCsp,
  iframe: buildIframe,
  prerender: buildPrerender,
};

/** CSP of /csp/: a strict policy that only allows images from the live CDN origin. */
export function strictCsp(cdnUrl: string): string {
  return `default-src 'none'; script-src 'self'; img-src ${cdnUrl}; style-src 'self'; font-src 'none'; require-trusted-types-for 'script'`;
}

export async function buildPage(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const build = SITES[req.site] ?? generic;
  return build(env, req);
}

/** Values every template may use. */
function baseVars(
  env: PageEnv,
  site: string,
  title: string,
  set: string | null,
  policy: string | null,
): Record<string, string> {
  return {
    CDN: env.cdnUrl,
    READER: env.readerUrl,
    TITLE: escapeHtml(set === null ? title : `${title} | ${set}`),
    LANG: langOf(set),
    SET: escapeHtml(set ?? ""),
    PAGE: escapeHtml(site),
    REFERRER_META: policy === null ? "" : `<meta name="referrer" content="${escapeHtml(policy)}" />`,
    IMAGES: "",
  };
}

function page(
  vars: Record<string, string>,
  data: Record<string, unknown>,
  query: URLSearchParams,
  headers: Record<string, string> = {},
): PageResult {
  const nostore = enumParam(query, "nostore", ["0", "1"], "0") === "1";
  return {
    kind: "page",
    vars: { ...vars, DATA: jsonForScript(data) },
    // no-cache rather than no-store, so pages stay eligible for the back/forward cache unless asked otherwise.
    headers: { "Cache-Control": nostore ? "no-store" : "no-cache", ...headers },
  };
}

function langOf(set: string | null): string {
  const m = /(?:^|[-_])(ko|ja|zh|en|es|vi)(?:[-_]|$)/.exec(set ?? "");
  return m?.[1] ?? "en";
}

function setParam(q: URLSearchParams, fallback: string): string {
  const set = q.get("set") ?? fallback;
  if (!isSetName(set)) {
    throw new HttpError(400, "set must match [A-Za-z0-9][A-Za-z0-9._-]*");
  }
  return set;
}

function policyParam(q: URLSearchParams, fallback: string | null): string | null {
  return q.has("policy") ? enumParam(q, "policy", REFERRER_POLICIES, null) : fallback;
}

function fmtParam(q: URLSearchParams): string | undefined {
  const raw = q.get("fmt");
  if (raw === null || raw === "") {
    return undefined;
  }
  const fmt = normaliseFmt(raw);
  if (fmt === null) {
    throw new HttpError(400, "fmt must be one of jpg, png, webp, avif, gif");
  }
  return fmt;
}

async function images(
  env: PageEnv,
  set: string,
  prefer: Prefer,
  fmt: string | undefined,
  requireFmt = false,
): Promise<FixtureImage[]> {
  const found = await env.catalog.resolve(set, { prefer, fmt, requireFmt });
  if (found === null) {
    const what = requireFmt && fmt !== undefined ? `${fmt} images for fixture set` : "fixture set";
    throw new HttpError(404, `No ${what} "${set}" under ${env.catalog.dir}. Run \`npm run fixtures\` first.`);
  }
  return found;
}

/** Query parameters forwarded from the page URL to every image URL it renders. */
interface ImageParams {
  pass: URLSearchParams;
  crossorigin: "anonymous" | "use-credentials" | null;
}

function imageParams(q: URLSearchParams): ImageParams {
  const pass = new URLSearchParams();
  const delay = intParam(q, "delay", 0, MAX_DELAY_MS, null);
  if (delay !== null) {
    pass.set("delay", String(delay));
  }
  const status = intParam(q, "status", 200, 599, null);
  if (status !== null) {
    pass.set("status", String(status));
  }
  const cache = enumParam(q, "cache", ["0", "1"], null);
  if (cache !== null) {
    pass.set("cache", cache);
  }
  const crossorigin = enumParam(q, "crossorigin", ["anonymous", "use-credentials"], null);
  const corsDefault = crossorigin === "anonymous" ? "1" : crossorigin === "use-credentials" ? "origin" : null;
  const cors = enumParam(q, "cors", CORS_VALUES, null) ?? corsDefault;
  if (cors !== null) {
    pass.set("cors", cors);
  }
  const origin = enumParam(q, "origin", ["strict"], null);
  if (origin !== null) {
    pass.set("origin", origin);
  }
  return { pass, crossorigin };
}

export function imageUrl(origin: string, route: ImageRoute, file: string, params?: URLSearchParams): string {
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  const qs = params?.toString() ?? "";
  return `${origin}/${route}/${encoded}${qs === "" ? "" : `?${qs}`}`;
}

function withParam(params: URLSearchParams, name: string, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set(name, value);
  return next;
}

function views(
  list: FixtureImage[],
  origin: string,
  route: ImageRoute,
  params: URLSearchParams,
): ImageView[] {
  return list.map((im) => ({
    file: im.file,
    src: imageUrl(origin, route, im.file, params),
    w: im.w,
    h: im.h,
  }));
}

type AttrValue = string | number | boolean | null | undefined;

function tag(name: string, attrs: Record<string, AttrValue>): string {
  const parts = [name];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    parts.push(value === true ? key : `${key}="${escapeHtml(String(value))}"`);
  }
  return `<${parts.join(" ")}>`;
}

function imgTag(view: ImageView, index: number, extra: Record<string, AttrValue> = {}): string {
  return tag("img", {
    id: `p${index + 1}`,
    class: "page",
    src: view.src,
    width: view.w,
    height: view.h,
    alt: `page ${index + 1}`,
    "data-fixture-file": view.file,
    ...extra,
  });
}

function crossoriginAttr(p: ImageParams): Record<string, AttrValue> {
  return { crossorigin: p.crossorigin };
}

// ---------------------------------------------------------------------------------------------------------------
// Pages

async function buildPaged(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "ko-p01");
  const via = enumParam(q, "via", ["src", "blob", "data"], "src");
  const params = imageParams(q);
  const list = await images(env, set, "single", fmtParam(q));
  // blob:/data: pages fetch the bytes with CORS and hand the element a local URL, like scrambling readers do.
  const fetchParams =
    via === "src" ? params.pass : withParam(params.pass, "cors", params.pass.get("cors") ?? "1");
  const imgs = views(list, env.cdnUrl, "img", fetchParams);
  const markup = imgs
    .map((v, i) =>
      via === "src"
        ? imgTag(v, i, crossoriginAttr(params))
        : imgTag(v, i, { src: null, "data-via": via, "data-fetch-src": v.src }),
    )
    .join("\n");
  const vars = { ...baseVars(env, req.site, "Paged reader", set, policyParam(q, null)), IMAGES: markup };
  return page(vars, { page: req.site, set, via, reader: env.readerUrl, cdn: env.cdnUrl, images: imgs }, q);
}

async function buildWebtoon(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "chapter-ko-60");
  const rawLazy = q.get("lazy") ?? "io";
  const lazy =
    rawLazy === "1" || rawLazy === "true" ? "io" : rawLazy === "0" || rawLazy === "false" ? "none" : rawLazy;
  if (lazy !== "none" && lazy !== "native" && lazy !== "io") {
    throw new HttpError(400, "lazy must be one of none, native, io");
  }
  const margin = intParam(q, "margin", 0, 100_000, 300);
  const attr = enumParam(q, "attr", LAZY_ATTRS, "data-src");
  const placeholder = enumParam(q, "placeholder", ["none", "gif"], "none");
  const mode = enumParam(q, "protected", ["referer", "full", "cookie"], null);
  // none (default): the page's own cross-site <img> requests carry the cookie, as on a logged-in reader;
  // lax: only first-party and extension requests carry it, so the page's images answer 403 too.
  const sameSite = enumParam(q, "samesite", ["lax", "none"], "none");
  if (mode === "cookie" && q.get("cookie") !== "1") {
    // Top-level hop through the CDN so the gate cookie is set first-party, then back here with cookie=1.
    const next = new URL(req.raw, env.readerUrl);
    next.searchParams.set("cookie", "1");
    const hop = new URLSearchParams({ samesite: sameSite, next: next.href });
    return { kind: "redirect", status: 302, location: `${env.cdnUrl}/__set-cookie?${hop.toString()}` };
  }
  const params = imageParams(q);
  const all = await images(env, set, "sequence", fmtParam(q));
  const n = intParam(q, "n", 1, 1000, all.length);
  const route: ImageRoute =
    mode === "referer"
      ? "protected"
      : mode === "full"
        ? "protected-full"
        : mode === "cookie"
          ? "protected-cookie"
          : "img";
  const imgs = views(all.slice(0, n), env.cdnUrl, route, params.pass);
  const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const markup = imgs
    .map((v, i) => {
      if (lazy === "native") {
        return imgTag(v, i, { loading: "lazy", ...crossoriginAttr(params) });
      }
      if (lazy === "none") {
        return imgTag(v, i, crossoriginAttr(params));
      }
      const ratio = v.w !== null && v.h !== null ? `aspect-ratio: ${v.w} / ${v.h}` : null;
      return imgTag(v, i, {
        class: "page lazy",
        src: placeholder === "gif" ? gif : null,
        style: placeholder === "gif" ? ratio : null,
        [attr]: v.src,
        ...crossoriginAttr(params),
      });
    })
    .join("\n");
  const policy = policyParam(q, mode === "full" ? "no-referrer-when-downgrade" : null);
  const vars = { ...baseVars(env, req.site, "Webtoon strip", set, policy), IMAGES: markup };
  const data = {
    page: req.site,
    set,
    lazy,
    margin,
    attr,
    placeholder,
    protected: mode,
    available: all.length,
    reader: env.readerUrl,
    cdn: env.cdnUrl,
    images: imgs,
  };
  return page(vars, data, q);
}

async function buildSeam(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "ko-seam01");
  const gap = intParam(q, "gap", 0, 200, 0);
  const params = imageParams(q);
  const imgs = views(await images(env, set, "sequence", fmtParam(q)), env.cdnUrl, "img", params.pass);
  const markup = imgs
    .map((v, i) =>
      imgTag(v, i, { style: i > 0 && gap > 0 ? `margin-top: ${gap}px` : null, ...crossoriginAttr(params) }),
    )
    .join("\n");
  const vars = {
    ...baseVars(env, req.site, "Seam strip", set, policyParam(q, null)),
    IMAGES: markup,
    GAP: String(gap),
  };
  return page(vars, { page: req.site, set, gap, reader: env.readerUrl, cdn: env.cdnUrl, images: imgs }, q);
}

async function buildWebp(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "ko-strip01");
  const params = imageParams(q);
  const imgs = views(await images(env, set, "sequence", "webp", true), env.cdnUrl, "img", params.pass);
  const markup = imgs.map((v, i) => imgTag(v, i, crossoriginAttr(params))).join("\n");
  const vars = { ...baseVars(env, req.site, "WebP slices", set, policyParam(q, null)), IMAGES: markup };
  return page(vars, { page: req.site, set, reader: env.readerUrl, cdn: env.cdnUrl, images: imgs }, q);
}

async function buildSrcset(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "ko-p01");
  const params = imageParams(q);
  const [view] = views(await images(env, set, "single", fmtParam(q)), env.cdnUrl, "img", params.pass);
  if (view === undefined) {
    throw new HttpError(404, `fixture set "${set}" is empty`);
  }
  const variant = (name: string): string =>
    imageUrl(env.cdnUrl, "img", view.file, withParam(params.pass, "variant", name));
  // 1) density descriptors: same bytes, different URLs, so currentSrc tells which candidate the browser chose.
  const density = imgTag(view, 0, {
    id: "density",
    srcset: `${variant("1x")} 1x, ${variant("2x")} 2x`,
    ...crossoriginAttr(params),
  });
  // 2) <picture> with modern formats first and the default format as the fallback <img>.
  const sources: string[] = [];
  for (const fmt of ["avif", "webp"]) {
    const alt = await env.catalog.resolve(set, { prefer: "single", fmt, requireFmt: true });
    const first = alt?.[0];
    if (first !== undefined && first.file !== view.file) {
      sources.push(
        tag("source", { type: `image/${fmt}`, srcset: imageUrl(env.cdnUrl, "img", first.file, params.pass) }),
      );
    }
  }
  const picture = `<picture id="picture">\n${[...sources, imgTag(view, 1, { id: "picture-img", ...crossoriginAttr(params) })].join("\n")}\n</picture>`;
  const vars = {
    ...baseVars(env, req.site, "srcset and picture", set, policyParam(q, null)),
    IMAGES: density,
    PICTURE: picture,
  };
  return page(vars, { page: req.site, set, reader: env.readerUrl, cdn: env.cdnUrl, images: [view] }, q);
}

async function buildProtected(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const full = req.site === "protected-full";
  const set = setParam(q, "ko-p01");
  const params = imageParams(q);
  const imgs = views(
    await images(env, set, "single", fmtParam(q)),
    env.cdnUrl,
    full ? "protected-full" : "protected",
    params.pass,
  );
  const markup = imgs.map((v, i) => imgTag(v, i, crossoriginAttr(params))).join("\n");
  // Chrome's default policy (strict-origin-when-cross-origin) sends only the origin cross-site, so the full-URL
  // page declares a policy that sends the whole URL; the extension must reproduce that on its retry with the page URL.
  const policy = policyParam(q, full ? "no-referrer-when-downgrade" : null);
  const title = full ? "Full-URL Referer gate" : "Referer-gated CDN";
  const vars = { ...baseVars(env, req.site, title, set, policy), IMAGES: markup };
  return page(vars, { page: req.site, set, policy, reader: env.readerUrl, cdn: env.cdnUrl, images: imgs }, q);
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

/** /infinite/ and /spa/: the set split into chapters of `per` images. */
async function buildChapters(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "chapter-ko-60");
  const per = intParam(q, "per", 1, 500, 10);
  const params = imageParams(q);
  const lazy = enumParam(q, "lazy", ["none", "native"], "none");
  const chapters = chunk(
    views(await images(env, set, "sequence", fmtParam(q)), env.cdnUrl, "img", params.pass),
    per,
  );
  const fromPath = /^\/spa\/ch\/(\d+)\/?$/.exec(req.path)?.[1];
  const requested =
    req.site === "spa" && fromPath !== undefined ? Number(fromPath) : intParam(q, "ch", 1, 10_000, 1);
  const ch = Math.min(Math.max(requested, 1), chapters.length);
  let markup = "";
  if (req.site === "infinite") {
    const first = chapters[ch - 1] ?? [];
    const imgs = first.map((v, i) =>
      imgTag(v, i, {
        id: `c${ch}p${i + 1}`,
        loading: lazy === "native" ? "lazy" : null,
        alt: `chapter ${ch} page ${i + 1}`,
        ...crossoriginAttr(params),
      }),
    );
    markup = `<section class="chapter" data-chapter="${ch}">\n<h2>Chapter ${ch}</h2>\n${imgs.join("\n")}\n</section>`;
  }
  const title = req.site === "spa" ? "SPA reader" : "Infinite chapters";
  const vars = { ...baseVars(env, req.site, title, set, policyParam(q, null)), IMAGES: markup };
  const data = {
    page: req.site,
    set,
    per,
    ch,
    lazy,
    crossorigin: params.crossorigin,
    reader: env.readerUrl,
    cdn: env.cdnUrl,
    chapters,
    images: chapters[ch - 1] ?? [],
  };
  return page(vars, data, q);
}

async function buildCanvas(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "ko-p01");
  // same: same-origin bytes (untainted canvas); cdn: cross-origin without CORS (tainted); cors: CORS-enabled.
  const src = enumParam(q, "src", ["same", "cdn", "cors"], "same");
  const params = imageParams(q);
  const list = await images(env, set, "single", fmtParam(q));
  const imgs =
    src === "same"
      ? views(list, env.readerUrl, "img", params.pass)
      : views(list, env.cdnUrl, "img", src === "cors" ? withParam(params.pass, "cors", "1") : params.pass);
  const vars = baseVars(env, req.site, "Canvas reader", set, policyParam(q, null));
  return page(vars, { page: req.site, set, src, reader: env.readerUrl, cdn: env.cdnUrl, images: imgs }, q);
}

async function buildCsp(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "ko-p01");
  const params = imageParams(q);
  const imgs = views(await images(env, set, "single", fmtParam(q)), env.cdnUrl, "img", params.pass);
  const markup = imgs.map((v, i) => imgTag(v, i, crossoriginAttr(params))).join("\n");
  const vars = { ...baseVars(env, req.site, "Strict CSP reader", set, policyParam(q, null)), IMAGES: markup };
  const data = {
    page: req.site,
    set,
    csp: strictCsp(env.cdnUrl),
    reader: env.readerUrl,
    cdn: env.cdnUrl,
    images: imgs,
  };
  return page(vars, data, q, { "Content-Security-Policy": strictCsp(env.cdnUrl) });
}

async function buildIframe(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  const set = setParam(q, "ko-p01");
  const params = imageParams(q);
  const list = await images(env, set, "single", fmtParam(q));
  // The cross-origin frame lives on the CDN origin and loads its images same-origin there.
  const origin = req.servedBy === "cdn" ? "" : env.cdnUrl;
  const imgs = views(list, origin, "img", params.pass);
  const markup = imgs.map((v, i) => imgTag(v, i, crossoriginAttr(params))).join("\n");
  const setQuery = new URLSearchParams({ set });
  for (const [k, v] of params.pass) {
    setQuery.set(k, v);
  }
  const srcdoc = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>srcdoc frame</title>',
    '<link rel="stylesheet" href="/_shared/fixture.css"></head>',
    `<body class="frame-body">${imgs.map((v, i) => imgTag(v, i, { id: `srcdoc-p${i + 1}` })).join("")}</body></html>`,
  ].join("");
  const vars = {
    ...baseVars(env, req.site, "Frames", set, policyParam(q, null)),
    IMAGES: markup,
    CHILD_SRC: escapeHtml(`/iframe/child.html?${setQuery.toString()}`),
    FRAME_SRC: escapeHtml(`${env.cdnUrl}/frame/?${setQuery.toString()}`),
    SRCDOC: escapeHtml(srcdoc),
  };
  return page(
    vars,
    { page: req.site, set, frame: req.file, reader: env.readerUrl, cdn: env.cdnUrl, images: imgs },
    q,
  );
}

function buildPrerender(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  let target = q.get("target");
  if (target === null || target === "") {
    const t = new URLSearchParams({
      set: setParam(q, "chapter-ko-60"),
      n: String(intParam(q, "n", 1, 1000, 10)),
      lazy: enumParam(q, "lazy", ["none", "native", "io"], "none"),
    });
    target = `/webtoon/?${t.toString()}`;
  } else if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
    throw new HttpError(400, "target must be a same-origin path starting with /");
  }
  const rules = { prerender: [{ source: "list", urls: [target], eagerness: "immediate" }] };
  const vars = {
    ...baseVars(env, req.site, "Prerender", null, policyParam(q, null)),
    TARGET: escapeHtml(target),
    SPECULATION_RULES: jsonForScript(rules),
  };
  return Promise.resolve(
    page(vars, { page: req.site, target, rules, reader: env.readerUrl, cdn: env.cdnUrl, images: [] }, q),
  );
}

/** A site directory without a spec: same vars as /paged/ (single image of ?set=, default ko-p01). */
async function generic(env: PageEnv, req: PageRequest): Promise<PageResult> {
  const q = req.query;
  if (!q.has("set")) {
    return page(
      baseVars(env, req.site, req.site, null, policyParam(q, null)),
      { page: req.site, images: [] },
      q,
    );
  }
  const set = setParam(q, "ko-p01");
  const params = imageParams(q);
  const imgs = views(await images(env, set, "single", fmtParam(q)), env.cdnUrl, "img", params.pass);
  const markup = imgs.map((v, i) => imgTag(v, i, crossoriginAttr(params))).join("\n");
  const vars = { ...baseVars(env, req.site, req.site, set, policyParam(q, null)), IMAGES: markup };
  return page(vars, { page: req.site, set, reader: env.readerUrl, cdn: env.cdnUrl, images: imgs }, q);
}

/** Replaces {{KEY}} with vars[KEY]; unknown keys are left as they are (tests assert none remain). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, key: string) => vars[key] ?? match);
}
