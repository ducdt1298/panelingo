// Compile-time constants injected by esbuild `define` (scripts/build.ts).

/** e.g. "0.1.0+20261009T153000.dev" */
declare const __BUILD_ID__: string;
/** true for dev and test builds */
declare const __DEV__: boolean;
/** true only for test builds (open shadow roots, test hooks, fixture hosts) */
declare const __TEST__: boolean;

// Runtime globals (not esbuild defines).

/**
 * Manual-mode flag for an on-request injection: src/sw/registration.ts sets it to Date.now() in the
 * frame's isolated world right before injecting content/main.js; the content script reads and clears it, and starts
 * in manual mode when it is younger than 10 s.
 */
// eslint-disable-next-line no-var -- a global the SW's executeScript sets on globalThis must be declared with var
declare var __ctvManual: number | undefined;
