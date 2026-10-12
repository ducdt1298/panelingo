// Readiness of the configured OpenAI-compatible endpoint from GET {baseUrl}/models. PURE; the engine's health monitor
// owns the polling schedule and the queue gate, the popup checks the same way without starting the engine.
//
//   base URL or model missing / invalid → misconfigured (no request is made)
//   no answer                           → unreachable (lna_blocked when the fetch error says Chrome blocked it)
//   200                                 → ready (cause notes a configured model the server does not list)
//   401 / 403                           → unauthorized (missing or wrong API key)
//   400 saying the key is invalid       → unauthorized (Gemini's OpenAI mode answers a bad key with 400)
//   404 / 405 / 501                     → ready: many compatible servers have no /models route; requests will tell
//   429                                 → ready: the server is reachable, requests back off on their own
//   anything else (5xx, ...)            → unreachable, with the status as cause

import type { ErrorCode, ErrorInfo } from "../errors.ts";
import type { ApiReadiness } from "../types.ts";
import { isInvalidKeyMessage } from "./api-errors.ts";

export interface HealthReading {
  readiness: ApiReadiness;
  /** The configured model id. */
  model: string | null;
  /** Why the endpoint is not ready, or a warning (model not listed, no /models route). */
  cause: string | null;
}

/** What GET /models answered (status and parsed JSON body, or null when the body was not JSON). */
export interface HealthAnswer {
  status: number;
  body: unknown;
}

export const INITIAL_HEALTH: Readonly<HealthReading> = Object.freeze({
  readiness: "unknown",
  model: null,
  cause: null,
});

/** {baseUrl}/models (trailing slashes of the base URL ignored). */
export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/models`;
}

/** Why the settings cannot work at all (then no request is made), or null. */
export function configProblem(baseUrl: string, model: string): string | null {
  if (model.trim() === "") return "no model configured";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "invalid base URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "the base URL must be http or https";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Model ids listed in an OpenAI-style { data: [{ id }] } body (also accepts { models: [...] } and plain arrays). */
export function listedModels(body: unknown): string[] | null {
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body["data"])
      ? body["data"]
      : isRecord(body) && Array.isArray(body["models"])
        ? body["models"]
        : null;
  if (list === null) return null;
  const ids: string[] = [];
  for (const item of list as unknown[]) {
    if (typeof item === "string") ids.push(item);
    else if (isRecord(item)) {
      const id = item["id"] ?? item["name"] ?? item["model"];
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

function errorMessage(input: unknown): string | null {
  // Gemini's OpenAI mode wraps its error object in a one-element array.
  const body = Array.isArray(input) && input.length > 0 ? (input[0] as unknown) : input;
  if (!isRecord(body)) return null;
  const error = body["error"];
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error["message"] === "string") return error["message"];
  return typeof body["message"] === "string" ? body["message"] : null;
}

/** Readiness from a GET /models answer; `answer` null means the request failed (see readinessFromFetchError). */
export function readinessFrom(answer: HealthAnswer | null, model: string | null): HealthReading {
  const reading = (readiness: ApiReadiness, cause: string | null = null): HealthReading => ({
    readiness,
    model,
    cause,
  });
  if (answer === null) return reading("unreachable");
  const { status, body } = answer;
  if (status >= 200 && status < 300) {
    const ids = listedModels(body);
    if (model !== null && ids !== null && ids.length > 0 && !ids.includes(model)) {
      return reading("ready", `model "${model}" is not listed by the server`);
    }
    return reading("ready");
  }
  const message = errorMessage(body);
  if (status === 401 || status === 403) return reading("unauthorized", message ?? `HTTP ${status}`);
  if (status === 400 && message !== null && isInvalidKeyMessage(message))
    return reading("unauthorized", message);
  if (status === 404 || status === 405 || status === 501)
    return reading("ready", "the server has no /models route");
  if (status === 429) return reading("ready", "rate limited");
  return reading("unreachable", message ?? `HTTP ${status}`);
}

/** Readiness when GET /models threw; `info` comes from classifyFetchError. */
export function readinessFromFetchError(info: ErrorInfo, model: string | null = null): HealthReading {
  return {
    readiness: info.code === "api.lna_blocked" ? "lna_blocked" : "unreachable",
    model,
    cause: info.message,
  };
}

/** Requests may be sent in this state. */
export function isSendable(readiness: ApiReadiness): boolean {
  return readiness === "ready";
}

const READINESS_ERROR: Readonly<Record<ApiReadiness, ErrorCode | null>> = {
  unknown: null,
  ready: null,
  unauthorized: "api.unauthorized",
  unreachable: "api.unreachable",
  lna_blocked: "api.lna_blocked",
  misconfigured: "api.config",
};

/** Error code that pauses the queue in this state (EngineStatus.queue.pausedBy), or null when sending is allowed. */
export function readinessErrorCode(readiness: ApiReadiness): ErrorCode | null {
  return READINESS_ERROR[readiness];
}
