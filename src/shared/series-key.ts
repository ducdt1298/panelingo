// Series and chapter identity of a comic page, for series memory (glossary, chapter history, summary). PURE.
//
// seriesKey = origin + "|" + series slug. The slug comes from generic rules; the first that matches wins:
//   1. a series id in the query (titleId, title_no, series_id, manga_id, comic_id, book_id, …);
//   2. the path segment after a marker (series, manga, manhwa, manhua, comic(s), webtoon(s), title, read, serie, obra,
//      …), past generic page names (index, list, detail, …): a numeric id there is the series (it outlives a renamed
//      slug), and a chapter suffix ("-chapter-12") is cut;
//   3. a numeric id followed by a slug ("/12345/some-title/…", "/12345-some-title/…");
//   4. the segment before the first chapter segment (chapter-12, capitulo-12, ch-12, episode-12, ep12, cap-12, …), or a
//      segment cut before its chapter suffix ("/some-title-chapter-12");
//   5. the series name in the page title, only when the path has nothing better: an empty path or one that starts
//      with a chapter or viewer segment ("/chapter/<id>");
//   6. the first path segment ("" for the site root).
// Language segments ("/en/", "/pt-br/") and file extensions are skipped; segments are decoded, NFC and lower case.
// chapterKey = the page URL without fragment, credentials, tracking parameters and page numbers ("?page=3",
// "/page-3", "/page/3"), with the query sorted: the pages of a paged reader share one chapter. Both keys are null for
// anything but http(s) pages.

export const SERIES_KEY_SEPARATOR = "|";
/** Longest slug kept (longer ones are cut). */
export const MAX_SLUG_CHARS = 120;
/** Longest series title derived from a page title. */
export const MAX_TITLE_CHARS = 120;

export interface PageKeys {
  /** Origin of the page (= siteKey). */
  siteKey: string;
  seriesKey: string;
  chapterKey: string;
  /** The series part of seriesKey. */
  slug: string;
}

/** Query parameters that name a series, in priority order (compared in lower case). */
const QUERY_IDS = [
  "titleid",
  "title_no",
  "titleno",
  "series_id",
  "seriesid",
  "series",
  "manga_id",
  "mangaid",
  "manga",
  "comic_id",
  "comicid",
  "comic",
  "book_id",
  "bookid",
  "work_id",
  "workid",
];

/** Path segments that announce the series segment after them. */
const MARKERS: ReadonlySet<string> = new Set([
  "series",
  "serie",
  "manga",
  "mangas",
  "manhwa",
  "manhua",
  "comic",
  "comics",
  "webtoon",
  "webtoons",
  "title",
  "titles",
  "read",
  "reader",
  "obra",
  "obras",
  "leer",
  "ler",
  "book",
  "books",
  "work",
  "works",
  "story",
  "truyen",
  "truyen-tranh",
]);

/** Page names that are never a series, skipped after a marker ("/webtoon/list", "/webtoon/index.html"). */
const GENERIC_SEGMENTS: ReadonlySet<string> = new Set([
  "index",
  "default",
  "home",
  "list",
  "detail",
  "details",
  "view",
  "viewer",
  "page",
  "all",
  "latest",
  "popular",
]);

/** Segments that start a chapter viewer (the title then names the series better than the path). */
const VIEWER_WORDS: ReadonlySet<string> = new Set(["viewer", "view", "reader", "read", "watch"]);

const LANGUAGE_SEGMENTS: ReadonlySet<string> = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "pt-br",
  "ru",
  "ja",
  "jp",
  "ko",
  "kr",
  "zh",
  "cn",
  "tw",
  "zh-cn",
  "zh-tw",
  "zh-hans",
  "zh-hant",
  "vi",
  "id",
  "th",
  "tr",
  "pl",
  "ar",
]);

/** Chapter words, longest first so the alternation never stops at a prefix ("ch" before "chapter"). */
const CHAPTER_WORDS = [
  "chapters",
  "chapter",
  "capitulos",
  "capitulo",
  "capítulo",
  "episodes",
  "episodio",
  "episódio",
  "episode",
  "volume",
  "chuong",
  "chương",
  "issue",
  "chap",
  "tomo",
  "tome",
  "epi",
  "cap",
  "vol",
  "ch",
  "ep",
].join("|");

/** A whole chapter segment: "chapter-12", "ch12", "ep-3", "capitulo-12-5", "chapter-12-the-end". */
const CHAPTER_SEGMENT = new RegExp(`^(?:${CHAPTER_WORDS})[-_.\\s]*\\d+(?:[-_.].*)?$`, "u");
/** A chapter word alone ("/chapter/12"). */
const CHAPTER_WORD = new RegExp(`^(?:${CHAPTER_WORDS})$`, "u");
/** A segment that ends with a chapter part: "tower-of-god-chapter-12" → "tower-of-god". */
const CHAPTER_SUFFIX = new RegExp(`^(.+?)[-_.\\s]+(?:${CHAPTER_WORDS})[-_.\\s]*\\d+(?:[-_.].*)?$`, "u");
const NUMERIC_ID = /^\d{2,}$/u;
const ID_THEN_SLUG = /^(\d{2,})-(?=.*\p{L})/u;
const HAS_LETTER = /\p{L}/u;
const FILE_EXTENSION = /\.(?:html?|php|aspx?|jsp)$/u;

/** Tracking parameters dropped from chapter keys (compared in lower case; utm_* by prefix). */
const TRACKING: ReadonlySet<string> = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "igshid",
  "ref",
  "ref_src",
  "spm",
  "page",
]);
const PAGE_SEGMENT = /^(?:page|pg)[-_]?\d+$/u;
const PAGE_WORD = /^(?:page|pg)$/u;

function parseHttp(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") return null;
  return parsed;
}

function decodeSegment(raw: string): string {
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // keep the raw segment
  }
  return text.normalize("NFC").trim().toLowerCase().replace(FILE_EXTENSION, "");
}

function segmentsOf(url: URL): string[] {
  return url.pathname
    .split("/")
    .map(decodeSegment)
    .filter((segment) => segment !== "");
}

function isChapterSegment(segment: string): boolean {
  return CHAPTER_SEGMENT.test(segment) || CHAPTER_WORD.test(segment);
}

/** The segment without a trailing chapter part ("one-piece-ch-3" → "one-piece"). */
function cutChapter(segment: string): string {
  return CHAPTER_SUFFIX.exec(segment)?.[1] ?? segment;
}

function slugOk(slug: string): string | null {
  const cut = [...slug].slice(0, MAX_SLUG_CHARS).join("");
  return cut === "" ? null : cut;
}

function fromQuery(url: URL): string | null {
  const params = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase();
    if (!params.has(key)) params.set(key, value.normalize("NFC").trim().toLowerCase());
  }
  for (const name of QUERY_IDS) {
    const value = params.get(name);
    if (value !== undefined && value !== "") return slugOk(value);
  }
  return null;
}

function fromMarker(segments: readonly string[]): string | null {
  const at = segments.findIndex((segment) => MARKERS.has(segment));
  if (at < 0) return null;
  for (const segment of segments.slice(at + 1)) {
    if (MARKERS.has(segment) || LANGUAGE_SEGMENTS.has(segment) || GENERIC_SEGMENTS.has(segment)) continue;
    if (isChapterSegment(segment)) return null;
    return slugOk(cutChapter(segment));
  }
  return null;
}

function fromNumericId(segments: readonly string[]): string | null {
  for (const [i, segment] of segments.entries()) {
    const joined = ID_THEN_SLUG.exec(segment);
    if (joined !== null) return slugOk(joined[1] ?? "");
    const next = segments[i + 1];
    if (NUMERIC_ID.test(segment) && next !== undefined && HAS_LETTER.test(next) && !isChapterSegment(next)) {
      return slugOk(segment);
    }
  }
  return null;
}

function fromChapter(segments: readonly string[]): string | null {
  for (const [i, segment] of segments.entries()) {
    if (isChapterSegment(segment)) {
      const before = segments
        .slice(0, i)
        .filter((s) => !LANGUAGE_SEGMENTS.has(s))
        .at(-1);
      return before === undefined ? null : slugOk(cutChapter(before));
    }
    const cut = CHAPTER_SUFFIX.exec(segment)?.[1];
    if (cut !== undefined && !LANGUAGE_SEGMENTS.has(cut)) return slugOk(cut);
  }
  return null;
}

const TITLE_PARTS = /\s+[|–—·»]+\s+|\s+-\s+|\s+::\s+|\s*\|\s*/u;
const TITLE_CHAPTER =
  /(?:^|\s)(?:chapter|chap|ch\.?|episode|ep\.?|episodio|capítulo|capitulo|cap\.?|vol\.?|volume|tome|tomo|chương|#)\s*\d+.*$/iu;
const TITLE_CJK_LABEL = /(?:(?:제\s*)?\d+\s*화|第\s*\d+\s*[話话章回])/u.source;
/** A Korean, Japanese or Chinese chapter label ("12화", "제12화", "第12話") leading the title. */
const TITLE_CJK_PREFIX = new RegExp(`^\\s*${TITLE_CJK_LABEL}\\s*`, "u");
/** The same label later in the title: it and everything after it go. */
const TITLE_CJK_CHAPTER = new RegExp(`\\s*${TITLE_CJK_LABEL}.*$`, "u");
const TITLE_TRAILING_NUMBER = /\s+\d+(?:[.,]\d+)?$/u;
const TITLE_READ = /^read\s+/iu;
const TITLE_ONLINE = /\s+online(?:\s+free)?$/iu;

/** The page title without its chapter part, site name and reader boilerplate ("" when nothing is left). */
function seriesNameOf(pageTitle: string): string {
  for (const part of pageTitle.normalize("NFC").split(TITLE_PARTS)) {
    const name = part
      .replace(TITLE_CJK_PREFIX, "")
      .replace(TITLE_CHAPTER, "")
      .replace(TITLE_CJK_CHAPTER, "")
      .replace(TITLE_ONLINE, "")
      .replace(TITLE_READ, "")
      .replace(TITLE_TRAILING_NUMBER, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (HAS_LETTER.test(name)) return name;
  }
  return "";
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** The path cannot name the series: no segment, or it starts with a chapter or viewer segment. */
function pathIsGeneric(segments: readonly string[]): boolean {
  const first = segments.find((segment) => !LANGUAGE_SEGMENTS.has(segment));
  return first === undefined || isChapterSegment(first) || VIEWER_WORDS.has(first);
}

function slugOf(url: URL, title: string): string {
  const segments = segmentsOf(url);
  const ruled =
    fromQuery(url) ?? fromMarker(segments) ?? fromNumericId(segments) ?? fromChapter(segments) ?? null;
  if (ruled !== null) return ruled;
  if (pathIsGeneric(segments)) {
    const fromTitle = slugOk(slugify(seriesNameOf(title)));
    if (fromTitle !== null) return fromTitle;
  }
  // A chapter segment first ("/ep12") names no series: such sites usually host a single one.
  const first = segments.find((segment) => !LANGUAGE_SEGMENTS.has(segment));
  return first === undefined || isChapterSegment(first) ? "" : (slugOk(cutChapter(first)) ?? "");
}

/** origin + "|" + series slug; null for non-http(s) pages. */
export function seriesKeyOf(url: string, title = ""): string | null {
  const parsed = parseHttp(url);
  return parsed === null ? null : `${parsed.origin}${SERIES_KEY_SEPARATOR}${slugOf(parsed, title)}`;
}

/** The page URL without fragment, credentials, tracking parameters and page numbers; null for non-http(s) pages. */
export function chapterKeyOf(url: string): string | null {
  const parsed = parseHttp(url);
  if (parsed === null) return null;
  // Empty segments (a trailing or doubled slash) go; the rest keeps its percent-encoding.
  const parts = parsed.pathname.split("/").filter((part) => part !== "");
  const last = decodeSegment(parts.at(-1) ?? "");
  if (PAGE_SEGMENT.test(last)) parts.pop();
  else if (/^\d+$/u.test(last) && PAGE_WORD.test(decodeSegment(parts.at(-2) ?? ""))) parts.splice(-2);
  const path = `/${parts.join("/")}`;
  const params = [...parsed.searchParams].filter(([name]) => {
    const key = name.toLowerCase();
    return !key.startsWith("utm_") && !TRACKING.has(key);
  });
  params.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
  return `${parsed.origin}${path}${query}`;
}

/** Every key of a page at once; null for non-http(s) pages. */
export function pageKeysOf(url: string, title = ""): PageKeys | null {
  const parsed = parseHttp(url);
  const chapterKey = chapterKeyOf(url);
  if (parsed === null || chapterKey === null) return null;
  const slug = slugOf(parsed, title);
  return {
    siteKey: parsed.origin,
    seriesKey: `${parsed.origin}${SERIES_KEY_SEPARATOR}${slug}`,
    chapterKey,
    slug,
  };
}

/** The siteKey (origin) part of a seriesKey, or null when it is not one. */
export function siteOfSeries(seriesKey: string): string | null {
  const at = seriesKey.indexOf(SERIES_KEY_SEPARATOR);
  if (at < 0) return null;
  const origin = seriesKey.slice(0, at);
  return parseHttp(origin)?.origin === origin ? origin : null;
}

/** A display title for a new series: the series name in the page title, else the slug made readable. */
export function seriesTitleOf(pageTitle: string, slug: string): string {
  const name = seriesNameOf(pageTitle);
  const title =
    name !== ""
      ? name
      : slug
          .split(/[-_\s]+/u)
          .filter((word) => word !== "")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
  return [...title].slice(0, MAX_TITLE_CHARS).join("");
}
