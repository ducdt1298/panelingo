// Lettering fonts for the overlay, registered from the web-accessible woff2 bytes: one FontFace per fontsource subset
// (and weight) with that subset's unicode-range. Chrome ignores @font-face inside shadow roots and url(data:) is
// unreliable under strict page CSPs, so bytes it is. Three families:
// - "CTV Comic": Patrick Hand 400, dialogue and thoughts (the default);
// - "CTV Round": Mali 400 and 700, captions (400), signs (700), and dialogue when settings.render.font is "mali";
// - "CTV SFX": Bangers 400, sound effects.
// Each family loads on first use, once per document; all of its faces are added together or not at all, so a family
// that fails falls back to the system fonts of its stack for measuring and drawing alike.

import { systemClock } from "../shared/clock.ts";

/** Family the overlay renders and measures dialogue with by default. */
export const COMIC_FAMILY = "CTV Comic";
/** Mali: captions, signs, and dialogue with render.font "mali". */
export const ROUND_FAMILY = "CTV Round";
/** Bangers: sound effects. */
export const SFX_FAMILY = "CTV SFX";

/** System fonts after a CTV family: they cover Vietnamese, and a failed load falls back to them. */
const FALLBACK_STACK = `"Comic Sans MS", "Segoe UI", sans-serif`;

/**
 * Font list of the DOM lines and of canvas measureText alike, so a glyph outside both subsets (or a failed load)
 * falls back to the same system font in both.
 */
export const COMIC_FONT_STACK = `"${COMIC_FAMILY}", ${FALLBACK_STACK}`;
export const ROUND_FONT_STACK = `"${ROUND_FAMILY}", ${FALLBACK_STACK}`;
export const SFX_FONT_STACK = `"${SFX_FAMILY}", ${FALLBACK_STACK}`;

/**
 * unicode-range per subset of @fontsource 5.3.0 (unicode.json, the same for patrick-hand, mali and bangers: they
 * come from the same Google Fonts subsetting).
 */
export const FONTSOURCE_UNICODE_RANGES = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC," +
    "U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  vietnamese:
    "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304," +
    "U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
} as const;

/** unicode-range of @fontsource/patrick-hand 5.3.0 per subset (400.css, unicode.json). */
export const PATRICK_HAND_UNICODE_RANGES = FONTSOURCE_UNICODE_RANGES;

export type FontSubset = keyof typeof FONTSOURCE_UNICODE_RANGES;
export type FontWeight = "400" | "700";

export interface FontFile {
  subset: FontSubset;
  /** Extension-relative path; scripts/build.ts copies the fontsource woff2 files to dist/assets/fonts. */
  path: string;
  unicodeRange: string;
  weight: FontWeight;
}

const SUBSETS: readonly FontSubset[] = ["latin", "vietnamese"];

/** The latin and vietnamese files of one fontsource font at these weights, in weight then subset order. */
function fontFiles(font: string, weights: readonly FontWeight[]): FontFile[] {
  return weights.flatMap((weight) =>
    SUBSETS.map((subset) => ({
      subset,
      path: `assets/fonts/${font}-${subset}-${weight}-normal.woff2`,
      unicodeRange: FONTSOURCE_UNICODE_RANGES[subset],
      weight,
    })),
  );
}

export const COMIC_FONT_FILES: readonly FontFile[] = fontFiles("patrick-hand", ["400"]);

export type FamilyKey = "comic" | "round" | "sfx";

export interface FontFamilySpec {
  readonly key: FamilyKey;
  /** The CSS family name the faces are registered under. */
  readonly family: string;
  /** The font list the DOM lines and the canvas measure use. */
  readonly stack: string;
  readonly files: readonly FontFile[];
}

export const FONT_FAMILIES: Readonly<Record<FamilyKey, FontFamilySpec>> = {
  comic: { key: "comic", family: COMIC_FAMILY, stack: COMIC_FONT_STACK, files: COMIC_FONT_FILES },
  round: {
    key: "round",
    family: ROUND_FAMILY,
    stack: ROUND_FONT_STACK,
    files: fontFiles("mali", ["400", "700"]),
  },
  sfx: { key: "sfx", family: SFX_FAMILY, stack: SFX_FONT_STACK, files: fontFiles("bangers", ["400"]) },
};

/** The files are local, so this only trips on a fault; the overlay then renders with the fallback font. */
export const FONT_LOAD_TIMEOUT_MS = 5000;

/** "U+0000-00FF,U+0131" → [[0x0, 0xff], [0x131, 0x131]]. Throws on anything else (no wildcards here). */
export function parseUnicodeRange(list: string): Array<[number, number]> {
  return list.split(",").map((part): [number, number] => {
    const m = /^\s*U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?\s*$/i.exec(part);
    if (m === null) throw new RangeError(`unicode-range: bad item "${part}"`);
    const from = Number.parseInt(m[1] ?? "", 16);
    const to = m[2] === undefined ? from : Number.parseInt(m[2], 16);
    if (to < from || to > 0x10ffff) throw new RangeError(`unicode-range: bad item "${part}"`);
    return [from, to];
  });
}

export function inUnicodeRange(ranges: ReadonlyArray<readonly [number, number]>, codePoint: number): boolean {
  return ranges.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/* ------------------------------------------------------------------ loading */

/** The parts of FontFace the loader uses (a fake in Node tests). */
export interface FaceLike {
  readonly family: string;
  readonly status: string;
  load(): Promise<unknown>;
}

/** The parts of document.fonts the loader uses. */
export interface FaceSetLike<F extends FaceLike> {
  add(face: F): unknown;
  forEach(callback: (face: F) => void): void;
}

export interface FontLoaderDeps<F extends FaceLike> {
  fonts: FaceSetLike<F>;
  getURL(path: string): string;
  fetchBytes(url: string): Promise<ArrayBuffer>;
  createFace(family: string, bytes: ArrayBuffer, descriptors: FontFaceDescriptors): F;
  /** Runs fn after ms; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  timeoutMs?: number;
}

/** FontFace.family as Chrome reports it may carry quotes. */
function bareFamily(name: string): string {
  return name.replace(/^["']|["']$/g, "");
}

/** Faces of `family` already loaded into this document (by an earlier content-script instance). */
function loadedFaces<F extends FaceLike>(fonts: FaceSetLike<F>, family: string): number {
  let count = 0;
  fonts.forEach((face) => {
    if (bareFamily(face.family) === family && face.status === "loaded") count++;
  });
  return count;
}

/**
 * Loads every file of a family (default CTV Comic) and adds the faces to the font set together: true when all are
 * ready, false on any failure or the timeout. A late success after the timeout is dropped, so lines are never
 * measured with one font and drawn with another.
 */
export function loadFaces<F extends FaceLike>(
  deps: FontLoaderDeps<F>,
  spec: FontFamilySpec = FONT_FAMILIES.comic,
): Promise<boolean> {
  if (loadedFaces(deps.fonts, spec.family) >= spec.files.length) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    let cancel: () => void = () => undefined;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      cancel();
      resolve(ok);
    };
    cancel = deps.setTimer(() => finish(false), deps.timeoutMs ?? FONT_LOAD_TIMEOUT_MS);
    Promise.all(
      spec.files.map(async (file) => {
        const bytes = await deps.fetchBytes(deps.getURL(file.path));
        const face = deps.createFace(spec.family, bytes, {
          weight: file.weight,
          style: "normal",
          unicodeRange: file.unicodeRange,
          display: "block",
        });
        await face.load();
        return face;
      }),
    ).then(
      (faces) => {
        if (done) return;
        for (const face of faces) deps.fonts.add(face);
        finish(true);
      },
      () => finish(false),
    );
  });
}

const loads = new WeakMap<Document, Map<FamilyKey, Promise<boolean>>>();

/** Single flight per document and family; false means "render with the fallback fonts of the family's stack". */
export function loadFontFamily(doc: Document, key: FamilyKey): Promise<boolean> {
  let perDoc = loads.get(doc);
  if (perDoc === undefined) {
    perDoc = new Map();
    loads.set(doc, perDoc);
  }
  let pending = perDoc.get(key);
  if (pending === undefined) {
    pending = loadFaces<FontFace>(
      {
        fonts: doc.fonts,
        getURL: (path) => chrome.runtime.getURL(path),
        fetchBytes: async (url) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`font ${url}: HTTP ${res.status}`);
          return res.arrayBuffer();
        },
        createFace: (family, bytes, descriptors) => new FontFace(family, bytes, descriptors),
        setTimer: (fn, ms) => systemClock.setTimer(fn, ms),
      },
      FONT_FAMILIES[key],
    );
    perDoc.set(key, pending);
  }
  return pending;
}

/** CTV Comic (Patrick Hand), single flight per document. */
export function loadComicFont(doc: Document): Promise<boolean> {
  return loadFontFamily(doc, "comic");
}
