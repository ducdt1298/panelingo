// OpenAI chat-completions wire format: chunk and completion objects, SSE frames, OpenAI error bodies, rough token
// estimates, plain JSON responses, and the helpers that split and replay recorded SSE transcripts byte for byte.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Model listed by GET /v1/models when none is configured. */
export const DEFAULT_MODEL = "mock-vision";

/** Response headers of a streamed completion, in the order they are set. */
export const SSE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Content-Type", "text/event-stream; charset=utf-8"],
  ["Cache-Control", "no-cache"],
  ["Connection", "keep-alive"],
];

/** The terminating SSE frame of every complete stream. */
export const DONE_FRAME = "data: [DONE]\n\n";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Identity shared by every chunk of one completion (OpenAI repeats id, created and model in each chunk). */
export interface CompletionMeta {
  id: string;
  model: string;
  /** Epoch seconds. */
  created: number;
}

/** An OpenAI error object: `{"error":{"message","type","param","code"}}`. */
export interface ApiErrorFields {
  message: string;
  type: string;
  code?: string | null | undefined;
  param?: string | null | undefined;
}

export interface ApiErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}

export function errorBody(fields: ApiErrorFields): ApiErrorBody {
  return {
    error: {
      message: fields.message,
      type: fields.type,
      param: fields.param ?? null,
      code: fields.code ?? null,
    },
  };
}

/** `chatcmpl-<32 hex chars>`. */
export function generateCompletionId(): string {
  return `chatcmpl-${randomUUID().replaceAll("-", "")}`;
}

export function newCompletion(model: string): CompletionMeta {
  return { id: generateCompletionId(), model, created: Math.floor(Date.now() / 1000) };
}

/** One `data: <json>` frame. */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(meta: CompletionMeta, choices: unknown[], extra: Record<string, unknown> = {}): string {
  return sseFrame({
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices,
    ...extra,
  });
}

/** First chunk of a stream: the assistant role with empty content, as OpenAI sends it. */
export function roleChunk(meta: CompletionMeta): string {
  return chunk(meta, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
}

export function contentChunk(meta: CompletionMeta, text: string): string {
  return chunk(meta, [{ index: 0, delta: { content: text }, finish_reason: null }]);
}

/** Last chunk with choices: empty delta and the finish reason ("stop", "length", "content_filter"...). */
export function finishChunk(meta: CompletionMeta, finishReason = "stop"): string {
  return chunk(meta, [{ index: 0, delta: {}, finish_reason: finishReason }]);
}

/** Sent after the finish chunk when the request asks for `stream_options.include_usage`; `choices` is empty. */
export function usageChunk(meta: CompletionMeta, usage: Usage): string {
  return chunk(meta, [], { usage });
}

/** An in-stream error frame, as some providers and gateways send when generation fails mid-stream. */
export function errorFrame(fields: ApiErrorFields): string {
  return sseFrame(errorBody(fields));
}

/** The `chat.completion` object of a request with `stream: false`. */
export function nonStreamBody(
  meta: CompletionMeta,
  content: string,
  usage: Usage,
  finishReason = "stop",
): Record<string, unknown> {
  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage,
  };
}

/** Optional property read (`value?.[key]`) that also works on primitives. */
export function prop(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  return (Object(value) as Record<string, unknown>)[key];
}

/** Text of a message `content`: a string, or the text parts of an array joined by "\n" (images add nothing). */
export function contentToText(content: unknown): string {
  if (Array.isArray(content)) {
    const pieces: string[] = [];
    for (const part of content as unknown[]) {
      const text = prop(part, "text");
      if (typeof text === "string" && text !== "") {
        pieces.push(text);
      }
    }
    return pieces.join("\n");
  }
  return typeof content === "string" ? content : "";
}

/** Rough token count: about 4 characters per token. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/** Flat estimate per image part (the mock never decodes dimensions). */
export const IMAGE_TOKENS = 85;

/** Prompt tokens: text at ~4 characters per token, 4 per message, IMAGE_TOKENS per image. */
export function estimatePromptTokens(messages: readonly unknown[], imageCount = 0): number {
  let chars = 0;
  for (const message of messages) {
    chars += contentToText(prop(message, "content")).length;
  }
  return Math.ceil(chars / 4) + 4 * messages.length + IMAGE_TOKENS * imageCount;
}

export function buildUsage(promptTokens: number, completionTokens: number): Usage {
  const prompt = Math.max(0, Math.floor(promptTokens));
  const completion = Math.max(0, Math.floor(completionTokens));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** A complete JSON response with Content-Length; HEAD gets the headers only. */
export function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(payload.length));
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(payload);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recorded transcripts

const LF = 0x0a;
const CR = 0x0d;

/**
 * Split raw SSE bytes into frames, each ending after the blank line that terminates it (LF, CRLF or CR line ends).
 * Bytes are never altered: concatenating the result gives the input back. A trailing incomplete frame is kept.
 */
export function splitSseFrames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let frameStart = 0;
  let lineStart = 0;
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c === LF || c === CR) {
      const end = c === CR && bytes[i + 1] === LF ? i + 2 : i + 1;
      if (i === lineStart && i > frameStart) {
        frames.push(bytes.subarray(frameStart, end));
        frameStart = end;
      }
      lineStart = end;
      i = end;
    } else {
      i += 1;
    }
  }
  if (frameStart < bytes.length) {
    frames.push(bytes.subarray(frameStart));
  }
  return frames;
}

/** The data of one SSE frame: its `data:` lines (one leading space removed) joined by LF, or null if none. */
function frameData(frame: Uint8Array): string | null {
  const lines: string[] = [];
  for (const line of new TextDecoder().decode(frame).split(/\r\n|\n|\r/)) {
    if (line.startsWith("data:")) {
      const data = line.slice(5);
      lines.push(data.startsWith(" ") ? data.slice(1) : data);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** True for the `data: [DONE]` frame. */
export function isDoneFrame(frame: Uint8Array): boolean {
  return frameData(frame)?.trim() === "[DONE]";
}

/** `choices[0].delta.content` of a frame, or null for role, usage, finish and [DONE] frames, comments and non-JSON. */
export function frameContent(frame: Uint8Array): string | null {
  const data = frameData(frame);
  if (data === null || data.trim() === "[DONE]") {
    return null;
  }
  try {
    const choices = prop(JSON.parse(data) as unknown, "choices");
    const content = prop(
      prop(Array.isArray(choices) ? (choices as unknown[])[0] : undefined, "delta"),
      "content",
    );
    return typeof content === "string" ? content : null;
  } catch {
    return null; // not JSON: not ours to interpret
  }
}

/** Text carried by the `delta.content` of SSE frames (answers a non-stream request from a replay). */
export function contentOfFrames(frames: readonly Uint8Array[]): string {
  return frames.map((frame) => frameContent(frame) ?? "").join("");
}

/** One write of a replayed transcript: exactly one recorded frame. */
export interface ReplayWrite {
  bytes: Uint8Array;
  /** Carries non-empty `delta.content`. Pacing and cuts only ever happen around these. */
  content: boolean;
  /** Holds the `data: [DONE]` frame. */
  done: boolean;
}

export function replayWrites(frames: readonly Uint8Array[]): ReplayWrite[] {
  return frames.map((bytes) => ({
    bytes,
    content: (frameContent(bytes) ?? "") !== "",
    done: isDoneFrame(bytes),
  }));
}
