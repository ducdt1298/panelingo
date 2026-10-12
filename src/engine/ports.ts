// Port registries.
// FrameRegistry: one frame per frameKey (tab:frame:document) with its FrameInfo and current port. A frame outlives
// its port for a 60 s grace period (BFCache, reconnect backoff): a new port with the same frameKey replaces the old one
// (pipeline.frameReplaced) and only a grace that runs out calls pipeline.frameGone. The FrameSink handed to the
// pipeline is the frame itself, so posts always reach the current port.
// UiRegistry: extension pages on Port "ui"; implements UiBroadcast for ui:watch subscribers.

import type { Logger } from "../platform/log.ts";
import type { EngineToCs, EngineToUi, PageHints } from "../shared/protocol.ts";
import type { Codec, PagePos } from "../shared/types.ts";
import { codecFromProbe } from "../shared/wire.ts";
import type { Clock, FrameInfo, FrameSink, UiBroadcast } from "./contracts.ts";
import type { CsHello, EnginePort, EnginePortEntry, UiHello, UiPort, UiPortEntry } from "./ready-gate.ts";

export const FRAME_GRACE_MS = 60_000;
/** Images remembered per frame for en:transcript / en:jump-to (oldest forgotten first). */
const MAX_FRAME_IMAGES = 4_000;
const MAX_TITLE = 500;

export interface FrameImage {
  pos: PagePos | null;
  contentKey: string | null;
}

export interface FrameHandle extends FrameSink {
  readonly frameKey: string;
  /** The current port, or null during the reconnect grace. */
  readonly port: EnginePort | null;
  /** Epoch ms when the port went away (grace running), else null. */
  readonly disconnectedAt: number | null;
  /** imageKey → page position and contentKey, learnt from img:submit and the engine's own img:* posts. */
  readonly images: ReadonlyMap<string, FrameImage>;
  readonly noteSubmit: (imageKey: string, pos: PagePos) => void;
  readonly forgetImages: (imageKeys: readonly string[]) => void;
}

export interface FrameEvents {
  readonly frameGone: (frameKey: string) => void;
  readonly frameReplaced: (frame: FrameSink) => void;
}

export interface FrameRegistryOptions {
  clock: Clock;
  log: Logger;
  events: FrameEvents;
  graceMs?: number;
  /** Mode of a frame until its cs:hello says otherwise (the site's setting). */
  defaultMode?: (siteKey: string) => "auto" | "manual";
  /** Every message the pipeline (or anyone) delivered to a frame. */
  onPost?: (frame: FrameHandle, message: EngineToCs) => void;
  /** Connected port count changed (idle detection, status). */
  onPortsChanged?: () => void;
}

export interface FrameRegistry {
  /** A new "engine" port: registers its frame, or re-attaches a frame still in its grace period. */
  readonly open: (entry: EnginePortEntry) => FrameHandle;
  /** Applies cs:hello (mode, page hints, codec from the probe); returns the negotiated codec. */
  readonly hello: (frame: FrameHandle, hello: CsHello) => Codec;
  /** The port of `entry` closed; ignored when the frame has moved on to a newer port. */
  readonly closed: (entry: EnginePortEntry) => void;
  /** The frame whose CURRENT port is entry.port. */
  readonly forEntry: (entry: EnginePortEntry) => FrameHandle | undefined;
  readonly get: (frameKey: string) => FrameHandle | undefined;
  readonly list: () => FrameHandle[];
  readonly byTab: (tabId: number) => FrameHandle[];
  readonly connectedCount: () => number;
  /** Posts to every connected frame; returns how many accepted it. */
  readonly broadcast: (message: EngineToCs) => number;
  readonly setCodec: (frame: FrameHandle, codec: Codec) => void;
  readonly setVisible: (frame: FrameHandle, visible: boolean) => void;
  /** Stops grace timers and closes every port (engine shutdown, tests). */
  readonly closeAll: () => void;
}

interface FrameState {
  readonly handle: FrameHandle;
  readonly info: FrameInfo;
  entry: EnginePortEntry | null;
  disconnectedAt: number | null;
  cancelGrace: (() => void) | null;
  readonly images: Map<string, FrameImage>;
}

export function sanitizePage(raw: unknown, fallback: PageHints): PageHints {
  if (typeof raw !== "object" || raw === null) return { ...fallback };
  const page = raw as Partial<Record<keyof PageHints, unknown>>;
  const layouts: ReadonlyArray<PageHints["layout"]> = ["auto", "webtoon", "paged-rtl", "paged-ltr"];
  return {
    title: typeof page.title === "string" ? page.title.slice(0, MAX_TITLE) : fallback.title,
    layout: layouts.includes(page.layout as PageHints["layout"])
      ? (page.layout as PageHints["layout"])
      : fallback.layout,
    visible: typeof page.visible === "boolean" ? page.visible : fallback.visible,
    dpr:
      typeof page.dpr === "number" && Number.isFinite(page.dpr) && page.dpr > 0 && page.dpr <= 16
        ? page.dpr
        : fallback.dpr,
  };
}

const DEFAULT_PAGE: PageHints = { title: "", layout: "auto", visible: true, dpr: 1 };

export function createFrameRegistry(options: FrameRegistryOptions): FrameRegistry {
  const { clock, log } = options;
  const graceMs = options.graceMs ?? FRAME_GRACE_MS;
  const frames = new Map<string, FrameState>();
  let focusSeq = 0;

  const portsChanged = (): void => {
    try {
      options.onPortsChanged?.();
    } catch (error) {
      log.warn("onPortsChanged threw", { error: String(error) });
    }
  };

  const remember = (state: FrameState, imageKey: string, update: Partial<FrameImage>): void => {
    const known = state.images.get(imageKey) ?? { pos: null, contentKey: null };
    state.images.delete(imageKey);
    state.images.set(imageKey, { ...known, ...update });
    if (state.images.size > MAX_FRAME_IMAGES) {
      const oldest = state.images.keys().next();
      if (oldest.done !== true) state.images.delete(oldest.value);
    }
  };

  /** The engine's own img:* posts tell which contentKey an imageKey resolved to. */
  const learn = (state: FrameState, message: EngineToCs): void => {
    if (message.type === "img:units" || message.type === "img:bulk" || message.type === "img:done") {
      remember(state, message.imageKey, { contentKey: message.contentKey });
    }
  };

  const create = (entry: EnginePortEntry): FrameState => {
    const info: FrameInfo = {
      frameKey: entry.frameKey,
      tabId: entry.tabId,
      frameId: entry.frameId,
      documentId: entry.documentId,
      url: entry.url,
      origin: entry.origin,
      siteKey: entry.origin,
      mode: options.defaultMode?.(entry.origin) ?? "auto",
      codec: "sc",
      page: { ...DEFAULT_PAGE },
      viewport: null,
      focusSeq: 0,
    };
    const images = new Map<string, FrameImage>();
    const state: FrameState = {
      info,
      entry,
      disconnectedAt: null,
      cancelGrace: null,
      images,
      handle: {
        frameKey: entry.frameKey,
        info,
        get connected() {
          return state.entry !== null && !state.entry.port.closed;
        },
        get port() {
          return state.entry?.port ?? null;
        },
        get disconnectedAt() {
          return state.disconnectedAt;
        },
        images,
        post: (message) => {
          const port = state.entry?.port;
          if (port === undefined || port.closed) return false;
          let sent = false;
          try {
            sent = port.post(message);
          } catch (error) {
            log.warn("frame post threw", { frameKey: info.frameKey, error: String(error) });
          }
          if (sent) {
            learn(state, message);
            try {
              options.onPost?.(state.handle, message);
            } catch (error) {
              log.warn("onPost threw", { error: String(error) });
            }
          }
          return sent;
        },
        noteSubmit: (imageKey, pos) => remember(state, imageKey, { pos }),
        forgetImages: (imageKeys) => {
          for (const imageKey of imageKeys) state.images.delete(imageKey);
        },
      },
    };
    return state;
  };

  const bumpFocus = (info: FrameInfo): void => {
    focusSeq += 1;
    info.focusSeq = focusSeq;
  };

  return {
    open: (entry) => {
      const existing = frames.get(entry.frameKey);
      if (existing !== undefined) {
        existing.cancelGrace?.();
        existing.cancelGrace = null;
        const previous = existing.entry;
        existing.entry = entry;
        existing.disconnectedAt = null;
        entry.port.codec = existing.info.codec;
        // Two live ports for one document: the newest wins.
        if (previous !== null && previous !== entry && !previous.port.closed) previous.port.close();
        log.debug("frame reconnected", { frameKey: entry.frameKey });
        try {
          options.events.frameReplaced(existing.handle);
        } catch (error) {
          log.warn("frameReplaced threw", { error: String(error) });
        }
        portsChanged();
        return existing.handle;
      }
      const state = create(entry);
      frames.set(entry.frameKey, state);
      portsChanged();
      return state.handle;
    },
    hello: (frame, hello) => {
      const state = frames.get(frame.frameKey);
      const codec = codecFromProbe(hello.probe);
      if (state === undefined) return codec;
      state.info.codec = codec;
      if (state.entry !== null) state.entry.port.codec = codec;
      if (hello.mode === "auto" || hello.mode === "manual") state.info.mode = hello.mode;
      state.info.page = sanitizePage(hello.page, state.info.page);
      if (state.info.page.visible) bumpFocus(state.info);
      return codec;
    },
    closed: (entry) => {
      const state = frames.get(entry.frameKey);
      if (state === undefined || state.entry !== entry) return;
      state.entry = null;
      state.disconnectedAt = clock.now();
      state.cancelGrace = clock.setTimer(() => {
        state.cancelGrace = null;
        if (state.entry !== null || frames.get(entry.frameKey) !== state) return;
        frames.delete(entry.frameKey);
        log.debug("frame gone", { frameKey: entry.frameKey });
        try {
          options.events.frameGone(entry.frameKey);
        } catch (error) {
          log.warn("frameGone threw", { error: String(error) });
        }
      }, graceMs);
      portsChanged();
    },
    forEntry: (entry) => {
      const state = frames.get(entry.frameKey);
      return state !== undefined && state.entry === entry ? state.handle : undefined;
    },
    get: (frameKey) => frames.get(frameKey)?.handle,
    list: () => [...frames.values()].map((state) => state.handle),
    byTab: (tabId) =>
      [...frames.values()].filter((state) => state.info.tabId === tabId).map((state) => state.handle),
    connectedCount: () => [...frames.values()].filter((state) => state.handle.connected).length,
    broadcast: (message) => {
      let sent = 0;
      for (const state of frames.values())
        if (state.handle.connected && state.handle.post(message)) sent += 1;
      return sent;
    },
    setCodec: (frame, codec) => {
      frame.info.codec = codec;
      if (frame.port !== null) frame.port.codec = codec;
    },
    setVisible: (frame, visible) => {
      frame.info.page = { ...frame.info.page, visible };
      if (visible) bumpFocus(frame.info);
    },
    closeAll: () => {
      const states = [...frames.values()];
      frames.clear(); // first, so the close events of these ports start no grace timer
      for (const state of states) {
        state.cancelGrace?.();
        state.cancelGrace = null;
        const entry = state.entry;
        state.entry = null;
        entry?.port.close();
      }
    },
  };
}

/* ------------------------------------------------------------------ UI ports */

export interface UiClient {
  readonly entry: UiPortEntry;
  readonly port: UiPort;
  /** undefined = not watching; null = global status only; a tab id = that tab as well. */
  watch: number | null | undefined;
}

export interface UiRegistry extends UiBroadcast {
  readonly open: (entry: UiPortEntry) => UiClient;
  readonly closed: (entry: UiPortEntry) => void;
  readonly get: (entry: UiPortEntry) => UiClient | undefined;
  /** Applies ui:hello (codec from the probe). */
  readonly hello: (client: UiClient, hello: UiHello) => Codec;
  readonly watch: (client: UiClient, tabId: number | null) => void;
  readonly count: () => number;
  readonly watchers: () => UiClient[];
  readonly closeAll: () => void;
}

export interface UiRegistryOptions {
  log: Logger;
  onPortsChanged?: () => void;
}

export function createUiRegistry(options: UiRegistryOptions): UiRegistry {
  const clients = new Map<UiPortEntry, UiClient>();

  const portsChanged = (): void => {
    try {
      options.onPortsChanged?.();
    } catch (error) {
      options.log.warn("onPortsChanged threw", { error: String(error) });
    }
  };

  return {
    open: (entry) => {
      const client: UiClient = { entry, port: entry.port, watch: undefined };
      clients.set(entry, client);
      portsChanged();
      return client;
    },
    closed: (entry) => {
      if (clients.delete(entry)) portsChanged();
    },
    get: (entry) => clients.get(entry),
    hello: (client, hello) => {
      const codec = codecFromProbe(hello.probe);
      client.port.codec = codec;
      return codec;
    },
    watch: (client, tabId) => {
      client.watch = tabId;
    },
    count: () => clients.size,
    watchers: () => [...clients.values()].filter((client) => client.watch !== undefined),
    post: (message: EngineToUi, tabId?: number | null) => {
      for (const client of clients.values()) {
        if (client.watch === undefined || client.port.closed) continue;
        // Tab-scoped messages go to that tab's watchers only; global ones to every watcher.
        if (typeof tabId === "number" && client.watch !== tabId) continue;
        client.port.post(message);
      }
    },
    closeAll: () => {
      const list = [...clients.values()];
      clients.clear();
      for (const client of list) client.port.close();
    },
  };
}
