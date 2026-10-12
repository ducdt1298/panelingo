// DOM helpers for the overlay. Styling goes through CSSOM only (a page CSP may block style attributes, never CSSOM),
// nodes are built one by one (no HTML parsing: Trusted Types pages), and the few interactive elements keep their
// events away from the page (readers wrap images in click-to-next links and handlers).

export function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}

/** CSS length in px, rounded to 1/1000 px (far below LayoutUnit's 1/64). */
export function px(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

/** Sets declarations with !important, in order (later ones override earlier shorthands such as `all`). */
export function setImportant(
  node: HTMLElement,
  declarations: ReadonlyArray<readonly [string, string]>,
): void {
  for (const [property, value] of declarations) node.style.setProperty(property, value, "important");
}

const STOPPED = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
  "keydown",
  "keyup",
  "keypress",
] as const;

/**
 * Keeps pointer, mouse and key events of an overlay control from reaching the page, and cancels the click's
 * default so an ancestor link does not navigate; `onClick` runs on activation.
 */
export function isolate(target: HTMLElement, onClick?: () => void): void {
  for (const type of STOPPED) target.addEventListener(type, (event) => event.stopPropagation());
  target.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick?.();
  });
}
