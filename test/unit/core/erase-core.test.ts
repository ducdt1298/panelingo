import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";
import {
  ERASE,
  compositePatch,
  computeErase,
  contrastRatio,
  eraseReadBox,
  eraseUse,
  readableOn,
} from "../../../src/shared/core/erase-core.ts";
import type {
  EraseKind,
  EraseMask,
  EraseParams,
  EraseResult,
  EraseUnit,
} from "../../../src/shared/core/erase-core.ts";
import type { Box, LineType, RGB, UnitStatus } from "../../../src/shared/types.ts";

// ---------------------------------------------------------------------------------------------------------------
// Synthetic images: RGBA arrays, pseudo-glyph bars with fractional (anti-aliased) edges.

interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
type Paint = (x: number, y: number) => RGB;

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const PAGE: RGB = [200, 200, 196];

function image(w: number, h: number, paint: Paint): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      const k = (y * w + x) * 4;
      data[k] = c[0];
      data[k + 1] = c[1];
      data[k + 2] = c[2];
      data[k + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function copy(img: Img): Img {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

function px(img: Img, x: number, y: number): RGB {
  const k = (y * img.width + x) * 4;
  return [img.data[k] ?? 0, img.data[k + 1] ?? 0, img.data[k + 2] ?? 0];
}

function diff(a: RGB, b: RGB): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(
    Math.round,
  ) as unknown as RGB;
}

/** Ellipse inscribed in a box: inside when the normalised radius is ≤ 1. */
function rho(b: Box, x: number, y: number): number {
  const dx = (x + 0.5 - (b.x1 + b.x2) / 2) / ((b.x2 - b.x1) / 2);
  const dy = (y + 0.5 - (b.y1 + b.y2) / 2) / ((b.y2 - b.y1) / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

/** A bubble: `inside` within the ellipse inscribed in `bubble`, an `outline`-px dark ring, `PAGE` outside. */
function bubbleScene(w: number, h: number, bubble: Box, inside: Paint, outline = 4): Paint {
  const inner: Box = {
    x1: bubble.x1 + outline,
    y1: bubble.y1 + outline,
    x2: bubble.x2 - outline,
    y2: bubble.y2 - outline,
  };
  return (x, y) => (rho(inner, x, y) <= 1 ? inside(x, y) : rho(bubble, x, y) <= 1 ? [20, 20, 20] : PAGE);
}

/** Pseudo-glyphs: per cell a frame with a gap plus a separate tick; fractional offsets give anti-aliased edges. */
function glyphBars(x0: number, y0: number, cols: number, rows: number, g: number, stroke?: number): Box[] {
  const s = stroke ?? Math.max(1.6, 0.14 * g);
  const out: Box[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = x0 + i * 1.1 * g + 0.3;
      const y = y0 + j * 1.3 * g + 0.6;
      const v = (i + 2 * j) % 3;
      out.push({ x1: x, y1: y, x2: x + 0.8 * g, y2: y + s });
      out.push({ x1: x, y1: y, x2: x + s, y2: y + 0.9 * g });
      if (v !== 0) out.push({ x1: x + 0.8 * g - s, y1: y, x2: x + 0.8 * g, y2: y + 0.6 * g });
      out.push({ x1: x, y1: y + 0.9 * g - s, x2: x + 0.6 * g, y2: y + 0.9 * g });
      if (v !== 1) out.push({ x1: x + 0.9 * g, y1: y + 0.2 * g, x2: x + 0.9 * g + s, y2: y + 0.8 * g });
    }
  }
  return out;
}

/** Ink bounding box of float bars (integer, x2/y2 exclusive). */
function inkBox(bars: readonly Box[]): Box {
  return {
    x1: Math.floor(Math.min(...bars.map((b) => b.x1))),
    y1: Math.floor(Math.min(...bars.map((b) => b.y1))),
    x2: Math.ceil(Math.max(...bars.map((b) => b.x2))),
    y2: Math.ceil(Math.max(...bars.map((b) => b.y2))),
  };
}

/** Paints bars with area coverage (anti-aliased) and returns the coverage per pixel. */
function paintBars(img: Img, bars: readonly Box[], ink: RGB, grow = 0): Float32Array {
  const cov = new Float32Array(img.width * img.height);
  for (const raw of bars) {
    const b: Box = { x1: raw.x1 - grow, y1: raw.y1 - grow, x2: raw.x2 + grow, y2: raw.y2 + grow };
    for (let y = Math.max(0, Math.floor(b.y1)); y < Math.min(img.height, Math.ceil(b.y2)); y++) {
      for (let x = Math.max(0, Math.floor(b.x1)); x < Math.min(img.width, Math.ceil(b.x2)); x++) {
        const ow = Math.min(x + 1, b.x2) - Math.max(x, b.x1);
        const oh = Math.min(y + 1, b.y2) - Math.max(y, b.y1);
        if (ow > 0 && oh > 0) cov[y * img.width + x] = (cov[y * img.width + x] ?? 0) + ow * oh;
      }
    }
  }
  for (let i = 0; i < cov.length; i++) {
    const c = Math.min(1, cov[i] ?? 0);
    cov[i] = c;
    if (c <= 0) continue;
    const k = i * 4;
    for (let ch = 0; ch < 3; ch++)
      img.data[k + ch] = Math.round((img.data[k + ch] ?? 0) * (1 - c) + (ink[ch] ?? 0) * c);
  }
  return cov;
}

/** Anti-aliased elliptical ring (4×4 supersampling) between `inner` (ρ = 1) and `inner` grown by `t` px. */
function paintRing(
  img: Img,
  inner: Box,
  t: number,
  ink: RGB,
  keep: (angle: number) => boolean = () => true,
): Uint8Array {
  const cx = (inner.x1 + inner.x2) / 2;
  const cy = (inner.y1 + inner.y2) / 2;
  const ax = (inner.x2 - inner.x1) / 2;
  const ay = (inner.y2 - inner.y1) / 2;
  const mask = new Uint8Array(img.width * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - cx;
          const dy = y + (sy + 0.5) / 4 - cy;
          const r0 = (dx / ax) ** 2 + (dy / ay) ** 2;
          const r1 = (dx / (ax + t)) ** 2 + (dy / (ay + t)) ** 2;
          if (r0 >= 1 && r1 <= 1 && keep(Math.atan2(dy, dx))) hits++;
        }
      }
      if (hits === 0) continue;
      const c = hits / 16;
      mask[y * img.width + x] = 1;
      const k = (y * img.width + x) * 4;
      for (let ch = 0; ch < 3; ch++)
        img.data[k + ch] = Math.round((img.data[k + ch] ?? 0) * (1 - c) + (ink[ch] ?? 0) * c);
    }
  }
  return mask;
}

function crop(img: Img, b: Box): Img {
  if (b.x2 <= b.x1 || b.y2 <= b.y1) return { width: 0, height: 0, data: new Uint8ClampedArray(0) };
  const out: Img = {
    width: b.x2 - b.x1,
    height: b.y2 - b.y1,
    data: new Uint8ClampedArray((b.x2 - b.x1) * (b.y2 - b.y1) * 4),
  };
  for (let y = b.y1; y < b.y2; y++) {
    out.data.set(
      img.data.subarray((y * img.width + b.x1) * 4, (y * img.width + b.x2) * 4),
      (y - b.y1) * out.width * 4,
    );
  }
  return out;
}

/** Runs the erase the way the engine does: on a crop of eraseReadBox. */
function erase(img: Img, unit: EraseUnit, others: Box[] = [], opts: Partial<EraseParams> = {}): EraseResult {
  const image = { w: img.width, h: img.height };
  const rb = eraseReadBox(unit, image, opts);
  return computeErase({ pixels: crop(img, rb), origin: { x: rb.x1, y: rb.y1 }, image, unit, others }, opts);
}

function asMask(r: EraseResult): EraseMask {
  assert.equal(r.kind, "mask", `expected a mask, got ${r.kind}${r.kind === "box" ? ` (${r.reason})` : ""}`);
  return r;
}

function composite(img: Img, r: EraseMask): Img {
  const out = copy(img);
  compositePatch(out, { x: 0, y: 0 }, r);
  return out;
}

/** Largest |after − clean| over the pixels where `cov` > 0 (the glyphs). */
function residual(after: Img, clean: Img, cov: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < cov.length; i++) {
    if ((cov[i] ?? 0) <= 0) continue;
    worst = Math.max(
      worst,
      diff(
        px(after, i % after.width, Math.floor(i / after.width)),
        px(clean, i % clean.width, Math.floor(i / clean.width)),
      ),
    );
  }
  return worst;
}

/** Pixels of `mask` that differ between two images. */
function changedIn(a: Img, b: Img, mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (
      mask[i] === 1 &&
      diff(px(a, i % a.width, Math.floor(i / a.width)), px(b, i % b.width, Math.floor(i / b.width))) > 0
    )
      n++;
  }
  return n;
}

/** Smooth value noise (24-px cells, ±40 levels): a textured ground that is locally almost flat. */
const valueNoise: Paint = (x, y) => {
  const grid = (i: number, j: number): number =>
    ((Math.imul(i * 374761393 + j * 668265263, 1274126177) >>> 8) % 81) - 40;
  const fx = x / 24;
  const fy = y / 24;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const v =
    (grid(i, j) * (1 - tx) + grid(i + 1, j) * tx) * (1 - ty) +
    (grid(i, j + 1) * (1 - tx) + grid(i + 1, j + 1) * tx) * ty;
  return [210 + v, 200 + v, 190 + v].map(Math.round) as unknown as RGB;
};

const BUBBLE: Box = { x1: 10, y1: 10, x2: 350, y2: 230 };

/** White-bubble scene with 2 × 6 glyphs of 22 px; returns source, clean image, coverage and unit. */
function textScene(inside: Paint, ink: RGB, opts: { g?: number; cols?: number; rows?: number } = {}) {
  const g = opts.g ?? 22;
  const cols = opts.cols ?? 6;
  const rows = opts.rows ?? 2;
  const clean = image(360, 240, bubbleScene(360, 240, BUBBLE, inside));
  const src = copy(clean);
  const bars = glyphBars(180 - (cols * 1.1 * g) / 2, 120 - (rows * 1.3 * g) / 2, cols, rows, g);
  const cov = paintBars(src, bars, ink);
  const unit: EraseUnit = { text: inkBox(bars), bubble: BUBBLE, glyphPx: g };
  return { clean, src, cov, bars, unit };
}

// ---------------------------------------------------------------------------------------------------------------

describe("background models", () => {
  test("constant white bubble, black ink: constant model, the glyphs disappear", () => {
    const s = textScene(() => WHITE, BLACK);
    const r = asMask(erase(s.src, s.unit));
    assert.equal(r.model, "const");
    assert.deepEqual(r.bg, WHITE);
    assert.deepEqual(r.textColor, BLACK);
    assert.ok(residual(composite(s.src, r), s.clean, s.cov) <= 1);
    assert.ok(r.stats.coverage > 0.99 && r.stats.ringCoverage > 0.99);
  });

  test("mild deterministic noise (±3) on the paper still erases cleanly", () => {
    const s = textScene((x, y) => {
      const n = ((x * 7919 + y * 104729) % 7) - 3;
      return [250 + n, 248 + n, 244 + n];
    }, BLACK);
    const r = asMask(erase(s.src, s.unit));
    assert.ok(residual(composite(s.src, r), s.clean, s.cov) <= 8);
  });

  for (const dir of ["vertical", "horizontal", "diagonal"] as const) {
    test(`${dir} gradient: plane model within 3 levels`, () => {
      const top: RGB = [250, 236, 200];
      const bottom: RGB = [214, 160, 96];
      const s = textScene(
        (x, y) => {
          const t = dir === "vertical" ? y / 239 : dir === "horizontal" ? x / 359 : (x / 359 + y / 239) / 2;
          return mix(top, bottom, t);
        },
        [30, 20, 60],
      );
      const r = asMask(erase(s.src, s.unit));
      assert.equal(r.model, "plane");
      assert.ok(residual(composite(s.src, r), s.clean, s.cov) <= 3);
    });
  }
});

describe("Otsu on the colour distance: both polarities, coloured and outlined ink", () => {
  const cases: Array<{ name: string; bg: RGB; ink: RGB; text: RGB }> = [
    { name: "white ink on dark blue", bg: [40, 53, 147], ink: [250, 250, 250], text: [250, 250, 250] },
    { name: "black ink on yellow", bg: [255, 224, 138], ink: [10, 10, 10], text: [10, 10, 10] },
    { name: "red ink on white", bg: WHITE, ink: [198, 40, 40], text: [198, 40, 40] },
    { name: "low-contrast grey ink on white (d = 65)", bg: WHITE, ink: [190, 190, 190], text: BLACK },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const s = textScene(() => c.bg, c.ink);
      const r = asMask(erase(s.src, s.unit));
      assert.ok(residual(composite(s.src, r), s.clean, s.cov) <= 2);
      assert.ok(diff(r.textColor, c.text) <= 2, `text colour ${r.textColor.join(",")}`);
    });
  }

  test("outlined lettering (white fill, 2-px black stroke) on yellow", () => {
    const bg: RGB = [255, 224, 138];
    const clean = image(
      360,
      240,
      bubbleScene(360, 240, BUBBLE, () => bg),
    );
    const src = copy(clean);
    // Fill 2.2 px + a 1.5-px stroke per side: about the ink density of the fixture's outlined lettering (frac 0.39).
    const bars = glyphBars(100, 86, 6, 2, 26, 2.2);
    const stroke = paintBars(src, bars, BLACK, 1.5);
    paintBars(src, bars, WHITE);
    const text = inkBox(
      bars.map((b) => ({ x1: b.x1 - 1.5, y1: b.y1 - 1.5, x2: b.x2 + 1.5, y2: b.y2 + 1.5 })),
    );
    const r = asMask(erase(src, { text, bubble: BUBBLE, glyphPx: 26 }));
    assert.ok(r.stats.frac > 0.25 && r.stats.frac < ERASE.maskFracMax, `ink frac ${r.stats.frac}`);
    assert.ok(residual(composite(src, r), clean, stroke) <= 2);
    assert.ok(contrastRatio(r.textColor, bg) >= ERASE.minContrast);
  });

  test("ink colour with too little contrast falls back to black or white", () => {
    const s = textScene(() => WHITE, [250, 214, 0]);
    const r = asMask(erase(s.src, s.unit));
    assert.deepEqual(r.textColor, BLACK);
  });
});

describe("outline protection", () => {
  /** Glyphs with a 3-px ring whose inner edge passes `margin` px beyond the corners of the text box. */
  function tight(margin: number, keep?: (angle: number) => boolean) {
    const clean = image(
      360,
      240,
      bubbleScene(360, 240, BUBBLE, () => WHITE),
    );
    const bars = glyphBars(120, 96, 5, 2, 20);
    const text = inkBox(bars);
    const hw = (text.x2 - text.x1) / 2 + margin;
    const hh = (text.y2 - text.y1) / 2 + margin;
    const cx = (text.x1 + text.x2) / 2;
    const cy = (text.y1 + text.y2) / 2;
    const inner: Box = {
      x1: cx - hw * Math.SQRT2,
      y1: cy - hh * Math.SQRT2,
      x2: cx + hw * Math.SQRT2,
      y2: cy + hh * Math.SQRT2,
    };
    const ring = paintRing(clean, inner, 3, [20, 20, 20], keep);
    const src = copy(clean);
    const cov = paintBars(src, bars, BLACK);
    for (let i = 0; i < cov.length; i++)
      assert.ok(!((cov[i] ?? 0) > 0 && ring[i] === 1), "fixture: ring touches a glyph");
    const bubble: Box = {
      x1: Math.floor(inner.x1 - 3),
      y1: Math.floor(inner.y1 - 3),
      x2: Math.ceil(inner.x2 + 3),
      y2: Math.ceil(inner.y2 + 3),
    };
    return { clean, src, cov, ring, unit: { text, bubble, glyphPx: 20 } satisfies EraseUnit };
  }

  test("balloon arcs crossing the window are never erased", () => {
    const s = tight(3);
    const r = asMask(erase(s.src, s.unit));
    const after = composite(s.src, r);
    assert.ok(r.stats.outlines >= 1, "the arcs reached the window");
    assert.equal(changedIn(after, s.src, s.ring), 0);
    assert.ok(residual(after, s.clean, s.cov) <= 2);
  });

  test("pieces of a dashed outline inside the window are kept (rim rule)", () => {
    const s = tight(3, (a) => Math.floor((a + Math.PI) / (Math.PI / 24)) % 2 === 0);
    const r = asMask(erase(s.src, s.unit));
    const after = composite(s.src, r);
    assert.equal(changedIn(after, s.src, s.ring), 0);
    assert.ok(residual(after, s.clean, s.cov) <= 2);
  });

  test("an outline whose contrast dips below the ink threshold is never erased (rim rule, hysteresis)", () => {
    // Like a dark outline on a blue bubble after 4:2:0 JPEG: segments alternate between strong (d ≈ 200) and weak
    // (d ≈ 80, between max(24, t/2) and t) along the arc.
    const s = tight(3);
    const cx = (s.unit.bubble.x1 + s.unit.bubble.x2) / 2;
    const cy = (s.unit.bubble.y1 + s.unit.bubble.y2) / 2;
    for (const img of [s.src, s.clean]) {
      for (let i = 0; i < s.ring.length; i++) {
        if (s.ring[i] !== 1) continue;
        const x = i % img.width;
        const y = Math.floor(i / img.width);
        const weak =
          Math.floor((Math.atan2(y + 0.5 - cy, x + 0.5 - cx) + Math.PI) / (Math.PI / 20)) % 2 === 0;
        if (weak) img.data.set([175, 175, 175], i * 4);
      }
    }
    const r = asMask(erase(s.src, s.unit));
    const after = composite(s.src, r);
    assert.equal(changedIn(after, s.src, s.ring), 0);
    assert.ok(residual(after, s.clean, s.cov) <= 2);
  });

  test("a straight panel line crossing the window of free text is kept, even where JPEG weakened it", () => {
    const clean = image(300, 200, () => WHITE);
    const bars = glyphBars(80, 70, 5, 2, 20);
    const text = inkBox(bars);
    const line = new Uint8Array(300 * 200);
    for (let y = text.y2 + 3; y < text.y2 + 6; y++) {
      for (let x = 0; x < 300; x++) {
        line[y * 300 + x] = 1;
        // 20-px strong segments (d = 235) alternate with weak ones (d = 80: above max(24, t/2), below t). Without
        // hysteresis the strong segments inside the window would be separate components and get erased.
        clean.data.set(Math.floor(x / 20) % 2 === 0 ? [20, 20, 20] : [175, 175, 175], (y * 300 + x) * 4);
      }
    }
    const src = copy(clean);
    const cov = paintBars(src, bars, BLACK);
    // The 3-px line fills 15 % of the 10-px ring, so relax the flatness guard to reach the mask pass.
    const r = asMask(erase(src, { text, bubble: null, glyphPx: 20 }, [], { ringCoverage: 0.8 }));
    const after = composite(src, r);
    assert.equal(changedIn(after, src, line), 0);
    assert.ok(residual(after, clean, cov) <= 2);
    assert.ok(r.stats.outlines >= 1);
  });

  test("a glyph merged with the outline is lost ink → plate, never a leftover stroke", () => {
    const s = tight(0.5);
    const r = erase(s.src, s.unit);
    if (r.kind === "mask") {
      // Allowed only if nothing visible stays behind.
      assert.ok(residual(composite(s.src, r), s.clean, s.cov) <= 24);
    } else {
      assert.equal(r.kind, "box", "a plate (texture or lost ink), never a mask with a leftover stroke");
    }
  });
});

describe("dilation and feather", () => {
  test("alpha 255 within r (Chebyshev) of the ink, 128 one pixel further, 0 beyond", () => {
    const clean = image(200, 160, () => WHITE);
    const src = copy(clean);
    const block: Box = { x1: 97, y1: 77, x2: 103, y2: 83 };
    for (let y = block.y1; y < block.y2; y++)
      for (let x = block.x1; x < block.x2; x++) src.data.set([0, 0, 0], (y * 200 + x) * 4);
    const r = asMask(erase(src, { text: block, bubble: null, glyphPx: 30 }));
    const rad = Math.min(ERASE.dilateMax, Math.max(ERASE.dilateMin, Math.round(ERASE.dilateFrac * 30)));
    assert.equal(r.stats.dilateR, rad);
    for (let y = 60; y < 100; y++) {
      for (let x = 80; x < 120; x++) {
        const dist = Math.max(block.x1 - x, x - (block.x2 - 1), block.y1 - y, y - (block.y2 - 1), 0);
        const inside = x >= r.rect.x1 && x < r.rect.x2 && y >= r.rect.y1 && y < r.rect.y2;
        const a = inside
          ? (r.patch.data[((y - r.rect.y1) * r.patch.width + (x - r.rect.x1)) * 4 + 3] ?? 0)
          : 0;
        const want = dist <= rad ? 255 : dist === rad + 1 ? 128 : 0;
        assert.equal(a, want, `alpha at ${x},${y} (distance ${dist})`);
      }
    }
    assert.deepEqual(r.rect, {
      x1: block.x1 - rad - 1,
      y1: block.y1 - rad - 1,
      x2: block.x2 + rad + 1,
      y2: block.y2 + rad + 1,
    });
  });

  test("the dilation radius follows glyphPx within [2, 5]", () => {
    for (const [g, want] of [
      [10, 2],
      [24, 2],
      [30, 3],
      [44, 4],
      [90, 5],
    ] as const) {
      const s = textScene(() => WHITE, BLACK, { g: 22 });
      const r = asMask(erase(s.src, { ...s.unit, glyphPx: g }));
      assert.equal(r.stats.dilateR, want, `glyphPx ${g}`);
    }
  });

  test("small glyphs (10 px, 1.6-px strokes) are erased cleanly with the minimum radius", () => {
    const s = textScene(() => WHITE, [30, 30, 30], { g: 10, cols: 10, rows: 3 });
    const r = asMask(erase(s.src, s.unit));
    assert.equal(r.stats.dilateR, ERASE.dilateMin);
    assert.ok(residual(composite(s.src, r), s.clean, s.cov) <= 2);
  });

  test("compositePatch blends straight alpha over the target", () => {
    const target: Img = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255]),
    };
    const scene = textScene(() => WHITE, BLACK);
    const patch: EraseMask = {
      kind: "mask",
      rect: { x1: 5, y1: 3, x2: 7, y2: 4 },
      bg: WHITE,
      textColor: BLACK,
      model: "const",
      patch: { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 200, 0, 0, 128]) },
      stats: asMask(erase(scene.src, scene.unit)).stats,
    };
    compositePatch(target, { x: 5, y: 3 }, patch);
    assert.deepEqual(
      [...target.data],
      [255, 255, 255, 255, Math.round((200 * 128 + 100 * 127) / 255), 50, 50, 255],
    );
  });
});

describe("guards", () => {
  test("no ink in the text box → none (translation only)", () => {
    const clean = image(
      360,
      240,
      bubbleScene(360, 240, BUBBLE, () => WHITE),
    );
    const r = erase(clean, { text: { x1: 140, y1: 100, x2: 220, y2: 140 }, bubble: BUBBLE, glyphPx: 20 });
    assert.equal(r.kind, "none");
    assert.deepEqual(r.rect, { x1: 140, y1: 100, x2: 220, y2: 140 });
  });

  test("screentone → plate (texture), even when the sample stride matches the tone period", () => {
    const tone: Paint = (x, y) => {
      const dx = (x % 6) + 0.5 - 3;
      const dy = (y % 6) + 0.5 - 3;
      return dx * dx + dy * dy <= 2.25 ? [60, 60, 60] : [252, 252, 250];
    };
    for (const g of [18, 22, 26]) {
      const s = textScene(tone, BLACK, { g });
      const r = erase(s.src, s.unit);
      assert.equal(r.kind, "box", `glyph ${g}`);
      if (r.kind === "box") {
        assert.equal(r.reason, "texture");
        assert.ok(r.bg !== null && diff(r.bg, [252, 252, 250]) <= 8, "plate tinted with the paper colour");
      }
    }
  });

  test("smooth value noise → plate (texture)", () => {
    const s = textScene(valueNoise, BLACK);
    const r = erase(s.src, s.unit);
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "texture");
  });

  test("transparent pixels → plate", () => {
    const s = textScene(() => WHITE, BLACK);
    s.src.data[(130 * 360 + 120) * 4 + 3] = 128;
    const r = erase(s.src, s.unit);
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "transparent");
  });

  test("no room for background samples → plate", () => {
    const img = image(40, 30, () => WHITE);
    const r = erase(img, { text: { x1: 2, y1: 2, x2: 38, y2: 28 }, bubble: null, glyphPx: 12 });
    assert.equal(r.kind, "box");
    if (r.kind === "box") {
      assert.equal(r.reason, "samples");
      assert.equal(r.bg, null);
      assert.deepEqual(r.textColor, BLACK);
    }
  });

  test("text box outside the image or mostly outside the bubble → plate (region)", () => {
    const s = textScene(() => WHITE, BLACK);
    const away: EraseUnit = { text: { x1: 400, y1: 10, x2: 450, y2: 40 }, bubble: null, glyphPx: 20 };
    assert.deepEqual(
      eraseReadBox(away, { w: 360, h: 240 }),
      { x1: 360, y1: 0, x2: 360, y2: 0 },
      "zero-sized",
    );
    const outside = erase(s.src, away);
    assert.equal(outside.kind, "box");
    if (outside.kind === "box") assert.equal(outside.reason, "region");
    const offBubble = erase(s.src, { ...s.unit, bubble: { x1: 0, y1: 0, x2: s.unit.text.x1 + 10, y2: 240 } });
    assert.equal(offBubble.kind, "box");
    if (offBubble.kind === "box") assert.equal(offBubble.reason, "region");
  });

  test("ink running out of the erasable area → plate (lost ink)", () => {
    const clean = image(360, 240, () => WHITE);
    const src = copy(clean);
    const bars = glyphBars(120, 100, 5, 1, 22);
    bars.push({ x1: 95, y1: 100, x2: 125, y2: 125 }); // a blob straddling the bubble inset
    paintBars(src, bars, BLACK);
    const bubble: Box = { x1: 92, y1: 40, x2: 300, y2: 200 }; // inset 3 % → x from ~98
    const r = erase(src, { text: inkBox(bars), bubble, glyphPx: 22 });
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "lost-ink");
    assert.ok(r.stats.rounds === 2, "R grew once before giving up");
  });

  test("a solid block filling most of R → plate (mask-frac)", () => {
    const clean = image(300, 200, () => WHITE);
    const src = copy(clean);
    paintBars(src, [{ x1: 100, y1: 70, x2: 190, y2: 120 }], BLACK);
    const r = erase(src, { text: { x1: 100, y1: 70, x2: 190, y2: 120 }, bubble: null, glyphPx: 40 });
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "mask-frac");
  });

  test("Otsu separability below etaMin → plate (eta)", () => {
    const s = textScene(() => WHITE, BLACK);
    const r = erase(s.src, s.unit, [], { etaMin: 0.999 });
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "eta");
  });

  test("other units' text is never sampled or erased", () => {
    const clean = image(360, 240, () => WHITE);
    const src = copy(clean);
    const a = glyphBars(60, 100, 4, 1, 22);
    const b = glyphBars(60 + 4 * 1.1 * 22 + 8, 100, 4, 1, 22); // 8 px to the right of unit A
    paintBars(src, a, BLACK);
    const covB = paintBars(src, b, [200, 0, 0]);
    const textA = inkBox(a);
    const textB = inkBox(b);
    const r = asMask(erase(src, { text: textA, bubble: null, glyphPx: 22 }, [textB]));
    const after = composite(src, r);
    const maskB = new Uint8Array(covB.length);
    for (let i = 0; i < covB.length; i++) maskB[i] = (covB[i] ?? 0) > 0 ? 1 : 0;
    assert.equal(changedIn(after, src, maskB), 0);
  });
});

describe("captions, overlapping units, ink beyond the bubble inset (RND-01 review)", () => {
  /**
   * A webtoon-style caption: a 3-px rectangular border whose inner edge lies `margin` px from the text box (the ends
   * of every line sit on the inscribed ellipse's rim). Returns the scene and the border mask.
   */
  function captionScene(inside: Paint, margin = 6, extra: readonly Box[] = []) {
    const bars = glyphBars(60, 60, 8, 2, 22);
    const text = inkBox(bars);
    const bubble: Box = {
      x1: text.x1 - margin - 3,
      y1: text.y1 - margin - 3,
      x2: text.x2 + margin + 3,
      y2: text.y2 + margin + 3,
    };
    const onBorder = (x: number, y: number): boolean =>
      x >= bubble.x1 &&
      x < bubble.x2 &&
      y >= bubble.y1 &&
      y < bubble.y2 &&
      (x < bubble.x1 + 3 || x >= bubble.x2 - 3 || y < bubble.y1 + 3 || y >= bubble.y2 - 3);
    const inBubble = (x: number, y: number): boolean =>
      x >= bubble.x1 && x < bubble.x2 && y >= bubble.y1 && y < bubble.y2;
    const clean = image(360, 200, (x, y) =>
      onBorder(x, y) ? [20, 20, 20] : inBubble(x, y) ? inside(x, y) : PAGE,
    );
    const border = new Uint8Array(360 * 200);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 360; x++) border[y * 360 + x] = onBorder(x, y) ? 1 : 0;
    const src = copy(clean);
    const cov = paintBars(src, [...bars, ...extra], BLACK);
    return { clean, src, cov, text, bubble, border };
  }

  test("text filling a rect caption is sampled in the erasable rectangle (B §B.8 step 2) and erased cleanly", () => {
    const s = captionScene(() => WHITE);
    const r = asMask(erase(s.src, { text: s.text, bubble: s.bubble, glyphPx: 22 }));
    assert.equal(r.stats.rectLike, true);
    assert.ok(r.stats.ringShare < ERASE.ringShareMin, `ring share ${r.stats.ringShare}`);
    const after = composite(s.src, r);
    assert.ok(residual(after, s.clean, s.cov) <= 2);
    assert.equal(changedIn(after, s.src, s.border), 0);
  });

  test("smooth noise inside a caption → plate, although the ellipse sees only slivers of the ring", () => {
    // Before the rect-like mode the samples and the ring sat in the middle of the four sides, where the noise
    // looked flat, and a smooth patch went over the textured ground (residual and damage on the RND-01 caption set).
    const s = captionScene(valueNoise);
    const r = erase(s.src, { text: s.text, bubble: s.bubble, glyphPx: 22 });
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "texture");
  });

  test("a glyph fragment just outside a too-tight text box on the caption rim → plate, never left behind", () => {
    // A period 3 px right of the last glyph (ink ends at x 252.6); the detector box stops just short of it. Not cut,
    // on the rim, no ink in the text box: a dash of a broken outline or a missed glyph? It lies inside R, so
    // neither erasing nor keeping it is safe. (Before the fix: a mask that left the period visible.)
    const period: Box = { x1: 256.4, y1: 104.6, x2: 259.4, y2: 108.6 };
    const s = captionScene(() => WHITE, 14, [period]);
    assert.equal(s.text.x2, 253, "fixture: last glyph column");
    const r = erase(s.src, { text: { ...s.text, x2: 256 }, bubble: s.bubble, glyphPx: 22 });
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "lost-ink");
    assert.ok(r.stats.ambiguous >= 1);
    // The plate hides the period too (text box + 0.15 × glyphPx alone ends at x 259, the period reaches x 259.4).
    assert.ok(r.rect.x2 >= 260, `plate ends at x ${r.rect.x2}`);
    // With a text box that includes it, the period is text and is erased with the rest.
    const full = asMask(erase(s.src, { text: { ...s.text, x2: 260 }, bubble: s.bubble, glyphPx: 22 }));
    const after = composite(s.src, full);
    assert.ok(residual(after, s.clean, s.cov) <= 2);
    assert.equal(changedIn(after, s.src, s.border), 0);
  });

  test("a period that touches the bubble inset is lost ink → plate, not a mask that leaves it", () => {
    // Same period, caption margin 12: the 3 % inset ends 1 px right of it, the 3×3 closing joins it to the
    // non-erasable cells, so it is cut, rim-like and kept. Its ~11 ink px stayed under the old 0.05 × glyphPx²
    // (24 px) residue cap: a mask with a visible period (~0.7 % residual, RND-01 allows 0.3 %).
    const period: Box = { x1: 256.4, y1: 104.6, x2: 259.4, y2: 108.6 };
    const s = captionScene(() => WHITE, 12, [period]);
    const r = erase(s.src, { text: { ...s.text, x2: 260 }, bubble: s.bubble, glyphPx: 22 });
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "lost-ink");
    assert.ok(r.stats.lostPx > 0 && r.stats.lostPx <= 0.05 * 22 * 22, `lost ${r.stats.lostPx} px`);
    assert.ok(r.stats.lostInk <= ERASE.lostInkMax, "under the 5 % ratio: only the residue cap catches it");
  });

  test("glyphs inside the text box but beyond the bubble inset are lost ink → plate", () => {
    // The detector's bubble box ends at x 268 and its 3 % inset at x 260; the glyphs end at 251.6 but the text box
    // also holds a "!" at x 262-265, wholly in the inset band where nothing is erasable. Before the fix nothing
    // counted that ink: a mask erased the glyphs and left the "!" under the translation.
    const s = textScene(() => WHITE, BLACK);
    const bang: Box[] = [
      { x1: 262.3, y1: 95, x2: 265.3, y2: 128 },
      { x1: 262.3, y1: 133, x2: 265.3, y2: 137 },
    ];
    paintBars(s.src, bang, BLACK);
    const r = erase(s.src, {
      text: inkBox([...s.bars, ...bang]),
      bubble: { ...BUBBLE, x2: 268 },
      glyphPx: 22,
    });
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "lost-ink");
    assert.ok(r.stats.inkBeyond > 0.05 * 22 * 22, `ink beyond ${r.stats.inkBeyond}`);
  });

  test("an 'other' box that duplicates the unit's own text box does not hide its ink (mask, not none)", () => {
    const s = textScene(() => WHITE, BLACK);
    const r = asMask(erase(s.src, s.unit, [{ ...s.unit.text }]));
    assert.ok(residual(composite(s.src, r), s.clean, s.cov) <= 2);
  });

  test("no ring left to check flatness on (other units all around R) → plate (samples)", () => {
    const s = textScene(() => WHITE, BLACK);
    const t = s.unit.text;
    const pad = Math.max(ERASE.padPx, Math.round(ERASE.padFrac * Math.min(t.x2 - t.x1, t.y2 - t.y1)));
    // Boxes 2 * pad .. pad + ringPx beyond the text: grown by pad for the sample exclusion they cover the whole ring.
    const a = 2 * pad;
    const b = pad + ERASE.ringPx;
    const frame: Box[] = [
      { x1: t.x1 - b, y1: t.y1 - b, x2: t.x2 + b, y2: t.y1 - a },
      { x1: t.x1 - b, y1: t.y2 + a, x2: t.x2 + b, y2: t.y2 + b },
      { x1: t.x1 - b, y1: t.y1 - a, x2: t.x1 - a, y2: t.y2 + a },
      { x1: t.x2 + a, y1: t.y1 - a, x2: t.x2 + b, y2: t.y2 + a },
    ];
    const r = erase(s.src, s.unit, frame);
    assert.equal(r.kind, "box");
    if (r.kind === "box") assert.equal(r.reason, "samples");
    assert.ok(r.stats.samples >= ERASE.minSamples, "the samples further out were enough");
  });
});

describe("determinism and placement", () => {
  test("same input → identical result; full image and read-box crop agree", () => {
    const s = textScene(() => [255, 224, 138], [198, 40, 40]);
    const a = erase(s.src, s.unit);
    const b = erase(s.src, s.unit);
    assert.deepEqual(a, b);
    const full = computeErase({
      pixels: s.src,
      origin: { x: 0, y: 0 },
      image: { w: 360, h: 240 },
      unit: s.unit,
    });
    assert.deepEqual(full, a);
  });

  test("the read box covers the regrowth window and the samples", () => {
    const unit: EraseUnit = { text: { x1: 100, y1: 100, x2: 200, y2: 140 }, bubble: null, glyphPx: 20 };
    const rb = eraseReadBox(unit, { w: 1000, h: 1000 });
    const pad = Math.max(ERASE.padPx, Math.round(ERASE.padFrac * 40));
    assert.ok(rb.x1 <= 100 - 2 * pad - 4 && rb.x2 >= 200 + 2 * pad + 4);
    assert.ok(rb.y1 <= 100 - pad - ERASE.ringPx && rb.y2 >= 140 + pad + ERASE.ringPx);
    assert.deepEqual(eraseReadBox({ ...unit, text: { x1: 0, y1: 0, x2: 30, y2: 20 } }, { w: 40, h: 30 }), {
      x1: 0,
      y1: 0,
      x2: 40,
      y2: 30,
    });
  });

  test("invalid input throws", () => {
    const img = image(10, 10, () => WHITE);
    const unit: EraseUnit = { text: { x1: 2, y1: 2, x2: 8, y2: 8 }, bubble: null, glyphPx: 6 };
    assert.throws(
      () => computeErase({ pixels: img, origin: { x: 0.5, y: 0 }, image: { w: 10, h: 10 }, unit }),
      RangeError,
    );
    assert.throws(
      () =>
        computeErase({
          pixels: { width: 10, height: 10, data: new Uint8ClampedArray(10) },
          origin: { x: 0, y: 0 },
          image: { w: 10, h: 10 },
          unit,
        }),
      RangeError,
    );
    assert.throws(
      () => computeErase({ pixels: img, origin: { x: 0, y: 0 }, image: { w: 0, h: 10 }, unit }),
      RangeError,
    );
  });

  test("timing sanity: a 300×200 unit (informative; budget 10 ms p90 in Chrome)", () => {
    const clean = image(420, 300, () => WHITE);
    const src = copy(clean);
    const bars = glyphBars(60, 50, 12, 7, 22);
    paintBars(src, bars, BLACK);
    const unit: EraseUnit = { text: inkBox(bars), bubble: { x1: 5, y1: 5, x2: 415, y2: 295 }, glyphPx: 22 };
    for (let i = 0; i < 5; i++) erase(src, unit); // warm-up
    const ms: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      asMask(erase(src, unit));
      ms.push(performance.now() - t0);
    }
    ms.sort((x, y) => x - y);
    const p90 = ms[Math.ceil(0.9 * ms.length) - 1] ?? Infinity;
    console.log(`erase 300×200 unit: p50 ${ms[15]?.toFixed(2)} ms, p90 ${p90.toFixed(2)} ms`);
    // Coverage instrumentation (npm run test:cov sets NODE_V8_COVERAGE) runs this code ~8× slower, more under the
    // load of every other test file, so the guard scales with it instead of flaking the coverage gate.
    const limitMs = process.env["NODE_V8_COVERAGE"] === undefined ? 200 : 2_000;
    assert.ok(
      p90 < limitMs,
      `far beyond the budget (p90 ${p90.toFixed(1)} ms ≥ ${limitMs} ms): something regressed`,
    );
  });
});

describe("render policy and colour helpers", () => {
  test("never erase or cover without a valid translation; SFX get a label by default", () => {
    const table: Array<[LineType, UnitStatus, EraseKind, boolean, string]> = [
      ["dialogue", "ok", "mask", false, "patch"],
      ["dialogue", "manual", "box", false, "plate"],
      ["narration", "ok", "none", false, "text"],
      ["dialogue", "refused", "mask", false, "nothing"],
      ["dialogue", "keep-original", "mask", false, "nothing"],
      ["dialogue", "untranslated", "mask", false, "nothing"],
      ["dialogue", "pending", "mask", false, "nothing"],
      ["dialogue", "error", "mask", false, "nothing"],
      ["ignore", "ok", "mask", false, "nothing"],
      ["sfx", "ok", "mask", false, "label"],
      ["sfx", "ok", "mask", true, "patch"],
      ["sfx", "ok", "box", true, "label"],
    ];
    for (const [type, status, kind, eraseSfx, want] of table) {
      assert.equal(eraseUse(type, status, kind, eraseSfx), want, `${type}/${status}/${kind}/${eraseSfx}`);
    }
  });

  test("WCAG contrast", () => {
    assert.ok(Math.abs(contrastRatio(BLACK, WHITE) - 21) < 1e-9);
    assert.equal(contrastRatio([90, 90, 90], [90, 90, 90]), 1);
    assert.deepEqual(readableOn(WHITE), BLACK);
    assert.deepEqual(readableOn([40, 53, 147]), WHITE);
  });
});
