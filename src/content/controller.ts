// Content-script controller: discovery → ladder step 1 (readLocalBytes, else the engine fetches the URL) → engine
// client; engine messages → overlay; overlay events → img:submit / img:retry, unit:overflow, unit:edit and
// unit:retranslate (bubble popup), sw:ack-privacy; the cs:log sink; teardown (also when the extension context is
// invalidated). Auto mode submits every candidate in priority order, manual mode only what the user asks for (hover
// button, context menu, command).
// Look-ahead: tier-B candidates (lazy images not loaded yet) are submitted with `prefetch` (detection only) and
// submitted again without it once they enter the translate window (en:horizons translateScreens) or the page loads
// them. Screen capture (ladder step 3): cap:prepare / cap:done go to capture-assist.ts; a capture that could not run
// (image off screen, reader scrolling) is retried once the image is on screen and the page is still.

import { createLogger, type LogSink, type Logger } from "../platform/log.ts";
import type { Clock } from "../shared/clock.ts";
import { errorMessage, type ErrorCode, type ErrorInfo } from "../shared/errors.ts";
import { computeHorizons, horizonFrom, inTranslateWindow, LOOKAHEAD } from "../shared/core/priority.ts";
import type { EngineToCsMap, ImageSubmit, ViewportInfo } from "../shared/protocol.ts";
import { effectiveTarget } from "../shared/languages.ts";
import type { Settings } from "../shared/settings.ts";
import { createPeek } from "./keys.ts";
import type { Codec, ImageState, LogEntry, Size, UnitRender } from "../shared/types.ts";
import { WIRE_HARD_LIMIT, WIRE_HARD_LIMIT_B64 } from "../shared/wire.ts";
import type {
  CreateOverlay,
  EngineClient,
  ImageElement,
  ImageStateInfo,
  LocalBytes,
  ReadLocalBytes,
  TrackedImage,
} from "./contracts.ts";
import {
  CAPTURE_QUIET_MS,
  CAPTURE_RETRY_MAX,
  captureRetryWanted,
  createCaptureAssist,
  type CaptureWindow,
} from "./capture-assist.ts";
import type { Discovery, DiscoveryEvents, SubmitBase } from "./discovery.ts";
import { createFrameChain } from "./frame-chain.ts";
import { isTerminal } from "./engine-client.ts";
import type { CommandTarget, TeardownReason } from "./messages.ts";
import type { ContentSummary } from "./test-hooks.ts";

export const LOG_FLUSH_MS = 2_000;
export const LOG_BATCH = 50;
export const LOG_KEEP = 500;
/** Concurrent ladder-step-1 reads: each may hold a whole image in memory. */
export const MAX_LOCAL_READS = 2;
/** Headroom for the JSON envelope below the codec's hard limit. */
const ENVELOPE_MARGIN = 64 * 1024;

/** Errors raised on the content side: a retry submits again instead of asking the engine (img:retry). */
const CLIENT_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "engine.unavailable",
  "engine.protocol",
  "engine.closing",
  "engine.overloaded",
  "ctx.invalidated",
  "msg.too_large",
]);

/**
 * Images "translate visible" leaves alone: finished, stale (re-translated only per image) and refused (never retried
 * automatically: re-uploaded only on an explicit request for that image).
 */
const SETTLED_FOR_VISIBLE: ReadonlySet<ImageState> = new Set<ImageState>([
  "done",
  "no-text",
  "stale",
  "refused",
]);

/** Largest ladder-step-1 read that still fits one message with this codec (base64 inflates by 4/3). */
export function maxLocalBytes(codec: Codec, settingsMax: number): number {
  const wire = codec === "b64" ? Math.floor((WIRE_HARD_LIMIT_B64 * 3) / 4) : WIRE_HARD_LIMIT;
  return Math.max(0, Math.min(settingsMax, wire - ENVELOPE_MARGIN));
}

/** img:state → overlay info, with only the fields that are present (exactOptionalPropertyTypes). */
export function stateInfo(message: {
  progress?: { done: number; total: number };
  etaSec?: number;
  error?: ErrorInfo;
}): ImageStateInfo {
  const info: ImageStateInfo = {};
  if (message.progress !== undefined) info.progress = message.progress;
  if (message.etaSec !== undefined) info.etaSec = message.etaSec;
  if (message.error !== undefined) info.error = message.error;
  return info;
}

/** The overlay paints a unit only with a valid translation (status ok, or a manual edit). */
export function isPainted(unit: UnitRender): boolean {
  return (unit.status === "ok" || unit.status === "manual") && unit.translation.trim() !== "";
}

function isImgElement(el: ImageElement): el is HTMLImageElement {
  return el.localName === "img";
}

function elementNatural(el: ImageElement): Size {
  return isImgElement(el) ? { w: el.naturalWidth, h: el.naturalHeight } : { w: el.width, h: el.height };
}

/** The window capture-assist works with; null without one (tests): captures are then declined. */
function captureWindowOf(doc: Document): CaptureWindow | null {
  const win = doc.defaultView;
  return win !== null && win !== undefined && typeof win.requestAnimationFrame === "function" ? win : null;
}

export interface ClientHooks {
  log: Logger;
  /** Rebuilds a submit whose bytes were dropped: fresh measurement and a new ladder-step-1 read. */
  reread: (submit: ImageSubmit) => Promise<ImageSubmit | null>;
}

export interface ControllerDeps {
  doc: Document;
  mode: "auto" | "manual";
  settings: Settings;
  /** The frame's site is opted in: ladder step 1 may use its one CORS probe per host. */
  siteEnabled: boolean;
  createOverlay: CreateOverlay;
  readLocalBytes: ReadLocalBytes;
  createDiscovery(events: DiscoveryEvents): Discovery;
  createClient(hooks: ClientHooks): EngineClient;
  clock: Clock;
  /** sw:ack-privacy (the privacy notice in the overlay was accepted). */
  ackPrivacy(): Promise<unknown>;
  /** Extra log sinks (the console in dev builds); cs:log to the engine is always on. */
  logSinks?: LogSink[];
  onTeardown?(reason: TeardownReason): void;
  /** Test builds: summary for E2E (test-hooks.ts). */
  onSummary?(summary: ContentSummary): void;
}

export interface Controller extends CommandTarget {
  readonly mode: "auto" | "manual";
  readonly log: Logger;
  start(): void;
  /** Synchronous variants of the command target (the controller never needs to wait). */
  toggleOverlay(): boolean;
  translateVisible(): number;
  translateImage(srcUrl: string, force: boolean): boolean;
  summary(): ContentSummary;
}

type Stage = "tracked" | "queued" | "reading" | "submitted";

interface ImageInfo {
  readonly image: TrackedImage;
  stage: Stage;
  /** Last state from the engine (or the engine client); null before the first one. */
  state: ImageState | null;
  error: ErrorInfo | null;
  /** Submitted and not terminal: a new request would only duplicate work. */
  active: boolean;
  everSubmitted: boolean;
  /** Natural size the unit geometry refers to (img:units / img:bulk, else the submitted size). */
  natural: Size | null;
  painted: Set<string>;
  lastPriority: number | null;
  /** The last submit was a tier-B prefetch (detection only). */
  prefetched: boolean;
  /** Translation wanted although the page may not have loaded the image (translate window, page load, user). */
  promoted: boolean;
  /** img:units said the picture came from a screen capture. */
  lowRes: boolean;
  /** Automatic capture retries so far. */
  captureRetries: number;
}

interface Queued {
  force: boolean;
  urgent: boolean;
  seq: number;
}

export function createController(deps: ControllerDeps): Controller {
  const { settings, clock } = deps;
  const images = new Map<string, ImageInfo>();
  const queue = new Map<string, Queued>();
  const offs: Array<() => void> = [];
  const logBuffer: LogEntry[] = [];
  let queueSeq = 0;
  let reading = 0;
  let pumpScheduled = false;
  let connected = false;
  let frameKey: string | null = null;
  let privacyNoticeKey: string | null = null;
  let cancelLogFlush: (() => void) | null = null;
  let tornDown = false;

  /* ---- cs:log sink: batched every 2 s, ≤ 50 entries per message, ≤ 500 kept ---- */

  const bufferLog: LogSink = (entry) => {
    logBuffer.push(entry);
    if (logBuffer.length > LOG_KEEP) logBuffer.splice(0, logBuffer.length - LOG_KEEP);
    armLogFlush();
  };

  function armLogFlush(): void {
    if (tornDown || !connected || cancelLogFlush !== null || logBuffer.length === 0) return;
    cancelLogFlush = clock.setTimer(flushLogs, LOG_FLUSH_MS);
  }

  function flushLogs(): void {
    cancelLogFlush = null;
    if (tornDown || !connected) return;
    const entries = logBuffer.slice(0, LOG_BATCH);
    if (client.post({ type: "cs:log", entries })) logBuffer.splice(0, entries.length);
    armLogFlush();
  }

  const log = createLogger("cs", {
    minLevel: settings.debug.logLevel,
    sinks: [bufferLog, ...(deps.logSinks ?? [])],
    now: () => clock.now(),
  });

  const client = deps.createClient({ log, reread });

  const overlay = deps.createOverlay(
    deps.doc,
    {
      shadowMode: __TEST__ ? "open" : "closed",
      mode: deps.mode,
      minFontPx: settings.render.minFontPx,
      maxFontPx: settings.render.maxFontPx,
      showDoneBadge: settings.render.showDoneBadge,
      font: settings.render.font,
      eraseSfx: settings.render.eraseSfx,
      sfxLabels: settings.render.sfxLabels,
      popupWithAltClick: settings.render.popupWithAltClick,
      // The engine resolves "auto" the same way, with the same browser languages.
      target: effectiveTarget(
        settings.translate.targetLang,
        settings.ui.locale,
        deps.doc.defaultView?.navigator?.languages ?? [],
      ).code,
      verticalText: settings.render.verticalText,
    },
    {
      onTranslateRequest: (imageKey) => {
        requestTranslate(imageKey, false);
      },
      onOverflow: (imageKey, unitKey, overflow) => {
        client.post({ type: "unit:overflow", imageKey, unitKey, overflow });
      },
      onPrivacyAccepted: () => acceptPrivacy(),
      // The engine answers both with img:unit to every frame showing the image.
      onEditUnit: (imageKey, unitKey, translation) =>
        !tornDown &&
        images.has(imageKey) &&
        client.post({ type: "unit:edit", imageKey, unitKey, translation }),
      onRetranslateUnit: (imageKey, unitKey) =>
        !tornDown && images.has(imageKey) && client.post({ type: "unit:retranslate", imageKey, unitKey }),
    },
  );

  const events: DiscoveryEvents = {
    onCandidate(image) {
      if (tornDown || images.has(image.imageKey)) return;
      images.set(image.imageKey, {
        image,
        stage: "tracked",
        state: null,
        error: null,
        active: false,
        everSubmitted: false,
        natural: null,
        painted: new Set(),
        lastPriority: null,
        prefetched: false,
        promoted: false,
        lowRes: false,
        captureRetries: 0,
      });
      overlay.attach(image);
      if (deps.mode === "auto") enqueue(image.imageKey, { force: false, urgent: false });
      publish();
    },
    onRemoved(imageKey) {
      const info = images.get(imageKey);
      if (info === undefined) return;
      images.delete(imageKey);
      queue.delete(imageKey);
      overlay.detach(imageKey);
      if (info.everSubmitted) client.forget([imageKey]);
      if (privacyNoticeKey === imageKey) privacyNoticeKey = null;
      publish();
    },
    onViewport(viewport, priorities) {
      if (tornDown) return;
      client.post({ type: "cs:viewport", ...viewport });
      const changed: Array<{ imageKey: string; priority: number }> = [];
      for (const item of priorities) {
        const info = images.get(item.imageKey);
        if (info === undefined || !info.active || info.lastPriority === item.priority) continue;
        info.lastPriority = item.priority;
        changed.push({ imageKey: item.imageKey, priority: item.priority });
      }
      // Also reorders the client's pending resubmissions when not connected.
      if (changed.length > 0) client.post({ type: "img:priority", items: changed });
      lastViewport = viewport;
      if (lastScrollY !== null && viewport.scrollY !== lastScrollY && !capture.active)
        lastScrollAt = clock.now();
      lastScrollY = viewport.scrollY;
      promoteInWindow(priorities);
      if ([...images.values()].some(wantsCaptureRetry)) scheduleCaptureCheck();
    },
    onResize() {
      if (!tornDown) overlay.relayout();
    },
    onLoaded(imageKey) {
      promote(imageKey, "loaded");
    },
  };

  const discovery = deps.createDiscovery(events);

  /* ---- look-ahead: prefetched images are translated inside the translate window ---- */

  const initialHorizons = computeHorizons({
    secondsPerScreen: settings.discovery.secondsPerScreenDefault,
    latencyMs: LOOKAHEAD.defaultLatencyMs,
    strip: false,
    settings: settings.discovery,
  });
  let translateScreens = initialHorizons.translateScreens;
  discovery.setHorizon({
    screens: initialHorizons.detectScreens,
    maxImages: initialHorizons.detectMaxImages,
  });

  /** The reader is near a prefetched image (or the page loaded it): submit it again without `prefetch`. */
  function promote(imageKey: string, why: "loaded" | "window", priority: number | null = null): void {
    const info = images.get(imageKey);
    if (tornDown || info === undefined || info.promoted) return;
    info.promoted = true;
    if (info.prefetched) {
      log.debug("prefetched image wanted now", { imageKey, why, priority, translateScreens });
    }
    if (info.prefetched && info.stage === "submitted") enqueue(imageKey, { force: false, urgent: false });
  }

  function promoteInWindow(priorities: ReadonlyArray<{ imageKey: string; priority: number }> | null): void {
    const items =
      priorities ??
      [...images.keys()].map((imageKey) => ({ imageKey, priority: discovery.priorityOf(imageKey) }));
    for (const { imageKey, priority } of items) {
      const info = images.get(imageKey);
      if (info?.prefetched !== true || info.promoted) continue;
      if (inTranslateWindow(priority, translateScreens)) promote(imageKey, "window", priority);
    }
  }

  /* ---- screen capture (ladder step 3) ---- */

  const captureWin = captureWindowOf(deps.doc);
  // Every frame answers its child frames (reader iframes) where they sit in the tab.
  const chain =
    captureWin === null
      ? null
      : createFrameChain({ win: captureWin as Window, doc: deps.doc, timers: clock, log });
  const capture = createCaptureAssist({
    doc: deps.doc,
    win: captureWin,
    timers: clock,
    elementOf: (imageKey) => images.get(imageKey)?.image.element ?? null,
    post: (message) => client.post(message),
    log,
    chain,
  });
  let lastViewport: ViewportInfo | null = null;
  let lastScrollY: number | null = null;
  let lastScrollAt = Number.NEGATIVE_INFINITY;
  let cancelCaptureCheck: (() => void) | null = null;

  function wantsCaptureRetry(info: ImageInfo): boolean {
    return (
      info.state === "error" &&
      !info.active &&
      info.captureRetries < CAPTURE_RETRY_MAX &&
      captureRetryWanted(info.error)
    );
  }

  function scheduleCaptureCheck(): void {
    if (tornDown || cancelCaptureCheck !== null) return;
    cancelCaptureCheck = clock.setTimer(captureCheck, CAPTURE_QUIET_MS);
  }

  /** Retries the captures that wait for their image to be on screen, once the reader stopped scrolling. */
  function captureCheck(): void {
    cancelCaptureCheck = null;
    if (tornDown) return;
    const waiting = [...images.values()].filter(wantsCaptureRetry);
    if (waiting.length === 0) return;
    if (capture.active || clock.now() - lastScrollAt < CAPTURE_QUIET_MS) {
      scheduleCaptureCheck();
      return;
    }
    const visible = discovery.onScreen().map((image) => image.imageKey);
    const due = waiting.filter((info) => visible.includes(info.image.imageKey));
    if (due.length === 0) return; // the next viewport sample brings them back
    // The engine checks what is on screen before it captures: give it the current list.
    if (lastViewport !== null) client.post({ type: "cs:viewport", ...lastViewport, onScreen: visible });
    for (const info of due) {
      info.captureRetries += 1;
      if (client.post({ type: "img:retry", imageKey: info.image.imageKey })) info.active = true;
      // The port went idle after the error: a new submit reconnects, and the engine restarts the failed image.
      else enqueue(info.image.imageKey, { force: false, urgent: true });
    }
    publish();
  }

  /* ---- submission: queue (urgent first, then priority), ladder step 1, client ---- */

  function enqueue(imageKey: string, options: { force: boolean; urgent: boolean }): void {
    const info = images.get(imageKey);
    if (tornDown || info === undefined) return;
    const previous = queue.get(imageKey);
    queue.set(imageKey, {
      force: (previous?.force ?? false) || options.force,
      urgent: (previous?.urgent ?? false) || options.urgent,
      seq: previous?.seq ?? queueSeq++,
    });
    if (info.stage === "tracked") info.stage = "queued";
    schedulePump();
  }

  /** A discovery scan reports every image synchronously: choose by priority once they are all queued. */
  function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function nextQueued(): string | null {
    let best: { key: string; urgent: boolean; rank: number; seq: number } | null = null;
    for (const [key, item] of queue) {
      // User requests keep click order; automatic ones follow the reading priority.
      const rank = item.urgent ? item.seq : discovery.priorityOf(key);
      const better =
        best === null ||
        (item.urgent && !best.urgent) ||
        (item.urgent === best.urgent && (rank < best.rank || (rank === best.rank && item.seq < best.seq)));
      if (better) best = { key, urgent: item.urgent, rank, seq: item.seq };
    }
    return best?.key ?? null;
  }

  function pump(): void {
    while (!tornDown && reading < MAX_LOCAL_READS && queue.size > 0) {
      const key = nextQueued();
      if (key === null) return;
      const item = queue.get(key);
      queue.delete(key);
      if (item === undefined) continue;
      reading += 1;
      void submitImage(key, item.force)
        .catch((error: unknown) =>
          log.error("submitting an image failed", { imageKey: key, error: errorMessage(error) }),
        )
        .finally(() => {
          reading -= 1;
          pump();
        });
    }
  }

  async function readLocal(element: ImageElement, src: string): Promise<LocalBytes | null> {
    try {
      return await deps.readLocalBytes(element, src, {
        maxBytes: maxLocalBytes(client.codec, settings.privacy.maxImageBytes),
        corsProbe: deps.siteEnabled,
      });
    } catch (error) {
      log.warn("ladder step 1 threw", { error: errorMessage(error) });
      return null;
    }
  }

  async function buildSubmit(info: ImageInfo, base: SubmitBase, force: boolean): Promise<ImageSubmit> {
    // A tier-B image has no pixels yet: the engine fetches its URL.
    const local = base.natural === null ? null : await readLocal(info.image.element, base.src);
    // A canvas has no fetchable URL: without local bytes only a screen capture can read it.
    const fallback = base.element === "canvas" ? "capture" : "url";
    const { prefetch, ...rest } = base;
    const submit: ImageSubmit = { ...rest, acquire: local === null ? fallback : "bytes" };
    if (prefetch === true && !info.promoted) submit.prefetch = true;
    if (local !== null) {
      submit.bytes = local.bytes;
      submit.mime = local.mime;
      submit.source = local.source;
    }
    if (force) submit.force = true;
    return submit;
  }

  async function submitImage(imageKey: string, force: boolean): Promise<void> {
    const info = images.get(imageKey);
    if (tornDown || info === undefined) return;
    const base = discovery.describe(imageKey);
    if (base === null) {
      info.stage = "tracked";
      publish();
      return;
    }
    info.stage = "reading";
    publish();
    const submit = await buildSubmit(info, base, force);
    if (tornDown || images.get(imageKey) !== info) return;
    info.stage = "submitted";
    info.state = null;
    info.error = null;
    info.active = true;
    info.everSubmitted = true;
    info.natural = base.natural;
    info.lastPriority = submit.priority;
    info.prefetched = submit.prefetch === true;
    client.submit(submit);
    // Promoted while this prefetch submit was being built: ask for the translation now.
    if (info.prefetched && info.promoted) enqueue(imageKey, { force: false, urgent: false });
    publish();
  }

  async function reread(submit: ImageSubmit): Promise<ImageSubmit | null> {
    const info = images.get(submit.imageKey);
    if (tornDown || info === undefined) return null;
    const base = discovery.describe(submit.imageKey);
    if (base === null) return null;
    return buildSubmit(info, base, submit.force === true);
  }

  /** Hover button, badge retry, context menu or command. */
  function requestTranslate(imageKey: string, force: boolean): boolean {
    const info = images.get(imageKey);
    if (tornDown || info === undefined) return false;
    info.promoted = true;
    if (info.prefetched && !queue.has(imageKey) && info.stage === "submitted" && !force) {
      enqueue(imageKey, { force: false, urgent: true });
      return true;
    }
    // A user request may show the privacy notice again: the overlay re-arms it after a decline (menu and command
    // requests do not pass through the overlay, so tell it).
    privacyNoticeKey = null;
    overlay.noteUserRequest(imageKey);
    if (queue.has(imageKey)) {
      enqueue(imageKey, { force, urgent: true });
      return true;
    }
    if (!force && (info.active || info.stage === "reading")) return true;
    const finished = info.state === "done" || info.state === "no-text";
    if (finished && !force) return true;
    // Partial, refused or failed in the engine: img:retry re-runs what is missing. Otherwise (stale result, an
    // error raised on this side, no port) a new submit, forced whenever the engine would replay its last result.
    const engineCanRetry =
      info.everSubmitted &&
      !finished &&
      info.state !== null &&
      info.state !== "stale" &&
      isTerminal(info.state, info.error ?? undefined) &&
      !(info.error !== null && CLIENT_ERRORS.has(info.error.code));
    if (engineCanRetry && !force && client.post({ type: "img:retry", imageKey })) {
      info.active = true;
      publish();
      return true;
    }
    enqueue(imageKey, { force: force || engineCanRetry || info.state === "stale", urgent: true });
    publish();
    return true;
  }

  /* ---- engine → overlay ---- */

  function paint(info: ImageInfo, natural: Size, unit: UnitRender): void {
    overlay.setUnit(info.image.imageKey, natural, unit);
    if (isPainted(unit)) info.painted.add(unit.unitKey);
    else info.painted.delete(unit.unitKey);
  }

  function onImageState(message: EngineToCsMap["img:state"]): void {
    const info = images.get(message.imageKey);
    if (info === undefined) return;
    info.state = message.state;
    info.error = message.error ?? null;
    if (isTerminal(message.state, message.error)) info.active = false;
    overlay.setState(message.imageKey, message.state, stateInfo(message));
    const waitingForConsent = message.state === "paused" && message.error?.code === "privacy.consent";
    if (waitingForConsent) showPrivacyNotice(message.imageKey);
    else if (privacyNoticeKey === message.imageKey) privacyNoticeKey = null; // the overlay hid that notice
    if (wantsCaptureRetry(info)) scheduleCaptureCheck();
    publish();
  }

  /** One notice per page, next to the first image waiting for consent; the overlay decides after a decline. */
  function showPrivacyNotice(imageKey: string): void {
    if (privacyNoticeKey !== null && images.has(privacyNoticeKey)) return;
    privacyNoticeKey = imageKey;
    overlay.showPrivacyNotice(imageKey);
  }

  function acceptPrivacy(): void {
    privacyNoticeKey = null;
    deps.ackPrivacy().then(
      () => log.info("privacy notice accepted"),
      (error: unknown) => log.warn("sw:ack-privacy failed", { error: errorMessage(error) }),
    );
  }

  offs.push(
    client.on("en:hello", (message) => {
      frameKey = message.frameKey;
      publish();
    }),
    client.on("img:units", (message) => {
      const info = images.get(message.imageKey);
      if (info === undefined) return;
      info.natural = message.natural;
      if (message.lowRes === true) info.lowRes = true;
      overlay.setUnits(message.imageKey, message.natural, message.units);
      publish();
    }),
    client.on("img:unit", (message) => {
      const info = images.get(message.imageKey);
      if (info === undefined) return;
      paint(info, info.natural ?? elementNatural(info.image.element), message.unit);
      publish();
    }),
    client.on("img:bulk", (message) => {
      const info = images.get(message.imageKey);
      if (info === undefined) return;
      info.natural = message.natural;
      for (const unit of message.units) paint(info, message.natural, unit);
      publish();
    }),
    client.on("img:state", onImageState),
    client.on("img:scroll-to", (message) => {
      if (!overlay.scrollToUnit(message.imageKey, message.unitKey)) {
        log.debug("scroll-to: unknown unit", { imageKey: message.imageKey, unitKey: message.unitKey });
      }
    }),
    client.on("img:done", (message) => {
      const info = images.get(message.imageKey);
      if (info === undefined) return;
      info.active = false;
      if (info.state === null || !isTerminal(info.state, info.error ?? undefined)) info.state = "done";
      publish();
    }),
    client.on("cap:prepare", (message) => capture.prepare(message)),
    client.on("cap:done", (message) => capture.done(message)),
    client.on("en:horizons", (message) => {
      discovery.setHorizon(horizonFrom(message, settings.discovery));
      if (Number.isFinite(message.translateScreens)) translateScreens = Math.max(0, message.translateScreens);
      promoteInWindow(null);
    }),
    client.onState((state) => {
      connected = state === "open";
      if (state === "dead") {
        teardown("ctx.invalidated");
        return;
      }
      armLogFlush();
      publish();
    }),
  );

  /* ---- summary and teardown ---- */

  function summary(): ContentSummary {
    const states: Record<string, string> = {};
    const painted: Record<string, number> = {};
    const lowRes: string[] = [];
    const prefetch: string[] = [];
    const ids: Record<string, string> = {};
    const errors: Record<string, string> = {};
    let paintedTotal = 0;
    for (const [key, info] of images) {
      states[key] = info.state ?? info.stage;
      painted[key] = info.painted.size;
      paintedTotal += info.painted.size;
      if (info.lowRes) lowRes.push(key);
      if (info.prefetched && !info.promoted) prefetch.push(key);
      const id: unknown = info.image.element.id;
      if (typeof id === "string" && id !== "") ids[key] = id;
      if (info.error !== null) errors[key] = info.error.code;
    }
    return {
      mode: deps.mode,
      client: client.state,
      frameKey,
      images: states,
      painted,
      paintedTotal,
      lowRes,
      prefetch,
      ids,
      errors,
      tornDown,
    };
  }

  function publish(): void {
    if (deps.onSummary !== undefined) deps.onSummary(summary());
  }

  /* ---- peek at the original (hold settings.render.peekKey) ---- */

  function startPeek(): void {
    const win = deps.doc.defaultView;
    if (win === null || win === undefined || typeof win.addEventListener !== "function") return;
    if (settings.render.peekKey === "" && !settings.render.peekWithAlt) return;
    /** The overlay was visible when the peek started, so it comes back when the peek ends. */
    let restore = false;
    const peek = createPeek({
      win,
      key: settings.render.peekKey,
      withAlt: settings.render.peekWithAlt,
      onPeek: (active) => {
        if (tornDown) return;
        if (active) {
          restore = overlay.visible;
          if (restore) overlay.setVisible(false);
        } else if (restore) {
          restore = false;
          overlay.setVisible(true);
        }
      },
    });
    offs.push(() => peek.destroy());
  }

  /** Observers, listeners, timers, the port and every overlay host go away; idempotent. */
  function teardown(reason: TeardownReason): void {
    if (tornDown) return;
    tornDown = true;
    cancelLogFlush?.();
    cancelLogFlush = null;
    cancelCaptureCheck?.();
    cancelCaptureCheck = null;
    queue.clear();
    for (const off of offs.splice(0)) off();
    capture.destroy();
    chain?.destroy();
    discovery.destroy();
    client.close();
    overlay.destroy();
    images.clear();
    publish();
    deps.onTeardown?.(reason);
  }

  return {
    mode: deps.mode,
    log,
    start() {
      if (tornDown) return;
      startPeek();
      discovery.start();
      log.info("content script started", { mode: deps.mode });
      publish();
    },
    toggleOverlay() {
      if (tornDown) return false;
      overlay.setVisible(!overlay.visible);
      return overlay.visible;
    },
    translateVisible() {
      if (tornDown) return 0;
      let requested = 0;
      for (const image of discovery.onScreen()) {
        const info = images.get(image.imageKey);
        if (info === undefined || info.active || info.stage === "reading") continue;
        if (info.state !== null && SETTLED_FOR_VISIBLE.has(info.state)) continue;
        if (requestTranslate(image.imageKey, false)) requested += 1;
      }
      return requested;
    },
    translateImage(srcUrl, force) {
      if (tornDown) return false;
      const image = discovery.findBySrc(srcUrl);
      if (image === null) return false;
      // findBySrc reports a newly tracked image through onCandidate; this covers a discovery that does not.
      if (!images.has(image.imageKey)) events.onCandidate(image);
      return requestTranslate(image.imageKey, force);
    },
    teardown,
    summary,
  };
}
