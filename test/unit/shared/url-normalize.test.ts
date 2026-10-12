import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_ALIAS_URL_LENGTH,
  URL_KEY_PREFIX,
  normalizeUrl,
  urlKeyOf,
} from "../../../src/shared/url-normalize.ts";

const CASES: ReadonlyArray<readonly [string, string | null, string]> = [
  [
    "HTTPS://CDN.Example.COM:443/a/./b/../c.jpg?x=1&y=2#frag",
    "https://cdn.example.com/a/c.jpg?x=1&y=2",
    "scheme/host case, default port, dot segments, fragment",
  ],
  ["http://cdn.example.com:80/p.png", "http://cdn.example.com/p.png", "default http port"],
  ["http://cdn.example.com:8080/p.png", "http://cdn.example.com:8080/p.png", "other ports stay"],
  ["https://cdn.example.com/p.png?b=2&a=1", "https://cdn.example.com/p.png?b=2&a=1", "query order stays"],
  [
    "https://cdn.example.com/p.png?token=AbC%2Fd&exp=17",
    "https://cdn.example.com/p.png?token=AbC%2Fd&exp=17",
    "tokens and encodings stay (stripping is P2)",
  ],
  ["https://cdn.example.com/P.PNG", "https://cdn.example.com/P.PNG", "path case stays"],
  ["http://a.example/b#", "http://a.example/b", "empty fragment"],
  ["http://a.example/b?", "http://a.example/b?", "empty query stays as parsed"],
  ["https://user:pw@cdn.example.com/x.jpg", "https://cdn.example.com/x.jpg", "credentials dropped"],
  ["https://münchen.de/x.jpg", "https://xn--mnchen-3ya.de/x.jpg", "IDN"],
  ["http://2130706433/x", "http://127.0.0.1/x", "numeric IPv4"],
  ["  https://cdn.example.com/x.jpg  ", "https://cdn.example.com/x.jpg", "surrounding spaces"],
  ["data:image/png;base64,AAAA", null, "data: has no alias"],
  ["blob:https://reader.example/9b1e", null, "blob: has no alias"],
  ["ftp://example.com/x.png", null, "other schemes"],
  ["/relative.png", null, "relative"],
  ["not a url", null, "malformed"],
];

for (const [input, expected, why] of CASES) {
  test(`normalizeUrl ${JSON.stringify(input)} (${why})`, () => {
    assert.equal(normalizeUrl(input), expected);
  });
}

test("urlKeyOf prefixes the normalized URL; null without an alias", () => {
  assert.equal(URL_KEY_PREFIX, "u:");
  assert.equal(urlKeyOf("HTTPS://CDN.example.com/x.jpg#top"), "u:https://cdn.example.com/x.jpg");
  assert.equal(urlKeyOf("data:image/png;base64,AAAA"), null);
  assert.equal(urlKeyOf("::"), null);
});

test("only the fragment and credentials merge; different queries, hosts or paths never do", () => {
  const key = (url: string): string | null => urlKeyOf(url);
  assert.equal(key("https://cdn.example.com/1.jpg#a"), key("https://cdn.example.com/1.jpg#b"));
  assert.equal(key("https://u@cdn.example.com/1.jpg"), key("https://cdn.example.com/1.jpg"));
  const distinct = [
    "https://cdn.example.com/1.jpg",
    "https://cdn.example.com/1.jpg?v=2",
    "https://cdn.example.com/1.jpg?v=3",
    "http://cdn.example.com/1.jpg",
    "https://cdn.example.com./1.jpg",
    "https://cdn2.example.com/1.jpg",
    "https://cdn.example.com/1.JPG",
    "https://cdn.example.com:8443/1.jpg",
  ];
  assert.equal(new Set(distinct.map(key)).size, distinct.length);
});

test("URLs longer than the alias cap get no key", () => {
  const base = "https://cdn.example.com/x.jpg?t=";
  const fits = base + "a".repeat(MAX_ALIAS_URL_LENGTH - base.length);
  assert.equal(normalizeUrl(fits)?.length, MAX_ALIAS_URL_LENGTH);
  assert.equal(normalizeUrl(`${fits}a`), null);
  assert.equal(urlKeyOf(`${fits}a`), null);
});
