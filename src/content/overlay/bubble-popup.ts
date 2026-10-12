// Per-balloon popup: what a painted unit says in full. It shows the original text, the whole translation (the
// lettering may have been shortened with "…"), the line type and speaker, and offers Copy, Edit (an inline textarea;
// Save sends the edit to the engine, which pushes the unit back), Translate again and Close. It is a non-modal
// role="dialog" card in its own shadow host on documentElement, fixed next to the balloon inside the viewport, so a
// reader's clipping or stacking never hides it; Tab stays inside it, Escape and a press outside close it
// (gestures.ts). Texts come from src/shared/i18n.

import { msg } from "../../shared/i18n/index.ts";
import type { LineType, RectCss, Size, UnitStatus } from "../../shared/types.ts";
import { element, isolate, px, setImportant } from "./dom.ts";
import { ROOT_Z_INDEX } from "./styles.ts";

export const POPUP_TAG = "ctv-popup";
/** Space between the balloon and the card, and the card's minimum distance to the viewport edges (CSS px). */
export const POPUP_GAP = 8;
export const POPUP_MARGIN = 8;
export const POPUP_WIDTH = 320;

export interface PopupView {
  original: string;
  /** The whole translation (or the user's edit). */
  translation: string;
  type: LineType;
  speaker: string;
  status: UnitStatus;
  /** The lettering was cut with "…" to fit (fitText step 4). */
  shortened: boolean;
}

export interface PopupActions {
  /** Save an edit (null = back to the AI translation); false when it could not be sent. */
  onSave(translation: string | null): boolean;
  /** Translate this unit again; false when it could not be sent. */
  onRetranslate(): boolean;
  /** The popup closed (any reason). */
  onClose(): void;
}

/* ------------------------------------------------------------------ pure helpers */

export type PopupSide = "right" | "left" | "below" | "above";

/**
 * Where the card (size `card`) goes next to the balloon (`anchor`, viewport px): to its right, else its left, else
 * below, else above; when none fits, the side with the most room. Always clamped inside the viewport with `margin`.
 */
export function placePopup(
  anchor: RectCss,
  card: Size,
  viewport: Size,
  gap = POPUP_GAP,
  margin = POPUP_MARGIN,
): { left: number; top: number; side: PopupSide } {
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  const room: Record<PopupSide, number> = {
    right: viewport.w - margin - (right + gap) - card.w,
    left: anchor.left - gap - margin - card.w,
    below: viewport.h - margin - (bottom + gap) - card.h,
    above: anchor.top - gap - margin - card.h,
  };
  const order: PopupSide[] = ["right", "left", "below", "above"];
  const side = order.find((s) => room[s] >= 0) ?? order.reduce((a, b) => (room[b] > room[a] ? b : a));
  let left: number;
  let top: number;
  if (side === "right" || side === "left") {
    left = side === "right" ? right + gap : anchor.left - gap - card.w;
    top = anchor.top;
  } else {
    left = anchor.left + anchor.width / 2 - card.w / 2;
    top = side === "below" ? bottom + gap : anchor.top - gap - card.h;
  }
  const clamp = (v: number, size: number, extent: number): number =>
    Math.max(margin, Math.min(v, extent - margin - size));
  return { left: clamp(left, card.w, viewport.w), top: clamp(top, card.h, viewport.h), side };
}

/** "Dialogue · Minho": the line type, then the speaker when the model named one. */
export function popupTitle(type: LineType, speaker: string): string {
  const label = msg().sidepanel.types[type];
  const who = speaker.trim();
  return who === "" ? label : `${label} · ${who}`;
}

/** The status line for a unit that is not (or no longer) painted: Waiting, Translating, Error, … */
export function statusLine(status: UnitStatus): string {
  return status === "ok" || status === "manual" ? "" : msg().unitStatus[status];
}

/** Writes text to the clipboard: the async API, else a selected textarea and execCommand (http pages). */
export async function copyText(doc: Document, root: Node, text: string): Promise<boolean> {
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // No permission or no focus: fall back below.
    }
  }
  const area = doc.createElement("textarea");
  area.value = text;
  setImportant(area, [
    ["position", "fixed"],
    ["left", "-9999px"],
    ["top", "0"],
    ["opacity", "0"],
  ]);
  root.appendChild(area);
  try {
    area.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/* ------------------------------------------------------------------ DOM */

export interface BubblePopup {
  /** The shadow host (gestures.ts tells presses inside it from presses outside). */
  readonly host: HTMLElement;
  readonly isOpen: boolean;
  open(view: PopupView, anchor: RectCss, actions: PopupActions): void;
  /** New data for the open unit (img:unit after an edit or a re-translation). */
  update(view: PopupView): void;
  /** The balloon moved (scroll, resize). */
  place(anchor: RectCss): void;
  close(): void;
  destroy(): void;
}

const HOST_STYLE: ReadonlyArray<readonly [string, string]> = [
  ["all", "initial"],
  ["display", "block"],
  ["position", "fixed"],
  ["left", "0"],
  ["top", "0"],
  ["width", "0"],
  ["height", "0"],
  ["overflow", "visible"],
  ["pointer-events", "none"],
  ["direction", "ltr"],
  ["z-index", String(Number(ROOT_Z_INDEX) + 1)],
];

function button(doc: Document, label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = element(doc, "button", className);
  b.type = "button";
  b.textContent = label;
  isolate(b, onClick);
  return b;
}

export function createBubblePopup(doc: Document, sheet: CSSStyleSheet, mode: ShadowRootMode): BubblePopup {
  const win: Window = doc.defaultView ?? window;
  const host = doc.createElement(POPUP_TAG);
  host.setAttribute("data-ctv-popup", "");
  setImportant(host, HOST_STYLE);
  const shadow = host.attachShadow({ mode });
  shadow.adoptedStyleSheets = [sheet];

  const card = element(doc, "div", "popup");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", msg().bubble.dialog);
  card.tabIndex = -1;
  card.hidden = true;
  const head = element(doc, "div", "head");
  const title = element(doc, "div", "title");
  title.id = "ctv-popup-title";
  const tag = element(doc, "span", "tag");
  tag.textContent = msg().unitStatus.manual;
  head.append(title, tag);
  card.setAttribute("aria-describedby", "ctv-popup-title");

  const originalLabel = element(doc, "div", "label");
  originalLabel.textContent = msg().bubble.original;
  const original = element(doc, "p", "text original");
  const translationLabel = element(doc, "div", "label");
  translationLabel.textContent = msg().bubble.translation;
  const translation = element(doc, "p", "text translation");
  const editor = element(doc, "textarea", "editor");
  editor.setAttribute("aria-label", msg().bubble.editLabel);
  editor.rows = 3;
  editor.hidden = true;
  const note = element(doc, "p", "note");
  note.textContent = msg().bubble.shortened;
  const status = element(doc, "p", "status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  let view: PopupView | null = null;
  let actions: PopupActions | null = null;
  let anchor: RectCss | null = null;
  let editing = false;
  let restoreFocus: HTMLElement | null = null;
  /** A status message the user caused (Copied, Saved, …). */
  let message = "";
  /** Translate again was sent ("sent"), then the unit went back to pending ("pending"); null otherwise. */
  let again: "sent" | "pending" | null = null;

  const say = (text: string): void => {
    message = text;
    render();
  };

  const copy = button(doc, msg().bubble.copy, "copy", () => {
    const text = view?.translation ?? "";
    void copyText(doc, shadow, text).then((ok) => say(ok ? msg().sidepanel.copied : msg().sidepanel.failed));
  });
  const edit = button(doc, msg().sidepanel.edit, "edit", () => {
    editing = true;
    editor.value = view?.translation ?? "";
    message = "";
    render();
    editor.focus();
    editor.select();
  });
  // An edit always wins over the AI text, so translating an edited unit again first drops the edit.
  const retranslate = button(doc, msg().bubble.retranslate, "again", () => {
    const edited = view?.status === "manual";
    const sent = (!edited || (actions?.onSave(null) ?? false)) && (actions?.onRetranslate() ?? false);
    again = sent ? "sent" : null;
    say(sent ? msg().bubble.retranslating : msg().sidepanel.failed);
  });
  const close = button(doc, msg().bubble.close, "close", () => closePopup());
  const save = button(doc, msg().bubble.save, "save primary", () => saveEdit());
  const cancel = button(doc, msg().sidepanel.cancel, "cancel", () => {
    editing = false;
    message = "";
    render();
    edit.focus();
  });
  const revert = button(doc, msg().bubble.revert, "revert", () => {
    const sent = actions?.onSave(null) ?? false;
    say(sent ? msg().bubble.saved : msg().sidepanel.failed);
  });
  const viewActions = element(doc, "div", "actions");
  viewActions.append(copy, edit, retranslate, close);
  const editActions = element(doc, "div", "actions");
  editActions.append(cancel, save);
  const extra = element(doc, "div", "actions extra");
  extra.append(revert);

  card.append(
    head,
    originalLabel,
    original,
    translationLabel,
    translation,
    editor,
    note,
    status,
    extra,
    viewActions,
    editActions,
  );
  shadow.append(card);
  // Presses, clicks and keys inside the card stay away from the page (readers bind keys and clicks globally).
  isolate(card);

  function saveEdit(): void {
    if (view === null) return;
    const text = editor.value.trim();
    const sent = actions?.onSave(text === "" ? null : text) ?? false;
    if (sent && text !== "") view = { ...view, translation: text, status: "manual" };
    editing = !sent;
    message = sent ? msg().bubble.saved : msg().sidepanel.failed;
    render();
    if (sent) edit.focus();
  }

  function render(): void {
    if (view === null) return;
    title.textContent = popupTitle(view.type, view.speaker);
    tag.hidden = view.status !== "manual";
    original.textContent = view.original;
    originalLabel.hidden = view.original.trim() === "";
    original.hidden = originalLabel.hidden;
    translation.textContent = view.translation;
    translation.hidden = editing;
    editor.hidden = !editing;
    note.hidden = editing || !view.shortened;
    const line = message !== "" ? message : statusLine(view.status);
    status.textContent = line;
    status.hidden = line === "";
    revert.hidden = editing || view.status !== "manual";
    extra.hidden = revert.hidden;
    viewActions.hidden = editing;
    editActions.hidden = !editing;
    copy.disabled = view.translation.trim() === "";
    if (anchor !== null) placeCard(anchor);
  }

  function placeCard(rect: RectCss): void {
    const width = Math.min(POPUP_WIDTH, Math.max(0, win.innerWidth - 2 * POPUP_MARGIN));
    card.style.width = px(width);
    const size = card.getBoundingClientRect();
    const spot = placePopup(
      rect,
      { w: size.width, h: size.height },
      { w: win.innerWidth, h: win.innerHeight },
    );
    card.style.left = px(spot.left);
    card.style.top = px(spot.top);
    card.setAttribute("data-side", spot.side);
  }

  function focusables(): HTMLElement[] {
    return [...card.querySelectorAll<HTMLElement>("button, textarea")].filter(
      (node) =>
        !node.hidden && !(node.parentElement?.hidden ?? false) && !(node as HTMLButtonElement).disabled,
    );
  }

  // Tab and Shift+Tab cycle inside the card; Ctrl/Cmd+Enter saves an edit.
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && editing) {
      event.preventDefault();
      saveEdit();
      return;
    }
    if (event.key !== "Tab") return;
    const list = focusables();
    const first = list[0];
    const last = list.at(-1);
    if (first === undefined || last === undefined) return;
    const active = shadow.activeElement;
    if (event.shiftKey && (active === first || active === card)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function closePopup(): void {
    if (view === null) return;
    const done = actions;
    view = null;
    actions = null;
    anchor = null;
    editing = false;
    message = "";
    again = null;
    card.hidden = true;
    host.remove();
    const back = restoreFocus;
    restoreFocus = null;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
    done?.onClose();
  }

  return {
    host,
    get isOpen() {
      return view !== null;
    },
    open(next, rect, handlers) {
      if (view !== null) closePopup();
      const active = doc.activeElement;
      restoreFocus = active instanceof HTMLElement && active !== doc.body ? active : null;
      view = next;
      actions = handlers;
      anchor = rect;
      editing = false;
      message = "";
      again = null;
      if (host.parentNode !== doc.documentElement) doc.documentElement.append(host);
      card.hidden = false;
      render();
      card.focus({ preventScroll: true });
    },
    update(next) {
      if (view === null) return;
      // While the unit is translated again it has no text: keep showing the last one.
      const waiting = next.status === "pending" || next.status === "translating";
      view =
        waiting && next.translation.trim() === ""
          ? { ...next, translation: view.translation, original: next.original || view.original }
          : next;
      if (again === "sent" && waiting) again = "pending";
      else if (again === "pending" && !waiting) {
        again = null;
        if (message === msg().bubble.retranslating) message = "";
      }
      render();
    },
    place(rect) {
      if (view === null) return;
      anchor = rect;
      placeCard(rect);
    },
    close: closePopup,
    destroy() {
      closePopup();
      host.remove();
    },
  };
}
