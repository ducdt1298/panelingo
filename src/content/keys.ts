// Peek at the original: while the peek key (settings.render.peekKey, a KeyboardEvent.code such as "Backquote") is
// held, the overlay hides; releasing it, or the window losing focus, brings it back. Keys typed into editable fields
// never peek. Optionally holding Alt alone peeks too (settings.render.peekWithAlt); its keyup is cancelled so Chrome
// on Windows does not move focus to the browser menu.

export interface PeekOptions {
  /** The window whose key events are watched (capture phase). */
  win: Window;
  /** KeyboardEvent.code of the peek key; "" disables it. */
  key: string;
  withAlt: boolean;
  /** true when a peek starts, false when it ends. */
  onPeek(active: boolean): void;
}

export interface Peek {
  readonly active: boolean;
  destroy(): void;
}

const ALT_CODES: ReadonlySet<string> = new Set(["AltLeft", "AltRight"]);
const EDITABLE_TAGS: ReadonlySet<string> = new Set(["input", "textarea", "select"]);
/** Key listeners run in the capture phase, before page handlers can stop the event. */
const CAPTURE: AddEventListenerOptions = { capture: true };

/**
 * The key event comes from a text field, a select or a contenteditable element (also inside open shadow roots), or
 * from the bubble popup: its closed shadow root shows only its host, and its edit field must never peek.
 */
export function isEditableTarget(event: Event): boolean {
  const target = event.composedPath()[0] ?? event.target;
  if (target === null || typeof target !== "object") return false;
  const el = target as Partial<HTMLElement>;
  if (el.isContentEditable === true) return true;
  if (typeof el.hasAttribute === "function" && el.hasAttribute("data-ctv-popup")) return true;
  return typeof el.localName === "string" && EDITABLE_TAGS.has(el.localName);
}

/** The code that starts a peek for this keydown, or null. */
export function peekCode(event: KeyboardEvent, key: string, withAlt: boolean): string | null {
  if (event.ctrlKey || event.metaKey) return null;
  if (key !== "" && event.code === key && !event.altKey) return event.code;
  if (withAlt && ALT_CODES.has(event.code) && !event.shiftKey) return event.code;
  return null;
}

export function createPeek(options: PeekOptions): Peek {
  const { win } = options;
  /** The code that started the current peek; null when not peeking. */
  let holding: string | null = null;

  const end = (): void => {
    if (holding === null) return;
    holding = null;
    options.onPeek(false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (holding !== null) {
      // Another key while Alt is held is a shortcut (Alt+Shift+Y…), not a peek.
      if (ALT_CODES.has(holding) && event.code !== holding) end();
      return;
    }
    if (event.repeat || isEditableTarget(event)) return;
    const code = peekCode(event, options.key, options.withAlt);
    if (code === null) return;
    holding = code;
    options.onPeek(true);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (holding === null || event.code !== holding) return;
    if (ALT_CODES.has(holding)) event.preventDefault();
    end();
  };

  const onVisibility = (): void => {
    if (win.document.visibilityState === "hidden") end();
  };

  win.addEventListener("keydown", onKeyDown, CAPTURE);
  win.addEventListener("keyup", onKeyUp, CAPTURE);
  win.addEventListener("blur", end);
  win.document.addEventListener("visibilitychange", onVisibility);

  return {
    get active() {
      return holding !== null;
    },
    destroy() {
      win.removeEventListener("keydown", onKeyDown, CAPTURE);
      win.removeEventListener("keyup", onKeyUp, CAPTURE);
      win.removeEventListener("blur", end);
      win.document.removeEventListener("visibilitychange", onVisibility);
      end();
    },
  };
}
