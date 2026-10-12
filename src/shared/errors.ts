// Error registry shared by engine, service worker, content and UI.
// Errors cross contexts as ErrorInfo values, never as rejections. User-facing texts live in src/shared/i18n. PURE.

export interface ErrorMeta {
  /** What the error affects. */
  scope: "unit" | "image" | "batch" | "queue" | "frame" | "global";
  /** never: give up · auto: retry policy decides · health: resume when the API is ready · user: needs a user action */
  retry: "never" | "auto" | "health" | "user";
  severity: "info" | "warn" | "error";
}

export const ERRORS = {
  // The OpenAI-compatible API endpoint (any provider: OpenAI, OpenRouter, Azure, Ollama, LM Studio, vLLM, ...).
  "api.unreachable": { scope: "queue", retry: "health", severity: "warn" },
  "api.lna_blocked": { scope: "global", retry: "user", severity: "error" },
  "api.unauthorized": { scope: "queue", retry: "health", severity: "warn" },
  "api.config": { scope: "global", retry: "user", severity: "error" },
  "api.rate_limit": { scope: "batch", retry: "auto", severity: "warn" },
  "api.upstream": { scope: "batch", retry: "auto", severity: "warn" },
  "api.context_length": { scope: "batch", retry: "auto", severity: "warn" },
  "api.timeout": { scope: "batch", retry: "auto", severity: "warn" },
  "api.truncated": { scope: "batch", retry: "auto", severity: "info" },
  "api.partial": { scope: "batch", retry: "auto", severity: "info" },
  "api.empty": { scope: "batch", retry: "auto", severity: "warn" },
  "api.too_large": { scope: "batch", retry: "auto", severity: "warn" },
  "api.bad_request": { scope: "batch", retry: "never", severity: "error" },
  "api.protocol": { scope: "batch", retry: "auto", severity: "warn" },
  "llm.refused": { scope: "batch", retry: "never", severity: "warn" },
  "llm.missing": { scope: "unit", retry: "user", severity: "info" },
  "llm.format": { scope: "batch", retry: "auto", severity: "warn" },
  "image.url_blocked": { scope: "image", retry: "never", severity: "warn" },
  "image.http": { scope: "image", retry: "auto", severity: "warn" },
  "image.not_image": { scope: "image", retry: "never", severity: "warn" },
  "image.too_large": { scope: "image", retry: "never", severity: "warn" },
  "image.decode": { scope: "image", retry: "auto", severity: "warn" },
  "image.capture_unavailable": { scope: "image", retry: "auto", severity: "info" },
  /** Only a screen capture could read the image, and it is not allowed here (site not on, tab hidden, subframe). */
  "image.capture_blocked": { scope: "image", retry: "user", severity: "info" },
  "detector.webgpu_unavailable": { scope: "global", retry: "never", severity: "info" },
  "detector.canary_mismatch": { scope: "global", retry: "never", severity: "warn" },
  "detector.model_integrity": { scope: "global", retry: "user", severity: "error" },
  "detector.init": { scope: "global", retry: "user", severity: "error" },
  "detector.run": { scope: "image", retry: "auto", severity: "warn" },
  "engine.unavailable": { scope: "frame", retry: "user", severity: "error" },
  "engine.closing": { scope: "frame", retry: "auto", severity: "info" },
  "engine.overloaded": { scope: "image", retry: "auto", severity: "info" },
  "engine.protocol": { scope: "frame", retry: "auto", severity: "error" },
  "engine.internal": { scope: "image", retry: "never", severity: "error" },
  "msg.too_large": { scope: "image", retry: "auto", severity: "warn" },
  "ctx.invalidated": { scope: "frame", retry: "never", severity: "info" },
  "dnr.failed": { scope: "image", retry: "auto", severity: "warn" },
  "store.io": { scope: "global", retry: "never", severity: "warn" },
  "store.quota": { scope: "global", retry: "user", severity: "warn" },
  "site.disabled": { scope: "frame", retry: "never", severity: "info" },
  /** No upload before the privacy notice is confirmed (settings.privacy.ackUploadNoticeAt), in auto and manual mode. */
  "privacy.consent": { scope: "global", retry: "user", severity: "info" },
  cancelled: { scope: "image", retry: "never", severity: "info" },
} as const satisfies Record<string, ErrorMeta>;

export type ErrorCode = keyof typeof ERRORS;

/** Serializable error crossing contexts. */
export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
  detail?: string;
}

export interface CtvErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  status?: number;
  detail?: string;
  cause?: unknown;
}

export class CtvError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string, options: CtvErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "CtvError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.detail = options.detail;
  }

  static from(info: ErrorInfo): CtvError {
    return new CtvError(info.code, info.message, info);
  }

  toInfo(): ErrorInfo {
    const info: ErrorInfo = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.retryAfterMs !== undefined) info.retryAfterMs = this.retryAfterMs;
    if (this.status !== undefined) info.status = this.status;
    if (this.detail !== undefined) info.detail = this.detail;
    return info;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERRORS, value);
}

/** The message of any thrown value, for logs and ErrorInfo (an Error's message, else String(value)). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Any thrown value → ErrorInfo. Unknown errors become engine.internal (a bug). */
export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof CtvError) {
    return error.toInfo();
  }
  return { code: "engine.internal", message: errorMessage(error), retryable: false };
}
