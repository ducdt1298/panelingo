import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyLocalSource,
  createLocalReader,
  isImageMime,
  mimeOf,
  parseDataUrl,
  percentDecode,
  readLocalBytes,
  type LocalFetchInit,
  type LocalFetchResponse,
  type LocalReader,
  type LocalReaderDeps,
} from "../../../src/content/acquire-local.ts";
import type { ImageElement, LocalBytes } from "../../../src/content/contracts.ts";
import { toBase64 } from "../../../src/shared/wire.ts";

const READER = "https://reader.example";
const PAGE = `${READER}/series/7/chapter/12`;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
const SNAPSHOT = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const MAX = 1024;

/* ------------------------------------------------------------------ fakes */

interface FakeImageInit {
  crossOrigin?: string | null;
  baseURI?: string;
}

function image(init: FakeImageInit = {}): ImageElement {
  const fake = {
    localName: "img",
    crossOrigin: init.crossOrigin ?? null,
    ownerDocument: { baseURI: init.baseURI ?? PAGE },
    complete: true,
    naturalWidth: 10,
    naturalHeight: 10,
  };
  return fake as unknown as ImageElement;
}

function canvas(): ImageElement {
  return { localName: "canvas", width: 10, height: 10 } as unknown as ImageElement;
}

interface Served {
  status?: number;
  type?: string | null;
  length?: string;
  body?: Uint8Array | Uint8Array[];
}

interface Call {
  url: string;
  init: LocalFetchInit;
}

function response(served: Served): LocalFetchResponse {
  const chunks = served.body === undefined ? [PNG] : Array.isArray(served.body) ? served.body : [served.body];
  const headers = new Headers();
  if (served.type !== null) headers.set("content-type", served.type ?? "image/png");
  if (served.length !== undefined) headers.set("content-length", served.length);
  const status = served.status ?? 200;
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }),
  };
}

function reader(
  serve: (url: string, init: LocalFetchInit) => Served | Error | Promise<Served>,
  overrides: Partial<LocalReaderDeps> = {},
): { read: LocalReader["read"]; calls: Call[]; snapshots: ImageElement[] } {
  const calls: Call[] = [];
  const snapshots: ImageElement[] = [];
  const deps: LocalReaderDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const served = await serve(url, init);
      if (served instanceof Error) throw served;
      return response(served);
    },
    pageOrigin: () => READER,
    snapshotPng: (element) => {
      snapshots.push(element);
      return Promise.resolve(SNAPSHOT.slice().buffer);
    },
    ...overrides,
  };
  return { read: createLocalReader(deps).read, calls, snapshots };
}

function bytes(local: LocalBytes | null): number[] | null {
  return local === null ? null : [...new Uint8Array(local.bytes)];
}

const opts = (corsProbe = false, maxBytes = MAX): { maxBytes: number; corsProbe: boolean } => ({
  maxBytes,
  corsProbe,
});

/* ------------------------------------------------------------------ pure helpers */

describe("pure helpers", () => {
  test("mimeOf and isImageMime", () => {
    assert.equal(mimeOf("Image/PNG; charset=binary"), "image/png");
    assert.equal(mimeOf(null), "");
    assert.equal(mimeOf("  "), "");
    for (const ok of ["", "image/webp", "application/octet-stream", "binary/octet-stream"]) {
      assert.equal(isImageMime(ok), true, ok);
    }
    for (const bad of ["text/html", "application/json", "video/mp4"])
      assert.equal(isImageMime(bad), false, bad);
  });

  test("percentDecode works on bytes", () => {
    assert.deepEqual([...percentDecode("abc")], [0x61, 0x62, 0x63]);
    assert.deepEqual([...percentDecode("%89PNG%0d%0A")], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    assert.deepEqual(
      [...percentDecode("%zz%4")],
      [0x25, 0x7a, 0x7a, 0x25, 0x34],
      "invalid escapes stay literal",
    );
    assert.deepEqual([...percentDecode("é")], [0xc3, 0xa9], "non-ASCII becomes UTF-8");
  });
});

describe("parseDataUrl", () => {
  const b64 = toBase64(PNG);

  test("base64 images, with parameters, any case, whitespace and %-escapes", () => {
    const variants = [
      `data:image/png;base64,${b64}`,
      `data:image/png;charset=utf-8;base64,${b64}`,
      `DATA:IMAGE/PNG;BASE64,${b64}`,
      `data:image/png ; base64 ,${b64}`.replace(" ,", ","),
      `data:image/png;base64,${b64.slice(0, 8)}\n${b64.slice(8)}`,
      `data:image/png;base64,${b64.replace(/\+/g, "%2B").replace(/\//g, "%2F").replace(/=/g, "%3D")}`,
    ];
    for (const url of variants) {
      const parsed = parseDataUrl(url, MAX);
      assert.ok(parsed !== null, url);
      assert.equal(parsed.mime, "image/png");
      assert.deepEqual([...new Uint8Array(parsed.bytes)], [...PNG], url);
    }
  });

  test("percent-encoded bodies and a missing type", () => {
    const raw = parseDataUrl("data:application/octet-stream,%89PNG%0D%0A", MAX);
    assert.deepEqual(
      raw === null ? null : [...new Uint8Array(raw.bytes)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a],
    );
    const untyped = parseDataUrl(`data:;base64,${b64}`, MAX);
    assert.equal(untyped?.mime, "application/octet-stream");
  });

  test("refuses non-images, malformed input and oversized payloads", () => {
    const refused = [
      "https://reader.example/x.png",
      "data:image/png;base64",
      "data:text/html,<b>x</b>",
      `data:text/plain;base64,${b64}`,
      "data:image/png;base64,***",
      "data:image/png;base64,",
      "data:image/png,",
      `data:image/png;base64,${toBase64(new Uint8Array(MAX + 1))}`,
      `data:image/png;base64,${"A".repeat(4 * (MAX + 3) + 1)}`,
    ];
    for (const url of refused) assert.equal(parseDataUrl(url, MAX), null, url.slice(0, 60));
    assert.equal(
      parseDataUrl(`data:image/png;base64,${toBase64(new Uint8Array(MAX))}`, MAX)?.bytes.byteLength,
      MAX,
    );
  });
});

describe("classifyLocalSource", () => {
  const cases: Array<[string, string, string | null, string]> = [
    ["data:image/png;base64,AAAA", PAGE, null, "data"],
    ["blob:https://reader.example/9b1e", PAGE, null, "blob"],
    [`${READER}/img/1.png`, PAGE, null, "same-origin"],
    ["/img/1.png", PAGE, null, "same-origin"],
    ["https://reader.example:443/img/1.png", PAGE, null, "same-origin"],
    ["https://cdn.example.net/1.png", PAGE, null, "cross-origin"],
    ["http://reader.example/1.png", PAGE, null, "cross-origin"],
    ["https://cdn.example.net/1.png", PAGE, "anonymous", "cors-attr"],
    ["https://cdn.example.net/1.png", PAGE, "use-credentials", "cors-attr"],
    ["https://cdn.example.net/1.png", "about:blank", null, "cross-origin"],
    ["about:blank", PAGE, null, "unsupported"],
    ["file:///C:/x.png", PAGE, null, "unsupported"],
    ["chrome-extension://abc/x.png", PAGE, null, "unsupported"],
    ["javascript:void(0)", PAGE, null, "unsupported"],
    ["", PAGE, null, "unsupported"],
    ["   ", PAGE, null, "unsupported"],
    ["img/1.png", "about:srcdoc", null, "unsupported"],
  ];
  for (const [src, base, crossOrigin, kind] of cases) {
    test(`${JSON.stringify(src)} (base ${base}, crossorigin ${String(crossOrigin)}) → ${kind}`, () => {
      assert.equal(classifyLocalSource(src, base, READER, crossOrigin).kind, kind);
    });
  }
});

/* ------------------------------------------------------------------ reader */

describe("readLocal", () => {
  test("data: images are decoded locally", async () => {
    const r = reader(() => new Error("no fetch expected"));
    const local = await r.read(image(), `data:image/png;base64,${toBase64(PNG)}`, opts());
    assert.deepEqual(local === null ? null : { mime: local.mime, source: local.source }, {
      mime: "image/png",
      source: "cs-fetch",
    });
    assert.deepEqual(bytes(local), [...PNG]);
    assert.equal(r.calls.length, 0);
    assert.equal(await r.read(image(), "data:text/html,hi", opts()), null);
  });

  test("same-origin images are fetched like the page (credentials, HTTP cache)", async () => {
    const r = reader(() => ({ type: "image/webp" }));
    const local = await r.read(image(), `${READER}/img/1.webp`, opts());
    assert.equal(local?.mime, "image/webp");
    assert.equal(local?.source, "cs-fetch");
    assert.deepEqual(bytes(local), [...PNG]);
    assert.equal(r.calls.length, 1);
    const [call] = r.calls;
    assert.ok(call !== undefined);
    assert.equal(call.url, `${READER}/img/1.webp`);
    assert.deepEqual(
      { ...call.init, signal: undefined },
      {
        method: "GET",
        mode: "cors",
        credentials: "same-origin",
        cache: "force-cache",
        redirect: "follow",
        signal: undefined,
      },
    );
    assert.equal(r.snapshots.length, 0);
  });

  test("relative sources resolve against the document base URL", async () => {
    const r = reader(() => ({}));
    await r.read(image({ baseURI: `${READER}/series/7/` }), "../img/2.png", opts());
    assert.equal(r.calls[0]?.url, `${READER}/series/img/2.png`);
  });

  test("a failed same-origin or blob: fetch falls back to the canvas snapshot", async () => {
    const r = reader((url) => (url.startsWith("blob:") ? new TypeError("Failed to fetch") : { status: 404 }));
    const fromSnapshot = await r.read(image(), `${READER}/img/missing.png`, opts());
    assert.deepEqual(
      fromSnapshot === null ? null : { mime: fromSnapshot.mime, source: fromSnapshot.source },
      { mime: "image/png", source: "cs-canvas" },
    );
    assert.deepEqual(bytes(fromSnapshot), [...SNAPSHOT]);
    const fromBlob = await r.read(image(), "blob:https://reader.example/9b1e", opts());
    assert.equal(fromBlob?.source, "cs-canvas");
    assert.equal(r.snapshots.length, 2);

    const tainted = reader(() => ({ status: 500 }), { snapshotPng: () => Promise.resolve(null) });
    assert.equal(await tainted.read(image(), `${READER}/img/x.png`, opts()), null);
  });

  test("images with a crossorigin attribute are fetched with CORS credentials to match", async () => {
    const r = reader(() => ({}));
    await r.read(image({ crossOrigin: "anonymous" }), "https://cdn.example.net/1.png", opts());
    await r.read(image({ crossOrigin: "use-credentials" }), "https://cdn.example.net/2.png", opts());
    assert.deepEqual(
      r.calls.map((c) => [c.init.mode, c.init.credentials]),
      [
        ["cors", "same-origin"],
        ["cors", "include"],
      ],
    );
  });

  test("cross-origin images: nothing without corsProbe", async () => {
    const r = reader(() => ({}));
    assert.equal(await r.read(image(), "https://cdn.example.net/1.png", opts(false)), null);
    assert.equal(r.calls.length, 0);
    assert.equal(r.snapshots.length, 0, "a cross-origin image would taint the canvas");
  });

  test("one CORS probe per origin per page; a working origin keeps using CORS", async () => {
    const r = reader((url) => (url.startsWith("https://open.example") ? {} : new TypeError("CORS")));
    assert.equal(await r.read(image(), "https://closed.example/1.png", opts(true)), null);
    assert.equal(await r.read(image(), "https://closed.example/2.png", opts(true)), null);
    assert.equal(r.calls.filter((c) => c.url.startsWith("https://closed.example")).length, 1);
    assert.equal(r.calls[0]?.init.credentials, "omit");

    assert.equal((await r.read(image(), "https://open.example/1.png", opts(true)))?.source, "cs-fetch");
    assert.equal((await r.read(image(), "https://open.example/2.png", opts(true)))?.source, "cs-fetch");
    assert.equal(r.calls.filter((c) => c.url.startsWith("https://open.example")).length, 2);
    assert.equal(r.snapshots.length, 0);
  });

  test("images arriving while a probe is pending go to the engine", async () => {
    let release: (served: Served) => void = () => undefined;
    const r = reader(() => new Promise<Served>((resolve) => (release = resolve)));
    const first = r.read(image(), "https://cdn.example.net/1.png", opts(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await r.read(image(), "https://cdn.example.net/2.png", opts(true)), null);
    release({});
    assert.equal((await first)?.source, "cs-fetch");
    assert.equal(r.calls.length, 1);
  });

  test("maxBytes: declared or streamed, the cap is never exceeded and too-large skips the snapshot", async () => {
    const declared = reader(() => ({ length: String(MAX + 1) }));
    assert.equal(await declared.read(image(), `${READER}/a.png`, opts()), null);
    const streamed = reader(() => ({ body: [PNG, new Uint8Array(MAX)] }));
    assert.equal(await streamed.read(image(), `${READER}/b.png`, opts()), null);
    assert.equal(
      declared.snapshots.length + streamed.snapshots.length,
      0,
      "a re-encode would not be smaller",
    );
    const exact = reader(() => ({ body: [PNG, new Uint8Array(MAX - PNG.length)] }));
    assert.equal((await exact.read(image(), `${READER}/c.png`, opts()))?.bytes.byteLength, MAX);
    const bigSnapshot = reader(() => ({ status: 404 }), {
      snapshotPng: () => Promise.resolve(new ArrayBuffer(MAX + 1)),
    });
    assert.equal(await bigSnapshot.read(image(), `${READER}/d.png`, opts()), null);

    const probe = reader(() => ({ length: String(MAX + 1) }));
    assert.equal(await probe.read(image(), "https://cdn.example.net/1.png", opts(true)), null);
    assert.equal(await probe.read(image(), "https://cdn.example.net/2.png", opts(true)), null);
    assert.equal(probe.calls.length, 2, "an oversized answer still proves CORS works for the origin");
  });

  test("non-image responses and empty bodies are refused", async () => {
    const html = reader(() => ({ type: "text/html" }), { snapshotPng: () => Promise.resolve(null) });
    assert.equal(await html.read(image(), `${READER}/a.png`, opts()), null);
    const empty = reader(() => ({ body: [] }), { snapshotPng: () => Promise.resolve(null) });
    assert.equal(await empty.read(image(), `${READER}/b.png`, opts()), null);
    const untyped = reader(() => ({ type: null }));
    assert.equal((await untyped.read(image(), `${READER}/c.png`, opts()))?.mime, "application/octet-stream");
  });

  test("canvases are read through the snapshot; a tainted canvas gives null", async () => {
    const r = reader(() => new Error("no fetch expected"));
    const local = await r.read(canvas(), "", opts());
    assert.equal(local?.source, "cs-canvas");
    assert.equal(local?.mime, "image/png");
    assert.equal(r.calls.length, 0);
    const tainted = reader(() => ({}), { snapshotPng: () => Promise.resolve(null) });
    assert.equal(await tainted.read(canvas(), "", opts()), null);
  });

  test("never throws", async () => {
    const throwing = reader(
      () => {
        throw new Error("sync throw");
      },
      {
        snapshotPng: () => Promise.reject(new Error("SecurityError")),
        pageOrigin: () => READER,
      },
    );
    assert.equal(await throwing.read(image(), `${READER}/a.png`, opts()), null);
    assert.equal(await throwing.read(canvas(), "", opts()), null);
    const brokenOrigin = reader(() => ({}), {
      pageOrigin: () => {
        throw new Error("no origin");
      },
    });
    assert.equal(await brokenOrigin.read(image(), `${READER}/a.png`, opts()), null);
  });

  test("a read that takes longer than the timeout is abandoned", async () => {
    const r = reader(
      (_url, init) =>
        new Promise<Served>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      { timeoutMs: 20, snapshotPng: () => Promise.resolve(null) },
    );
    const started = performance.now();
    assert.equal(await r.read(image(), `${READER}/slow.png`, opts()), null);
    assert.ok(performance.now() - started < 1000);
    assert.equal(r.calls[0]?.init.signal.aborted, true);
  });

  test("readLocalBytes (page defaults) decodes data: URLs without touching the network", async () => {
    const local = await readLocalBytes(image(), `data:image/png;base64,${toBase64(PNG)}`, opts());
    assert.deepEqual(bytes(local), [...PNG]);
    assert.equal(
      await readLocalBytes(canvas(), "", opts()),
      null,
      "no canvas API in Node: null, not a throw",
    );
  });
});
