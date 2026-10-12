// Series and chapter keys from page URLs (src/shared/series-key.ts): English, Spanish, Korean webtoon and manga
// reader URL styles on example domains.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  chapterKeyOf,
  MAX_SLUG_CHARS,
  pageKeysOf,
  seriesKeyOf,
  seriesTitleOf,
  siteOfSeries,
} from "../../../src/shared/series-key.ts";

/** [page URL, page title, expected seriesKey]. */
const SERIES_CASES: ReadonlyArray<readonly [url: string, title: string, seriesKey: string | null]> = [
  // Marker segments (English manga readers).
  ["https://reader.example/manga/sky-pirates/chapter-1050", "", "https://reader.example|sky-pirates"],
  ["https://reader.example/manga/sky-pirates", "", "https://reader.example|sky-pirates"],
  [
    "https://reader.example/manga/sky-pirates/chapter-1050/page-3?utm_source=x#top",
    "",
    "https://reader.example|sky-pirates",
  ],
  ["https://reader.example/en/manga/iron-knight/vol-1/chapter-2", "", "https://reader.example|iron-knight"],
  ["https://reader.example/comic/tower-of-stars-chapter-12", "", "https://reader.example|tower-of-stars"],
  ["https://reader.example/read/sky-pirates/1050", "", "https://reader.example|sky-pirates"],
  ["https://reader.example/comics/read/the-hero/ch-3", "", "https://reader.example|the-hero"],
  ["https://reader.example/manhwa/the-player/episode-12", "", "https://reader.example|the-player"],
  ["https://reader.example/manhua/jade-summit/chapter-3000", "", "https://reader.example|jade-summit"],
  ["https://reader.example/es/manga/sky-pirates/cap-12.html", "", "https://reader.example|sky-pirates"],
  ["https://reader.example/manga/%ED%95%9C%EA%B8%80/1", "", "https://reader.example|한글"],
  ["https://reader.example/manga/Sky-Pirates/Chapter-1", "", "https://reader.example|sky-pirates"],
  // A numeric id after the marker wins over the slug that follows it (slugs get renamed, ids stay).
  ["https://reader.example/series/12345/lone-hunter/chapter/12", "", "https://reader.example|12345"],
  ["https://reader.example/title/98765/chapter/3", "", "https://reader.example|98765"],
  // Spanish readers.
  ["https://lector.example/obra/el-castillo/capitulo-3", "", "https://lector.example|el-castillo"],
  ["https://lector.example/leer/el-castillo-capitulo-3", "", "https://lector.example|el-castillo"],
  ["https://lector.example/serie/la-espada/cap-5", "", "https://lector.example|la-espada"],
  ["https://lector.example/la-espada/capitulo-12-5", "", "https://lector.example|la-espada"],
  // Korean webtoon portals: the series id is in the query.
  ["https://comic.example/webtoon/detail?titleId=747269&no=12", "", "https://comic.example|747269"],
  ["https://comic.example/webtoon/list?titleId=747269", "", "https://comic.example|747269"],
  [
    "https://webtoons.example/en/fantasy/tower-of-stars/episode-1/viewer?title_no=95&episode_no=1",
    "",
    "https://webtoons.example|95",
  ],
  ["https://comic.example/view?series_id=A12&chapter=3", "", "https://comic.example|a12"],
  // Numeric id + slug without a marker.
  ["https://reader.example/12345/sky-pirates/3", "", "https://reader.example|12345"],
  ["https://reader.example/12345-sky-pirates/chapter-3", "", "https://reader.example|12345"],
  // Chapter segments without a marker.
  ["https://reader.example/sky-pirates/chapter-1050", "", "https://reader.example|sky-pirates"],
  ["https://reader.example/sky-pirates-chapter-1050", "", "https://reader.example|sky-pirates"],
  ["https://reader.example/sky-pirates/ep12", "", "https://reader.example|sky-pirates"],
  ["https://reader.example/en/sky-pirates/c/chapter-5", "", "https://reader.example|c"],
  // Chapter-only paths: the page title names the series.
  [
    "https://reader.example/chapter/0f9c-41ab",
    "Sky Pirates - Chapter 1050 - Reader",
    "https://reader.example|sky-pirates",
  ],
  ["https://reader.example/viewer/123", "혼자 사냥꾼 12화 | Reader", "https://reader.example|혼자-사냥꾼"],
  ["https://reader.example/read", "Read The Hero Chapter 4 Online", "https://reader.example|the-hero"],
  // Fallbacks: the first path segment, or the whole site.
  ["https://reader.example/sky-pirates/1050", "", "https://reader.example|sky-pirates"],
  ["https://reader.example/ep12", "", "https://reader.example|"],
  ["https://reader.example/", "", "https://reader.example|"],
  ["https://reader.example/chapter/0f9c-41ab", "", "https://reader.example|"],
  ["http://127.0.0.1:8080/fixtures/webtoon/index.html", "", "http://127.0.0.1:8080|fixtures"],
  // Not a web page.
  ["ftp://reader.example/manga/x", "", null],
  ["chrome-extension://abc/ui/sidepanel.html", "", null],
  ["not a url", "", null],
];

describe("seriesKeyOf", () => {
  for (const [url, title, expected] of SERIES_CASES) {
    test(`${url}${title === "" ? "" : ` (${title})`} → ${String(expected)}`, () => {
      assert.equal(seriesKeyOf(url, title), expected);
    });
  }

  test("every chapter of a series shares its key; other series do not", () => {
    const chapters = [1, 2, 10, 100].map((n) =>
      seriesKeyOf(`https://reader.example/manga/sky-pirates/chapter-${n}`),
    );
    assert.equal(new Set(chapters).size, 1);
    assert.notEqual(
      seriesKeyOf("https://reader.example/manga/sky-pirates/chapter-1"),
      seriesKeyOf("https://reader.example/manga/iron-knight/chapter-1"),
    );
    assert.notEqual(
      seriesKeyOf("https://reader.example/manga/sky-pirates/chapter-1"),
      seriesKeyOf("https://mirror.example/manga/sky-pirates/chapter-1"),
      "mirror domains are separate series",
    );
  });

  test("a long slug is cut", () => {
    const key = seriesKeyOf(`https://reader.example/manga/${"a".repeat(500)}/chapter-1`);
    assert.equal(key, `https://reader.example|${"a".repeat(MAX_SLUG_CHARS)}`);
  });
});

describe("chapterKeyOf", () => {
  const CASES: ReadonlyArray<readonly [string, string | null]> = [
    ["https://reader.example/manga/x/chapter-1#page=4", "https://reader.example/manga/x/chapter-1"],
    ["https://reader.example/manga/x/chapter-1/", "https://reader.example/manga/x/chapter-1"],
    ["https://Reader.Example:443/manga/x/chapter-1", "https://reader.example/manga/x/chapter-1"],
    ["https://user:pw@reader.example/manga/x/chapter-1", "https://reader.example/manga/x/chapter-1"],
    [
      "https://reader.example/manga/x/chapter-1?utm_source=a&utm_medium=b&fbclid=c&gclid=d&ref=e",
      "https://reader.example/manga/x/chapter-1",
    ],
    ["https://reader.example/manga/x/chapter-1?b=2&a=1", "https://reader.example/manga/x/chapter-1?a=1&b=2"],
    ["https://reader.example/manga/x/chapter-1/page-3", "https://reader.example/manga/x/chapter-1"],
    ["https://reader.example/manga/x/chapter-1/page/3/", "https://reader.example/manga/x/chapter-1"],
    ["https://reader.example/manga/x/chapter-1?page=3", "https://reader.example/manga/x/chapter-1"],
    [
      "https://comic.example/webtoon/detail?titleId=747269&no=12",
      "https://comic.example/webtoon/detail?no=12&titleId=747269",
    ],
    ["https://reader.example", "https://reader.example/"],
    ["https://reader.example/manga/%ED%95%9C/1", "https://reader.example/manga/%ED%95%9C/1"],
    ["data:image/png;base64,AAAA", null],
    ["blob:https://reader.example/1234", null],
  ];
  for (const [url, expected] of CASES) {
    test(`${url} → ${String(expected)}`, () => {
      assert.equal(chapterKeyOf(url), expected);
    });
  }

  test("different chapters stay different; pages of one chapter share it", () => {
    assert.notEqual(
      chapterKeyOf("https://reader.example/manga/x/chapter-1"),
      chapterKeyOf("https://reader.example/manga/x/chapter-2"),
    );
    assert.equal(
      chapterKeyOf("https://reader.example/manga/x/chapter-1/page-2"),
      chapterKeyOf("https://reader.example/manga/x/chapter-1/page-9"),
    );
  });
});

describe("pageKeysOf, siteOfSeries and seriesTitleOf", () => {
  test("pageKeysOf returns every key at once", () => {
    assert.deepEqual(
      pageKeysOf("https://reader.example/manga/sky-pirates/chapter-3?utm_campaign=x", "Sky Pirates"),
      {
        siteKey: "https://reader.example",
        seriesKey: "https://reader.example|sky-pirates",
        chapterKey: "https://reader.example/manga/sky-pirates/chapter-3",
        slug: "sky-pirates",
      },
    );
    assert.equal(pageKeysOf("about:blank"), null);
  });

  test("siteOfSeries recovers the origin of a valid seriesKey only", () => {
    assert.equal(siteOfSeries("https://reader.example|sky-pirates"), "https://reader.example");
    assert.equal(siteOfSeries("https://reader.example|"), "https://reader.example");
    assert.equal(siteOfSeries("http://127.0.0.1:8080|x"), "http://127.0.0.1:8080");
    assert.equal(siteOfSeries("https://reader.example/path|x"), null);
    assert.equal(siteOfSeries("https://Reader.example|x"), null, "not normalized");
    assert.equal(siteOfSeries("no separator"), null);
    assert.equal(siteOfSeries("ftp://reader.example|x"), null);
  });

  test("seriesTitleOf takes the series name from the page title, else makes the slug readable", () => {
    assert.equal(seriesTitleOf("Sky Pirates - Chapter 1050 - Reader", "x"), "Sky Pirates");
    assert.equal(seriesTitleOf("Chapter 12 | Tower of Stars", "x"), "Tower of Stars");
    assert.equal(seriesTitleOf("Read The Hero Chapter 4 Online", "x"), "The Hero");
    assert.equal(seriesTitleOf("El Castillo Capítulo 3 – Lector", "x"), "El Castillo");
    assert.equal(seriesTitleOf("혼자 사냥꾼 12화", "x"), "혼자 사냥꾼");
    assert.equal(seriesTitleOf("第12話 巨人の森", "x"), "巨人の森");
    assert.equal(seriesTitleOf("", "tower-of-stars"), "Tower Of Stars");
    assert.equal(seriesTitleOf("Chapter 3", "747269"), "747269");
    assert.equal([...seriesTitleOf("x".repeat(400), "s")].length, 120);
  });
});
