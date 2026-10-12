# Recorded chat streams (`*.sse`)

Raw response bodies of `POST /v1/chat/completions` with `stream: true`, recorded from an OpenAI-compatible endpoint
serving gpt-5.2 (its chunks report the model as `azure-gpt-5.2`). Every request was built from the synthetic
fixtures in `test/fixtures/generated` (shapes and sentences written for this project); never record transcripts of
real comic pages.

| File part      | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `gpt52-<nnn>-` | model and recording number                                                                |
| `<case>`       | what was sent: `page-ko-p01` (one Korean page), `marks-20-a` (20 numbered marks), ...     |
| `.sse`         | the body exactly as received                                                              |
| `.meta.json`   | the same request's status, response headers, network chunk arrival times and timing summary |

`.meta.json` fields: `case`, `model`, `startedAt`, `status`, `responseHeaders`, `complete` (`data: [DONE]` arrived),
`chunks` (`[ms since the request was sent, bytes]` per network chunk), `timing` (`tHeaders`, `tFirstContent`,
`tFirstItem`, `tLastItem`, `tDone`, in ms since the request was sent; null when not reached) and `error`.

All 17 streams are complete. They show real-world details a client must handle: the role chunk carries no `content`,
content arrives in deltas of a few characters that split lines across chunks, and the usage chunk (`choices: []`)
comes **before** the finish chunk, unlike OpenAI, which sends it after.

## Byte-exact

A transcript is the body exactly as received: `data: <json>` frames separated by blank lines, LF line ends, ending
with `data: [DONE]`. Do not reformat, re-indent or convert line ends:

- `.gitattributes` marks `*.sse` as `-text`, so git never converts LF/CRLF (parser tests depend on the exact bytes,
  including any hand-made CRLF variants);
- `.prettierignore` excludes this folder.

## How they are used

- **Parser tests** (`src/shared/core/sse` and the line parser) split each transcript at every byte offset.
- **Mock replay**: start the mock server (`tools/mock-openai`) with `replayDir` pointing here and set `replayFile`:

  ```ts
  const mock = await createMockServer({ replayDir: "test/fixtures/sse" });
  mock.setScenario({ replayFile: "gpt52-020-page-ko-p01.sse", headersDelayMs: 2000, chunkDelayMs: 50 });
  ```

  or `npm run mock-api -- --replay-dir test/fixtures/sse --scenario '{"replayFile":"gpt52-020-page-ko-p01.sse"}'`.
  The mock writes the bytes unchanged, one write (one HTTP chunk) per recorded frame. The frames before the first
  content frame go out with the headers after `headersDelayMs` (or with the first content frame when `lateHeaders`
  is set), `firstChunkDelayMs` plus the sampled T0 of a `latencyProfile` precede the first content frame,
  `chunkDelayMs` separates content frames, and the frames after the last one follow at once. `dropAfterChunks: k`
  ends the stream right after the `k`-th content frame, `resetAfterChunks: k` drops the connection there, and
  `errorFrame` sends an in-stream error object there. A `stream: false` request gets the concatenated
  `delta.content` as one JSON completion. The `.meta.json` timings are not replayed.

## Adding a recording

Save the raw body of a streamed request built from the synthetic fixtures as `gpt52-<nnn>-<case>.sse` (or another
model prefix) without touching its bytes, and write the matching `.meta.json` with the fields above.
