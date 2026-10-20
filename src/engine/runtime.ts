// Engine composition root. main.ts builds the ReadyGate, registers the listeners synchronously and then calls
// startRuntime(gate, factories) from a lazy chunk. Boot order: open the stores, load the kv settings mirror, pull
// sw:get-settings (2 s; on failure keep the mirror or the defaults), sw:ping codec self-test, log sink to the
// LogStore, services through the factories in dependency order, first /models check (not awaited), phase "ready",
// gate.drain(). Retention runs later, at most once per 24 h and only while idle. Nothing here awaits ORT: the
// detector loads its model when a page in auto mode says hello (or at the first detection).

import { consoleSink, createLogger, type LogLevel, type LogSink, type Logger } from "../platform/log.ts";
import { callSw } from "../platform/messaging.ts";
import { systemClock } from "../shared/clock.ts";
import type { Gfx } from "../shared/gfx.ts";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";
import { findEnabledSite } from "../shared/site.ts";
import type { Settings, SiteSettings } from "../shared/settings.ts";
import type { Codec, EnginePhase, EngineStatus, LogEntry, OfflineStatus } from "../shared/types.ts";
import { codecFromProbe, makeProbe } from "../shared/wire.ts";
import type {
  ApiHealth,
  Clock,
  CoreDeps,
  EngineStores,
  LogStore,
  OfflinePackTranslator,
  PackReport,
  PackTranslator,
  Pipeline,
  ServiceFactories,
  SettingsSource,
  TextDetector,
  TranslatePack,
  UnitResult,
  UploadCounter,
} from "./contracts.ts";
import { createMutex } from "./detector.ts";
import { createModelFiles } from "./model-files.ts";
import { createCaptureAssist, SW_CAPTURE_TIMEOUT_MS, type CaptureAssist } from "./capture.ts";
import { createEraser } from "./erase.ts";
import { createCsHandler } from "./handlers-cs.ts";
import {
  assembleStatus,
  createStatusPusher,
  createUiHandlers,
  handleUiMessage,
  type Lifecycle,
} from "./handlers-ui.ts";
import { createIdleMonitor, type IdleMonitor } from "./idle.ts";
import { createBadgeFeed } from "./badge-feed.ts";
import { createFrameRegistry, createUiRegistry, type FrameRegistry, type UiRegistry } from "./ports.ts";
import type { GateDispatch, PortEntry, ReadyGate } from "./ready-gate.ts";
import { createSettingsCache } from "./settings-cache.ts";
import { DAY_MS, runRetention } from "./store/retention.ts";

export const SETTINGS_PULL_TIMEOUT_MS = 2_000;
export const SW_PING_TIMEOUT_MS = 2_000;
/** A "closing" engine that is still alive after this goes back to "ready" (e.g. the SW restarted meanwhile). */
export const CLOSE_REVERT_MS = 5_000;
/** Status recompute / busy / idle check while running (pushes happen only on change). */
export const STATUS_TICK_MS = 2_000;
/** Retention never runs on the startup path. */
export const RETENTION_FIRST_CHECK_MS = 60_000;
export const RETENTION_RETRY_MS = 5 * 60_000;

export interface RuntimeEnv {
  clock?: Clock;
  /** Replaces the default logger (console + LogStore ring buffer). */
  log?: Logger;
  /** Extra sinks of the default logger. */
  sinks?: LogSink[];
  /** Overrides factories.createGfx. */
  gfx?: Gfx;
  settingsTimeoutMs?: number;
}

export interface EngineRuntime {
  readonly phase: () => EnginePhase;
  readonly status: () => EngineStatus;
  /** startRuntime() call → phase "ready", in ms of the runtime clock. */
  readonly bootMs: number;
  /** Codec of the engine ↔ SW channel from the sw:ping self-test. */
  readonly swCodec: Codec;
  readonly settings: SettingsSource;
  readonly stores: EngineStores;
  readonly health: ApiHealth;
  readonly detector: TextDetector;
  readonly uploads: UploadCounter;
  readonly pipeline: Pipeline;
  readonly frames: FrameRegistry;
  readonly ui: UiRegistry;
  readonly idle: IdleMonitor;
  /** Stops timers and services, closes ports and the database (tests, shutdown). */
  readonly stop: () => Promise<void>;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };
/** Entries kept until the LogStore exists. */
const EARLY_LOG_LIMIT = 500;

export interface EngineLogging {
  readonly logger: Logger;
  /** Starts writing into the ring buffer (and flushes what was logged before). */
  readonly attach: (logs: LogStore) => void;
}

/** The engine logger: settings.debug.logLevel filter, console in dev builds (warnings always), LogStore ring buffer. */
export function createEngineLogging(options: {
  clock: Clock;
  level: () => LogLevel;
  sinks?: LogSink[];
  console?: boolean;
}): EngineLogging {
  let store: LogStore | null = null;
  const early: LogEntry[] = [];
  const toConsole = options.console ?? __DEV__;
  const sink: LogSink = (entry) => {
    if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[options.level()]) return;
    if (toConsole || entry.level === "warn" || entry.level === "error") consoleSink(entry);
    if (store !== null) store.append(entry);
    else if (early.length < EARLY_LOG_LIMIT) early.push(entry);
  };
  return {
    logger: createLogger("engine", {
      minLevel: "debug",
      sinks: [sink, ...(options.sinks ?? [])],
      now: () => options.clock.now(),
    }),
    attach: (logs) => {
      store = logs;
      for (const entry of early.splice(0)) logs.append(entry);
    },
  };
}

async function pullSettings(
  timeoutMs: number,
  log: Logger,
): Promise<{ settings: Settings; sites: Record<string, SiteSettings> } | null> {
  try {
    return await callSw("sw:get-settings", {}, { timeoutMs });
  } catch (error) {
    log.warn("sw:get-settings failed", { error: String(error) });
    return null;
  }
}

async function pingSw(log: Logger): Promise<Codec> {
  try {
    const reply = await callSw("sw:ping", { probe: makeProbe() }, { timeoutMs: SW_PING_TIMEOUT_MS });
    const codec = codecFromProbe(reply.probe);
    log.info("codec self-test", { channel: "sw", codec });
    return codec;
  } catch (error) {
    log.warn("sw:ping failed, assuming structured clone", { error: String(error) });
    return "sc";
  }
}

/** The offline engine's status before its first pack. */
export function idleOffline(settings: Settings): OfflineStatus {
  return { state: "idle", model: settings.translate.offlineModel, active: [], download: null, error: null };
}

/** Offline mode without an offline translator (test factories): every unit fails with offline.run. */
export function offlineUnavailable(
  pack: TranslatePack,
  onUnit: (result: UnitResult) => void,
): Promise<PackReport> {
  for (const unit of pack.units) {
    onUnit({
      contentKey: unit.contentKey,
      unitKey: unit.unitKey,
      status: "error",
      type: "dialogue",
      speaker: "",
      original: "",
      translation: "",
      lang: null,
      model: null,
    });
  }
  return Promise.resolve({
    packId: pack.packId,
    requests: 0,
    missing: pack.units.map((unit) => unit.unitKey),
    error: { code: "offline.run", message: "offline mode is not available in this engine", retryable: false },
    model: null,
    lang: null,
    firstLineMs: null,
    totalMs: 0,
    uploadedBytes: 0,
  });
}

/** Port messages that never change the status. */
const QUIET_CS_TYPES: ReadonlySet<string> = new Set(["cs:log", "cs:heartbeat", "cs:viewport"]);
/** Posts that are themselves status traffic. */
const QUIET_POSTS: ReadonlySet<string> = new Set(["en:status", "en:hello", "en:closing"]);

/**
 * Boots the engine behind `gate`. Never rejects: a boot failure calls gate.fail() and resolves null, so main.ts can
 * fire and forget it.
 */
export async function startRuntime(
  gate: ReadyGate,
  factories: ServiceFactories,
  env: RuntimeEnv = {},
): Promise<EngineRuntime | null> {
  const clock = env.clock ?? systemClock;
  const started = clock.now();
  const holder: { settings: SettingsSource | null } = { settings: null };
  const logging = createEngineLogging({
    clock,
    level: () => holder.settings?.current().debug.logLevel ?? "info",
    sinks: env.sinks ?? [],
  });
  const log = env.log ?? logging.logger;
  gate.setLogger(log);
  const settings = createSettingsCache({ clock, log });
  holder.settings = settings;
  const core: CoreDeps = { clock, log, settings };

  let stores: EngineStores | null = null;
  try {
    stores = await factories.openStores(core);
    logging.attach(stores.logs);
    const mirror = settings.attach(stores.kv);
    const [pulled, swCodec] = await Promise.all([
      pullSettings(env.settingsTimeoutMs ?? SETTINGS_PULL_TIMEOUT_MS, log),
      pingSw(log),
    ]);
    const mirrored = await mirror;
    if (pulled !== null) settings.apply(pulled.settings, pulled.sites);
    else log.warn(mirrored ? "using the settings mirror" : "using default settings");
    const gfx = env.gfx ?? factories.createGfx(core);
    return compose({ gate, factories, core, stores, gfx, swCodec, started });
  } catch (error) {
    gate.fail(error);
    if (stores !== null) {
      await stores.close().catch((closeError: unknown) => {
        log.warn("closing stores after a failed boot", { error: String(closeError) });
      });
    }
    return null;
  }
}

interface ComposeInput {
  gate: ReadyGate;
  factories: ServiceFactories;
  core: CoreDeps;
  stores: EngineStores;
  gfx: Gfx;
  swCodec: Codec;
  started: number;
}

/** Creates the services in dependency order, wires ports and handlers, then drains the gate. */
function compose(input: ComposeInput): EngineRuntime {
  const { gate, factories, core, stores, gfx, swCodec } = input;
  const { clock, log, settings } = core;
  let phase: EnginePhase = "booting";
  let stopped = false;
  let pipeline: Pipeline | null = null;
  let capture: CaptureAssist | null = null;
  let markDirty: () => void = () => undefined;
  let checkIdle: () => void = () => undefined;

  // build-info.json (the offline catalog), read once when offline mode first needs it.
  const buildFiles = createModelFiles({
    getURL: (path) => chrome.runtime.getURL(path),
    fetch: (url) => fetch(url),
    store: stores.models,
    now: () => clock.now(),
    log,
  });
  const readBuildInfo = (): ReturnType<typeof buildFiles.buildInfo> => buildFiles.buildInfo();

  const portsChanged = (): void => {
    checkIdle();
    markDirty();
  };
  const badges = createBadgeFeed({ log, send: (request) => callSw("sw:badge", request) });
  const frames = createFrameRegistry({
    clock,
    log,
    events: {
      frameGone: (frameKey) => {
        capture?.frameGone(frameKey);
        badges.forgetFrame(frameKey);
        pipeline?.frameGone(frameKey);
      },
      frameReplaced: (frame) => pipeline?.frameReplaced(frame),
    },
    defaultMode: (siteKey) => settings.site(siteKey).mode,
    onPost: (frame, message) => {
      if (message.type === "img:state") {
        badges.observe(frame.info.tabId, frame.info.frameKey, message.imageKey, message.state);
      }
      if (!QUIET_POSTS.has(message.type)) markDirty();
    },
    onPortsChanged: portsChanged,
  });
  const ui = createUiRegistry({ log, onPortsChanged: portsChanged });

  const health = factories.createHealth(core);
  // Ladder step 3: screen captures through the frame (cap:prepare / cap:ready) and the service worker (sw:capture).
  const captureAssist = createCaptureAssist({
    clock,
    log,
    gfx,
    post: (frameKey, message) => frames.get(frameKey)?.post(message) ?? false,
    callSw: (type, payload) => callSw(type, payload, { timeoutMs: SW_CAPTURE_TIMEOUT_MS }),
    swCodec: () => swCodec,
    // A reader iframe belongs to the enabled site that lists its origin in extraFrameOrigins.
    siteEnabled: (frame, ctx) => ctx.site.enabled || findEnabledSite(frame.url, settings.sites()) !== null,
  });
  capture = captureAssist;
  const acquirer = factories.createAcquirer({ ...core, capture: captureAssist });
  const decoder = factories.createDecoder(core);
  // One lock around every ORT call of the engine's instance: the detector and the offline recognizers (the offline
  // translation models have their own instance in a worker, offline/mt-worker.ts).
  const ortLock = createMutex();
  const detector = factories.createDetector({ ...core, stores, gfx, exclusive: ortLock });
  const composite = factories.createComposite({ ...core, gfx });
  const uploads = factories.createUploads({ ...core, stores });
  const apiTranslator = factories.createTranslator({
    ...core,
    health,
    composite,
    uploads,
    // The pipeline exists by the time a pack can hit a 429 or a watchdog timeout.
    onConcurrencyCap: (cap) => pipeline?.throttle(cap.value, cap.forMs),
  });
  // Offline mode (experimental): created on first use, so API-mode engines never load its code paths' models.
  let offlineTranslator: OfflinePackTranslator | null = null;
  const offline = (): OfflinePackTranslator | null => {
    if (offlineTranslator === null && factories.createOfflineTranslator !== undefined) {
      offlineTranslator = factories.createOfflineTranslator({
        ...core,
        stores,
        gfx,
        exclusive: ortLock,
        catalog: async () => (await readBuildInfo()).offline ?? [],
        detectorBackend: () => detector.state().backend,
      });
    }
    return offlineTranslator;
  };
  // Each pack goes to the engine configured when it starts: the API translator, or the offline one.
  const translator: PackTranslator = {
    translate: (pack, onUnit) => {
      if (settings.current().translate.engine !== "offline") return apiTranslator.translate(pack, onUnit);
      const engine = offline();
      return engine === null ? offlineUnavailable(pack, onUnit) : engine.translate(pack, onUnit);
    },
  };

  const idle = createIdleMonitor({
    clock,
    log,
    settings,
    ports: () => frames.connectedCount() + ui.count(),
    workIdle: () => pipeline?.idle() ?? true,
    notifyIdle: (idleSinceMs) => callSw("sw:engine-idle", { idleSinceMs }),
    detector: () => detector,
  });
  checkIdle = () => idle.check();

  // The pipeline sees a detector that reports its activity, so the idle monitor can release the session.
  const trackedDetector: TextDetector = {
    state: () => detector.state(),
    detect: async (image, options) => {
      idle.detectionStarted();
      try {
        return await detector.detect(image, options);
      } finally {
        idle.detectionFinished();
      }
    },
    unitsFrom: (raw, size, options, slices) => detector.unitsFrom(raw, size, options, slices),
    // A warm-up counts as activity: a session loaded for a page that never sends an image is released like any other.
    warmup: async () => {
      idle.detectionStarted();
      try {
        await detector.warmup();
      } finally {
        idle.detectionFinished();
      }
    },
    release: () => detector.release(),
  };

  const activePipeline = factories.createPipeline({
    ...core,
    stores,
    health,
    acquirer,
    decoder,
    detector: trackedDetector,
    translator,
    ui,
    eraser: createEraser({ gfx, log }),
  });
  pipeline = activePipeline;

  const status = (): EngineStatus =>
    assembleStatus({
      phase: () => phase,
      health,
      checkedAt: () => health.checkedAt(),
      detector,
      pipeline: activePipeline,
      uploads,
      log,
      engine: () => settings.current().translate.engine,
      offline: () => offlineTranslator?.state() ?? idleOffline(settings.current()),
    });

  const pusher = createStatusPusher({
    clock,
    compute: status,
    publish: (snapshot) => {
      frames.broadcast({ type: "en:status", status: snapshot });
      ui.post({ type: "en:status", status: snapshot });
    },
  });
  markDirty = () => pusher.markDirty();
  const unsubscribeHealth = health.onChange(() => markDirty());
  const unsubscribeSettings = settings.onChange(() => markDirty());

  let cancelRevert: (() => void) | null = null;
  const lifecycle: Lifecycle = {
    phase: () => phase,
    prepareClose: () => {
      if (phase === "closing") return true;
      if (phase !== "ready" || !idle.isIdle()) return false;
      phase = "closing";
      log.info("engine closing");
      cancelRevert?.();
      cancelRevert = clock.setTimer(() => {
        cancelRevert = null;
        if (phase !== "closing" || stopped) return;
        phase = "ready";
        log.info("still alive after prepare-close, back to ready");
        markDirty();
        idle.check();
      }, CLOSE_REVERT_MS);
      return true;
    },
  };

  const csHandler = createCsHandler({
    log,
    frames,
    pipeline: activePipeline,
    logs: stores.logs,
    capture: captureAssist,
    now: () => clock.now(),
    onHello: (frame, hello) => {
      const codec = frames.hello(frame, hello);
      // A page in auto mode submits its images next: the model loads (and WebGPU compiles) while they download.
      if (hello.mode === "auto" && detector.state().state === "unloaded") void trackedDetector.warmup();
      if (hello.v !== PROTOCOL_VERSION)
        log.warn("content protocol mismatch", { frameKey: frame.info.frameKey });
      frame.post({
        type: "en:hello",
        v: PROTOCOL_VERSION,
        build: __BUILD_ID__,
        probe: makeProbe(),
        codec,
        frameKey: frame.info.frameKey,
        status: status(),
      });
    },
  });
  const uiPortDeps = { ui, status, log };
  const handlers = createUiHandlers({
    log,
    settings,
    stores,
    pipeline: activePipeline,
    frames,
    lifecycle,
    status,
    changed: () => markDirty(),
    clock,
  });

  /** While closing, new ports learn it and are disconnected (they reconnect to the next engine). */
  const refuse = (entry: PortEntry): void => {
    if (entry.kind === "engine") entry.port.post({ type: "en:closing" });
    else entry.port.post({ type: "en:status", status: status() });
    entry.port.close();
  };

  const dispatch: GateDispatch = {
    portOpened: (entry) => {
      if (phase === "closing") {
        refuse(entry);
        return;
      }
      if (entry.kind === "engine") {
        const frame = frames.open(entry);
        // The gate already answered this frame's hello with phase "booting": apply it and send the real status.
        if (entry.hello !== null) {
          frames.hello(frame, entry.hello);
          frame.post({ type: "en:status", status: status() });
        }
      } else {
        const client = ui.open(entry);
        if (entry.hello !== null) ui.hello(client, entry.hello);
      }
    },
    engineMessage: (entry, message) => {
      const frame = frames.forEntry(entry);
      if (frame === undefined) return;
      csHandler(frame, message);
      if (!QUIET_CS_TYPES.has(message.type)) markDirty();
    },
    uiMessage: (entry, message) => {
      const client = ui.get(entry);
      if (client !== undefined) handleUiMessage(client, message, uiPortDeps);
    },
    portClosed: (entry) => {
      if (entry.kind === "engine") frames.closed(entry);
      else ui.closed(entry);
    },
    handlers,
  };

  let cancelTick: (() => void) | null = null;
  const tick = (): void => {
    cancelTick = null;
    if (stopped) return;
    try {
      health.setBusy(!activePipeline.idle());
    } catch (error) {
      log.warn("pipeline.idle threw", { error: String(error) });
    }
    markDirty();
    idle.check();
    cancelTick = clock.setTimer(tick, STATUS_TICK_MS);
  };

  let cancelRetention: (() => void) | null = null;
  const scheduleRetention = (delayMs: number): void => {
    cancelRetention?.();
    cancelRetention = clock.setTimer(
      () => {
        cancelRetention = null;
        void retentionCheck();
      },
      Math.max(0, delayMs),
    );
  };
  const retentionCheck = async (): Promise<void> => {
    if (stopped) return;
    try {
      const last = (await stores.kv.get("retention.lastRunAt")) ?? 0;
      const now = clock.now();
      if (now - last < DAY_MS) {
        scheduleRetention(last + DAY_MS - now);
        return;
      }
      if (stopped) return;
      if (!activePipeline.idle()) {
        scheduleRetention(RETENTION_RETRY_MS);
        return;
      }
      await runRetention({ stores, settings: settings.current(), now, log });
      scheduleRetention(DAY_MS);
    } catch (error) {
      log.warn("retention failed", { error: String(error) }, "store.io");
      scheduleRetention(RETENTION_RETRY_MS);
    }
  };

  void health.refresh();
  phase = "ready";
  const bootMs = clock.now() - input.started;
  log.info("engine ready", { bootMs, swCodec });
  gate.drain(dispatch);
  markDirty();
  idle.check();
  tick();
  scheduleRetention(RETENTION_FIRST_CHECK_MS);

  return {
    phase: () => phase,
    status,
    bootMs,
    swCodec,
    settings,
    stores,
    health,
    detector,
    uploads,
    pipeline: activePipeline,
    frames,
    ui,
    idle,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      cancelTick?.();
      cancelRetention?.();
      cancelRevert?.();
      pusher.stop();
      idle.stop();
      unsubscribeHealth();
      unsubscribeSettings();
      health.stop();
      await offlineTranslator?.release().catch((error: unknown) => {
        log.warn("offline release failed", { error: String(error) });
      });
      frames.closeAll();
      ui.closeAll();
      await stores.close();
    },
  };
}
