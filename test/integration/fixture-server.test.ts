// Two-origin fixture server (tools/fixture-server): gates, CDN knobs, log, pages, results and path safety.
// Uses its own temporary image tree (drawn here: plain ellipses on white), never test/fixtures/generated.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { parseManifest } from "../../tools/fixture-server/fixtures.ts";
import { sniffImageSize } from "../../tools/fixture-server/image-size.ts";
import type { FixtureServer } from "../../tools/fixture-server/server.ts";
import { createFixtureServer, strictCsp } from "../../tools/fixture-server/server.ts";

const SITES = fileURLToPath(new URL("../fixtures/sites", import.meta.url));
const SECRET = "ctv-secret-canary-zq7"; // must never be served

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

interface Req {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Raw request target, sent as is (no URL normalisation). */
  rawPath?: string;
}

/** node:http client: exact control over Referer, Cookie, Origin and raw paths; never follows redirects. */
function request(url: string, opts: Req = {}): Promise<Res> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port,
        path: opts.rawPath ?? `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

async function drawImage(
  file: string,
  w: number,
  h: number,
  format: "png" | "jpeg" | "webp" | "avif",
): Promise<void> {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 3, h / 4, 0, 0, Math.PI * 2);
  ctx.stroke();
  await mkdir(path.dirname(file), { recursive: true });
  switch (format) {
    case "jpeg":
      await writeFile(file, await canvas.encode("jpeg", 90));
      break;
    case "webp":
      await writeFile(file, await canvas.encode("webp", 90));
      break;
    case "avif":
      await writeFile(file, await canvas.encode("avif"));
      break;
    case "png":
      await writeFile(file, await canvas.encode("png"));
      break;
  }
}

function fixtureData(html: string): Record<string, unknown> & { images: { file: string; src: string }[] } {
  const m = /<script type="application\/json" id="ctv-fixture-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m?.[1] !== undefined, "page embeds #ctv-fixture-data");
  return JSON.parse(m[1]) as Record<string, unknown> & { images: { file: string; src: string }[] };
}

function imgTags(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m?.[1]?.replaceAll("&amp;", "&") ?? null;
}

let tmp = "";
let gen = "";
let resultsDir = "";
let fx: FixtureServer;
let reader = "";
let cdn = "";

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "ctv-fixture-server-"));
  gen = path.join(tmp, "generated");
  resultsDir = path.join(tmp, "results");
  await drawImage(path.join(gen, "ko-p01.jpg"), 120, 180, "jpeg");
  await drawImage(path.join(gen, "ko-p01.webp"), 120, 180, "webp");
  await drawImage(path.join(gen, "ko-p01.avif"), 120, 180, "avif");
  await drawImage(path.join(gen, "ko-p01.textmask.png"), 120, 180, "png");
  await drawImage(path.join(gen, "en-p01.png"), 90, 140, "png");
  await drawImage(path.join(gen, "es-p01.png"), 90, 140, "png");
  for (let i = 1; i <= 3; i++) {
    await drawImage(path.join(gen, `ko-strip01-${i}.webp`), 80, 256, "webp");
    await drawImage(path.join(gen, `ko-seam01-${i}.png`), 72, 300, "png");
  }
  // 12 numbered slices; 10 sorts after 9 (natural order), not after 1. The generator also writes a text mask and
  // ground truth next to each image; neither may show up as a page.
  for (let i = 1; i <= 12; i++) {
    await drawImage(path.join(gen, "chapter-ko-60", `${i}.jpg`), 80, 200, "jpeg");
  }
  await drawImage(path.join(gen, "chapter-ko-60", "1.mask.png"), 80, 200, "png");
  await writeFile(path.join(gen, "chapter-ko-60", "1.gt.json"), "{}");
  await writeFile(path.join(gen, "notes.json"), "{}");
  await writeFile(path.join(tmp, "secret.txt"), SECRET);
  await drawImage(path.join(tmp, "outside", "outside.png"), 10, 10, "png");
  await writeFile(path.join(tmp, "outside", "secret.png"), SECRET);
  // A junction (no admin rights needed on Windows) that points out of the image root.
  await symlink(path.join(tmp, "outside"), path.join(gen, "escape"), "junction");

  fx = await createFixtureServer({
    root: tmp,
    sitesDir: SITES,
    readerPort: 0,
    cdnPort: 0,
    resultsDir,
    quiet: true,
  });
  reader = fx.readerUrl;
  cdn = fx.cdnUrl;
});

after(async () => {
  await fx.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("origins", () => {
  test("reader is 127.0.0.1 and the CDN is localhost, on separate ports", () => {
    const r = new URL(reader);
    const c = new URL(cdn);
    assert.equal(r.hostname, "127.0.0.1");
    assert.equal(c.hostname, "localhost");
    assert.notEqual(r.port, c.port);
    assert.equal(fx.readerPort, Number(r.port));
    assert.equal(fx.cdnPort, Number(c.port));
  });

  test("the CDN answers on every loopback address of localhost", async () => {
    const res4 = await request(`http://127.0.0.1:${fx.cdnPort}/img/ko-p01.jpg`);
    assert.equal(res4.status, 200);
    const hasV6 = Object.values(os.networkInterfaces()).some((list) =>
      (list ?? []).some((a) => a.family === "IPv6" && a.internal && a.address === "::1"),
    );
    if (hasV6) {
      const res6 = await request(`http://[::1]:${fx.cdnPort}/img/ko-p01.jpg`);
      assert.equal(res6.status, 200);
    }
  });
});

describe("CDN images", () => {
  test("serve generated images with their content type, no-store and no CORS", async () => {
    const cases = [
      ["ko-p01.jpg", "image/jpeg"],
      ["ko-p01.webp", "image/webp"],
      ["ko-p01.avif", "image/avif"],
      ["en-p01.png", "image/png"],
      ["chapter-ko-60/10.jpg", "image/jpeg"],
    ] as const;
    for (const [file, type] of cases) {
      const res = await request(`${cdn}/img/${file}`);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers["content-type"], type, file);
      assert.equal(res.headers["cache-control"], "no-store", file);
      assert.equal(res.headers["access-control-allow-origin"], undefined, file);
      assert.equal(res.headers["cross-origin-resource-policy"], "cross-origin", file);
      assert.deepEqual(res.body, await readFile(path.join(gen, file)), file);
    }
  });

  test("HEAD answers headers without a body", async () => {
    const res = await request(`${cdn}/img/ko-p01.jpg`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    assert.equal(
      Number(res.headers["content-length"]),
      (await readFile(path.join(gen, "ko-p01.jpg"))).length,
    );
  });

  test("?status forces the response status", async () => {
    assert.equal((await request(`${cdn}/img/ko-p01.jpg?status=503`)).status, 503);
    assert.equal((await request(`${cdn}/img/ko-p01.jpg?status=404`)).status, 404);
    const ok = await request(`${cdn}/img/ko-p01.jpg?status=200`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["content-type"], "image/jpeg");
    for (const bad of ["abc", "99", "700", "-1", "2.5"]) {
      assert.equal((await request(`${cdn}/img/ko-p01.jpg?status=${bad}`)).status, 400, bad);
    }
  });

  test("?delay holds the response back", async () => {
    const t0 = performance.now();
    const res = await request(`${cdn}/img/ko-p01.jpg?delay=200`);
    const elapsed = performance.now() - t0;
    assert.equal(res.status, 200);
    assert.ok(elapsed >= 190, `elapsed ${elapsed} ms`);
    const bad = await request(`${cdn}/img/ko-p01.jpg?delay=soon`);
    assert.equal(bad.status, 400);
    assert.equal((await request(`${cdn}/img/ko-p01.jpg?delay=600001`)).status, 400);
  });

  test("?cors adds CORS headers only when asked", async () => {
    const star = await request(`${cdn}/img/ko-p01.jpg?cors=1`);
    assert.equal(star.headers["access-control-allow-origin"], "*");
    const echo = await request(`${cdn}/img/ko-p01.jpg?cors=origin`, { headers: { Origin: reader } });
    assert.equal(echo.headers["access-control-allow-origin"], reader);
    assert.equal(echo.headers["access-control-allow-credentials"], "true");
    assert.equal(echo.headers["vary"], "Origin");
    assert.equal((await request(`${cdn}/img/ko-p01.jpg?cors=yes`)).status, 400);

    const preflight = await request(`${cdn}/img/ko-p01.jpg?cors=1`, {
      method: "OPTIONS",
      headers: {
        Origin: reader,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "range",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.equal(preflight.headers["access-control-allow-headers"], "range");
    const plain = await request(`${cdn}/img/ko-p01.jpg`, { method: "OPTIONS", headers: { Origin: reader } });
    assert.equal(plain.status, 204);
    assert.equal(plain.headers["access-control-allow-origin"], undefined);
  });

  test("?cache=1 allows caching with validators; default and ?cache=0 are no-store", async () => {
    assert.equal((await request(`${cdn}/img/ko-p01.jpg?cache=0`)).headers["cache-control"], "no-store");
    const cached = await request(`${cdn}/img/ko-p01.jpg?cache=1`);
    assert.equal(cached.headers["cache-control"], "public, max-age=3600");
    const etag = cached.headers.etag;
    assert.ok(typeof etag === "string" && etag.length > 2);
    assert.ok(typeof cached.headers["last-modified"] === "string");
    const revalidated = await request(`${cdn}/img/ko-p01.jpg?cache=1`, {
      headers: { "If-None-Match": etag },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);
    assert.equal((await request(`${cdn}/img/ko-p01.jpg?cache=2`)).status, 400);
  });

  test("missing files, non-image files and unknown routes are 404", async () => {
    assert.equal((await request(`${cdn}/img/nope.jpg`)).status, 404);
    assert.equal((await request(`${cdn}/img/notes.json`)).status, 404);
    assert.equal((await request(`${cdn}/img/chapter-ko-60`)).status, 404);
    assert.equal((await request(`${cdn}/elsewhere`)).status, 404);
    assert.equal((await request(`${cdn}/img/ko-p01.jpg`, { method: "POST" })).status, 405);
  });
});

describe("hotlink gates", () => {
  test("/protected/ needs a Referer that starts with the reader origin and a slash", async () => {
    const url = `${cdn}/protected/ko-p01.jpg`;
    assert.equal((await request(url)).status, 403);
    assert.equal((await request(url, { headers: { Referer: `${reader}/` } })).status, 200);
    assert.equal((await request(url, { headers: { Referer: `${reader}/protected/` } })).status, 200);
    for (const bad of [
      reader,
      `${reader}0/`,
      `${cdn}/`,
      "http://example.test/",
      `${reader.replace("http", "https")}/`,
    ]) {
      assert.equal((await request(url, { headers: { Referer: bad } })).status, 403, bad);
    }
    const ok = await request(url, { headers: { Referer: `${reader}/` } });
    assert.equal(ok.headers["content-type"], "image/jpeg");
    assert.deepEqual(ok.body, await readFile(path.join(gen, "ko-p01.jpg")));
  });

  test("/protected-full/ refuses origin-only Referers", async () => {
    const url = `${cdn}/protected-full/ko-p01.jpg`;
    assert.equal((await request(url)).status, 403);
    assert.equal((await request(url, { headers: { Referer: `${reader}/` } })).status, 403);
    assert.equal((await request(url, { headers: { Referer: `${reader}/protected-full/` } })).status, 200);
    assert.equal(
      (await request(url, { headers: { Referer: `${reader}/webtoon/?set=chapter-ko-60` } })).status,
      200,
    );
    assert.equal((await request(url, { headers: { Referer: `${cdn}/protected-full/` } })).status, 403);
  });

  test("/protected-cookie/ needs ctv_gate=1, which /__set-cookie sets", async () => {
    const url = `${cdn}/protected-cookie/ko-p01.jpg`;
    assert.equal((await request(url)).status, 403);
    assert.equal((await request(url, { headers: { Referer: `${reader}/` } })).status, 403);

    const set = await request(`${cdn}/__set-cookie`);
    assert.equal(set.status, 200);
    const cookie = String(set.headers["set-cookie"]);
    assert.match(cookie, /^ctv_gate=1; /);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/);
    const none = String((await request(`${cdn}/__set-cookie?samesite=none`)).headers["set-cookie"]);
    assert.match(none, /SameSite=None; Secure/);
    assert.equal((await request(`${cdn}/__set-cookie?samesite=strict`)).status, 400);

    assert.equal((await request(url, { headers: { Cookie: "ctv_gate=1" } })).status, 200);
    assert.equal((await request(url, { headers: { Cookie: "a=b; ctv_gate=1; c=d" } })).status, 200);
    assert.equal((await request(url, { headers: { Cookie: "ctv_gate=0" } })).status, 403);
    assert.equal((await request(url, { headers: { Cookie: "xctv_gate=1" } })).status, 403);

    const next = `${reader}/webtoon/?protected=cookie&cookie=1`;
    const hop = await request(`${cdn}/__set-cookie?next=${encodeURIComponent(next)}`);
    assert.equal(hop.status, 302);
    assert.equal(hop.headers.location, next);
    assert.match(String(hop.headers["set-cookie"]), /^ctv_gate=1; /);
    const foreign = await request(`${cdn}/__set-cookie?next=${encodeURIComponent("http://example.test/")}`);
    assert.equal(foreign.status, 400);

    const cleared = await request(`${cdn}/__clear-cookie`);
    assert.match(String(cleared.headers["set-cookie"]), /^ctv_gate=; .*Max-Age=0/);
  });

  test("?origin=strict refuses foreign Origin headers (extension fetches) but not the page's own", async () => {
    const url = `${cdn}/protected/ko-p01.jpg?origin=strict`;
    const referer = `${reader}/protected/`;
    assert.equal((await request(url, { headers: { Referer: referer } })).status, 200);
    assert.equal((await request(url, { headers: { Referer: referer, Origin: reader } })).status, 200);
    const ext = await request(url, {
      headers: { Referer: referer, Origin: "chrome-extension://abcdefghijklmnop" },
    });
    assert.equal(ext.status, 403);
  });

  test("gated requests show up in the log with what the gate saw", async () => {
    fx.clearLog();
    await request(`${cdn}/protected/ko-p01.jpg`, { headers: { Referer: `${reader}/protected/` } });
    await request(`${cdn}/protected/ko-p01.jpg`);
    const log = fx.requests();
    assert.equal(log.length, 2);
    assert.deepEqual(
      log.map((e) => [e.path, e.referer, e.status]),
      [
        ["/protected/ko-p01.jpg", `${reader}/protected/`, 200],
        ["/protected/ko-p01.jpg", null, 403],
      ],
    );
  });
});

describe("redirect", () => {
  test("/redirect?to= answers 302 with that Location", async () => {
    const to = "http://127.0.0.1:8099/x.png";
    const res = await request(`${cdn}/redirect?to=${encodeURIComponent(to)}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, to);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    const local = await request(
      `${cdn}/redirect?to=${encodeURIComponent("/img/ko-p01.jpg")}&status=307&cors=1`,
    );
    assert.equal(local.status, 307);
    assert.equal(local.headers.location, "/img/ko-p01.jpg");
    assert.equal(local.headers["access-control-allow-origin"], "*");
  });

  test("/redirect rejects missing or non-http targets and unknown codes", async () => {
    assert.equal((await request(`${cdn}/redirect`)).status, 400);
    for (const to of ["javascript:alert(1)", "//example.test/x", "file:///C:/x", "not a url"]) {
      assert.equal((await request(`${cdn}/redirect?to=${encodeURIComponent(to)}`)).status, 400, to);
    }
    assert.equal((await request(`${cdn}/redirect?to=%2Fimg%2Fko-p01.jpg&status=300`)).status, 400);
  });
});

describe("request log", () => {
  test("records referer, origin, cookie, sec-fetch-site, a short user agent and the status", async () => {
    fx.clearLog();
    await request(`${cdn}/img/ko-p01.jpg?cors=1`, {
      headers: {
        Referer: `${reader}/paged/`,
        Origin: reader,
        Cookie: "ctv_gate=1",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HeadlessChrome/154.0.8037.98",
      },
    });
    await request(`${cdn}/img/missing.jpg`);
    const [first, second, ...rest] = fx.requests();
    assert.equal(rest.length, 0);
    assert.ok(first !== undefined && second !== undefined);
    assert.ok(Math.abs(first.t - Date.now()) < 60_000);
    assert.deepEqual(
      { ...first, t: 0 },
      {
        t: 0,
        method: "GET",
        path: "/img/ko-p01.jpg?cors=1",
        referer: `${reader}/paged/`,
        origin: reader,
        cookie: "ctv_gate=1",
        secFetchSite: "cross-site",
        secFetchMode: "cors",
        secFetchDest: "empty",
        userAgentShort: "HeadlessChrome/154",
        status: 200,
      },
    );
    assert.equal(second.status, 404);
    assert.equal(second.referer, null);
  });

  test("GET /__log serves the same entries and is not logged itself; POST /__log/clear empties it", async () => {
    fx.clearLog();
    await request(`${cdn}/img/ko-p01.jpg`);
    const res = await request(`${cdn}/__log`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    const entries = JSON.parse(res.text) as unknown[];
    assert.deepEqual(entries, fx.requests());
    assert.equal(entries.length, 1);
    assert.equal((await request(`${cdn}/__log/clear`)).status, 405);
    const cleared = await request(`${cdn}/__log/clear`, { method: "POST" });
    assert.deepEqual(JSON.parse(cleared.text), { cleared: 1 });
    assert.deepEqual(fx.requests(), []);
  });

  test("a request still waiting on ?delay has status null, also after the client gives up", async () => {
    fx.clearLog();
    const pending = new Promise<string>((resolve) => {
      const req = http.get(`http://127.0.0.1:${fx.cdnPort}/img/ko-p01.jpg?delay=30000`, { agent: false });
      req.on("error", (error) => resolve(error.message));
      setTimeout(() => req.destroy(new Error("client gave up")), 100);
    });
    while (fx.requests().length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(fx.requests()[0]?.status, null);
    assert.equal(await pending, "client gave up");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fx.requests()[0]?.status, null);
  });
});

describe("reader pages", () => {
  async function page(pathAndQuery: string): Promise<{ res: Res; data: ReturnType<typeof fixtureData> }> {
    const res = await request(`${reader}${pathAndQuery}`);
    assert.equal(res.status, 200, `${pathAndQuery}: ${res.text.slice(0, 200)}`);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.doesNotMatch(res.text, /\{\{[A-Z_]+\}\}/, `${pathAndQuery} leaves a placeholder`);
    return { res, data: fixtureData(res.text) };
  }

  test("every fixture page renders, and every image it references is served", async () => {
    const pages = [
      "/paged/",
      "/paged/?set=en-p01",
      "/webtoon/",
      "/webtoon/?lazy=native",
      "/webtoon/?lazy=none&n=3",
      "/seam/?gap=4",
      "/webp/",
      "/srcset/",
      "/protected/",
      "/protected-full/",
      "/infinite/",
      "/spa/",
      "/spa/ch/2",
      "/canvas/",
      "/csp/",
      "/iframe/",
      "/iframe/child.html?set=ko-p01",
      "/prerender/",
    ];
    for (const p of pages) {
      const { res, data } = await page(p);
      assert.equal(res.headers["cache-control"], "no-cache", p);
      for (const im of data.images) {
        const gated = /\/protected(?:-full)?\//.test(im.src) ? { Referer: `${reader}${p}` } : undefined;
        const img = await request(im.src, gated === undefined ? {} : { headers: gated });
        assert.equal(img.status, 200, `${p} -> ${im.src}`);
      }
    }
    const root = await request(`${reader}/`);
    assert.equal(root.status, 200);
    assert.ok(root.text.includes(`${cdn}/__log`));
    assert.doesNotMatch(root.text, /\{\{[A-Z_]+\}\}/);
  });

  test("/paged/ shows one page image from the CDN with its natural size", async () => {
    const { res, data } = await page("/paged/?set=ko-p01");
    const [tag, ...more] = imgTags(res.text);
    assert.equal(more.length, 0);
    assert.ok(tag !== undefined);
    assert.equal(attr(tag, "src"), `${cdn}/img/ko-p01.jpg`);
    assert.equal(attr(tag, "width"), "120");
    assert.equal(attr(tag, "height"), "180");
    assert.equal(attr(tag, "data-fixture-file"), "ko-p01.jpg");
    assert.equal(data["set"], "ko-p01");
    assert.match(res.text, /<html lang="ko"/);
    assert.match((await page("/paged/?set=es-p01")).res.text, /<html lang="es"/);

    const webp = imgTags((await page("/paged/?set=ko-p01&fmt=webp")).res.text)[0] ?? "";
    assert.equal(attr(webp, "src"), `${cdn}/img/ko-p01.webp`);
    const blob = imgTags((await page("/paged/?via=blob")).res.text)[0] ?? "";
    assert.equal(attr(blob, "src"), null);
    assert.equal(attr(blob, "data-fetch-src"), `${cdn}/img/ko-p01.jpg?cors=1`);
    const co = imgTags((await page("/paged/?crossorigin=anonymous&delay=5")).res.text)[0] ?? "";
    assert.equal(attr(co, "crossorigin"), "anonymous");
    assert.equal(attr(co, "src"), `${cdn}/img/ko-p01.jpg?delay=5&cors=1`);
  });

  test("/webtoon/ lazy modes: none, native loading=lazy, IntersectionObserver data-src", async () => {
    const none = await page("/webtoon/?set=chapter-ko-60&n=3&lazy=none");
    const tags = imgTags(none.res.text);
    assert.deepEqual(
      tags.map((t) => attr(t, "src")),
      ["1.jpg", "2.jpg", "3.jpg"].map((f) => `${cdn}/img/chapter-ko-60/${f}`),
    );
    assert.ok(tags.every((t) => attr(t, "width") === "80" && attr(t, "height") === "200"));

    const native = imgTags((await page("/webtoon/?n=2&lazy=native")).res.text);
    assert.ok(native.length === 2 && native.every((t) => attr(t, "loading") === "lazy"));

    const io = await page("/webtoon/?n=12&lazy=io&margin=500");
    const ioTags = imgTags(io.res.text);
    assert.equal(ioTags.length, 12);
    assert.ok(ioTags.every((t) => attr(t, "src") === null && attr(t, "data-src")?.startsWith(`${cdn}/img/`)));
    assert.equal(attr(ioTags[9] ?? "", "data-src"), `${cdn}/img/chapter-ko-60/10.jpg`); // natural order
    assert.equal(io.data["lazy"], "io");
    assert.equal(io.data["margin"], 500);
    assert.equal(io.data["available"], 12);

    const alt =
      imgTags((await page("/webtoon/?n=1&lazy=1&attr=data-original&placeholder=gif")).res.text)[0] ?? "";
    assert.ok(attr(alt, "data-original")?.endsWith("/img/chapter-ko-60/1.jpg"));
    assert.match(attr(alt, "src") ?? "", /^data:image\/gif;base64,/);
    assert.equal(attr(alt, "style"), "aspect-ratio: 80 / 200");

    assert.equal(imgTags((await page("/webtoon/?n=500")).res.text).length, 12);
    for (const bad of ["n=0", "lazy=eager", "margin=-5", "attr=src", "protected=yes", "set=..%2Fx"]) {
      assert.equal((await request(`${reader}/webtoon/?${bad}`)).status, 400, bad);
    }
  });

  test("/webtoon/?protected= routes the images through the gates", async () => {
    const ref = await page("/webtoon/?n=2&lazy=none&protected=referer");
    assert.ok(imgTags(ref.res.text).every((t) => attr(t, "src")?.startsWith(`${cdn}/protected/`)));
    const full = await page("/webtoon/?n=2&lazy=none&protected=full");
    assert.ok(imgTags(full.res.text).every((t) => attr(t, "src")?.startsWith(`${cdn}/protected-full/`)));
    assert.match(full.res.text, /<meta name="referrer" content="no-referrer-when-downgrade" \/>/);
    const slow = await page("/webtoon/?n=1&lazy=none&delay=1500&cache=1");
    assert.equal(
      attr(imgTags(slow.res.text)[0] ?? "", "src"),
      `${cdn}/img/chapter-ko-60/1.jpg?delay=1500&cache=1`,
    );
  });

  test("/webtoon/?protected=cookie hops through /__set-cookie, then loads /protected-cookie/ images", async () => {
    const first = await request(`${reader}/webtoon/?n=2&lazy=none&protected=cookie`);
    assert.equal(first.status, 302);
    const hop = new URL(String(first.headers.location));
    assert.equal(hop.origin, cdn);
    assert.equal(hop.pathname, "/__set-cookie");
    assert.equal(hop.searchParams.get("samesite"), "none");
    const next = hop.searchParams.get("next") ?? "";
    assert.equal(next, `${reader}/webtoon/?n=2&lazy=none&protected=cookie&cookie=1`);

    const setter = await request(hop.href);
    assert.equal(setter.status, 302);
    assert.equal(setter.headers.location, next);
    assert.match(String(setter.headers["set-cookie"]), /^ctv_gate=1; .*SameSite=None; Secure/);

    const final = await page(new URL(next).pathname + new URL(next).search);
    const srcs = imgTags(final.res.text).map((t) => attr(t, "src") ?? "");
    assert.equal(srcs.length, 2);
    assert.ok(srcs.every((s) => s.startsWith(`${cdn}/protected-cookie/chapter-ko-60/`)));
    assert.equal((await request(srcs[0] ?? "")).status, 403);
    assert.equal((await request(srcs[0] ?? "", { headers: { Cookie: "ctv_gate=1" } })).status, 200);

    const lax = await request(`${reader}/webtoon/?protected=cookie&samesite=lax`);
    assert.equal(new URL(String(lax.headers.location)).searchParams.get("samesite"), "lax");
  });

  test("/seam/ stacks the seam slices with the requested gap", async () => {
    const gap4 = imgTags((await page("/seam/?gap=4")).res.text);
    assert.deepEqual(
      gap4.map((t) => attr(t, "data-fixture-file")),
      ["ko-seam01-1.png", "ko-seam01-2.png", "ko-seam01-3.png"],
    );
    assert.deepEqual(
      gap4.map((t) => attr(t, "style")),
      [null, "margin-top: 4px", "margin-top: 4px"],
    );
    assert.ok(imgTags((await page("/seam/?gap=0")).res.text).every((t) => attr(t, "style") === null));
    assert.equal((await request(`${reader}/seam/?gap=999`)).status, 400);
  });

  test("/webp/ shows the WebP slices; a set without WebP is 404", async () => {
    const tags = imgTags((await page("/webp/")).res.text);
    assert.deepEqual(
      tags.map((t) => attr(t, "src")),
      [1, 2, 3].map((i) => `${cdn}/img/ko-strip01-${i}.webp`),
    );
    assert.ok(tags.every((t) => attr(t, "width") === "80" && attr(t, "height") === "256"));
    const none = await request(`${reader}/webp/?set=chapter-ko-60`);
    assert.equal(none.status, 404);
  });

  test("/srcset/ has density candidates and a picture with AVIF and WebP sources", async () => {
    const { res } = await page("/srcset/");
    const density = imgTags(res.text).find((t) => attr(t, "id") === "density") ?? "";
    assert.equal(
      attr(density, "srcset"),
      `${cdn}/img/ko-p01.jpg?variant=1x 1x, ${cdn}/img/ko-p01.jpg?variant=2x 2x`,
    );
    const picture = /<picture id="picture">([\s\S]*?)<\/picture>/.exec(res.text)?.[1] ?? "";
    assert.match(picture, new RegExp(`<source type="image/avif" srcset="${cdn}/img/ko-p01.avif">`));
    assert.match(picture, new RegExp(`<source type="image/webp" srcset="${cdn}/img/ko-p01.webp">`));
    assert.equal(attr(imgTags(picture)[0] ?? "", "src"), `${cdn}/img/ko-p01.jpg`);
  });

  test("/protected/ and /protected-full/ pages load through their gates", async () => {
    const plain = await page("/protected/");
    assert.equal(attr(imgTags(plain.res.text)[0] ?? "", "src"), `${cdn}/protected/ko-p01.jpg`);
    assert.doesNotMatch(plain.res.text, /<meta name="referrer"/);
    const full = await page("/protected-full/");
    assert.equal(attr(imgTags(full.res.text)[0] ?? "", "src"), `${cdn}/protected-full/ko-p01.jpg`);
    assert.match(full.res.text, /<meta name="referrer" content="no-referrer-when-downgrade" \/>/);
    const origin = await page("/protected-full/?policy=origin");
    assert.match(origin.res.text, /<meta name="referrer" content="origin" \/>/);
    assert.equal((await request(`${reader}/protected-full/?policy=everything`)).status, 400);
  });

  test("/infinite/ renders the first chapter and embeds the rest", async () => {
    const { res, data } = await page("/infinite/?per=5");
    assert.match(res.text, /<section class="chapter" data-chapter="1">/);
    assert.equal(imgTags(res.text).length, 5);
    assert.equal(attr(imgTags(res.text)[0] ?? "", "id"), "c1p1");
    const chapters = data["chapters"] as unknown[][];
    assert.deepEqual(
      chapters.map((c) => c.length),
      [5, 5, 2],
    );
    assert.match(res.text, /<div id="sentinel"/);
    const third = await page("/infinite/?per=5&ch=3");
    assert.match(third.res.text, /data-chapter="3"/);
    assert.equal(imgTags(third.res.text).length, 2);
  });

  test("/spa/ serves the same shell for every client route, with data-reactroot", async () => {
    const deep = await page("/spa/ch/2?per=4");
    assert.match(deep.res.text, /<div id="root" data-reactroot=""><\/div>/);
    assert.equal(deep.data["ch"], 2);
    assert.equal(imgTags(deep.res.text).length, 0); // rendered by script
    assert.equal((await page("/spa/")).data["ch"], 1);
    assert.equal((await request(`${reader}/spa/ch/x`)).status, 404);
    const script = await request(`${reader}/spa/page.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
  });

  test("/canvas/ draws same-origin images by default; src=cors|cdn use the CDN", async () => {
    const same = await page("/canvas/");
    assert.equal(imgTags(same.res.text).length, 0);
    assert.equal(same.data["src"], "same");
    const src = same.data.images[0]?.src ?? "";
    assert.equal(src, `${reader}/img/ko-p01.jpg`);
    const bytes = await request(src);
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers["content-type"], "image/jpeg");
    assert.equal((await page("/canvas/?src=cors")).data.images[0]?.src, `${cdn}/img/ko-p01.jpg?cors=1`);
    assert.equal((await page("/canvas/?src=cdn")).data.images[0]?.src, `${cdn}/img/ko-p01.jpg`);
  });

  test("/csp/ sends the strict CSP and stays clean under it", async () => {
    const { res } = await page("/csp/");
    const expected = `default-src 'none'; script-src 'self'; img-src ${cdn}; style-src 'self'; font-src 'none'; require-trusted-types-for 'script'`;
    assert.equal(res.headers["content-security-policy"], expected);
    assert.equal(strictCsp(cdn), expected);
    for (const script of res.text.match(/<script\b[^>]*>/g) ?? []) {
      assert.ok(
        /\ssrc="\/[^/]/.test(script) || script.includes('type="application/json"'),
        `inline script would be blocked: ${script}`,
      );
    }
    assert.doesNotMatch(res.text, /\sstyle="/);
    assert.doesNotMatch(res.text, /\son[a-z]+="/);
    assert.ok(imgTags(res.text).every((t) => attr(t, "src")?.startsWith(`${cdn}/`)));
    assert.equal((await request(`${reader}/paged/`)).headers["content-security-policy"], undefined);
  });

  test("/iframe/ has same-origin, about:blank, srcdoc and cross-origin frames", async () => {
    const { res } = await page("/iframe/");
    const frames = res.text.match(/<iframe\b[^>]*>/g) ?? [];
    const byId = (id: string): string => frames.find((f) => attr(f, "id") === id) ?? "";
    assert.equal(attr(byId("same-frame"), "src"), "/iframe/child.html?set=ko-p01");
    assert.equal(attr(byId("blank-frame"), "src"), null);
    assert.equal(attr(byId("cross-frame"), "src"), `${cdn}/frame/?set=ko-p01`);
    const srcdoc = /srcdoc="([^"]*)"/.exec(byId("srcdoc-frame"))?.[1] ?? "";
    assert.ok(srcdoc.startsWith("&lt;!doctype html&gt;"), srcdoc);
    assert.ok(srcdoc.includes(`src=&quot;${cdn}/img/ko-p01.jpg&quot;`), srcdoc);

    const child = await page("/iframe/child.html?set=ko-p01");
    assert.equal(attr(imgTags(child.res.text)[0] ?? "", "src"), `${cdn}/img/ko-p01.jpg`);
    const cross = await request(`${cdn}/frame/?set=ko-p01`);
    assert.equal(cross.status, 200);
    assert.equal(cross.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(attr(imgTags(cross.text)[0] ?? "", "src"), "/img/ko-p01.jpg"); // same-origin inside the frame
    assert.ok(cross.text.includes(`${reader}/_shared/fixture.css`));
    assert.equal((await request(`${cdn}/frame?set=ko-p01`)).status, 301);
  });

  test("/prerender/ asks for a prerender of a /webtoon/ chapter and links to it", async () => {
    const { res, data } = await page("/prerender/?n=3");
    const rulesText = /<script type="speculationrules">([\s\S]*?)<\/script>/.exec(res.text)?.[1] ?? "";
    const rules = JSON.parse(rulesText) as { prerender: { source: string; urls: string[] }[] };
    const target = "/webtoon/?set=chapter-ko-60&n=3&lazy=none";
    assert.deepEqual(rules.prerender[0]?.urls, [target]);
    assert.equal(rules.prerender[0]?.source, "list");
    assert.ok(res.text.includes(`<a id="activate" href="${target.replaceAll("&", "&amp;")}">`));
    assert.equal(data["target"], target);
    const custom = await page("/prerender/?target=%2Fpaged%2F%3Fset%3Den-p01");
    assert.ok(custom.res.text.includes('"urls":["/paged/?set=en-p01"]'));
    assert.equal((await request(`${reader}/prerender/?target=%2F%2Fexample.test%2F`)).status, 400);
  });

  test("unknown routes, fixture sets and methods", async () => {
    assert.equal((await request(`${reader}/nope/`)).status, 404);
    assert.equal((await request(`${reader}/paged/nope.js`)).status, 404);
    const missing = await request(`${reader}/paged/?set=zz-p99`);
    assert.equal(missing.status, 404);
    assert.match(missing.text, /npm run fixtures/);
    assert.equal((await request(`${reader}/paged/?set=a%20b`)).status, 400);
    const slashless = await request(`${reader}/paged?set=en-p01`);
    assert.equal(slashless.status, 301);
    assert.equal(slashless.headers.location, "/paged/?set=en-p01");
    assert.equal((await request(`${reader}/paged/`, { method: "DELETE" })).status, 405);
    assert.equal((await request(`${reader}/favicon.ico`)).status, 204);
  });

  test("?nostore=1 opts a page out of caching entirely", async () => {
    assert.equal((await page("/paged/?nostore=1")).res.headers["cache-control"], "no-store");
  });

  test("/__fixtures resolves sets the way the pages do", async () => {
    const seq = JSON.parse(
      (await request(`${reader}/__fixtures?set=chapter-ko-60&prefer=sequence`)).text,
    ) as {
      images: { file: string; w: number; h: number; cdn: string }[];
    };
    assert.deepEqual(
      seq.images.map((i) => i.file),
      Array.from({ length: 12 }, (_, i) => `chapter-ko-60/${i + 1}.jpg`),
    );
    assert.deepEqual([seq.images[0]?.w, seq.images[0]?.h], [80, 200]);
    assert.equal(seq.images[0]?.cdn, `${cdn}/img/chapter-ko-60/1.jpg`);
    const single = JSON.parse((await request(`${reader}/__fixtures?set=ko-p01`)).text) as {
      images: { file: string }[];
    };
    assert.deepEqual(
      single.images.map((i) => i.file),
      ["ko-p01.jpg"],
    );
    const all = JSON.parse((await request(`${reader}/__fixtures`)).text) as { files: string[] };
    assert.ok(all.files.includes("ko-p01.textmask.png"));
    assert.equal((await request(`${reader}/__fixtures?set=zz-p99`)).status, 404);
  });
});

describe("results", () => {
  test("POST /__results/<exp> saves pretty-printed JSON in the results dir", async () => {
    const body = { experiment: "upload-sizes", ok: true, sizes: [65536, 1048576], nested: { p50: 12.5 } };
    const res = await request(`${reader}/__results/upload-sizes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    const file = path.join(resultsDir, "upload-sizes.json");
    assert.deepEqual(JSON.parse(res.text), { saved: file });
    assert.equal(await readFile(file, "utf8"), `${JSON.stringify(body, null, 2)}\n`);

    await request(`${reader}/__results/upload-sizes`, { method: "POST", body: "[1,2]" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [1, 2]);
    const dotted = await request(`${reader}/__results/detector.sweep_a`, { method: "POST", body: "{}" });
    assert.equal(dotted.status, 200);
    assert.equal(await readFile(path.join(resultsDir, "detector.sweep_a.json"), "utf8"), "{}\n");
  });

  test("rejects bad bodies, bad names and other methods", async () => {
    const post = (name: string, body = "{}"): Promise<Res> =>
      request(`${reader}/__results/x`, { method: "POST", body, rawPath: `/__results/${name}` });
    assert.equal((await post("bad-json", "{nope")).status, 400);
    assert.equal((await post("empty", "")).status, 400);
    for (const name of ["..%2Fescape", "a%2Fb", "%2e%2e", "CON", "nul.txt", ".hidden", "a/b", "", "a%5Cb"]) {
      assert.equal((await post(name)).status, 400, name);
    }
    assert.equal((await request(`${reader}/__results/upload-sizes`)).status, 405);
    const preflight = await request(`${reader}/__results/upload-sizes`, {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://abc", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-methods"], "POST, OPTIONS");
    assert.equal(preflight.headers["access-control-allow-headers"], "content-type");
    await assert.rejects(readFile(path.join(tmp, "escape.json")));
  });
});

describe("path safety", () => {
  test("CDN image routes refuse traversal, absolute paths and junction escapes", async () => {
    const raw = [
      "/img/../secret.txt",
      "/img/..%2fsecret.txt",
      "/img/%2e%2e/secret.txt",
      "/img/%2E%2E%2Fsecret.txt",
      "/img/..%5csecret.txt",
      "/img/..\\secret.txt",
      "/img/chapter-ko-60/../../secret.txt",
      "/img//etc/passwd",
      "/img/%2Fetc%2Fpasswd",
      "/img/C:%5CWindows%5Cwin.ini",
      "/img/C:/Windows/win.ini",
      "/img/ko-p01.jpg%00.png",
      "/img/escape/secret.png",
      "/img/escape/outside.png",
      "/protected/../secret.txt",
      "/img/",
    ];
    for (const rawPath of raw) {
      const res = await request(`${cdn}/`, { rawPath, headers: { Referer: `${reader}/` } });
      assert.ok(res.status === 400 || res.status === 404, `${rawPath} -> ${res.status}`);
      assert.ok(!res.text.includes(SECRET), rawPath);
    }
  });

  test("reader static routes refuse traversal", async () => {
    const raw = [
      "/paged/../../secret.txt",
      "/paged/..%2f..%2f..%2fsecret.txt",
      "/_shared/%2e%2e/%2e%2e/%2e%2e/secret.txt",
      "/img/../../secret.txt",
      "//secret.txt",
      "/spa/..%2f..%2fsecret.txt",
    ];
    for (const rawPath of raw) {
      const res = await request(`${reader}/`, { rawPath });
      assert.ok(res.status === 400 || res.status === 404, `${rawPath} -> ${res.status}`);
      assert.ok(!res.text.includes(SECRET), rawPath);
    }
    const css = await request(`${reader}/_shared/fixture.css`);
    assert.equal(css.status, 200);
    assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
  });
});

describe("generator manifest", () => {
  const manifestFile = (): string => path.join(gen, "manifest.json");
  const manifest = {
    generator: "test",
    fixtures: [
      {
        name: "demo-chapter",
        images: [
          { image: "chapter-ko-60/3.jpg", width: 80, height: 200, units: 2 },
          { image: "chapter-ko-60/1.jpg", width: 80, height: 200, units: 0 },
        ],
      },
      { name: "partial", images: ["chapter-ko-60/2.jpg", "not-written-yet.png", "../secret.txt"] },
      { name: "demo-page", images: [{ image: "ko-p01.jpg" }] },
      { name: "only-junk", images: ["/abs.png", "a\\b.png", "C:/x.png", "a/../b.png"] },
    ],
  };

  before(async () => {
    await writeFile(manifestFile(), JSON.stringify(manifest));
  });
  after(async () => {
    await rm(manifestFile(), { force: true });
  });

  test("declared sets keep the generator's order and sizes", async () => {
    const res = await request(`${reader}/webtoon/?set=demo-chapter&lazy=none`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      imgTags(res.text).map((t) => [attr(t, "data-fixture-file"), attr(t, "width"), attr(t, "height")]),
      [
        ["chapter-ko-60/3.jpg", "80", "200"],
        ["chapter-ko-60/1.jpg", "80", "200"],
      ],
    );
    const partial = await request(`${reader}/webtoon/?set=partial&lazy=none`);
    assert.deepEqual(
      imgTags(partial.text).map((t) => attr(t, "data-fixture-file")),
      ["chapter-ko-60/2.jpg"],
    );
    assert.equal((await request(`${reader}/paged/?set=only-junk`)).status, 404);
  });

  test("a requested format swaps in the sibling file, and falls back to file names when there is none", async () => {
    const webp = await request(`${reader}/paged/?set=demo-page&fmt=webp`);
    assert.equal(attr(imgTags(webp.text)[0] ?? "", "src"), `${cdn}/img/ko-p01.webp`);
    const plain = await request(`${reader}/paged/?set=demo-page`);
    assert.equal(attr(imgTags(plain.text)[0] ?? "", "src"), `${cdn}/img/ko-p01.jpg`);
    assert.equal((await request(`${reader}/webp/?set=demo-chapter`)).status, 404);
  });

  test("/__fixtures lists the declared sets; undeclared names still resolve by file name", async () => {
    const all = JSON.parse((await request(`${reader}/__fixtures`)).text) as { sets: string[] };
    assert.deepEqual(all.sets, ["demo-chapter", "partial", "demo-page"]);
    assert.equal(imgTags((await request(`${reader}/webtoon/?set=chapter-ko-60&lazy=none`)).text).length, 12);
  });

  test("a broken manifest is ignored until it is fixed", async () => {
    await writeFile(manifestFile(), "{ half-written");
    assert.equal((await request(`${reader}/webtoon/?set=demo-chapter`)).status, 404);
    assert.equal((await request(`${reader}/webtoon/?set=chapter-ko-60`)).status, 200);
    await writeFile(manifestFile(), JSON.stringify(manifest, null, 2));
    assert.equal((await request(`${reader}/webtoon/?set=demo-chapter`)).status, 200);
  });

  test("parseManifest accepts strings and {image} records and drops unsafe paths", () => {
    const sets = parseManifest({
      fixtures: [
        {
          name: "a",
          images: ["x/1.png", { image: "x/2.png", width: 3, height: 4 }, { image: "x/3.png", width: "3" }],
        },
        { name: "b", images: ["../up.png", "/root.png", "c:/drive.png", "x//y.png"] },
        { name: 7, images: ["x.png"] },
        { images: ["x.png"] },
        "junk",
      ],
    });
    assert.deepEqual([...sets.keys()], ["a"]);
    assert.deepEqual(sets.get("a"), [
      { image: "x/1.png" },
      { image: "x/2.png", width: 3, height: 4 },
      { image: "x/3.png" },
    ]);
    assert.equal(parseManifest(null).size, 0);
    assert.equal(parseManifest({ fixtures: "nope" }).size, 0);
  });
});

describe("image size sniffing", () => {
  test("reads the size of real PNG, JPEG, WebP (VP8X) and AVIF files", async () => {
    for (const [file, type] of [
      ["ko-p01.jpg", "jpeg"],
      ["ko-p01.webp", "webp"],
      ["ko-p01.avif", "avif"],
      ["ko-p01.textmask.png", "png"],
    ] as const) {
      assert.deepEqual(sniffImageSize(await readFile(path.join(gen, file))), { w: 120, h: 180, type }, file);
    }
  });

  test("handles lossy VP8, lossless VP8L, GIF, EXIF-rotated JPEG and junk", () => {
    const riff = (chunk: string, payload: number[]): Uint8Array =>
      Uint8Array.from([
        ...Buffer.from("RIFF"),
        0,
        0,
        0,
        0,
        ...Buffer.from("WEBP"),
        ...Buffer.from(chunk),
        payload.length,
        0,
        0,
        0,
        ...payload,
      ]);
    // VP8: frame tag, start code 9d 01 2a, 14-bit width and height (little endian).
    const vp8 = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0xc0, 0x12]);
    assert.deepEqual(sniffImageSize(vp8), { w: 800, h: 4800, type: "webp" });
    // VP8L: signature 0x2f, then (w-1) and (h-1) in 14 bits each.
    const bits = (720 - 1) | ((9000 - 1) << 14);
    const vp8l = riff("VP8L", [
      0x2f,
      bits & 0xff,
      (bits >>> 8) & 0xff,
      (bits >>> 16) & 0xff,
      (bits >>> 24) & 0xff,
    ]);
    assert.deepEqual(sniffImageSize(vp8l), { w: 720, h: 9000, type: "webp" });
    const gif = Uint8Array.from([...Buffer.from("GIF89a"), 0x20, 0x03, 0x00, 0x0a, 0, 0, 0]);
    assert.deepEqual(sniffImageSize(gif), { w: 800, h: 2560, type: "gif" });

    // JPEG: SOI, APP1 Exif (little-endian TIFF, orientation 6 = rotated 90 degrees), SOF0 800x600.
    const tiff = [
      0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 1, 0, 0, 0, 6, 0, 0, 0,
    ];
    const exif = [...Buffer.from("Exif"), 0, 0, ...tiff, 0, 0, 0, 0];
    const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
    const sof = [
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    ];
    const rotated = Uint8Array.from([0xff, 0xd8, ...app1, ...sof]);
    assert.deepEqual(sniffImageSize(rotated), { w: 600, h: 800, type: "jpeg" });
    const upright = Uint8Array.from([0xff, 0xd8, ...sof]);
    assert.deepEqual(sniffImageSize(upright), { w: 800, h: 600, type: "jpeg" });

    assert.equal(sniffImageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
    assert.equal(sniffImageSize(new TextEncoder().encode("not an image")), null);
    assert.equal(sniffImageSize(new Uint8Array(0)), null);
  });
});

describe("lifecycle", () => {
  test("close() ends responses that are still waiting on ?delay", async () => {
    const own = await createFixtureServer({
      root: tmp,
      sitesDir: SITES,
      readerPort: 0,
      cdnPort: 0,
      resultsDir,
      quiet: true,
    });
    const outcome = new Promise<string>((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${own.cdnPort}/img/ko-p01.jpg?delay=60000`,
        { agent: false },
        (res) => resolve(`status ${res.statusCode ?? 0}`),
      );
      req.on("error", (error) => resolve(`error ${error.message}`));
    });
    while (own.requests().length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const t0 = performance.now();
    await own.close();
    assert.ok(performance.now() - t0 < 2000, "close() did not wait for the delay");
    assert.match(await outcome, /^error /);
    await own.close(); // idempotent
  });

  test("fixed ports that are taken fail with EADDRINUSE", async () => {
    await assert.rejects(
      createFixtureServer({ root: tmp, sitesDir: SITES, readerPort: fx.readerPort, cdnPort: 0, quiet: true }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "EADDRINUSE",
    );
  });
});
