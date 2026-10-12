// Tiny DOM builders for the extension pages: no framework and no innerHTML (text always goes in as text nodes).

export type Child = Node | string | number | false | null | undefined;
export type PropValue = string | number | boolean | null | undefined | ((event: Event) => void);
export type Props = Readonly<Record<string, PropValue>>;

/** Set as DOM properties rather than attributes (they reflect live form state). */
const PROPERTIES: ReadonlySet<string> = new Set(["value", "checked", "disabled", "selected", "hidden"]);

function applyProp(el: HTMLElement, key: string, value: PropValue): void {
  if (typeof value === "function") {
    if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    return;
  }
  if (PROPERTIES.has(key)) {
    (el as unknown as Record<string, unknown>)[key] = value ?? false;
    return;
  }
  if (value === null || value === undefined || value === false) return;
  if (key === "class") el.className = String(value);
  else el.setAttribute(key, value === true ? "" : String(value));
}

/** Appends children; strings and numbers become text nodes, false/null/undefined are skipped. */
export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

/** h("button", { class: "primary", onclick: run }, "Save"): element with props (on* = listeners) and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props !== null) for (const [key, value] of Object.entries(props)) applyProp(el, key, value);
  append(el, children);
  return el;
}

export function text(value: string): Text {
  return document.createTextNode(value);
}

/** Removes every child. */
export function clear(el: Element): void {
  el.replaceChildren();
}

/** Replaces the children of `el`. */
export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}
