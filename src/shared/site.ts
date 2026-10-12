// Site identity (siteKey = origin) and Chrome match patterns for the runtime content-script registration.
// PURE. A site is stored as `site:<siteKey>`; the content script is registered for the patterns of every enabled
// site: its origin (every subdomain too with includeSubdomains) plus extraFrameOrigins for reader iframes served
// from another origin. Patterns keep an explicit port; like Chrome, a pattern without a port matches every port.
// Series and chapter keys of a page are derived in series-key.ts.

import type { SiteSettings } from "./settings.ts";

/** Lowercase origin of an http(s) URL; null for other schemes, opaque origins and unparsable input. */
export function siteKeyFor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") return null;
  return parsed.origin;
}

/** True when `value` is already a normalized siteKey (what `site:<siteKey>` storage keys must hold). */
export function isSiteKey(value: string): boolean {
  return siteKeyFor(value) === value;
}

/** Both URLs are http(s) with the same origin. */
export function isSameSite(a: string, b: string): boolean {
  const key = siteKeyFor(a);
  return key !== null && key === siteKeyFor(b);
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Chrome match patterns for a site: `scheme://host[:port]/*`, or `scheme://*.host[:port]/*` (the host itself and
 * every subdomain) when includeSubdomains is set and the host is a name rather than an IP literal. [] when invalid.
 */
export function matchPatternsFor(siteKey: string, includeSubdomains: boolean): string[] {
  const origin = siteKeyFor(siteKey);
  if (origin === null) return [];
  const url = new URL(origin);
  const host = includeSubdomains && !isIpLiteral(url.hostname) ? `*.${url.hostname}` : url.hostname;
  const port = url.port === "" ? "" : `:${url.port}`;
  return [`${url.protocol}//${host}${port}/*`];
}

const PATTERN = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*:[\]]+|\[[0-9a-f:.]+\])(?::(\*|\d+))?(\/.*)$/i;

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/** Chrome match-pattern semantics for http(s) URLs (scheme, `*.` subdomains, optional port, path glob). */
export function patternMatchesUrl(pattern: string, url: string): boolean {
  const match = PATTERN.exec(pattern);
  if (match === null) return false;
  const [, scheme = "", host = "", port, path = "/*"] = match;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (scheme !== "*" && `${scheme.toLowerCase()}:` !== parsed.protocol) return false;
  const wanted = host.toLowerCase();
  if (wanted !== "*") {
    if (wanted.startsWith("*.")) {
      const base = wanted.slice(2);
      if (parsed.hostname !== base && !parsed.hostname.endsWith(`.${base}`)) return false;
    } else if (parsed.hostname !== wanted) {
      return false;
    }
  }
  if (port !== undefined && port !== "*") {
    const effective = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
    if (effective !== port) return false;
  }
  return globToRegExp(path).test(`${parsed.pathname}${parsed.search}`);
}

/** Every match pattern the content script must be registered for, deduplicated and sorted. */
export function contentScriptMatches(sites: Readonly<Record<string, SiteSettings>>): string[] {
  const patterns = new Set<string>();
  for (const [siteKey, site] of Object.entries(sites)) {
    if (!site.enabled) continue;
    for (const pattern of matchPatternsFor(siteKey, site.includeSubdomains)) patterns.add(pattern);
    for (const origin of site.extraFrameOrigins) {
      for (const pattern of matchPatternsFor(origin, false)) patterns.add(pattern);
    }
  }
  return [...patterns].sort();
}

export interface SiteMatch {
  siteKey: string;
  site: SiteSettings;
  /** origin: the URL's own site · subdomain: includeSubdomains · frame: one of the site's extraFrameOrigins. */
  via: "origin" | "subdomain" | "frame";
}

/**
 * The enabled site that covers `url`, or null. The URL's own site record decides when it exists, enabled or not (a
 * subdomain the user turned off in the popup stays off under a parent with includeSubdomains); otherwise the most
 * specific site that covers it through includeSubdomains, then a site that lists its origin in extraFrameOrigins.
 */
export function findEnabledSite(
  url: string,
  sites: Readonly<Record<string, SiteSettings>>,
): SiteMatch | null {
  const origin = siteKeyFor(url);
  if (origin === null) return null;
  const own = sites[origin];
  if (own !== undefined) return own.enabled ? { siteKey: origin, site: own, via: "origin" } : null;
  const enabled = Object.entries(sites)
    .filter(([siteKey, site]) => site.enabled && isSiteKey(siteKey))
    .sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  for (const [siteKey, site] of enabled) {
    if (site.includeSubdomains && matchPatternsFor(siteKey, true).some((p) => patternMatchesUrl(p, url))) {
      return { siteKey, site, via: "subdomain" };
    }
  }
  for (const [siteKey, site] of enabled) {
    if (site.extraFrameOrigins.some((frameOrigin) => siteKeyFor(frameOrigin) === origin)) {
      return { siteKey, site, via: "frame" };
    }
  }
  return null;
}
