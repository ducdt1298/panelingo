// Idle teardown. Closing the offscreen document is the only way to give WASM memory back, but the SW cannot count
// ports, so the engine reports: with 0 ports and no queued, running or in-flight work for engine.idleCloseMin it sends
// sw:engine-idle, and the SW answers with en:prepare-close. Separately, the detector session is released after
// engine.detectorReleaseMin without a detection (the document stays).

import type { Logger } from "../platform/log.ts";
import { minutesToMs } from "../platform/time.ts";
import type { Clock, SettingsSource, TextDetector } from "./contracts.ts";

/** How often an engine without ports re-checks whether its remaining work has finished. */
export const IDLE_POLL_MS = 30_000;

export interface IdleDeps {
  clock: Clock;
  log: Logger;
  settings: SettingsSource;
  /** Open "engine" and "ui" ports (frames in their reconnect grace do not count). */
  ports: () => number;
  /** Pipeline.idle(): nothing queued, running or in flight. */
  workIdle: () => boolean;
  /** callSw("sw:engine-idle"): idleSinceMs is the epoch ms when the idle period began. */
  notifyIdle: (idleSinceMs: number) => Promise<{ closing: boolean }>;
  /** The detector to release, once it exists. */
  detector: () => Pick<TextDetector, "release" | "state"> | null;
}

export interface IdleMonitor {
  /** Re-evaluates the idle state (port opened or closed, work changed). */
  readonly check: () => void;
  /** 0 ports and no work right now (en:prepare-close). */
  readonly isIdle: () => boolean;
  /** Epoch ms since when the engine has been idle, or null. */
  readonly idleSince: () => number | null;
  readonly detectionStarted: () => void;
  readonly detectionFinished: () => void;
  readonly stop: () => void;
}

export function createIdleMonitor(deps: IdleDeps): IdleMonitor {
  const { clock, log, settings } = deps;
  let since: number | null = null;
  let cancelClose: (() => void) | null = null;
  let cancelPoll: (() => void) | null = null;
  let cancelRelease: (() => void) | null = null;
  let detecting = 0;
  let notifying = false;
  let stopped = false;

  const cancel = (timer: (() => void) | null): null => {
    timer?.();
    return null;
  };

  const isIdle = (): boolean => deps.ports() === 0 && deps.workIdle();
  const closeAfterMs = (): number => minutesToMs(settings.current().engine.idleCloseMin);

  const armClose = (delayMs: number): void => {
    cancelClose = cancel(cancelClose);
    cancelClose = clock.setTimer(onCloseTimer, Math.max(0, delayMs));
  };

  const onCloseTimer = (): void => {
    cancelClose = null;
    check();
    if (stopped || since === null || notifying) return;
    const idleFor = clock.now() - since;
    if (idleFor < closeAfterMs()) {
      armClose(closeAfterMs() - idleFor);
      return;
    }
    notifying = true;
    const idleSince = since;
    log.info("engine idle, asking the SW to close it", { idleSinceMs: idleSince });
    void deps
      .notifyIdle(idleSince)
      .then(
        (reply) => {
          if (!reply.closing) log.debug("SW keeps the engine open");
        },
        (error: unknown) => {
          log.warn("sw:engine-idle failed", { error: String(error) });
        },
      )
      .finally(() => {
        notifying = false;
        // Still here (the SW declined, or the close did not happen): ask again after another full period.
        if (!stopped && since !== null) armClose(closeAfterMs());
      });
  };

  const check = (): void => {
    if (stopped) return;
    const ports = deps.ports();
    const idle = ports === 0 && deps.workIdle();
    if (idle) {
      cancelPoll = cancel(cancelPoll);
      if (since === null) {
        since = clock.now();
        if (!notifying) armClose(closeAfterMs());
      }
      return;
    }
    since = null;
    cancelClose = cancel(cancelClose);
    // Without ports nothing else wakes the engine when the last request finishes: poll for it.
    if (ports === 0 && cancelPoll === null) {
      cancelPoll = clock.setTimer(() => {
        cancelPoll = null;
        check();
      }, IDLE_POLL_MS);
    } else if (ports > 0) {
      cancelPoll = cancel(cancelPoll);
    }
  };

  const armRelease = (): void => {
    cancelRelease = cancel(cancelRelease);
    cancelRelease = clock.setTimer(() => {
      cancelRelease = null;
      const detector = deps.detector();
      if (stopped || detecting > 0 || detector === null || detector.state().state !== "ready") return;
      log.info("releasing the detector session after idle time");
      detector.release().catch((error: unknown) => {
        log.warn("detector release failed", { error: String(error) });
      });
    }, minutesToMs(settings.current().engine.detectorReleaseMin));
  };

  return {
    check,
    isIdle,
    idleSince: () => since,
    detectionStarted: () => {
      detecting += 1;
      cancelRelease = cancel(cancelRelease);
    },
    detectionFinished: () => {
      detecting = Math.max(0, detecting - 1);
      if (detecting === 0 && !stopped) armRelease();
    },
    stop: () => {
      stopped = true;
      cancelClose = cancel(cancelClose);
      cancelPoll = cancel(cancelPoll);
      cancelRelease = cancel(cancelRelease);
    },
  };
}
