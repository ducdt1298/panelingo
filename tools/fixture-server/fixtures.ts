// Resolves a fixture set name to the ordered list of generated images a page should show.
//   1. generated/manifest.json from tools/fixtures/make_fixtures.py: fixtures[].name -> images[].image, in the
//      generator's order (it knows best). A requested format swaps in the sibling <stem>.<fmt> when it exists.
//   2. Otherwise file names: a directory named after the set (natural order), a numbered sequence
//      <set>-1.webp / <set>_02.png / <set>.s3.jpg, or a single file <set>.<ext>.
// Without a requested format the file name rules prefer jpg > png > webp > avif > gif.

import type { Stats } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ImageSize } from "./image-size.ts";
import { SNIFF_BYTES, sniffImageSize } from "./image-size.ts";

export const IMAGE_EXTS: readonly string[] = ["jpg", "jpeg", "png", "webp", "avif", "gif"];
const FORMAT_ORDER: readonly string[] = ["jpg", "jpeg", "png", "webp", "avif", "gif"];

/** Generator by-products that are images but never page content (text masks, debug renders). */
const AUX_STEM = /(?:^|[._-])(?:textmask|mask|debug|overlay|preview|gt)$/i;
const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export interface FixtureFile {
  /** Path relative to the generated dir, with forward slashes. */
  rel: string;
  abs: string;
  dir: string;
  stem: string;
  ext: string;
}

export interface FixtureImage {
  file: string;
  w: number | null;
  h: number | null;
}

export type Prefer = "single" | "sequence";

export interface ResolveOptions {
  prefer: Prefer;
  /** Preferred extension (without dot). */
  fmt?: string | undefined;
  /** Only accept `fmt`. */
  requireFmt?: boolean;
}

export interface ManifestImage {
  image: string;
  width?: number;
  height?: number;
}

export interface Catalog {
  readonly dir: string;
  list(): Promise<FixtureFile[]>;
  /** Set names declared by generated/manifest.json (empty without a manifest). */
  names(): Promise<string[]>;
  resolve(set: string, opts: ResolveOptions): Promise<FixtureImage[] | null>;
}

export function isSetName(name: string): boolean {
  return SET_NAME.test(name) && !name.includes("..");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSafeRel(rel: string): boolean {
  return !/[\\:\0]/.test(rel) && rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Reads fixtures[].{name, images[]} from the generator manifest; images are "<rel>" or {image, width, height}. */
export function parseManifest(doc: unknown): Map<string, ManifestImage[]> {
  const sets = new Map<string, ManifestImage[]>();
  const fixtures = isRecord(doc) && Array.isArray(doc["fixtures"]) ? (doc["fixtures"] as unknown[]) : [];
  for (const fx of fixtures) {
    if (!isRecord(fx) || typeof fx["name"] !== "string" || !Array.isArray(fx["images"])) {
      continue;
    }
    const images: ManifestImage[] = [];
    for (const im of fx["images"] as unknown[]) {
      const rel =
        typeof im === "string" ? im : isRecord(im) && typeof im["image"] === "string" ? im["image"] : null;
      if (rel === null || !isSafeRel(rel)) {
        continue;
      }
      const w = isRecord(im) ? im["width"] : undefined;
      const h = isRecord(im) ? im["height"] : undefined;
      images.push(
        typeof w === "number" && typeof h === "number" ? { image: rel, width: w, height: h } : { image: rel },
      );
    }
    if (images.length > 0) {
      sets.set(fx["name"], images);
    }
  }
  return sets;
}

export function createCatalog(dir: string): Catalog {
  const sizes = new Map<string, { key: string; w: number | null; h: number | null }>();
  let manifestCache: { key: string; sets: Map<string, ManifestImage[]> } | null = null;

  async function list(): Promise<FixtureFile[]> {
    let entries;
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch {
      return []; // not generated yet
    }
    const files: FixtureFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) {
        continue;
      }
      const abs = path.join(entry.parentPath, entry.name);
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      const slash = rel.lastIndexOf("/");
      files.push({
        rel,
        abs,
        dir: slash < 0 ? "" : rel.slice(0, slash),
        stem: entry.name.slice(0, entry.name.length - ext.length - 1),
        ext,
      });
    }
    files.sort((a, b) => COLLATOR.compare(a.rel, b.rel));
    return files;
  }

  async function manifest(): Promise<Map<string, ManifestImage[]>> {
    const file = path.join(dir, "manifest.json");
    let st: Stats;
    try {
      st = await stat(file);
    } catch {
      return new Map();
    }
    const key = `${st.size}:${st.mtimeMs}`;
    if (manifestCache?.key !== key) {
      let sets = new Map<string, ManifestImage[]>();
      try {
        sets = parseManifest(JSON.parse(await readFile(file, "utf8")));
      } catch {
        // unreadable or half-written: fall back to file names
      }
      manifestCache = { key, sets };
    }
    return manifestCache.sets;
  }

  async function dims(file: FixtureFile): Promise<{ w: number | null; h: number | null }> {
    let st: Stats;
    try {
      st = await stat(file.abs);
    } catch {
      return { w: null, h: null };
    }
    const key = `${st.size}:${st.mtimeMs}`;
    const cached = sizes.get(file.abs);
    if (cached?.key === key) {
      return { w: cached.w, h: cached.h };
    }
    let size = await sniffFile(file.abs, Math.min(st.size, SNIFF_BYTES));
    if (size === null && st.size > SNIFF_BYTES) {
      size = await sniffFile(file.abs, st.size);
    }
    const result = { w: size?.w ?? null, h: size?.h ?? null };
    sizes.set(file.abs, { key, ...result });
    return result;
  }

  const withDims = (found: FixtureFile[]): Promise<FixtureImage[]> =>
    Promise.all(
      found.map(async (f) => {
        const d = await dims(f);
        return { file: f.rel, w: d.w, h: d.h };
      }),
    );

  /** The manifest's own list, with the requested format swapped in; null to fall back to file names. */
  async function fromManifest(
    set: string,
    opts: ResolveOptions,
    files: FixtureFile[],
  ): Promise<FixtureImage[] | null> {
    const listed = (await manifest()).get(set);
    if (listed === undefined) {
      return null;
    }
    const fmt = normaliseFmt(opts.fmt);
    const byStem = new Map<string, FixtureFile[]>();
    for (const f of files) {
      const key = `${f.dir}/${f.stem}`;
      byStem.set(key, [...(byStem.get(key) ?? []), f]);
    }
    const out: FixtureImage[] = [];
    for (const im of listed) {
      const ext = path.posix.extname(im.image).slice(1).toLowerCase();
      const slash = im.image.lastIndexOf("/");
      const stem = im.image.slice(slash + 1, im.image.length - (ext === "" ? 0 : ext.length + 1));
      const group = byStem.get(`${slash < 0 ? "" : im.image.slice(0, slash)}/${stem}`) ?? [];
      const wanted = fmt === null ? [] : fmt === "jpg" ? ["jpg", "jpeg"] : [fmt];
      const preferred = group.find((f) => wanted.includes(f.ext));
      const exact = group.find((f) => f.rel === im.image);
      const chosen = preferred ?? (opts.requireFmt === true && fmt !== null ? undefined : exact);
      if (chosen === undefined) {
        if (opts.requireFmt === true && fmt !== null) {
          return null; // e.g. no WebP copy of this set: let the file name rules look for one
        }
        continue; // listed but not written (yet)
      }
      if (chosen === exact && im.width !== undefined && im.height !== undefined) {
        out.push({ file: chosen.rel, w: im.width, h: im.height });
      } else {
        out.push(...(await withDims([chosen])));
      }
    }
    return out.length > 0 ? out : null;
  }

  async function resolve(set: string, opts: ResolveOptions): Promise<FixtureImage[] | null> {
    if (!isSetName(set)) {
      return null;
    }
    const files = await list();
    const declared = await fromManifest(set, opts, files);
    if (declared !== null) {
      return declared;
    }
    const all = files.filter((f) => !AUX_STEM.test(f.stem));
    const order = formatOrder(opts);
    const pick = (group: FixtureFile[]): FixtureFile | undefined => {
      for (const ext of order) {
        const hit = group.find((f) => f.ext === ext);
        if (hit !== undefined) {
          return hit;
        }
      }
      return undefined;
    };
    const grouped = (candidates: FixtureFile[], keyOf: (f: FixtureFile) => string): FixtureFile[] => {
      const groups = new Map<string, FixtureFile[]>();
      for (const f of candidates) {
        const key = keyOf(f);
        groups.set(key, [...(groups.get(key) ?? []), f]);
      }
      const keys = [...groups.keys()].sort((a, b) => COLLATOR.compare(a, b));
      return keys.map((k) => pick(groups.get(k) ?? [])).filter((f): f is FixtureFile => f !== undefined);
    };

    const single = (): FixtureFile[] =>
      grouped(
        all.filter((f) => f.stem === set),
        (f) => f.dir,
      ).slice(0, 1);
    const seqRe = new RegExp(`^${escapeRegExp(set)}[-_.](?:p|s|page|part|slice)?(\\d+)$`, "i");
    const sequence = (): FixtureFile[] => {
      const groups = new Map<number, FixtureFile[]>();
      for (const f of all) {
        const n = seqRe.exec(f.stem)?.[1];
        if (n !== undefined) {
          groups.set(Number(n), [...(groups.get(Number(n)) ?? []), f]);
        }
      }
      return [...groups.keys()]
        .sort((a, b) => a - b)
        .map((k) => pick(groups.get(k) ?? []))
        .filter((f): f is FixtureFile => f !== undefined);
    };
    const directory = (): FixtureFile[] => {
      const inDir = all.filter((f) => `/${f.dir}/`.includes(`/${set}/`));
      return grouped(inDir, (f) => `${f.dir}/${f.stem}`);
    };

    const strategies =
      opts.prefer === "single" ? [single, sequence, directory] : [directory, sequence, single];
    for (const strategy of strategies) {
      const found = strategy();
      if (found.length > 0) {
        return withDims(found);
      }
    }
    return null;
  }

  async function names(): Promise<string[]> {
    return [...(await manifest()).keys()];
  }

  return { dir, list, names, resolve };
}

function formatOrder(opts: ResolveOptions): string[] {
  const fmt = normaliseFmt(opts.fmt);
  if (fmt !== null && opts.requireFmt === true) {
    return fmt === "jpg" ? ["jpg", "jpeg"] : [fmt];
  }
  const head = fmt === null ? [] : fmt === "jpg" ? ["jpg", "jpeg"] : [fmt];
  return [...head, ...FORMAT_ORDER.filter((e) => !head.includes(e))];
}

export function normaliseFmt(fmt: string | null | undefined): string | null {
  if (fmt === null || fmt === undefined) {
    return null;
  }
  const f = fmt.toLowerCase() === "jpeg" ? "jpg" : fmt.toLowerCase();
  return IMAGE_EXTS.includes(f) ? f : null;
}

async function sniffFile(abs: string, bytes: number): Promise<ImageSize | null> {
  const handle = await open(abs, "r");
  try {
    const buf = new Uint8Array(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return sniffImageSize(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
