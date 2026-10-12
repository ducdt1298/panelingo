// Server-sent events for the chat completions stream of the OpenAI-compatible API. PURE: decoded text in, callbacks
// out; the caller turns bytes into text.
//
// Framing follows the WHATWG event-stream rules: a line ends with LF, CRLF or a lone CR (a CR at the end of a chunk
// waits for the next chunk, which may start with LF); a blank line ends a frame; `data:` lines are joined with LF after
// removing one leading space; comments (`:`) and the event/id/retry fields are ignored; an unterminated frame at EOF
// is dropped. A typical server only sends `data: <json>\n\n` frames: role, content…, usage (`choices: []`), finish
// (`finish_reason: "stop"`, which proves nothing), then `data: [DONE]`.

export interface SseParser {
  /** Feeds decoded text, in chunks of any size. */
  push(text: string): void;
  /** End of stream: a final lone CR still ends its line; an incomplete frame is discarded. */
  end(): void;
}

const LF = 10;
const CR = 13;

export function createSseParser(onData: (data: string) => void): SseParser {
  let buffer = "";
  let data: string[] | null = null;
  let started = false;
  let ended = false;

  const takeLine = (line: string): void => {
    if (line === "") {
      if (data !== null) {
        const payload = data.join("\n");
        data = null;
        onData(payload);
      }
      return;
    }
    if (line.charCodeAt(0) === 58 /* ":" comment */) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") {
      return; // event, id, retry and unknown fields carry nothing we use
    }
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32 /* " " */) {
      value = value.slice(1);
    }
    (data ??= []).push(value);
  };

  const scan = (final: boolean): void => {
    const n = buffer.length;
    let pos = 0;
    while (pos < n) {
      let i = pos;
      while (i < n) {
        const c = buffer.charCodeAt(i);
        if (c === LF || c === CR) {
          break;
        }
        i += 1;
      }
      if (i >= n) {
        break; // partial line: wait for more text
      }
      if (buffer.charCodeAt(i) === CR) {
        if (i + 1 >= n && !final) {
          break; // a CR ending the chunk may be the first half of CRLF
        }
        takeLine(buffer.slice(pos, i));
        pos = buffer.charCodeAt(i + 1) === LF ? i + 2 : i + 1;
      } else {
        takeLine(buffer.slice(pos, i));
        pos = i + 1;
      }
    }
    buffer = pos === 0 ? buffer : buffer.slice(pos);
  };

  return {
    push(text: string): void {
      if (ended || text === "") {
        return;
      }
      if (!started) {
        started = true;
        if (text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }
      }
      buffer += text;
      scan(false);
    },
    end(): void {
      if (ended) {
        return;
      }
      ended = true;
      scan(true);
      buffer = "";
      data = null;
    },
  };
}

/** An `error` object sent inside the stream (some servers send one; others just end the stream silently). */
export interface StreamErrorFrame {
  message: string;
  type: string | null;
  code: string | null;
}

export interface ChatStreamState {
  /** `data: [DONE]` arrived. Required for completeness, but not proof of it (ids are still counted). */
  sawDone: boolean;
  /** Non-empty data payloads received, including `[DONE]`. */
  frames: number;
  /** Payloads that were not a JSON object; skipped. */
  invalidFrames: number;
  id: string | null;
  /** Provider model id from the chunk envelope, e.g. "gpt-4o-mini-2024-07-18". */
  model: string | null;
  finishReason: string | null;
  /** Last `usage` object seen (some servers only estimate it). */
  usage: unknown;
  /** First in-stream error frame. */
  error: StreamErrorFrame | null;
}

export interface ChatStreamDecoder {
  push(text: string): void;
  end(): void;
  /** Live view of what the stream has reported so far. */
  readonly state: Readonly<ChatStreamState>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(value: unknown): StreamErrorFrame {
  if (isRecord(value)) {
    return {
      message: typeof value.message === "string" && value.message !== "" ? value.message : "upstream error",
      type: typeof value.type === "string" ? value.type : null,
      code: typeof value.code === "string" ? value.code : null,
    };
  }
  return {
    message: typeof value === "string" && value !== "" ? value : "upstream error",
    type: null,
    code: null,
  };
}

/**
 * OpenAI-style chat chunks on top of the SSE parser. `choices[0].delta.content` goes to `onContent` in stream order;
 * everything after `[DONE]` or after an error frame is ignored (the error ends the request).
 */
export function createChatStreamDecoder(onContent: (text: string) => void): ChatStreamDecoder {
  const state: ChatStreamState = {
    sawDone: false,
    frames: 0,
    invalidFrames: 0,
    id: null,
    model: null,
    finishReason: null,
    usage: null,
    error: null,
  };

  const onData = (data: string): void => {
    if (state.sawDone || state.error !== null) {
      return;
    }
    const trimmed = data.trim();
    if (trimmed === "") {
      return;
    }
    state.frames += 1;
    if (trimmed === "[DONE]") {
      state.sawDone = true;
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      state.invalidFrames += 1;
      return;
    }
    if (!isRecord(message)) {
      state.invalidFrames += 1;
      return;
    }
    if (message.error !== undefined && message.error !== null && message.error !== false) {
      state.error ??= readError(message.error);
    }
    if (typeof message.id === "string") {
      state.id ??= message.id;
    }
    if (typeof message.model === "string") {
      state.model ??= message.model;
    }
    if (message.usage !== undefined && message.usage !== null) {
      state.usage = message.usage;
    }
    const choice: unknown = Array.isArray(message.choices) ? message.choices[0] : undefined;
    if (isRecord(choice)) {
      const delta = choice.delta;
      if (isRecord(delta) && typeof delta.content === "string" && delta.content !== "") {
        onContent(delta.content);
      }
      if (typeof choice.finish_reason === "string") {
        state.finishReason = choice.finish_reason;
      }
    }
  };

  const sse = createSseParser(onData);
  return {
    push: (text: string): void => sse.push(text),
    end: (): void => sse.end(),
    state,
  };
}
