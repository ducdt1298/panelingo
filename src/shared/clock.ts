// Injected time source shared by every context: production code uses systemClock, tests drive a manual clock.
// PURE: Date and setTimeout/clearTimeout behave the same in Node and every Chrome context.

/** Same shape as api-client's ApiClientDeps time functions. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Runs fn after ms; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};
