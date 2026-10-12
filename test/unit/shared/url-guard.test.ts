import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkImageUrl,
  isBlockedIpv4,
  type UrlGuardOptions,
  type UrlGuardReason,
} from "../../../src/shared/url-guard.ts";

const BS = "\\";
const DEV_HOSTS = ["127.0.0.1:8080", "localhost:8081"];

interface Case {
  url: string;
  expect: "ok" | UrlGuardReason;
  /** Expected href when ok (defaults to the parser's href, not checked). */
  href?: string;
  allow?: readonly string[];
  why: string;
}

const CASES: readonly Case[] = [
  // ---- public hosts pass, as parsed hrefs
  {
    url: "https://cdn.example.com/a/b.jpg",
    expect: "ok",
    href: "https://cdn.example.com/a/b.jpg",
    why: "public",
  },
  {
    url: "http://img.example.org:8080/x.png?token=abc&e=1",
    expect: "ok",
    href: "http://img.example.org:8080/x.png?token=abc&e=1",
    why: "port and query kept",
  },
  { url: "HTTPS://CDN.EXAMPLE.COM/A.JPG", expect: "ok", href: "https://cdn.example.com/A.JPG", why: "case" },
  {
    url: "https://cdn.example.com:443/x",
    expect: "ok",
    href: "https://cdn.example.com/x",
    why: "default port",
  },
  { url: "http://93.184.216.34/x.png", expect: "ok", why: "public IPv4" },
  { url: "http://1.0.0.0/", expect: "ok", why: "just above 0/8" },
  { url: "http://11.0.0.1/", expect: "ok", why: "just above 10/8" },
  { url: "http://100.63.255.255/", expect: "ok", why: "just below 100.64/10" },
  { url: "http://100.128.0.0/", expect: "ok", why: "just above 100.64/10" },
  { url: "http://172.15.255.255/", expect: "ok", why: "just below 172.16/12" },
  { url: "http://172.32.0.1/", expect: "ok", why: "just above 172.16/12" },
  { url: "http://198.17.255.255/", expect: "ok", why: "just below 198.18/15" },
  { url: "http://198.20.0.0/", expect: "ok", why: "just above 198.18/15" },
  { url: "http://223.255.255.255/", expect: "ok", why: "just below multicast" },
  { url: "https://localhost.example.com/x", expect: "ok", why: "localhost only as a label of a public name" },
  { url: "https://münchen.de/x", expect: "ok", href: "https://xn--mnchen-3ya.de/x", why: "IDN → punycode" },
  { url: "https://example.com./x", expect: "ok", why: "public name with the root dot" },
  { url: `http://evil.com${BS}@127.0.0.1/`, expect: "ok", why: "a backslash ends the host: evil.com" },

  // ---- malformed
  { url: "", expect: "malformed", why: "empty" },
  { url: "not a url", expect: "malformed", why: "garbage" },
  { url: "/relative/page.png", expect: "malformed", why: "relative" },
  { url: "//127.0.0.1/x", expect: "malformed", why: "scheme-relative" },
  { url: "http://256.0.0.1/", expect: "malformed", why: "IPv4 octet > 255" },
  { url: "http://1.2.3.4.5/", expect: "malformed", why: "five numeric labels" },
  { url: "http://4294967296/", expect: "malformed", why: "decimal IPv4 > 32 bits" },
  { url: "http://[fe80::1%25eth0]/", expect: "malformed", why: "IPv6 zone id" },

  // ---- scheme
  { url: "data:image/png;base64,AAAA", expect: "scheme", why: "data: is read in content" },
  { url: "blob:https://reader.example/9b1e", expect: "scheme", why: "blob: is read in content" },
  { url: "ftp://example.com/x.png", expect: "scheme", why: "ftp" },
  { url: "file:///C:/x.png", expect: "scheme", why: "file" },
  { url: "javascript:alert(1)", expect: "scheme", why: "javascript" },
  { url: "chrome-extension://abcdefgh/x.png", expect: "scheme", why: "extension" },
  { url: "ws://example.com/", expect: "scheme", why: "websocket" },
  {
    url: "ftp://127.0.0.1:8080/x",
    expect: "scheme",
    allow: DEV_HOSTS,
    why: "the allow-list never widens schemes",
  },

  // ---- credentials
  { url: "https://user:pass@example.com/x", expect: "credentials", why: "user + password" },
  { url: "https://user@example.com/x", expect: "credentials", why: "user only" },
  { url: "https://:pw@example.com/x", expect: "credentials", why: "password only" },
  { url: "http://127.0.0.1%2f@evil.com/", expect: "credentials", why: "encoded slash in the userinfo" },
  {
    url: "http://user@localhost:8081/x",
    expect: "credentials",
    allow: DEV_HOSTS,
    why: "checked before allowHosts",
  },

  // ---- localhost names
  { url: "http://localhost/x", expect: "localhost", why: "localhost" },
  { url: "http://LOCALHOST:8081/x", expect: "localhost", why: "uppercase, not allow-listed" },
  { url: "http://localhost./x", expect: "localhost", why: "root dot" },
  { url: "http://foo.localhost/x", expect: "localhost", why: "*.localhost" },
  { url: "http://a.b.localhost./x", expect: "localhost", why: "nested *.localhost with root dot" },
  { url: "http://ｌｏｃａｌｈｏｓｔ/x", expect: "localhost", why: "full-width letters" },

  // ---- private network names
  { url: "http://intranet/x", expect: "local-name", why: "single label" },
  { url: "http://printer.local/x", expect: "local-name", why: ".local" },
  { url: "http://nas.lan/x", expect: "local-name", why: ".lan" },
  { url: "http://router.home.arpa/x", expect: "local-name", why: ".home.arpa" },
  { url: "http://metadata.google.internal/x", expect: "local-name", why: ".internal" },
  { url: "http://wiki.corp/x", expect: "local-name", why: ".corp" },
  { url: "http://portal.intranet/x", expect: "local-name", why: ".intranet" },
  { url: "http://localhost.localdomain/x", expect: "local-name", why: ".localdomain" },

  // ---- private / special IPv4, in every spelling the parser accepts
  { url: "http://127.0.0.1/", expect: "private-ip", why: "loopback" },
  { url: "http://2130706433/", expect: "private-ip", why: "decimal loopback" },
  { url: "http://0x7f.1/", expect: "private-ip", why: "hex + short form" },
  { url: "http://0177.0.0.1/", expect: "private-ip", why: "octal" },
  { url: "http://127.1/", expect: "private-ip", why: "two-part form" },
  { url: "http://0x7f000001/", expect: "private-ip", why: "hex integer" },
  { url: "http://017700000001/", expect: "private-ip", why: "octal integer" },
  { url: "http://0x7f.0x0.0x0.0x1/", expect: "private-ip", why: "hex parts" },
  { url: "http://%31%32%37.0.0.1/", expect: "private-ip", why: "percent-encoded host" },
  { url: "http://１２７.０.０.１/", expect: "private-ip", why: "full-width digits" },
  { url: `http:${BS}${BS}127.0.0.1${BS}x`, expect: "private-ip", why: "backslashes" },
  { url: "http:127.0.0.1/x", expect: "private-ip", why: "missing slashes" },
  { url: " http://127.0.0.1/ ", expect: "private-ip", why: "surrounding spaces" },
  { url: "http://\t127.0.0.1/", expect: "private-ip", why: "embedded tab" },
  { url: "http://127.0.0.1./", expect: "private-ip", why: "root dot" },
  { url: "http://0/", expect: "private-ip", why: "0 → 0.0.0.0" },
  { url: "http://0.0.0.0:8080/", expect: "private-ip", why: "unspecified" },
  { url: "http://10.1.2.3/", expect: "private-ip", why: "10/8" },
  { url: "http://100.64.0.1/", expect: "private-ip", why: "CGNAT low" },
  { url: "http://100.127.255.255/", expect: "private-ip", why: "CGNAT high" },
  { url: "http://169.254.169.254/latest/meta-data/", expect: "private-ip", why: "cloud metadata" },
  { url: "http://172.16.0.1/", expect: "private-ip", why: "172.16/12 low" },
  { url: "http://172.31.255.255/", expect: "private-ip", why: "172.16/12 high" },
  { url: "http://192.0.0.8/", expect: "private-ip", why: "IETF protocol assignments" },
  { url: "http://192.0.2.10/", expect: "private-ip", why: "TEST-NET-1" },
  { url: "http://192.168.1.1/", expect: "private-ip", why: "192.168/16" },
  { url: "http://0300.0250.0.1/", expect: "private-ip", why: "octal 192.168.0.1" },
  { url: "http://3232235777/", expect: "private-ip", why: "decimal 192.168.1.1" },
  { url: "http://198.18.0.1/", expect: "private-ip", why: "benchmarking low" },
  { url: "http://198.19.255.255/", expect: "private-ip", why: "benchmarking high" },
  { url: "http://198.51.100.7/", expect: "private-ip", why: "TEST-NET-2" },
  { url: "http://203.0.113.9/", expect: "private-ip", why: "TEST-NET-3" },
  { url: "http://224.0.0.1/", expect: "private-ip", why: "multicast" },
  { url: "http://239.255.255.250/", expect: "private-ip", why: "SSDP multicast" },
  { url: "http://240.0.0.1/", expect: "private-ip", why: "reserved" },
  { url: "http://255.255.255.255/", expect: "private-ip", why: "broadcast" },
  { url: "http://4294967295/", expect: "private-ip", why: "decimal broadcast" },

  // ---- every IPv6 literal
  { url: "http://[::1]/", expect: "ipv6", why: "loopback" },
  { url: "http://[0:0:0:0:0:0:0:1]/", expect: "ipv6", why: "long loopback" },
  { url: "http://[::]/", expect: "ipv6", why: "unspecified" },
  { url: "http://[::ffff:127.0.0.1]/", expect: "ipv6", why: "IPv4-mapped loopback" },
  { url: "http://[::ffff:8.8.8.8]/", expect: "ipv6", why: "IPv4-mapped public" },
  { url: "http://[64:ff9b::7f00:1]/", expect: "ipv6", why: "NAT64" },
  { url: "http://[fe80::1]/", expect: "ipv6", why: "link-local" },
  { url: "http://[fc00::1]:8080/", expect: "ipv6", why: "unique local" },
  { url: "https://[2001:4860:4860::8888]/", expect: "ipv6", why: "public IPv6 too" },

  // ---- dev fixture hosts (exact host:port, http only)
  { url: "http://127.0.0.1:8080/img/p1.png", expect: "ok", allow: DEV_HOSTS, why: "reader fixture host" },
  { url: "http://localhost:8081/protected/p1.png", expect: "ok", allow: DEV_HOSTS, why: "CDN fixture host" },
  { url: "http://LocalHost:8081/x", expect: "ok", allow: DEV_HOSTS, why: "host case" },
  { url: "http://127.0.0.1:8081/x", expect: "private-ip", allow: DEV_HOSTS, why: "other port" },
  { url: "http://localhost:8080/x", expect: "localhost", allow: DEV_HOSTS, why: "other host for that port" },
  {
    url: "https://localhost:8081/x",
    expect: "localhost",
    allow: DEV_HOSTS,
    why: "https is never allow-listed",
  },
  { url: "http://127.0.0.1/x", expect: "ok", allow: ["127.0.0.1"], why: "entry without port = 80" },
  { url: "http://127.0.0.1:80/x", expect: "ok", allow: ["127.0.0.1:80"], why: "explicit :80" },
  { url: "http://[::1]:8080/x", expect: "ok", allow: ["[::1]:8080"], why: "IPv6 entry" },
  {
    url: "http://127.0.0.1:8080/x",
    expect: "private-ip",
    allow: ["", "http://127.0.0.1:8080/", "127.0.0.1:8080/x", "u@127.0.0.1:8080", "127.0.0.1:99999", "[::1"],
    why: "malformed entries are ignored",
  },
  { url: "http://127.0.0.1:8080/x", expect: "private-ip", allow: [], why: "empty allow-list" },
];

test("the table has at least 40 cases", () => {
  assert.ok(CASES.length >= 40, `${CASES.length} cases`);
});

for (const c of CASES) {
  test(`${JSON.stringify(c.url)} → ${c.expect} (${c.why})`, () => {
    const options: UrlGuardOptions = c.allow === undefined ? {} : { allowHosts: c.allow };
    const result = checkImageUrl(c.url, options);
    if (c.expect === "ok") {
      assert.equal(result.ok, true, JSON.stringify(result));
      if (result.ok && c.href !== undefined) assert.equal(result.url, c.href);
    } else {
      assert.deepEqual(result, { ok: false, reason: c.expect });
    }
  });
}

test("ok results are the parsed href, ready for fetch", () => {
  const result = checkImageUrl("  HTTP://Cdn.Example.com:80/a/./b/../c.png?q=1#frag ");
  assert.deepEqual(result, { ok: true, url: "http://cdn.example.com/a/c.png?q=1#frag" });
});

test("isBlockedIpv4 range boundaries", () => {
  const ip = (a: number, b: number, c: number, d: number): number =>
    ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const blocked: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],
    [0, 255, 255, 255],
    [10, 255, 255, 255],
    [127, 255, 255, 254],
    [169, 254, 0, 0],
    [192, 88, 99, 1],
    [255, 255, 255, 255],
  ];
  const open: Array<[number, number, number, number]> = [
    [1, 1, 1, 1],
    [8, 8, 8, 8],
    [169, 253, 255, 255],
    [169, 255, 0, 0],
    [192, 0, 1, 1],
    [192, 167, 255, 255],
    [192, 169, 0, 0],
  ];
  for (const parts of blocked) assert.equal(isBlockedIpv4(ip(...parts)), true, parts.join("."));
  for (const parts of open) assert.equal(isBlockedIpv4(ip(...parts)), false, parts.join("."));
});
