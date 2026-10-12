import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  compareRanks,
  createQueue,
  createSlots,
  type Lane,
  type QueueDeps,
  type QueueGate,
  type QueueTask,
} from "../../../src/engine/queue.ts";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

class ManualClock {
  t = 1_000_000;
  private readonly timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  readonly now = (): number => this.t;
  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  advance(ms: number): void {
    this.t += ms;
    for (const timer of this.timers) {
      if (timer.live && timer.at <= this.t) {
        timer.live = false;
        timer.fn();
      }
    }
  }
}

interface FakeTask extends QueueTask {
  readonly name: string;
  lane: Lane | null;
  urgentNow: boolean;
  rankNow: number[];
  finish(): void;
  fail(error: Error): void;
}

function makeTask(
  name: string,
  started: string[],
  opts: { urgent?: boolean; rank?: number[] } = {},
): FakeTask {
  const done = Promise.withResolvers<void>();
  const task: FakeTask = {
    name,
    lane: null,
    urgentNow: opts.urgent ?? false,
    rankNow: opts.rank ?? [0],
    urgent: () => task.urgentNow,
    rank: () => task.rankNow,
    run(lane) {
      task.lane = lane;
      started.push(name);
      return done.promise;
    },
    finish: () => done.resolve(),
    fail: (error) => done.reject(error),
  };
  return task;
}

function setup(options: { concurrency?: number; cap?: number; open?: boolean } = {}) {
  const clock = new ManualClock();
  const busy: boolean[] = [];
  const crashes: unknown[] = [];
  const state = {
    concurrency: options.concurrency ?? 2,
    cap: options.cap ?? 3,
    gate: ((options.open ?? true) ? { open: true } : { open: false, code: "api.unreachable" }) as QueueGate,
  };
  const deps: QueueDeps = {
    clock,
    limits: () => ({ concurrency: state.concurrency, cap: state.cap }),
    gate: () => state.gate,
    onBusy: (value) => busy.push(value),
    onCrash: (error) => crashes.push(error),
  };
  const started: string[] = [];
  return { clock, busy, crashes, state, started, queue: createQueue(deps) };
}

describe("pack queue lanes", () => {
  test("runs at most `concurrency` normal tasks and starts the next one when a lane frees", async () => {
    const { queue, started } = setup({ concurrency: 2, cap: 3 });
    const tasks = ["a", "b", "c", "d"].map((name) => makeTask(name, started));
    for (const task of tasks) queue.add(task);
    assert.deepEqual(started, ["a", "b"]);
    assert.deepEqual(queue.snapshot(), { queued: 2, running: 2, urgentRunning: 0, concurrency: 2, cap: 3 });
    tasks[0]?.finish();
    await flush();
    assert.deepEqual(started, ["a", "b", "c"]);
    assert.equal(tasks[2]?.lane, "normal");
  });

  test("the urgent lane serves only urgent tasks, and in-flight never exceeds the cap", () => {
    const { queue, started } = setup({ concurrency: 2, cap: 3 });
    queue.add(makeTask("a", started));
    queue.add(makeTask("b", started));
    const lazy = makeTask("lazy", started);
    queue.add(lazy);
    assert.deepEqual(started, ["a", "b"]);
    const hot = makeTask("hot", started, { urgent: true });
    queue.add(hot);
    assert.deepEqual(started, ["a", "b", "hot"]);
    assert.equal(hot.lane, "urgent");
    const hot2 = makeTask("hot2", started, { urgent: true });
    queue.add(hot2);
    assert.deepEqual(started, ["a", "b", "hot"]);
    assert.deepEqual(queue.snapshot(), { queued: 2, running: 3, urgentRunning: 1, concurrency: 2, cap: 3 });
    assert.equal(queue.isQueued(lazy), true);
    assert.equal(queue.isRunning(hot), true);
  });

  test("no urgent lane when the cap leaves none (concurrency 4 = maxInFlight 4)", () => {
    const { queue, started } = setup({ concurrency: 4, cap: 4 });
    for (const name of ["a", "b", "c", "d"]) queue.add(makeTask(name, started));
    queue.add(makeTask("hot", started, { urgent: true }));
    assert.equal(started.length, 4);
    assert.equal(queue.snapshot().queued, 1);
  });

  test("urgent tasks first, then lower rank, then insertion order; ranks are read at dispatch", async () => {
    const { queue, started, state } = setup({ concurrency: 1, cap: 1, open: false });
    const slow = makeTask("slow", started, { rank: [0, 9] });
    const fast = makeTask("fast", started, { rank: [0, 1] });
    const tie = makeTask("tie", started, { rank: [0, 1] });
    const hot = makeTask("hot", started, { rank: [1, 99], urgent: true });
    for (const task of [slow, fast, tie, hot]) queue.add(task);
    assert.deepEqual(started, []);
    slow.rankNow = [0, 0];
    state.gate = { open: true };
    queue.pump();
    assert.deepEqual(started, ["hot"]);
    for (const expected of ["slow", "fast", "tie"]) {
      const running = [slow, fast, tie, hot].find((task) => task.name === started.at(-1));
      running?.finish();
      await flush();
      assert.equal(started.at(-1), expected);
    }
  });
});

describe("pack queue gate, drop and throttle", () => {
  test("nothing is sent while the gate is closed; pump() after it opens sends", () => {
    const { queue, started, state } = setup({ open: false });
    queue.add(makeTask("a", started));
    assert.deepEqual(started, []);
    assert.equal(queue.idle(), false);
    state.gate = { open: true };
    queue.pump();
    assert.deepEqual(started, ["a"]);
  });

  test("drop() removes unsent tasks only; a running task is never aborted and still finishes", async () => {
    const { queue, started, busy } = setup({ concurrency: 1, cap: 1 });
    const running = makeTask("running", started);
    const waiting = makeTask("waiting", started);
    queue.add(running);
    queue.add(waiting);
    const removed = queue.drop(() => true);
    assert.deepEqual(removed, [waiting]);
    assert.equal(queue.isRunning(running), true);
    running.finish();
    await flush();
    assert.deepEqual(started, ["running"]);
    assert.equal(queue.idle(), true);
    assert.deepEqual(busy, [true, false]);
  });

  test("throttle caps requests in flight until it expires on the clock", async () => {
    const { queue, started, clock } = setup({ concurrency: 2, cap: 3 });
    queue.throttle(1, 10 * 60_000);
    const a = makeTask("a", started);
    queue.add(a);
    queue.add(makeTask("b", started));
    queue.add(makeTask("hot", started, { urgent: true }));
    assert.deepEqual(started, ["a"]);
    assert.deepEqual(queue.snapshot(), { queued: 2, running: 1, urgentRunning: 0, concurrency: 1, cap: 1 });
    clock.advance(5 * 60_000);
    assert.deepEqual(started, ["a"]);
    clock.advance(5 * 60_000);
    // The urgent task takes the free normal lane; the extra lane is only for urgent work when normal lanes are full.
    assert.deepEqual(started, ["a", "hot"]);
    a.finish();
    await flush();
    assert.deepEqual(started, ["a", "hot", "b"]);
  });

  test("a stricter or longer throttle wins over a weaker one", () => {
    const { queue, started, clock } = setup({ concurrency: 2, cap: 3 });
    queue.throttle(1, 60_000);
    queue.throttle(2, 1_000);
    queue.add(makeTask("a", started));
    queue.add(makeTask("b", started));
    clock.advance(30_000);
    assert.deepEqual(started, ["a"]);
    clock.advance(30_000);
    assert.deepEqual(started, ["a", "b"]);
  });

  test("onBusy fires on transitions only", async () => {
    const { queue, started, busy } = setup({ concurrency: 2, cap: 2 });
    const a = makeTask("a", started);
    const b = makeTask("b", started);
    queue.add(a);
    queue.add(b);
    a.finish();
    await flush();
    assert.deepEqual(busy, [true]);
    b.finish();
    await flush();
    assert.deepEqual(busy, [true, false]);
  });

  test("a run() that throws or rejects frees its lane and is reported", async () => {
    const { queue, started, crashes } = setup({ concurrency: 1, cap: 1 });
    const boom: QueueTask = {
      urgent: () => false,
      rank: () => [0],
      run: () => {
        throw new Error("sync boom");
      },
    };
    const rejecting = makeTask("rejecting", started);
    const after = makeTask("after", started);
    queue.add(boom);
    queue.add(rejecting);
    queue.add(after);
    await flush();
    assert.deepEqual(started, ["rejecting"]);
    rejecting.fail(new Error("async boom"));
    await flush();
    assert.deepEqual(started, ["rejecting", "after"]);
    assert.equal(crashes.length, 2);
  });

  test("a task that pumps the queue from run() does not overfill the lanes", () => {
    const { started, queue } = setup({ concurrency: 1, cap: 1 });
    const reentrant: QueueTask = {
      urgent: () => false,
      rank: () => [0],
      run: () => {
        started.push("reentrant");
        queue.pump();
        return new Promise<void>(() => {});
      },
    };
    queue.add(reentrant);
    queue.add(makeTask("next", started));
    assert.deepEqual(started, ["reentrant"]);
    assert.equal(queue.snapshot().running, 1);
  });

  test("compareRanks orders element by element", () => {
    assert.equal(compareRanks([0, 1], [0, 2]), -1);
    assert.equal(compareRanks([1], [0, 9]), 1);
    assert.equal(compareRanks([2, 0], [2]), 0);
  });
});

describe("preparation slots", () => {
  test("at most `size` holders; the best-ranked waiter is served first; release is idempotent", async () => {
    const slots = createSlots(1);
    const first = slots.take(() => [5]);
    const release = await first.granted;
    assert.ok(release !== null);
    const order: string[] = [];
    const later = slots.take(() => [9]);
    const sooner = slots.take(() => [1]);
    void later.granted.then(() => order.push("later"));
    void sooner.granted.then(() => order.push("sooner"));
    assert.deepEqual([slots.busy, slots.waiting], [1, 2]);
    release();
    release();
    await flush();
    assert.deepEqual(order, ["sooner"]);
    assert.deepEqual([slots.busy, slots.waiting], [1, 1]);
  });

  test("a cancelled request resolves with null and never takes a slot", async () => {
    const slots = createSlots(1);
    const holder = await slots.take(() => [0]).granted;
    const ticket = slots.take(() => [0]);
    ticket.cancel();
    assert.equal(await ticket.granted, null);
    assert.equal(slots.waiting, 0);
    holder?.();
    assert.equal(slots.busy, 0);
  });
});
