// node scripts/build.ts [--test] [--prod] [--watch] [--verify-models] [--out=<dir>]
// (E2E against another folder: build with --out=build-<name>, then run with CTV_EXTENSION_DIR=build-<name>)
//
// Builds the unpacked extension into dist/ (or --out, a folder inside the repository that is empty or holds an
// earlier build: it is wiped first):
//   dist/sw.js (ESM, no splitting: a service worker cannot import() lazily)
//   dist/engine/{offscreen.html, main.js, chunks/*} (ESM with code splitting; ORT lands in a lazy chunk)
//   dist/content/main.js (classic IIFE content script)
//   dist/ui/{popup,options,sidepanel[,debug]}.{html,js,css} + chunks
//   dist/assets/{icons,fonts,canary}, dist/vendor/ort/<asyncify wasm>, dist/models/*.onnx, dist/LICENSES/*
//   dist/manifest.json (from src/manifest.ts), dist/build-info.json
import * as esbuild from "esbuild";
import { existsSync, watch as fsWatch } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildManifest, type BuildMode, allManifestMessages } from "../src/manifest.ts";
import { sha256File } from "./lib/hash.ts";
import { readModelsLock, shippedModels } from "./lib/models.ts";
import { CACHE_MODELS, DIST as DEFAULT_DIST, NODE_MODULES, ROOT, VENDOR, rel } from "./lib/paths.ts";

const flags = new Set(process.argv.slice(2));
const DIST = await outputDir([...flags].find((flag) => flag.startsWith("--out="))?.slice("--out=".length));
const mode: BuildMode = flags.has("--prod") ? "prod" : flags.has("--test") ? "test" : "dev";
const watchMode = flags.has("--watch");
const verifyModels = flags.has("--verify-models");

const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { version: string };
const ortPkg = JSON.parse(
  await readFile(path.join(NODE_MODULES, "onnxruntime-web", "package.json"), "utf8"),
) as {
  version: string;
};
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "");
const BUILD_ID = `${pkg.version}+${stamp}${mode === "prod" ? "" : `.${mode}`}`;

const UI_PAGES =
  mode === "prod" ? ["popup", "options", "sidepanel"] : ["popup", "options", "sidepanel", "debug"];
const ORT_WASM = "ort-wasm-simd-threaded.asyncify.wasm";
const FONT_FILES = [
  "@fontsource/patrick-hand/files/patrick-hand-latin-400-normal.woff2",
  "@fontsource/patrick-hand/files/patrick-hand-vietnamese-400-normal.woff2",
  "@fontsource/mali/files/mali-latin-400-normal.woff2",
  "@fontsource/mali/files/mali-vietnamese-400-normal.woff2",
  "@fontsource/mali/files/mali-latin-700-normal.woff2",
  "@fontsource/mali/files/mali-vietnamese-700-normal.woff2",
  "@fontsource/bangers/files/bangers-latin-400-normal.woff2",
  "@fontsource/bangers/files/bangers-vietnamese-400-normal.woff2",
];
const LICENSE_FILES: Array<[from: string, to: string]> = [
  [path.join(VENDOR, "LICENSES", "Apache-2.0.txt"), "Apache-2.0.txt"],
  [
    path.join(VENDOR, "LICENSES", "NOTICE-comic-text-and-bubble-detector.txt"),
    "NOTICE-comic-text-and-bubble-detector.txt",
  ],
  [path.join(VENDOR, "LICENSES", "MIT-onnxruntime-web.txt"), "MIT-onnxruntime-web.txt"],
  [path.join(NODE_MODULES, "idb", "LICENSE"), "ISC-idb.txt"],
  [path.join(NODE_MODULES, "@fontsource", "patrick-hand", "LICENSE"), "OFL-patrick-hand.txt"],
  [path.join(NODE_MODULES, "@fontsource", "mali", "LICENSE"), "OFL-mali.txt"],
  [path.join(NODE_MODULES, "@fontsource", "bangers", "LICENSE"), "OFL-bangers.txt"],
];

const common: esbuild.BuildOptions = {
  bundle: true,
  platform: "browser",
  target: ["chrome148"],
  charset: "utf8",
  logLevel: "warning",
  sourcemap: mode === "prod" ? false : "linked",
  minify: mode === "prod",
  legalComments: "linked",
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __DEV__: String(mode !== "prod"),
    __TEST__: String(mode === "test"),
  },
};

const builds: esbuild.BuildOptions[] = [
  { ...common, entryPoints: { sw: "src/sw/main.ts" }, outdir: DIST, format: "esm", splitting: false },
  {
    ...common,
    entryPoints: { main: "src/engine/main.ts" },
    outdir: path.join(DIST, "engine"),
    format: "esm",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
  },
  {
    ...common,
    entryPoints: { main: "src/content/main.ts" },
    outdir: path.join(DIST, "content"),
    format: "iife",
  },
  {
    ...common,
    entryPoints: Object.fromEntries(UI_PAGES.map((page) => [page, `src/ui/${page}/${page}.ts`])),
    outdir: path.join(DIST, "ui"),
    format: "esm",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
  },
];

const started = Date.now();
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
const models = await checkModels();

if (watchMode) {
  const contexts = await Promise.all(
    builds.map((options) => esbuild.context({ ...options, absWorkingDir: ROOT })),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  await copyStatic(models);
  for (const dir of ["src/ui", "src/engine", "assets"]) {
    fsWatch(path.join(ROOT, dir), { recursive: true }, (_event, file) => {
      if (file !== null && /\.(html|css|png|json|woff2)$/.test(file)) {
        copyStatic(models).catch((error: unknown) => console.error("static copy failed", error));
      }
    });
  }
  console.log(`watching (${mode}) ${BUILD_ID}`);
} else {
  await Promise.all(builds.map((options) => esbuild.build({ ...options, absWorkingDir: ROOT })));
  await copyStatic(models);
  await assertDist(models);
  await printSizes();
  console.log(`built ${BUILD_ID} in ${((Date.now() - started) / 1000).toFixed(1)}s → ${rel(DIST)}/`);
}

interface CheckedModel {
  file: string;
  sha256: string;
  bytes: number;
}

/** Every required model must be in .cache/models with the locked size and a matching sha256 sidecar. */
async function checkModels(): Promise<CheckedModel[]> {
  const required = shippedModels(readModelsLock());
  const checked: CheckedModel[] = [];
  for (const model of required) {
    const file = path.join(CACHE_MODELS, model.file);
    const sidecar = `${file}.sha256`;
    if (!existsSync(file) || (await stat(file)).size !== model.bytes || !existsSync(sidecar)) {
      fail(`${model.file} is missing or incomplete in ${rel(CACHE_MODELS)}. Run: npm run fetch-models`);
    }
    const recorded = (await readFile(sidecar, "utf8")).trim();
    const actual = verifyModels ? await sha256File(file) : recorded;
    if (recorded !== model.sha256 || actual !== model.sha256) {
      fail(`${model.file} does not match the pinned sha256. Run: npm run fetch-models -- --verify`);
    }
    checked.push({ file: model.file, sha256: model.sha256, bytes: model.bytes });
  }
  return checked;
}

async function copyStatic(models: CheckedModel[]): Promise<void> {
  await copyInto("src/engine/offscreen.html", "engine/offscreen.html");
  for (const page of UI_PAGES) {
    await copyInto(`src/ui/${page}/${page}.html`, `ui/${page}.html`);
    if (existsSync(path.join(ROOT, `src/ui/${page}/${page}.css`))) {
      await copyInto(`src/ui/${page}/${page}.css`, `ui/${page}.css`);
    }
  }
  await copyDir(path.join(ROOT, "assets", "icons"), path.join(DIST, "assets", "icons"));
  await copyDir(path.join(ROOT, "assets", "canary"), path.join(DIST, "assets", "canary"));

  for (const font of FONT_FILES) {
    await copyAbsolute(
      path.join(NODE_MODULES, font),
      path.join(DIST, "assets", "fonts", path.basename(font)),
    );
  }
  // The '/webgpu' bundle keeps its embedded Emscripten glue when wasmPaths names this binary explicitly,
  // so this is the only ORT file shipped (no .mjs, no jsep/jspi/plain variants).
  await copyAbsolute(
    path.join(NODE_MODULES, "onnxruntime-web", "dist", ORT_WASM),
    path.join(DIST, "vendor", "ort", ORT_WASM),
  );
  for (const model of models) {
    await copyAbsolute(path.join(CACHE_MODELS, model.file), path.join(DIST, "models", model.file));
  }
  for (const [from, to] of LICENSE_FILES) {
    await copyAbsolute(from, path.join(DIST, "LICENSES", to));
  }

  const manifest = buildManifest({ version: pkg.version, mode });
  await writeFile(path.join(DIST, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [dir, messages] of allManifestMessages()) {
    await mkdir(path.join(DIST, "_locales", dir), { recursive: true });
    await writeFile(
      path.join(DIST, "_locales", dir, "messages.json"),
      `${JSON.stringify(messages, null, 2)}\n`,
    );
  }
  await writeFile(
    path.join(DIST, "build-info.json"),
    `${JSON.stringify({ buildId: BUILD_ID, mode, ort: ortPkg.version, models }, null, 2)}\n`,
  );
}

async function assertDist(models: CheckedModel[]): Promise<void> {
  const content = await readFile(path.join(DIST, "content", "main.js"), "utf8");
  if (/^\s*(import|export)\s/m.test(content)) {
    fail("dist/content/main.js has a top-level import/export; content scripts must be classic IIFE scripts");
  }
  const ortFiles = await readdir(path.join(DIST, "vendor", "ort"));
  if (ortFiles.length !== 1 || ortFiles[0] !== ORT_WASM) {
    fail(`dist/vendor/ort must hold exactly ${ORT_WASM}, found: ${ortFiles.join(", ")}`);
  }
  const manifest = JSON.parse(await readFile(path.join(DIST, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const key of ["content_scripts", "cross_origin_embedder_policy", "cross_origin_opener_policy"]) {
    if (key in manifest) {
      fail(`manifest must not contain ${key}`);
    }
  }
  for (const icon of ["16", "32", "48", "128"]) {
    if (!existsSync(path.join(DIST, "assets", "icons", `icon-${icon}.png`))) {
      fail(`missing assets/icons/icon-${icon}.png. Run: npm run icons`);
    }
  }
  for (const model of models) {
    if ((await stat(path.join(DIST, "models", model.file))).size !== model.bytes) {
      fail(`dist/models/${model.file} has the wrong size`);
    }
  }
}

async function printSizes(): Promise<void> {
  const rows: Array<[string, number]> = [];
  for (const entry of await readdir(DIST, { withFileTypes: true })) {
    const full = path.join(DIST, entry.name);
    rows.push([entry.name, entry.isDirectory() ? await dirSize(full) : (await stat(full)).size]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, size]) => sum + size, 0);
  for (const [name, size] of rows) {
    console.log(`  ${name.padEnd(18)} ${(size / 1_000_000).toFixed(2).padStart(7)} MB`);
  }
  console.log(`  ${"total".padEnd(18)} ${(total / 1_000_000).toFixed(2).padStart(7)} MB`);
  // The budget is about what ships: source maps exist only in dev and test builds, so they do not count.
  const shipped = total - (await dirSize(DIST, (name) => name.endsWith(".map")));
  if (shipped > 85_000_000) {
    fail(`dist is ${(shipped / 1_000_000).toFixed(1)} MB without source maps, above the 85 MB budget`);
  }
}

async function dirSize(dir: string, include: (name: string) => boolean = () => true): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full, include);
    else if (include(entry.name)) total += (await stat(full)).size;
  }
  return total;
}

async function copyInto(fromRel: string, toRel: string): Promise<void> {
  await copyAbsolute(path.join(ROOT, fromRel), path.join(DIST, toRel));
}

async function copyAbsolute(from: string, to: string): Promise<void> {
  if (!existsSync(from)) {
    fail(`missing build input ${rel(from)}`);
  }
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

async function copyDir(from: string, to: string): Promise<void> {
  if (!existsSync(from)) {
    return;
  }
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(source, target);
    } else {
      await copyAbsolute(source, target);
    }
  }
}

function fail(message: string): never {
  console.error(`build failed: ${message}`);
  process.exit(1);
}

/** The output folder: dist/ by default; --out must stay inside the repository and never be a folder of other files. */
async function outputDir(requested: string | undefined): Promise<string> {
  if (requested === undefined || requested === "") return DEFAULT_DIST;
  const dir = path.resolve(ROOT, requested);
  const inside = path.relative(ROOT, dir);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error(`--out must be a folder inside the repository, got ${requested}`);
  }
  if (existsSync(dir)) {
    const entries = await readdir(dir);
    if (entries.length > 0 && !entries.includes("manifest.json")) {
      throw new Error(`--out ${requested} is not empty and holds no earlier build; refusing to wipe it`);
    }
  }
  return dir;
}
