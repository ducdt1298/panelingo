// Offline mode evaluation (docs/OFFLINE-MODE.md), run through the E2E harness in Chrome (onnxruntime-node is not a
// dependency): a test build translates the generated fixtures with engine "offline", the models served from a local
// mirror of .cache/offline-models, and the mock OpenAI-compatible server must see no request at all. Per page it
// reports the OCR character error rate against the ground truth's `original`, the translations next to their
// references (chrF), the time per unit for detection, OCR and translation, and the download size per language pair.
//
//   npm run fetch-models -- --offline          (once: about 2.1 GB of pinned models into .cache/offline-models)
//   node scripts/build.ts --test --out=build-offline
//   CTV_EXTENSION_DIR=build-offline node tools/offline-eval/run.ts [--models=opus-mt,nllb-600m]
//     [--backends=auto,wasm] [--targets=en,vi] [--sets=ko-p01,ja-p01,zh-p01,en-p01,es-p01,ko-strip01]
//     [--shots=<dir>]   (a full-page screenshot of every translated page, <model>-<backend>-<set>-<target>.png)
//
// "auto" lets the detector (and so the recognizer) use WebGPU where Chrome offers it; "wasm" keeps everything on the
// CPU. Translation models always run on WASM (their int8 graphs were slower on WebGPU). Results: reports/offline-eval/
// (results-<stamp>.json with every unit, summary-<stamp>.md with the tables).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "puppeteer-core";
import { enableSite, openPage, sleep, waitImagesSettled } from "../../e2e/helpers/flows.ts";
import { ROOT } from "../../e2e/helpers/chrome.ts";
import { launch, type Harness } from "../../e2e/helpers/launch.ts";
import { missingFiles, offlineCatalog, startOfflineMirror } from "../../e2e/helpers/offline-models.ts";
import { downloadBytes } from "../../src/shared/offline/catalog.ts";
import {
  OCR_MODEL,
  planRoute,
  routeModels,
  type OfflineModelChoice,
} from "../../src/shared/offline/routing.ts";
import type { Lang, UnitGeometry } from "../../src/shared/types.ts";
import { urlKeyOf } from "../../src/shared/url-normalize.ts";
import {
  fixed,
  markdownTable,
  mean,
  scoreUnits,
  sentenceId,
  type EngineUnit,
  type GroundTruthUnit,
  type SentenceLine,
  type UnitRow,
} from "./metrics.ts";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key = "", value = ""] = arg.replace(/^--/u, "").split("=");
    return [key, value] as const;
  }),
);
const list = (key: string, fallback: string): string[] =>
  (args.get(key) ?? fallback)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
const MODELS = list("models", "opus-mt,nllb-600m") as OfflineModelChoice[];
const BACKENDS = list("backends", "auto,wasm") as Array<"auto" | "wasm">;
const TARGETS = list("targets", "en,vi");
const SETS = list("sets", "ko-p01,ja-p01,zh-p01,en-p01,es-p01,ko-strip01");
const SHOTS = args.get("shots") ?? "";
const PAGE_TIMEOUT_MS = 20 * 60_000;

interface GroundTruthFile {
  image: string;
  lang: Lang;
  units: Array<GroundTruthUnit & { lines?: string[] }>;
}

interface PackLog {
  units: number;
  lines: number;
  voteMs: number;
  loadMs: number;
  ocrMs: number;
  mtMs: number;
  ms: number;
}

interface PageRun {
  model: OfflineModelChoice;
  backend: string;
  detectorBackend: string;
  set: string;
  lang: Lang;
  target: string;
  route: string;
  downloadMb: number;
  wallMs: number;
  detectMs: number | null;
  packs: PackLog[];
  rows: UnitRow[];
  apiRequests: number;
}

const generated = (name: string): string => path.join(ROOT, "test", "fixtures", "generated", name);

async function sentences(lang: Lang): Promise<SentenceLine[]> {
  const file = path.join(ROOT, "test", "fixtures", "sentences", `${lang}.json`);
  return (JSON.parse(await readFile(file, "utf8")) as { lines: SentenceLine[] }).lines;
}

/** Runs `expression` in the engine's offscreen document and returns its JSON value. */
async function engineEval(browser: Browser, expression: string): Promise<unknown> {
  const target = browser.targets().find((t) => t.url().includes("offscreen.html"));
  if (target === undefined) return null;
  const session = await target.createCDPSession();
  try {
    const result = await session.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression,
    });
    return result.result.value ?? null;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Every record of an engine store (IndexedDB "ctv"). */
function storeRecords<T>(browser: Browser, store: string): Promise<T[]> {
  return engineEval(
    browser,
    `new Promise((resolve) => {
      const open = indexedDB.open("ctv");
      open.onsuccess = () => {
        const request = open.result.transaction(${JSON.stringify(store)}).objectStore(${JSON.stringify(store)}).getAll();
        request.onsuccess = () => { resolve(request.result); open.result.close(); };
        request.onerror = () => resolve([]);
      };
      open.onerror = () => resolve([]);
    })`,
  ).then((value) => (Array.isArray(value) ? (value as T[]) : []));
}

interface LogRecord {
  t: number;
  msg: string;
  data?: Record<string, unknown>;
}

function detectedMs(entry: LogRecord | undefined): number | null {
  const ms = entry?.data?.["ms"];
  return typeof ms === "number" ? ms : null;
}

async function runPage(
  h: Harness,
  model: OfflineModelChoice,
  backend: string,
  set: string,
  target: string,
): Promise<PageRun> {
  const gt = JSON.parse(await readFile(generated(`${set}.gt.json`), "utf8")) as GroundTruthFile;
  const lines = await sentences(gt.lang);
  const english = await sentences("en");
  const available = new Set(offlineCatalog().map((file) => file.model));
  const route = planRoute(gt.lang, target, model, available);
  const source = gt.lang === "other" ? null : gt.lang;
  // The site's language is "auto": the vote reads with the CJK recognizer first, and with the Korean one if needed.
  const models =
    source === null
      ? []
      : [
          ...new Set([
            ...routeModels(source, route),
            OCR_MODEL.zh,
            ...(source === "ko" ? [OCR_MODEL.ko] : []),
          ]),
        ];
  const startedAt = Date.now();
  const requestsBefore = h.api.requests().length;
  const opened = await openPage(h, `/paged/?set=${set}`);
  await waitImagesSettled(opened.page, 1, PAGE_TIMEOUT_MS);
  if (SHOTS !== "") {
    await mkdir(path.resolve(ROOT, SHOTS), { recursive: true });
    await sleep(1_000); // lettering is fitted after the last unit arrives
    await opened.page.screenshot({
      path: path.resolve(ROOT, SHOTS, `${model}-${backend}-${set}-${target}.png`),
      fullPage: true,
    });
  }
  const wallMs = Date.now() - startedAt;
  const src = await opened.page.evaluate(() => document.querySelector("img")?.src ?? "");
  await opened.page.close();
  // Translations are written every 2 s and logs every 1 s.
  await sleep(2_500);
  const urlKey = urlKeyOf(src);
  const alias = (await storeRecords<{ urlKey: string; contentKey: string }>(h.browser, "urls")).find(
    (record) => record.urlKey === urlKey,
  );
  const contentKey = alias?.contentKey ?? "";
  const unitsRecord = (
    await storeRecords<{ contentKey: string; units: UnitGeometry[]; backend: string }>(h.browser, "units")
  ).find((record) => record.contentKey === contentKey);
  const records = (
    await storeRecords<{
      contentKey: string;
      unitKey: string;
      status: string;
      type: string;
      original: string;
      translation: string;
      model: string;
      target?: string;
    }>(h.browser, "translations")
  ).filter((record) => record.contentKey === contentKey);
  const engineUnits: EngineUnit[] = (unitsRecord?.units ?? []).map((geometry) => {
    const record = records.find((r) => r.unitKey === geometry.unitKey);
    return {
      geometry,
      status: record?.status ?? "missing",
      type: record?.type ?? "",
      original: record?.original ?? "",
      translation: record?.translation ?? "",
      model: record?.model ?? "",
    };
  });
  const logs = (await storeRecords<LogRecord>(h.browser, "logs")).filter((entry) => entry.t >= startedAt);
  const packs = logs
    .filter((entry) => entry.msg === "offline pack translated")
    .map((entry) => {
      const d = entry.data ?? {};
      const num = (key: string): number => {
        const value = d[key];
        return typeof value === "number" ? value : 0;
      };
      return {
        units: num("units"),
        lines: num("lines"),
        voteMs: num("voteMs"),
        loadMs: num("loadMs"),
        ocrMs: num("ocrMs"),
        mtMs: num("mtMs"),
        ms: num("ms"),
      };
    });
  const detected = logs.find((entry) => entry.msg === "text detected");
  const reference = (unit: GroundTruthUnit): string | null => {
    if (target === "vi") return unit.vi;
    if (target !== "en") return null;
    const id = sentenceId(unit.original, lines);
    return id === null ? null : (english.find((line) => line.id === id)?.text ?? null);
  };
  return {
    model,
    backend,
    detectorBackend: unitsRecord?.backend ?? "?",
    set,
    lang: gt.lang,
    target,
    route: route.kind === "translate" ? route.label.replace(/^offline:/u, "") : route.kind,
    downloadMb: downloadBytes(offlineCatalog(), models) / 1_000_000,
    wallMs,
    detectMs: detectedMs(detected),
    packs,
    rows: scoreUnits(gt.units, engineUnits, reference),
    apiRequests: h.api.requests().length - requestsBefore,
  };
}

async function runEngine(model: OfflineModelChoice, backend: "auto" | "wasm"): Promise<PageRun[]> {
  const mirror = await startOfflineMirror();
  const h = await launch({
    settings: {
      translate: { engine: "offline", offlineModel: model, targetLang: TARGETS[0] ?? "en" },
      detector: { backend },
      // Every fixture page is on the same reader site: series memory would carry one page's language to the next.
      memory: { enabled: false },
      debug: { offlineModelBaseUrl: mirror.baseUrl, logLevel: "info" },
    },
  });
  const runs: PageRun[] = [];
  try {
    await enableSite(h);
    for (const target of TARGETS) {
      await h.patchSettings({ translate: { targetLang: target } });
      await sleep(600);
      for (const set of SETS) {
        const started = Date.now();
        const run = await runPage(h, model, backend, set, target);
        runs.push(run);
        const cer = mean(run.rows.map((row) => row.cer));
        const chrf = mean(run.rows.flatMap((row) => (row.chrF === null ? [] : [row.chrF])));
        console.log(
          `${model}/${backend} ${set} → ${target}: CER ${fixed(cer, 3)}, chrF ${fixed(chrf)}, ` +
            `${((Date.now() - started) / 1000).toFixed(1)} s, API requests ${run.apiRequests}`,
        );
      }
    }
  } finally {
    await h.close();
    await mirror.close();
  }
  return runs;
}

function perUnit(run: PageRun, key: "ocrMs" | "mtMs" | "voteMs" | "loadMs"): number | null {
  const units = run.packs.reduce((sum, pack) => sum + pack.units, 0);
  if (units === 0) return null;
  return run.packs.reduce((sum, pack) => sum + pack[key], 0) / units;
}

function summary(runs: readonly PageRun[]): string {
  const out: string[] = [];
  const ocrRows = runs
    .filter((run) => run.target === TARGETS[0] && run.backend === BACKENDS[0])
    .filter((run, i, all) => all.findIndex((r) => r.set === run.set && r.model === run.model) === i)
    .filter((run) => run.model === MODELS[0]);
  out.push("### OCR (character error rate, spaces and punctuation ignored)\n");
  out.push(
    markdownTable(
      ["Page", "Lang", "Units (detected)", "CER", "CER detected only", "Sample (OCR → ground truth)"],
      ocrRows.map((run) => {
        const detected = run.rows.filter((row) => row.ocr !== null);
        const sample = detected.find((row) => row.cer > 0) ?? detected[0];
        return [
          run.set,
          run.lang,
          `${run.rows.length} (${detected.length})`,
          fixed(mean(run.rows.map((row) => row.cer)), 3),
          fixed(mean(detected.map((row) => row.cer)), 3),
          sample === undefined ? "" : `${sample.ocr ?? ""} → ${sample.gtOriginal}`,
        ];
      }),
    ),
  );
  for (const model of MODELS) {
    out.push(`\n### Translation, ${model} (chrF against the reference, 0–100)\n`);
    const rows = runs.filter((run) => run.model === model && run.backend === BACKENDS[0]);
    out.push(
      markdownTable(
        ["Page", "Target", "Route", "chrF", "Download (MB)", "Sample (translation | reference)"],
        rows.map((run) => {
          const scored = run.rows.filter((row) => row.chrF !== null);
          const sample = scored[1] ?? scored[0];
          return [
            run.set,
            run.target,
            run.route,
            fixed(mean(scored.map((row) => row.chrF ?? 0))),
            run.downloadMb.toFixed(0),
            sample === undefined ? "" : `${sample.translation ?? "–"} | ${sample.reference ?? ""}`,
          ];
        }),
      ),
    );
  }
  out.push(
    "\n### Time per unit (ms; warm runs: the first page of each engine, which loads the models, left out)\n",
  );
  const timing: string[][] = [];
  for (const model of MODELS) {
    for (const backend of BACKENDS) {
      const rows = runs.filter((run) => run.model === model && run.backend === backend);
      const warm = rows.slice(1);
      const units = (run: PageRun): number => run.rows.length || 1;
      timing.push([
        model,
        backend,
        rows[0]?.detectorBackend ?? "?",
        fixed(mean(rows.flatMap((run) => (run.detectMs === null ? [] : [run.detectMs / units(run)]))), 0),
        fixed(mean(warm.flatMap((run) => perUnit(run, "ocrMs") ?? [])), 0),
        fixed(mean(warm.flatMap((run) => perUnit(run, "mtMs") ?? [])), 0),
        fixed(mean(warm.flatMap((run) => perUnit(run, "voteMs") ?? [])), 0),
        fixed((rows[0]?.packs.reduce((sum, pack) => sum + pack.loadMs, 0) ?? 0) / 1000, 1),
        fixed(mean(warm.map((run) => run.wallMs / 1000)), 1),
      ]);
    }
  }
  out.push(
    markdownTable(
      [
        "Model",
        "Backend",
        "Detector on",
        "Detect / unit",
        "OCR / unit",
        "MT / unit",
        "Language vote / unit",
        "First load (s)",
        "Page (s)",
      ],
      timing,
    ),
  );
  const pairs = new Map<string, number>();
  for (const run of runs)
    pairs.set(`${run.model} ${run.lang} → ${run.target} (${run.route})`, run.downloadMb);
  out.push(
    "\n### Download per language pair (recognizers, the language vote's included, + translation models)\n",
  );
  out.push(
    markdownTable(
      ["Pair", "MB"],
      [...pairs].map(([pair, mb]) => [pair, mb.toFixed(0)]),
    ),
  );
  out.push(`\nAPI requests during the evaluation: ${runs.reduce((sum, run) => sum + run.apiRequests, 0)}`);
  return out.join("\n");
}

const needed = [
  ...new Set([
    ...Object.values(OCR_MODEL),
    ...MODELS.flatMap((model) =>
      SETS.flatMap((set) => {
        const lang = set.split("-")[0] as Exclude<Lang, "other">;
        return TARGETS.flatMap((target) => {
          const route = planRoute(lang, target, model, new Set(offlineCatalog().map((f) => f.model)));
          return route.kind === "translate" ? route.legs.map((leg) => leg.model) : [];
        });
      }),
    ),
  ]),
];
const missing = missingFiles(needed);
if (missing.length > 0) {
  console.error(
    `missing in .cache/offline-models: ${[...new Set(missing.map((f) => f.model))].join(", ")}. ` +
      "Run: npm run fetch-models -- --offline",
  );
  process.exit(1);
}

const all: PageRun[] = [];
for (const model of MODELS) {
  for (const backend of BACKENDS) all.push(...(await runEngine(model, backend)));
}
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/gu, "")
  .replace(/\.\d+Z$/u, "");
const outDir = path.join(ROOT, "reports", "offline-eval");
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, `results-${stamp}.json`), `${JSON.stringify(all, null, 2)}\n`);
const text = summary(all);
await writeFile(path.join(outDir, `summary-${stamp}.md`), `${text}\n`);
console.log(`\n${text}\n\nwritten to ${path.relative(ROOT, outDir)}/{results,summary}-${stamp}.*`);
