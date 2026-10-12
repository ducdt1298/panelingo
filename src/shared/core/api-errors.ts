// Failures of the OpenAI-compatible endpoint → ErrorInfo (the single error/action table, docs/ARCHITECTURE.md
// "Errors"). PURE. Retry decisions live in retry-policy.ts.
//
// Error bodies follow the OpenAI shape {"error":{"message","type","code","param"}}; many compatible servers (Azure,
// OpenRouter, vLLM, Ollama, LM Studio, LiteLLM) use the same shape or a plain {"error":"…"} / {"message":"…"}.
// Classification goes by status first, then type and code. A content-filter answer is a refusal and is never retried:
// providers may keep what was uploaded. `retryable` follows the registry: true when the code is retried automatically
// ("auto") or resumes once the endpoint is reachable ("health"); false when it needs the user or is never retried.

import { CtvError, ERRORS, type ErrorCode, type ErrorInfo } from "../errors.ts";
import { isContentFilterMessage } from "./refusal.ts";

interface ParsedBody {
  message: string | null;
  type: string | null;
  code: string | null;
  /** Nested provider details some gateways add (e.g. OpenRouter metadata.raw, LiteLLM details). */
  nested: string | null;
  raw: string | null;
}

const MAX_MESSAGE_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

function nestedText(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value.slice(0, 2000);
  if (isRecord(value)) {
    try {
      return JSON.stringify(value).slice(0, 2000);
    } catch {
      return null;
    }
  }
  return null;
}

function parseBody(body: unknown): ParsedBody {
  const parsed: ParsedBody = { message: null, type: null, code: null, nested: null, raw: null };
  let value = body;
  if (typeof value === "string") {
    parsed.raw = value.trim() === "" ? null : value.trim().slice(0, MAX_MESSAGE_CHARS);
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return parsed;
    }
  }
  // Gemini's OpenAI mode wraps its error object in a one-element array.
  if (Array.isArray(value) && value.length > 0) value = value[0];
  if (!isRecord(value)) return parsed;
  const error = value["error"];
  if (isRecord(error)) {
    parsed.message = str(error["message"]);
    // Google APIs put the canonical status ("INVALID_ARGUMENT", "PERMISSION_DENIED") where OpenAI has the type.
    parsed.type = str(error["type"]) ?? str(error["status"]);
    parsed.code = str(error["code"]);
    parsed.nested =
      nestedText(error["metadata"]) ?? nestedText(error["details"]) ?? nestedText(error["innererror"]);
  } else {
    parsed.message = str(error) ?? str(value["message"]) ?? str(value["detail"]);
  }
  return parsed;
}

function make(code: ErrorCode, message: string, status: number | null, detail: string | null): ErrorInfo {
  const policy = ERRORS[code].retry;
  const info: ErrorInfo = { code, message, retryable: policy === "auto" || policy === "health" };
  if (status !== null) info.status = status;
  if (detail !== null) info.detail = detail;
  return info;
}

const CONTEXT_LENGTH = /context[_ ]length|maximum context|too many tokens|prompt is too long|max_tokens/iu;
const NO_VISION = /image|vision|multimodal|image_url/iu;
const MODEL_UNKNOWN = /model.*(not found|does not exist|unknown|not available)|no such model|invalid model/iu;
const TOO_LARGE = /too large|entity too large|payload|request size|body size/iu;
/** A rejected key reported with a status other than 401/403 (Gemini answers a bad key with 400). */
const INVALID_KEY =
  /api[_ ]?key(?: is)? (?:not valid|invalid|expired)|API_KEY_INVALID|invalid[_ ]api[_ ]key|incorrect api key|UNAUTHENTICATED/iu;

/** True when an error text says the API key was rejected. */
export function isInvalidKeyMessage(text: string): boolean {
  return INVALID_KEY.test(text);
}

/** Non-2xx response of POST {baseUrl}/chat/completions. `body` is the parsed JSON, the raw text, or null. */
export function classifyHttpError(status: number, body: unknown): ErrorInfo {
  const e = parseBody(body);
  const message = (e.message ?? e.raw ?? `HTTP ${status}`).slice(0, MAX_MESSAGE_CHARS);
  const text = `${e.message ?? ""} ${e.code ?? ""} ${e.type ?? ""} ${e.raw ?? ""}`;
  const info = (code: ErrorCode, detail: string | null = e.code ?? e.type): ErrorInfo =>
    make(code, message, status, detail);

  if (status === 401 || status === 403) {
    if (
      e.code === "content_filter" ||
      [e.message, e.nested].some((t) => t !== null && isContentFilterMessage(t))
    ) {
      return info("llm.refused");
    }
    return info("api.unauthorized");
  }
  if ([e.message, e.code, e.type, e.nested, e.raw].some((t) => t !== null && isContentFilterMessage(t))) {
    return info("llm.refused");
  }
  if (status === 402) {
    // Payment required (e.g. OpenRouter credits): like insufficient_quota, only the user can fix it.
    return info("api.config", e.code ?? "payment required: check the account's credits or billing");
  }
  if (status === 413 || (status >= 400 && TOO_LARGE.test(text) && !CONTEXT_LENGTH.test(text))) {
    return info("api.too_large");
  }
  if (status === 429) {
    // insufficient_quota is a billing problem, not a transient limit: the user has to act.
    if (e.code === "insufficient_quota" || e.type === "insufficient_quota") return info("api.config");
    return info("api.rate_limit");
  }
  if (status === 400 || status === 422) {
    if (INVALID_KEY.test(`${text} ${e.nested ?? ""}`)) return info("api.unauthorized");
    if (e.code === "context_length_exceeded" || CONTEXT_LENGTH.test(text)) return info("api.context_length");
    if (MODEL_UNKNOWN.test(text) || e.code === "model_not_found") return info("api.config");
    if (NO_VISION.test(text)) return info("api.config", "model without image input");
    return info("api.bad_request");
  }
  if (status === 404) return info("api.config", e.code ?? "not found: check the base URL and the model");
  if (status === 408 || status === 504) return info("api.timeout");
  if (status >= 500 && status <= 599) return info("api.upstream");
  if (status >= 400 && status <= 499) return info("api.bad_request");
  return info("api.protocol");
}

const LNA_BLOCKED =
  /address space|local network|private network|loopback network|local-network|loopback-network/iu;

function describe(error: unknown, depth = 0): string {
  if (depth > 3 || error === undefined || error === null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return [error.name, error.message, typeof code === "string" ? code : "", describe(error.cause, depth + 1)]
      .filter((part) => part !== "")
      .join(" ");
  }
  return "";
}

/** The transport threw before or while reading a response (fetch TypeError, Node socket error, abort). */
export function classifyFetchError(error: unknown): ErrorInfo {
  if (error instanceof CtvError) return error.toInfo();
  const text = describe(error);
  const message = (error instanceof Error ? error.message : text) || "network error";
  if (LNA_BLOCKED.test(text)) return make("api.lna_blocked", message, null, null);
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return make("api.timeout", message, null, "aborted");
  return make("api.unreachable", message, null, null);
}
