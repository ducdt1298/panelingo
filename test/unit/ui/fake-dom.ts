// Just enough of the DOM for ui/common/dom.ts builders and the extension pages in Node (imported by tests; not a
// test file itself).

export class FakeNode {
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;

  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeNode): void {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of [...this.childNodes]) this.removeChild(child);
    for (const node of nodes) this.appendChild(node);
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  /** Like the DOM: replaces every child with one text node. */
  set textContent(value: string) {
    this.replaceChildren(new FakeText(value));
  }
}

export class FakeText extends FakeNode {
  readonly data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }

  override get textContent(): string {
    return this.data;
  }
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  className = "";
  #value: unknown = undefined;
  [property: string]: unknown;

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  /** Live form value; a <select> without an explicit value reports its selected (else first) option, like the DOM. */
  get value(): unknown {
    if (this.#value !== undefined || this.tagName !== "SELECT") return this.#value;
    const options = this.findAll("option");
    const chosen = options.find((option) => option["selected"] === true) ?? options[0];
    return chosen === undefined ? "" : (chosen.value ?? chosen.textContent);
  }

  set value(next: unknown) {
    this.#value = next;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /** Like HTMLElement.click(): fires a click event and counts it (download links, hidden file pickers). */
  click(): void {
    this["clicks"] = (typeof this["clicks"] === "number" ? this["clicks"] : 0) + 1;
    this.dispatch("click");
  }

  /** Like HTMLElement.focus() (counted; the fake document's activeElement is set by tests). */
  focus(): void {
    this["focuses"] = (typeof this["focuses"] === "number" ? this["focuses"] : 0) + 1;
  }

  /** Like Element.remove(). */
  remove(): void {
    this.parentNode?.removeChild(this);
  }

  /** Fires a fake event; returns whether a listener called preventDefault(). */
  dispatch(type: string): boolean {
    return this.fire(type).prevented;
  }

  /** Fires a fake event; reports whether listeners called preventDefault() and stopPropagation(). */
  fire(type: string): { prevented: boolean; stopped: boolean } {
    const outcome = { prevented: false, stopped: false };
    const event = {
      type,
      target: this,
      preventDefault: () => {
        outcome.prevented = true;
      },
      stopPropagation: () => {
        outcome.stopped = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return outcome;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  /** Depth-first search by tag name. */
  findAll(tag: string): FakeElement[] {
    const wanted = tag.toUpperCase();
    const out: FakeElement[] = [];
    for (const child of this.children) {
      if (child.tagName === wanted) out.push(child);
      out.push(...child.findAll(tag));
    }
    return out;
  }

  /** Depth-first search by the id attribute. */
  findById(id: string): FakeElement | null {
    for (const child of this.children) {
      if (child.getAttribute("id") === id) return child;
      const found = child.findById(id);
      if (found !== null) return found;
    }
    return null;
  }

  /** The first element of this tag whose text is exactly `text` (throws when there is none). */
  byText(tag: string, text: string): FakeElement {
    const found = this.findAll(tag).find((el) => el.textContent === text);
    if (found === undefined) throw new Error(`no <${tag}> with text ${JSON.stringify(text)}`);
    return found;
  }
}

/** Installs a fake `document` global; returns the uninstall function. */
export function installFakeDocument(): () => void {
  return installFakePage().uninstall;
}

/** The `document` global an extension page sees: element builders plus the page's static elements by id. */
export interface FakeDocument {
  title: string;
  activeElement: FakeElement | null;
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  createElement(tag: string): FakeElement;
  createTextNode(data: string): FakeText;
  getElementById(id: string): FakeElement | null;
}

export interface FakePage {
  readonly document: FakeDocument;
  /** The static element with this id (one of `ids`). */
  readonly byId: (id: string) => FakeElement;
  readonly uninstall: () => void;
}

/** Installs a fake `document` whose body holds one empty <div> per id (the page's HTML skeleton). */
export function installFakePage(ids: readonly string[] = []): FakePage {
  const holder = globalThis as { document?: unknown };
  const previous = holder.document;
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  documentElement.appendChild(body);
  for (const id of ids) {
    const el = new FakeElement("div");
    el.setAttribute("id", id);
    body.appendChild(el);
  }
  const doc: FakeDocument = {
    title: "",
    activeElement: null,
    documentElement,
    body,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
    getElementById: (id: string) => documentElement.findById(id),
  };
  holder.document = doc;
  return {
    document: doc,
    byId: (id) => {
      const el = doc.getElementById(id);
      if (el === null) throw new Error(`no #${id}`);
      return el;
    },
    uninstall: () => {
      holder.document = previous;
    },
  };
}

/** A standalone Document stand-in for builders that take the document as a parameter (content overlay). */
export function fakeDocument(): Document {
  const doc = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (data: string) => new FakeText(data),
  };
  return doc as unknown as Document;
}

export function asFake(node: unknown): FakeElement {
  if (!(node instanceof FakeElement)) throw new Error("not a fake element");
  return node;
}
