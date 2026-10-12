// Type-checks every environment with its own tsconfig (browser, service worker, pure shared code, Node tools,
// tests). Projects whose tsconfig does not exist yet are skipped, so new directories join automatically.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { NODE_MODULES, ROOT } from "./lib/paths.ts";

const PROJECTS = [
  "tsconfig.json",
  "src/sw/tsconfig.json",
  "src/shared/tsconfig.json",
  "scripts/tsconfig.json",
  "tools/tsconfig.json",
  "test/tsconfig.json",
  "e2e/tsconfig.json",
];

const tsc = path.join(NODE_MODULES, "typescript", "bin", "tsc");
let failed = 0;

for (const project of PROJECTS) {
  if (!existsSync(path.join(ROOT, project))) {
    continue;
  }
  const started = Date.now();
  const result = spawnSync(process.execPath, [tsc, "-p", project], { cwd: ROOT, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`typecheck ok   ${project} (${seconds}s)`);
  } else {
    failed += 1;
    console.error(`typecheck FAIL ${project}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
