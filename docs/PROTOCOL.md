# Messaging protocol

Every message between the content scripts, the service worker, the offscreen engine and the extension pages is typed
in [`src/shared/protocol.ts`](../src/shared/protocol.ts). The rules below keep that traffic safe across service-worker
restarts, extension reloads and orphaned content scripts. Rules marked with ESLint are enforced in
[`eslint.config.js`](../eslint.config.js).

For the bigger picture see [ARCHITECTURE.md](ARCHITECTURE.md#messaging).

## Channels

| Channel                                                      | Direction                           | Message prefix                                       |
| ------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------- |
| `chrome.runtime.sendMessage` to the service worker           | content script, engine, pages → SW  | `sw:*` (`SwApi`)                                     |
| `chrome.runtime.sendMessage` to the engine                   | SW, pages → engine                  | `en:*` (`EngineApi`)                                 |
| `chrome.tabs.sendMessage`                                    | SW → content script                 | `cs:*` (`CsApi`)                                     |
| Port `engine` (`chrome.runtime.connect({ name: "engine" })`) | content script ⇄ engine             | `cs:*`, `img:*`, `unit:*`, `cap:*` / `en:*`, `img:*` |
| Port `ui` (`chrome.runtime.connect({ name: "ui" })`)         | popup, options, side panel ⇄ engine | `ui:*` / `en:*`, `tx:*`                              |

One-shot messages use the envelope `{ target, type, v, payload }` and resolve to
`{ ok: true, data } | { ok: false, error }`.

## Rules

| Rule   | Statement                                                                                                                                                                                                                                                         | Enforced by                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **R1** | `chrome.*` event listeners are plain, non-`async` functions. One-shot messages are received only through `onMessageFor()` in `src/platform/messaging.ts`, which ignores other targets, never throws and keeps the response channel open only when it will answer. | ESLint (`R1_ASYNC_LISTENER`, `R1_ONMESSAGE`; only `messaging.ts` may touch `runtime.onMessage`) |
| **R2** | Replies are `Reply<T>`. Errors travel as `ErrorInfo` values, and callers only ever see a `CtvError`, never a raw `chrome.runtime.lastError` string.                                                                                                               | `src/platform/messaging.ts`, types                                                              |
| **R3** | Only the engine (`src/engine/main.ts`) listens to `runtime.onConnect`, and only for the port names `engine` and `ui`. Any other port is ignored and never disconnected.                                                                                           | ESLint (`R3_ONCONNECT`)                                                                         |
| **R4** | Every `port.postMessage` goes through `safePost`/`TypedPort.post`, which never throws. A post to a closed port returns `false`.                                                                                                                                   | `src/platform/port.ts`                                                                          |
| **R5** | Every receiver checks the sender. For example, content scripts may only ask the service worker for the engine and record privacy consent, and only the service worker may push settings to the engine or close it.                                                | `src/sw/router.ts`, `src/engine/ready-gate.ts`                                                  |
| **R6** | Payloads are wire-safe: plain objects, arrays, primitives and `ArrayBuffer`s. Class instances behave differently under JSON and structured clone, so they are not allowed.                                                                                        | `src/shared/wire.ts`, the strict-wire mode of the test fake                                     |
| **R7** | Size limits: 8 MiB soft, 32 MiB hard with structured clone, 8 MiB hard with the base64 fallback. An over-limit post is refused, not truncated.                                                                                                                    | `src/shared/wire.ts`, `src/platform/port.ts`                                                    |
| **R8** | No `blob:` or `data:` URLs cross contexts (Chrome blocks extension `blob:` URLs in pages since Chrome 137). Send the bytes and draw them on a canvas.                                                                                                             | Review, types (`Bytes`)                                                                         |
| **R9** | Every envelope and hello carries `PROTOCOL_VERSION` (`src/shared/versions.ts`). A mismatch is logged, and a content script that cannot speak the engine's version gives up cleanly with `engine.protocol`.                                                        | `src/shared/protocol.ts`, `src/content/engine-client.ts`                                        |

## Codec negotiation

The manifest sets `message_serialization: "structured_clone"`, which Chrome 148 introduced. Each side sends a 3-byte
`ArrayBuffer` probe in its hello (`cs:hello`, `ui:hello`, `en:hello`):

- If the probe arrives as the exact `ArrayBuffer`, the channel uses structured clone (`"sc"`).
- Otherwise both sides switch to base64 (`"b64"`). The content script announces this with `cs:codec`.

## Timeouts

One-shot calls time out after 10 s to the service worker (15 s for `sw:ensure-engine`), 5 s to the engine and 3 s to a
tab. Port requests carry a `reqId` and a per-call timeout. A content-script frame keeps its engine-side state for 60 s
after a disconnect, so a quick service-worker or port restart does not lose work.

## Changing the protocol

1. Add or change the type in `src/shared/protocol.ts`. Keep payloads wire-safe (R6).
2. Handle the message in exactly one context and extend the sender allow-list (R5) when a new sender is involved.
3. Bump `PROTOCOL_VERSION` when an existing message changes shape.
4. Cover the change with a test that uses the Chrome fake (`test/support/chrome-fake.ts`), which delivers messages
   asynchronously, clones payloads and rejects non-wire-safe values. See [TESTING.md](TESTING.md).
