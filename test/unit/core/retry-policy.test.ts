import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAccountant, type PackOutcome } from "../../../src/shared/core/id-accounting.ts";
import type { ItemRec } from "../../../src/shared/core/line-parser.ts";
import {
  allowAutoPass,
  decide,
  HTTP_BACKOFF_MS,
  jitter,
  planLadder,
  UNAUTHORIZED_PROBE_MS,
  type LadderState,
  type RetryDecision,
} from "../../../src/shared/core/retry-policy.ts";
import type { ErrorCode } from "../../../src/shared/errors.ts";

/** mulberry32: small seeded PRNG. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = 1_000_000;
const mid = (): number => 0.5;

function d(code: ErrorCode, attempt: number, rng: () => number = mid): RetryDecision {
  return decide({ code }, attempt, NOW, rng);
}

describe("jitter", () => {
  test("stays within ±20% and spans the range (seeded)", () => {
    const rng = seeded(42);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 2000; i += 1) {
      const value = jitter(10_000, rng);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    assert.ok(min >= 8_000 && max <= 12_000, `${min}..${max}`);
    assert.ok(min < 8_200 && max > 11_800, "uses most of the band");
    assert.equal(
      jitter(10_000, () => 0.5),
      10_000,
    );
    assert.equal(
      jitter(10_000, () => 0),
      8_000,
    );
  });
});

describe("decide: plan §4.6 actions and budgets", () => {
  test("429: 2 s then 5 s (±20%), then fail; concurrency 1 for 10 min every time", () => {
    const rng = seeded(7);
    const first = d("api.rate_limit", 0, rng);
    const second = d("api.rate_limit", 1, rng);
    const third = d("api.rate_limit", 2, rng);
    assert.equal(first.action, "retry");
    assert.ok((first.delayMs ?? 0) >= 1_600 && (first.delayMs ?? 0) <= 2_400, String(first.delayMs));
    assert.equal(first.at, NOW + (first.delayMs ?? 0));
    assert.equal(second.action, "retry");
    assert.ok((second.delayMs ?? 0) >= 4_000 && (second.delayMs ?? 0) <= 6_000, String(second.delayMs));
    assert.equal(third.action, "fail", "≤ 2 HTTP retries per request");
    for (const decision of [first, second, third]) {
      assert.deepEqual(decision.concurrency, { value: 1, forMs: 600_000 });
    }
  });

  test("the 15 s backoff step is used only when the retry budget is raised", () => {
    const decision = decide({ code: "api.rate_limit" }, 2, NOW, mid, { maxHttpRetries: 3 });
    assert.equal(decision.action, "retry");
    assert.equal(decision.delayMs, HTTP_BACKOFF_MS[2]);
  });

  test("502/503/504 (api.upstream): 2/5 s backoff, then fail; no concurrency change", () => {
    assert.deepEqual(d("api.upstream", 0), { action: "retry", delayMs: 2_000, at: NOW + 2_000 });
    assert.deepEqual(d("api.upstream", 1), { action: "retry", delayMs: 5_000, at: NOW + 5_000 });
    assert.deepEqual(d("api.upstream", 2), { action: "fail" });
  });

  test("watchdog timeout: one retry ≥ 120 s later at concurrency 1 for 5 min with watchdog ×1.5", () => {
    assert.deepEqual(d("api.timeout", 0), {
      action: "retry",
      delayMs: 120_000,
      at: NOW + 120_000,
      concurrency: { value: 1, forMs: 300_000 },
      watchdogFactor: 1.5,
    });
    assert.deepEqual(d("api.timeout", 1), { action: "fail", concurrency: { value: 1, forMs: 300_000 } });
  });

  test("400 context_length_exceeded: split at once (the same request would fail again), fail when it cannot", () => {
    assert.deepEqual(d("api.context_length", 0), { action: "split" }, "no blind retry first");
    assert.deepEqual(d("api.context_length", 1), { action: "split" });
    assert.deepEqual(d("api.context_length", 2), { action: "split" }, "a split is not an HTTP retry");
    for (const attempt of [0, 1]) {
      assert.deepEqual(decide({ code: "api.context_length" }, attempt, NOW, mid, { canSplit: false }), {
        action: "fail",
      });
    }
    assert.deepEqual(decide({ code: "api.context_length" }, 0, NOW, mid, { maxHttpRetries: 0 }), {
      action: "split",
    });
  });

  test("500 entity too large: rebuild at q0.80, then split, then fail", () => {
    assert.deepEqual(d("api.too_large", 0), { action: "shrink", jpegQuality: 0.8 });
    assert.deepEqual(d("api.too_large", 1), { action: "split" });
    assert.deepEqual(d("api.too_large", 2), { action: "split" });
    assert.deepEqual(decide({ code: "api.too_large" }, 1, NOW, mid, { canSplit: false }), {
      action: "fail",
    });
  });

  test("sameCodeAttempts: another code's retry does not use up a code's single retry", () => {
    const after502 = { sameCodeAttempts: 0 };
    // One 502 retry already made (attempt 1): the first timeout / too_large / protocol still gets its step.
    assert.deepEqual(decide({ code: "api.timeout" }, 1, NOW, mid, after502), {
      action: "retry",
      delayMs: 120_000,
      at: NOW + 120_000,
      concurrency: { value: 1, forMs: 300_000 },
      watchdogFactor: 1.5,
    });
    assert.deepEqual(decide({ code: "api.context_length" }, 1, NOW, mid, after502), { action: "split" });
    assert.deepEqual(decide({ code: "api.too_large" }, 1, NOW, mid, after502), {
      action: "shrink",
      jpegQuality: 0.8,
    });
    assert.equal(decide({ code: "api.protocol" }, 1, NOW, mid, after502).action, "retry");
    // The HTTP budget (2 per request) still caps blind retries.
    assert.equal(decide({ code: "api.timeout" }, 2, NOW, mid, after502).action, "fail");
    assert.equal(decide({ code: "api.context_length" }, 2, NOW, mid, after502).action, "split");
    // A context_length after other failures still splits while the pack can be halved.
    assert.equal(
      decide({ code: "api.context_length" }, 2, NOW, mid, { sameCodeAttempts: 1 }).action,
      "split",
    );
    // The code's own single retry is spent even if the request budget is not.
    assert.equal(decide({ code: "api.timeout" }, 1, NOW, mid, { sameCodeAttempts: 1 }).action, "fail");
    assert.equal(decide({ code: "api.empty" }, 1, NOW, mid, { sameCodeAttempts: 1 }).action, "reask");
    assert.equal(decide({ code: "api.empty" }, 1, NOW, mid, after502).action, "retry");
    assert.equal(
      decide({ code: "api.unauthorized" }, 1, NOW, mid, after502).resume,
      "timer",
      "the first api.unauthorized still gets its 60 s probe",
    );
  });

  test("empty or garbage: one full retry counted as a ladder request, then the ladder", () => {
    for (const code of ["api.empty", "llm.format"] as const) {
      const first = d(code, 0, seeded(3));
      assert.equal(first.action, "retry");
      assert.equal(first.ladder, true);
      assert.ok((first.delayMs ?? 0) >= 2_400 && (first.delayMs ?? 0) <= 3_600);
      assert.deepEqual(d(code, 1), { action: "reask" });
    }
  });

  test("truncated and partial: keep the valid lines, run the ladder", () => {
    assert.deepEqual(d("api.truncated", 0), { action: "reask" });
    assert.deepEqual(d("api.partial", 3), { action: "reask" });
  });

  test("an unreachable endpoint pauses the queue until GET /models answers again", () => {
    assert.deepEqual(d("api.unreachable", 0), { action: "pause", resume: "health" });
    assert.deepEqual(d("api.unreachable", 3), { action: "pause", resume: "health" }, "on any attempt");
  });

  test("an LNA block and a bad configuration (URL, model, quota) pause until the user acts", () => {
    for (const code of ["api.lna_blocked", "api.config"] as const) {
      assert.deepEqual(d(code, 0), { action: "pause", resume: "user" }, code);
      assert.deepEqual(d(code, 2), { action: "pause", resume: "user" }, code);
    }
  });

  test("401/403 (api.unauthorized): pause, one probe after UNAUTHORIZED_PROBE_MS, then wait for the user", () => {
    assert.equal(UNAUTHORIZED_PROBE_MS, 60_000);
    assert.deepEqual(d("api.unauthorized", 0), {
      action: "pause",
      resume: "timer",
      delayMs: 60_000,
      at: NOW + 60_000,
    });
    assert.deepEqual(d("api.unauthorized", 1), { action: "pause", resume: "user" });
  });

  test("refusal, bad request and errors unrelated to the API call are never retried", () => {
    for (const code of [
      "llm.refused",
      "api.bad_request",
      "llm.missing",
      "image.http",
      "engine.internal",
    ] as const) {
      assert.deepEqual(d(code, 0), { action: "fail" }, code);
    }
  });

  test("protocol errors get one retry", () => {
    assert.equal(d("api.protocol", 0).action, "retry");
    assert.equal(d("api.protocol", 1).action, "fail");
  });

  test("maxHttpRetries 0 disables HTTP retries", () => {
    for (const code of ["api.rate_limit", "api.upstream", "api.timeout", "api.protocol"] as const) {
      assert.equal(decide({ code }, 0, NOW, mid, { maxHttpRetries: 0 }).action, "fail", code);
    }
  });
});

describe("allowAutoPass: ≤ 2 automatic passes per unit in 10 min", () => {
  test("counts only passes inside the window", () => {
    assert.equal(allowAutoPass([], NOW), true);
    assert.equal(allowAutoPass([NOW - 1_000], NOW), true);
    assert.equal(allowAutoPass([NOW - 1_000, NOW - 2_000], NOW), false);
    assert.equal(allowAutoPass([NOW - 700_000, NOW - 2_000], NOW), true);
  });
});

// ---- Ladder ----

function item(id: number, translation: string, original = "원본"): ItemRec {
  return { kind: "item", id, type: "dialogue", speaker: "", original, translation, raw: "" };
}

/** Outcome of a request asking for n labels where `answered` labels came back translated. */
function outcomeOf(
  n: number,
  answered: readonly number[],
  extra: { refusedItems?: readonly number[]; junk?: readonly string[]; long?: readonly number[] } = {},
): PackOutcome {
  const acc = createAccountant(n);
  for (const id of answered) {
    const long = extra.long?.includes(id) ?? false;
    acc.accept(item(id, long ? "Một câu rất dài ".repeat(8) : `Bản dịch ${id}`));
  }
  for (const id of extra.refusedItems ?? []) {
    acc.accept(item(id, "Xin lỗi, tôi không thể dịch nội dung này."));
  }
  return acc.finish(true, extra.junk ?? []);
}

function state(ids: readonly number[], overrides: Partial<LadderState> = {}): LadderState {
  return { ids, depth: 0, reaskUsed: false, fullRetryUsed: false, extraRequests: 0, ...overrides };
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("planLadder", () => {
  test("nothing missing → done", () => {
    assert.deepEqual(planLadder(outcomeOf(4, [1, 2, 3, 4]), state(range(1, 4))), { kind: "done" });
  });

  test("≤ max(2, ceil(0.3·N)) missing and no re-ask yet → crops-only re-ask of those ids", () => {
    // N = 10 → limit 3
    const outcome = outcomeOf(10, [1, 2, 4, 5, 7, 8, 9]);
    assert.deepEqual(planLadder(outcome, state(range(1, 10))), {
      kind: "reask",
      ids: [3, 6, 10],
      refused: [],
    });
    // N = 3 → limit 2
    assert.deepEqual(planLadder(outcomeOf(3, [2]), state([1, 2, 3])), {
      kind: "reask",
      ids: [1, 3],
      refused: [],
    });
  });

  test("more missing than the limit → split the missing ids in halves by position", () => {
    const outcome = outcomeOf(10, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(planLadder(outcome, state(range(1, 10))), {
      kind: "split",
      groups: [
        [7, 8],
        [9, 10],
      ],
      refused: [],
    });
  });

  test("re-ask already used → split; depth 2 reached → give up as untranslated", () => {
    const outcome = outcomeOf(4, [1, 3]);
    assert.deepEqual(planLadder(outcome, state(range(1, 4), { reaskUsed: true, extraRequests: 1 })), {
      kind: "split",
      groups: [[2], [4]],
      refused: [],
    });
    assert.deepEqual(planLadder(outcome, state(range(1, 4), { reaskUsed: true, depth: 2 })), {
      kind: "give-up",
      untranslated: [2, 4],
      refused: [],
    });
  });

  test("a single missing id splits into one group", () => {
    const outcome = outcomeOf(2, [1]);
    assert.deepEqual(planLadder(outcome, state([1, 2], { reaskUsed: true, extraRequests: 1 })), {
      kind: "split",
      groups: [[2]],
      refused: [],
    });
  });

  test("a single-unit request is never sent again unchanged", () => {
    // Pack of one unit with an empty translation: crops-only re-ask, then give up (a "split" of [7] would re-send
    // exactly the original full composite, twice).
    const acc = createAccountant(1);
    acc.accept(item(1, ""));
    const outcome = acc.finish(true);
    assert.deepEqual(planLadder(outcome, state([7])), { kind: "reask", ids: [7], refused: [] });
    assert.deepEqual(planLadder(outcome, state([7], { reaskUsed: true, extraRequests: 1 })), {
      kind: "give-up",
      untranslated: [7],
      refused: [],
    });
    // The one-unit split of a re-ask (above: groups [[6]]) answered nothing either: stop there.
    assert.deepEqual(planLadder(outcome, state([6], { reaskUsed: true, depth: 1, extraRequests: 2 })), {
      kind: "give-up",
      untranslated: [6],
      refused: [],
    });
  });

  test("labels of a sub-request map back to pack ids", () => {
    // A crops-only re-ask of pack ids 3, 6 and 10 (labels 1..3); label 2 is still missing.
    const outcome = outcomeOf(3, [1, 3]);
    assert.deepEqual(planLadder(outcome, state([3, 6, 10], { reaskUsed: true, extraRequests: 1 })), {
      kind: "split",
      groups: [[6]],
      refused: [],
    });
  });

  test("≤ 4 extra requests per pack", () => {
    const outcome = outcomeOf(10, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(planLadder(outcome, state(range(1, 10), { extraRequests: 3 })), {
      kind: "give-up",
      untranslated: [7, 8, 9, 10],
      refused: [],
    });
    assert.deepEqual(planLadder(outcomeOf(3, [1, 2]), state([1, 2, 3], { extraRequests: 4 })), {
      kind: "give-up",
      untranslated: [3],
      refused: [],
    });
    assert.equal(planLadder(outcome, state(range(1, 10), { extraRequests: 2 })).kind, "split");
    assert.equal(
      planLadder(outcome, state(range(1, 10), { extraRequests: 0, maxExtraRequests: 1 })).kind,
      "give-up",
    );
  });

  test("garbage output (no item) → one full retry, then the normal ladder", () => {
    const garbage = outcomeOf(4, [], { junk: ["Here is my answer in prose."] });
    assert.deepEqual(planLadder(garbage, state(range(1, 4))), { kind: "retry", ids: [1, 2, 3, 4] });
    assert.deepEqual(planLadder(garbage, state(range(1, 4), { fullRetryUsed: true, extraRequests: 1 })), {
      kind: "split",
      groups: [
        [1, 2],
        [3, 4],
      ],
      refused: [],
    });
  });

  test("pack-level refusal → give up as refused, no retry by default", () => {
    const refused = outcomeOf(6, [], { junk: ["I'm sorry, but I can't help with this image."] });
    assert.equal(refused.refusal, true);
    assert.deepEqual(planLadder(refused, state(range(1, 6))), {
      kind: "give-up",
      untranslated: [],
      refused: [1, 2, 3, 4, 5, 6],
    });
  });

  test("splitOnRefusal: split once at depth 0 when the pack has ≥ 4 units", () => {
    const refused = outcomeOf(6, [], { junk: ["I'm sorry, but I can't help with this image."] });
    assert.deepEqual(planLadder(refused, state(range(1, 6), { splitOnRefusal: true })), {
      kind: "split",
      groups: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      refused: [],
    });
    assert.equal(planLadder(refused, state(range(1, 6), { splitOnRefusal: true, depth: 1 })).kind, "give-up");
    const small = outcomeOf(3, [], { junk: ["I'm sorry, I cannot assist."] });
    assert.equal(planLadder(small, state([1, 2, 3], { splitOnRefusal: true })).kind, "give-up");
  });

  test("item-level refusals are final (refused) while the other ids continue", () => {
    const outcome = outcomeOf(10, [1, 2, 3, 4, 5, 6, 7, 8], { refusedItems: [9] });
    assert.deepEqual(planLadder(outcome, state(range(1, 10))), { kind: "reask", ids: [10], refused: [9] });
    const onlyRefused = outcomeOf(3, [1, 2], { refusedItems: [3] });
    assert.deepEqual(planLadder(onlyRefused, state([1, 2, 3])), {
      kind: "give-up",
      untranslated: [],
      refused: [3],
    });
    assert.deepEqual(planLadder(onlyRefused, state([1, 2, 3], { splitOnRefusal: true })), {
      kind: "reask",
      ids: [3],
      refused: [],
    });
  });

  test("a suspect-merge id joins the re-ask with the missing next id", () => {
    const outcome = outcomeOf(6, [1, 2, 4, 5, 6], { long: [2] });
    assert.deepEqual(outcome.suspects, [2]);
    assert.deepEqual(planLadder(outcome, state(range(1, 6))), { kind: "reask", ids: [2, 3], refused: [] });
  });

  test("a content-filter upstream error refuses the unresolved ids only", () => {
    const acc = createAccountant(3);
    acc.accept(item(1, "Một"));
    const outcome = acc.finish(false, [], { upstreamError: "ResponsibleAIPolicyViolation" });
    assert.deepEqual(planLadder(outcome, state([1, 2, 3])), {
      kind: "give-up",
      untranslated: [],
      refused: [2, 3],
    });
  });

  test("a content-filter error after every id was answered changes nothing", () => {
    const acc = createAccountant(2);
    acc.accept(item(1, "Một"));
    acc.accept(item(2, "Hai"));
    const outcome = acc.finish(false, [], { upstreamError: "content_filter" });
    assert.equal(outcome.refusal, true);
    assert.deepEqual(planLadder(outcome, state([1, 2])), { kind: "done" });
  });

  test("a suspect-merge id keeps its valid translation: never listed in a give-up", () => {
    // Label 1 is ok (drawn) but suspect, labels 2 and 3 are missing.
    const outcome = outcomeOf(3, [1], { long: [1] });
    assert.deepEqual(outcome.suspects, [1]);
    assert.deepEqual(planLadder(outcome, state([4, 5, 6], { reaskUsed: true, depth: 2 })), {
      kind: "give-up",
      untranslated: [5, 6],
      refused: [],
    });
    const filtered = createAccountant(3);
    filtered.accept(item(1, "Một câu rất dài ".repeat(8)));
    const refusal = filtered.finish(false, [], { upstreamError: "content_filter" });
    assert.deepEqual(refusal.suspects, [1]);
    assert.deepEqual(planLadder(refusal, state([1, 2, 3])), {
      kind: "give-up",
      untranslated: [],
      refused: [2, 3],
    });
    // Only the suspect is left (its next id was refused) and the budget is spent: nothing to downgrade.
    const lone = outcomeOf(2, [1], { long: [1], refusedItems: [2] });
    assert.deepEqual(lone.suspects, [1]);
    assert.deepEqual(planLadder(lone, state([1, 2], { extraRequests: 4 })), {
      kind: "give-up",
      untranslated: [],
      refused: [2],
    });
    const nothingLeft = outcomeOf(2, [1], { long: [1] });
    assert.deepEqual(
      planLadder(nothingLeft, state([1, 2], { reaskUsed: true, extraRequests: 4 })),
      { kind: "give-up", untranslated: [2], refused: [] },
      "the missing next id is still reported",
    );
  });
});
