import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives in scripts/lib/). */
export const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DIST = path.join(ROOT, "dist");
export const CACHE_MODELS = path.join(ROOT, ".cache", "models");
export const VENDOR = path.join(ROOT, "vendor");
export const NODE_MODULES = path.join(ROOT, "node_modules");

/** Path relative to the repo root with forward slashes, for logs and manifests. */
export function rel(p: string): string {
  return path.relative(ROOT, p).split(path.sep).join("/");
}
