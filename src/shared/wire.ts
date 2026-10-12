// Wire format helpers and codec negotiation for chrome.runtime messaging. Every Chrome messaging channel preserves
// ArrayBuffer under message_serialization "structured_clone"; the probe handshake stays as a guard and base64
// remains the fallback codec. PURE.

import type { Bytes, Codec } from "./types.ts";

export const WIRE_SOFT_LIMIT = 8 * 1024 * 1024;
export const WIRE_HARD_LIMIT = 32 * 1024 * 1024;
/** Hard limit when the base64 codec is in use (structured clone was not available on the channel). */
export const WIRE_HARD_LIMIT_B64 = 8 * 1024 * 1024;

const PROBE_BYTES = [0xc7, 0x7e, 0x01] as const;

/** A 3-byte ArrayBuffer whose survival tells whether the channel uses structured clone. */
export function makeProbe(): ArrayBuffer {
  return Uint8Array.from(PROBE_BYTES).buffer;
}

export function isProbe(value: unknown): boolean {
  if (Object.prototype.toString.call(value) !== "[object ArrayBuffer]") return false;
  const bytes = new Uint8Array(value as ArrayBuffer);
  return bytes.length === PROBE_BYTES.length && PROBE_BYTES.every((b, i) => bytes[i] === b);
}

/** Codec to use after a hello: structured clone only if the peer's probe arrived as the exact ArrayBuffer. */
export function codecFromProbe(probe: unknown): Codec {
  return isProbe(probe) ? "sc" : "b64";
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 (with padding) of the bytes; written without btoa so it is identical in Node and Chrome. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`;
  }
  return out;
}

const B64_INDEX: ReadonlyMap<string, number> = new Map([...B64].map((c, i) => [c, i]));

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+/g, "");
  if (clean.length % 4 === 1) throw new Error("invalid base64 length");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const values = [0, 1, 2, 3].map((k) => {
      const ch = clean[i + k];
      if (ch === undefined) return -1;
      const v = B64_INDEX.get(ch);
      if (v === undefined) throw new Error(`invalid base64 character ${JSON.stringify(ch)}`);
      return v;
    });
    const [a, b, c, d] = values as [number, number, number, number];
    const n = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    out[o++] = (n >> 16) & 255;
    if (c >= 0) out[o++] = (n >> 8) & 255;
    if (d >= 0) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

/** Encode an ArrayBuffer for a channel with the given codec. */
export function encodeBytes(buffer: ArrayBuffer, codec: Codec): Bytes {
  return codec === "sc" ? buffer : { b64: toBase64(new Uint8Array(buffer)) };
}

/** Decode a Bytes value received on any channel (either form is accepted). */
export function decodeBytes(value: Bytes): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  const bytes = fromBase64(value.b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function isBytes(value: unknown): value is Bytes {
  return (
    value instanceof ArrayBuffer ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as { b64?: unknown }).b64 === "string" &&
      Object.keys(value).length === 1)
  );
}

/** Rough wire size: JSON text length plus binary payloads (base64 inflates by 4/3). */
export function estimateWireBytes(message: unknown, codec: Codec): number {
  let binary = 0;
  const json = JSON.stringify(message, (_key, value: unknown) => {
    if (value instanceof ArrayBuffer) {
      binary += codec === "b64" ? Math.ceil((value.byteLength * 4) / 3) : value.byteLength;
      return 0;
    }
    if (ArrayBuffer.isView(value)) {
      binary += codec === "b64" ? Math.ceil((value.byteLength * 4) / 3) : value.byteLength;
      return 0;
    }
    return value;
  });
  return (json === undefined ? 0 : json.length) + binary;
}

export function hardLimitFor(codec: Codec): number {
  return codec === "sc" ? WIRE_HARD_LIMIT : WIRE_HARD_LIMIT_B64;
}

export type WireCheck = { ok: true } | { ok: false; path: string; why: string };

/**
 * Wire-safe = plain JSON values plus Bytes. Rejects undefined, Map, Set, Date, BigInt, functions and class
 * instances, which behave differently under JSON and structured clone.
 */
export function isWireSafe(message: unknown, path = "$"): WireCheck {
  if (message === null) return { ok: true };
  switch (typeof message) {
    case "string":
    case "boolean":
      return { ok: true };
    case "number":
      return Number.isFinite(message) ? { ok: true } : { ok: false, path, why: "non-finite number" };
    case "undefined":
      return { ok: false, path, why: "undefined" };
    case "bigint":
      return { ok: false, path, why: "bigint" };
    case "function":
    case "symbol":
      return { ok: false, path, why: typeof message };
    case "object":
      break;
  }
  if (message instanceof ArrayBuffer) return { ok: true };
  if (Array.isArray(message)) {
    for (let i = 0; i < message.length; i += 1) {
      const check = isWireSafe(message[i], `${path}[${i}]`);
      if (!check.ok) return check;
    }
    return { ok: true };
  }
  const proto: unknown = Object.getPrototypeOf(message);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, path, why: Object.prototype.toString.call(message) };
  }
  for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
    const check = isWireSafe(value, `${path}.${key}`);
    if (!check.ok) return check;
  }
  return { ok: true };
}
