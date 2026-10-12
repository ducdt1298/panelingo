import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { migrateSite, type SiteSettings } from "../../../src/shared/settings.ts";
import {
  contentScriptMatches,
  findEnabledSite,
  isSameSite,
  isSiteKey,
  matchPatternsFor,
  patternMatchesUrl,
  siteKeyFor,
} from "../../../src/shared/site.ts";

function site(patch: Partial<SiteSettings>): SiteSettings {
  return migrateSite({ enabled: true, ...patch }, 1);
}

describe("siteKeyFor", () => {
  test("http(s) URLs → lowercase origin without default port, path or query", () => {
    assert.equal(siteKeyFor("https://Comic.Naver.com/webtoon/detail?titleId=1#x"), "https://comic.naver.com");
    assert.equal(siteKeyFor("http://127.0.0.1:8080/webtoon/?n=3"), "http://127.0.0.1:8080");
    assert.equal(siteKeyFor("https://example.com:443/a"), "https://example.com");
    assert.equal(siteKeyFor("http://example.com:80/"), "http://example.com");
    assert.equal(siteKeyFor("https://[::1]:8443/"), "https://[::1]:8443");
    assert.equal(siteKeyFor("http://2130706433/"), "http://127.0.0.1", "WHATWG normalizes IPv4 forms");
  });

  test("other schemes, opaque origins and garbage → null", () => {
    for (const url of [
      "chrome://extensions",
      "chrome-extension://abc/ui/popup.html",
      "file:///C:/comic.html",
      "about:blank",
      "data:text/html,hi",
      "blob:https://example.com/uuid",
      "ftp://example.com/",
      "not a url",
      "",
    ]) {
      assert.equal(siteKeyFor(url), null, url);
    }
  });

  test("isSiteKey only accepts normalized origins; isSameSite compares origins", () => {
    assert.equal(isSiteKey("https://example.com"), true);
    assert.equal(isSiteKey("https://example.com/"), false);
    assert.equal(isSiteKey("https://Example.com"), false);
    assert.equal(isSiteKey("example.com"), false);
    assert.equal(isSameSite("https://a.example/1", "https://a.example/2?x"), true);
    assert.equal(isSameSite("https://a.example/", "http://a.example/"), false);
    assert.equal(isSameSite("https://a.example:8443/", "https://a.example/"), false);
    assert.equal(isSameSite("about:blank", "about:blank"), false);
  });
});

describe("matchPatternsFor", () => {
  test("origin → one pattern with /* path, keeping an explicit port", () => {
    assert.deepEqual(matchPatternsFor("https://comic.naver.com", false), ["https://comic.naver.com/*"]);
    assert.deepEqual(matchPatternsFor("http://127.0.0.1:8080", false), ["http://127.0.0.1:8080/*"]);
    assert.deepEqual(matchPatternsFor("http://localhost:8081", true), ["http://*.localhost:8081/*"]);
  });

  test("includeSubdomains uses *. for names but never for IP literals", () => {
    assert.deepEqual(matchPatternsFor("https://example.com", true), ["https://*.example.com/*"]);
    assert.deepEqual(matchPatternsFor("http://127.0.0.1:8080", true), ["http://127.0.0.1:8080/*"]);
    assert.deepEqual(matchPatternsFor("https://[::1]:8443", true), ["https://[::1]:8443/*"]);
  });

  test("accepts any URL of the site, rejects what has no http(s) origin", () => {
    assert.deepEqual(matchPatternsFor("https://example.com/path?q=1", false), ["https://example.com/*"]);
    assert.deepEqual(matchPatternsFor("chrome://newtab", false), []);
    assert.deepEqual(matchPatternsFor("garbage", true), []);
  });
});

describe("patternMatchesUrl (Chrome match-pattern semantics)", () => {
  test("scheme, host, subdomains and path glob", () => {
    assert.equal(patternMatchesUrl("https://example.com/*", "https://example.com/a/b?c=1"), true);
    assert.equal(patternMatchesUrl("https://example.com/*", "http://example.com/"), false);
    assert.equal(patternMatchesUrl("*://example.com/*", "http://example.com/"), true);
    assert.equal(patternMatchesUrl("https://*.example.com/*", "https://example.com/"), true);
    assert.equal(patternMatchesUrl("https://*.example.com/*", "https://img.cdn.example.com/x"), true);
    assert.equal(patternMatchesUrl("https://*.example.com/*", "https://badexample.com/"), false);
    assert.equal(patternMatchesUrl("https://*/*", "https://anything.example/"), true);
    assert.equal(patternMatchesUrl("https://example.com/comic/*", "https://example.com/comic/1"), true);
    assert.equal(patternMatchesUrl("https://example.com/comic/*", "https://example.com/news/1"), false);
  });

  test("ports: none matches every port; an explicit port matches the effective port only", () => {
    assert.equal(patternMatchesUrl("https://example.com/*", "https://example.com:8443/"), true);
    assert.equal(patternMatchesUrl("http://127.0.0.1:8080/*", "http://127.0.0.1:8080/webtoon/"), true);
    assert.equal(patternMatchesUrl("http://127.0.0.1:8080/*", "http://127.0.0.1:8081/"), false);
    assert.equal(patternMatchesUrl("https://example.com:443/*", "https://example.com/"), true);
    assert.equal(patternMatchesUrl("http://example.com:*/*", "http://example.com:1234/"), true);
  });

  test("invalid patterns and non-http URLs never match", () => {
    assert.equal(patternMatchesUrl("example.com", "https://example.com/"), false);
    assert.equal(patternMatchesUrl("https://example.com", "https://example.com/"), false, "path required");
    assert.equal(patternMatchesUrl("https://example.com/*", "about:blank"), false);
    assert.equal(patternMatchesUrl("https://example.com/*", "not a url"), false);
  });

  test("every generated pattern matches its own site", () => {
    for (const key of ["https://comic.naver.com", "http://127.0.0.1:8080", "http://localhost:8081"]) {
      for (const sub of [false, true]) {
        for (const pattern of matchPatternsFor(key, sub)) {
          assert.equal(patternMatchesUrl(pattern, `${key}/chapter/1?x=y`), true, `${pattern} ⊇ ${key}`);
        }
      }
    }
  });
});

describe("contentScriptMatches", () => {
  test("enabled sites only, subdomains, extra frame origins; deduplicated and sorted", () => {
    const matches = contentScriptMatches({
      "https://b.example": site({
        includeSubdomains: true,
        extraFrameOrigins: ["https://viewer.cdn.example/"],
      }),
      "http://127.0.0.1:8080": site({ extraFrameOrigins: ["http://127.0.0.1:8080", "not an origin"] }),
      "https://off.example": site({ enabled: false, extraFrameOrigins: ["https://never.example"] }),
    });
    assert.deepEqual(matches, [
      "http://127.0.0.1:8080/*",
      "https://*.b.example/*",
      "https://viewer.cdn.example/*",
    ]);
    assert.deepEqual(contentScriptMatches({}), []);
  });
});

describe("findEnabledSite", () => {
  const sites = {
    "https://reader.example": site({}),
    "https://example.com": site({ includeSubdomains: true }),
    "https://m.example.com": site({ mode: "manual" }),
    "https://host.example": site({ extraFrameOrigins: ["https://frames.example"] }),
    "https://off.example": site({ enabled: false }),
  };

  test("own origin first, then the most specific includeSubdomains site, then extra frame origins", () => {
    assert.deepEqual(findEnabledSite("https://reader.example/ch/1", sites)?.via, "origin");
    const own = findEnabledSite("https://m.example.com/x", sites);
    assert.equal(own?.siteKey, "https://m.example.com");
    assert.equal(own?.site.mode, "manual");
    const sub = findEnabledSite("https://img.example.com/x", sites);
    assert.deepEqual([sub?.siteKey, sub?.via], ["https://example.com", "subdomain"]);
    const frame = findEnabledSite("https://frames.example/viewer", sites);
    assert.deepEqual([frame?.siteKey, frame?.via], ["https://host.example", "frame"]);
  });

  test("the URL's own record decides even when disabled: a parent's includeSubdomains does not override it", () => {
    const withOff = { ...sites, "https://off.example.com": site({ enabled: false }) };
    assert.equal(findEnabledSite("https://off.example.com/ch/1", withOff), null);
    assert.equal(findEnabledSite("https://other.example.com/ch/1", withOff)?.siteKey, "https://example.com");
    const frameOff = { ...sites, "https://frames.example": site({ enabled: false }) };
    assert.equal(findEnabledSite("https://frames.example/viewer", frameOff), null);
  });

  test("disabled, unknown and non-http pages → null", () => {
    assert.equal(findEnabledSite("https://off.example/", sites), null);
    assert.equal(findEnabledSite("https://unknown.example/", sites), null);
    assert.equal(findEnabledSite("about:blank", sites), null);
    assert.equal(findEnabledSite("chrome://extensions", sites), null);
  });
});
