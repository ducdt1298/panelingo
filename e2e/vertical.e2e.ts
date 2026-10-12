// CJK targets and vertical lettering. The mock's oracle answers from ground truth; this file writes a temporary copy
// that adds reference translations in the target language (`refs.<code>`, the parallel sentences of
// test/fixtures/sentences, which share `vi` with the generated units) and sets the mock's `oracleLang`:
//   1. ja-p01 (tategaki balloons) translated into Traditional Chinese: the vertical balloons are lettered in
//      vertical-rl columns inside the balloon, the horizontal sign stays horizontal, in a CJK system font.
//   2. The same page with render.verticalText "never": every unit horizontal.
//   3. ko-p01 (horizontal balloons) translated into Japanese: horizontal CJK lettering that fits the balloons.
// CTV_SHOT_DIR=<dir> saves screenshots of each page.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import { ROOT } from "./helpers/chrome.ts";
import { enableSite, sleep, withDiagnostics, type GroundTruth, type OpenedPage } from "./helpers/flows.ts";
import { launch, waitForSummary, type Harness } from "./helpers/launch.ts";

const GENERATED = path.join(ROOT, "test/fixtures/generated");

interface Sentence {
  text: string;
  vi: string;
}

interface GtUnitRefs {
  id: number;
  kind: string;
  type: string;
  orientation: string;
  vi: string | null;
  bubble: { x1: number; y1: number; x2: number; y2: number } | null;
  refs?: Record<string, string>;
}

interface Shown {
  unit: string | null;
  vertical: boolean;
  writingMode: string;
  fontFamily: string;
  overflow: boolean;
  text: string;
  /** Union of the line boxes, client px. */
  box: { left: number; top: number; right: number; bottom: number };
}

let h: Harness;
let gtDir = "";

/** Copies `set`'s ground truth into gtDir with refs[code] from the parallel sentences of `sentences` (by vi). */
async function addRefs(set: string, code: string, sentences: string): Promise<void> {
  const file = JSON.parse(
    await readFile(path.join(ROOT, "test/fixtures/sentences", `${sentences}.json`), "utf8"),
  ) as {
    lines: Sentence[];
    actionLines?: Sentence[];
  };
  const byVi = new Map([...file.lines, ...(file.actionLines ?? [])].map((s) => [s.vi, s.text]));
  const gt = JSON.parse(await readFile(path.join(GENERATED, `${set}.gt.json`), "utf8")) as {
    units: GtUnitRefs[];
  };
  for (const unit of gt.units) {
    const text = unit.vi === null ? undefined : byVi.get(unit.vi);
    if (text !== undefined) unit.refs = { ...unit.refs, [code]: text };
  }
  await writeFile(path.join(gtDir, `${set}.gt.json`), JSON.stringify(gt));
}

before(async () => {
  gtDir = await mkdtemp(path.join(os.tmpdir(), "ctv-vertical-gt-"));
  await addRefs("ja-p01", "zh-tw", "zh");
  await addRefs("ko-p01", "ja", "ja");
  h = await launch({ api: { gtDir } });
  await enableSite(h);
});

after(async () => {
  await h?.close();
  if (gtDir !== "") await rm(gtDir, { recursive: true, force: true });
});

async function open(set: string): Promise<OpenedPage> {
  const page = await h.browser.newPage();
  await page.setViewport({ width: 900, height: 1300 });
  const opened: OpenedPage = { page, logs: [] };
  page.on("console", (message) => opened.logs.push(`${message.type()}: ${message.text()}`));
  await page.goto(`${h.fixtures.readerUrl}/paged/?set=${set}`);
  await waitForSummary(page, (s) => Object.values(s.images).some((state) => state === "done"));
  await sleep(300); // fonts measured, last units painted
  return opened;
}

async function shownUnits(page: Page): Promise<Shown[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll("[data-ctv-host]")].flatMap((host) =>
      [...(host.shadowRoot?.querySelectorAll(".unit") ?? [])].flatMap((unit) => {
        const lines = [...unit.querySelectorAll<HTMLElement>(".line")];
        const first = lines[0];
        if (first === undefined) return [];
        const rects = lines.map((l) => l.getBoundingClientRect());
        const style = getComputedStyle(first);
        return [
          {
            unit: unit.getAttribute("data-unit"),
            vertical: unit.hasAttribute("data-vertical"),
            writingMode: style.writingMode,
            fontFamily: style.fontFamily,
            overflow: unit.hasAttribute("data-overflow"),
            text: lines.map((l) => l.textContent ?? "").join(""),
            box: {
              left: Math.min(...rects.map((r) => r.left)),
              top: Math.min(...rects.map((r) => r.top)),
              right: Math.max(...rects.map((r) => r.right)),
              bottom: Math.max(...rects.map((r) => r.bottom)),
            },
          },
        ];
      }),
    ),
  );
}

/** A ground-truth box in client px (the page shows one image). */
async function toClient(
  page: Page,
  gt: GroundTruth,
  b: { x1: number; y1: number; x2: number; y2: number },
): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const rect = await page.evaluate(() => {
    const r = document.querySelector("img")?.getBoundingClientRect();
    return r === undefined ? null : { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  assert.ok(rect !== null);
  const sx = rect.width / gt.width;
  const sy = rect.height / gt.height;
  return {
    left: rect.left + b.x1 * sx,
    top: rect.top + b.y1 * sy,
    right: rect.left + b.x2 * sx,
    bottom: rect.top + b.y2 * sy,
  };
}

function centre(box: Shown["box"]): { x: number; y: number } {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

async function balloons(
  page: Page,
  set: string,
): Promise<Array<{ unit: GtUnitRefs; shown: Shown; balloon: Shown["box"] }>> {
  const gt = JSON.parse(await readFile(path.join(gtDir, `${set}.gt.json`), "utf8")) as GroundTruth & {
    units: GtUnitRefs[];
  };
  const shown = await shownUnits(page);
  const out: Array<{ unit: GtUnitRefs; shown: Shown; balloon: Shown["box"] }> = [];
  for (const unit of gt.units) {
    if (unit.kind !== "bubble" || unit.bubble === null || unit.type === "ignore") continue;
    const balloon = await toClient(page, gt, unit.bubble);
    const match = shown.find((s) => {
      const c = centre(s.box);
      return c.x >= balloon.left && c.x <= balloon.right && c.y >= balloon.top && c.y <= balloon.bottom;
    });
    assert.ok(match !== undefined, `${set} unit ${unit.id} (${unit.type}) is painted`);
    out.push({ unit, shown: match, balloon });
  }
  return out;
}

async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env["CTV_SHOT_DIR"];
  if (dir !== undefined && dir !== "")
    await page.screenshot({ path: path.join(dir, `vertical-${name}.png`) });
}

const squash = (s: string): string => s.replace(/\s+/gu, "");

test("ja-p01 into Traditional Chinese: vertical balloons get vertical-rl columns that fit; the sign stays horizontal", async () => {
  await h.patchSettings({ translate: { targetLang: "zh-tw" } });
  h.api.setScenario({ oracleLang: "zh-tw" });
  const opened = await open("ja-p01");
  await withDiagnostics(h, opened, async () => {
    const { page } = opened;
    await shoot(page, "zh-tw");
    const found = await balloons(page, "ja-p01");
    assert.ok(found.length >= 6, `${found.length} balloons`);
    let vertical = 0;
    for (const { unit, shown, balloon } of found) {
      assert.equal(unit.orientation, "v");
      // The engine estimates each unit's orientation from its text boxes: tall tategaki balloons are always "v";
      // a nearly square one may come out "h" and is then lettered horizontally, like any horizontal balloon.
      const bubble = unit.bubble ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
      if (bubble.y2 - bubble.y1 > 1.2 * (bubble.x2 - bubble.x1)) {
        assert.equal(shown.vertical, true, `tall balloon ${unit.id} is lettered vertically`);
      }
      assert.equal(shown.writingMode, shown.vertical ? "vertical-rl" : "horizontal-tb", `unit ${unit.id}`);
      if (shown.vertical) vertical += 1;
      assert.match(shown.fontFamily, /^"Microsoft JhengHei UI"/u);
      assert.equal(shown.overflow, false, `unit ${unit.id} fits without "…"`);
      assert.equal(
        squash(shown.text),
        squash(unit.refs?.["zh-tw"] ?? ""),
        `unit ${unit.id} shows its translation`,
      );
      const tol = 2;
      assert.ok(
        shown.box.left >= balloon.left - tol &&
          shown.box.right <= balloon.right + tol &&
          shown.box.top >= balloon.top - tol &&
          shown.box.bottom <= balloon.bottom + tol,
        `unit ${unit.id}: lettering ${JSON.stringify(shown.box)} inside the balloon ${JSON.stringify(balloon)}`,
      );
      if (shown.vertical) {
        assert.ok(
          shown.box.bottom - shown.box.top > shown.box.right - shown.box.left,
          `unit ${unit.id} is taller than wide`,
        );
      }
    }
    assert.ok(vertical >= 5, `${vertical} vertical balloons`);
    // The sign is horizontal text in the source: it stays horizontal when it is painted (free text depends on the
    // detector's recall).
    const horizontal = (await shownUnits(page)).filter((s) => !s.vertical);
    for (const s of horizontal) assert.equal(s.writingMode, "horizontal-tb");
  });
});

test('render.verticalText "never": the same balloons are lettered horizontally', async () => {
  await h.patchSettings({ render: { verticalText: "never" } });
  const opened = await open("ja-p01");
  try {
    await withDiagnostics(h, opened, async () => {
      const { page } = opened;
      await shoot(page, "never");
      const found = await balloons(page, "ja-p01");
      assert.ok(found.length >= 6);
      for (const { unit, shown } of found) {
        assert.equal(shown.vertical, false, `unit ${unit.id}`);
        assert.equal(shown.writingMode, "horizontal-tb", `unit ${unit.id}`);
      }
    });
  } finally {
    await h.patchSettings({ render: { verticalText: "auto" } });
  }
});

test("ko-p01 into Japanese: horizontal balloons get horizontal Japanese lettering that fits", async () => {
  await h.patchSettings({ translate: { targetLang: "ja" } });
  h.api.setScenario({ oracleLang: "ja" });
  const opened = await open("ko-p01");
  await withDiagnostics(h, opened, async () => {
    const { page } = opened;
    await shoot(page, "ja");
    const found = await balloons(page, "ko-p01");
    assert.ok(found.length >= 6, `${found.length} balloons`);
    for (const { unit, shown, balloon } of found) {
      assert.equal(shown.vertical, false, `unit ${unit.id} stays horizontal`);
      assert.equal(shown.writingMode, "horizontal-tb");
      assert.match(shown.fontFamily, /^"Yu Gothic UI"/u);
      assert.equal(squash(shown.text), squash(unit.refs?.ja ?? ""), `unit ${unit.id} shows its translation`);
      const tol = 2;
      assert.ok(
        shown.box.left >= balloon.left - tol &&
          shown.box.right <= balloon.right + tol &&
          shown.box.top >= balloon.top - tol &&
          shown.box.bottom <= balloon.bottom + tol,
        `unit ${unit.id}: lettering inside the balloon`,
      );
    }
  });
});
