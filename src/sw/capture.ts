// sw:capture (ladder step 3): one chrome.tabs.captureVisibleTab of the engine's frame tab.
//
// captureVisibleTab takes a window, not a tab, so the requested tab must be the active tab of the last focused,
// non-minimized window, before and after the capture: anything else would capture another page. Captures are queued
// per window and started at least CAPTURE.minGapMs apart (Chrome allows about two per second); a capture refused by
// that quota waits and runs once more. The PNG of the viewport goes to the engine, which crops it to the image at
// once and keeps nothing else; the service worker keeps no copy.

import { readImageSize } from "../shared/core/image-header.ts";
import { CAPTURE, createCaptureThrottle, visiblePart } from "../shared/core/capture.ts";
import { systemClock, type Clock } from "../shared/clock.ts";
import { CtvError, errorMessage } from "../shared/errors.ts";
import type { ReqOf, ResOf, SwApi } from "../shared/protocol.ts";
import type { RectCss, Size } from "../shared/types.ts";
import { encodeBytes } from "../shared/wire.ts";

type CaptureRequest = ReqOf<SwApi, "sw:capture">;
type CaptureResult = ResOf<SwApi, "sw:capture">;

const QUOTA_MESSAGE = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validRect(rect: RectCss | undefined): rect is RectCss {
  return (
    rect !== undefined &&
    finite(rect.left) &&
    finite(rect.top) &&
    finite(rect.width) &&
    finite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

function validViewport(viewport: Size | undefined): viewport is Size {
  return (
    viewport !== undefined && finite(viewport.w) && finite(viewport.h) && viewport.w > 0 && viewport.h > 0
  );
}

function blocked(detail: string, message: string): CtvError {
  return new CtvError("image.capture_blocked", message, { detail });
}

/** Bytes of a data:...;base64 URL (captureVisibleTab's answer). */
export function dataUrlToBytes(url: string): Uint8Array<ArrayBuffer> {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0 || !url.slice(0, comma).endsWith(";base64")) {
    throw new CtvError("image.capture_unavailable", "the capture is not a base64 data URL", {
      detail: "format",
    });
  }
  // atob is native and fast; a 4K screenshot is several MB of base64.
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface CaptureEnv {
  clock?: Clock;
}

export interface TabCapturer {
  capture(request: CaptureRequest): Promise<CaptureResult>;
}

export function createTabCapturer(env: CaptureEnv = {}): TabCapturer {
  const throttle = createCaptureThrottle(env.clock ?? systemClock, CAPTURE.minGapMs);

  /** The tab must be what captureVisibleTab of its window shows, and the user must be looking at that window. */
  async function checkCapturable(tabId: number): Promise<chrome.tabs.Tab> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw blocked("tab", `tab ${tabId} is gone: ${errorMessage(error)}`);
    }
    if (!tab.active) throw blocked("hidden", "the tab is not the active tab of its window");
    let focused: chrome.windows.Window;
    let own: chrome.windows.Window;
    try {
      [focused, own] = await Promise.all([chrome.windows.getLastFocused(), chrome.windows.get(tab.windowId)]);
    } catch (error) {
      throw blocked("window", `window lookup failed: ${errorMessage(error)}`);
    }
    if (focused.id !== tab.windowId) throw blocked("unfocused", "the tab's window is not the focused window");
    if (own.state === "minimized") throw blocked("hidden", "the tab's window is minimized");
    return tab;
  }

  async function shoot(tabId: number, windowId: number): Promise<Uint8Array<ArrayBuffer>> {
    await checkCapturable(tabId);
    let url: string;
    try {
      url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (error) {
      const message = errorMessage(error);
      if (QUOTA_MESSAGE.test(message)) {
        throw new CtvError("image.capture_unavailable", message, { detail: "quota", retryable: true });
      }
      throw blocked("denied", `captureVisibleTab failed: ${message}`);
    }
    // The user may have switched tabs while Chrome was capturing: then the picture is of another page.
    const tab = await checkCapturable(tabId);
    if (tab.windowId !== windowId) throw blocked("hidden", "the tab moved to another window");
    return dataUrlToBytes(url);
  }

  return {
    async capture(request) {
      if (!Number.isInteger(request.tabId) || request.tabId < 0) {
        throw blocked("tab", "sw:capture needs the tab of a page");
      }
      if (!validRect(request.rect) || !validViewport(request.viewport)) {
        throw new CtvError("engine.protocol", "sw:capture: invalid rect or viewport");
      }
      const tab = await checkCapturable(request.tabId);
      const windowId = tab.windowId;
      const once = (): Promise<Uint8Array<ArrayBuffer>> =>
        throttle.run(windowId, () => shoot(request.tabId, windowId));
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await once();
      } catch (error) {
        if (!(error instanceof CtvError) || error.detail !== "quota") throw error;
        bytes = await once();
      }
      const size = readImageSize(bytes);
      if (size === null || size.w <= 0 || size.h <= 0) {
        throw new CtvError("image.capture_unavailable", "the capture is not a readable PNG", {
          detail: "format",
        });
      }
      const visible = visiblePart(request.rect, request.viewport) ?? {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      };
      return {
        png: encodeBytes(bytes.buffer, request.codec),
        scale: size.w / request.viewport.w,
        visible,
      };
    },
  };
}

let shared: TabCapturer | null = null;

/** The service worker's capturer (one throttle per worker lifetime). */
export function captureTab(request: CaptureRequest): Promise<CaptureResult> {
  shared ??= createTabCapturer();
  return shared.capture(request);
}
