import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  COMIC_FAMILY,
  COMIC_FONT_FILES,
  COMIC_FONT_STACK,
  FONT_FAMILIES,
  FONT_LOAD_TIMEOUT_MS,
  PATRICK_HAND_UNICODE_RANGES,
  ROUND_FAMILY,
  SFX_FAMILY,
  inUnicodeRange,
  loadComicFont,
  loadFaces,
  loadFontFamily,
  parseUnicodeRange,
} from "../../../src/content/fonts.ts";
import type { FontLoaderDeps } from "../../../src/content/fonts.ts";
import { normalizeText } from "../../../src/shared/core/fit-text.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FONTSOURCE = path.join(ROOT, "node_modules", "@fontsource", "patrick-hand");

describe("Patrick Hand subsets", () => {
  test("unicode-range constants equal @fontsource/patrick-hand's own (unicode.json)", () => {
    const upstream = JSON.parse(readFileSync(path.join(FONTSOURCE, "unicode.json"), "utf8")) as Record<
      string,
      string
    >;
    assert.equal(PATRICK_HAND_UNICODE_RANGES.latin, upstream["latin"]);
    assert.equal(PATRICK_HAND_UNICODE_RANGES.vietnamese, upstream["vietnamese"]);
  });

  test("one file per subset, shipped by the build from fontsource", () => {
    assert.deepEqual(
      COMIC_FONT_FILES.map((f) => f.subset),
      ["latin", "vietnamese"],
    );
    const build = readFileSync(path.join(ROOT, "scripts", "build.ts"), "utf8");
    for (const file of COMIC_FONT_FILES) {
      const name = path.posix.basename(file.path);
      assert.ok(file.path.startsWith("assets/fonts/"), file.path);
      assert.ok(existsSync(path.join(FONTSOURCE, "files", name)), `${name} exists in fontsource`);
      assert.ok(build.includes(name), `scripts/build.ts copies ${name}`);
      assert.equal(file.unicodeRange, PATRICK_HAND_UNICODE_RANGES[file.subset]);
    }
  });

  test("latin + vietnamese cover ASCII and every Vietnamese letter as rendered (fitText lines are NFC)", () => {
    const ranges = [
      ...parseUnicodeRange(PATRICK_HAND_UNICODE_RANGES.latin),
      ...parseUnicodeRange(PATRICK_HAND_UNICODE_RANGES.vietnamese),
    ];
    const vowels = "aăâeêioôơuưy";
    const marks = ["", "̀", "́", "̉", "̃", "̣"];
    const letters = new Set<string>(["đ", "Đ"]);
    for (const v of vowels) {
      for (const m of marks) {
        letters.add(`${v}${m}`.normalize("NFC"));
        letters.add(`${v.toUpperCase()}${m}`.normalize("NFC"));
      }
    }
    const text = normalizeText(`${[...letters].join(" ")} ₫“”…–!?.,`.normalize("NFD"));
    for (let c = 0x20; c < 0x7f; c++) assert.ok(inUnicodeRange(ranges, c), `U+${c.toString(16)}`);
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      assert.ok(inUnicodeRange(ranges, cp), `${ch} U+${cp.toString(16)}`);
    }
    assert.equal(inUnicodeRange(ranges, 0xac00), false, "Hangul is not in the font");
  });

  test("parseUnicodeRange reads single points and ranges, rejects anything else", () => {
    assert.deepEqual(parseUnicodeRange("U+0000-00FF, U+0131,u+1ea0-1ef9"), [
      [0, 0xff],
      [0x131, 0x131],
      [0x1ea0, 0x1ef9],
    ]);
    for (const bad of ["U+4??", "0131", "U+00FF-0000", "U+110000", ""]) {
      assert.throws(() => parseUnicodeRange(bad), RangeError, bad);
    }
  });

  test("the font stack names CTV Comic first and ends with a generic family", () => {
    assert.ok(COMIC_FONT_STACK.startsWith(`"${COMIC_FAMILY}"`));
    assert.ok(COMIC_FONT_STACK.endsWith("sans-serif"));
  });
});

/** A FaceLike whose status the fake load() updates. */
interface Face {
  family: string;
  status: string;
  bytes: ArrayBuffer;
  descriptors: FontFaceDescriptors;
  load(): Promise<unknown>;
}

interface Deferred {
  promise: Promise<ArrayBuffer>;
  resolve(value: ArrayBuffer): void;
}

function deferred(): Deferred {
  let resolve: (value: ArrayBuffer) => void = () => undefined;
  const promise = new Promise<ArrayBuffer>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(
  options: {
    failFetch?: string;
    failLoad?: string;
    hold?: Deferred;
    existing?: Face[];
    getURLThrows?: boolean;
  } = {},
) {
  const set: Face[] = [...(options.existing ?? [])];
  const created: Face[] = [];
  const fetched: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const deps: FontLoaderDeps<Face> = {
    fonts: {
      add: (face) => set.push(face),
      forEach: (callback) => set.forEach((face) => callback(face)),
    },
    getURL: (p) => {
      if (options.getURLThrows === true) throw new Error("Extension context invalidated.");
      return `chrome-extension://ctv/${p}`;
    },
    fetchBytes: (url) => {
      fetched.push(url);
      if (options.failFetch !== undefined && url.includes(options.failFetch)) {
        return Promise.reject(new Error("HTTP 404"));
      }
      if (options.hold !== undefined && url.includes("vietnamese")) return options.hold.promise;
      return Promise.resolve(new ArrayBuffer(16));
    },
    createFace: (family, bytes, descriptors) => {
      const face: Face = {
        family: `"${family}"`,
        status: "unloaded",
        bytes,
        descriptors,
        load() {
          if (
            options.failLoad !== undefined &&
            descriptors.unicodeRange?.includes(options.failLoad) === true
          ) {
            face.status = "error";
            return Promise.reject(new Error("OTS parsing error"));
          }
          face.status = "loaded";
          return Promise.resolve(face);
        },
      };
      created.push(face);
      return face;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return { deps, set, created, fetched, timers };
}

describe("loadFaces", () => {
  test("registers both subsets as CTV Comic with their unicode-range, then resolves true", async () => {
    const h = harness();
    assert.equal(await loadFaces(h.deps), true);
    assert.deepEqual(
      h.fetched,
      COMIC_FONT_FILES.map((f) => `chrome-extension://ctv/${f.path}`),
    );
    assert.equal(h.set.length, 2);
    for (const [i, face] of h.created.entries()) {
      assert.equal(face.family, `"${COMIC_FAMILY}"`);
      assert.equal(face.status, "loaded");
      assert.deepEqual(face.descriptors, {
        weight: "400",
        style: "normal",
        unicodeRange: COMIC_FONT_FILES[i]?.unicodeRange,
        display: "block",
      });
    }
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0]?.ms, FONT_LOAD_TIMEOUT_MS);
    assert.equal(h.timers[0]?.cancelled, true);
  });

  test("faces an earlier content script loaded into the document are reused", async () => {
    const first = harness();
    await loadFaces(first.deps);
    const second = harness({ existing: first.set });
    assert.equal(await loadFaces(second.deps), true);
    assert.deepEqual(second.fetched, []);
    assert.equal(second.set.length, 2);
  });

  test("any failed fetch, failed parse or invalidated context → false, nothing registered", async () => {
    for (const options of [{ failFetch: "latin" }, { failLoad: "U+1EA0" }, { getURLThrows: true }]) {
      const h = harness(options);
      assert.equal(await loadFaces(h.deps), false, JSON.stringify(options));
      assert.equal(h.set.length, 0, JSON.stringify(options));
      assert.equal(h.timers[0]?.cancelled, true);
    }
  });

  test("timeout → false, and a late success is never mixed in", async () => {
    const hold = deferred();
    const h = harness({ hold });
    const result = loadFaces(h.deps);
    await new Promise((r) => setImmediate(r));
    h.timers[0]?.fn();
    assert.equal(await result, false);
    hold.resolve(new ArrayBuffer(16));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.set.length, 0);
  });

  test("loadComicFont is single-flight per document and fails soft without an extension context", async () => {
    const doc = { fonts: { add: () => undefined, forEach: () => undefined } } as unknown as Document;
    const first = loadComicFont(doc);
    assert.equal(loadComicFont(doc), first);
    assert.equal(await first, false);
  });
});

describe("font families (CTV Comic, CTV Round, CTV SFX)", () => {
  const PACKAGES = { comic: "patrick-hand", round: "mali", sfx: "bangers" } as const;

  test("each family names its faces, its stack and the files of its fontsource package", () => {
    assert.equal(FONT_FAMILIES.comic.family, COMIC_FAMILY);
    assert.equal(FONT_FAMILIES.round.family, ROUND_FAMILY);
    assert.equal(FONT_FAMILIES.sfx.family, SFX_FAMILY);
    assert.equal(FONT_FAMILIES.comic.files, COMIC_FONT_FILES);
    assert.deepEqual(
      FONT_FAMILIES.round.files.map((f) => `${f.subset} ${f.weight}`),
      ["latin 400", "vietnamese 400", "latin 700", "vietnamese 700"],
    );
    assert.deepEqual(
      FONT_FAMILIES.sfx.files.map((f) => `${f.subset} ${f.weight}`),
      ["latin 400", "vietnamese 400"],
    );
    const build = readFileSync(path.join(ROOT, "scripts", "build.ts"), "utf8");
    for (const [key, pkg] of Object.entries(PACKAGES) as Array<[keyof typeof PACKAGES, string]>) {
      const spec = FONT_FAMILIES[key];
      assert.equal(spec.key, key);
      assert.ok(spec.stack.startsWith(`"${spec.family}", `), spec.stack);
      assert.ok(spec.stack.endsWith("sans-serif"), spec.stack);
      const upstream = JSON.parse(
        readFileSync(path.join(ROOT, "node_modules", "@fontsource", pkg, "unicode.json"), "utf8"),
      ) as Record<string, string>;
      for (const file of spec.files) {
        const name = path.posix.basename(file.path);
        assert.ok(existsSync(path.join(ROOT, "node_modules", "@fontsource", pkg, "files", name)), name);
        assert.ok(build.includes(name), `scripts/build.ts copies ${name}`);
        assert.equal(file.unicodeRange, upstream[file.subset], `${name} unicode-range = ${pkg}'s own`);
      }
    }
  });

  test("CTV Round registers Mali 400 and 700 per subset, all added together", async () => {
    const h = harness();
    assert.equal(await loadFaces(h.deps, FONT_FAMILIES.round), true);
    assert.equal(h.set.length, 4);
    assert.deepEqual(
      h.created.map((face) => [face.family, face.descriptors.weight]),
      [
        [`"${ROUND_FAMILY}"`, "400"],
        [`"${ROUND_FAMILY}"`, "400"],
        [`"${ROUND_FAMILY}"`, "700"],
        [`"${ROUND_FAMILY}"`, "700"],
      ],
    );
    assert.ok(h.fetched.every((url) => url.includes("/mali-")));
  });

  test("one failed file of a family adds none of its faces; other families are independent", async () => {
    const bold = harness({ failFetch: "mali-vietnamese-700" });
    assert.equal(await loadFaces(bold.deps, FONT_FAMILIES.round), false);
    assert.equal(bold.set.length, 0, "never Mali 400 without 700");
    const sfx = harness({ existing: [] });
    assert.equal(await loadFaces(sfx.deps, FONT_FAMILIES.sfx), true);
    assert.deepEqual(
      sfx.created.map((face) => face.family),
      [`"${SFX_FAMILY}"`, `"${SFX_FAMILY}"`],
    );
  });

  test("faces of one family already in the document do not count for another", async () => {
    const comic = harness();
    await loadFaces(comic.deps);
    const round = harness({ existing: comic.set });
    assert.equal(await loadFaces(round.deps, FONT_FAMILIES.round), true);
    assert.equal(round.fetched.length, 4, "Mali is fetched even though CTV Comic is loaded");
  });

  test("loadFontFamily is single-flight per document and family", async () => {
    const doc = { fonts: { add: () => undefined, forEach: () => undefined } } as unknown as Document;
    const round = loadFontFamily(doc, "round");
    assert.equal(loadFontFamily(doc, "round"), round);
    assert.notEqual(loadFontFamily(doc, "sfx"), round);
    assert.equal(loadFontFamily(doc, "comic"), loadComicFont(doc));
    assert.equal(await round, false, "no extension context: fallback fonts");
  });
});
