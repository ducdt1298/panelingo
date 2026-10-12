import { readFileSync } from "node:fs";
import path from "node:path";
import { VENDOR } from "./paths.ts";

/** Deterministic transforms that derive a shipped model from a downloaded one. */
export type ModelTransform = "strip-value-info";

/** One pinned detector file from vendor/models.lock.json. */
export interface ModelEntry {
  id: string;
  file: string;
  role: string;
  license: string;
  bytes: number;
  sha256: string;
  /** Download URL (pinned commit). Absent for derived files. */
  url?: string;
  /** Derived files: id of the source entry and the transform applied to it. */
  derivedFrom?: string;
  transform?: ModelTransform;
  /** false = only an input to a derivation; not copied into dist. Default true. */
  ship?: boolean;
  /** Optional models are only fetched with --optional and never required by the build. */
  optional?: boolean;
}

export interface ModelsLock {
  models: ModelEntry[];
}

export function readModelsLock(): ModelsLock {
  const raw: unknown = JSON.parse(readFileSync(path.join(VENDOR, "models.lock.json"), "utf8"));
  if (!isModelsLock(raw)) {
    throw new Error("vendor/models.lock.json is malformed");
  }
  return raw;
}

export function shippedModels(lock: ModelsLock): ModelEntry[] {
  return lock.models.filter((m) => m.ship !== false && m.optional !== true);
}

function isModelsLock(value: unknown): value is ModelsLock {
  if (typeof value !== "object" || value === null || !("models" in value) || !Array.isArray(value.models)) {
    return false;
  }
  return value.models.every(
    (m: unknown) =>
      typeof m === "object" &&
      m !== null &&
      "file" in m &&
      typeof m.file === "string" &&
      (("url" in m && typeof m.url === "string") ||
        ("derivedFrom" in m && typeof m.derivedFrom === "string")) &&
      "bytes" in m &&
      typeof m.bytes === "number" &&
      "sha256" in m &&
      typeof m.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(m.sha256),
  );
}
