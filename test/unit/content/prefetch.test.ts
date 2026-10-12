// Tier-B pure decisions: which URL a lazy image will load, on which hosts, and whether it is in the reading column.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLUMN_TOLERANCE_PX,
  hostOf,
  inReadingColumn,
  lazyUrls,
  srcsetUrls,
} from "../../../src/content/prefetch.ts";
import { srcsetUrls as fromDiscovery } from "../../../src/content/discovery.ts";

const BASE = "https://reader.example/series/7/ch/12";
const HOSTS = new Set(["cdn.example", "cdn.example:8443"]);

test("lazyUrls: data-src, data-lazy-src, data-original first, then src, then srcset; absolute and deduped", () => {
  assert.deepEqual(
    lazyUrls(
      {
        src: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
        srcset: "https://cdn.example/p2@1x.jpg 1x, https://cdn.example/p2@2x.jpg 2x",
        lazy: ["//cdn.example/p2.jpg", null, "https://cdn.example/p2.jpg"],
      },
      BASE,
      HOSTS,
    ),
    ["https://cdn.example/p2.jpg", "https://cdn.example/p2@1x.jpg", "https://cdn.example/p2@2x.jpg"],
  );
  assert.deepEqual(
    lazyUrls({ src: "https://cdn.example/native.jpg", srcset: null, lazy: [null, null, null] }, BASE, HOSTS),
    ["https://cdn.example/native.jpg"],
    "native loading=lazy: the src itself",
  );
  assert.deepEqual(
    lazyUrls({ src: null, srcset: null, lazy: [null, "https://cdn.example:8443/x.webp", null] }, BASE, HOSTS),
    ["https://cdn.example:8443/x.webp"],
  );
});

test("lazyUrls: placeholders, other hosts and broken values drop out", () => {
  assert.deepEqual(
    lazyUrls(
      {
        src: "/img/loading.gif",
        srcset: "",
        lazy: ["blob:https://reader.example/1", "https://ads.example/banner.jpg", "http://[::1"],
      },
      BASE,
      HOSTS,
    ),
    [],
  );
  assert.deepEqual(lazyUrls({ src: "  ", srcset: null, lazy: [] }, BASE, HOSTS), []);
  assert.equal(hostOf("https://cdn.example:8443/a.jpg"), "cdn.example:8443");
  assert.equal(hostOf("data:image/png;base64,AA"), null);
  assert.equal(hostOf("/relative/a.jpg"), null);
});

test("inReadingColumn: same left and width (± 2 px) as two loaded images, or as one in the same container", () => {
  const strip = { id: "strip" };
  const column = [
    { left: 100, width: 800, parent: strip },
    { left: 101, width: 799, parent: { id: "other" } },
    { left: 400, width: 300, parent: strip },
  ];
  assert.equal(inReadingColumn({ left: 100 + COLUMN_TOLERANCE_PX, width: 800 }, null, column), true);
  assert.equal(inReadingColumn({ left: 103.5, width: 800 }, null, column), false, "beyond the tolerance");
  assert.equal(inReadingColumn({ left: 400, width: 300 }, null, column), false, "only one image there");
  assert.equal(inReadingColumn({ left: 400, width: 300 }, strip, column), true, "same strip container");
  assert.equal(inReadingColumn({ left: 100, width: 800 }, strip, [column[0] ?? column[1]!]), true);
  assert.equal(inReadingColumn({ left: 100, width: 800 }, { id: "x" }, [column[0]!]), false);
  assert.equal(inReadingColumn({ left: 100, width: 800 }, null, []), false);
});

test("srcsetUrls moved to prefetch.ts and is still exported by discovery.ts", () => {
  assert.equal(fromDiscovery, srcsetUrls);
  assert.deepEqual(srcsetUrls("a.jpg 1x, b.jpg 2x"), ["a.jpg", "b.jpg"]);
});
