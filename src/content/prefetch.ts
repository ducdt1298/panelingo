// Tier-B discovery (look-ahead prefetch): pure decisions about lazy images the page has not loaded yet.
//
// A lazy image is a prefetch candidate when it sits in the reading column (same left edge and width, ± 2 px, as
// at least two loaded comic images, or as a loaded image in the same container) and names a URL on a host the page's
// loaded comic images come from. Which candidates are submitted (within the detect horizon, at most detectMaxImages
// ahead) is shared/core/priority.ts horizonCut; discovery.ts does the DOM reads.

/** Attributes lazy-loading libraries keep the real URL in (the src then holds a placeholder or nothing). */
export const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original"] as const;
export const COLUMN_TOLERANCE_PX = 2;
/** Images of the reading column needed when the candidate shares no container with one of them. */
export const COLUMN_MIN_IMAGES = 2;

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** URLs of a srcset attribute (HTML image-candidate syntax; descriptors dropped, commas inside URLs kept). */
export function srcsetUrls(srcset: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && (isSpace(srcset[i]) || srcset[i] === ",")) i += 1;
    if (i >= srcset.length) break;
    const start = i;
    while (i < srcset.length && !isSpace(srcset[i])) i += 1;
    let url = srcset.slice(start, i);
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      while (i < srcset.length) {
        const char = srcset[i];
        i += 1;
        if (char === "(") depth += 1;
        else if (char === ")") depth = Math.max(0, depth - 1);
        else if (char === "," && depth === 0) break;
      }
    }
    if (url !== "") urls.push(url);
  }
  return urls;
}

export interface LazyAttrs {
  src: string | null;
  srcset: string | null;
  /** data-src, data-lazy-src, data-original (in LAZY_ATTRS order). */
  lazy: ReadonlyArray<string | null>;
}

function absoluteHttp(raw: string | null, base: string): URL | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * URLs a lazy <img> will load, most likely first: data-src, data-lazy-src, data-original, then src, then the srcset
 * candidates. Only absolute http(s) URLs on `hosts` (URL.host of the page's loaded comic images), without
 * duplicates; placeholders (data:, blob:, other hosts) drop out.
 */
export function lazyUrls(attrs: LazyAttrs, base: string, hosts: ReadonlySet<string>): string[] {
  const raw = [...attrs.lazy, attrs.src, ...(attrs.srcset === null ? [] : srcsetUrls(attrs.srcset))];
  const out: string[] = [];
  for (const value of raw) {
    const url = absoluteHttp(value, base);
    if (url === null || !hosts.has(url.host) || out.includes(url.href)) continue;
    out.push(url.href);
  }
  return out;
}

/** The host of an absolute http(s) URL, or null. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

export interface ColumnImage {
  /** Page CSS px. */
  left: number;
  width: number;
  /** The element's parent (any identity token). */
  parent: unknown;
}

function sameColumn(a: { left: number; width: number }, b: { left: number; width: number }): boolean {
  return (
    Math.abs(a.left - b.left) <= COLUMN_TOLERANCE_PX && Math.abs(a.width - b.width) <= COLUMN_TOLERANCE_PX
  );
}

/** Same column as ≥ COLUMN_MIN_IMAGES loaded images, or as a loaded image with the same parent (a strip container). */
export function inReadingColumn(
  rect: { left: number; width: number },
  parent: unknown,
  column: readonly ColumnImage[],
): boolean {
  let matches = 0;
  for (const image of column) {
    if (!sameColumn(rect, image)) continue;
    if (parent !== null && image.parent === parent) return true;
    matches += 1;
    if (matches >= COLUMN_MIN_IMAGES) return true;
  }
  return false;
}
