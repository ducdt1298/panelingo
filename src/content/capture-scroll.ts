// Scrolling and measuring for screen captures (capture-assist.ts in the frame that shows the image, frame-chain.ts in
// the frames around it): content boxes, moving an element by scrolling its nearest scrolling ancestor and then the
// window, on both axes, with every scroll position remembered so a capture session can put the page back.

import type { RectCss } from "../shared/types.ts";

export type ScrollWindow = Pick<Window, "scrollX" | "scrollY" | "scrollTo" | "getComputedStyle">;

type BoxStyle = Pick<
  CSSStyleDeclaration,
  | "borderTopWidth"
  | "borderRightWidth"
  | "borderBottomWidth"
  | "borderLeftWidth"
  | "paddingTop"
  | "paddingRight"
  | "paddingBottom"
  | "paddingLeft"
>;

/** Scroll positions before a capture session, first change first (null target = the window). */
export type ScrollMemo = Array<{ target: Element | null; left: number; top: number }>;

const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** The content box (where the picture or the frame's document is drawn) of a border box, same coordinates. */
export function contentBox(rect: RectCss, style: BoxStyle): RectCss {
  const left = px(style.borderLeftWidth) + px(style.paddingLeft);
  const right = px(style.borderRightWidth) + px(style.paddingRight);
  const top = px(style.borderTopWidth) + px(style.paddingTop);
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);
  return {
    left: rect.left + left,
    top: rect.top + top,
    width: Math.max(0, rect.width - left - right),
    height: Math.max(0, rect.height - top - bottom),
  };
}

/** An element's content box in its document's viewport (CSS px). */
export function elementBox(win: Pick<Window, "getComputedStyle">, el: Element): RectCss {
  const r = el.getBoundingClientRect();
  return contentBox({ left: r.left, top: r.top, width: r.width, height: r.height }, win.getComputedStyle(el));
}

/** The nearest ancestor of `el` that scrolls along `axis`, or null for the window. */
function scrollerOf(win: ScrollWindow, doc: Document, el: Element, axis: "x" | "y"): Element | null {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (node === doc.documentElement || node === doc.body) return null;
    const style = win.getComputedStyle(node);
    const overflow = axis === "y" ? style.overflowY : style.overflowX;
    if (!SCROLLABLE.has(overflow)) continue;
    const scrolls =
      axis === "y" ? node.scrollHeight > node.clientHeight + 1 : node.scrollWidth > node.clientWidth + 1;
    if (scrolls) return node;
  }
  return null;
}

function remember(memo: ScrollMemo, target: Element | null, win: ScrollWindow): void {
  if (memo.some((entry) => entry.target === target)) return;
  memo.push(
    target === null
      ? { target, left: win.scrollX, top: win.scrollY }
      : { target, left: target.scrollLeft, top: target.scrollTop },
  );
}

function scrollAxis(
  memo: ScrollMemo,
  win: ScrollWindow,
  doc: Document,
  el: Element,
  axis: "x" | "y",
  delta: number,
): void {
  if (!(Math.abs(delta) >= 0.5)) return;
  const at = (): number => (axis === "y" ? el.getBoundingClientRect().top : el.getBoundingClientRect().left);
  let rest = delta;
  const scroller = scrollerOf(win, doc, el, axis);
  if (scroller !== null) {
    remember(memo, scroller, win);
    const before = at();
    scroller.scrollTo({
      top: scroller.scrollTop + (axis === "y" ? rest : 0),
      left: scroller.scrollLeft + (axis === "x" ? rest : 0),
      behavior: "instant",
    });
    rest -= before - at();
  }
  if (!(Math.abs(rest) >= 0.5)) return;
  remember(memo, null, win);
  win.scrollTo({
    top: win.scrollY + (axis === "y" ? rest : 0),
    left: win.scrollX + (axis === "x" ? rest : 0),
    behavior: "instant",
  });
}

/** Moves `el` by (dx, dy) CSS px on screen: its scrolling containers first, then the window for what is left. */
export function scrollElementBy(
  memo: ScrollMemo,
  win: ScrollWindow,
  doc: Document,
  el: Element,
  dx: number,
  dy: number,
): void {
  scrollAxis(memo, win, doc, el, "y", dy);
  scrollAxis(memo, win, doc, el, "x", dx);
}

/** Puts every remembered scroll position back, last change first. */
export function restoreScroll(memo: ScrollMemo, win: ScrollWindow): void {
  for (const entry of [...memo].reverse()) {
    const target = entry.target ?? win;
    target.scrollTo({ top: entry.top, left: entry.left, behavior: "instant" });
  }
  memo.length = 0;
}
