// en:* one-shot handlers (SW and extension pages) and Port "ui" messages, plus the EngineStatus snapshot and its
// throttled push (≤ 4 per second) to frames and ui:watch subscribers.
// Glossary and series edits (side panel) go straight to the stores with the rules of shared/core/memory.ts; every
// payload is validated, and an invalid one fails with engine.protocol.

import type { Logger } from "../platform/log.ts";
import type { Handlers } from "../platform/messaging.ts";
import { systemClock } from "../shared/clock.ts";
import { readinessErrorCode, type HealthReading } from "../shared/core/health.ts";
import {
  applySeriesPatch,
  confirmEntry,
  isInconsistent,
  manualEntry,
  newSeriesProfile,
  rankEntries,
  sanitizeSeriesPatch,
  termKey,
} from "../shared/core/memory.ts";
import { CtvError } from "../shared/errors.ts";
import { PROTOCOL_VERSION, type EngineApi, type UiToEngine } from "../shared/protocol.ts";
import type { GlossaryEntry } from "../shared/records.ts";
import { pageKeysOf, siteOfSeries, type PageKeys } from "../shared/series-key.ts";
import type {
  Bytes,
  EnginePhase,
  EngineStatus,
  GlossaryEdit,
  OfflineStatus,
  Transcript,
  TranscriptItem,
} from "../shared/types.ts";
import { makeProbe } from "../shared/wire.ts";
import type {
  ApiHealth,
  Clock,
  EngineStores,
  Pipeline,
  SettingsSource,
  TextDetector,
  UploadCounter,
} from "./contracts.ts";
import type { FrameHandle, FrameRegistry, UiClient, UiRegistry } from "./ports.ts";
import { placeholderStatus } from "./ready-gate.ts";
import { clearCache, type CacheScope } from "./store/retention.ts";

/* ------------------------------------------------------------------ status */

export interface StatusSources {
  phase: () => EnginePhase;
  health: ApiHealth;
  /** Epoch ms of the last /models check. */
  checkedAt: () => number;
  detector: TextDetector;
  pipeline: Pipeline;
  uploads: UploadCounter;
  log?: Logger;
  /** settings.translate.engine; absent = "api". */
  engine?: () => "api" | "offline";
  /** The offline engine's state (offline mode). */
  offline?: () => OfflineStatus | null;
}

/** One EngineStatus snapshot; a failing source falls back to its "unknown" value instead of failing the status. */
export function assembleStatus(sources: StatusSources): EngineStatus {
  const base = placeholderStatus(sources.phase());
  const read = <T>(what: string, get: () => T, fallback: T): T => {
    try {
      return get();
    } catch (error) {
      sources.log?.warn("status source threw", { what, error: String(error) });
      return fallback;
    }
  };
  const reading = read<HealthReading | null>("health", () => sources.health.reading(), null);
  const detector = read("detector", () => sources.detector.state(), base.detector);
  const queue = read("queue", () => sources.pipeline.queueStatus(), base.queue);
  const uploads = read("uploads", () => sources.uploads.today(), base.uploads);
  const engine = read("engine", () => sources.engine?.() ?? "api", "api" as const);
  const offline = engine === "offline" ? read("offline", () => sources.offline?.() ?? null, null) : null;
  return {
    phase: base.phase,
    build: base.build,
    api:
      reading === null
        ? base.api
        : {
            readiness: reading.readiness,
            model: reading.model,
            cause: reading.cause,
            checkedAt: read("checkedAt", sources.checkedAt, 0),
          },
    detector: { backend: detector.backend, state: detector.state, canary: detector.canary },
    queue: {
      queued: queue.queued,
      inFlight: queue.inFlight,
      urgentInFlight: queue.urgentInFlight,
      done: queue.done,
      failed: queue.failed,
      // The translator waits on /models even when the pipeline itself reports no pause (not in offline mode).
      pausedBy:
        queue.pausedBy ??
        (reading === null || engine === "offline" ? null : readinessErrorCode(reading.readiness)),
      concurrency: queue.concurrency,
      boxBudget: queue.boxBudget,
    },
    uploads: { today: uploads.today, bytesToday: uploads.bytesToday },
    ...(engine === "offline" ? { engine } : {}),
    ...(offline === null ? {} : { offline }),
  };
}

/** Status identity for change detection: the time of the last /models check alone is not a change. */
export function statusKey(status: EngineStatus): string {
  return JSON.stringify({ ...status, api: { ...status.api, checkedAt: 0 } });
}

export const STATUS_MIN_INTERVAL_MS = 250;

export interface StatusPusher {
  /** Something may have changed: push within the throttle window if the status differs from the last push. */
  readonly markDirty: () => void;
  readonly stop: () => void;
}

export interface StatusPusherOptions {
  clock: Clock;
  compute: () => EngineStatus;
  publish: (status: EngineStatus) => void;
  minIntervalMs?: number;
}

export function createStatusPusher(options: StatusPusherOptions): StatusPusher {
  const { clock } = options;
  const minInterval = options.minIntervalMs ?? STATUS_MIN_INTERVAL_MS;
  let lastKey: string | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let cancel: (() => void) | null = null;
  let stopped = false;

  const push = (): void => {
    cancel = null;
    lastAt = clock.now();
    const status = options.compute();
    const key = statusKey(status);
    if (key === lastKey) return;
    lastKey = key;
    options.publish(status);
  };

  return {
    markDirty: () => {
      if (cancel !== null || stopped) return;
      cancel = clock.setTimer(push, Math.max(0, lastAt + minInterval - clock.now()));
    },
    stop: () => {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}

/* ------------------------------------------------------------------ one-shots */

export interface Lifecycle {
  readonly phase: () => EnginePhase;
  /** en:prepare-close: true (phase "closing") only while the engine is idle. */
  readonly prepareClose: () => boolean;
}

export interface UiHandlerDeps {
  log: Logger;
  settings: SettingsSource;
  stores: EngineStores;
  pipeline: Pipeline;
  frames: FrameRegistry;
  lifecycle: Lifecycle;
  status: () => EngineStatus;
  /** The status may have changed (settings applied, edit, cache cleared). */
  changed?: () => void;
  /** Time source for glossary and series edits (default systemClock). */
  clock?: Clock;
}

const SCOPES: readonly CacheScope[] = ["all", "site", "series"];

function invalid(type: string): CtvError {
  return new CtvError("engine.protocol", `${type}: invalid payload`);
}

/** Entries per glossary call (an import is sent in chunks). */
export const MAX_GLOSSARY_EDITS = 500;
const MAX_SERIES_KEY_CHARS = 2_048;

/** A seriesKey ("origin|slug", src/shared/series-key.ts) from a payload, or invalid(type). */
function seriesKeyFrom(type: keyof EngineApi, value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_SERIES_KEY_CHARS || siteOfSeries(value) === null) {
    throw invalid(type);
  }
  return value;
}

/** Glossary keys (cleaned originals) from a payload, or invalid(type). */
function origsFrom(type: keyof EngineApi, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_GLOSSARY_EDITS) throw invalid(type);
  return (value as unknown[]).map((orig) => {
    const key = typeof orig === "string" ? termKey(orig) : "";
    if (key === "") throw invalid(type);
    return key;
  });
}

/** Complete edits (original and translation set; note optional) by glossary key, or invalid(type). */
function editsFrom(type: keyof EngineApi, value: unknown): Map<string, GlossaryEdit> {
  if (!Array.isArray(value) || value.length > MAX_GLOSSARY_EDITS) throw invalid(type);
  const edits = new Map<string, GlossaryEdit>();
  for (const raw of value as unknown[]) {
    const edit = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
      Record<keyof GlossaryEdit, unknown>
    >;
    const note = edit.note ?? "";
    if (typeof edit.orig !== "string" || typeof edit.translation !== "string" || typeof note !== "string") {
      throw invalid(type);
    }
    const key = termKey(edit.orig);
    if (key === "" || edit.translation.trim() === "") throw invalid(type);
    edits.set(key, { orig: key, translation: edit.translation, note });
  }
  return edits;
}

/** A series memory store, or engine.internal when this engine runs without them. */
function required<T>(store: T | undefined, type: keyof EngineApi): T {
  if (store === undefined)
    throw new CtvError("engine.internal", `${type}: series memory stores are unavailable`);
  return store;
}

/** Keys of the frame that shows the tab's comic: the top frame when it has images, else the first frame that has. */
export function tabKeys(frames: readonly FrameHandle[]): PageKeys | null {
  const withImages = frames.filter((frame) => frame.images.size > 0);
  const frame =
    withImages.find((f) => f.info.frameId === 0) ??
    withImages[0] ??
    frames.find((f) => f.info.frameId === 0) ??
    frames[0];
  return frame === undefined ? null : pageKeysOf(frame.info.url, frame.info.page.title);
}

/**
 * Transcript of a tab: stored lines of the images its frames showed, in page order then reading order, with the
 * tab's series and chapter keys. A line whose translation misses the glossary rendering of a term in its original is
 * flagged "inconsistent".
 */
export async function buildTranscript(
  deps: Pick<UiHandlerDeps, "frames" | "stores">,
  tabId: number,
): Promise<Transcript> {
  const frames = deps.frames.byTab(tabId);
  const keys = tabKeys(frames);
  let glossary: GlossaryEntry[] = [];
  if (keys !== null && deps.stores.glossary !== undefined) {
    // The flags are a hint: a failed read only leaves them out.
    glossary = await deps.stores.glossary.forSeries(keys.seriesKey).catch(() => []);
  }
  const pages = new Map<string, { docOrder: number; yTop: number }>();
  for (const frame of frames) {
    for (const image of frame.images.values()) {
      if (image.contentKey === null) continue;
      const docOrder = image.pos?.docOrder ?? Number.MAX_SAFE_INTEGER;
      const yTop = image.pos?.yTop ?? 0;
      const known = pages.get(image.contentKey);
      if (known === undefined || docOrder < known.docOrder) pages.set(image.contentKey, { docOrder, yTop });
    }
  }
  const ordered = [...pages.entries()].sort(([, a], [, b]) => a.docOrder - b.docOrder || a.yTop - b.yTop);
  const items: TranscriptItem[] = [];
  for (const [pageOrder, [contentKey]] of ordered.entries()) {
    const [units, records] = await Promise.all([
      deps.stores.units.get(contentKey),
      deps.stores.translations.forImage(contentKey),
    ]);
    const unitOrder = new Map((units?.units ?? []).map((unit) => [unit.unitKey, unit.order]));
    const rank = (unitKey: string): number => unitOrder.get(unitKey) ?? Number.MAX_SAFE_INTEGER;
    records.sort((a, b) => rank(a.unitKey) - rank(b.unitKey) || a.unitKey.localeCompare(b.unitKey));
    for (const [index, record] of records.entries()) {
      const manual = record.manual === 1 && record.manualTranslation !== null;
      const translation = manual ? (record.manualTranslation ?? record.translation) : record.translation;
      items.push({
        contentKey,
        unitKey: record.unitKey,
        pageOrder,
        order: unitOrder.get(record.unitKey) ?? index,
        type: record.type,
        speaker: record.speaker,
        original: record.original,
        translation,
        status: manual ? "manual" : record.status,
        manual,
        flags: isInconsistent(glossary, record.original, translation) ? ["inconsistent"] : [],
      });
    }
  }
  return { tabId, seriesKey: keys?.seriesKey ?? null, chapterKey: keys?.chapterKey ?? null, items };
}

/** en:jump-to: asks the first connected frame of the tab that shows the image to scroll to the unit. */
export function jumpTo(frames: FrameRegistry, tabId: number, contentKey: string, unitKey: string): boolean {
  for (const frame of frames.byTab(tabId)) {
    if (!frame.connected) continue;
    for (const [imageKey, image] of frame.images) {
      if (image.contentKey === contentKey && frame.post({ type: "img:scroll-to", imageKey, unitKey })) {
        return true;
      }
    }
  }
  return false;
}

export function createUiHandlers(deps: UiHandlerDeps): Handlers<EngineApi> {
  const clock = deps.clock ?? systemClock;
  const changed = (): void => {
    deps.changed?.();
  };
  return {
    "en:settings": (payload) => {
      deps.settings.apply(payload.settings, payload.sites);
      changed();
      return {};
    },
    "en:prepare-close": () => ({ ok: deps.lifecycle.prepareClose() }),
    "en:ping": (payload) => ({
      probe: (payload as { probe?: Bytes } | null)?.probe ?? makeProbe(),
      phase: deps.lifecycle.phase(),
    }),
    "en:status": () => deps.status(),
    "en:transcript": (payload) => {
      if (!Number.isInteger(payload.tabId)) throw invalid("en:transcript");
      return buildTranscript(deps, payload.tabId);
    },
    "en:edit-unit": async (payload) => {
      const { contentKey, unitKey, translation } = payload;
      if (
        typeof contentKey !== "string" ||
        typeof unitKey !== "string" ||
        (translation !== null && typeof translation !== "string")
      ) {
        throw invalid("en:edit-unit");
      }
      await deps.pipeline.edit({ contentKey }, unitKey, translation);
      changed();
      return {};
    },
    "en:retranslate": (payload) => {
      if (!Number.isInteger(payload.tabId)) throw invalid("en:retranslate");
      const scope: { tabId: number; contentKey?: string; unitKey?: string } = { tabId: payload.tabId };
      if (typeof payload.contentKey === "string") scope.contentKey = payload.contentKey;
      if (typeof payload.unitKey === "string") scope.unitKey = payload.unitKey;
      const queued = deps.pipeline.retranslate(scope);
      changed();
      return { queued };
    },
    "en:glossary-list": async (payload) => {
      const seriesKey = seriesKeyFrom("en:glossary-list", payload.seriesKey);
      const { series, glossary } = deps.stores;
      if (series === undefined || glossary === undefined) return { series: null, entries: [] };
      const [profile, entries] = await Promise.all([series.get(seriesKey), glossary.forSeries(seriesKey)]);
      return { series: profile ?? null, entries: rankEntries(entries) };
    },
    "en:glossary-upsert": async (payload) => {
      const type = "en:glossary-upsert";
      const seriesKey = seriesKeyFrom(type, payload.seriesKey);
      const edits = editsFrom(type, payload.entries);
      const now = clock.now();
      await required(deps.stores.glossary, type).update(seriesKey, [...edits.keys()], (orig, existing) => {
        const edit = edits.get(orig);
        return edit === undefined ? undefined : (manualEntry(seriesKey, existing, edit, now) ?? undefined);
      });
      return {};
    },
    "en:glossary-delete": async (payload) => {
      const type = "en:glossary-delete";
      const seriesKey = seriesKeyFrom(type, payload.seriesKey);
      const origs = origsFrom(type, payload.origs);
      await required(deps.stores.glossary, type).update(seriesKey, origs, () => null);
      return {};
    },
    "en:glossary-confirm": async (payload) => {
      const type = "en:glossary-confirm";
      const seriesKey = seriesKeyFrom(type, payload.seriesKey);
      const origs = origsFrom(type, payload.origs);
      await required(deps.stores.glossary, type).update(
        seriesKey,
        origs,
        (_orig, existing) => confirmEntry(existing) ?? undefined,
      );
      return {};
    },
    "en:series-update": async (payload) => {
      const type = "en:series-update";
      const seriesKey = seriesKeyFrom(type, payload.seriesKey);
      const patch = sanitizeSeriesPatch(payload.patch);
      if (patch === null) throw invalid(type);
      const now = clock.now();
      const siteKey = siteOfSeries(seriesKey) ?? "";
      await required(deps.stores.series, type).update(seriesKey, (existing) =>
        applySeriesPatch(
          existing ?? newSeriesProfile(seriesKey, siteKey, patch.title ?? "", now),
          patch,
          now,
        ),
      );
      return {};
    },
    "en:jump-to": (payload) => {
      const { tabId, contentKey, unitKey } = payload;
      if (!Number.isInteger(tabId) || typeof contentKey !== "string" || typeof unitKey !== "string") {
        throw invalid("en:jump-to");
      }
      return { found: jumpTo(deps.frames, tabId, contentKey, unitKey) };
    },
    "en:cache-clear": async (payload) => {
      const scope = SCOPES.find((candidate) => candidate === payload.scope);
      if (scope === undefined) throw invalid("en:cache-clear");
      const deletedRecords = await clearCache(
        deps.stores,
        scope,
        typeof payload.key === "string" ? payload.key : undefined,
      );
      deps.pipeline.cacheCleared();
      deps.log.info("cache cleared", { scope, deletedRecords });
      changed();
      return { deletedRecords };
    },
  };
}

/* ------------------------------------------------------------------ Port "ui" */

export interface UiPortDeps {
  ui: UiRegistry;
  status: () => EngineStatus;
  log: Logger;
}

export function handleUiMessage(client: UiClient, message: UiToEngine, deps: UiPortDeps): void {
  switch (message.type) {
    case "ui:hello": {
      const codec = deps.ui.hello(client, message);
      if (message.v !== PROTOCOL_VERSION) deps.log.warn("ui protocol mismatch", { v: message.v });
      client.port.post({ type: "en:hello", v: PROTOCOL_VERSION, probe: makeProbe(), codec });
      return;
    }
    case "ui:watch": {
      const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
      deps.ui.watch(client, tabId);
      client.port.post({ type: "en:status", status: deps.status() });
      return;
    }
  }
}
