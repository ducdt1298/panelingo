// API endpoint readiness (or, in offline mode, the offline engine's state), engine status and the daily upload counter
// as view models (pure, unit-tested) shared by the extension pages. Texts and remediation:
// msg().readiness, msg().errors, msg().popup, msg().offlineState.

import type { HealthReading } from "../../shared/core/health.ts";
import { toErrorInfo } from "../../shared/errors.ts";
import { msg } from "../../shared/i18n/index.ts";
import type { ApiReadiness, EngineStatus, OfflineStatus } from "../../shared/types.ts";

export type Tone = "ok" | "warn" | "error" | "pending" | "idle";

/** Short localized title of any thrown value for a page message (msg().errors; unknown errors: engine.internal). */
export function errorTitle(error: unknown): string {
  return msg().errors[toErrorInfo(error).code].title;
}

export interface StatusBlock {
  tone: Tone;
  title: string;
  /** What the user can do (empty when nothing). */
  hint: string;
  lines: string[];
  warnings: string[];
}

export const READINESS_TONE: Readonly<Record<ApiReadiness, Tone>> = {
  unknown: "pending",
  ready: "ok",
  unauthorized: "error",
  unreachable: "error",
  lna_blocked: "error",
  misconfigured: "error",
};

const MB = 1024 * 1024;

/** null reading = the /models request is still running; baseUrl is shown so the user sees which endpoint. */
export function apiBlock(reading: HealthReading | null, baseUrl: string | null = null): StatusBlock {
  if (reading === null) {
    return { tone: "pending", title: msg().popup.checking, hint: "", lines: [], warnings: [] };
  }
  const text = msg().readiness[reading.readiness];
  const lines: string[] = [];
  if (baseUrl !== null && baseUrl !== "") lines.push(msg().popup.endpoint(baseUrl));
  if (reading.model !== null) lines.push(msg().popup.model(reading.model));
  const warnings: string[] = [];
  if (reading.cause !== null) {
    // On a ready endpoint the cause is a warning (model not listed, no /models route); otherwise it explains why.
    if (reading.readiness === "ready") warnings.push(msg().popup.cause(reading.cause));
    else lines.push(msg().popup.cause(reading.cause));
  }
  return { tone: READINESS_TONE[reading.readiness], title: text.label, hint: text.hint, lines, warnings };
}

const MB_DECIMAL = 1_000_000;

/**
 * Offline mode (experimental): what the popup shows instead of the AI endpoint. null = the engine is not running (or
 * predates offline mode): the models load on first use.
 */
export function offlineBlock(status: OfflineStatus | null): StatusBlock {
  const t = msg();
  if (status === null) {
    return { tone: "idle", title: t.offlineState.idle, hint: t.popup.offlineHint, lines: [], warnings: [] };
  }
  const lines: string[] = [];
  if (status.download !== null) {
    lines.push(
      t.popup.offlineDownload(status.download.done / MB_DECIMAL, status.download.total / MB_DECIMAL),
    );
  }
  if (status.active.length > 0) lines.push(t.popup.offlineModels(status.active.join(", ")));
  if (status.state === "failed" && status.error !== null) {
    const error = t.errors[status.error];
    return { tone: "error", title: error.title, hint: error.hint, lines, warnings: [] };
  }
  const tone: Tone =
    status.state === "ready"
      ? "ok"
      : status.state === "downloading" || status.state === "loading"
        ? "pending"
        : "idle";
  return { tone, title: t.offlineState[status.state], hint: t.popup.offlineHint, lines, warnings: [] };
}

export interface EngineState {
  exists: boolean;
  /** null when the engine exists but did not answer en:status. */
  status: EngineStatus | null;
}

/** null state = sw:engine-state is still pending. */
export function engineBlock(state: EngineState | null): StatusBlock {
  const block = (tone: Tone, title: string): StatusBlock => ({
    tone,
    title,
    hint: "",
    lines: [],
    warnings: [],
  });
  if (state === null) return block("pending", msg().popup.checking);
  if (!state.exists) return block("idle", msg().popup.engineStopped);
  const status = state.status;
  if (status === null) return block("warn", msg().popup.engineUnreadable);
  const { detector, queue } = status;
  const lines = [
    msg().popup.detectorLine(
      msg().detectorBackend[detector.backend],
      msg().detectorState[detector.state],
      msg().detectorCanary[detector.canary],
    ),
    msg().popup.queueLine(queue.queued, queue.inFlight, queue.done, queue.failed),
  ];
  const paused = queue.pausedBy;
  if (paused !== null) lines.unshift(msg().popup.pausedBy(msg().errors[paused].title));
  const tone: Tone =
    status.phase === "failed"
      ? "error"
      : paused !== null
        ? "warn"
        : status.phase === "ready"
          ? "ok"
          : "pending";
  return {
    tone,
    title: msg().enginePhase[status.phase],
    hint: paused === null ? "" : msg().errors[paused].hint,
    lines,
    warnings: [],
  };
}

/** "Sent N composite images (X MB) to the AI today"; null without a running engine (never started for this). */
export function uploadsLine(status: EngineStatus | null): string | null {
  if (status === null) return null;
  return msg().ui.uploadsToday(status.uploads.today, status.uploads.bytesToday / MB);
}
