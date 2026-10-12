import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FRAMEWORK_ROOT_IDS,
  INITIAL_BOX,
  MISMATCH_TOLERANCE_PX,
  REFIT_SCALE_CHANGE,
  clipArea,
  clipInsets,
  contentRect,
  cssToNatural,
  isFrameworkManaged,
  layerMap,
  naturalToCss,
  needsRefit,
  objectFitRect,
  objectPosition,
  placeHost,
  rectMismatch,
  withinTolerance,
} from "../../../../src/content/overlay/host.ts";
import type { AncestorLike, Edges } from "../../../../src/content/overlay/host.ts";
import { HOST_RESET, OVERLAY_CSS, ROOT_RESET, ROOT_Z_INDEX } from "../../../../src/content/overlay/styles.ts";
import { COMIC_FONT_STACK } from "../../../../src/content/fonts.ts";
import type { Box, RectCss, Size } from "../../../../src/shared/types.ts";

const ZERO: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
const rect = (left: number, top: number, width: number, height: number): RectCss => ({
  left,
  top,
  width,
  height,
});
const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });

/** A chain of plain elements, innermost first: [id, attribute names][]. */
function chain(...nodes: Array<[string, string[]]>): AncestorLike | null {
  let parent: AncestorLike | null = null;
  for (const [id, attrs] of [...nodes].reverse()) {
    const node: AncestorLike = { id, getAttributeNames: () => [...attrs], parentElement: parent };
    parent = node;
  }
  return parent;
}

const BODY: [string, string[]] = ["", []];
const HTML: [string, string[]] = ["", ["lang"]];

describe("framework-managed parents (sibling host or documentElement root)", () => {
  test("plain markup keeps the sibling host", () => {
    assert.equal(
      isFrameworkManaged(chain(["", ["class"]], ["viewer", ["class", "data-page"]], BODY, HTML)),
      false,
    );
    assert.equal(isFrameworkManaged(null), false);
  });

  test("React, Vue scoped styles and Angular markers on the parent or any ancestor", () => {
    assert.equal(isFrameworkManaged(chain(["", ["data-v-7ba5bd90", "class"]], BODY, HTML)), true);
    assert.equal(isFrameworkManaged(chain(["", ["class"]], ["", ["data-reactroot"]], BODY, HTML)), true);
    assert.equal(isFrameworkManaged(chain(["", []], ["", []], ["", ["ng-version"]], BODY, HTML)), true);
  });

  test("SPA mount points as ancestors: #__next, #root, #app", () => {
    for (const id of FRAMEWORK_ROOT_IDS) {
      assert.equal(isFrameworkManaged(chain(["", ["class"]], [id, []], BODY, HTML)), true, id);
    }
    assert.deepEqual([...FRAMEWORK_ROOT_IDS].sort(), ["__next", "app", "root"]);
  });

  test("look-alikes do not count", () => {
    assert.equal(
      isFrameworkManaged(chain(["rooted", ["data-version", "data-vue"]], ["application", []], BODY)),
      false,
    );
  });
});

describe("placement (natural px ↔ CSS px)", () => {
  test("contentRect: border and padding scale with the element", () => {
    const border: Edges = { top: 2, right: 2, bottom: 2, left: 2 };
    const padding: Edges = { top: 0, right: 8, bottom: 0, left: 8 };
    // Border box 820 CSS px wide, shown at half size by an ancestor transform.
    assert.deepEqual(contentRect({ rect: rect(10, 20, 410, 300), borderBoxWidth: 820, border, padding }), {
      left: 15,
      top: 21,
      width: 400,
      height: 298,
    });
    assert.deepEqual(
      contentRect({ rect: rect(0, 0, 800, 600), borderBoxWidth: 800, border: ZERO, padding: ZERO }),
      {
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      },
    );
  });

  test("placeHost corrects the current box by the measured offset", () => {
    // The containing block starts at (40, 300) on screen.
    const placed = placeHost(INITIAL_BOX, rect(40, 300, 100, 100), rect(140, 900, 720, 6912));
    assert.deepEqual(placed, { box: rect(100, 600, 720, 6912), scale: 1 });
    // Already in place: unchanged.
    assert.deepEqual(
      placeHost(placed.box, rect(140, 900, 720, 6912), rect(140, 900, 720, 6912)).box,
      placed.box,
    );
  });

  test("placeHost under an ancestor scale transform works in the containing block's CSS px", () => {
    const placed = placeHost(rect(0, 0, 100, 100), rect(20, 10, 50, 50), rect(70, 60, 400, 300));
    assert.equal(placed.scale, 0.5);
    assert.deepEqual(placed.box, rect(100, 100, 800, 600));
  });

  test("objectFitRect: fill, contain, cover, none, scale-down and object-position", () => {
    const box: Size = { w: 400, h: 400 };
    const natural: Size = { w: 800, h: 400 };
    assert.deepEqual(objectFitRect(box, natural, null, "fill", "50% 50%"), rect(0, 0, 400, 400));
    assert.deepEqual(objectFitRect(box, natural, null, "contain", "50% 50%"), rect(0, 100, 400, 200));
    assert.deepEqual(objectFitRect(box, natural, null, "contain", "0% 0%"), rect(0, 0, 400, 200));
    assert.deepEqual(objectFitRect(box, natural, null, "cover", "50% 50%"), rect(-200, 0, 800, 400));
    assert.deepEqual(
      objectFitRect(box, natural, { w: 200, h: 100 }, "none", "50% 50%"),
      rect(100, 150, 200, 100),
    );
    assert.deepEqual(
      objectFitRect(box, natural, { w: 200, h: 100 }, "scale-down", "50% 50%"),
      rect(100, 150, 200, 100),
    );
    assert.deepEqual(
      objectFitRect(box, natural, { w: 1600, h: 800 }, "scale-down", "50% 50%"),
      rect(0, 100, 400, 200),
    );
    assert.deepEqual(objectFitRect(box, { w: 0, h: 0 }, null, "contain", ""), rect(0, 0, 400, 400));
  });

  test("objectPosition: lengths, percentages and keywords in either order; anything else centres", () => {
    const at = (value: string): [number, number] => {
      const p = objectPosition(value);
      return [p.x(100), p.y(50)];
    };
    assert.deepEqual(at("50% 50%"), [50, 25]);
    assert.deepEqual(at("0px 10px"), [0, 10]);
    assert.deepEqual(at("100% 0%"), [100, 0]);
    assert.deepEqual(at("right bottom"), [100, 50]);
    assert.deepEqual(at("bottom right"), [100, 50]);
    assert.deepEqual(at("top"), [50, 0]);
    assert.deepEqual(at("left"), [0, 25]);
    assert.deepEqual(at("calc(10% + 2px) 0px"), [50, 25]);
    assert.deepEqual(at("right 10px bottom 5px"), [50, 25]);
  });

  test("naturalToCss and cssToNatural invert each other", () => {
    const m = layerMap(rect(12, -30, 900, 8640), { w: 800, h: 7680 });
    const box = b(103, 2050, 377, 2290);
    const css = naturalToCss(box, m);
    assert.deepEqual(css, {
      left: 12 + 103 * 1.125,
      top: -30 + 2050 * 1.125,
      width: 274 * 1.125,
      height: 240 * 1.125,
    });
    const back = cssToNatural(css, m);
    for (const k of ["x1", "y1", "x2", "y2"] as const) assert.ok(Math.abs(back[k] - box[k]) < 1e-9, k);
  });
});

describe("P1-10 exit: ≤ 2 CSS px against the engine geometry at reader widths 900 / 1280 / 1600", () => {
  const natural: Size = { w: 800, h: 7680 };
  const units = [
    b(64, 120, 410, 380),
    b(402, 1500, 760, 1710),
    b(0, 7400, 800, 7680),
    b(33.5, 4001.25, 99.75, 4090),
  ];
  /** Chrome keeps layout positions in LayoutUnits of 1/64 px. */
  const snap = (v: number): number => Math.round(v * 64) / 64;

  for (const viewport of [900, 1280, 1600]) {
    test(`reader width ${viewport}`, () => {
      // A centred strip 90% of the viewport wide (max 800 CSS px), 2 px border, page scrolled by 5000 px.
      const shown = Math.min(800, viewport * 0.9);
      const imageRect = rect(
        (viewport - shown) / 2 - 2,
        180 - 5000,
        shown + 4,
        (shown * natural.h) / natural.w + 4,
      );
      const content = contentRect({
        rect: imageRect,
        borderBoxWidth: shown + 4,
        border: { top: 2, right: 2, bottom: 2, left: 2 },
        padding: ZERO,
      });
      // The containing block's padding box sits at (viewport/2 - 450, 60 - 5000) on screen.
      const origin = { left: viewport / 2 - 450, top: 60 - 5000 };
      const placed = placeHost(INITIAL_BOX, rect(origin.left, origin.top, 100, 100), content);
      const hostLeft = origin.left + snap(placed.box.left);
      const hostTop = origin.top + snap(placed.box.top);
      const m = layerMap(
        objectFitRect({ w: placed.box.width, h: placed.box.height }, natural, null, "fill", "50% 50%"),
        natural,
      );
      const s = content.width / natural.w;
      for (const unit of units) {
        const expected = rect(
          content.left + unit.x1 * s,
          content.top + unit.y1 * s,
          (unit.x2 - unit.x1) * s,
          (unit.y2 - unit.y1) * s,
        );
        const local = naturalToCss(unit, m);
        const actual = rect(hostLeft + local.left, hostTop + local.top, local.width, local.height);
        assert.ok(rectMismatch(expected, actual) < 0.05, `${viewport}: ${rectMismatch(expected, actual)} px`);
        assert.ok(withinTolerance(expected, actual));
      }
    });
  }

  test("the tolerance check itself: 2 px passes, 2.5 px fails", () => {
    assert.equal(MISMATCH_TOLERANCE_PX, 2);
    const a = rect(100, 200, 50, 40);
    assert.equal(rectMismatch(a, a), 0);
    assert.equal(withinTolerance(a, rect(102, 200, 50, 40)), true);
    assert.equal(withinTolerance(a, rect(100, 200, 52.5, 40)), false, "right edge 2.5 px off");
    assert.equal(rectMismatch(a, rect(98, 201, 52, 38)), 2);
  });
});

describe("root-mode clipping", () => {
  test("clipArea: padding box minus scrollbars, scaled like the element", () => {
    assert.deepEqual(
      clipArea({
        rect: rect(0, 0, 210, 110),
        offsetWidth: 420,
        clientLeft: 10,
        clientTop: 10,
        clientWidth: 383,
        clientHeight: 200,
      }),
      rect(5, 5, 191.5, 100),
    );
  });

  test("clipInsets: none, partial, scaled, empty", () => {
    const target = rect(100, 100, 400, 1000);
    assert.equal(clipInsets(target, [], 1), null);
    assert.deepEqual(clipInsets(target, [rect(0, 0, 1000, 2000)], 1), {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    assert.deepEqual(clipInsets(target, [rect(0, 300, 1000, 400), rect(150, 0, 1000, 2000)], 1), {
      top: 200,
      right: 0,
      bottom: 400,
      left: 50,
    });
    assert.deepEqual(clipInsets(target, [rect(0, 300, 1000, 400)], 2), {
      top: 100,
      right: 0,
      bottom: 200,
      left: 0,
    });
    assert.equal(clipInsets(target, [rect(600, 0, 100, 2000)], 1), "empty");
    assert.equal(clipInsets(target, [rect(0, 0, 1000, 50)], 1), "empty");
    assert.equal(clipInsets(target, [rect(0, 0, 300, 2000), rect(320, 0, 300, 2000)], 1), "empty");
  });
});

describe("re-fit rule (B.9.2)", () => {
  test("only a scale change above 20% or a zoom change re-fits; the first plan always does", () => {
    assert.equal(REFIT_SCALE_CHANGE, 0.2);
    assert.equal(needsRefit(Number.NaN, 1, Number.NaN, 1), true);
    assert.equal(needsRefit(1, 1.19, 1, 1), false);
    assert.equal(needsRefit(1, 0.81, 1, 1), false);
    assert.equal(needsRefit(1, 1.21, 1, 1), true);
    assert.equal(needsRefit(1, 0.79, 1, 1), true);
    assert.equal(needsRefit(1, 1, 1, 1.25), true);
    assert.equal(needsRefit(1, 0, 1, 1), true);
  });
});

describe("styles (A.8 item 7, D-027)", () => {
  test("the host reset starts with all: initial and keeps the host out of hit testing", () => {
    assert.deepEqual(HOST_RESET[0], ["all", "initial"]);
    assert.deepEqual(ROOT_RESET[0], ["all", "initial"]);
    assert.ok(HOST_RESET.some(([p, v]) => p === "pointer-events" && v === "none"));
    assert.ok(ROOT_RESET.some(([p, v]) => p === "z-index" && v === ROOT_Z_INDEX));
  });

  test("the sheet loads nothing (no url(), no @import) and uses the comic stack for lines", () => {
    assert.ok(!/url\s*\(/i.test(OVERLAY_CSS));
    assert.ok(!/@import/i.test(OVERLAY_CSS));
    assert.ok(OVERLAY_CSS.includes(`font-family: ${COMIC_FONT_STACK};`));
  });

  test("only buttons, the privacy notice and the bubble popup take pointer events", () => {
    const interactive = [...OVERLAY_CSS.matchAll(/([^{}]+)\{[^{}]*pointer-events:\s*auto[^{}]*\}/g)].map(
      (m) => (m[1] ?? "").trim(),
    );
    assert.deepEqual(interactive, ["button", ".notice", ".popup"]);
  });
});
