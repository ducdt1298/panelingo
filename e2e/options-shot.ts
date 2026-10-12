// Debug aid: node e2e/options-shot.ts <out.png> [locale] [light|dark] — full-page screenshot of the options page of
// the build ($CTV_EXTENSION_DIR or dist/) with one site's editor and the Advanced section open. The API settings point
// at a local mock OpenAI-compatible server; any other network request from the page is aborted.
import puppeteer, { TargetType } from "puppeteer-core";
import { createMockServer } from "../tools/mock-openai/server.ts";
import { chromePath, extensionDir } from "./helpers/chrome.ts";

const out = process.argv[2] ?? "options.png";
const locale = process.argv[3] ?? "en";
const scheme = process.argv[4] === "dark" ? "dark" : "light";
const api = await createMockServer({ port: 0 });
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  pipe: true,
  enableExtensions: [extensionDir()],
});
try {
  const target = await browser.waitForTarget(
    (t) => t.type() === TargetType.SERVICE_WORKER && t.url().endsWith("/sw.js"),
  );
  const sw = await target.worker();
  if (sw === null) throw new Error("service worker target has no worker handle");
  // Let onInstalled seed the defaults first: it read-merge-writes the settings and would overwrite ours.
  for (let i = 0; i < 30; i += 1) {
    const seeded = await sw.evaluate(
      async () => (await chrome.storage.local.get("settings")).settings !== undefined,
    );
    if (seeded) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await sw.evaluate(
    (settings, site) => chrome.storage.local.set({ settings, "site:https://reader.example.com": site }),
    {
      ui: { locale },
      api: { baseUrl: api.baseUrl, model: api.model, apiKey: "" },
      render: { maxFontPx: 48, font: "mali" },
      memory: { historyMaxLines: 10 },
      privacy: { ackUploadNoticeAt: Date.now() },
    },
    {
      enabled: true,
      mode: "manual",
      layout: "paged-rtl",
      sourceLang: "ja",
      extraFrameOrigins: ["https://viewer.example.com"],
    },
  );
  const id = new URL(target.url()).host;
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (/^(?:chrome-extension|data|blob):/.test(url) || url.startsWith(`${api.url}/`))
      void request.continue();
    else void request.abort();
  });
  await page.setViewport({ width: 900, height: 900 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.goto(`chrome-extension://${id}/ui/options.html`);
  await page.waitForSelector("#site-1-toggle");
  await page.click("#site-1-toggle");
  await page.click("#advanced-details > summary");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.screenshot({ path: out, fullPage: true });
} finally {
  await browser.close();
  await api.close();
}
