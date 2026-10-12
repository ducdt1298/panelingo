// URL aliases for the image cache (store `urls`): urlKey = "u:" + normalizeUrl(src). PURE.
//
// Deliberately conservative: only rewrites that can never make two different images share a key. The
// WHATWG parser lowercases scheme and host, drops default ports, canonicalizes IPv4 and IDN hosts and resolves dot
// segments; on top of that the fragment and any credentials are dropped. The query stays byte-for-byte: stripping
// CDN tokens is not done, as it would need evidence that it never merges different images.

export const URL_KEY_PREFIX = "u:";
/** Longer URLs get no alias (contentKey still dedupes them); keeps the `urls` store small. */
export const MAX_ALIAS_URL_LENGTH = 8192;

/** Canonical form of an http(s) URL, or null for anything that cannot be an alias (data:, blob:, malformed). */
export function normalizeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  const href = parsed.href;
  return href.length > MAX_ALIAS_URL_LENGTH ? null : href;
}

/** "u:" + normalizeUrl(url), or null when the URL has no alias (data:, blob:, malformed, too long). */
export function urlKeyOf(url: string): string | null {
  const normalized = normalizeUrl(url);
  return normalized === null ? null : `${URL_KEY_PREFIX}${normalized}`;
}
