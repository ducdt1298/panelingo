// node tools/fixture-server/cli.ts [--reader-port 8080] [--cdn-port 8081] [--root test/fixtures]
//                                  [--host 127.0.0.1] [--results-dir reports/fixture-results] [--quiet]
// Prints both origins and serves until Ctrl+C (SIGINT).

import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_RESULTS_DIR, DEFAULT_ROOT, createFixtureServer } from "./server.ts";

const USAGE = `usage: node tools/fixture-server/cli.ts [--reader-port 8080] [--cdn-port 8081] [--root test/fixtures]
       [--host 127.0.0.1] [--results-dir reports/fixture-results] [--quiet]`;

function port(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const n = Number(value);
  if (!/^\d+$/.test(value) || n > 65535) {
    throw new Error(`--${name} must be a port number (0-65535)`);
  }
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "reader-port": { type: "string" },
      "cdn-port": { type: "string" },
      root: { type: "string" },
      host: { type: "string" },
      "results-dir": { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const server = await createFixtureServer({
    root: values.root === undefined ? DEFAULT_ROOT : path.resolve(values.root),
    readerPort: port(values["reader-port"], 8080, "reader-port"),
    cdnPort: port(values["cdn-port"], 8081, "cdn-port"),
    resultsDir:
      values["results-dir"] === undefined ? DEFAULT_RESULTS_DIR : path.resolve(values["results-dir"]),
    quiet: values.quiet,
    ...(values.host === undefined ? {} : { host: values.host }),
  });
  console.log(`reader  ${server.readerUrl}/`);
  console.log(`cdn     ${server.cdnUrl}/`);
  console.log(`results ${server.resultsDir}`);
  console.log("Ctrl+C to stop");
  const stop = (): void => {
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(USAGE);
  process.exit(2);
});
