# Mock OpenAI-compatible API (`tools/mock-openai`)

A local stand-in for an OpenAI-compatible vision chat API (`/v1/models`, `/v1/chat/completions`) for unit and
integration tests, E2E runs and offline demos. Plain `node:http`, no dependencies. It never calls a real model: it
answers in the extension's line protocol with placeholder lines, ground-truth lines (oracle mode) or a recorded
stream, and every failure a real endpoint can produce is a scenario knob.

## Quick start

```sh
npm run mock-api                      # node tools/mock-openai/cli.ts --port 4925
npm run mock-api -- --api-key sk-demo --gt-dir test/fixtures/generated --replay-dir test/fixtures/sse
node tools/mock-openai/cli.ts --help
```

Then, in the extension's settings: **Base URL** `http://127.0.0.1:4925/v1`, **Model** `mock-vision` (or `--model`),
**API key** empty (or the `--api-key` value). Without ground truth the mock reads N from the prompt
("N = 16") and answers `#1`…`#N` with placeholder lines; test builds of the extension also send `x-ctv-test-units`,
which lets the mock answer from the fixtures' ground truth (`--gt-dir`).

In tests, start it in-process on an ephemeral port:

```ts
import { createMockServer } from "../../tools/mock-openai/server.ts";

const mock = await createMockServer({ port: 0, model: "mock-vision", apiKey: "sk-test" });
// client base URL: mock.baseUrl (= `${mock.url}/v1`)
mock.setScenario({ sequence: [{ failBeforeHeaders: "rate_limit" }], chunkDelayMs: 20 });
// ... run the code under test ...
mock.requests(); // what arrived, how it was answered
mock.reset(); // forget requests, back to the initial scenario
await mock.close();
```

Options: `host` (127.0.0.1), `port` (0 = any; the CLI uses 4925), `model` (`mock-vision`), `apiKey`, `maxBodyBytes`
(50 MiB), `gtDir`, `replayDir`, `scenario`, `health`, `log`.

## Routes

| Route                          | Answer                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GET`/`HEAD /v1/models`        | `{"object":"list","data":[{"id":<model>,"object":"model","created":…,"owned_by":"mock"}]}`, or a preset     |
| `GET`/`HEAD /v1/models/<id>`   | the model object, or 404 `model_not_found`                                                                  |
| `POST /v1/chat/completions`    | `stream: true`: SSE `chat.completion.chunk` frames + `data: [DONE]`; otherwise one `chat.completion` object |
| other paths                    | 404 `Invalid URL (<METHOD> <path>)`                                                                         |
| other methods on a known route | 405 with `Allow`; `OPTIONS` gets 204 with `Allow` and **no CORS headers**                                   |

- With `apiKey`, every `/v1` route needs `Authorization: Bearer <apiKey>`; otherwise 401 `invalid_api_key`. The
  token is never recorded. `setApiKey(key)` replaces the required key at runtime (a provider rotating keys;
  `undefined` = none), and `reset()` restores the configured one.
- Every error body has the OpenAI shape `{"error":{"message","type","param","code"}}` (`param`/`code` may be null).
- The response `model` echoes the request's `model`; `/v1/models` lists the configured one.
- A stream is: the role chunk (`delta: {role: "assistant", content: ""}`), content chunks, the finish chunk
  (`finish_reason`), a usage chunk (`choices: []`) only when the request sets `stream_options.include_usage`, then
  `data: [DONE]`. Usage is estimated (about 4 characters per token, a flat 85 per image).
- Validation follows OpenAI's rules where the extension cares: `model` and a non-empty `messages` array are
  required; roles `system`, `developer`, `user`, `assistant`, `tool`; content parts `text` and `image_url` (images in
  `user` messages only; base64 data URLs of PNG, JPEG, GIF or WebP bytes, or http(s) URLs, which are recorded but
  never fetched); `temperature` 0–2; `n` must be 1. Bodies over `maxBodyBytes` get 413 `request_too_large`.
- A client that disconnects does not cancel the simulated generation (as with most providers), so `inFlight()`
  still counts it.

## Scenario

`setScenario(patch)`, the `scenario` option, `POST /__scenario` and the per-request override
`POST /v1/chat/completions?scenario=<url-encoded JSON>` all take the same fields; unknown fields are errors. Error
fields accept a `FAILURES` name or `{status, message, type?, code?, param?, body?}`; `latencyProfile` accepts a
`LATENCY_PRESETS` name.

| Field               | Default   | Effect                                                                                                     |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `name`              | `default` | label stored on every recorded request                                                                     |
| `headersDelayMs`    | 0         | wait before the response starts (stream headers, JSON completion or JSON error)                            |
| `lateHeaders`       | false     | hold the headers and the role chunk until the first content chunk, as some proxies and local servers do    |
| `firstChunkDelayMs` | 0         | wait between the headers and the first content chunk (time to first token), plus the sampled T0            |
| `chunkDelayMs`      | 0         | wait between content chunks                                                                                |
| `chunkChars`        | 16        | code points per content chunk                                                                              |
| `failBeforeHeaders` | null      | answer with this HTTP error after `headersDelayMs`                                                         |
| `dropAfterChunks`   | null      | end the stream cleanly after k content chunks: no finish chunk, no usage, no `[DONE]` (silent truncation)  |
| `resetAfterChunks`  | null      | destroy the connection after k content chunks; 0 = before the response, so `fetch()` rejects               |
| `errorFrame`        | null      | send `data: {"error":{…}}` where the stream stops (after `dropAfterChunks` or the last chunk), no `[DONE]` |
| `finishReason`      | `stop`    | `finish_reason` of the finish chunk (`length`, `content_filter`, …)                                        |
| `empty`             | false     | no content at all: role chunk, finish chunk, `[DONE]`                                                      |
| `text`              | null      | stream this exact text (line ends, fences and separators kept)                                             |
| `refusal`           | false     | `true` or a sentence: answer with a refusal instead of lines                                               |
| `garbageOnly`       | false     | prose and a code fence, no protocol line                                                                   |
| `missingIds`        | `[]`      | ids left out                                                                                               |
| `duplicateIds`      | `[]`      | ids answered twice, the second time with a different translation                                           |
| `unknownIds`        | `[]`      | extra lines with ids outside the requested set                                                             |
| `appendLines`       | `[]`      | lines added after the `#` lines (`@term\|…`, `@sum\|…`)                                                    |
| `lang`              | `ko`      | language on the `@lang` line when no ground truth says otherwise                                           |
| `lineEnding`        | `\n`      | `\n` or `\r\n` (also `lf`, `crlf`)                                                                         |
| `oracleVi`          | `safe`    | oracle translations: `safe` passes the extension's validation, `echo` is `VI:<original>`                   |
| `oracleLang`        | null      | oracle translations from the ground truth's `refs.<lang>` (verbatim) where a unit has one, e.g. `"en"`     |
| `latencyProfile`    | null      | seeded log-normal T0 and per-line gaps (see below)                                                         |
| `replayFile`        | null      | stream a recorded `.sse` file from `replayDir` byte for byte                                               |
| `sequence`          | `[]`      | per-request overrides: step k applies to the k-th chat request after `setScenario`/`reset`, then the base  |

Content precedence: `failBeforeHeaders`, `replayFile`, `empty`, `text`, `refusal`, `garbageOnly`, then generated
lines. Id faults and `appendLines` apply to generated lines. Requests rejected by validation do not consume a
`sequence` step.

When `lateHeaders` is set, a stream that stops before any content (`dropAfterChunks: 0`, an `errorFrame` cut at 0,
or an empty replay cut) is answered as an HTTP error instead: the `errorFrame`'s status and body, else 502
`bad_gateway`. A `stream: false` request that would be cut gets the same HTTP error (or the reset).

### Error presets (`FAILURES`)

| Name                 | Status | `type`                  | `code`                     |
| -------------------- | ------ | ----------------------- | -------------------------- |
| `unauthorized`       | 401    | `invalid_request_error` | `invalid_api_key`          |
| `forbidden`          | 403    | `invalid_request_error` | `permission_denied`        |
| `model_not_found`    | 404    | `invalid_request_error` | `model_not_found`          |
| `no_vision`          | 400    | `invalid_request_error` | null (image input refused) |
| `bad_request`        | 400    | `invalid_request_error` | null                       |
| `context_length`     | 400    | `invalid_request_error` | `context_length_exceeded`  |
| `content_filter`     | 400    | `invalid_request_error` | `content_filter`           |
| `too_large`          | 413    | `invalid_request_error` | `request_too_large`        |
| `rate_limit`         | 429    | `requests`              | `rate_limit_exceeded`      |
| `insufficient_quota` | 429    | `insufficient_quota`    | `insufficient_quota`       |
| `server_error`       | 500    | `server_error`          | null                       |
| `bad_gateway`        | 502    | `server_error`          | `bad_gateway`              |
| `overloaded`         | 503    | `server_error`          | `service_unavailable`      |
| `timeout`            | 504    | `server_error`          | `timeout`                  |

A custom error may set `body` to serve a non-OpenAI shape verbatim, e.g. `{"detail":"…"}` or `{"error":"…"}`.

### Readiness presets (`GET /v1/models`)

`setHealth(preset)`, the `health` option or `POST /__health` (`{"preset":"<name>"}`, or any other object, served
verbatim with 200):

| Preset            | Answer                                                      |
| ----------------- | ----------------------------------------------------------- |
| `ready`           | 200 with the configured model                               |
| `unauthorized`    | 401 `invalid_api_key`                                       |
| `no-models-route` | 404 `Invalid URL (GET /v1/models)`, like servers without it |
| `server-error`    | 500 `server_error`                                          |

### Latency

`latencyProfile: {t0P50, t0P90, tLineP50, tLineP90, seed}` draws T0 (time to the first token) and a gap before every
later answer line from log-normal distributions fitted to the given medians and 90th percentiles. The draws depend
only on the seed and the request index since `setScenario`/`reset`, so a run replays exactly. Presets: `cloud`
(about 10 s to the first token, 0.8 s per line) and `fast` (1.2 s, 0.12 s).

### Replay

`replayFile` streams a recorded transcript (path relative to `replayDir`, e.g. `test/fixtures/sse`) byte for byte,
one write per frame. The frames before the first content frame go out with the headers, `firstChunkDelayMs` (+ T0)
precedes the first content frame, `chunkDelayMs` separates content frames, and the frames after the last one follow
at once. The cut knobs count content frames. A `stream: false` request gets the concatenated `delta.content`.

## Oracle mode

The mock cannot see the image, so test builds of the extension send `x-ctv-test-units: base64(JSON [{n, src, box}])`
describing which unit each number marks. With `gtDir`, the mock maps every box to a ground-truth unit of
`<gtDir>/<src>.gt.json` (IoU ≥ 0.5 with its text box, else its bubble box; `src` may be a URL, leading route folders
are skipped) and answers `#n|<type>|<speaker>|<original>|VI:<translation>`; unmatched numbers get `#n|ignore|||`.
Both the generator's unit schema and the `comic-fixture/1` schema are read. Real providers ignore the header.

A unit may also carry reference translations in other languages, `refs: {"en": "See you at seven."}`. With the
scenario field `oracleLang` set to one of those codes, the mock answers that text verbatim (no `VI:` prefix), as a
model translating into that language would; units without it keep the `VI:` answer. `e2e/docs-shots.ts` uses this
to letter the README screenshots in English.

## Recorded requests

`requests()` (or `GET /__requests`) returns one record per request: method, path, query, selected headers, `bearer`
and `authorized`, `model`, `stream`, `temperature`, message roles and text sizes, the system text (`systemText`,
first 64 KiB of the system and developer messages, e.g. to check the requested target language), images (source, MIME type, decoded
size, sniffed format, `detail`), N, decoded test units and the oracle report, the scenario name, status, time to
headers and duration, outcome (`done`, `truncated`, `stream-error`, `error`, `reset`, `aborted`, `pending`), frames
written, error code, sampled latency, and whether the client disconnected. `maxConcurrency()` and `inFlight()` count
concurrent chat requests.

## Control routes (mock only)

| Route                                             | Effect                                                         |
| ------------------------------------------------- | -------------------------------------------------------------- |
| `GET`/`POST /__scenario`                          | read / replace the scenario                                    |
| `GET`/`POST /__health`                            | read / replace the `GET /v1/models` answer                     |
| `GET /__requests`                                 | recorded requests, `maxConcurrency`, `inFlight`                |
| `POST /__reset`                                   | forget requests and marks, initial scenario and health         |
| `GET`/`POST /__mark?id=&e=`, `GET /__marks`       | timestamped marks, plus the `/slow` runs                       |
| `GET`/`POST /slow?headersDelayMs=&bodyGapMs=&id=` | a one-word stream with controllable gaps (connection lifetime) |

## Files

| File           | Contents                                                                      |
| -------------- | ----------------------------------------------------------------------------- |
| `server.ts`    | `createMockServer`, routing, streaming, replay, recording, control routes     |
| `scenarios.ts` | scenario fields and parsing, error and readiness presets, latency, answers    |
| `request.ts`   | body reading, bearer check, request validation (`MockApiError`)               |
| `wire.ts`      | chunk and completion objects, SSE frames, usage estimates, transcript helpers |
| `oracle.ts`    | `x-ctv-test-units` decoding and ground-truth matching                         |
| `cli.ts`       | command line (`npm run mock-api`)                                             |

Not emulated: tool calls, `n > 1`, logprobs, the Responses API, CORS.
