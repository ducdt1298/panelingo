// What to do after a failed or incomplete request. PURE: time and randomness are passed in.
//
// Two layers:
// - decide(): HTTP-level action for one ErrorInfo. At most 2 HTTP retries per request (not counted in the ladder).
// - planLadder(): id-level steps for a pack after a completed (possibly truncated or partial) stream. At most 4 extra
//   requests per pack: one crops-only re-ask, splits of the missing ids by position (depth ≤ 2), one full retry after
//   empty/garbage output; then the units stay untranslated. Refusals are never retried unless splitOnRefusal is on
//   (default off: refused content would be uploaded again and is never deleted upstream).

import type { ErrorCode, ErrorInfo } from "../errors.ts";
import type { PackOutcome } from "./id-accounting.ts";

/** Backoff for 429 and 5xx, ±20% jitter. With the 2-retry budget only the first two steps are reached. */
export const HTTP_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000];
export const JITTER_RATIO = 0.2;
export const MAX_HTTP_RETRIES = 2;
export const RATE_LIMIT_CONCURRENCY = Object.freeze({ value: 1, forMs: 10 * 60_000 });
export const TIMEOUT_RETRY_DELAY_MS = 120_000;
export const TIMEOUT_CONCURRENCY = Object.freeze({ value: 1, forMs: 5 * 60_000 });
export const TIMEOUT_WATCHDOG_FACTOR = 1.5;
export const SHRINK_JPEG_QUALITY = 0.8;
export const EMPTY_RETRY_DELAY_MS = 3_000;
/** After a 401/403 the request is tried once more after this delay (a key fixed in the meantime), then waits. */
export const UNAUTHORIZED_PROBE_MS = 60_000;
export const MAX_LADDER_REQUESTS = 4;
export const MAX_SPLIT_DEPTH = 2;
export const REASK_MAX_RATIO = 0.3;
export const AUTO_PASSES = Object.freeze({ max: 2, windowMs: 10 * 60_000 });

export type RetryAction = "retry" | "pause" | "split" | "shrink" | "fail" | "reask";

export interface RetryDecision {
  /**
   * retry: send the same request again after delayMs · pause: hold the queue (resume tells how) · split: halve the
   * pack · shrink: rebuild the composite at jpegQuality · fail: give up on this request · reask: keep the valid lines
   * and run planLadder for the missing ids.
   */
  action: RetryAction;
  delayMs?: number;
  /** now + delayMs. */
  at?: number;
  /** Temporary concurrency cap for the whole queue. */
  concurrency?: { value: number; forMs: number };
  /** Multiply the client watchdogs for the retried request. */
  watchdogFactor?: number;
  jpegQuality?: number;
  /** This retry counts as a ladder request (full retry after empty or garbage output). */
  ladder?: boolean;
  /** How a pause ends: a ready GET /models check, a user action, or the delay (a single probe). */
  resume?: "health" | "user" | "timer";
}

export interface RetryPolicyOptions {
  /** HTTP retries allowed per request (default 2). */
  maxHttpRetries?: number;
  /** False when the pack cannot be split further (single unit or ladder depth reached): split becomes fail. */
  canSplit?: boolean;
  /**
   * Earlier failures of this request with the same code (default: `attempt`). Pass it when a request can fail with
   * different codes, so that one code's single retry (timeout, context_length, too_large, protocol, empty) is not
   * used up by another code's retry; `attempt` still caps the total at maxHttpRetries.
   */
  sameCodeAttempts?: number;
}

/** `ms` ± ratio, using rng() ∈ [0, 1). */
export function jitter(ms: number, rng: () => number, ratio: number = JITTER_RATIO): number {
  return Math.round(ms * (1 + (rng() * 2 - 1) * ratio));
}

const PAUSE_UNTIL: Partial<Record<ErrorCode, "health" | "user">> = {
  "api.unreachable": "health",
  "api.lna_blocked": "user",
  "api.config": "user",
};

/**
 * HTTP-level decision for a failed request. `attempt` = times this request was already sent again after a failure
 * (retry or shrink; 0 on the first failure); `now` is used for `at`; `rng` drives the jitter.
 */
export function decide(
  info: Pick<ErrorInfo, "code">,
  attempt: number,
  now: number,
  rng: () => number,
  options: RetryPolicyOptions = {},
): RetryDecision {
  const tries = Math.max(0, Math.floor(attempt));
  const same = Math.max(0, Math.floor(options.sameCodeAttempts ?? tries));
  const maxRetries = options.maxHttpRetries ?? MAX_HTTP_RETRIES;
  const canSplit = options.canSplit ?? true;
  const splitOrFail = (): RetryDecision => (canSplit ? { action: "split" } : { action: "fail" });
  const retry = (
    delayMs: number,
    extra: Omit<RetryDecision, "action" | "delayMs" | "at"> = {},
  ): RetryDecision => ({
    action: "retry",
    delayMs,
    at: now + delayMs,
    ...extra,
  });
  const backoff = (): number =>
    jitter(HTTP_BACKOFF_MS[Math.min(tries, HTTP_BACKOFF_MS.length - 1)] ?? 15_000, rng);
  const code = info.code;

  const pauseUntil = PAUSE_UNTIL[code];
  if (pauseUntil !== undefined) {
    return { action: "pause", resume: pauseUntil };
  }
  if (code === "api.unauthorized") {
    // A wrong or missing API key: one probe after 60 s (the user may have fixed it), then wait for the user.
    return same === 0
      ? {
          action: "pause",
          resume: "timer",
          delayMs: UNAUTHORIZED_PROBE_MS,
          at: now + UNAUTHORIZED_PROBE_MS,
        }
      : { action: "pause", resume: "user" };
  }
  if (code === "api.rate_limit") {
    const concurrency = { ...RATE_LIMIT_CONCURRENCY };
    return tries < maxRetries ? retry(backoff(), { concurrency }) : { action: "fail", concurrency };
  }
  if (code === "api.upstream") {
    return tries < maxRetries ? retry(backoff()) : { action: "fail" };
  }
  if (code === "api.timeout") {
    // The abandoned request still runs upstream: wait until it has plausibly finished, then retry alone.
    const concurrency = { ...TIMEOUT_CONCURRENCY };
    return same === 0 && tries < maxRetries
      ? retry(TIMEOUT_RETRY_DELAY_MS, { concurrency, watchdogFactor: TIMEOUT_WATCHDOG_FACTOR })
      : { action: "fail", concurrency };
  }
  if (code === "api.context_length") {
    // The prompt plus the composite exceed the model's window: halve the pack (the halves are new requests with
    // their own budgets), and fail only when the pack cannot be halved any more.
    return splitOrFail();
  }
  if (code === "api.too_large") {
    // Rebuild the composite smaller once (not a blind retry), then halve the pack.
    return same === 0 ? { action: "shrink", jpegQuality: SHRINK_JPEG_QUALITY } : splitOrFail();
  }
  if (code === "api.empty" || code === "llm.format") {
    // One full retry of the same composite, counted as a ladder request; then the normal ladder.
    return same === 0 ? retry(jitter(EMPTY_RETRY_DELAY_MS, rng), { ladder: true }) : { action: "reask" };
  }
  if (code === "api.truncated" || code === "api.partial") {
    return { action: "reask" };
  }
  if (code === "api.protocol") {
    return same === 0 && tries < maxRetries ? retry(backoff()) : { action: "fail" };
  }
  // llm.refused (no retry, no erase), api.bad_request, and every code that is not about the API call.
  return { action: "fail" };
}

/** True when another automatic pass is allowed for a unit, given the times of its previous automatic passes. */
export function allowAutoPass(passTimes: readonly number[], now: number, limit = AUTO_PASSES): boolean {
  return passTimes.filter((t) => now - t < limit.windowMs).length < limit.max;
}

export interface LadderState {
  /** Pack-level ids answered by this request: ids[k - 1] is the pack id behind label #k. In position order. */
  ids: readonly number[];
  /** Split depth of this request (0 = the original pack). */
  depth: number;
  /** The pack's single crops-only re-ask was already used. */
  reaskUsed: boolean;
  /** The pack's single full retry after empty/garbage output was already used. */
  fullRetryUsed: boolean;
  /** Ladder requests already issued for this pack (the first request does not count). */
  extraRequests: number;
  /** translate.splitOnRefusal (default false). */
  splitOnRefusal?: boolean;
  maxExtraRequests?: number;
  maxDepth?: number;
}

export type LadderStep =
  | { kind: "done" }
  /** Send the same request again (empty or garbage output). Costs 1 ladder request. */
  | { kind: "retry"; ids: number[] }
  /** Crops-only composite renumbered 1..k, neighbouring validated lines as history. Costs 1. `refused` are final. */
  | { kind: "reask"; ids: number[]; refused: number[] }
  /** One full composite per group (groups.length ladder requests, depth + 1). `refused` are final. */
  | { kind: "split"; groups: number[][]; refused: number[] }
  /**
   * Final: keep the original pixels; untranslated units offer "Translate again", refused ones show "The AI refused".
   * A unit that already holds a valid translation (a suspect-merge id re-asked by an earlier step) keeps it: only
   * ids without one are downgraded.
   */
  | { kind: "give-up"; untranslated: number[]; refused: number[] };

function halves(ids: readonly number[]): number[][] {
  if (ids.length <= 1) {
    return ids.length === 0 ? [] : [[...ids]];
  }
  const cut = Math.ceil(ids.length / 2);
  return [ids.slice(0, cut), ids.slice(cut)];
}

/**
 * Next ladder step for the request described by `state`, given its PackOutcome (labels 1..state.ids.length).
 * Suspect-merge ids are ok (already drawn): they join re-asks and splits to get a cleaner line, but never a give-up.
 * A split must send fewer ids per request than this one did, so a single unit is never sent again unchanged.
 */
export function planLadder(outcome: PackOutcome, state: LadderState): LadderStep {
  const budget = (state.maxExtraRequests ?? MAX_LADDER_REQUESTS) - state.extraRequests;
  const maxDepth = state.maxDepth ?? MAX_SPLIT_DEPTH;
  const splitOnRefusal = state.splitOnRefusal ?? false;
  const toPackIds = (labels: Iterable<number>): number[] => {
    const ids = new Set<number>();
    for (const label of labels) {
      const id = state.ids[label - 1];
      if (id !== undefined) {
        ids.add(id);
      }
    }
    return [...ids].sort((a, b) => a - b);
  };
  const suspects = toPackIds(outcome.suspects);
  const withoutSuspects = (ids: readonly number[]): number[] => ids.filter((id) => !suspects.includes(id));
  const progresses = (groups: readonly number[][]): boolean =>
    groups.length > 0 && groups.every((group) => group.length < state.ids.length);

  if (outcome.refusal) {
    const refused = toPackIds(outcome.missing);
    if (refused.length === 0) {
      return { kind: "done" };
    }
    const unresolved = toPackIds([...outcome.missing, ...outcome.suspects]);
    if (splitOnRefusal && state.depth === 0 && unresolved.length >= 4 && budget >= 2) {
      return { kind: "split", groups: halves(unresolved), refused: [] };
    }
    return { kind: "give-up", untranslated: [], refused };
  }

  if (outcome.received === 0 && !state.fullRetryUsed && budget >= 1 && state.ids.length > 0) {
    return { kind: "retry", ids: [...state.ids].sort((a, b) => a - b) };
  }

  const refusedLabels: number[] = [];
  const missLabels: number[] = [...outcome.suspects];
  for (const label of outcome.missing) {
    const result = outcome.byId.get(label);
    if (!splitOnRefusal && result?.status === "missing" && result.reason === "refusal") {
      refusedLabels.push(label);
    } else {
      missLabels.push(label);
    }
  }
  const refused = toPackIds(refusedLabels);
  const miss = toPackIds(missLabels).filter((id) => !refused.includes(id));
  if (miss.length === 0) {
    return refused.length === 0 ? { kind: "done" } : { kind: "give-up", untranslated: [], refused };
  }

  const reaskLimit = Math.max(2, Math.ceil(REASK_MAX_RATIO * state.ids.length));
  if (!state.reaskUsed && miss.length <= reaskLimit && budget >= 1) {
    return { kind: "reask", ids: miss, refused };
  }
  if (state.depth < maxDepth) {
    const groups = halves(miss);
    if (progresses(groups) && budget >= groups.length) {
      return { kind: "split", groups, refused };
    }
  }
  const untranslated = withoutSuspects(miss);
  return untranslated.length === 0 && refused.length === 0
    ? { kind: "done" }
    : { kind: "give-up", untranslated, refused };
}
