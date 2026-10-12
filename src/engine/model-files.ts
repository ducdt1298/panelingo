// Detector model files, fetched and verified at build time and shipped in the package (docs/DEVELOPMENT.md).
//
// scripts/build.ts writes build-info.json = {buildId, mode, ort, models: [{file, sha256, bytes}]}. Every load checks
// the byte length; the sha256 (crypto.subtle) is checked once per build and remembered in the models store, so later
// engine starts of the same build skip hashing ~41 MB. Any mismatch, a missing entry or an unreadable file is
// detector.model_integrity: the package is broken and only a rebuild fixes it (fetch-models + build).

import type { Logger } from "../platform/log.ts";
import { CtvError, errorMessage } from "../shared/errors.ts";
import { toHex } from "../shared/ids.ts";
import type { ModelIntegrityRecord } from "../shared/records.ts";
import type { ModelStore } from "./contracts.ts";

export const BUILD_INFO_PATH = "build-info.json";
export const MODELS_DIR = "models";

export interface ModelEntry {
  file: string;
  sha256: string;
  bytes: number;
}

export interface BuildInfo {
  buildId: string;
  mode: string;
  /** onnxruntime-web version bundled by the build. */
  ort: string;
  models: ModelEntry[];
}

/** The part of a fetch Response this module and the detector use (extension package files). */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export interface ModelFilesDeps {
  /** chrome.runtime.getURL. */
  getURL(path: string): string;
  fetch: FetchLike;
  store: ModelStore;
  /** Epoch ms for ModelIntegrityRecord.verifiedAt. */
  now(): number;
  log?: Logger;
  /** Lowercase hex sha256; default crypto.subtle. */
  sha256?: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
}

export interface ModelFiles {
  /** build-info.json, read once (a failed read is retried on the next call). */
  buildInfo(): Promise<BuildInfo>;
  /** The build-info entry of `file`. */
  entry(file: string): Promise<ModelEntry>;
  /** Bytes of models/<file> after the integrity checks. The caller drops them once the session exists. */
  load(file: string): Promise<Uint8Array<ArrayBuffer>>;
}

function integrity(message: string, file: string, cause?: unknown): CtvError {
  return new CtvError("detector.model_integrity", message, { detail: file, cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates build-info.json. Throws detector.model_integrity when it is malformed. */
export function parseBuildInfo(json: unknown): BuildInfo {
  const bad = (what: string): CtvError => integrity(`${BUILD_INFO_PATH}: ${what}`, BUILD_INFO_PATH);
  if (!isRecord(json)) throw bad("not an object");
  const { buildId, mode, ort, models } = json;
  if (typeof buildId !== "string" || buildId === "") throw bad("no buildId");
  if (typeof ort !== "string") throw bad("no ort version");
  if (!Array.isArray(models)) throw bad("no models list");
  const entries = (models as unknown[]).map((m, i): ModelEntry => {
    if (
      !isRecord(m) ||
      typeof m["file"] !== "string" ||
      m["file"] === "" ||
      typeof m["sha256"] !== "string" ||
      !/^[0-9a-f]{64}$/.test(m["sha256"]) ||
      !Number.isSafeInteger(m["bytes"]) ||
      (m["bytes"] as number) <= 0
    ) {
      throw bad(`malformed model entry ${i}`);
    }
    return { file: m["file"], sha256: m["sha256"], bytes: m["bytes"] as number };
  });
  return { buildId, mode: typeof mode === "string" ? mode : "", ort, models: entries };
}

/** Lowercase hex sha256 via crypto.subtle (offscreen document and Node 24 alike). */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

export function createModelFiles(deps: ModelFilesDeps): ModelFiles {
  const hash = deps.sha256 ?? sha256Hex;
  /** `${buildId}:${file}` verified by this engine instance. */
  const verified = new Set<string>();
  let info: Promise<BuildInfo> | null = null;

  async function fetchOk(path: string, file: string): Promise<FetchResponseLike> {
    let response: FetchResponseLike;
    try {
      response = await deps.fetch(deps.getURL(path));
    } catch (error) {
      throw integrity(`${path}: ${errorMessage(error)}`, file, error);
    }
    if (!response.ok) throw integrity(`${path}: HTTP ${response.status}`, file);
    return response;
  }

  async function readBuildInfo(): Promise<BuildInfo> {
    const response = await fetchOk(BUILD_INFO_PATH, BUILD_INFO_PATH);
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw integrity(`${BUILD_INFO_PATH}: ${errorMessage(error)}`, BUILD_INFO_PATH, error);
    }
    return parseBuildInfo(json);
  }

  function buildInfo(): Promise<BuildInfo> {
    if (info === null) {
      const reading = readBuildInfo();
      info = reading;
      void reading.catch(() => {
        if (info === reading) info = null;
      });
    }
    return info;
  }

  async function entry(file: string): Promise<ModelEntry> {
    const found = (await buildInfo()).models.find((m) => m.file === file);
    if (found === undefined) throw integrity(`${file} is not listed in ${BUILD_INFO_PATH}`, file);
    return found;
  }

  /** The store says this exact file was hashed for this build. Store errors only cost a re-hash. */
  async function verifiedBefore(file: string, expected: ModelEntry, buildId: string): Promise<boolean> {
    if (verified.has(`${buildId}:${file}`)) return true;
    let record: ModelIntegrityRecord | undefined;
    try {
      record = await deps.store.get(file);
    } catch (error) {
      deps.log?.warn("models store read failed", { file, message: errorMessage(error) }, "store.io");
      return false;
    }
    return (
      record !== undefined &&
      record.ok &&
      record.verifiedForBuild === buildId &&
      record.sha256 === expected.sha256 &&
      record.bytes === expected.bytes
    );
  }

  async function remember(record: ModelIntegrityRecord): Promise<void> {
    try {
      await deps.store.put(record);
    } catch (error) {
      deps.log?.warn(
        "models store write failed",
        { file: record.file, message: errorMessage(error) },
        "store.io",
      );
    }
  }

  async function load(file: string): Promise<Uint8Array<ArrayBuffer>> {
    const { buildId } = await buildInfo();
    const expected = await entry(file);
    const response = await fetchOk(`${MODELS_DIR}/${file}`, file);
    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      throw integrity(`${file}: ${errorMessage(error)}`, file, error);
    }
    if (buffer.byteLength !== expected.bytes) {
      throw integrity(`${file}: ${buffer.byteLength} bytes, expected ${expected.bytes}`, file);
    }
    const bytes = new Uint8Array(buffer);
    if (await verifiedBefore(file, expected, buildId)) {
      verified.add(`${buildId}:${file}`);
      return bytes;
    }
    const actual = await hash(bytes);
    const ok = actual === expected.sha256;
    await remember({
      file,
      sha256: actual,
      bytes: buffer.byteLength,
      verifiedForBuild: buildId,
      ok,
      verifiedAt: deps.now(),
    });
    if (!ok) {
      throw integrity(
        `${file}: sha256 ${actual.slice(0, 12)}… expected ${expected.sha256.slice(0, 12)}…`,
        file,
      );
    }
    verified.add(`${buildId}:${file}`);
    deps.log?.info("model verified", { file, bytes: buffer.byteLength, build: buildId });
    return bytes;
  }

  return { buildInfo, entry, load };
}
