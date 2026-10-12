// cs:* one-shot commands (CsApi) sent by the service worker with tabs.sendMessage: toggle the overlay, translate the
// images on screen, translate one image (context menu) and teardown. Installed through onMessageFor: replies are
// Reply<T> and errors travel as ErrorInfo.

import { onMessageFor } from "../platform/messaging.ts";
import type { CsApi } from "../shared/protocol.ts";

/** Why a content script stops: an SW command, an orphaned context, or a frame whose site is not enabled. */
export type TeardownReason = CsApi["cs:teardown"][0]["reason"] | "ctx.invalidated" | "not-enabled";

export interface CommandTarget {
  /** Returns the new visibility. */
  toggleOverlay(): boolean | Promise<boolean>;
  /** Requests every on-screen candidate that is not translated or in progress; returns how many. */
  translateVisible(): number | Promise<number>;
  /** False when no <img> of this frame matches srcUrl (currentSrc, src or a srcset candidate). */
  translateImage(srcUrl: string, force: boolean): boolean | Promise<boolean>;
  teardown(reason: TeardownReason): void;
}

function fromOwnExtension(sender: chrome.runtime.MessageSender): boolean {
  try {
    return sender.id !== undefined && sender.id === chrome.runtime.id;
  } catch {
    return false;
  }
}

/** Installs the cs handlers; returns the function that removes them. */
export function listenForCommands(target: CommandTarget): () => void {
  return onMessageFor(
    "cs",
    {
      "cs:toggle-overlay": async () => ({ visible: await target.toggleOverlay() }),
      "cs:translate-visible": async () => ({ submitted: await target.translateVisible() }),
      "cs:translate-image": async (payload) => ({
        found: await target.translateImage(payload.srcUrl, payload.force),
      }),
      "cs:teardown": (payload) => {
        target.teardown(payload.reason);
        return {};
      },
    },
    { allow: (_type, sender) => fromOwnExtension(sender) },
  );
}
