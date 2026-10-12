import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createChatStreamDecoder, createSseParser } from "../../../src/shared/core/sse.ts";

// A transcript shaped like an OpenAI-compatible proxy stream: role, content deltas cut mid-line and mid-character,
// usage with choices [], finish, [DONE]. Sentences and names are made up for this test.
const ENVELOPE = {
  id: "chatcmpl-1760000000000-k3x9q2m1z",
  object: "chat.completion.chunk",
  created: 1760000000,
  model: "azure-gpt-5.2",
};
const DELTAS = [
  "@lang|ko\n#1|dia",
  "logue|Zorvik|비가 와",
  "요|Trời mưa rồi.\n#2|thought||우산이 없",
  "어|Mình không có ô...\n#3|sfx||쾅|RẦM!\n#4|sign||Plimba 가게|Tiệm Plimba\n",
  "@term|Plimba|Plimba|tên tiệm bánh\n",
];
const CONTENT = DELTAS.join("");
const USAGE = { prompt_tokens: 1310, completion_tokens: 52, total_tokens: 1362 };

function frame(choices: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...ENVELOPE, choices, ...extra });
}

const PAYLOADS = [
  frame([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]),
  ...DELTAS.map((content) => frame([{ index: 0, delta: { content }, finish_reason: null }])),
  frame([], { usage: USAGE }),
  frame([{ index: 0, delta: {}, finish_reason: "stop" }]),
  "[DONE]",
];

function transcript(eol: string, payloads: readonly string[] = PAYLOADS): string {
  return payloads.map((payload) => `data: ${payload}${eol}${eol}`).join("");
}

/** Decodes `bytes` cut at `cuts` with a streaming TextDecoder, as the client does. */
function textChunks(bytes: Uint8Array, cuts: readonly number[]): string[] {
  const decoder = new TextDecoder();
  const out: string[] = [];
  let start = 0;
  for (const cut of [...cuts, bytes.length]) {
    out.push(decoder.decode(bytes.subarray(start, cut), { stream: true }));
    start = cut;
  }
  out.push(decoder.decode());
  return out;
}

function parse(chunks: readonly string[]): string[] {
  const data: string[] = [];
  const parser = createSseParser((payload) => data.push(payload));
  for (const chunk of chunks) {
    parser.push(chunk);
  }
  parser.end();
  return data;
}

/** mulberry32: small seeded PRNG for reproducible fuzzing. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("createSseParser", () => {
  for (const [name, eol] of [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ] as const) {
    test(`${name}: a split at every byte offset yields the same frames`, () => {
      const bytes = new TextEncoder().encode(transcript(eol));
      assert.deepEqual(parse(textChunks(bytes, [])), PAYLOADS);
      for (let cut = 0; cut <= bytes.length; cut += 1) {
        assert.deepEqual(parse(textChunks(bytes, [cut])), PAYLOADS, `cut at byte ${cut}`);
      }
    });

    test(`${name}: byte-by-byte and random multi-splits yield the same frames`, () => {
      const bytes = new TextEncoder().encode(transcript(eol));
      const everyByte = Array.from({ length: bytes.length }, (_, i) => i);
      assert.deepEqual(parse(textChunks(bytes, everyByte)), PAYLOADS);
      const random = rng(1);
      for (let run = 0; run < 200; run += 1) {
        const cuts = Array.from({ length: 1 + Math.floor(random() * 12) }, () =>
          Math.floor(random() * bytes.length),
        ).sort((a, b) => a - b);
        assert.deepEqual(parse(textChunks(bytes, cuts)), PAYLOADS, `cuts ${cuts.join(",")}`);
      }
    });
  }

  test("a CR at the end of a chunk waits for a possible LF", () => {
    const data: string[] = [];
    const parser = createSseParser((payload) => data.push(payload));
    parser.push("data: a\r");
    parser.push("\n\r");
    assert.deepEqual(data, [], "CRLF + a lone CR still pending");
    parser.push("\n");
    assert.deepEqual(data, ["a"]);
    parser.push("data: b\r\r");
    assert.deepEqual(data, ["a"], "second CR may be half of CRLF");
    parser.end();
    assert.deepEqual(data, ["a", "b"], "at EOF a final CR ends its line");
  });

  test("comments and event/id/retry fields are ignored; data lines join with LF", () => {
    const text = [
      ": keepalive",
      "",
      "event: message",
      "id: 7",
      "retry: 1000",
      "data: first",
      "data:second",
      "data:  two spaces",
      "data",
      "unknown: x",
      "",
      "",
      ":only a comment",
      "",
    ].join("\n");
    assert.deepEqual(parse([text]), ["first\nsecond\n two spaces\n"]);
  });

  test("an incomplete frame at EOF is discarded", () => {
    assert.deepEqual(parse(["data: done-frame\n\ndata: half"]), ["done-frame"]);
    assert.deepEqual(parse(["data: no-blank-line\n"]), []);
  });

  test("a leading BOM is ignored and push after end is a no-op", () => {
    const data: string[] = [];
    const parser = createSseParser((payload) => data.push(payload));
    parser.push("\ufeffdata: x\n\n");
    parser.end();
    parser.push("data: y\n\n");
    parser.end();
    assert.deepEqual(data, ["x"]);
  });
});

describe("createChatStreamDecoder", () => {
  function decode(chunks: readonly string[]): { content: string; state: ReturnType<typeof snapshot> } {
    let content = "";
    const decoder = createChatStreamDecoder((text) => {
      content += text;
    });
    for (const chunk of chunks) {
      decoder.push(chunk);
    }
    decoder.end();
    return { content, state: snapshot(decoder.state) };
  }
  function snapshot(state: ReturnType<typeof createChatStreamDecoder>["state"]): typeof state {
    return { ...state };
  }

  test("proxy transcript: content in order, usage frame with choices [], finish and [DONE]", () => {
    const bytes = new TextEncoder().encode(transcript("\n"));
    for (let cut = 0; cut <= bytes.length; cut += 7) {
      const { content, state } = decode(textChunks(bytes, [cut]));
      assert.equal(content, CONTENT);
      assert.equal(state.sawDone, true);
      assert.equal(state.finishReason, "stop");
      assert.deepEqual(state.usage, USAGE);
      assert.equal(state.model, "azure-gpt-5.2");
      assert.equal(state.id, ENVELOPE.id);
      assert.equal(state.frames, PAYLOADS.length);
      assert.equal(state.invalidFrames, 0);
      assert.equal(state.error, null);
    }
  });

  test("EOF without [DONE] leaves sawDone false and keeps the content", () => {
    const payloads = PAYLOADS.slice(0, 4);
    const { content, state } = decode([transcript("\n", payloads), 'data: {"choices":[{"delta":{"con']);
    assert.equal(content, DELTAS.slice(0, 3).join(""));
    assert.equal(state.sawDone, false);
    assert.equal(state.finishReason, null);
  });

  test("invalid JSON and non-object payloads are skipped and counted", () => {
    const payloads = [
      PAYLOADS[1] ?? "",
      "{not json",
      "42",
      '["array"]',
      frame([{ index: 0, delta: { content: "#1|x" }, finish_reason: null }]),
    ];
    const { content, state } = decode([transcript("\n", payloads)]);
    assert.equal(content, `${DELTAS[0] ?? ""}#1|x`);
    assert.equal(state.invalidFrames, 3);
    assert.equal(state.frames, 5);
  });

  test("frames after [DONE] are ignored", () => {
    const payloads = [PAYLOADS[1] ?? "", "[DONE]", frame([{ index: 0, delta: { content: "late" } }])];
    const { content, state } = decode([transcript("\n", payloads)]);
    assert.equal(content, DELTAS[0]);
    assert.equal(state.sawDone, true);
    assert.equal(state.frames, 2);
  });

  test("an in-stream error object is recorded (first one wins)", () => {
    const payloads = [
      PAYLOADS[1] ?? "",
      JSON.stringify({
        error: { message: "upstream broke", type: "upstream_error", code: "upstream_sse_error" },
      }),
      JSON.stringify({ error: "second" }),
    ];
    const { state } = decode([transcript("\n", payloads)]);
    assert.deepEqual(state.error, {
      message: "upstream broke",
      type: "upstream_error",
      code: "upstream_sse_error",
    });
  });

  test("an error frame ends the stream: later frames in the same chunk deliver nothing", () => {
    const payloads = [
      frame([{ index: 0, delta: { content: "#1|dialogue||a|Một\n" }, finish_reason: null }]),
      JSON.stringify({ error: { message: "upstream broke" } }),
      frame([{ index: 0, delta: { content: "#2|dialogue||b|Hai\n" }, finish_reason: null }]),
      "[DONE]",
    ];
    const { content, state } = decode([transcript("\n", payloads)]);
    assert.equal(content, "#1|dialogue||a|Một\n");
    assert.equal(state.error?.message, "upstream broke");
    assert.equal(state.sawDone, false);
    assert.equal(state.frames, 2);
  });

  test("empty content deltas and empty data payloads are ignored", () => {
    const payloads = ["", frame([{ index: 0, delta: { content: "" }, finish_reason: null }]), "[DONE]"];
    let calls = 0;
    const decoder = createChatStreamDecoder(() => {
      calls += 1;
    });
    decoder.push(transcript("\n", payloads));
    decoder.end();
    assert.equal(calls, 0);
    assert.equal(decoder.state.frames, 2);
    assert.equal(decoder.state.sawDone, true);
  });
});

// Recorded streaming bodies (test/fixtures/sse/README.md): every transcript must decode identically however it is
// cut. A cut can only disturb the SSE event it falls in and that event's closing blank line, so each single cut is
// checked on a local window (the event holding the byte before the cut plus the next event) instead of re-decoding
// the whole body, which keeps `npm run check` fast: every offset of bodies up to 4 KiB (whole body) and of the first
// and last 4 KiB of longer ones (role, first deltas, usage, finish, [DONE]), plus 1,000 evenly spaced offsets. The
// seeded multi-cut runs decode the whole body; the synthetic transcripts above cover every offset of whole bodies.
describe("recorded transcripts (test/fixtures/sse/*.sse)", () => {
  const dir = new URL("../../fixtures/sse/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sse"))
    .sort();
  const EDGE_BYTES = 4_096;
  const SAMPLED_OFFSETS = 1_000;
  const MULTI_CUT_RUNS = 50;

  /** Offsets where an SSE event starts (0 and right after every blank line, any line ending), then the body end. */
  function eventBounds(bytes: Uint8Array): number[] {
    const bounds = [0];
    let lineEmpty = true;
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i];
      if (byte !== 0x0a && byte !== 0x0d) {
        lineEmpty = false;
        continue;
      }
      const end = byte === 0x0d && bytes[i + 1] === 0x0a ? i + 2 : i + 1;
      if (lineEmpty) bounds.push(end);
      lineEmpty = true;
      i = end - 1;
    }
    if (bounds.at(-1) !== bytes.length) bounds.push(bytes.length);
    return bounds;
  }

  /** [from, to): the event holding the byte before `cut` and the next event (all a cut there can disturb). */
  function windowAround(bounds: readonly number[], cut: number): [number, number] {
    let lo = 0;
    let hi = bounds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((bounds[mid] ?? 0) < cut) lo = mid;
      else hi = mid - 1;
    }
    return [bounds[lo] ?? 0, bounds[Math.min(lo + 2, bounds.length - 1)] ?? 0];
  }

  test("event bounds and cut windows", () => {
    const body = new TextEncoder().encode("data: a\n\ndata: b\r\n\r\ndata: c\r\rdata: d");
    const bounds = eventBounds(body);
    assert.deepEqual(bounds, [0, 9, 20, 29, 36]);
    assert.deepEqual(windowAround(bounds, 0), [0, 20]);
    assert.deepEqual(
      windowAround(bounds, 9),
      [0, 20],
      "a cut right after a blank line also checks that line",
    );
    assert.deepEqual(windowAround(bounds, 10), [9, 29]);
    assert.deepEqual(windowAround(bounds, 36), [29, 36]);
  });

  function decodeAll(chunks: readonly string[]): { content: string; state: string } {
    let content = "";
    const decoder = createChatStreamDecoder((text) => {
      content += text;
    });
    for (const chunk of chunks) {
      decoder.push(chunk);
    }
    decoder.end();
    return { content, state: JSON.stringify(decoder.state) };
  }

  test("the transcript folder exists", () => {
    assert.ok(Array.isArray(files));
  });

  for (const name of files) {
    test(`${name}: every cut decodes identically`, () => {
      const bytes = new Uint8Array(readFileSync(new URL(name, dir)));
      const whole = decodeAll(textChunks(bytes, []));
      const short = bytes.length <= EDGE_BYTES;
      const bounds = eventBounds(bytes);
      const cuts = new Set<number>();
      for (let cut = 0; cut <= Math.min(EDGE_BYTES, bytes.length); cut += 1) cuts.add(cut);
      for (let cut = Math.max(0, bytes.length - EDGE_BYTES); cut <= bytes.length; cut += 1) cuts.add(cut);
      for (let i = 0; i < SAMPLED_OFFSETS; i += 1) {
        cuts.add(Math.floor((i * bytes.length) / (SAMPLED_OFFSETS - 1)));
      }
      const windows = new Map<number, { content: string; state: string }>();
      for (const cut of cuts) {
        const [from, to] = short ? [0, bytes.length] : windowAround(bounds, cut);
        const piece = bytes.subarray(from, to);
        let expected = short ? whole : windows.get(from);
        if (expected === undefined) {
          expected = decodeAll(textChunks(piece, []));
          windows.set(from, expected);
        }
        assert.deepEqual(decodeAll(textChunks(piece, [cut - from])), expected, `cut at byte ${cut}`);
      }
      const random = rng(bytes.length);
      for (let run = 0; run < MULTI_CUT_RUNS; run += 1) {
        const cuts = Array.from({ length: 1 + Math.floor(random() * 40) }, () =>
          Math.floor(random() * bytes.length),
        ).sort((a, b) => a - b);
        assert.deepEqual(decodeAll(textChunks(bytes, cuts)), whole, `cuts ${cuts.join(",")}`);
      }
    });
  }
});
