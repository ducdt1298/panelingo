// Typed wrapper around chrome.runtime.Port: post() never throws (the raw postMessage throws on a disconnected port;
// post() returns false instead), messages are size-checked against the wire limits, request/response pairs carry a
// ReqId and a timeout, and each side tracks the negotiated codec.

import { CtvError } from "../shared/errors.ts";
import { newReqId } from "../shared/ids.ts";
import type { PortMsg } from "../shared/protocol.ts";
import type { Codec } from "../shared/types.ts";
import { WIRE_SOFT_LIMIT, estimateWireBytes, hardLimitFor } from "../shared/wire.ts";
import type { Logger } from "./log.ts";

export interface TypedPort<In, Out> {
  readonly raw: chrome.runtime.Port;
  codec: Codec;
  /** False when the port is gone or the message is over the hard limit. Never throws. */
  post(message: PortMsg<Out>): boolean;
  /** Subscribe to one message type; returns an unsubscribe function. */
  on<K extends keyof In & string>(
    type: K,
    handler: (message: { readonly type: K } & In[K]) => void,
  ): () => void;
  /** Sends a message carrying a fresh reqId and resolves with the first reply of the listed types with that reqId. */
  request<K extends keyof Out & string, R extends keyof In & string>(
    type: K,
    body: Omit<Out[K], "reqId">,
    reply: readonly R[],
    timeoutMs: number,
  ): Promise<{ readonly type: R } & In[R]>;
  onClose(handler: (lastError: string | null) => void): void;
  readonly closed: boolean;
  close(): void;
}

export interface WrapOptions {
  ctx: string;
  log: Logger;
  codec?: Codec;
}

export function wrapPort<In, Out>(raw: chrome.runtime.Port, options: WrapOptions): TypedPort<In, Out> {
  const handlers = new Map<string, Set<(message: never) => void>>();
  const closeHandlers: Array<(lastError: string | null) => void> = [];
  let closed = false;

  const finish = (lastError: string | null): void => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) {
      try {
        handler(lastError);
      } catch (error) {
        options.log.warn("port close handler threw", { ctx: options.ctx, error: String(error) });
      }
    }
    handlers.clear();
  };

  raw.onMessage.addListener((message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const type = (message as { type?: unknown }).type;
    if (typeof type !== "string") return;
    const set = handlers.get(type);
    if (set === undefined) return;
    for (const handler of [...set]) {
      try {
        handler(message as never);
      } catch (error) {
        options.log.warn("port handler threw", { ctx: options.ctx, type, error: String(error) });
      }
    }
  });
  raw.onDisconnect.addListener(() => {
    finish(chrome.runtime.lastError?.message ?? null);
  });

  const port: TypedPort<In, Out> = {
    raw,
    codec: options.codec ?? "sc",
    get closed() {
      return closed;
    },
    post(message) {
      if (closed) return false;
      const size = estimateWireBytes(message, port.codec);
      if (size > hardLimitFor(port.codec)) {
        options.log.warn("message over the hard limit dropped", {
          ctx: options.ctx,
          type: message.type,
          size,
        });
        return false;
      }
      if (size > WIRE_SOFT_LIMIT) {
        options.log.warn("message over the soft limit", { ctx: options.ctx, type: message.type, size });
      }
      try {
        raw.postMessage(message);
        return true;
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    on(type, handler) {
      let set = handlers.get(type);
      if (set === undefined) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
    request(type, body, reply, timeoutMs) {
      const reqId = newReqId(options.ctx);
      return new Promise((resolve, reject) => {
        const unsubscribers: Array<() => void> = [];
        const done = (): void => {
          clearTimeout(timer);
          for (const off of unsubscribers) off();
        };
        const timer = setTimeout(() => {
          done();
          reject(new CtvError("engine.protocol", `${type}: no reply within ${timeoutMs} ms`));
        }, timeoutMs);
        for (const replyType of reply) {
          unsubscribers.push(
            port.on(replyType, (message) => {
              if ((message as { reqId?: unknown }).reqId !== reqId) return;
              done();
              resolve(message);
            }),
          );
        }
        port.onClose(() => {
          done();
          reject(new CtvError("engine.closing", `${type}: port closed`));
        });
        const sent = port.post({ ...(body as object), type, reqId } as unknown as PortMsg<Out>);
        if (!sent) {
          done();
          reject(new CtvError("engine.closing", `${type}: could not post`));
        }
      });
    },
    onClose(handler) {
      if (closed) {
        handler(null);
        return;
      }
      closeHandlers.push(handler);
    },
    close() {
      if (closed) return;
      try {
        raw.disconnect();
      } catch {
        // already gone
      }
      finish(null);
    },
  };
  return port;
}
