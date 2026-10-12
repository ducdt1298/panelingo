// Debug aid: node e2e/popup-shot.ts <out.png> — screenshots the popup of dist/ with the API settings pointed at a
// local mock OpenAI-compatible server; any other network request from the popup is aborted.
import puppeteer, { TargetType } from "puppeteer-core";
import { createMockServer } from "../tools/mock-openai/server.ts";
import { chromePath, extensionDir } from "./helpers/chrome.ts";

const out = process.argv[2] ?? "popup.png";
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
  await sw.evaluate((settings) => chrome.storage.local.set({ settings }), {
    api: { baseUrl: api.baseUrl, model: api.model, apiKey: "" },
  });
  const id = new URL(target.url()).host;
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (/^(?:chrome-extension|data|blob):/.test(url) || url.startsWith(`${api.url}/`))
      void request.continue();
    else void request.abort();
  });
  await page.setViewport({ width: 380, height: 640 });
  await page.goto(`chrome-extension://${id}/ui/popup.html`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await page.screenshot({ path: out });
} finally {
  await browser.close();
  await api.close();
}
