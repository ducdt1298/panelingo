// node e2e/run-gpu.ts [files...] (npm run test:e2e:gpu builds first): the E2E suite in a visible Chrome window
// (CTV_HEADED=1), where WebGPU and chrome.tabs.captureVisibleTab are real. Without arguments it runs every
// e2e/**/*.e2e.ts file, serially, like npm run test:e2e.

import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers/chrome.ts";

const files = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=1",
    "--test-timeout=180000",
    ...(files.length > 0 ? files : ["e2e/**/*.e2e.ts"]),
  ],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, CTV_HEADED: "1" } },
);
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
