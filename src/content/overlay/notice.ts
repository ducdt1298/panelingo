// Privacy notice in the overlay, for uploads made before the one-time upload notice was confirmed (typically the
// first manual-mode upload): a small card next to the image whose upload is paused for privacy.consent. Accepting is
// the user's consent (the controller sends sw:ack-privacy); the texts come from src/shared/i18n.

import { msg } from "../../shared/i18n/index.ts";
import { element, isolate } from "./dom.ts";

export interface NoticeHandlers {
  onAccept(): void;
  onDecline(): void;
}

export function createPrivacyNotice(doc: Document, handlers: NoticeHandlers): HTMLDivElement {
  const card = element(doc, "div", "notice");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", msg().ui.privacyTitle);
  const title = element(doc, "div", "title");
  title.textContent = msg().ui.privacyTitle;
  const body = element(doc, "div", "body");
  body.textContent = msg().ui.privacyBody;
  const actions = element(doc, "div", "actions");
  const decline = element(doc, "button", "decline");
  decline.type = "button";
  decline.textContent = msg().ui.privacyDecline;
  isolate(decline, () => handlers.onDecline());
  const accept = element(doc, "button", "accept");
  accept.type = "button";
  accept.textContent = msg().ui.privacyAccept;
  isolate(accept, () => handlers.onAccept());
  actions.append(decline, accept);
  card.append(title, body, actions);
  // Clicks on the card's text must not reach a click-to-next link or handler around the image either.
  isolate(card);
  return card;
}
