// node tools/mock-openai/cli.ts [--port 4925] [--host 127.0.0.1] [--model mock-vision] [--api-key <key>]
//   [--gt-dir test/fixtures/generated] [--replay-dir test/fixtures/sse] [--scenario <json | path.json>]
//   [--health <preset | json>] [--quiet]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseJsonFile } from "./oracle.ts";
import { HEALTH_PRESETS, LATENCY_PRESETS, parseScenarioPatch, type HealthPreset } from "./scenarios.ts";
import { createMockServer } from "./server.ts";
import { DEFAULT_MODEL } from "./wire.ts";

const HELP = `Mock OpenAI-compatible vision chat API (tests, E2E runs, offline demos).

Usage: node tools/mock-openai/cli.ts [options]      (npm run mock-api)
  --port <n>          listen port (default 4925; 0 = any free port)
  --host <host>       listen address (default 127.0.0.1)
  --model <id>        model listed by GET /v1/models (default ${DEFAULT_MODEL})
  --api-key <key>     require "Authorization: Bearer <key>" on /v1 routes (default: no key)
  --gt-dir <dir>      ground truth for oracle mode (header x-ctv-test-units), e.g. test/fixtures/generated
  --replay-dir <dir>  recorded .sse transcripts for scenario.replayFile, e.g. test/fixtures/sse
  --scenario <json>   initial scenario as JSON, or a path to a JSON file
                      (latencyProfile presets: ${Object.keys(LATENCY_PRESETS).join(", ")})
  --health <preset>   initial GET /v1/models answer: ${HEALTH_PRESETS.join(", ")}, or a JSON payload
  --quiet             do not log one line per request

API routes:     GET /v1/models, GET /v1/models/<id>, POST /v1/chat/completions (stream true/false)
Control routes: GET|POST /__scenario, GET|POST /__health, GET /__requests, POST /__reset,
                GET|POST /__mark?id=&e=, GET /__marks, GET|POST /slow?headersDelayMs=&bodyGapMs=&id=
Per-request override: POST /v1/chat/completions?scenario=<url-encoded JSON>`;

function readJsonArg(value: string): unknown {
  const text =
    value.trim().startsWith("{") || value.trim().startsWith('"') ? value : readFileSync(value, "utf8");
  return parseJsonFile(text);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "4925" },
      host: { type: "string", default: "127.0.0.1" },
      model: { type: "string" },
      "api-key": { type: "string" },
      "gt-dir": { type: "string" },
      "replay-dir": { type: "string" },
      scenario: { type: "string" },
      health: { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer 0-65535, got ${values.port}`);
  }
  let health: HealthPreset | object | undefined;
  if (values.health !== undefined) {
    health = (HEALTH_PRESETS as readonly string[]).includes(values.health)
      ? (values.health as HealthPreset)
      : (readJsonArg(values.health) as object);
  }
  const apiKey = values["api-key"];
  const mock = await createMockServer({
    host: values.host,
    port,
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(values["gt-dir"] !== undefined ? { gtDir: values["gt-dir"] } : {}),
    ...(values["replay-dir"] !== undefined ? { replayDir: values["replay-dir"] } : {}),
    ...(values.scenario !== undefined ? { scenario: parseScenarioPatch(readJsonArg(values.scenario)) } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(values.quiet ? {} : { log: (line: string) => console.log(line) }),
  });
  console.log(`mock OpenAI-compatible API listening on ${mock.url} (Ctrl+C to stop)`);
  console.log(`  base URL: ${mock.baseUrl}`);
  console.log(`  model:    ${mock.model}`);
  console.log(`  API key:  ${apiKey !== undefined && apiKey !== "" ? "required (--api-key)" : "none"}`);
  const stop = (): void => {
    mock.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
