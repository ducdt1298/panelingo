// Readiness of the OpenAI-compatible endpoint from GET {baseUrl}/models. shared/core/health.ts maps an answer to a
// readiness; this module owns the polling cadence, the queue gate (whenSendable) and the pauses caused by classified
// request failures (report).
//
// Cadence: ready (work pending) 30 s · unauthorized / misconfigured 15 s · network errors 5 s for 2 min, then 30 s ·
// unknown 15 s. With no work and nobody waiting for 2 min, polling stops; refresh(), setBusy(true) and
// whenSendable() restart it, and so does any change of the endpoint settings. After a reported failure the next check
// waits one interval, so a /models answer that still looks fine cannot turn a failing request into a hot retry loop.

import { classifyFetchError } from "../shared/core/api-errors.ts";
import {
  configProblem,
  INITIAL_HEALTH,
  isSendable,
  modelsUrl,
  readinessFrom,
  readinessFromFetchError,
  type HealthReading,
} from "../shared/core/health.ts";
import type { ErrorCode, ErrorInfo } from "../shared/errors.ts";
import type { ApiReadiness } from "../shared/types.ts";
import type { ApiHealth, CoreDeps } from "./contracts.ts";

export const HEALTH_CADENCE = Object.freeze({
  readyMs: 30_000,
  pausedMs: 15_000,
  networkFastMs: 5_000,
  networkFastForMs: 120_000,
  networkSlowMs: 30_000,
  idleStopMs: 120_000,
});

/** A 401 from chat while /models still answers 200 (servers that only guard chat): hold, then probe again. */
export const UNAUTHORIZED_HOLD_MS = 60_000;
/** A model the server rejects (unknown model, no image input): /models cannot show it, so hold this long. */
export const CONFIG_HOLD_MS = 5 * 60_000;

/** What report() does per code: the readiness shown while paused, and how long codes /models cannot clear hold. */
const REPORT_PAUSES: Partial<Record<ErrorCode, { readiness: ApiReadiness; holdMs: number | null }>> = {
  "api.unreachable": { readiness: "unreachable", holdMs: null },
  "api.lna_blocked": { readiness: "lna_blocked", holdMs: null },
  "api.unauthorized": { readiness: "unauthorized", holdMs: UNAUTHORIZED_HOLD_MS },
  "api.config": { readiness: "misconfigured", holdMs: CONFIG_HOLD_MS },
};

export interface HealthResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type HealthFetch = (
  url: string,
  init: {
    method: "GET";
    cache: "no-store";
    credentials: "omit";
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<HealthResponse>;

export interface HealthOptions {
  /** Injected in tests (default: global fetch). */
  fetch?: HealthFetch;
}

export interface HealthMonitor extends ApiHealth {
  /** Epoch ms of the last completed /models check (0 = never), for EngineStatus.api.checkedAt. */
  readonly checkedAt: () => number;
}

interface Pause {
  code: ErrorCode;
  readiness: ApiReadiness;
  cause: string;
  at: number;
  /** Order of the report among check starts: only a check started later may lift the pause. */
  seq: number;
  /** Timed pause end, or null when the next /models answer decides. */
  until: number | null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function keyOf(reading: HealthReading): string {
  return [reading.readiness, reading.model, reading.cause].join("|");
}

export function createHealth(deps: CoreDeps & HealthOptions): HealthMonitor {
  const { clock, log, settings } = deps;
  const fetchHealth: HealthFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  let fromHealth: HealthReading = { ...INITIAL_HEALTH };
  let pause: Pause | null = null;
  let busy = false;
  let idleSince = clock.now();
  let lastCheckAt = 0;
  let netErrorSince: number | null = null;
  let inFlight: Promise<HealthReading> | null = null;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  let sequence = 0;
  const endpointKey = (): string => {
    const api = settings.current().api;
    return [api.baseUrl, api.apiKey, api.model].join("\u0000");
  };
  let endpoint = endpointKey();
  const waiters: Array<() => void> = [];
  const listeners = new Set<(reading: HealthReading) => void>();

  const current = (): HealthReading =>
    pause === null ? fromHealth : { ...fromHealth, readiness: pause.readiness, cause: pause.cause };
  let lastKey = keyOf(current());

  const active = (): boolean => busy || waiters.length > 0;

  const notify = (): void => {
    const reading = current();
    const key = keyOf(reading);
    if (key !== lastKey) {
      lastKey = key;
      log.info("api readiness", { readiness: reading.readiness, model: reading.model, cause: reading.cause });
      for (const listener of [...listeners]) {
        try {
          listener(reading);
        } catch (error) {
          log.warn("health listener threw", { error: String(error) });
        }
      }
    }
    if (waiters.length > 0 && isSendable(reading.readiness)) {
      for (const resolve of waiters.splice(0)) resolve();
      if (!busy) idleSince = clock.now();
    }
  };

  const cadence = (): number => {
    const readiness = current().readiness;
    switch (readiness) {
      case "ready":
        return HEALTH_CADENCE.readyMs;
      case "unreachable":
      case "lna_blocked":
        return netErrorSince !== null && clock.now() - netErrorSince < HEALTH_CADENCE.networkFastForMs
          ? HEALTH_CADENCE.networkFastMs
          : HEALTH_CADENCE.networkSlowMs;
      case "unknown":
      case "unauthorized":
      case "misconfigured":
        return HEALTH_CADENCE.pausedMs;
    }
  };

  const pollingStopped = (now: number): boolean =>
    stopped || (!active() && now - idleSince >= HEALTH_CADENCE.idleStopMs);

  const nextCheckAt = (now: number): number => {
    let at = lastCheckAt === 0 ? now : lastCheckAt + cadence();
    if (pause !== null) {
      at = Math.max(at, pause.at + cadence());
      if (pause.until !== null) at = Math.min(at, pause.until);
    }
    return at;
  };

  const schedule = (): void => {
    if (cancelTimer !== null) {
      cancelTimer();
      cancelTimer = null;
    }
    const now = clock.now();
    if (pollingStopped(now)) return;
    cancelTimer = clock.setTimer(
      () => {
        cancelTimer = null;
        if (!pollingStopped(clock.now())) void refresh();
      },
      Math.max(0, nextCheckAt(now) - now),
    );
  };

  /** GET /models within healthTimeoutMs (the whole exchange, body included). */
  const fetchText = async (
    url: string,
    apiKey: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; status: number; text: string }> => {
    const controller = new AbortController();
    let cancel: () => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      cancel = clock.setTimer(() => {
        const error = new DOMException(`GET /models timed out after ${timeoutMs} ms`, "TimeoutError");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const work = (async () => {
      const response = await fetchHealth(url, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        headers: apiKey.trim() === "" ? {} : { Authorization: `Bearer ${apiKey.trim()}` },
        signal: controller.signal,
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    })();
    work.catch(() => undefined); // settled after a timeout: nobody is listening any more
    try {
      return await Promise.race([work, timeout]);
    } finally {
      cancel();
    }
  };

  const apply = (reading: HealthReading, startedSeq: number): void => {
    const now = clock.now();
    lastCheckAt = now;
    fromHealth = reading;
    if (pause !== null) {
      // A timed pause runs out; any other pause yields to a /models answer requested after the failure.
      if (pause.until !== null ? now >= pause.until : startedSeq > pause.seq) pause = null;
    }
    const effective = current().readiness;
    if (effective === "unreachable" || effective === "lna_blocked") netErrorSince ??= now;
    else netErrorSince = null;
    notify();
    schedule();
  };

  const check = async (): Promise<HealthReading> => {
    sequence += 1;
    const startedSeq = sequence;
    const api = settings.current().api;
    endpoint = endpointKey();
    let reading: HealthReading;
    const problem = configProblem(api.baseUrl, api.model);
    if (problem !== null) {
      reading = {
        ...INITIAL_HEALTH,
        readiness: "misconfigured",
        model: api.model.trim() || null,
        cause: problem,
      };
    } else {
      try {
        const response = await fetchText(modelsUrl(api.baseUrl), api.apiKey, api.healthTimeoutMs);
        reading = readinessFrom({ status: response.status, body: parseJson(response.text) }, api.model);
      } catch (error) {
        reading = readinessFromFetchError(classifyFetchError(error), api.model);
      }
    }
    if (!stopped) apply(reading, startedSeq);
    return current();
  };

  const refresh = (): Promise<HealthReading> => {
    if (stopped) return Promise.resolve(current());
    inFlight ??= check()
      .catch((error: unknown) => {
        log.warn("health check failed", { error: String(error) });
        return current();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const unsubscribe = settings.onChange(() => {
    if (endpointKey() === endpoint) return;
    endpoint = endpointKey();
    pause = null;
    netErrorSince = null;
    void refresh();
  });

  return {
    reading: current,
    sendable: () => isSendable(current().readiness),
    checkedAt: () => lastCheckAt,
    whenSendable: () => {
      if (isSendable(current().readiness)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (lastCheckAt === 0) void refresh();
        else if (inFlight === null) schedule();
      });
    },
    report: (error: ErrorInfo) => {
      const rule = REPORT_PAUSES[error.code];
      if (rule === undefined) return;
      const now = clock.now();
      sequence += 1;
      pause = {
        code: error.code,
        readiness: rule.readiness,
        cause: `${error.code}: ${error.message}`,
        at: now,
        seq: sequence,
        until: rule.holdMs === null ? null : now + rule.holdMs,
      };
      if (rule.readiness === "unreachable" || rule.readiness === "lna_blocked") netErrorSince ??= now;
      notify();
      if (inFlight === null) schedule();
    },
    setBusy: (next) => {
      if (next === busy) return;
      busy = next;
      if (!next) {
        if (waiters.length === 0) idleSince = clock.now();
        return;
      }
      if (inFlight === null) schedule();
    },
    refresh,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: () => {
      stopped = true;
      if (cancelTimer !== null) {
        cancelTimer();
        cancelTimer = null;
      }
      unsubscribe();
    },
  };
}
