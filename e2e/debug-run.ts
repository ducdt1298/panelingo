// Manual debugging aid (not a test): node e2e/debug-run.ts [set] — runs the paged flow on a fixture set against the
// mock OpenAI-compatible server and prints the content summary, mock requests, the engine's IndexedDB log and page
// console output.
// Set CTV_HEADED=1 to watch it.

import type { Browser } from "puppeteer-core";
import { launch, summary } from "./helpers/launch.ts";

const set = process.argv[2] ?? "ko-p01";
const h = await launch({ headed: process.env.CTV_HEADED === "1" });
const logs: string[] = [];

async function engineLogs(browser: Browser): Promise<string[]> {
  const engine = browser.targets().find((t) => t.url().includes("offscreen.html"));
  if (engine === undefined) return ["(no offscreen target)"];
  const session = await engine.createCDPSession();
  const result = await session.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise((resolve) => {
      const r = indexedDB.open("ctv");
      r.onsuccess = () => {
        const q = r.result.transaction("logs").objectStore("logs").getAll();
        q.onsuccess = () => resolve(q.result.map((e) => e.level + " " + e.msg + " " + JSON.stringify(e.data ?? {}) + (e.code ? " code=" + e.code : "")));
      };
      r.onerror = () => resolve(["cannot open ctv"]);
    })`,
  });
  return (
    (result.result.value as string[] | undefined) ?? [
      JSON.stringify(result.exceptionDetails ?? result.result),
    ]
  );
}

try {
  const siteKey = new URL(h.fixtures.readerUrl).origin;
  await h.setStorage({ [`site:${siteKey}`]: { enabled: true, mode: "auto" } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const page = await h.browser.newPage();
  page.on("console", (m) => logs.push(`[page:${m.type()}] ${m.text()}`));
  await page.goto(`${h.fixtures.readerUrl}/paged/?set=${set}`);
  for (let i = 0; i < 120; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const s = await summary(page);
    if (
      s !== null &&
      Object.values(s.images).some((v) => ["done", "error", "partial", "no-text", "refused"].includes(v))
    )
      break;
  }
  console.log("SUMMARY", JSON.stringify(await summary(page)));
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.CTV_SETTLE_MS ?? 0)));
  const units = await page.evaluate(() =>
    [...document.querySelectorAll("[data-ctv-host]")].flatMap((host) =>
      [...(host.shadowRoot?.querySelectorAll(".unit") ?? [])].map((unit) => ({
        unit: unit.getAttribute("data-unit"),
        erase: unit.getAttribute("data-erase"),
        fontPx: unit.querySelector<HTMLElement>(".line")?.style.fontSize ?? null,
        plate: unit.querySelector<HTMLElement>(".plate")?.style.backgroundColor ?? null,
      })),
    ),
  );
  console.log("UNITS", JSON.stringify(units));
  if (process.env.CTV_SHOT !== undefined)
    await page.screenshot({ path: process.env.CTV_SHOT, fullPage: true });
  const requests = h.api.requests().map((r) => ({
    path: r.path,
    status: r.status,
    outcome: r.outcome,
    n: r.n,
    oracle: r.oracle?.matched.length ?? null,
    error: r.errorCode,
  }));
  console.log("API", JSON.stringify(requests));
  await new Promise((resolve) => setTimeout(resolve, 1500)); // log batches flush every 1 s
  console.log("ENGINE LOG\n" + (await engineLogs(h.browser)).join("\n"));
} finally {
  console.log("PAGE LOG\n" + logs.join("\n"));
  await h.close();
}
