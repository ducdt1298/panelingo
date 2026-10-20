// Pack scheduler: `concurrency` normal lanes plus one urgent lane, never more than inFlightCap(settings) requests in
// flight. Urgent tasks (head image on screen) go first and alone may take the urgent lane; the rest go by rank.
// Nothing is dispatched while the gate is closed (privacy notice, API health) and a running task is never aborted:
// drop() only removes tasks that were not sent yet.
// createSlots() is the small priority pool that bounds image preparation (acquire, decode, detect).

import type { ErrorCode } from "../shared/errors.ts";
import type { Clock } from "./contracts.ts";

export type Lane = "normal" | "urgent";

export interface QueueTask {
  /** Head image on screen: sorts first and may take the urgent lane. Read at every dispatch. */
  urgent(): boolean;
  /** Compared element by element, lower first; ties keep insertion order. Read at every dispatch. */
  rank(): readonly number[];
  /** Sends the pack. Never aborted; settles when the pack is finished. */
  run(lane: Lane): Promise<void>;
  /**
   * False: not yet (series warm-up); the task keeps its place and takes no lane. Read at every dispatch; whoever
   * makes it true again calls pump().
   */
  ready?(): boolean;
}

export interface QueueLimits {
  /** Normal lanes (settings.api.concurrency). */
  concurrency: number;
  /** Requests in flight, urgent lane included (settings inFlightCap). */
  cap: number;
}

/** Closed with a null code: not sendable yet, nothing to show (readiness "unknown"). */
export type QueueGate = { readonly open: true } | { readonly open: false; readonly code: ErrorCode | null };

export interface QueueDeps {
  clock: Clock;
  limits(): QueueLimits;
  gate(): QueueGate;
  /** The queue turned non-empty (queued or running) or empty again: ApiHealth.setBusy. */
  onBusy(busy: boolean): void;
  /** run() threw or rejected; it should settle normally, so this is a bug. */
  onCrash?(error: unknown): void;
}

export interface QueueSnapshot {
  queued: number;
  running: number;
  urgentRunning: number;
  /** Normal lanes in effect (a throttle lowers it). */
  concurrency: number;
  cap: number;
}

export interface PackQueue {
  add(task: QueueTask): void;
  /** Removes the queued (unsent) tasks that match; running tasks are never touched. */
  drop(match: (task: QueueTask) => boolean): QueueTask[];
  /** Dispatches whatever the gate, the lanes and the ranks allow now. */
  pump(): void;
  /** Temporary cap on requests in flight (429: 1 for 10 min; watchdog timeout: 1 for 5 min). */
  throttle(value: number, forMs: number): void;
  isQueued(task: QueueTask): boolean;
  isRunning(task: QueueTask): boolean;
  snapshot(): QueueSnapshot;
  /** Nothing queued and nothing running. */
  idle(): boolean;
}

export function compareRanks(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

interface Waiting {
  readonly task: QueueTask;
  readonly seq: number;
}

export function createQueue(deps: QueueDeps): PackQueue {
  const queued: Waiting[] = [];
  const running = new Map<QueueTask, Lane>();
  let seq = 0;
  let normalRunning = 0;
  let urgentRunning = 0;
  let throttled: { value: number; until: number; cancel: () => void } | null = null;
  let pumping = false;
  let again = false;
  let busy = false;

  const lanes = (): { normal: number; urgent: number; cap: number } => {
    const limits = deps.limits();
    const concurrency = Math.max(1, Math.floor(limits.concurrency));
    let cap = Math.max(concurrency, Math.floor(limits.cap));
    if (throttled !== null) cap = Math.min(cap, throttled.value);
    const normal = Math.min(concurrency, cap);
    return { normal, urgent: Math.max(0, cap - normal), cap };
  };

  const updateBusy = (): void => {
    const now = queued.length + running.size > 0;
    if (now === busy) return;
    busy = now;
    deps.onBusy(busy);
  };

  /** Index of the best queued task that is ready: urgent first, then rank, then insertion order. */
  const best = (): { index: number; urgent: boolean } | null => {
    let found: { index: number; urgent: boolean; rank: readonly number[]; seq: number } | null = null;
    for (const [index, entry] of queued.entries()) {
      if (entry.task.ready?.() === false) continue;
      const urgent = entry.task.urgent();
      const rank = entry.task.rank();
      if (
        found === null ||
        (urgent && !found.urgent) ||
        (urgent === found.urgent &&
          (compareRanks(rank, found.rank) < 0 ||
            (compareRanks(rank, found.rank) === 0 && entry.seq < found.seq)))
      ) {
        found = { index, urgent, rank, seq: entry.seq };
      }
    }
    return found === null ? null : { index: found.index, urgent: found.urgent };
  };

  const finish = (task: QueueTask): void => {
    const lane = running.get(task);
    if (lane === undefined) return;
    running.delete(task);
    if (lane === "urgent") urgentRunning -= 1;
    else normalRunning -= 1;
    pump();
  };

  const start = (index: number, lane: Lane): void => {
    const [entry] = queued.splice(index, 1);
    if (entry === undefined) return;
    const task = entry.task;
    running.set(task, lane);
    if (lane === "urgent") urgentRunning += 1;
    else normalRunning += 1;
    let result: Promise<void>;
    try {
      result = task.run(lane);
    } catch (error) {
      result = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    void result.then(
      () => finish(task),
      (error: unknown) => {
        deps.onCrash?.(error);
        finish(task);
      },
    );
  };

  const dispatchOne = (): boolean => {
    if (queued.length === 0 || !deps.gate().open) return false;
    const pick = best();
    if (pick === null) return false;
    const free = lanes();
    if (normalRunning < free.normal) {
      start(pick.index, "normal");
      return true;
    }
    if (pick.urgent && urgentRunning < free.urgent) {
      start(pick.index, "urgent");
      return true;
    }
    return false;
  };

  function pump(): void {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        while (dispatchOne()) {
          // keep dispatching while lanes are free
        }
      } while (again);
    } finally {
      pumping = false;
    }
    updateBusy();
  }

  return {
    add(task) {
      if (running.has(task) || queued.some((entry) => entry.task === task)) return;
      seq += 1;
      queued.push({ task, seq });
      pump();
    },
    drop(match) {
      const removed: QueueTask[] = [];
      for (let i = queued.length - 1; i >= 0; i -= 1) {
        const entry = queued[i];
        if (entry !== undefined && match(entry.task)) {
          queued.splice(i, 1);
          removed.unshift(entry.task);
        }
      }
      updateBusy();
      return removed;
    },
    pump,
    throttle(value, forMs) {
      const now = deps.clock.now();
      const limit = Math.max(1, Math.floor(value));
      const until = now + Math.max(0, forMs);
      if (throttled !== null && throttled.value <= limit && throttled.until >= until) return;
      const merged = {
        value: Math.min(limit, throttled?.value ?? limit),
        until: Math.max(until, throttled?.until ?? until),
      };
      throttled?.cancel();
      const state = { ...merged, cancel: () => {} };
      state.cancel = deps.clock.setTimer(() => {
        if (throttled === state) {
          throttled = null;
          pump();
        }
      }, merged.until - now);
      throttled = state;
    },
    isQueued: (task) => queued.some((entry) => entry.task === task),
    isRunning: (task) => running.has(task),
    snapshot() {
      const free = lanes();
      return {
        queued: queued.length,
        running: running.size,
        urgentRunning,
        concurrency: free.normal,
        cap: free.cap,
      };
    },
    idle: () => queued.length === 0 && running.size === 0,
  };
}

/* ------------------------------------------------------------------ preparation slots */

export interface SlotTicket {
  /** A release function once a slot is granted; null when the request was cancelled first. */
  readonly granted: Promise<(() => void) | null>;
  cancel(): void;
}

export interface SlotPool {
  /** Waits for a slot; the best rank among the waiters is served first (ranks are read when a slot frees). */
  take(rank: () => readonly number[]): SlotTicket;
  readonly busy: number;
  readonly waiting: number;
}

export function createSlots(size: number): SlotPool {
  const limit = Math.max(1, Math.floor(size));
  interface Waiter {
    rank: () => readonly number[];
    seq: number;
    resolve: (release: (() => void) | null) => void;
  }
  const waiters: Waiter[] = [];
  let busy = 0;
  let seq = 0;

  const grant = (): void => {
    while (busy < limit && waiters.length > 0) {
      let bestIndex = 0;
      for (let i = 1; i < waiters.length; i += 1) {
        const a = waiters[i];
        const b = waiters[bestIndex];
        if (a === undefined || b === undefined) continue;
        const order = compareRanks(a.rank(), b.rank());
        if (order < 0 || (order === 0 && a.seq < b.seq)) bestIndex = i;
      }
      const [next] = waiters.splice(bestIndex, 1);
      if (next === undefined) return;
      busy += 1;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        busy -= 1;
        grant();
      });
    }
  };

  return {
    take(rank) {
      seq += 1;
      const { promise, resolve } = Promise.withResolvers<(() => void) | null>();
      const waiter: Waiter = { rank, seq, resolve };
      waiters.push(waiter);
      grant();
      return {
        granted: promise,
        cancel() {
          const index = waiters.indexOf(waiter);
          if (index < 0) return;
          waiters.splice(index, 1);
          waiter.resolve(null);
        },
      };
    },
    get busy() {
      return busy;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
