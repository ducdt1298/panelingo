// The offscreen engine's lifecycle as seen from the service worker: single-flight creation and the idle close
// handshake. Nothing here has to survive a worker restart: the engine is rediscovered with runtime.getContexts, and
// the two promises below only exist while a create or a close is in flight.

import { createLogger } from "../platform/log.ts";
import { callEngine } from "../platform/messaging.ts";
import { loadAll } from "../platform/storage.ts";
import { errorMessage } from "../shared/errors.ts";

export const ENGINE_PATH = "engine/offscreen.html";
const JUSTIFICATION =
  "Runs the local comic text detector (WebGPU/WASM) and decodes/re-encodes comic page images.";
/** Another worker instance (or a caller that lost the race) created the document first. */
const SINGLE_OFFSCREEN = /single offscreen/i;
export const PREPARE_CLOSE_TIMEOUT_MS = 2_000;

const log = createLogger("sw");

let creating: Promise<boolean> | null = null;
let closing: Promise<void> | null = null;
let pushes: Promise<unknown> = Promise.resolve();

export function engineUrl(): string {
  return chrome.runtime.getURL(ENGINE_PATH);
}

export function findEngine(): Promise<chrome.runtime.ExtensionContext[]> {
  return chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [engineUrl()] });
}

export async function engineExists(): Promise<boolean> {
  return (await findEngine()).length > 0;
}

/**
 * Sends the current settings and sites to the engine (en:settings). Pushes are serialized and each one reads
 * storage when its turn comes, so the engine always ends up with the newest values.
 */
export function pushSettingsToEngine(): Promise<void> {
  const run = pushes.then(async () => {
    await callEngine("en:settings", await loadAll());
  });
  pushes = run.catch(() => undefined);
  return run;
}

/** `replace`: contextId of an unresponsive engine to recreate (force); null creates only when none exists. */
async function createEngine(replace: string | null): Promise<boolean> {
  const current = await findEngine();
  if (current.length > 0) {
    if (replace === null || !current.some((context) => context.contextId === replace)) return false;
    log.warn("recreating an unresponsive engine");
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
  try {
    await chrome.offscreen.createDocument({
      url: ENGINE_PATH,
      reasons: ["WORKERS", "BLOBS"],
      justification: JUSTIFICATION,
    });
  } catch (error) {
    if (SINGLE_OFFSCREEN.test(errorMessage(error))) return false;
    throw error;
  }
  // The engine also pulls sw:get-settings while booting, so whichever arrives first wins.
  pushSettingsToEngine().catch((error: unknown) => {
    log.debug("en:settings push after create failed", { error: errorMessage(error) });
  });
  return true;
}

/**
 * Makes sure the engine document exists. Concurrent callers share one createDocument; a close in progress is
 * awaited first. force recreates the engine that exists right now (content asks for it after repeated fast
 * connect failures); a caller that saw an older document never closes a newer one.
 */
export async function ensureEngine(force = false): Promise<{ created: boolean }> {
  for (;;) {
    if (closing !== null) await closing;
    const found = await findEngine();
    if (closing !== null) continue;
    if (found.length > 0 && !force) return { created: false };
    const replace = force ? (found[0]?.contextId ?? null) : null;
    creating ??= createEngine(replace).finally(() => {
      creating = null;
    });
    return { created: await creating };
  }
}

/**
 * Idle close, started by the engine's sw:engine-idle: ask en:prepare-close (the engine says no when it got busy
 * again), then close through the shared `closing` promise that ensureEngine waits for. Returns true when closed.
 */
export async function closeEngineIfIdle(timeoutMs: number = PREPARE_CLOSE_TIMEOUT_MS): Promise<boolean> {
  if (creating !== null || closing !== null) return false;
  if (!(await engineExists())) return false;
  let accepted: boolean;
  try {
    accepted = (await callEngine("en:prepare-close", {}, { timeoutMs })).ok;
  } catch (error) {
    log.debug("en:prepare-close failed", { error: errorMessage(error) });
    return false;
  }
  if (!accepted || creating !== null || closing !== null) return false;
  let closed = false;
  closing = chrome.offscreen
    .closeDocument()
    .then(
      () => {
        closed = true;
      },
      (error: unknown) => {
        log.warn("closeDocument failed", { error: errorMessage(error) });
      },
    )
    .finally(() => {
      closing = null;
    });
  await closing;
  return closed;
}
