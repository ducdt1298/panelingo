// The upload notice shown before a site is enabled for the first time (privacy.ackUploadNoticeAt): the AI provider
// may keep what it receives, so nothing is sent before the user confirms it once.

import { callSw } from "../../platform/messaging.ts";
import { msg } from "../../shared/i18n/index.ts";
import type { Settings } from "../../shared/settings.ts";
import { h } from "./dom.ts";

export function needsPrivacyAck(settings: Settings): boolean {
  return settings.privacy.ackUploadNoticeAt === null;
}

/** Records the confirmation (settings.privacy.ackUploadNoticeAt) through the service worker; returns its time. */
export async function acknowledgePrivacy(): Promise<number> {
  return (await callSw("sw:ack-privacy", {})).at;
}

export interface NoticeHandlers {
  onAccept(): void;
  onDecline(): void;
  /** Opens the full explanation (options → privacy). */
  onDetails?: () => void;
}

export function privacyNotice(handlers: NoticeHandlers): HTMLElement {
  const details = handlers.onDetails;
  return h(
    "div",
    { class: "notice", role: "dialog", "aria-label": msg().ui.privacyTitle },
    h("h3", null, msg().ui.privacyTitle),
    h("p", null, msg().ui.privacyBody),
    details === undefined
      ? null
      : h(
          "p",
          null,
          h(
            "a",
            {
              href: "#",
              onclick: (event) => {
                event.preventDefault();
                details();
              },
            },
            msg().popup.privacyDetails,
          ),
        ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { class: "primary", type: "button", onclick: () => handlers.onAccept() },
        msg().ui.privacyAccept,
      ),
      h("button", { type: "button", onclick: () => handlers.onDecline() }, msg().ui.privacyDecline),
    ),
  );
}
