// Downloads the pinned detector models into .cache/models, derives the fixed ones, and verifies size + sha256.
// The build copies the shipped files from there into dist/models; binaries never go into git.
//
//   node scripts/fetch-models.ts            fetch/derive missing files, trust existing .sha256 sidecars
//   node scripts/fetch-models.ts --verify   re-hash every cached file
//   node scripts/fetch-models.ts --optional also fetch models marked optional in the lock file
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./lib/hash.ts";
import { readModelsLock, type ModelEntry } from "./lib/models.ts";
import { stripValueInfo } from "./lib/onnx-strip.ts";
import { CACHE_MODELS, rel } from "./lib/paths.ts";

const flags = new Set(process.argv.slice(2));
const verifyAll = flags.has("--verify");
const includeOptional = flags.has("--optional");

await mkdir(CACHE_MODELS, { recursive: true });
const { models } = readModelsLock();
// Downloads first, derivations after their sources.
const ordered = [
  ...models.filter((m) => m.derivedFrom === undefined),
  ...models.filter((m) => m.derivedFrom !== undefined),
];
let failures = 0;

for (const model of ordered) {
  if (model.optional === true && !includeOptional) {
    console.log(`skip     ${model.file} (optional; pass --optional to fetch)`);
    continue;
  }
  try {
    const status = await ensureModel(model);
    console.log(`${status.padEnd(8)} ${model.file} (${formatMb(model.bytes)})`);
  } catch (error) {
    failures += 1;
    console.error(`FAILED   ${model.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`${failures} model(s) failed. Nothing partial was kept in ${rel(CACHE_MODELS)}.`);
  process.exit(1);
}

async function ensureModel(model: ModelEntry): Promise<"cached" | "verified" | "fetched" | "derived"> {
  const target = path.join(CACHE_MODELS, model.file);
  const sidecar = `${target}.sha256`;

  if (existsSync(target) && (await stat(target)).size === model.bytes) {
    if (!verifyAll && existsSync(sidecar) && (await readFile(sidecar, "utf8")).trim() === model.sha256) {
      return "cached";
    }
    const actual = await sha256File(target);
    if (actual === model.sha256) {
      await writeFile(sidecar, `${model.sha256}\n`);
      return "verified";
    }
    console.warn(`hash mismatch for cached ${model.file}; rebuilding it`);
  }

  if (model.derivedFrom !== undefined) {
    await derive(model, target);
    await writeFile(sidecar, `${model.sha256}\n`);
    return "derived";
  }
  await download(model, target);
  await writeFile(sidecar, `${model.sha256}\n`);
  return "fetched";
}

/** Applies the entry's deterministic transform to its (already verified) source file. */
async function derive(model: ModelEntry, target: string): Promise<void> {
  const source = models.find((m) => m.id === model.derivedFrom);
  if (source === undefined) {
    throw new Error(`derivedFrom ${model.derivedFrom} is not in the lock file`);
  }
  const sourcePath = path.join(CACHE_MODELS, source.file);
  if (!existsSync(sourcePath) || (await sha256File(sourcePath)) !== source.sha256) {
    throw new Error(`source ${source.file} is missing or does not match its pinned sha256`);
  }
  if (model.transform !== "strip-value-info") {
    throw new Error(`unknown transform ${String(model.transform)}`);
  }
  const { bytes, removedValueInfo } = stripValueInfo(new Uint8Array(await readFile(sourcePath)));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== model.bytes || actual !== model.sha256) {
    throw new Error(
      `derived ${model.file} is ${bytes.length} B sha256 ${actual}, expected ${model.bytes} B ${model.sha256}`,
    );
  }
  const partial = `${target}.part`;
  await writeFile(partial, bytes);
  await rename(partial, target);
  console.log(`  ${model.file}: removed ${removedValueInfo} value_info entries from ${source.file}`);
}

async function download(model: ModelEntry, target: string): Promise<void> {
  if (model.url === undefined) {
    throw new Error(`${model.file} has no url`);
  }
  const partial = `${target}.part`;
  await rm(partial, { force: true });

  const response = await fetch(model.url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`HTTP ${response.status} for ${model.url}`);
  }

  const hash = createHash("sha256");
  const out = createWriteStream(partial);
  let received = 0;
  let nextReport = 0.1;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.byteLength;
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
      if (received / model.bytes >= nextReport) {
        process.stdout.write(`  ${model.file}: ${Math.round((received / model.bytes) * 100)}%\n`);
        nextReport += 0.1;
      }
    }
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
  } catch (error) {
    out.destroy();
    await rm(partial, { force: true });
    throw error;
  }

  const actual = hash.digest("hex");
  if (received !== model.bytes || actual !== model.sha256) {
    await rm(partial, { force: true });
    throw new Error(
      `integrity check failed: got ${received} B sha256 ${actual}, expected ${model.bytes} B ${model.sha256}`,
    );
  }
  await rename(partial, target);
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
