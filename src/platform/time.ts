// Minute-based settings (engine idleCloseMin and detectorReleaseMin, content portIdleMin) run 60× faster in test
// builds, so E2E can watch the engine close and reopen. Every context converts these settings through minutesToMs.

export const MINUTE_MS = __TEST__ ? 1_000 : 60_000;

export function minutesToMs(minutes: number): number {
  return minutes * MINUTE_MS;
}
