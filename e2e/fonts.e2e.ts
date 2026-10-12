// Lettering faces on ko-p01: the caption is lettered in CTV Round (Mali 400), dialogue and thoughts in CTV Comic
// (Patrick Hand), a sign in CTV Round bold, and every family loads from the bundled bytes (no fallback font). Sizes
// stay within the lettering bound of e2e/lettering.e2e.ts. With render.font "mali", dialogue is lettered in CTV
// Round too.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Page } from "puppeteer-core";
import {
  enableSite,
  groundTruth,
  paintedFor,
  paintedUnits,
  withDiagnostics,
  type GtUnit,
  type OpenedPage,
  type PaintedUnit,
} from "./helpers/flows.ts";
import { launch, waitForSummary, type Harness } from "./helpers/launch.ts";

interface Lettered {
  unit: string | null;
  face: string | null;
  family: string;
  weight: string;
  text: string;
}

let h: Harness;

before(async () => {
  h = await launch();
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

/** Face, computed font family and weight of every painted unit's first line (open shadow roots in test builds). */
async function lettering(page: Page): Promise<Lettered[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll("[data-ctv-host]")].flatMap((host) =>
      [...(host.shadowRoot?.querySelectorAll(".unit") ?? [])].map((unit) => {
        const line = unit.querySelector<HTMLElement>(".line");
        const style = line === null ? null : getComputedStyle(line);
        return {
          unit: unit.getAttribute("data-unit"),
          face: unit.getAttribute("data-face"),
          family: style?.fontFamily ?? "",
          weight: style?.fontWeight ?? "",
          text: [...unit.querySelectorAll(".line")].map((l) => l.textContent ?? "").join(" "),
        };
      }),
    ),
  );
}

/** The families registered in the page's font set with their loaded weights ("CTV Round 400", …). */
async function loadedFaces(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const out = new Set<string>();
    document.fonts.forEach((face) => {
      if (face.status === "loaded") out.add(`${face.family.replace(/["']/g, "")} ${face.weight}`);
    });
    return [...out].sort();
  });
}

async function openKoP01(): Promise<OpenedPage> {
  const page = await h.browser.newPage();
  const opened: OpenedPage = { page, logs: [] };
  page.on("console", (message) => opened.logs.push(`${message.type()}: ${message.text()}`));
  await page.goto(`${h.fixtures.readerUrl}/paged/?set=ko-p01`);
  return opened;
}

function find(unit: GtUnit, painted: readonly PaintedUnit[], lettered: readonly Lettered[]): Lettered {
  const shown = paintedFor(unit, painted);
  assert.ok(shown !== undefined, `unit ${unit.id} (${unit.type}) is painted`);
  const line = lettered.find((l) => l.unit === shown.unit);
  assert.ok(line !== undefined, `unit ${unit.id} has lines`);
  return line;
}

test("ko-p01: captions in CTV Round, dialogue in CTV Comic, signs in bold; sizes still match the source", async () => {
  const opened = await openKoP01();
  await withDiagnostics(h, opened, async () => {
    const { page } = opened;
    const gt = await groundTruth("ko-p01");
    await waitForSummary(page, (s) => Object.values(s.images).some((state) => state === "done"));
    const painted = await paintedUnits(page);
    const lettered = await lettering(page);

    const caption = gt.units.find((u) => u.type === "narration");
    assert.ok(caption !== undefined);
    const round = find(caption, painted, lettered);
    assert.equal(round.face, "round");
    assert.match(round.family, /^"CTV Round"/u);
    assert.equal(round.weight, "400");

    const dialogue = gt.units.filter((u) => u.type === "dialogue" || u.type === "thought");
    assert.ok(dialogue.length >= 4);
    for (const unit of dialogue) {
      const line = find(unit, painted, lettered);
      assert.equal(line.face, "comic", `unit ${unit.id}`);
      assert.match(line.family, /^"CTV Comic"/u, `unit ${unit.id}`);
    }

    // Free text depends on the detector's recall: a sign, when painted, is bold Mali.
    const sign = gt.units.find((u) => u.type === "sign");
    const signShown = sign === undefined ? undefined : paintedFor(sign, painted);
    if (sign !== undefined && signShown !== undefined) {
      const line = find(sign, painted, lettered);
      assert.equal(line.face, "round-bold");
      assert.match(line.family, /^"CTV Round"/u);
      assert.equal(line.weight, "700");
    }

    // Bundled bytes, not the fallback: both weights of Mali and Patrick Hand are in the page's font set.
    const faces = await loadedFaces(page);
    for (const want of ["CTV Comic 400", "CTV Round 400", "CTV Round 700"]) {
      assert.ok(faces.includes(want), `${want} loaded (${faces.join(", ")})`);
    }

    // Size: capitals matched per face, shrunk only to fit: within the bound of the lettering test.
    for (const unit of [caption, ...dialogue]) {
      const shown = paintedFor(unit, painted);
      const ratio = (shown?.fontPx ?? 0) / unit.fontPx;
      assert.ok(
        ratio >= 0.5 && ratio <= 1.5,
        `unit ${unit.id}: ${shown?.fontPx ?? "?"} px for source lettering of ${unit.fontPx} px`,
      );
    }
  });
});

test("render.font mali: dialogue is lettered in CTV Round as well", async () => {
  await h.patchSettings({ render: { font: "mali" } });
  const opened = await openKoP01();
  try {
    await withDiagnostics(h, opened, async () => {
      const { page } = opened;
      const gt = await groundTruth("ko-p01");
      await waitForSummary(page, (s) => Object.values(s.images).some((state) => state === "done"));
      const painted = await paintedUnits(page);
      const lettered = await lettering(page);
      for (const unit of gt.units.filter((u) => u.type === "dialogue" || u.type === "thought")) {
        const line = find(unit, painted, lettered);
        assert.equal(line.face, "round", `unit ${unit.id}`);
        assert.match(line.family, /^"CTV Round"/u, `unit ${unit.id}`);
        const ratio = (paintedFor(unit, painted)?.fontPx ?? 0) / unit.fontPx;
        assert.ok(ratio >= 0.5 && ratio <= 1.5, `unit ${unit.id}: ratio ${ratio}`);
      }
      assert.ok(!(await loadedFaces(page)).includes("CTV Comic 400"), "Patrick Hand is not even loaded");
    });
  } finally {
    await h.patchSettings({ render: { font: "patrick-hand" } });
  }
});
