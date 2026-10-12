// Erasing and lettering on ko-p01: with a slow first token from the mock, nothing is painted (no patch, no plate, no
// text) before the unit's translation arrived; the painted balloons carry a drawn erase patch and a font size close
// to the source lettering.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  balloonUnits,
  chats,
  enableSite,
  groundTruth,
  paintedFor,
  paintedUnits,
  sleep,
  withDiagnostics,
  type OpenedPage,
} from "./helpers/flows.ts";
import { launch, waitForSummary, type Harness } from "./helpers/launch.ts";

/** Time to first token of every chat answer in this file. */
const FIRST_TOKEN_MS = 1_500;

interface Sighting {
  unit: string;
  /** Page Date.now() when the unit node was first seen. */
  t: number;
  text: string;
  patch: boolean;
  plate: boolean;
}

let h: Harness;

before(async () => {
  h = await launch();
  await enableSite(h);
});

after(async () => {
  await h?.close();
});

test("ko-p01: units appear only after their translation arrived, with erase patches and fitting font sizes", async () => {
  h.api.setScenario({ name: "slow-first-token", firstChunkDelayMs: FIRST_TOKEN_MS });
  const page = await h.browser.newPage();
  const opened: OpenedPage = { page, logs: [] };
  page.on("console", (message) => opened.logs.push(`${message.type()}: ${message.text()}`));
  // Samples the (open, test-build) overlay every 20 ms from the start of the document: the first sighting of every
  // unit node, with what it showed at that moment.
  await page.evaluateOnNewDocument(() => {
    const seen = new Map<string, Sighting>();
    (window as unknown as { __ctvSightings: Map<string, Sighting> }).__ctvSightings = seen;
    setInterval(() => {
      for (const host of document.querySelectorAll("[data-ctv-host]")) {
        for (const unit of host.shadowRoot?.querySelectorAll(".unit") ?? []) {
          const key = `${host.getAttribute("data-ctv-image") ?? "?"}/${unit.getAttribute("data-unit") ?? "?"}`;
          if (seen.has(key)) continue;
          seen.set(key, {
            unit: key,
            t: Date.now(),
            text: [...unit.querySelectorAll(".line")].map((l) => l.textContent ?? "").join(" "),
            patch: unit.querySelector(".patch") !== null,
            plate: unit.querySelector(".plate") !== null,
          });
        }
      }
    }, 20);
  });
  await page.goto(`${h.fixtures.readerUrl}/paged/?set=ko-p01`);

  await withDiagnostics(h, opened, async () => {
    const gt = await groundTruth("ko-p01");
    await waitForSummary(page, (s) => Object.values(s.images).some((state) => state === "done"));
    await sleep(100); // one more sampling round
    const painted = await paintedUnits(page);
    const sightings = await page.evaluate(() => [
      ...(window as unknown as { __ctvSightings: Map<string, Sighting> }).__ctvSightings.values(),
    ]);
    const requests = chats(h);
    assert.ok(requests.length >= 1);
    assert.ok(requests.every((r) => r.scenarioName === "slow-first-token"));
    assert.equal(sightings.length, painted.length, "every painted unit was sampled");

    // 1. Nothing before the first token of any answer, and every unit after the first token of its own answer.
    const firstToken = Math.min(...requests.map((r) => r.t)) + FIRST_TOKEN_MS;
    const slack = 50; // two clocks of the same machine, sampled every 20 ms
    for (const s of sightings) {
      assert.ok(s.t >= firstToken - slack, `${s.unit} painted ${firstToken - s.t} ms before any translation`);
      assert.ok(s.text.trim() !== "", `${s.unit} appeared without its translation (patch ${s.patch})`);
    }
    for (const unit of balloonUnits(gt)) {
      const shown = paintedFor(unit, painted);
      if (shown === undefined) continue;
      const own = requests.filter((r) => r.oracle?.matched.some((m) => m.gtId === String(unit.id)) === true);
      assert.ok(own.length > 0, `the mock translated unit ${unit.id}`);
      const arrived = Math.min(...own.map((r) => r.t)) + FIRST_TOKEN_MS;
      const seen = sightings.find((s) => s.text === shown.text);
      assert.ok(seen !== undefined && seen.t >= arrived - slack, `unit ${unit.id} painted before its answer`);
    }

    // 2. Erase: every lettered balloon hides the source text, mostly with a reconstructed patch.
    const balloons = balloonUnits(gt).flatMap((unit) => {
      const shown = paintedFor(unit, painted);
      return shown === undefined ? [] : [{ unit, shown }];
    });
    assert.equal(balloons.length, balloonUnits(gt).length, "every balloon painted");
    for (const { unit, shown } of balloons) {
      assert.ok(
        shown.erase === "patch" || shown.erase === "plate",
        `unit ${unit.id} has no erase (${String(shown.erase)})`,
      );
    }
    const patched = balloons.filter((b) => b.shown.erase === "patch").length;
    assert.ok(patched >= Math.ceil(balloons.length / 2), `only ${patched}/${balloons.length} erase patches`);
    // The patches are drawn: each canvas holds opaque pixels.
    const drawn = await page.evaluate(() =>
      [...document.querySelectorAll("[data-ctv-host]")].flatMap((host) =>
        [...(host.shadowRoot?.querySelectorAll<HTMLCanvasElement>("canvas.patch") ?? [])].map((canvas) => {
          const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
          let opaque = 0;
          for (let i = 3; data !== undefined && i < data.length; i += 4) if ((data[i] ?? 0) > 0) opaque += 1;
          return { w: canvas.width, h: canvas.height, opaque };
        }),
      ),
    );
    assert.equal(drawn.length, patched);
    for (const canvas of drawn) {
      assert.ok(canvas.w > 0 && canvas.h > 0 && canvas.opaque > 0, `empty patch ${JSON.stringify(canvas)}`);
    }

    // 3. Lettering: the fitted font size (natural px) stays close to the source lettering's size.
    for (const { unit, shown } of balloons) {
      assert.ok(shown.fontPx !== null && Number.isFinite(shown.fontPx), `unit ${unit.id} has no font size`);
      const ratio = (shown.fontPx ?? 0) / unit.fontPx;
      assert.ok(
        ratio >= 0.5 && ratio <= 1.5,
        `unit ${unit.id}: ${shown.fontPx ?? "?"} px for source lettering of ${unit.fontPx} px`,
      );
    }
  });
});
