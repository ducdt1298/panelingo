// Pack translator. For each request of a pack: composite → prompt → streamChat → line parser → id accounting,
// delivering every accepted unit at once; then core/retry-policy decides what follows. The requests of one pack run
// one after another.
//
// Ladder (planLadder): re-ask the missing ids crops-only (renumbered 1..k, neighbouring accepted lines as context),
// else split them by position (≤ 2 levels), else "untranslated"; one full retry after an empty or garbage answer;
// ≤ translate.maxLadderRequestsPerPack requests beyond the first (5 per pack and pass by default). A composite that
// cannot be laid out is split before anything is sent; its halves count against the same budget.
// HTTP level (decide): jittered backoff for 429 / 5xx / watchdog timeouts (≤ maxHttpRetriesPerRequest), a pause
// through ApiHealth.report() followed by whenSendable() (or failure when only the user can fix it), a q0.80
// rebuild when the server rejects the body as too large, and a split for context_length / too_large.
// A request that fails after some lines were accepted counts as truncated: those lines stay and the ladder handles
// the rest. Refusals are final unless translate.splitOnRefusal. A long line whose next id is missing (suspect merge,
// core/id-accounting) is held back until that id shows up or the ladder had its chance to give a cleaner line,
// because onUnit fires exactly once per unit. Nothing here ever aborts an in-flight request.
// Series memory (pack.memory, built by the pipeline): style, glossary, forms of address and summary go into every
// request; the chapter history into full requests (crops-only re-asks send their neighbouring lines instead), and only
// full requests ask for an @sum line. The report carries the answers' @term lines, last @sum and @lang (learning).

import { defaultDeps, streamChat, type StreamChatOptions, type Transport } from "./api-client.ts";
import type {
  ApiHealth,
  CompositeBuilder,
  CompositeFail,
  CompositeOk,
  CoreDeps,
  PackLearning,
  PackReport,
  PackTranslator,
  PackUnit,
  TranslatePack,
  UnitOutcomeStatus,
  UnitResult,
  UploadCounter,
} from "./contracts.ts";
import {
  createAccountant,
  isMergeSuspect,
  type PackOutcome,
  type Term,
} from "../shared/core/id-accounting.ts";
import { createLineParser, type ItemRec, type Rec } from "../shared/core/line-parser.ts";
import { profileForModel } from "../shared/core/model-profile.ts";
import {
  buildPrompt,
  type ChatMessage,
  type HistoryLine,
  type PromptTarget,
  type StyleProfile,
} from "../shared/core/prompt.ts";
import { effectiveTarget } from "../shared/languages.ts";
import type { Settings } from "../shared/settings.ts";
import { decide, MAX_SPLIT_DEPTH, planLadder, SHRINK_JPEG_QUALITY } from "../shared/core/retry-policy.ts";
import { toErrorInfo, type ErrorCode, type ErrorInfo } from "../shared/errors.ts";
import type { Lang } from "../shared/types.ts";

/** Pause → whenSendable → send again, at most this often per request (/models may say ready while requests fail). */
export const MAX_PAUSES_PER_REQUEST = 3;
/** Accepted lines on each side of a re-asked unit that go into the crops-only prompt as context. */
export const CONTEXT_NEIGHBOURS = 2;
/** Style without series memory: the SeriesProfile defaults (romanized Korean names, no Japanese honorifics). */
export const DEFAULT_STYLE: StyleProfile = Object.freeze({ koNames: "romanized", keepJaHonorifics: false });

export interface TranslatorDeps extends CoreDeps {
  health: ApiHealth;
  composite: CompositeBuilder;
  uploads: UploadCounter;
  /** HTTP transport; fetch when omitted. */
  transport?: Transport;
  /** Jitter source in [0, 1); Math.random when omitted. */
  random?: () => number;
  /** A 429 or a watchdog timeout asks the whole queue to slow down for a while. */
  onConcurrencyCap?: (cap: { value: number; forMs: number }) => void;
}

/** Codes that mean the request body never reached the server (nothing uploaded). */
const NOT_SENT: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["api.unreachable", "api.lna_blocked"]);
const FINAL_MISSING: ReadonlySet<UnitOutcomeStatus> = new Set<UnitOutcomeStatus>([
  "untranslated",
  "error",
  "refused",
]);

/** One planned request: pack ids are 1-based positions in pack.units; label #k of the request is ids[k - 1]. */
interface Job {
  ids: number[];
  mode: "full" | "crops-only";
  depth: number;
  /** Wait before the first send (backoff carried over from a stream that failed half-way). */
  delayMs: number;
  watchdogFactor: number;
}

interface FollowUp {
  delayMs: number;
  watchdogFactor: number;
}

interface Line {
  rec: ItemRec;
  lang: Lang | null;
}

interface Attempt {
  outcome: PackOutcome;
  error: ErrorInfo | null;
  /** Labels whose long line was held back during this attempt. */
  heldLabels: ReadonlySet<number>;
}

type Built = CompositeOk | CompositeFail;

function halves(ids: readonly number[]): [number[], number[]] {
  const cut = Math.ceil(ids.length / 2);
  return [ids.slice(0, cut), ids.slice(cut)];
}

function refusalInfo(message: string): ErrorInfo {
  return { code: "llm.refused", message, retryable: false };
}

/**
 * The language to translate into: settings.translate.targetLang, or ("auto") the UI language, or the browser's
 * preferred languages as the engine document sees them.
 */
export function promptTarget(
  settings: Settings,
  browser: readonly string[] = navigatorLanguages(),
): PromptTarget {
  const language = effectiveTarget(settings.translate.targetLang, settings.ui.locale, browser);
  return { code: language.code, name: language.englishName };
}

function navigatorLanguages(): string[] {
  return typeof navigator === "undefined" ? [] : [...navigator.languages];
}

export function createTranslator(deps: TranslatorDeps): PackTranslator {
  let transport = deps.transport;
  const baseTransport: Transport = (url, init) => {
    transport ??= defaultDeps().transport;
    return transport(url, init);
  };
  return {
    translate: (pack, onUnit) => translatePack(deps, baseTransport, pack, onUnit),
  };
}

async function translatePack(
  deps: TranslatorDeps,
  baseTransport: Transport,
  pack: TranslatePack,
  onUnit: (result: UnitResult) => void,
): Promise<PackReport> {
  const { clock, health } = deps;
  const log = deps.log.child({ frameKey: pack.frameKey, batchId: pack.packId });
  const started = clock.now();
  const settings = deps.settings.current();
  const tr = settings.translate;
  const api = settings.api;
  const random = deps.random ?? Math.random;
  const profile = profileForModel(settings.api.model);
  const fallbackLang: Lang | null = pack.lang === "auto" ? null : pack.lang;

  const report: PackReport = {
    packId: pack.packId,
    requests: 0,
    missing: [],
    error: null,
    // The configured id, for the report and every unit alike: units stream out before the response names its model.
    model: api.model,
    lang: null,
    firstLineMs: null,
    totalMs: 0,
    uploadedBytes: 0,
  };
  let reportedLang: Lang | null = null;
  /** @term lines of every answer (first rendering per original wins) and the last @sum of a full request. */
  const terms = new Map<string, Term>();
  let summary: string | null = null;
  let answered = false;
  let ladderUsed = 0;
  let reaskUsed = false;
  let fullRetryUsed = false;
  let firstJob: Job | null = null;

  const final = new Map<number, UnitResult>();
  /** Suspect-merge lines (valid translations) waiting for a cleaner line from the ladder. */
  const held = new Map<number, Line>();
  /** Valid lines by pack id: context for crops-only re-asks. */
  const accepted = new Map<number, ItemRec>();
  /** Latest line seen per pack id, valid or not: type and original for units that end without a translation. */
  const lastRec = new Map<number, ItemRec>();
  const queue: Job[] = [];
  const ladderLeft = (): number => tr.maxLadderRequestsPerPack - ladderUsed;
  /** Callbacks into the rest of the engine must never be mistaken for a failed request. */
  const quietly = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      log.error(`${what} threw`, { message: toErrorInfo(error).message });
    }
  };

  const emit = (p: number, status: UnitOutcomeStatus, rec: ItemRec | undefined, lang: Lang | null): void => {
    const unit = pack.units[p - 1];
    if (unit === undefined || final.has(p)) return;
    held.delete(p);
    const result: UnitResult = {
      contentKey: unit.contentKey,
      unitKey: unit.unitKey,
      status,
      type: rec?.type ?? "dialogue",
      speaker: rec?.speaker ?? "",
      original: rec?.original ?? "",
      translation: status === "ok" ? (rec?.translation ?? "") : "",
      lang,
      model: report.model,
    };
    final.set(p, result);
    quietly("onUnit", () => onUnit(result));
  };

  /** Final status for a unit that has no new valid line; a held suspect keeps its valid translation. */
  const giveUp = (p: number, status: "untranslated" | "error" | "refused"): void => {
    const line = held.get(p);
    if (line !== undefined) {
      emit(p, "ok", line.rec, line.lang);
      return;
    }
    if (status === "refused" && !final.has(p)) {
      report.error ??= refusalInfo("the model refused to translate some units");
    }
    emit(p, status, lastRec.get(p), reportedLang ?? fallbackLang);
  };

  const failJob = (job: Job, info: ErrorInfo): void => {
    report.error ??= info;
    for (const p of job.ids) giveUp(p, info.code === "llm.refused" ? "refused" : "error");
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      clock.setTimer(resolve, ms);
    });

  const unitsOf = (job: Job): PackUnit[] =>
    job.ids.flatMap((p) => {
      const unit = pack.units[p - 1];
      return unit === undefined ? [] : [unit];
    });

  const compose = (job: Job, quality: number): Promise<Built> =>
    deps.composite.build({
      units: unitsOf(job),
      mode: job.mode,
      profile,
      dir: pack.dir,
      jpegQuality: quality,
      images: pack.images,
    });

  /** Up to CONTEXT_NEIGHBOURS accepted lines on each side of every re-asked unit, in pack order. */
  const neighbourLines = (ids: readonly number[]): HistoryLine[] => {
    const asked = new Set(ids);
    const picked = new Set<number>();
    for (const p of ids) {
      for (const step of [-1, 1]) {
        let found = 0;
        for (let q = p + step; q >= 1 && q <= pack.units.length && found < CONTEXT_NEIGHBOURS; q += step) {
          if (asked.has(q) || !accepted.has(q)) continue;
          picked.add(q);
          found += 1;
        }
      }
    }
    return [...picked]
      .sort((a, b) => a - b)
      .flatMap((q) => {
        const rec = accepted.get(q);
        return rec === undefined
          ? []
          : [{ pos: q, speaker: rec.speaker, original: rec.original, translation: rec.translation }];
      });
  };

  const target = promptTarget(settings);
  const memory = pack.memory;
  const memoryLimits = {
    glossaryEntries: settings.memory.glossaryInPrompt,
    summaryWords: settings.memory.summaryMaxWords,
  };
  // The chapter history follows settings.memory; a re-ask's neighbouring lines keep the default history limits.
  const historyLimits = {
    historyLines: settings.memory.historyMaxLines,
    historyTokens: settings.memory.historyMaxTokens,
  };
  const promptFor = (job: Job, dataUrl: string): ChatMessage[] =>
    buildPrompt(
      {
        target,
        lang: pack.lang,
        n: job.ids.length,
        mode: job.mode,
        style: memory?.style ?? DEFAULT_STYLE,
        glossary: memory?.glossary ?? [],
        pronouns: memory?.pronouns ?? [],
        summary: memory?.summary ?? null,
        history: job.mode === "crops-only" ? neighbourLines(job.ids) : (memory?.history ?? []),
        askSummary: job.mode === "full" && (memory?.askSummary ?? false),
      },
      dataUrl,
      {
        maxTextChars: tr.promptCharCap,
        ...memoryLimits,
        ...(job.mode === "full" ? historyLimits : {}),
      },
    ).messages;

  /** Keeps what an answer taught (terms, summary) for the report. */
  const collect = (job: Job, outcome: PackOutcome): void => {
    if (outcome.received > 0 || outcome.terms.length > 0) answered = true;
    for (const term of outcome.terms) {
      const key = term.original.normalize("NFC").trim();
      if (!terms.has(key)) terms.set(key, { ...term });
    }
    if (job.mode === "full" && outcome.summary !== null) summary = outcome.summary;
  };

  const compositeFailed = (job: Job, reason: CompositeFail["reason"]): void => {
    if (job.ids.length >= 2 && job.depth < MAX_SPLIT_DEPTH && ladderLeft() >= 1) {
      // Nothing was sent: the first half takes this request's place, only the second one is extra.
      ladderUsed += 1;
      const [a, b] = halves(job.ids);
      queue.unshift({ ...job, ids: a, depth: job.depth + 1 }, { ...job, ids: b, depth: job.depth + 1 });
      log.info("composite does not fit, splitting", { units: job.ids.length, reason, depth: job.depth });
      return;
    }
    log.warn("composite does not fit, giving up", { units: job.ids.length, reason, depth: job.depth });
    for (const p of job.ids) giveUp(p, "untranslated");
  };

  /** One send of a built request: streams lines into the accountant and delivers units as they validate. */
  const send = async (
    job: Job,
    built: CompositeOk,
    messages: readonly ChatMessage[],
    watchdogFactor: number,
  ): Promise<Attempt> => {
    const k = job.ids.length;
    const accountant = createAccountant(k, pack.lang, target.code);
    const resolved = new Set<number>();
    const heldLabels = new Set<number>();
    let attemptLang: Lang | null = null;
    firstJob ??= job;
    const timesFirstLine = firstJob === job;
    const sentAt = clock.now();

    const onRec = (rec: Rec): void => {
      if (rec.kind === "lang") {
        attemptLang ??= rec.lang;
        reportedLang ??= rec.lang;
      }
      const outcome = accountant.accept(rec);
      if (outcome === null || rec.kind !== "item") return;
      const label = rec.id;
      const p = job.ids[label - 1];
      if (p === undefined || final.has(p)) return;
      lastRec.set(p, rec);
      if (outcome.status === "missing") return;
      const lang = attemptLang ?? fallbackLang;
      resolved.add(label);
      if (timesFirstLine && report.firstLineMs === null) report.firstLineMs = clock.now() - sentAt;
      // The previous line was only held until this neighbour arrived.
      const prev = job.ids[label - 2];
      if (prev !== undefined && heldLabels.delete(label - 1)) {
        const line = held.get(prev);
        if (line !== undefined) emit(prev, "ok", line.rec, line.lang);
      }
      if (outcome.status === "ok") {
        accepted.set(p, rec);
        // id-accounting's suspect-merge test, applied while the stream is still running.
        if (label < k && !resolved.has(label + 1) && isMergeSuspect(rec)) {
          heldLabels.add(label);
          held.set(p, { rec, lang });
          return;
        }
        emit(p, "ok", rec, lang);
        return;
      }
      emit(p, outcome.status === "ignore" ? "ignored" : "keep-original", rec, lang);
    };

    const parser = createLineParser(onRec);
    let responded = false;
    const transport: Transport = async (url, init) => {
      const response = await baseTransport(url, init);
      responded = true;
      return response;
    };
    // The endpoint as configured now, not when the pack started: the probe after a pause (a 401, an unreachable
    // server) must use a key or base URL the user fixed in the meantime.
    const endpoint = deps.settings.current().api;
    const options: StreamChatOptions = {
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: api.model,
      temperature: api.temperature,
      messages,
      onLine: (line) => parser.push(line),
      firstByteTimeoutMs: api.firstByteTimeoutMs,
      idleTimeoutMs: api.idleTimeoutMs,
      totalTimeoutMs: api.totalTimeoutMs,
      watchdogFactor,
    };
    if (__TEST__ && built.testUnits !== undefined) options.testUnits = built.testUnits;

    const recordUpload = (): void => {
      report.uploadedBytes += built.jpeg.byteLength;
      quietly("uploads.record", () => deps.uploads.record(built.jpeg.byteLength));
    };
    report.requests += 1;
    try {
      const result = await streamChat(options, {
        transport,
        now: () => clock.now(),
        setTimer: (fn, ms) => clock.setTimer(fn, ms),
      });
      parser.end();
      recordUpload();
      const outcome = accountant.finish(result.sawDone);
      log.debug("api request done", {
        respondedModel: result.model ?? null,
        units: k,
        mode: job.mode,
        depth: job.depth,
        received: outcome.received,
        missing: outcome.missing.length,
        truncated: result.truncated,
        ms: clock.now() - sentAt,
      });
      return { outcome, error: null, heldLabels };
    } catch (error) {
      parser.end();
      const info = toErrorInfo(error);
      if (responded || !NOT_SENT.has(info.code)) recordUpload();
      const outcome = accountant.finish(false, [], { upstreamError: info.message });
      return {
        outcome: info.code === "llm.refused" ? { ...outcome, refusal: true } : outcome,
        error: info,
        heldLabels,
      };
    }
  };

  /** After a request: release held lines that turned out fine, then plan the ladder. */
  const settle = (job: Job, attempt: Attempt, follow: FollowUp): void => {
    const { outcome } = attempt;
    for (const label of attempt.heldLabels) {
      const p = job.ids[label - 1];
      const line = p === undefined ? undefined : held.get(p);
      if (p !== undefined && line !== undefined && !outcome.suspects.includes(label)) {
        emit(p, "ok", line.rec, line.lang);
      }
    }
    if (outcome.refusal && report.error === null) {
      report.error = refusalInfo("the model refused to translate");
    }
    const step = planLadder(outcome, {
      ids: job.ids,
      depth: job.depth,
      reaskUsed,
      fullRetryUsed,
      extraRequests: ladderUsed,
      splitOnRefusal: tr.splitOnRefusal,
      maxExtraRequests: tr.maxLadderRequestsPerPack,
    });
    if (step.kind !== "done") {
      log.debug("ladder step", { step: step.kind, missing: outcome.missing.length, depth: job.depth });
    }
    switch (step.kind) {
      case "done":
        return;
      case "retry":
        fullRetryUsed = true;
        ladderUsed += 1;
        queue.push({ ...job, ids: step.ids, ...follow });
        return;
      case "reask":
        for (const p of step.refused) giveUp(p, "refused");
        reaskUsed = true;
        ladderUsed += 1;
        queue.push({ ids: step.ids, mode: "crops-only", depth: job.depth, ...follow });
        return;
      case "split":
        for (const p of step.refused) giveUp(p, "refused");
        ladderUsed += step.groups.length;
        for (const ids of step.groups) queue.push({ ids, mode: "full", depth: job.depth + 1, ...follow });
        return;
      case "give-up":
        for (const p of step.untranslated) giveUp(p, "untranslated");
        for (const p of step.refused) giveUp(p, "refused");
        return;
    }
  };

  const runJob = async (job: Job): Promise<void> => {
    let built: Built;
    let messages: ChatMessage[];
    try {
      built = await compose(job, tr.jpegQuality);
      if (!built.ok) {
        compositeFailed(job, built.reason);
        return;
      }
      messages = promptFor(job, built.dataUrl);
    } catch (error) {
      failJob(job, toErrorInfo(error));
      return;
    }
    let httpRetries = 0;
    let pauses = 0;
    const sameCode = new Map<ErrorCode, number>();
    let delayMs = job.delayMs;
    let watchdogFactor = job.watchdogFactor;

    for (;;) {
      if (delayMs > 0) await sleep(delayMs);
      delayMs = 0;
      await health.whenSendable();
      const attempt = await send(job, built, messages, watchdogFactor);
      collect(job, attempt.outcome);
      const info = attempt.error;
      if (info === null) {
        settle(job, attempt, { delayMs: 0, watchdogFactor: 1 });
        return;
      }
      const same = sameCode.get(info.code) ?? 0;
      sameCode.set(info.code, same + 1);
      const canSplit = job.ids.length >= 2 && job.depth < MAX_SPLIT_DEPTH && ladderLeft() >= 2;
      const decision = decide(info, httpRetries, clock.now(), random, {
        maxHttpRetries: tr.maxHttpRetriesPerRequest,
        canSplit,
        sameCodeAttempts: same,
      });
      const cap = decision.concurrency;
      if (cap !== undefined) quietly("onConcurrencyCap", () => deps.onConcurrencyCap?.({ ...cap }));
      log.warn(
        "api request failed",
        {
          status: info.status ?? null,
          action: decision.action,
          received: attempt.outcome.received,
          units: job.ids.length,
        },
        info.code,
      );

      if (attempt.outcome.received > 0 || info.code === "llm.refused") {
        // Lines already arrived (or the content was refused): keep what is valid and let the ladder do the rest.
        if (decision.action === "pause") health.report(info);
        if (info.code === "llm.refused") report.error ??= info;
        const follow: FollowUp =
          decision.action === "retry"
            ? {
                delayMs: decision.delayMs ?? 0,
                watchdogFactor: watchdogFactor * (decision.watchdogFactor ?? 1),
              }
            : { delayMs: 0, watchdogFactor };
        settle(job, attempt, follow);
        return;
      }

      switch (decision.action) {
        case "retry":
          if (decision.ladder === true) {
            // The pack's single full retry after an empty answer, counted as a ladder request.
            if (fullRetryUsed || ladderLeft() < 1) {
              settle(job, attempt, { delayMs: 0, watchdogFactor });
              return;
            }
            fullRetryUsed = true;
            ladderUsed += 1;
          }
          httpRetries += 1;
          delayMs = decision.delayMs ?? 0;
          watchdogFactor *= decision.watchdogFactor ?? 1;
          continue;
        case "shrink":
          httpRetries += 1;
          try {
            built = await compose(job, decision.jpegQuality ?? SHRINK_JPEG_QUALITY);
            if (!built.ok) {
              compositeFailed(job, built.reason);
              return;
            }
            messages = promptFor(job, built.dataUrl);
          } catch (error) {
            failJob(job, toErrorInfo(error));
            return;
          }
          continue;
        case "pause":
          health.report(info);
          if (decision.resume === "user" || pauses >= MAX_PAUSES_PER_REQUEST) {
            failJob(job, info);
            return;
          }
          pauses += 1;
          if (decision.resume === "timer") delayMs = decision.delayMs ?? 0;
          continue;
        case "split": {
          ladderUsed += 2;
          const [a, b] = halves(job.ids);
          const next = {
            mode: job.mode,
            depth: job.depth + 1,
            delayMs: 0,
            watchdogFactor: job.watchdogFactor,
          };
          queue.push({ ...next, ids: a }, { ...next, ids: b });
          return;
        }
        case "reask":
          settle(job, attempt, { delayMs: 0, watchdogFactor });
          return;
        case "fail":
          failJob(job, info);
          return;
      }
    }
  };

  queue.push({
    ids: pack.units.map((_, index) => index + 1),
    mode: "full",
    depth: 0,
    delayMs: 0,
    watchdogFactor: 1,
  });
  try {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const open = job.ids.filter((p) => !final.has(p));
      if (open.length > 0) await runJob({ ...job, ids: open });
    }
  } catch (error) {
    const info = toErrorInfo(error);
    log.error("translator failed", { message: info.message }, info.code);
    failJob(
      { ids: pack.units.map((_, index) => index + 1), mode: "full", depth: 0, delayMs: 0, watchdogFactor: 1 },
      info,
    );
  }

  // Every unit gets exactly one onUnit; held suspects keep their valid line.
  pack.units.forEach((_, index) => giveUp(index + 1, "untranslated"));
  report.missing = pack.units.flatMap((unit, index) => {
    const status = final.get(index + 1)?.status;
    return status !== undefined && FINAL_MISSING.has(status) ? [unit.unitKey] : [];
  });
  report.lang = reportedLang ?? fallbackLang;
  if (answered || reportedLang !== null) {
    const learning: PackLearning = { terms: [...terms.values()], summary, lang: reportedLang };
    report.learning = learning;
  }
  report.totalMs = clock.now() - started;
  log.info("pack translated", {
    units: pack.units.length,
    requests: report.requests,
    missing: report.missing.length,
    error: report.error?.code ?? null,
    ms: report.totalMs,
  });
  return report;
}
