// Shadow hosts. One host per image: a sibling right after the image (inside the same containing block, so it scrolls,
// clips and transforms with it), or a host in a shared root on documentElement when the parent is framework-managed
// or the page removed the sibling host. Positions are measured, never derived from offsetParent: the host's current
// CSS box is corrected by the distance between its client rect and the image's content rect, which holds for any
// containing block, ancestor scale transform, or the root's page coordinates. Units live in a layer sized natural W×H
// under translate + scale(displayed / natural).

import type { Box, RectCss, Size } from "../../shared/types.ts";
import type { ImageElement } from "../contracts.ts";
import { element, px, setImportant } from "./dom.ts";
import { HOST_RESET } from "./styles.ts";

export type HostMode = "sibling" | "root";

export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/* ------------------------------------------------------------------ framework-managed parents */

/** Mount points of SPA frameworks (Next.js, React/Vite templates, Vue). */
export const FRAMEWORK_ROOT_IDS: ReadonlySet<string> = new Set(["__next", "root", "app"]);

/** The parts of an Element the decision reads (DOM elements satisfy it; tests pass plain objects). */
export interface AncestorLike {
  readonly id: string;
  getAttributeNames(): string[];
  readonly parentElement: AncestorLike | null;
}

/**
 * A content script cannot see page-world expandos (__reactFiber$…, __vue__), so ownership is read from markup:
 * data-reactroot, ng-version or a Vue scoped-style data-v-* attribute on the parent or any ancestor, or an ancestor
 * that is a SPA mount point (#__next, #root, #app).
 */
export function isFrameworkManaged(parent: AncestorLike | null): boolean {
  for (let node = parent; node !== null; node = node.parentElement) {
    if (FRAMEWORK_ROOT_IDS.has(node.id)) return true;
    for (const name of node.getAttributeNames()) {
      if (name === "data-reactroot" || name === "ng-version" || name.startsWith("data-v-")) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ placement (pure) */

export interface ImageBoxInput {
  /** getBoundingClientRect() of the image: visual px. */
  rect: RectCss;
  /** Layout width of its border box in CSS px (computed width, plus padding and border under content-box). */
  borderBoxWidth: number;
  border: Edges;
  padding: Edges;
}

/** The image's content box in visual px: its border and padding scale with it. */
export function contentRect(input: ImageBoxInput): RectCss {
  const s = input.borderBoxWidth > 0 && input.rect.width > 0 ? input.rect.width / input.borderBoxWidth : 1;
  const left = (input.border.left + input.padding.left) * s;
  const top = (input.border.top + input.padding.top) * s;
  const right = (input.border.right + input.padding.right) * s;
  const bottom = (input.border.bottom + input.padding.bottom) * s;
  return {
    left: input.rect.left + left,
    top: input.rect.top + top,
    width: Math.max(0, input.rect.width - left - right),
    height: Math.max(0, input.rect.height - top - bottom),
  };
}

/**
 * The CSS box that puts the host exactly on `target` (visual px), from the box it has now (`current`, CSS px of its
 * containing block) and where that box shows up (`hostRect`, visual px). scale = visual px per CSS px of the
 * containing block (ancestor transforms); the offset absorbs the containing block, html/body margins and scrolling.
 */
export function placeHost(
  current: RectCss,
  hostRect: RectCss,
  target: RectCss,
): { box: RectCss; scale: number } {
  const scale = current.width > 0 && hostRect.width > 0 ? hostRect.width / current.width : 1;
  return {
    box: {
      left: current.left + (target.left - hostRect.left) / scale,
      top: current.top + (target.top - hostRect.top) / scale,
      width: target.width / scale,
      height: target.height / scale,
    },
    scale,
  };
}

type Offset = (free: number) => number;

function axisOffset(token: string | undefined, axis: "x" | "y"): Offset | null {
  if (token === undefined) return null;
  const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|%)$/i.exec(token);
  if (m !== null) {
    const n = Number(m[1]);
    return m[2] === "%" ? (free) => (free * n) / 100 : () => n;
  }
  if (token === "center") return (free) => free / 2;
  if (token === (axis === "x" ? "left" : "top")) return () => 0;
  if (token === (axis === "x" ? "right" : "bottom")) return (free) => free;
  return null;
}

/** Computed object-position ("50% 50%", "0px 10px", keywords in either order); anything else centres. */
export function objectPosition(value: string): { x: Offset; y: Offset } {
  const center: Offset = (free) => free / 2;
  const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 1) tokens.push("center");
  if (tokens.length !== 2) return { x: center, y: center };
  let [a, b] = tokens;
  if (a === "top" || a === "bottom" || b === "left" || b === "right") [a, b] = [b, a];
  return { x: axisOffset(a, "x") ?? center, y: axisOffset(b, "y") ?? center };
}

/**
 * Where the natural image is drawn inside a content box of size `box` (CSS px), per object-fit and
 * object-position. `intrinsic` is the element's own CSS size (naturalWidth/Height, density-corrected; canvas
 * width/height) for `none` and `scale-down`; otherwise only the aspect ratio of `natural` matters.
 */
export function objectFitRect(
  box: Size,
  natural: Size,
  intrinsic: Size | null,
  fit: string,
  position: string,
): RectCss {
  if (!(natural.w > 0) || !(natural.h > 0)) return { left: 0, top: 0, width: box.w, height: box.h };
  const own = intrinsic !== null && intrinsic.w > 0 && intrinsic.h > 0 ? intrinsic : natural;
  const contain = Math.min(box.w / natural.w, box.h / natural.h);
  let w = box.w;
  let h = box.h;
  if (fit === "contain") {
    w = natural.w * contain;
    h = natural.h * contain;
  } else if (fit === "cover") {
    const s = Math.max(box.w / natural.w, box.h / natural.h);
    w = natural.w * s;
    h = natural.h * s;
  } else if (fit === "none" || (fit === "scale-down" && own.w <= natural.w * contain)) {
    w = own.w;
    h = own.h;
  } else if (fit === "scale-down") {
    w = natural.w * contain;
    h = natural.h * contain;
  }
  const pos = objectPosition(position);
  return { left: pos.x(box.w - w), top: pos.y(box.h - h), width: w, height: h };
}

/** natural px → host-local CSS px: (x + u·sx, y + v·sy). */
export interface LayerMap {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

export function layerMap(drawn: RectCss, natural: Size): LayerMap {
  return { x: drawn.left, y: drawn.top, sx: drawn.width / natural.w, sy: drawn.height / natural.h };
}

export function layerTransform(m: LayerMap): string {
  return `translate(${px(m.x)}, ${px(m.y)}) scale(${m.sx}, ${m.sy})`;
}

export function naturalToCss(b: Box, m: LayerMap): RectCss {
  return {
    left: m.x + b.x1 * m.sx,
    top: m.y + b.y1 * m.sy,
    width: (b.x2 - b.x1) * m.sx,
    height: (b.y2 - b.y1) * m.sy,
  };
}

export function cssToNatural(r: RectCss, m: LayerMap): Box {
  return {
    x1: (r.left - m.x) / m.sx,
    y1: (r.top - m.y) / m.sy,
    x2: (r.left + r.width - m.x) / m.sx,
    y2: (r.top + r.height - m.y) / m.sy,
  };
}

/** Target: painted geometry within 2 CSS px of the engine's, at reader widths 900 / 1280 / 1600. */
export const MISMATCH_TOLERANCE_PX = 2;

/** Largest distance between corresponding edges of two rects. */
export function rectMismatch(a: RectCss, b: RectCss): number {
  return Math.max(
    Math.abs(a.left - b.left),
    Math.abs(a.top - b.top),
    Math.abs(a.left + a.width - (b.left + b.width)),
    Math.abs(a.top + a.height - (b.top + b.height)),
  );
}

export function withinTolerance(
  expected: RectCss,
  actual: RectCss,
  tolerance = MISMATCH_TOLERANCE_PX,
): boolean {
  return rectMismatch(expected, actual) <= tolerance;
}

/** Layout numbers of a clipping ancestor (visual rect plus CSS-px client metrics). */
export interface ClipSource {
  rect: RectCss;
  offsetWidth: number;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
}

/** What a clipping ancestor lets through: its padding box minus scrollbars, in visual px. */
export function clipArea(c: ClipSource): RectCss {
  const s = c.offsetWidth > 0 && c.rect.width > 0 ? c.rect.width / c.offsetWidth : 1;
  return {
    left: c.rect.left + c.clientLeft * s,
    top: c.rect.top + c.clientTop * s,
    width: c.clientWidth * s,
    height: c.clientHeight * s,
  };
}

/**
 * clip-path insets (host CSS px) that cut a root-mode host to what the image's clipping ancestors show; null when
 * nothing clips, "empty" when nothing of the image shows.
 */
export function clipInsets(
  target: RectCss,
  clips: readonly RectCss[],
  scale: number,
): Edges | "empty" | null {
  if (clips.length === 0) return null;
  let left = -Infinity;
  let top = -Infinity;
  let right = Infinity;
  let bottom = Infinity;
  for (const c of clips) {
    left = Math.max(left, c.left);
    top = Math.max(top, c.top);
    right = Math.min(right, c.left + c.width);
    bottom = Math.min(bottom, c.top + c.height);
  }
  const tRight = target.left + target.width;
  const tBottom = target.top + target.height;
  if (Math.min(right, tRight) <= Math.max(left, target.left)) return "empty";
  if (Math.min(bottom, tBottom) <= Math.max(top, target.top)) return "empty";
  const s = scale > 0 ? scale : 1;
  return {
    top: Math.max(0, top - target.top) / s,
    right: Math.max(0, tRight - right) / s,
    bottom: Math.max(0, tBottom - bottom) / s,
    left: Math.max(0, left - target.left) / s,
  };
}

/** Re-fit when the display scale moved by more than 20% (otherwise only the transform follows) or the zoom changed. */
export const REFIT_SCALE_CHANGE = 0.2;

export function needsRefit(planScale: number, scale: number, planZoom: number, zoom: number): boolean {
  if (!(planScale > 0) || !(scale > 0)) return true;
  return Math.abs(scale / planScale - 1) > REFIT_SCALE_CHANGE || Math.abs(zoom - planZoom) > 1e-6;
}

/* ------------------------------------------------------------------ DOM glue */

export const HOST_TAG = "ctv-host";
export const ROOT_TAG = "ctv-root";
/** A fresh host's box: wide enough that its client rect gives the containing block's scale precisely. */
export const INITIAL_BOX: Readonly<RectCss> = { left: 0, top: 0, width: 100, height: 100 };

export interface HostDom {
  host: HTMLElement;
  shadow: ShadowRoot;
  /** Clips the unit layer to the image's content box. */
  clip: HTMLDivElement;
  /** Natural px under the scale transform. */
  layer: HTMLDivElement;
  /** Sticky column (CSS px) for the badge row and the privacy notice. */
  stack: HTMLDivElement;
  row: HTMLDivElement;
}

export function setHostBox(host: HTMLElement, box: RectCss): void {
  setImportant(host, [
    ["left", px(box.left)],
    ["top", px(box.top)],
    ["width", px(box.width)],
    ["height", px(box.height)],
  ]);
}

export function createHostDom(
  doc: Document,
  sheet: CSSStyleSheet,
  owner: string,
  imageKey: string,
  mode: ShadowRootMode,
): HostDom {
  const host = doc.createElement(HOST_TAG);
  host.setAttribute("data-ctv-host", owner);
  host.setAttribute("data-ctv-image", imageKey);
  setImportant(host, HOST_RESET);
  setHostBox(host, INITIAL_BOX);
  const shadow = host.attachShadow({ mode });
  shadow.adoptedStyleSheets = [sheet];
  const clip = element(doc, "div", "clip");
  const layer = element(doc, "div", "layer");
  layer.hidden = true;
  clip.append(layer);
  const ui = element(doc, "div", "ui");
  const stack = element(doc, "div", "stack");
  const row = element(doc, "div", "row");
  stack.append(row);
  ui.append(stack);
  shadow.append(clip, ui);
  return { host, shadow, clip, layer, stack, row };
}

/** The element the sibling host follows: the <picture> around an <img>, else the image itself. */
export function anchorOf(image: ImageElement): Element {
  const parent = image.parentElement;
  return parent !== null && parent.tagName === "PICTURE" ? parent : image;
}

/** Removes hosts of other overlay instances (an orphaned content script) right after the anchor. */
export function removeStaleHosts(anchor: Element, owner: string): void {
  let next = anchor.nextElementSibling;
  while (next !== null && next.hasAttribute("data-ctv-host")) {
    const after = next.nextElementSibling;
    if (next.getAttribute("data-ctv-host") !== owner) next.remove();
    next = after;
  }
}

export function rectOf(r: DOMRectReadOnly): RectCss {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export interface ImageReading {
  /** Content box, visual px. */
  content: RectCss;
  fit: string;
  position: string;
  zIndex: number | null;
  intrinsic: Size | null;
}

function cssNumber(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Reads where the image is drawn; null when it is not rendered. Layout reads only. */
export function readImage(image: ImageElement, win: Window): ImageReading | null {
  if (!image.isConnected) return null;
  const rect = image.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const cs = win.getComputedStyle(image);
  const border: Edges = {
    top: cssNumber(cs.borderTopWidth),
    right: cssNumber(cs.borderRightWidth),
    bottom: cssNumber(cs.borderBottomWidth),
    left: cssNumber(cs.borderLeftWidth),
  };
  const padding: Edges = {
    top: cssNumber(cs.paddingTop),
    right: cssNumber(cs.paddingRight),
    bottom: cssNumber(cs.paddingBottom),
    left: cssNumber(cs.paddingLeft),
  };
  const width = cssNumber(cs.width);
  const borderBoxWidth =
    cs.boxSizing === "border-box" ? width : width + border.left + border.right + padding.left + padding.right;
  const z = Number.parseInt(cs.zIndex, 10);
  let intrinsic: Size | null = null;
  if ("naturalWidth" in image) {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      intrinsic = { w: image.naturalWidth, h: image.naturalHeight };
    }
  } else if (image.width > 0 && image.height > 0) {
    intrinsic = { w: image.width, h: image.height };
  }
  return {
    content: contentRect({ rect: rectOf(rect), borderBoxWidth, border, padding }),
    fit: cs.objectFit,
    position: cs.objectPosition,
    zIndex: Number.isFinite(z) ? z : null,
    intrinsic,
  };
}

export interface AncestorScan {
  /** Ancestors whose overflow (or paint containment) clips the image. */
  clips: Element[];
  /** The image or an ancestor is fixed or sticky: it moves against the page when the document scrolls. */
  viewportBound: boolean;
}

/** Root-mode hosts sit outside the image's ancestors, so they replay its clipping and fixed positioning. */
export function scanAncestors(image: Element, win: Window): AncestorScan {
  const doc = image.ownerDocument;
  const clips: Element[] = [];
  let viewportBound = false;
  for (
    let node: Element | null = image;
    node !== null && node !== doc.body && node !== doc.documentElement;
    node = node.parentElement
  ) {
    const cs = win.getComputedStyle(node);
    if (cs.position === "fixed" || cs.position === "sticky") viewportBound = true;
    if (node === image || cs.display === "inline" || cs.display === "contents") continue;
    if (
      cs.overflowX !== "visible" ||
      cs.overflowY !== "visible" ||
      /\b(paint|strict|content)\b/.test(cs.contain)
    ) {
      clips.push(node);
    }
  }
  return { clips, viewportBound };
}

export function readClip(node: Element): RectCss {
  const rect = rectOf(node.getBoundingClientRect());
  return clipArea({
    rect,
    offsetWidth: node instanceof HTMLElement ? node.offsetWidth : rect.width,
    clientLeft: node.clientLeft,
    clientTop: node.clientTop,
    clientWidth: node.clientWidth,
    clientHeight: node.clientHeight,
  });
}
