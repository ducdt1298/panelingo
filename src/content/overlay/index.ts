// Overlay: one shadow host per tracked image (host.ts), units painted as plate + fitted translated text in natural px
// under a scale transform (render.ts), a status badge (badge.ts), the manual-mode "Translate" button
// (hover-button.ts), the privacy notice (notice.ts) and the per-balloon popup (bubble-popup.ts, opened by Alt+click
// or a long press through gestures.ts). Hosts are re-placed in batches (read every rect, then write): on
// ResizeObserver deliveries (images and body), window resizes, page removals of a host, and for hosts in the shared
// root the scrolls and transitions that move an image against the page. Units are re-fitted only when the display
// scale moved by more than 20% or the zoom changed; otherwise the transform alone follows. Each unit is lettered in
// the face of its line type (lettering.ts); the font families load when the first units of the page arrive.
// Translations into Japanese, Chinese or Korean use the system's CJK fonts (measured on first use), and Japanese and
// Traditional Chinese are lettered vertically in vertical balloons (lettering.ts letterVertically).

import type { FontMetrics, Measure } from "../../shared/core/fit-text.ts";
import type { Box, ImageState, RectCss, Script, Size, UnitGeometry, UnitRender } from "../../shared/types.ts";
import type { CreateOverlay, ImageElement, ImageStateInfo, Overlay, TrackedImage } from "../contracts.ts";
import { FONT_FAMILIES, loadFontFamily } from "../fonts.ts";
import type { FamilyKey } from "../fonts.ts";
import {
  CJK_FONT_STACKS,
  CJK_INK_EM,
  CJK_INK_MATCH,
  CJK_LINE_PROBES,
  FACES,
  cjkFaceKey,
  cjkTargetOf,
  faceFor,
  facesOf,
  familiesInUse,
  letterVertically,
} from "../lettering.ts";
import type { FaceKey } from "../lettering.ts";
import {
  canvasContext,
  createMeasure,
  measureCapHeight,
  measureFontMetrics,
  measureInkHeight,
} from "../measure.ts";
import { badgeView, createBadge } from "./badge.ts";
import type { BadgeHandle } from "./badge.ts";
import { createBubblePopup } from "./bubble-popup.ts";
import type { BubblePopup, PopupView } from "./bubble-popup.ts";
import { px, setImportant } from "./dom.ts";
import {
  INITIAL_BOX,
  ROOT_TAG,
  anchorOf,
  clipInsets,
  createHostDom,
  isFrameworkManaged,
  layerMap,
  layerTransform,
  needsRefit,
  objectFitRect,
  placeHost,
  readClip,
  readImage,
  rectOf,
  removeStaleHosts,
  scanAncestors,
  setHostBox,
} from "./host.ts";
import type { Edges, HostDom, HostMode, LayerMap } from "./host.ts";
import { createHoverButton, hoverButtonVisible } from "./hover-button.ts";
import type { HoverButtonHandle } from "./hover-button.ts";
import { boxToRect, containsPoint, createPopupGestures, naturalToClient, pickHit } from "./gestures.ts";
import type { GestureEvent, HitCandidate } from "./gestures.ts";
import { createPrivacyNotice } from "./notice.ts";
import { buildUnitNode, planUnit, sfxMode, shouldPaint, unitHitBox } from "./render.ts";
import type { UnitPlan } from "./render.ts";
import { ROOT_RESET, overlaySheet } from "./styles.ts";

/** After a "Translate" / "Translate again" click the hover button stays away this long unless a state arrives first. */
export const REQUEST_HOLD_MS = 15_000;

interface UnitRec {
  render: UnitRender;
  node: HTMLElement | null;
  /** Display scale and zoom of the current plan; NaN = plan (again). */
  planScale: number;
  planZoom: number;
  /** Last overflow flag sent to the engine; undefined = never sent (the engine assumes false). */
  overflow: boolean | undefined;
  /** Where the painted unit answers Alt+click and long-press (natural px); kept as the popup's anchor. */
  hit: Box | null;
}

/** A face whose family has loaded (or fell back to the system fonts of its stack). */
interface FaceState {
  measure: Measure;
  metrics: FontMetrics;
  capHeightEm: number;
  /** Unknown for a fallback font. */
  inkAscentEm: number | undefined;
  /** CJK faces are matched by ink height (CJK_INK_MATCH); default the cap-height match. */
  sizeMatch?: Readonly<Record<Script, number>>;
}

/** The painted unit a popup belongs to. */
interface PopupTarget {
  key: string;
  unitKey: string;
}

interface Entry {
  readonly key: string;
  readonly element: ImageElement;
  readonly anchor: Element;
  mode: HostMode;
  readonly dom: HostDom;
  readonly badge: BadgeHandle;
  readonly hover: HoverButtonHandle | null;
  notice: HTMLElement | null;
  /** Inline styles last written to the host, compared before writing again. */
  box: RectCss;
  zIndex: string;
  clipPath: string;
  transform: string;
  visibility: string;
  /** The sibling host went into the page at least once (a later absence means the page removed it). */
  inserted: boolean;
  /** Placed at least once; `shown`: the image is rendered right now. */
  placed: boolean;
  shown: boolean;
  /** Visual CSS px per natural px. */
  scale: number;
  natural: Size | null;
  geometry: Map<string, UnitGeometry>;
  units: Map<string, UnitRec>;
  state: ImageState | undefined;
  hoverImage: boolean;
  hoverButton: boolean;
  requested: boolean;
  requestTimer: number;
  /** The parent observed for host removals (sibling mode). */
  watched: Node | null;
  /** Root mode: the image's clipping ancestors and whether it moves with the viewport. */
  clips: Element[];
  viewportBound: boolean;
  cleanup: Array<() => void>;
}

interface Reading {
  entry: Entry;
  place: { box: RectCss; scale: number } | null;
  layer: LayerMap | null;
  clip: Edges | "empty" | null;
  zIndex: string;
}

function ownerId(): string {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return Array.from(words, (w) => w.toString(36)).join("");
}

function sameBox(a: RectCss, b: RectCss): boolean {
  const eps = 0.001;
  return (
    Math.abs(a.left - b.left) < eps &&
    Math.abs(a.top - b.top) < eps &&
    Math.abs(a.width - b.width) < eps &&
    Math.abs(a.height - b.height) < eps
  );
}

function clipPathOf(clip: Edges | null): string {
  if (clip === null || Math.max(clip.top, clip.right, clip.bottom, clip.left) < 0.01) return "none";
  return `inset(${px(clip.top)} ${px(clip.right)} ${px(clip.bottom)} ${px(clip.left)})`;
}

function warn(message: string, error: unknown): void {
  if (__DEV__) console.warn(`[ctv] overlay: ${message}`, error);
}

export const createOverlay: CreateOverlay = (doc, options, events): Overlay => {
  const win: Window = doc.defaultView ?? window;
  const owner = ownerId();
  const sheet = overlaySheet(doc);
  const entries = new Map<string, Entry>();
  /** Parents observed for host removals, with the number of hosts in each. */
  const watched = new Map<Node, number>();
  const pending = new Set<Entry>();
  let pendingAll = false;
  let frame = 0;
  let visible = true;
  let destroyed = false;
  /** declined: the notice stays away until the user asks again through the overlay; accepted: consent given. */
  let privacy: "idle" | "accepted" | "declined" = "idle";
  let root: HTMLElement | null = null;
  /** Bundled faces once their family loaded, and CJK system-font faces once measured; by data-face key. */
  const faces = new Map<string, FaceState>();
  /** Japanese, Chinese or Korean translations: lettered with the system's CJK fonts. */
  const cjk = cjkTargetOf(options.target);
  const familiesRequested = new Set<FamilyKey>();
  let popup: BubblePopup | null = null;
  let popupAt: PopupTarget | null = null;
  let popupFrame = 0;

  const all = (): Entry[] => [...entries.values()];
  const zoomNow = (): number => {
    const z = win.devicePixelRatio;
    return z > 0 && Number.isFinite(z) ? z : 1;
  };
  const notify = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      warn(`${what} handler threw`, error);
    }
  };

  /* ---------------------------------------------------------------- observers and listeners */

  // Delivered after layout and before paint: re-placing here keeps hosts on their images in the same frame.
  const ro = new ResizeObserver(() => relayout(all()));
  const mo = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node === root || (node instanceof Element && node.getAttribute("data-ctv-host") === owner)) {
          scheduleAll();
          return;
        }
      }
    }
  });
  const onResize = (): void => {
    scheduleAll();
    schedulePopupPlace();
  };
  const onScroll = (event: Event): void => {
    schedulePopupPlace();
    const target = event.target;
    for (const e of entries.values()) {
      if (e.mode !== "root") continue;
      const moved = target === doc ? e.viewportBound : target instanceof Node && target.contains(e.element);
      if (moved) pending.add(e);
    }
    if (pending.size > 0) scheduleFrame();
  };
  // Root hosts do not follow transforms of the image's ancestors (sliders): re-place them when motion ends.
  const onMotion = (): void => {
    for (const e of entries.values()) if (e.mode === "root") pending.add(e);
    if (pending.size > 0) scheduleFrame();
  };
  win.addEventListener("resize", onResize);
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  doc.addEventListener("transitionend", onMotion, true);
  doc.addEventListener("animationend", onMotion, true);
  // The body's size changes when content above an image grows or shrinks, which moves the image.
  if (doc.body !== null) ro.observe(doc.body);

  function scheduleFrame(): void {
    if (frame !== 0 || destroyed) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      const list = pendingAll ? all() : [...pending].filter((e) => entries.get(e.key) === e);
      pendingAll = false;
      pending.clear();
      relayout(list);
    });
  }

  function scheduleAll(): void {
    pendingAll = true;
    scheduleFrame();
  }

  /* ---------------------------------------------------------------- host placement in the DOM */

  /**
   * Observes a sibling host's parent: removals of the host (MutationObserver) and its size (ResizeObserver: content
   * inserted above an image grows the container and moves the image without resizing it).
   */
  function watch(e: Entry, node: Node): void {
    e.watched = node;
    const n = watched.get(node) ?? 0;
    watched.set(node, n + 1);
    if (n > 0) return;
    mo.observe(node, { childList: true });
    if (node instanceof Element) ro.observe(node);
  }

  function unwatch(e: Entry): void {
    const node = e.watched;
    if (node === null) return;
    e.watched = null;
    const n = (watched.get(node) ?? 1) - 1;
    if (n > 0) {
      watched.set(node, n);
      return;
    }
    watched.delete(node);
    if (node instanceof Element && node !== doc.body) ro.unobserve(node);
    // MutationObserver has no per-target unobserve.
    mo.disconnect();
    for (const target of watched.keys()) mo.observe(target, { childList: true });
    if (root !== null) mo.observe(doc.documentElement, { childList: true });
  }

  function ensureRoot(): HTMLElement {
    if (root === null) {
      root = doc.createElement(ROOT_TAG);
      root.setAttribute("data-ctv-root", owner);
      setImportant(root, ROOT_RESET);
      mo.observe(doc.documentElement, { childList: true });
    }
    if (root.parentNode !== doc.documentElement) doc.documentElement.append(root);
    return root;
  }

  function toRoot(e: Entry): void {
    unwatch(e);
    e.mode = "root";
    e.dom.host.setAttribute("data-ctv-mode", "root");
    const scan = scanAncestors(e.element, win);
    e.clips = scan.clips;
    e.viewportBound = scan.viewportBound;
    ensureRoot().append(e.dom.host);
  }

  /** Puts the host where its mode wants it; a sibling host the page removed or moved sends the image to the root. */
  function connect(e: Entry): void {
    const host = e.dom.host;
    if (e.mode === "root") {
      const r = ensureRoot();
      if (host.parentNode !== r) r.append(host);
      return;
    }
    const parent = e.anchor.parentNode;
    if (parent === null || !e.anchor.isConnected || host.parentNode === parent) return;
    if (e.inserted) {
      toRoot(e);
      return;
    }
    removeStaleHosts(e.anchor, owner);
    e.anchor.after(host);
    e.inserted = true;
    watch(e, parent);
  }

  /* ---------------------------------------------------------------- relayout: read all, write all, paint */

  function measure(e: Entry): Reading {
    const host = e.dom.host;
    const image = host.isConnected ? readImage(e.element, win) : null;
    if (image === null || image.content.width < 1 || image.content.height < 1) {
      return { entry: e, place: null, layer: null, clip: null, zIndex: e.zIndex };
    }
    const place = placeHost(e.box, rectOf(host.getBoundingClientRect()), image.content);
    const drawnIn = { w: place.box.width, h: place.box.height };
    const layer =
      e.natural === null
        ? null
        : layerMap(objectFitRect(drawnIn, e.natural, image.intrinsic, image.fit, image.position), e.natural);
    const clip = e.mode === "root" ? clipInsets(image.content, e.clips.map(readClip), place.scale) : null;
    const zIndex = e.mode === "root" ? "auto" : String(Math.max(1, (image.zIndex ?? 0) + 1));
    return { entry: e, place, layer, clip, zIndex };
  }

  /** A shown host inherits visibility, so a sibling host hides with a page wrapper the reader hides. */
  function showHost(e: Entry): void {
    const value = visible && e.shown ? "inherit" : "hidden";
    if (value === e.visibility) return;
    setImportant(e.dom.host, [["visibility", value]]);
    e.visibility = value;
  }

  function apply(r: Reading): void {
    const e = r.entry;
    if (r.place === null || r.clip === "empty") {
      e.shown = false;
      showHost(e);
      return;
    }
    const host = e.dom.host;
    if (!sameBox(r.place.box, e.box)) {
      setHostBox(host, r.place.box);
      e.box = r.place.box;
    }
    if (r.zIndex !== e.zIndex) {
      setImportant(host, [["z-index", r.zIndex]]);
      e.zIndex = r.zIndex;
    }
    const clipPath = clipPathOf(r.clip);
    if (clipPath !== e.clipPath) {
      setImportant(host, [["clip-path", clipPath]]);
      e.clipPath = clipPath;
    }
    if (r.layer !== null) {
      const transform = layerTransform(r.layer);
      if (transform !== e.transform) {
        e.dom.layer.style.transform = transform;
        e.transform = transform;
      }
      e.dom.layer.hidden = false;
      e.scale = Math.min(r.layer.sx, r.layer.sy) * r.place.scale;
    }
    e.placed = true;
    e.shown = true;
    showHost(e);
  }

  function relayout(list: readonly Entry[]): void {
    if (destroyed || list.length === 0) return;
    for (const e of list) connect(e);
    const readings = list.map(measure);
    for (const r of readings) apply(r);
    const zoom = zoomNow();
    for (const e of list) paintPending(e, zoom);
    if (popupAt !== null) schedulePopupPlace();
  }

  /* ---------------------------------------------------------------- painting */

  /**
   * Loads a font family once, then paints every unit that waited for one of its faces. A family that failed to load
   * renders with the system fonts of its stack: their metrics and cap height are measured, never assumed.
   */
  function ensureFamily(key: FamilyKey): void {
    if (familiesRequested.has(key) || destroyed) return;
    familiesRequested.add(key);
    const stack = FONT_FAMILIES[key].stack;
    const ready = (loaded: boolean): void => {
      if (destroyed) return;
      for (const face of facesOf(key)) {
        // One context per measure: createMeasure keeps the context's font set between calls.
        faces.set(face.key, {
          measure: createMeasure(stack, canvasContext(doc), face.weight),
          metrics: loaded ? face.metrics : measureFontMetrics(stack, canvasContext(doc), face.weight),
          capHeightEm: loaded
            ? face.capHeightEm
            : (measureCapHeight(stack, canvasContext(doc), face.weight) ?? face.capHeightEm),
          inkAscentEm: loaded ? face.inkAscentEm : undefined,
        });
      }
      relayout(all());
    };
    try {
      void loadFontFamily(doc, key).then(ready, (error: unknown) => {
        warn(`font ${key} failed to load`, error);
        ready(false);
      });
    } catch (error) {
      warn(`font ${key} failed to load`, error);
      ready(false);
    }
  }

  /** Every family these settings letter in (no-op after the first call). */
  function ensureFamilies(): void {
    if (cjk !== null) return; // system fonts: nothing to load
    for (const key of familiesInUse(options.font, options.eraseSfx || options.sfxLabels)) ensureFamily(key);
  }

  /** The data-face key of a unit: a bundled face, or a CJK face of the target. */
  function faceOf(unit: UnitRender): string {
    return cjk !== null ? cjkFaceKey(cjk, unit.type) : faceFor(unit.type, options.font);
  }

  /** A CJK face measured on first use (system fonts need no loading): metrics, ink height, ink size match. */
  function cjkFace(key: string, stack: string): FaceState {
    const known = faces.get(key);
    if (known !== undefined) return known;
    const weight = key.endsWith("-bold") ? 700 : 400;
    const state: FaceState = {
      measure: createMeasure(stack, canvasContext(doc), weight),
      metrics: measureFontMetrics(stack, canvasContext(doc), weight, CJK_LINE_PROBES),
      capHeightEm: measureInkHeight(stack, canvasContext(doc), weight) ?? CJK_INK_EM,
      inkAscentEm: undefined,
      sizeMatch: CJK_INK_MATCH,
    };
    faces.set(key, state);
    return state;
  }

  /** The face to letter a unit in, or null while its bundled family loads (requested here). */
  function chooseFace(unit: UnitRender): { key: string; state: FaceState | null } {
    const key = faceOf(unit);
    if (cjk !== null) return { key, state: cjkFace(key, CJK_FONT_STACKS[cjk]) };
    const state = faces.get(key) ?? null;
    if (state === null) ensureFamily(FACES[key as FaceKey].family);
    return { key, state };
  }

  /** The unit will be lettered (so it needs its face's font): a valid translation that is not a hidden SFX. */
  function needsFace(unit: UnitRender): boolean {
    if (!shouldPaint(unit)) return false;
    return unit.type !== "sfx" || sfxMode(unit, options.eraseSfx, options.sfxLabels) !== "none";
  }

  function paintedCount(e: Entry): number {
    let n = 0;
    for (const rec of e.units.values()) if (rec.node !== null) n++;
    return n;
  }

  function updateHover(e: Entry): void {
    e.hover?.setVisible(
      hoverButtonVisible({
        mode: options.mode,
        hovering: e.hoverImage || e.hoverButton,
        requested: e.requested,
        state: e.state,
        painted: paintedCount(e),
      }),
    );
  }

  /** Boxes of the image's other units: fitText's step 3 never grows into them. */
  function obstacles(e: Entry, unitKey: string): Box[] {
    const out: Box[] = [];
    for (const g of e.geometry.values()) if (g.unitKey !== unitKey) out.push(g.bubble ?? g.text);
    for (const [key, rec] of e.units)
      if (key !== unitKey && !e.geometry.has(key)) out.push(rec.render.fit.region);
    return out;
  }

  function paint(e: Entry, rec: UnitRec, zoom: number): void {
    if (e.natural === null) return;
    const unitKey = rec.render.unitKey;
    let faceKey = faceOf(rec.render);
    let face: FaceState | null = null;
    if (needsFace(rec.render)) {
      const chosen = chooseFace(rec.render);
      faceKey = chosen.key;
      face = chosen.state;
      // Planned again (planScale stays NaN) once the family is ready.
      if (face === null) return;
    }
    let plan: UnitPlan | null = null;
    if (face !== null) {
      try {
        plan = planUnit(rec.render, e.scale, face.measure, {
          minFontPx: options.minFontPx,
          maxFontPx: options.maxFontPx,
          metrics: face.metrics,
          capHeightEm: face.capHeightEm,
          ...(face.inkAscentEm !== undefined ? { inkAscentEm: face.inkAscentEm } : {}),
          ...(face.sizeMatch !== undefined ? { sizeMatch: face.sizeMatch } : {}),
          vertical: letterVertically(options.target, options.verticalText, rec.render.fit.orientation),
          eraseSfx: options.eraseSfx,
          sfxLabels: options.sfxLabels,
          zoom,
          image: e.natural,
          grow: rec.render.seam === undefined,
          obstacles: obstacles(e, unitKey),
          geometry: e.geometry.get(unitKey) ?? null,
        });
      } catch (error) {
        warn(`cannot lay out unit ${unitKey}`, error);
      }
    }
    rec.planScale = e.scale;
    rec.planZoom = zoom;
    if (plan === null) {
      rec.node?.remove();
      rec.node = null;
      updateHover(e);
      refreshPopup(e, rec);
      return;
    }
    const node = buildUnitNode(
      doc,
      plan,
      (error) => warn(`cannot draw the erase patch of ${unitKey}`, error),
      faceKey,
    );
    if (rec.node !== null && rec.node.parentNode === e.dom.layer) rec.node.replaceWith(node);
    else e.dom.layer.append(node);
    rec.node = node;
    rec.hit = unitHitBox(plan, rec.render.fit.region);
    const overflow = plan.overflow;
    if (overflow !== (rec.overflow ?? false)) {
      rec.overflow = overflow;
      notify("onOverflow", () => events.onOverflow(e.key, unitKey, overflow));
    }
    updateHover(e);
    refreshPopup(e, rec);
  }

  /** Plans units that have none yet, or whose plan the scale or zoom has outgrown. */
  function paintPending(e: Entry, zoom: number): void {
    if (!e.shown || e.natural === null || !(e.scale > 0)) return;
    for (const rec of e.units.values()) {
      if (needsRefit(rec.planScale, e.scale, rec.planZoom, zoom)) paint(e, rec, zoom);
    }
  }

  /** True when the natural size is new: everything must be measured and planned again. */
  function setNatural(e: Entry, natural: Size): boolean {
    if (!(natural.w > 0) || !(natural.h > 0)) return false;
    if (e.natural !== null && e.natural.w === natural.w && e.natural.h === natural.h) return false;
    e.natural = { w: natural.w, h: natural.h };
    e.dom.layer.style.width = px(natural.w);
    e.dom.layer.style.height = px(natural.h);
    for (const rec of e.units.values()) rec.planScale = Number.NaN;
    return true;
  }

  /* ---------------------------------------------------------------- user requests and privacy */

  function requestTranslate(key: string): void {
    const e = entries.get(key);
    if (e === undefined || destroyed) return;
    // Asking again re-opens the privacy notice if the engine still waits for consent.
    privacy = "idle";
    e.requested = true;
    win.clearTimeout(e.requestTimer);
    e.requestTimer = win.setTimeout(() => {
      e.requested = false;
      updateHover(e);
    }, REQUEST_HOLD_MS);
    updateHover(e);
    notify("onTranslateRequest", () => events.onTranslateRequest(key));
  }

  /** A request from the context menu, a command or the popup: re-arms the (page-wide) notice like requestTranslate. */
  function noteUserRequest(_key: string): void {
    if (!destroyed) privacy = "idle";
  }

  function hideNotice(e: Entry): void {
    e.notice?.remove();
    e.notice = null;
  }

  function answerPrivacy(accepted: boolean): void {
    privacy = accepted ? "accepted" : "declined";
    for (const e of entries.values()) hideNotice(e);
    if (accepted) notify("onPrivacyAccepted", () => events.onPrivacyAccepted());
  }

  function setHover(key: string, part: "image" | "button", over: boolean): void {
    const e = entries.get(key);
    if (e === undefined) return;
    if (part === "image") e.hoverImage = over;
    else e.hoverButton = over;
    updateHover(e);
  }

  /* ---------------------------------------------------------------- Overlay */

  function createEntry(image: TrackedImage): Entry {
    const key = image.imageKey;
    const anchor = anchorOf(image.element);
    const mode: HostMode = isFrameworkManaged(anchor.parentElement) ? "root" : "sibling";
    const dom = createHostDom(doc, sheet, owner, key, options.shadowMode);
    dom.host.setAttribute("data-ctv-mode", mode);
    const badge = createBadge(doc, () => requestTranslate(key));
    const hover =
      options.mode === "manual"
        ? createHoverButton(doc, {
            onClick: () => requestTranslate(key),
            onHover: (over) => setHover(key, "button", over),
          })
        : null;
    if (hover !== null) dom.row.append(hover.element);
    dom.row.append(badge.element);
    const scan = mode === "root" ? scanAncestors(image.element, win) : { clips: [], viewportBound: false };
    const e: Entry = {
      key,
      element: image.element,
      anchor,
      mode,
      dom,
      badge,
      hover,
      notice: null,
      box: { ...INITIAL_BOX },
      zIndex: "",
      clipPath: "",
      transform: "",
      visibility: "hidden",
      inserted: false,
      placed: false,
      shown: false,
      scale: 0,
      natural: null,
      geometry: new Map(),
      units: new Map(),
      state: undefined,
      hoverImage: false,
      hoverButton: false,
      requested: false,
      requestTimer: 0,
      watched: null,
      clips: scan.clips,
      viewportBound: scan.viewportBound,
      cleanup: [],
    };
    if (hover !== null) {
      const element = image.element;
      const enter = (): void => setHover(key, "image", true);
      const leave = (): void => setHover(key, "image", false);
      element.addEventListener("pointerenter", enter);
      element.addEventListener("pointerleave", leave);
      e.cleanup.push(() => {
        element.removeEventListener("pointerenter", enter);
        element.removeEventListener("pointerleave", leave);
      });
    }
    return e;
  }

  function attach(image: TrackedImage): void {
    if (destroyed) return;
    const prev = entries.get(image.imageKey);
    if (prev !== undefined) {
      if (prev.element === image.element) {
        connect(prev);
        scheduleAll();
        return;
      }
      detach(image.imageKey);
    }
    // One host per element: a new key for the same element (its src changed) replaces the old one.
    for (const other of entries.values()) {
      if (other.element === image.element) {
        detach(other.key);
        break;
      }
    }
    const e = createEntry(image);
    entries.set(e.key, e);
    connect(e);
    // Its first delivery places the host.
    ro.observe(image.element);
  }

  function setUnits(imageKey: string, natural: Size, units: readonly UnitGeometry[]): void {
    const e = entries.get(imageKey);
    if (e === undefined || destroyed) return;
    // The fonts load while the units are translated.
    ensureFamilies();
    const resized = setNatural(e, natural);
    e.geometry = new Map(units.map((u) => [u.unitKey, u]));
    // Covers and step-3 obstacles come from the geometry.
    for (const rec of e.units.values()) rec.planScale = Number.NaN;
    if (resized) relayout([e]);
    else paintPending(e, zoomNow());
  }

  function setUnit(imageKey: string, natural: Size, unit: UnitRender): void {
    const e = entries.get(imageKey);
    if (e === undefined || destroyed) return;
    ensureFamilies();
    if (cjk === null && needsFace(unit)) ensureFamily(FACES[faceOf(unit) as FaceKey].family);
    const resized = setNatural(e, natural);
    const rec = e.units.get(unit.unitKey);
    if (rec === undefined) {
      e.units.set(unit.unitKey, {
        render: unit,
        node: null,
        planScale: Number.NaN,
        planZoom: Number.NaN,
        overflow: undefined,
        hit: null,
      });
    } else {
      rec.render = unit;
      rec.planScale = Number.NaN;
    }
    if (resized || !e.placed) relayout([e]);
    else paintPending(e, zoomNow());
  }

  function setState(imageKey: string, state: ImageState, info?: ImageStateInfo): void {
    const e = entries.get(imageKey);
    if (e === undefined || destroyed) return;
    e.state = state;
    e.requested = false;
    win.clearTimeout(e.requestTimer);
    e.requestTimer = 0;
    e.badge.update(
      badgeView(state, info, { mode: options.mode, showDoneBadge: options.showDoneBadge }),
      state,
    );
    if (e.notice !== null && !(state === "paused" && info?.error?.code === "privacy.consent")) hideNotice(e);
    updateHover(e);
  }

  function showPrivacyNotice(imageKey: string): void {
    if (destroyed || privacy !== "idle") return;
    const e = entries.get(imageKey);
    if (e === undefined || e.notice !== null) return;
    e.notice = createPrivacyNotice(doc, {
      onAccept: () => answerPrivacy(true),
      onDecline: () => answerPrivacy(false),
    });
    e.dom.stack.append(e.notice);
  }

  function detach(imageKey: string): void {
    const e = entries.get(imageKey);
    if (e === undefined) return;
    if (popupAt?.key === imageKey) popup?.close();
    entries.delete(imageKey);
    pending.delete(e);
    ro.unobserve(e.element);
    for (const fn of e.cleanup) fn();
    win.clearTimeout(e.requestTimer);
    unwatch(e);
    e.dom.host.remove();
  }

  /** The nearest ancestor that scrolls vertically, or null for the document itself. */
  function scrollParent(el: Element): Element | null {
    for (
      let node = el.parentElement;
      node !== null && node !== doc.documentElement;
      node = node.parentElement
    ) {
      if (node === doc.body) break;
      const overflowY = win.getComputedStyle(node).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight)
        return node;
    }
    return null;
  }

  function scrollToUnit(imageKey: string, unitKey: string): boolean {
    const e = entries.get(imageKey);
    if (e === undefined || e.natural === null || e.natural.h <= 0) return false;
    // Geometry comes with img:units; a cache hit (img:bulk) only brings the painted units' fit regions.
    const geometry = e.geometry.get(unitKey);
    const box = geometry?.bubble ?? geometry?.text ?? e.units.get(unitKey)?.render.fit.region;
    if (box === undefined) return false;
    const rect = e.element.getBoundingClientRect();
    const y = rect.top + ((box.y1 + box.y2) / 2 / e.natural.h) * rect.height;
    const scroller = scrollParent(e.element);
    const middle =
      scroller === null
        ? win.innerHeight / 2
        : scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    // A background tab does not animate: jump there so the page is in place when the reader switches back.
    const behavior: ScrollBehavior = doc.visibilityState === "hidden" ? "instant" : "smooth";
    (scroller ?? win).scrollBy({ top: y - middle, behavior });
    const node = e.units.get(unitKey)?.node;
    if (node !== null && node !== undefined && typeof node.animate === "function") {
      node.animate(
        [
          { boxShadow: "0 0 0 3px rgba(26, 115, 232, 0.9)" },
          { boxShadow: "0 0 0 3px rgba(26, 115, 232, 0)" },
        ],
        { duration: 1600, easing: "ease-out" },
      );
    }
    return true;
  }

  function setVisible(next: boolean): void {
    visible = next;
    for (const e of entries.values()) showHost(e);
  }

  /* ---------------------------------------------------------------- bubble popup */

  /** The unit's hit box in client px (the layer's client rect holds every ancestor scale and the scroll). */
  function clientBox(e: Entry, rec: UnitRec, layer?: RectCss): Box | null {
    if (rec.hit === null || e.natural === null) return null;
    return naturalToClient(rec.hit, layer ?? rectOf(e.dom.layer.getBoundingClientRect()), e.natural);
  }

  /** The image is under the point (not clipped away, not behind another page layer). */
  function imageAt(e: Entry, x: number, y: number): boolean {
    if (doc.elementsFromPoint(x, y).includes(e.element)) return true;
    // An image the page made transparent to the pointer is never in that list: trust the geometry.
    return win.getComputedStyle(e.element).pointerEvents === "none";
  }

  /** The painted unit under a client point: the innermost one, on an image that shows there. */
  function hitTest(x: number, y: number): PopupTarget | null {
    if (destroyed || !visible) return null;
    const point = { x, y };
    const candidates: Array<HitCandidate<PopupTarget>> = [];
    for (const e of entries.values()) {
      if (!e.shown || e.natural === null) continue;
      let layer: RectCss | null = null;
      const own: Array<HitCandidate<PopupTarget>> = [];
      for (const [unitKey, rec] of e.units) {
        if (rec.node === null || rec.hit === null) continue;
        layer ??= rectOf(e.dom.layer.getBoundingClientRect());
        const box = clientBox(e, rec, layer);
        if (box !== null && containsPoint(box, point)) own.push({ target: { key: e.key, unitKey }, box });
      }
      if (own.length > 0 && imageAt(e, x, y)) candidates.push(...own);
    }
    return pickHit(point, candidates)?.target ?? null;
  }

  function popupView(rec: UnitRec): PopupView {
    const unit = rec.render;
    return {
      original: unit.original,
      translation: unit.translation,
      type: unit.type,
      speaker: unit.speaker,
      status: unit.status,
      shortened: rec.overflow === true,
    };
  }

  function openPopup(target: PopupTarget): void {
    const e = entries.get(target.key);
    const rec = e?.units.get(target.unitKey);
    if (e === undefined || rec === undefined || destroyed) return;
    const box = clientBox(e, rec);
    if (box === null) return;
    popup ??= createBubblePopup(doc, sheet, options.shadowMode);
    popupAt = target;
    popup.open(popupView(rec), boxToRect(box), {
      onSave: (translation) => {
        let sent = false;
        notify("onEditUnit", () => {
          sent = events.onEditUnit?.(target.key, target.unitKey, translation) ?? false;
        });
        return sent;
      },
      onRetranslate: () => {
        let sent = false;
        notify("onRetranslateUnit", () => {
          sent = events.onRetranslateUnit?.(target.key, target.unitKey) ?? false;
        });
        return sent;
      },
      onClose: () => {
        if (popupAt === target) popupAt = null;
      },
    });
  }

  /** The open popup shows the unit's latest data (img:unit after an edit or a re-translation). */
  function refreshPopup(e: Entry, rec: UnitRec): void {
    if (popup === null || popupAt === null) return;
    if (popupAt.key !== e.key || popupAt.unitKey !== rec.render.unitKey) return;
    popup.update(popupView(rec));
    schedulePopupPlace();
  }

  function schedulePopupPlace(): void {
    if (popupFrame !== 0 || popupAt === null || destroyed) return;
    popupFrame = win.requestAnimationFrame(() => {
      popupFrame = 0;
      const at = popupAt;
      if (at === null || popup === null) return;
      const e = entries.get(at.key);
      const rec = e?.units.get(at.unitKey);
      const box = e !== undefined && rec !== undefined ? clientBox(e, rec) : null;
      if (box === null) popup.close();
      else popup.place(boxToRect(box));
    });
  }

  /** The event comes from the overlay's own UI: a host of this overlay or the popup. */
  function pathOf(event: GestureEvent): EventTarget[] {
    return typeof event.composedPath === "function" ? event.composedPath() : [];
  }

  const gestures = createPopupGestures<PopupTarget>({
    win,
    altClick: options.popupWithAltClick,
    hitTest,
    onOpen: openPopup,
    isOwn: (event) =>
      pathOf(event).some(
        (node) =>
          node instanceof Element && (node.getAttribute("data-ctv-host") === owner || node === popup?.host),
      ),
    inPopup: (event) => popup !== null && pathOf(event).includes(popup.host),
    isOpen: () => popup?.isOpen === true,
    onDismiss: () => popup?.close(),
    setTimer: (fn, ms) => {
      const id = win.setTimeout(fn, ms);
      return () => win.clearTimeout(id);
    },
  });

  function destroy(): void {
    if (destroyed) return;
    popup?.destroy();
    popup = null;
    popupAt = null;
    gestures.destroy();
    for (const key of [...entries.keys()]) detach(key);
    destroyed = true;
    ro.disconnect();
    mo.disconnect();
    win.removeEventListener("resize", onResize);
    doc.removeEventListener("scroll", onScroll, true);
    doc.removeEventListener("transitionend", onMotion, true);
    doc.removeEventListener("animationend", onMotion, true);
    if (frame !== 0) win.cancelAnimationFrame(frame);
    frame = 0;
    if (popupFrame !== 0) win.cancelAnimationFrame(popupFrame);
    popupFrame = 0;
    root?.remove();
    root = null;
    watched.clear();
    pending.clear();
  }

  return {
    attach,
    setUnits,
    setUnit,
    setState,
    showPrivacyNotice,
    noteUserRequest,
    detach,
    scrollToUnit,
    setVisible,
    get visible() {
      return visible;
    },
    relayout: () => relayout(all()),
    destroy,
  };
};
