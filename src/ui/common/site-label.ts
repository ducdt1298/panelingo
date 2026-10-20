// How a site key (an origin) is shown in the extension pages: the host, and its first letter for an avatar. PURE.

/** "reader.example.com" for "https://reader.example.com"; the scheme is kept when it is not https. */
export function hostOf(siteKey: string): string {
  try {
    const url = new URL(siteKey);
    return url.protocol === "https:" ? url.host : `${url.protocol}//${url.host}`;
  } catch {
    return siteKey;
  }
}

/** The first letter of the host (without "www."), upper case, for the site's avatar. */
export function initialOf(siteKey: string): string {
  const host = hostOf(siteKey)
    .replace(/^[a-z]+:\/\//u, "")
    .replace(/^www\./u, "");
  return (host[0] ?? "?").toUpperCase();
}
