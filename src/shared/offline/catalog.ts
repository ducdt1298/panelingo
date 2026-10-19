// Offline mode model catalog (docs/OFFLINE-MODE.md): the pinned Hugging Face files of the "offline" group of
// vendor/models.lock.json, as scripts/build.ts copies them into build-info.json. A file is identified by its repo,
// revision and path; the engine downloads it from https://huggingface.co/<repo>/resolve/<revision>/<path> (or the
// dev/test base URL) and checks bytes and sha256 before using it. PURE.

export type OfflineKind = "ocr" | "mt";
/** ocr: model + dict (inference.yml) · mt: encoder + decoder (merged, with KV cache) + tokenizer + config. */
export type OfflineRole = "model" | "dict" | "encoder" | "decoder" | "tokenizer" | "config";

export interface OfflineFile {
  /** Model id, e.g. "ocr-korean", "opus-mt-ko-en", "nllb-200-distilled-600m". */
  model: string;
  kind: OfflineKind;
  role: OfflineRole;
  /** Hugging Face repository, e.g. "Xenova/opus-mt-ko-en". */
  repo: string;
  /** Full commit hash the file is pinned to. */
  revision: string;
  /** Path inside the repository, e.g. "onnx/encoder_model_quantized.onnx". */
  path: string;
  license: string;
  bytes: number;
  sha256: string;
}

export const HUGGING_FACE = "https://huggingface.co";

/** Cache Storage name of the downloaded files (the engine writes it; the options page can measure or delete it). */
export const OFFLINE_CACHE = "panelingo-offline-models-v1";

const ROLES: Readonly<Record<OfflineKind, readonly OfflineRole[]>> = {
  ocr: ["model", "dict"],
  mt: ["encoder", "decoder", "tokenizer", "config"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;

/** A repository path or name made of safe segments (no "..", no empty segment, no backslash). */
function safePath(value: string, maxSegments: number): boolean {
  const parts = value.split("/");
  return (
    parts.length >= 1 &&
    parts.length <= maxSegments &&
    parts.every((part) => SAFE_SEGMENT.test(part) && part !== "." && part !== "..")
  );
}

/** Validates the offline file list (lock file or build-info.json). Throws Error naming the bad entry. */
export function parseOfflineFiles(json: unknown): OfflineFile[] {
  if (!Array.isArray(json)) throw new Error("offline files: not a list");
  return (json as unknown[]).map((raw, index): OfflineFile => {
    const bad = (what: string): Error => new Error(`offline file ${index}: ${what}`);
    if (!isRecord(raw)) throw bad("not an object");
    const { model, kind, role, repo, revision, path, license, bytes, sha256 } = raw;
    if (typeof model !== "string" || !SAFE_SEGMENT.test(model)) throw bad("bad model id");
    if (kind !== "ocr" && kind !== "mt") throw bad("bad kind");
    if (typeof role !== "string" || !ROLES[kind].includes(role as OfflineRole)) throw bad("bad role");
    if (typeof repo !== "string" || !safePath(repo, 2) || !repo.includes("/")) throw bad("bad repo");
    if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision))
      throw bad("revision is not a commit");
    if (typeof path !== "string" || !safePath(path, 4)) throw bad("bad path");
    if (typeof license !== "string" || license === "") throw bad("no license");
    if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) throw bad("bad size");
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) throw bad("bad sha256");
    return {
      model,
      kind,
      role: role as OfflineRole,
      repo,
      revision,
      path,
      license,
      bytes: bytes as number,
      sha256,
    };
  });
}

/** Download URL: the pinned resolve URL on Hugging Face, or the same layout under a dev/test base URL. */
export function offlineFileUrl(file: OfflineFile, base: string = HUGGING_FACE): string {
  const root = base.replace(/\/+$/u, "");
  return `${root}/${file.repo}/resolve/${file.revision}/${file.path}`;
}

/** Where the file lives under .cache/offline-models (and under a local mirror): <repo>/<revision>/<path>. */
export function offlineLocalPath(file: OfflineFile): string {
  return `${file.repo}/${file.revision}/${file.path}`;
}

/** The files of one model, by role; null when the catalog lacks any role the model kind needs. */
export function modelFiles(
  files: readonly OfflineFile[],
  model: string,
): Partial<Record<OfflineRole, OfflineFile>> | null {
  const own = files.filter((file) => file.model === model);
  if (own.length === 0) return null;
  const kind = own[0]?.kind ?? "ocr";
  const byRole: Partial<Record<OfflineRole, OfflineFile>> = {};
  for (const file of own) byRole[file.role] = file;
  return ROLES[kind].every((role) => byRole[role] !== undefined) ? byRole : null;
}

/** Total download size of the given models (each file counted once). */
export function downloadBytes(files: readonly OfflineFile[], models: readonly string[]): number {
  const wanted = new Set(models);
  return files.filter((file) => wanted.has(file.model)).reduce((sum, file) => sum + file.bytes, 0);
}

/** Model ids in catalog order. */
export function catalogModels(files: readonly OfflineFile[]): string[] {
  return [...new Set(files.map((file) => file.model))];
}
