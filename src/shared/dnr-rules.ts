// Pure builders for the extension's declarativeNetRequest session rules (SSRF guard and Referer). The service worker
// (src/sw/dnr.ts) applies them; string literals match chrome.declarativeNetRequest's enum values. PURE.
//
// Layout (all rules scoped to the extension's own non-tab requests: initiatorDomains [extension id],
// tabIds [TAB_ID_NONE = -1], so page and content-script requests are never touched):
//   ids 1–6      priority 1  block   literal private / loopback / link-local hosts (one regex per range: a single
//                                    regex exceeds DNR's 2 KB compiled-regex limit on Chrome 154)
//   ids 10–99    priority 2  allow   the configured API endpoint and dev fixture hosts
//   ids ≥ 1000   priority 3  modifyHeaders  Referer (and optionally Origin) per image host

export const TAB_ID_NONE = -1;
export const GUARD_FIRST_ID = 1;
export const ALLOW_FIRST_ID = 10;
export const ALLOW_LAST_ID = 99;
export const REFERER_FIRST_ID = 1000;
export const REFERER_MAX_RULES = 4000;

/** One anchored regex per private range (each validated with isRegexSupported on Chrome 154). */
export const GUARD_REGEXES: readonly string[] = [
  String.raw`^https?://(0|10|127)\.[0-9]+\.[0-9]+\.[0-9]+(:[0-9]+)?/`,
  String.raw`^https?://(169\.254|192\.168)\.[0-9]+\.[0-9]+(:[0-9]+)?/`,
  String.raw`^https?://172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+(:[0-9]+)?/`,
  String.raw`^https?://100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+(:[0-9]+)?/`,
  String.raw`^https?://\[`,
  String.raw`^https?://([^/:]+\.)?localhost(:[0-9]+)?/`,
];

export interface DnrHeaderOp {
  header: string;
  operation: "set" | "remove";
  value?: string;
}

export interface DnrRuleLike {
  id: number;
  priority: number;
  action: { type: "block" } | { type: "allow" } | { type: "modifyHeaders"; requestHeaders: DnrHeaderOp[] };
  condition: {
    regexFilter?: string;
    urlFilter?: string;
    requestDomains?: string[];
    initiatorDomains: string[];
    tabIds: number[];
  };
}

/** Guard block rules plus allow rules for the given origins (e.g. "http://127.0.0.1:11434"). */
export function buildGuardRules(extensionId: string, allowOrigins: readonly string[]): DnrRuleLike[] {
  if (allowOrigins.length > ALLOW_LAST_ID - ALLOW_FIRST_ID + 1) {
    throw new Error(`too many allow origins (${allowOrigins.length})`);
  }
  const scope = { initiatorDomains: [extensionId], tabIds: [TAB_ID_NONE] };
  const block: DnrRuleLike[] = GUARD_REGEXES.map((regexFilter, index) => ({
    id: GUARD_FIRST_ID + index,
    priority: 1,
    action: { type: "block" },
    condition: { regexFilter, ...scope },
  }));
  const allow: DnrRuleLike[] = [...new Set(allowOrigins.map(normalizeOrigin))].map((origin, index) => ({
    id: ALLOW_FIRST_ID + index,
    priority: 2,
    action: { type: "allow" },
    condition: { urlFilter: `|${origin}/`, ...scope },
  }));
  return [...block, ...allow];
}

/** Referer rule for one image host. referer null removes the header; removeOrigin drops Origin too. */
export function buildRefererRule(
  id: number,
  extensionId: string,
  host: string,
  referer: string | null,
  removeOrigin: boolean,
): DnrRuleLike {
  if (id < REFERER_FIRST_ID) throw new Error(`referer rule id ${id} is below ${REFERER_FIRST_ID}`);
  const requestHeaders: DnrHeaderOp[] = [
    referer === null
      ? { header: "referer", operation: "remove" }
      : { header: "referer", operation: "set", value: referer },
  ];
  if (removeOrigin) requestHeaders.push({ header: "origin", operation: "remove" });
  return {
    id,
    priority: 3,
    action: { type: "modifyHeaders", requestHeaders },
    condition: { requestDomains: [host], initiatorDomains: [extensionId], tabIds: [TAB_ID_NONE] },
  };
}

/** "http://127.0.0.1:11434/v1" → "http://127.0.0.1:11434"; "127.0.0.1:8080" → "http://127.0.0.1:8080". */
export function normalizeOrigin(value: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  return new URL(withScheme).origin;
}

/** Host that owns a referer rule, or null when the rule is not a referer rule. */
export function refererRuleHost(rule: {
  id: number;
  condition?: { requestDomains?: string[] | undefined } | undefined;
}): string | null {
  if (rule.id < REFERER_FIRST_ID) return null;
  return rule.condition?.requestDomains?.[0] ?? null;
}

/** Next free referer id: max(existing referer ids) + 1, starting at REFERER_FIRST_ID. */
export function nextRefererId(existingIds: readonly number[]): number {
  let max = REFERER_FIRST_ID - 1;
  for (const id of existingIds) if (id >= REFERER_FIRST_ID && id > max) max = id;
  return max + 1;
}

/** True when two referer rules would send the same headers (so an update can be skipped). */
export function sameRefererAction(a: DnrRuleLike, b: DnrRuleLike): boolean {
  return JSON.stringify(a.action) === JSON.stringify(b.action);
}
