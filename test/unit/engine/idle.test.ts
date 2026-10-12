// Idle teardown (L3): sw:engine-idle after idleCloseMin with 0 ports and no work; detector release after
// detectorReleaseMin without detections. Test builds scale 1 min to 1 s (platform/time.ts MINUTE_MS).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdleMonitor, IDLE_POLL_MS, type IdleMonitor } from "../../../src/engine/idle.ts";
import { createSettingsCache } from "../../../src/engine/settings-cache.ts";
import { minutesToMs } from "../../../src/platform/time.ts";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings.ts";
import { captureLogger, fakeDetector, ManualClock, type FakeDetector } from "./store/engine-fakes.ts";

interface World {
  clock: ManualClock;
  idle: IdleMonitor;
  detector: FakeDetector;
  state: { ports: number; workIdle: boolean; reply: boolean | Error; calls: number[] };
}

function world(): World {
  const clock = new ManualClock();
  const detector = fakeDetector();
  const state: World["state"] = { ports: 0, workIdle: true, reply: true, calls: [] };
  const idle = createIdleMonitor({
    clock,
    log: captureLogger().log,
    settings: createSettingsCache({ clock }),
    ports: () => state.ports,
    workIdle: () => state.workIdle,
    notifyIdle: (since) => {
      state.calls.push(since);
      return state.reply instanceof Error
        ? Promise.reject(state.reply)
        : Promise.resolve({ closing: state.reply });
    },
    detector: () => detector,
  });
  return { clock, idle, detector, state };
}

const CLOSE_MS = minutesToMs(DEFAULT_SETTINGS.engine.idleCloseMin);
const RELEASE_MS = minutesToMs(DEFAULT_SETTINGS.engine.detectorReleaseMin);

test("0 ports and no work for idleCloseMin → one sw:engine-idle carrying when the idle period began", async () => {
  const { clock, idle, state } = world();
  const start = clock.now();
  idle.check();
  assert.equal(idle.isIdle(), true);
  assert.equal(idle.idleSince(), start);
  await clock.advance(CLOSE_MS - 1);
  assert.deepEqual(state.calls, []);
  await clock.advance(1);
  assert.deepEqual(state.calls, [start]);
  idle.check();
  await clock.advance(CLOSE_MS - 1);
  assert.equal(state.calls.length, 1, "asked once per idle period");
  idle.stop();
});

test("a port or new work resets the idle period", async () => {
  const { clock, idle, state } = world();
  idle.check();
  await clock.advance(CLOSE_MS / 2);
  state.ports = 1;
  idle.check();
  assert.equal(idle.idleSince(), null);
  assert.equal(idle.isIdle(), false);
  await clock.advance(CLOSE_MS);
  assert.deepEqual(state.calls, []);
  state.ports = 0;
  state.workIdle = false;
  idle.check();
  await clock.advance(CLOSE_MS);
  assert.deepEqual(state.calls, [], "in-flight work keeps the engine open");
  state.workIdle = true;
  assert.equal(idle.idleSince(), null);
  await clock.advance(IDLE_POLL_MS - CLOSE_MS);
  const since = idle.idleSince();
  assert.equal(since, clock.now(), "without ports the monitor polls until the work is done");
  assert.deepEqual(state.calls, []);
  await clock.advance(CLOSE_MS);
  assert.deepEqual(state.calls, [since]);
  idle.stop();
});

test("when the SW keeps the engine (or the call fails) it asks again after another full period", async () => {
  const { clock, idle, state } = world();
  state.reply = false;
  idle.check();
  await clock.advance(CLOSE_MS);
  assert.equal(state.calls.length, 1);
  state.reply = new Error("no SW");
  await clock.advance(CLOSE_MS);
  assert.equal(state.calls.length, 2);
  state.reply = true;
  await clock.advance(CLOSE_MS);
  assert.equal(state.calls.length, 3);
  idle.stop();
  await clock.advance(CLOSE_MS * 2);
  assert.equal(state.calls.length, 3);
  assert.equal(clock.pending(), 0, "stop() cancels every timer");
});

test("the detector is released after detectorReleaseMin without detections, never during one", async () => {
  const { clock, idle, detector } = world();
  detector.current = { backend: "webgpu", state: "ready", canary: "pass" };
  idle.detectionStarted();
  idle.detectionStarted();
  idle.detectionFinished();
  await clock.advance(RELEASE_MS * 2);
  assert.equal(detector.releases, 0, "one detection still running");
  idle.detectionFinished();
  await clock.advance(RELEASE_MS - 1);
  assert.equal(detector.releases, 0);
  idle.detectionStarted();
  idle.detectionFinished();
  await clock.advance(RELEASE_MS - 1);
  assert.equal(detector.releases, 0, "a new detection restarts the countdown");
  await clock.advance(1);
  assert.equal(detector.releases, 1);
  assert.equal(detector.state().state, "unloaded");

  idle.detectionStarted();
  idle.detectionFinished();
  await clock.advance(RELEASE_MS);
  assert.equal(detector.releases, 1, "an unloaded detector is not released again");
  idle.stop();
});
