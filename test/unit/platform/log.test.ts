import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger, silentLogger } from "../../../src/platform/log.ts";
import type { LogEntry } from "../../../src/shared/types.ts";

function capture(minLevel?: LogEntry["level"]): {
  entries: LogEntry[];
  log: ReturnType<typeof createLogger>;
} {
  const entries: LogEntry[] = [];
  const options = minLevel === undefined ? {} : { minLevel };
  const log = createLogger("engine", { ...options, now: () => 42, sinks: [(entry) => entries.push(entry)] });
  return { entries, log };
}

test("entries below the minimum level are dropped (default info)", () => {
  const { entries, log } = capture();
  log.debug("hidden");
  log.info("shown", { n: 1 });
  log.warn("warned", undefined, "image.http");
  log.error("failed");
  assert.deepEqual(
    entries.map((entry) => entry.level),
    ["info", "warn", "error"],
  );
  assert.deepEqual(entries[0], { t: 42, level: "info", ctx: "engine", msg: "shown", data: { n: 1 } });
  assert.deepEqual(entries[1], { t: 42, level: "warn", ctx: "engine", msg: "warned", code: "image.http" });
});

test("child loggers merge tags; later tags win", () => {
  const { entries, log } = capture("debug");
  const image = log.child({ frameKey: "1:0:D", imageKey: "3.0" });
  image.debug("decoded");
  image.child({ imageKey: "3.1", batchId: "b7" }).info("packed");
  assert.equal(entries[0]?.frameKey, "1:0:D");
  assert.equal(entries[0]?.imageKey, "3.0");
  assert.deepEqual(
    { frameKey: entries[1]?.frameKey, imageKey: entries[1]?.imageKey, batchId: entries[1]?.batchId },
    { frameKey: "1:0:D", imageKey: "3.1", batchId: "b7" },
  );
});

test("a throwing sink never breaks the caller or the other sinks", () => {
  const seen: string[] = [];
  const log = createLogger("cs", {
    sinks: [
      () => {
        throw new Error("sink down");
      },
      (entry) => seen.push(entry.msg),
    ],
  });
  assert.doesNotThrow(() => log.error("still logged"));
  assert.deepEqual(seen, ["still logged"]);
});

test("silentLogger accepts every call", () => {
  assert.doesNotThrow(() => {
    silentLogger.error("x");
    silentLogger.child({ imageKey: "1" }).warn("y");
  });
});
