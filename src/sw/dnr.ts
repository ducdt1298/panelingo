// Applies the declarativeNetRequest session rules built by src/shared/dnr-rules.ts (Referer rules, SSRF guard).
// Chrome is the source of truth: rule ids are rebuilt from getSessionRules() on every call (never cached in SW
// globals, which die with the worker), calls are serialized, and the referer-rule LRU lives in storage.session.

import {
  ALLOW_LAST_ID,
  REFERER_FIRST_ID,
  REFERER_MAX_RULES,
  buildGuardRules,
  buildRefererRule,
  nextRefererId,
  refererRuleHost,
  sameRefererAction,
  type DnrRuleLike,
} from "../shared/dnr-rules.ts";

const LRU_KEY = "dnr:lru";

let chain: Promise<unknown> = Promise.resolve();

/** Runs DNR updates one at a time (concurrent updateSessionRules calls race on rule ids). */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

function asChromeRules(rules: readonly DnrRuleLike[]): chrome.declarativeNetRequest.Rule[] {
  // The literal action/operation strings equal the chrome.declarativeNetRequest enum values.
  return rules as unknown as chrome.declarativeNetRequest.Rule[];
}

async function readLru(): Promise<Record<string, number>> {
  const stored = await chrome.storage.session.get(LRU_KEY);
  const value: unknown = stored[LRU_KEY];
  return typeof value === "object" && value !== null ? (value as Record<string, number>) : {};
}

async function writeLru(lru: Record<string, number>): Promise<void> {
  await chrome.storage.session.set({ [LRU_KEY]: lru });
}

export interface GuardInstallResult {
  installed: number;
  unsupported: string[];
}

/**
 * Installs the SSRF guard (block literal private hosts) plus allow rules for the API endpoint and dev fixture hosts.
 * Regexes Chrome cannot compile are skipped and reported instead of failing the whole update.
 */
export function installGuardRules(allowOrigins: readonly string[]): Promise<GuardInstallResult> {
  return serialize(async () => {
    const unsupported: string[] = [];
    const rules: DnrRuleLike[] = [];
    for (const rule of buildGuardRules(chrome.runtime.id, allowOrigins)) {
      const regex = rule.condition.regexFilter;
      if (regex !== undefined) {
        const check = await chrome.declarativeNetRequest.isRegexSupported({ regex });
        if (!check.isSupported) {
          unsupported.push(regex);
          continue;
        }
      }
      rules.push(rule);
    }
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existing.filter((r) => r.id <= ALLOW_LAST_ID).map((r) => r.id),
      addRules: asChromeRules(rules),
    });
    return { installed: rules.length, unsupported };
  });
}

/**
 * Ensures exactly one Referer rule for `host` with the given headers; idempotent. Returns the rule id. Evicts the
 * least recently used hosts when more than REFERER_MAX_RULES referer rules would exist.
 */
export function ensureRefererRule(
  host: string,
  referer: string | null,
  removeOrigin: boolean,
): Promise<number> {
  return serialize(async () => {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const current = existing.find((r) => refererRuleHost(r) === host);
    const id = current?.id ?? nextRefererId(existing.map((r) => r.id));
    const rule = buildRefererRule(id, chrome.runtime.id, host, referer, removeOrigin);

    const lru = await readLru();
    lru[host] = Date.now();

    if (current !== undefined && sameRefererAction(current as unknown as DnrRuleLike, rule)) {
      await writeLru(lru);
      return id;
    }

    const removeRuleIds = [id];
    const refererRules = existing.filter((r) => r.id >= REFERER_FIRST_ID);
    if (current === undefined && refererRules.length >= REFERER_MAX_RULES) {
      const byAge = refererRules
        .map((r) => ({ id: r.id, host: refererRuleHost(r) ?? "", used: lru[refererRuleHost(r) ?? ""] ?? 0 }))
        .sort((a, b) => a.used - b.used);
      const excess = refererRules.length - REFERER_MAX_RULES + 1;
      for (const victim of byAge.slice(0, excess)) {
        removeRuleIds.push(victim.id);
        delete lru[victim.host];
      }
    }

    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: asChromeRules([rule]) });
    await writeLru(lru);
    return id;
  });
}

/** Removes every Referer rule (e.g. on engine close); guard rules stay. */
export function clearRefererRules(): Promise<number> {
  return serialize(async () => {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const ids = existing.filter((r) => r.id >= REFERER_FIRST_ID).map((r) => r.id);
    if (ids.length > 0) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    await writeLru({});
    return ids.length;
  });
}
