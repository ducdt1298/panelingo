// Manual aid (not a test): regenerates the README and Chrome Web Store images in docs/images.
//
//   npm run fixtures && npm run build:test
//   node e2e/docs-shots.ts [--out docs/images] [--raw <dir>] [--skip-demo]
//
// Launches the E2E harness (e2e/helpers/launch.ts: Chrome with the built extension from $CTV_EXTENSION_DIR or dist/,
// the fixture server and the mock OpenAI-compatible server, all on ephemeral ports); the extension never talks to a
// real AI endpoint. Only generated fixtures appear: ko-p01 and es-p01 (paged), ko-strip01 (webtoon demo).
//
// The pages read in English (settings.translate.targetLang "en"): the mock's oracle answers from the fixtures' ground
// truth, whose reference translations are Vietnamese (`vi`), so this script writes a temporary copy of the ground
// truth that adds `refs.en`, the parallel English sentence of each unit (test/fixtures/sentences/en.json shares ids
// and `vi` with the other languages), in sentence case as a model would write it, and sets the mock's `oracleLang`.
//
// Raw captures go to a temporary folder (or --raw); tools/docs/compose_images.py (Python 3 + Pillow, as for the
// fixtures) scales, encodes and composes them into the final files. See docs/images/README.md.

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { TargetType, type Page, type Viewport } from "puppeteer-core";
import { ROOT } from "./helpers/chrome.ts";
import { enableSite, paintedUnits, sleep, tabIdOf, waitAllImages, waitUntil } from "./helpers/flows.ts";
import { launch, summary, type Harness } from "./helpers/launch.ts";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "docs/images" },
    raw: { type: "string" },
    "skip-demo": { type: "boolean", default: false },
  },
});
const OUT = path.resolve(ROOT, args.out ?? "docs/images");
const GENERATED = path.join(ROOT, "test/fixtures/generated");
const PAGED_SETS = ["ko-p01", "es-p01"] as const;
const DEMO_SET = "ko-strip01";
/** Model name the mock lists (shown by the popup and the options page). */
const MODEL = "vision-model";
const PAGED_VIEWPORT: Viewport = { width: 820, height: 1360, deviceScaleFactor: 1.5 };
/** 1067x800 CSS px at 0.75: 800x600 frames showing the 800 px strip as a centred column, like a reader. */
const DEMO_VIEWPORT: Viewport = { width: 1067, height: 800, deviceScaleFactor: 0.75 };
const STRIP_STILL_VIEWPORT: Viewport = { width: 800, height: 1100, deviceScaleFactor: 1 };
const SIDE_PANEL_VIEWPORT: Viewport = { width: 440, height: 800, deviceScaleFactor: 2 };
const OPTIONS_VIEWPORT: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
const POPUP_VIEWPORT: Viewport = { width: 380, height: 640, deviceScaleFactor: 2 };

/** Device pixels per CSS pixel of each raw capture (tools/docs/compose_images.py scales them back). */
const dpr: Record<string, number> = {};

function log(message: string): void {
  console.log(`[docs-shots] ${message}`);
}

// ---- English references for the oracle ----

interface Sentence {
  id: string;
  type: string;
  text: string;
  vi: string;
}

interface GtUnitDoc {
  type: string;
  vi: string | null;
  canary: string | null;
  refs?: Record<string, string>;
}

/** English comic lettering is all capitals; a model translating into English writes sentence case. */
function sentenceCase(text: string, keep: readonly string[] = []): string {
  let out = text
    .toLowerCase()
    .replace(/(^|[.!?…]\s+)(\p{L})/gu, (_m, lead: string, letter: string) => lead + letter.toUpperCase())
    .replace(/\bi\b/gu, "I");
  for (const token of keep) {
    out = out.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"), token);
  }
  return out;
}

/** Copies the ground truth of `sets` into `dir`, adding refs.en from the parallel English sentences. */
async function writeEnglishGroundTruth(dir: string, sets: readonly string[]): Promise<void> {
  const en = JSON.parse(await readFile(path.join(ROOT, "test/fixtures/sentences/en.json"), "utf8")) as {
    lines: Sentence[];
    actionLines?: Sentence[];
  };
  const byVi = new Map<string, Sentence>();
  for (const s of [...en.lines, ...(en.actionLines ?? [])]) byVi.set(s.vi, s);
  for (const set of sets) {
    const gt = JSON.parse(await readFile(path.join(GENERATED, `${set}.gt.json`), "utf8")) as {
      units: GtUnitDoc[];
    };
    const missing: number[] = [];
    gt.units.forEach((unit, index) => {
      if (unit.type === "ignore" || unit.vi === null) return;
      const sentence = byVi.get(unit.vi);
      if (sentence === undefined) {
        missing.push(index + 1);
        return;
      }
      const capitals = sentence.type === "sfx" || sentence.type === "sign";
      unit.refs = {
        en: capitals ? sentence.text : sentenceCase(sentence.text, unit.canary ? [unit.canary] : []),
      };
    });
    if (missing.length > 0) log(`${set}: no English reference for units ${missing.join(", ")}`);
    await writeFile(path.join(dir, `${set}.gt.json`), JSON.stringify(gt));
  }
}

// ---- page helpers ----

async function openAt(h: Harness, url: string, viewport: Viewport): Promise<Page> {
  const page = await h.browser.newPage();
  await page.setViewport(viewport);
  await page.goto(url, { waitUntil: "load" });
  return page;
}

/** Waits until fonts are loaded and the painted units stop changing (the overlay re-fits once fonts arrive). */
async function settle(page: Page, minUnits = 1): Promise<number> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  let last = -1;
  let stable = 0;
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const units = (await paintedUnits(page)).length;
    stable = units === last && units >= minUnits ? stable + 1 : 0;
    if (stable >= 4) break;
    last = units;
    await sleep(250);
  }
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
  );
  await sleep(400);
  return last;
}

/** The first image's box in page coordinates (the page is not scrolled). */
async function imageBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return await page.evaluate(() => {
    window.scrollTo(0, 0);
    const img = document.querySelector("main img");
    if (img === null) throw new Error("no image on the page");
    const r = img.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

/** Translates a paged fixture and saves the translated image region (overlay shown) as after-<set>.png. */
async function capturePaged(h: Harness, set: string, raw: string): Promise<Page> {
  const page = await openAt(h, `${h.fixtures.readerUrl}/paged/?set=${set}`, PAGED_VIEWPORT);
  await waitAllImages(page, ["done"], 1, 120_000);
  const units = await settle(page);
  const box = await imageBox(page);
  if (box.y + box.height > PAGED_VIEWPORT.height)
    throw new Error(`${set}: the page does not fit the viewport`);
  await page.screenshot({ path: path.join(raw, `after-${set}.png`), clip: box });
  log(`${set}: ${units} painted units, image ${Math.round(box.width)}x${Math.round(box.height)} CSS px`);
  return page;
}

/** The side panel's transcript of the comic tab, saved as <name>.png. */
async function captureSidePanel(h: Harness, comic: Page, raw: string, name: string): Promise<void> {
  const tabId = await tabIdOf(h, comic.url());
  const panel = await h.browser.newPage();
  await panel.setViewport(SIDE_PANEL_VIEWPORT);
  await panel.goto(`chrome-extension://${h.extensionId}/ui/sidepanel.html?tabId=${tabId}`);
  await panel.waitForSelector("li.line", { timeout: 30_000 });
  await sleep(800);
  await panel.screenshot({ path: path.join(raw, `${name}.png`) });
  dpr[name] = SIDE_PANEL_VIEWPORT.deviceScaleFactor ?? 1;
  await panel.close();
  log(`side panel (${name})`);
}

/**
 * The toolbar popup for the comic tab: chrome.action.openPopup() with that tab focused. Where the browser cannot
 * open it, the popup page is loaded in a tab whose chrome.tabs.query answers with the comic tab.
 */
async function capturePopup(h: Harness, comic: Page, raw: string): Promise<void> {
  const file = path.join(raw, "popup.png");
  await comic.bringToFront();
  try {
    await h.sw.evaluate(() => chrome.action.openPopup());
    const target = await h.browser.waitForTarget(
      (t) => t.type() === TargetType.PAGE && t.url().endsWith("/ui/popup.html"),
      { timeout: 10_000 },
    );
    const popup = await target.asPage();
    await sleep(2_000);
    const size = await popup.evaluate(() => ({
      width: Math.ceil(document.documentElement.scrollWidth),
      height: Math.ceil(document.documentElement.scrollHeight),
    }));
    // Sharper pixels for the store images: where the action popup cannot be emulated at 2x, the popup page is
    // captured in a tab instead (below), which can.
    try {
      await popup.setViewport({ ...size, deviceScaleFactor: 2 });
      await sleep(500);
    } catch (error) {
      await popup.close().catch(() => undefined);
      throw error;
    }
    dpr["popup"] = 2;
    await popup.screenshot({ path: file, fullPage: true });
    await popup.close().catch(() => undefined);
    log(`popup (action popup, ${size.width}x${size.height} CSS px)`);
    return;
  } catch (error) {
    log(`openPopup unavailable (${error instanceof Error ? error.message : String(error)}); popup in a tab`);
  }
  const tabId = await tabIdOf(h, comic.url());
  const page = await h.browser.newPage();
  await page.setViewport(POPUP_VIEWPORT);
  await page.evaluateOnNewDocument((id: number) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info: chrome.tabs.QueryInfo) =>
      info.active === true ? (await query({})).filter((tab) => tab.id === id) : await query(info);
  }, tabId);
  await page.goto(`chrome-extension://${h.extensionId}/ui/popup.html`);
  await sleep(2_000);
  const size = await page.evaluate(() => ({
    width: Math.ceil(document.documentElement.scrollWidth),
    // The page is as tall as the tab: measure the popup itself.
    height: Math.ceil(
      document.querySelector("main")?.getBoundingClientRect().bottom ?? document.documentElement.scrollHeight,
    ),
  }));
  await page.screenshot({
    path: file,
    clip: {
      x: 0,
      y: 0,
      width: Math.min(size.width, POPUP_VIEWPORT.width),
      height: Math.min(size.height, POPUP_VIEWPORT.height),
    },
  });
  dpr["popup"] = POPUP_VIEWPORT.deviceScaleFactor ?? 1;
  await page.close();
  log("popup (tab)");
}

async function captureOptions(h: Harness, raw: string): Promise<void> {
  const page = await h.browser.newPage();
  await page.setViewport(OPTIONS_VIEWPORT);
  await page.goto(`chrome-extension://${h.extensionId}/ui/options.html`, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await sleep(1_500);
  await page.screenshot({ path: path.join(raw, "options.png") });
  dpr["options"] = OPTIONS_VIEWPORT.deviceScaleFactor ?? 1;
  await page.close();
  log("options page");
}

// ---- demo ----

interface Frame {
  file: string;
  /** Milliseconds since the first kept frame. */
  t: number;
}

const easeInOut = (x: number): number => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

/**
 * Frames of the webtoon demo: about a second of the original strip, the first balloons being re-lettered, then a
 * smooth scroll while the answer streams in (the mock is paced like a real model), and a short hold at the end.
 */
async function captureDemo(h: Harness, raw: string): Promise<void> {
  const dir = path.join(raw, "demo");
  await mkdir(dir, { recursive: true });
  h.api.setScenario({ oracleLang: "en", firstChunkDelayMs: 500, chunkDelayMs: 70, chunkChars: 16 });
  const page = await openAt(h, `${h.fixtures.readerUrl}/webtoon/?set=${DEMO_SET}&lazy=none`, DEMO_VIEWPORT);
  const top = await page.evaluate(() => {
    const img = document.querySelector("main img");
    return img === null ? 0 : Math.round(img.getBoundingClientRect().top + window.scrollY);
  });
  const start = top + 150; // the first caption and balloon are in view
  const fps = 10;
  const keepBefore = 10; // frames of the untouched strip kept before the first balloon is painted
  const hold = 1_600;
  const scrollMs = 6_000;
  const scrollPx = 3_000;
  const end = 1_000;
  const frames: Array<{ buf: Uint8Array; at: number }> = [];
  let firstPaint: number | null = null;
  const started = Date.now();
  for (let i = 0; ; i += 1) {
    const now = Date.now();
    if (firstPaint === null && now - started > 120_000) throw new Error("demo: nothing was painted in 120 s");
    let y = start;
    if (firstPaint !== null) {
      const since = now - firstPaint;
      if (since > hold + scrollMs + end) break;
      y = start + scrollPx * easeInOut(Math.min(1, Math.max(0, (since - hold) / scrollMs)));
    }
    await page.evaluate((to: number) => window.scrollTo(0, to), Math.round(y));
    const buf = await page.screenshot({ type: "jpeg", quality: 92 });
    frames.push({ buf, at: Date.now() });
    if (firstPaint === null) {
      if (frames.length > keepBefore + 1) frames.shift();
      if (i % 2 === 0 && (await paintedUnits(page)).length > 0) firstPaint = Date.now();
    }
    const wait = 1000 / fps - (Date.now() - now);
    if (wait > 0) await sleep(wait);
  }
  const t0 = frames[0]?.at ?? 0;
  const list: Frame[] = [];
  for (const [i, frame] of frames.entries()) {
    const file = `frame-${String(i + 1).padStart(4, "0")}.jpg`;
    await writeFile(path.join(dir, file), frame.buf);
    list.push({ file, t: frame.at - t0 });
  }
  await writeFile(path.join(dir, "frames.json"), JSON.stringify({ fps, frames: list }, null, 2));
  const s = await summary(page);
  log(
    `demo: ${list.length} frames over ${((list.at(-1)?.t ?? 0) / 1000).toFixed(1)} s, images ${JSON.stringify(s?.images)}`,
  );
  // A still of the translated strip (its second panel) and its transcript, for the store screenshots.
  await waitAllImages(page, ["done"], 1, 120_000);
  await page.setViewport(STRIP_STILL_VIEWPORT);
  await page.evaluate((to: number) => window.scrollTo(0, to), top + 1_000);
  await settle(page);
  await page.screenshot({ path: path.join(raw, "strip-section.png") });
  await captureSidePanel(h, page, raw, "sidepanel-strip");
  h.api.setScenario({ oracleLang: "en" });
  await page.close();
}

// ---- main ----

const raw =
  args.raw !== undefined ? path.resolve(args.raw) : await mkdtemp(path.join(os.tmpdir(), "ctv-docs-raw-"));
const gtDir = await mkdtemp(path.join(os.tmpdir(), "ctv-docs-gt-"));
await mkdir(raw, { recursive: true });
await writeEnglishGroundTruth(gtDir, [...PAGED_SETS, DEMO_SET]);
const h = await launch({
  api: { gtDir, model: MODEL, scenario: { oracleLang: "en" } },
  settings: { translate: { targetLang: "en" }, ui: { locale: "en" } },
});
try {
  await enableSite(h);
  const pages: Page[] = [];
  for (const set of PAGED_SETS) pages.push(await capturePaged(h, set, raw));
  const spanish = pages[1];
  if (spanish === undefined) throw new Error("es-p01 was not captured");
  await captureSidePanel(h, spanish, raw, "sidepanel");
  await capturePopup(h, spanish, raw);
  await captureOptions(h, raw);
  for (const page of pages) await page.close();
  if (!args["skip-demo"]) await captureDemo(h, raw);
  const chats = h.api.requests().filter((r) => r.path === "/v1/chat/completions");
  log(`${chats.length} chat requests, all answered by the local mock at ${h.api.url}`);
  await writeFile(path.join(raw, "shots.json"), JSON.stringify({ dpr }, null, 2));
  await waitUntil(
    "no request in flight",
    () => h.api.inFlight(),
    (n) => n === 0,
    10_000,
  );
} finally {
  await h.close();
  await rm(gtDir, { recursive: true, force: true });
}

await mkdir(OUT, { recursive: true });
const python = process.env["PYTHON"] ?? "python";
const composer = path.join(ROOT, "tools/docs/compose_images.py");
const composed = spawnSync(python, ["-I", "-B", composer, "--raw", raw, "--out", OUT, "--root", ROOT], {
  stdio: "inherit",
});
if (composed.status !== 0) {
  throw new Error(`${python} ${path.relative(ROOT, composer)} failed (raw captures kept in ${raw})`);
}
if (args.raw === undefined) await rm(raw, { recursive: true, force: true });
log(`images written to ${path.relative(ROOT, OUT) || "."}`);
