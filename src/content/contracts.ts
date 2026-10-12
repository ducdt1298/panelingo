// Content-script internal boundaries.
// TYPES ONLY. controller.ts wires discovery, engine-client, acquire-local and the overlay through these types.
// Implementations: overlay/index.ts exports `createOverlay: CreateOverlay`; acquire-local.ts exports
// `readLocalBytes: ReadLocalBytes`; main.ts passes both to the controller.

import type { ErrorInfo } from "../shared/errors.ts";
import type { CsToEngine, EngineToCsMap, ImageSubmit } from "../shared/protocol.ts";
import type { Codec, ImageState, Size, UnitGeometry, UnitRender } from "../shared/types.ts";

/* ------------------------------------------------------------------ images on the page (discovery.ts) */

export type ImageElement = HTMLImageElement | HTMLCanvasElement;

/** One image the content script tracks; discovery owns the element ↔ imageKey mapping (`${elementSeq}.${srcGen}`). */
export interface TrackedImage {
  imageKey: string;
  element: ImageElement;
}

/* ------------------------------------------------------------------ ladder step 1 (acquire-local.ts) */

export interface LocalBytes {
  bytes: ArrayBuffer;
  mime: string;
  source: "cs-fetch" | "cs-canvas";
}

export interface ReadLocalOptions {
  /** Never read more than this (settings.privacy.maxImageBytes, and the codec's hard limit). */
  maxBytes: number;
  /** Allow the one-per-host-per-page CORS probe (opted-in sites only). */
  corsProbe: boolean;
}

/**
 * Reads bytes the content script can legally read: data:, blob:, same-origin, images with a crossorigin attribute
 * and untainted canvases. null means "let the engine fetch it" (ladder step 2). Never throws.
 */
export type ReadLocalBytes = (
  element: ImageElement,
  src: string,
  options: ReadLocalOptions,
) => Promise<LocalBytes | null>;

/* ------------------------------------------------------------------ engine connection (engine-client.ts) */

export type EngineClientState = "idle" | "connecting" | "open" | "backoff" | "suspended" | "dead";

export interface EngineClient {
  readonly state: EngineClientState;
  readonly codec: Codec;
  /** Queued until the port is open; every pending submit is re-sent after a reconnect. */
  submit(submit: ImageSubmit): void;
  /** Any other message; false when not connected (not queued). */
  post(message: CsToEngine): boolean;
  on<K extends keyof EngineToCsMap>(
    type: K,
    handler: (message: { readonly type: K } & EngineToCsMap[K]) => void,
  ): () => void;
  /** Stop tracking (and resubmitting) these images. */
  forget(imageKeys: readonly string[]): void;
  onState(listener: (state: EngineClientState) => void): () => void;
  /** Permanent shutdown (teardown, context invalidated). */
  close(): void;
}

/* ------------------------------------------------------------------ overlay (overlay/*.ts, fonts.ts, measure.ts) */

export interface OverlayOptions {
  /** "closed" in prod so the page cannot reach into the overlay; "open" in __TEST__ builds for Puppeteer. */
  shadowMode: "open" | "closed";
  mode: "auto" | "manual";
  minFontPx: number;
  maxFontPx: number;
  showDoneBadge: boolean;
  /** settings.render.font: the dialogue font (content/lettering.ts). */
  font: "patrick-hand" | "mali";
  /** settings.render.eraseSfx: SFX with a clean erase patch are erased and lettered in place. */
  eraseSfx: boolean;
  /** settings.render.sfxLabels: other SFX get a label pill; off leaves them untouched. */
  sfxLabels: boolean;
  /** settings.render.popupWithAltClick: Alt+click on a painted unit opens its popup (a long press always does). */
  popupWithAltClick: boolean;
  /**
   * The language translations are written in (a TARGET_LANGUAGES code, resolved like the engine does): CJK targets
   * are lettered with the system's CJK fonts, Japanese and Traditional Chinese vertically in vertical balloons.
   */
  target: string;
  /** settings.render.verticalText. */
  verticalText: "auto" | "never";
}

export interface OverlayEvents {
  /** Manual mode: the hover button or the badge's retry was clicked. */
  onTranslateRequest(imageKey: string): void;
  /** fitText had to cut the text with "…" (or fits again): sent to the engine as unit:overflow. */
  onOverflow(imageKey: string, unitKey: string, overflow: boolean): void;
  /** The privacy notice shown in the overlay was accepted (controller sends sw:ack-privacy). */
  onPrivacyAccepted(): void;
  /**
   * Bubble popup: the user edited a unit (null = revert to the AI text) → unit:edit. False when it could not be sent
   * (no engine connection).
   */
  onEditUnit?(imageKey: string, unitKey: string, translation: string | null): boolean;
  /** Bubble popup: translate one painted unit again, bypassing the cache → unit:retranslate. False when not sent. */
  onRetranslateUnit?(imageKey: string, unitKey: string): boolean;
}

export interface ImageStateInfo {
  progress?: { done: number; total: number };
  etaSec?: number;
  error?: ErrorInfo;
}

export interface Overlay {
  /** Creates or re-attaches the shadow host of an image; idempotent. */
  attach(image: TrackedImage): void;
  /** img:units: geometry only; nothing is painted for a unit until it has a valid translation. */
  setUnits(imageKey: string, natural: Size, units: readonly UnitGeometry[]): void;
  /** img:unit, or each item of img:bulk. Paints plate + fitted text only for status ok / manual. */
  setUnit(imageKey: string, natural: Size, unit: UnitRender): void;
  setState(imageKey: string, state: ImageState, info?: ImageStateInfo): void;
  /** Shows the privacy notice next to this image (state paused with error privacy.consent). */
  showPrivacyNotice(imageKey: string): void;
  /**
   * The user asked to translate this image outside the overlay (context menu, keyboard command, popup): like the
   * overlay's own hover button or retry, this re-arms a declined privacy notice so it may be shown again.
   */
  noteUserRequest(imageKey: string): void;
  detach(imageKey: string): void;
  /**
   * img:scroll-to (the side panel's "Show"): scrolls the unit's balloon to the middle of its scrolling box and flashes
   * it. False when the image or the unit is unknown.
   */
  scrollToUnit(imageKey: string, unitKey: string): boolean;
  /**
   * Toggle (Alt+Shift+Y) and peek; pointer-events are always none on painted units (the bubble popup opens through
   * window-level hit-testing of Alt+click and long-press, overlay/gestures.ts).
   */
  setVisible(visible: boolean): void;
  readonly visible: boolean;
  /** Re-position every host (resize/zoom); per-image changes come from a ResizeObserver. */
  relayout(): void;
  /** Removes every host, observer and listener (teardown, extension context invalidated). */
  destroy(): void;
}

export type CreateOverlay = (doc: Document, options: OverlayOptions, events: OverlayEvents) => Overlay;
