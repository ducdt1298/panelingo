// SSRF guard for engine image fetches: page-supplied URLs must never reach the user's private network. PURE.
//
// Every check runs on the WHATWG-parsed URL: the parser already turns decimal, octal, hex and short IPv4 forms
// (2130706433, 0x7f.1, 0177.0.0.1, 127.1) into dotted quads, maps full-width characters, lowercases the host and
// drops default ports, so the rules below only ever see canonical hosts. Redirects are re-checked by the caller on
// the final response URL; DNS rebinding (a public name resolving to a private address) is a known residual risk,
// since the DNR guard rules only cover literal IPs.

export type UrlGuardReason =
  /** Not an absolute URL. */
  | "malformed"
  /** Not http: or https: (data: and blob: are read by the content script, never fetched by the engine). */
  | "scheme"
  /** user:pass@ in the URL. */
  | "credentials"
  /** localhost and *.localhost. */
  | "localhost"
  /** Single-label hosts and private-network suffixes (.local, .lan, .home.arpa, ...). */
  | "local-name"
  /** Private, loopback, link-local or otherwise special IPv4 literal. */
  | "private-ip"
  /** Every IPv6 literal. */
  | "ipv6";

export type UrlGuardResult = { ok: true; url: string } | { ok: false; reason: UrlGuardReason };

export interface UrlGuardOptions {
  /**
   * Exact "host:port" entries (settings.privacy.devFixtureHosts) that skip the host rules, http only. The caller
   * passes them only when __DEV__ || __TEST__; an entry without a port means port 80.
   */
  allowHosts?: readonly string[];
}

/** [network, prefix length] in host order. */
type Cidr = readonly [number, number];

function v4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** IANA special-purpose IPv4 blocks that must never be fetched (RFC 6890 and successors). */
const BLOCKED_V4: readonly Cidr[] = [
  [v4(0, 0, 0, 0), 8], // "this network"
  [v4(10, 0, 0, 0), 8], // private
  [v4(100, 64, 0, 0), 10], // carrier-grade NAT
  [v4(127, 0, 0, 0), 8], // loopback
  [v4(169, 254, 0, 0), 16], // link-local (cloud metadata endpoints)
  [v4(172, 16, 0, 0), 12], // private
  [v4(192, 0, 0, 0), 24], // IETF protocol assignments
  [v4(192, 0, 2, 0), 24], // TEST-NET-1
  [v4(192, 88, 99, 0), 24], // 6to4 relay anycast
  [v4(192, 168, 0, 0), 16], // private
  [v4(198, 18, 0, 0), 15], // benchmarking
  [v4(198, 51, 100, 0), 24], // TEST-NET-2
  [v4(203, 0, 113, 0), 24], // TEST-NET-3
  [v4(224, 0, 0, 0), 4], // multicast
  [v4(240, 0, 0, 0), 4], // reserved, including 255.255.255.255
];

/** Names that only resolve inside a private network. */
const LOCAL_SUFFIXES: readonly string[] = [
  ".local",
  ".localdomain",
  ".lan",
  ".home.arpa",
  ".internal",
  ".intranet",
  ".corp",
];

const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * The host as a number when it is an IPv4 literal. Only parsed hosts reach this: the WHATWG parser already
 * rejected octets over 255 and rewrote every other numeric form as a canonical dotted quad.
 */
function parseIpv4(host: string): number | null {
  const match = DOTTED_QUAD.exec(host);
  if (match === null) return null;
  const [a, b, c, d] = match.slice(1).map(Number) as [number, number, number, number];
  return v4(a, b, c, d);
}

export function isBlockedIpv4(address: number): boolean {
  // Every prefix in BLOCKED_V4 is ≥ 1 (a shift by 32 would be a shift by 0 in JS).
  return BLOCKED_V4.some(([network, prefix]) => (address & (0xffffffff << (32 - prefix))) >>> 0 === network);
}

/** "Host:8080" / "127.0.0.1" → "host:8080" / "127.0.0.1:80"; null when the entry is not a host[:port]. */
function canonicalAllowEntry(entry: string): string | null {
  const text = entry.trim();
  if (text === "" || /[/?#@\s]/.test(text)) return null;
  try {
    const parsed = new URL(`http://${text}`);
    return `${parsed.hostname}:${parsed.port === "" ? "80" : parsed.port}`;
  } catch {
    return null;
  }
}

function hostReason(hostname: string): UrlGuardReason | null {
  if (hostname.startsWith("[")) return "ipv6";
  // "localhost." and "printer.local." name the same hosts as without the root dot.
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  const ip = parseIpv4(host);
  if (ip !== null) return isBlockedIpv4(ip) ? "private-ip" : null;
  if (!host.includes(".")) return "local-name";
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "local-name";
  return null;
}

/**
 * Decides whether the engine may fetch `raw`. Rules in order: WHATWG parse, http/https only, no credentials,
 * exact allowHosts match (http only), then localhost names, single-label and private suffixes, private IPv4
 * ranges and every IPv6 literal. On success `url` is the parsed href.
 */
export function checkImageUrl(raw: string, options: UrlGuardOptions = {}): UrlGuardResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "credentials" };
  if (parsed.protocol === "http:" && options.allowHosts !== undefined && options.allowHosts.length > 0) {
    const hostPort = `${parsed.hostname}:${parsed.port === "" ? "80" : parsed.port}`;
    if (options.allowHosts.some((entry) => canonicalAllowEntry(entry) === hostPort)) {
      return { ok: true, url: parsed.href };
    }
  }
  const reason = hostReason(parsed.hostname);
  return reason === null ? { ok: true, url: parsed.href } : { ok: false, reason };
}
