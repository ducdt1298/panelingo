// Request side of the mock: read the JSON body under a size limit, check the bearer token, and validate a
// chat-completions body roughly the way OpenAI does, collecting what the recorder needs (roles, text, images).
// Error responses use the OpenAI shape {"error":{"message","type","param","code"}}.

import type { IncomingMessage } from "node:http";
import { finished } from "node:stream/promises";
import { errorBody, prop, type ApiErrorBody } from "./wire.ts";

/** Default request body limit. */
export const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;

/** A request the mock rejects; becomes an OpenAI error body with `status`. */
export class MockApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;

  constructor(
    message: string,
    options: { status?: number; type?: string; code?: string | null; param?: string | null } = {},
  ) {
    super(message);
    this.name = "MockApiError";
    this.status = options.status ?? 400;
    this.type = options.type ?? "invalid_request_error";
    this.code = options.code ?? null;
    this.param = options.param ?? null;
  }

  toBody(): ApiErrorBody {
    return errorBody(this);
  }
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

// ---------------------------------------------------------------------------------------------------------------
// Body

export type BodyResult =
  | { kind: "empty"; bytes: 0 }
  | { kind: "json"; value: unknown; bytes: number }
  | { kind: "invalid-json"; message: string; bytes: number }
  | { kind: "too-large"; bytes: number };

/** Consume and discard whatever is left of the request body. */
export async function drainRequest(req: IncomingMessage): Promise<void> {
  if (req.readableEnded) {
    return;
  }
  req.resume();
  await finished(req).catch(() => undefined);
}

/**
 * Read the whole body (also past the limit, so a rejected request leaves its keep-alive connection usable) and parse
 * it as JSON whatever the Content-Type. Rejects only when the client aborts the upload.
 */
export async function readJsonBody(
  req: IncomingMessage,
  limit = DEFAULT_MAX_BODY_BYTES,
): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const part of req) {
    const buf = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
    received += buf.length;
    if (received <= limit) {
      chunks.push(buf);
    }
  }
  if (received > limit) {
    return { kind: "too-large", bytes: received };
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    return { kind: "empty", bytes: 0 };
  }
  try {
    return { kind: "json", value: JSON.parse(text) as unknown, bytes: received };
  } catch (error) {
    return {
      kind: "invalid-json",
      message: error instanceof Error ? error.message : String(error),
      bytes: received,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Authorization

export type BearerCheck = "ok" | "missing" | "invalid";

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header(req, "authorization") ?? "");
  return match?.[1] ?? null;
}

/** Without a configured key every request passes. */
export function checkBearer(req: IncomingMessage, apiKey: string | undefined): BearerCheck {
  if (apiKey === undefined || apiKey === "") {
    return "ok";
  }
  const token = bearerToken(req);
  if (token === null) {
    return "missing";
  }
  return token === apiKey ? "ok" : "invalid";
}

export function unauthorizedError(check: Exclude<BearerCheck, "ok">): MockApiError {
  const message =
    check === "missing"
      ? "You didn't provide an API key. Send it in an Authorization header using Bearer auth (Authorization: Bearer YOUR_KEY)."
      : "Incorrect API key provided.";
  return new MockApiError(message, { status: 401, code: "invalid_api_key" });
}

// ---------------------------------------------------------------------------------------------------------------
// Validation

const ROLES = new Set<unknown>(["system", "developer", "user", "assistant", "tool"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_DETAILS = new Set<unknown>(["auto", "low", "high"]);
const UNSUPPORTED_IMAGE =
  "You uploaded an unsupported image. Please make sure your image has one of the following formats: ['png', 'jpeg', 'gif', 'webp'].";

export type ImageSniff = "jpeg" | "png" | "gif" | "webp" | "other";

/** An image_url part that passed validation. */
export interface ValidatedImage {
  messageIndex: number;
  /** "data" for a base64 data URL, "url" for a remote URL (never fetched). */
  source: "data" | "url";
  /** MIME type of a data URL; null for remote URLs. */
  mime: string | null;
  /** Decoded size of a data URL; 0 for remote URLs. */
  bytes: number;
  /** What the decoded bytes are; null for remote URLs. */
  sniff: ImageSniff | null;
  /** `image_url.detail` when sent. */
  detail: string | null;
}

export interface ValidatedChat {
  model: string;
  messages: unknown[];
  stream: boolean;
  /** `stream_options.include_usage`: a usage chunk follows the finish chunk. */
  includeUsage: boolean;
  temperature: number | null;
  images: ValidatedImage[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string, param: string | null, code: string | null = "invalid_value"): MockApiError {
  return new MockApiError(message, { code, param });
}

export function sniffImage(bytes: Uint8Array): ImageSniff {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    return "webp";
  }
  return "other";
}

function validateImagePart(
  part: Record<string, unknown>,
  messageIndex: number,
  role: unknown,
  param: string,
): ValidatedImage {
  if (role !== "user") {
    throw invalid(`Image URLs are only allowed for messages with role 'user', not '${String(role)}'.`, param);
  }
  const imageUrl = part["image_url"];
  if (!isPlainObject(imageUrl) || typeof imageUrl["url"] !== "string") {
    throw invalid("image_url must be an object with a string url.", `${param}.image_url`, "invalid_type");
  }
  const detail = imageUrl["detail"];
  if (detail !== undefined && detail !== null && !IMAGE_DETAILS.has(detail)) {
    throw invalid("image_url.detail must be 'auto', 'low' or 'high'.", `${param}.image_url.detail`);
  }
  const base = { messageIndex, detail: typeof detail === "string" ? detail : null };
  const url = imageUrl["url"].trim();
  if (/^https?:\/\//i.test(url)) {
    return { ...base, source: "url", mime: null, bytes: 0, sniff: null };
  }
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,([\s\S]*)$/i.exec(url);
  if (!match) {
    throw invalid(
      "Invalid image URL: expected an http(s) URL or a base64 data URL.",
      `${param}.image_url.url`,
      "invalid_image_url",
    );
  }
  const mime = (match[1] ?? "").trim().toLowerCase();
  const data = (match[2] ?? "").replace(/\s+/g, "");
  if (data === "" || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data) || /=[^=]/.test(data)) {
    throw invalid("Invalid base64 image data.", `${param}.image_url.url`, "invalid_image_url");
  }
  const bytes = Buffer.from(data, "base64");
  const sniff = sniffImage(bytes);
  if (!IMAGE_MIME_TYPES.has(mime) || sniff === "other") {
    throw invalid(UNSUPPORTED_IMAGE, `${param}.image_url.url`, "invalid_image_format");
  }
  return { ...base, source: "data", mime, bytes: bytes.length, sniff };
}

function validateMessage(message: unknown, index: number, images: ValidatedImage[]): void {
  const param = `messages[${index}]`;
  if (!isPlainObject(message)) {
    throw invalid(`${param} must be an object.`, param, "invalid_type");
  }
  const role = message["role"];
  if (!ROLES.has(role)) {
    throw invalid(
      `Invalid value for '${param}.role': expected one of 'system', 'developer', 'user', 'assistant' or 'tool'.`,
      `${param}.role`,
    );
  }
  const content = message["content"];
  if (content === undefined || content === null || typeof content === "string") {
    return;
  }
  if (!Array.isArray(content)) {
    throw invalid(
      `${param}.content must be a string or an array of content parts.`,
      `${param}.content`,
      "invalid_type",
    );
  }
  (content as unknown[]).forEach((part, j) => {
    const partParam = `${param}.content[${j}]`;
    if (!isPlainObject(part)) {
      throw invalid(`${partParam} must be an object.`, partParam, "invalid_type");
    }
    const type = part["type"];
    if (type === "text") {
      if (typeof part["text"] !== "string") {
        throw invalid(`${partParam}.text must be a string.`, `${partParam}.text`, "invalid_type");
      }
      return;
    }
    if (type === "image_url") {
      images.push(validateImagePart(part, index, role, partParam));
      return;
    }
    throw invalid(
      `Unsupported content part type ${JSON.stringify(type)}: the mock accepts 'text' and 'image_url'.`,
      `${partParam}.type`,
    );
  });
}

/** Validate a chat-completions body; throws MockApiError (HTTP 400) on the first problem. */
export function validateChatRequest(body: unknown): ValidatedChat {
  if (!isPlainObject(body)) {
    throw invalid("The request body must be a JSON object.", null, "invalid_type");
  }
  const model = body["model"];
  if (model === undefined || model === null || model === "") {
    throw invalid("you must provide a model parameter", "model", "missing_required_parameter");
  }
  if (typeof model !== "string") {
    throw invalid("model must be a string.", "model", "invalid_type");
  }
  const messages = body["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalid(
      "messages must be a non-empty array.",
      "messages",
      messages === undefined ? "missing_required_parameter" : "invalid_value",
    );
  }
  const stream = body["stream"];
  if (stream !== undefined && stream !== null && typeof stream !== "boolean") {
    throw invalid("stream must be a boolean.", "stream", "invalid_type");
  }
  const options = body["stream_options"];
  if (options !== undefined && options !== null && !isPlainObject(options)) {
    throw invalid("stream_options must be an object.", "stream_options", "invalid_type");
  }
  const temperature = body["temperature"];
  if (
    temperature !== undefined &&
    temperature !== null &&
    (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)
  ) {
    throw invalid("temperature must be a number between 0 and 2.", "temperature");
  }
  const n = body["n"];
  if (n !== undefined && n !== null && n !== 1) {
    throw invalid("The mock only supports n=1.", "n", "unsupported_value");
  }
  const images: ValidatedImage[] = [];
  (messages as unknown[]).forEach((message, index) => validateMessage(message, index, images));
  return {
    model,
    messages: messages as unknown[],
    stream: stream === true,
    includeUsage: prop(options, "include_usage") === true,
    temperature: typeof temperature === "number" ? temperature : null,
    images,
  };
}
