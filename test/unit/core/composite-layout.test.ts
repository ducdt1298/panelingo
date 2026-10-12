import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMP,
  badgeWidth,
  headerMinWidth,
  layoutComposite,
  paletteColor,
} from "../../../src/shared/core/composite-layout.ts";
import type {
  CompositeLayout,
  CropSpec,
  Mark,
  ModelProfileLike,
  Segment,
} from "../../../src/shared/core/composite-layout.ts";
import type { ModelProfile } from "../../../src/shared/core/model-profile.ts";
import { height, inter, width } from "../../../src/shared/geometry.ts";
import type { Box, ReadingDir, Script } from "../../../src/shared/types.ts";

// Compile-time contract: core/model-profile.ts profiles can be passed straight to layoutComposite.
type Assert<T extends true> = T;
export type _ProfileFits = Assert<ModelProfile extends ModelProfileLike ? true : false>;

const GLYPHS = {
  glyphTarget: { hangul: 30, cjk: 32, latin: 22 },
  glyphMin: { hangul: 20, cjk: 22, latin: 14 },
} as const;
/** Mirrors core/model-profile.ts gpt52 / gemini25: 2048×768, then 2048×1152. */
const DENSE: ModelProfileLike = {
  canvas: [
    { W: 2048, H: 768 },
    { W: 2048, H: 1152 },
  ],
  ...GLYPHS,
};
/** Mirrors core/model-profile.ts gpt4o / default: 2048×768 only. */
const BASIC: ModelProfileLike = { canvas: [{ W: 2048, H: 768 }], ...GLYPHS };

interface UnitSpec {
  image: number;
  text: Box;
  glyph?: number;
  script?: Script;
  ghost?: true;
}

interface Pack {
  segs: Segment[];
  marks: Mark[];
  crops: CropSpec[];
}

function nth<T>(items: readonly T[], i: number): T {
  const item = items[i];
  assert.ok(item !== undefined, `missing item ${i}`);
  return item;
}

function bx(x1: number, y1: number, x2: number, y2: number): Box {
  return { x1, y1, x2, y2 };
}

/** Units are numbered 1..N in the given order; ghosts get no number and no crop. */
function makePack(
  images: ReadonlyArray<{ w: number; h: number }>,
  units: UnitSpec[],
  kind: Segment["kind"],
): Pack {
  const segs = images.map((im, i) => ({
    imageId: `img${i}`,
    kind,
    src: bx(0, 0, im.w, im.h),
    imgW: im.w,
    imgH: im.h,
  }));
  const marks: Mark[] = [];
  const crops: CropSpec[] = [];
  let n = 0;
  for (const u of units) {
    if (u.ghost === true) {
      marks.push({ n: 0, segment: u.image, text: u.text, ghost: true });
      continue;
    }
    n++;
    const im = nth(images, u.image);
    marks.push({ n, segment: u.image, text: u.text });
    crops.push({
      n,
      imageId: `img${u.image}`,
      text: u.text,
      bounds: { w: im.w, h: im.h },
      glyphPx: u.glyph ?? 24,
      script: u.script ?? "hangul",
    });
  }
  return { segs, marks, crops };
}

function layout(p: Pack, prof: ModelProfileLike = DENSE, dir: ReadingDir = "ltr"): CompositeLayout {
  return layoutComposite(p.segs, p.marks, p.crops, prof, dir, "full");
}

function inside(b: Box, outer: Box): boolean {
  return b.x1 >= outer.x1 && b.y1 >= outer.y1 && b.x2 <= outer.x2 && b.y2 <= outer.y2;
}

function assertDisjoint(boxes: readonly Box[], what: string): void {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.equal(inter(nth(boxes, i), nth(boxes, j)), 0, `${what} ${i} and ${j} overlap`);
    }
  }
}

/** Geometry every rendered layout must satisfy. */
function assertInvariants(l: CompositeLayout): void {
  const canvas = bx(0, 0, l.W, l.H);
  const rects: Array<[string, Box]> = [
    ...l.context.map((c): [string, Box] => ["context", c.dst]),
    ...l.marks.flatMap((m): Array<[string, Box]> => [
      ["frame", m.frame],
      ["badge", m.badge],
    ]),
    ...l.ghosts.map((g): [string, Box] => ["ghost", g.frame]),
    ...l.crops.flatMap((c): Array<[string, Box]> => [
      ["cell", c.cell],
      ["header", c.header],
      ["crop", c.dst],
    ]),
  ];
  if (l.separator !== null) rects.push(["separator", l.separator]);
  for (const [what, b] of rects) {
    assert.ok(inside(b, canvas), `${what} ${JSON.stringify(b)} is outside ${l.W}x${l.H}`);
    assert.ok(width(b) > 0 && height(b) > 0, `${what} ${JSON.stringify(b)} is empty`);
  }

  for (const c of l.crops) {
    assert.ok(inside(c.cell, l.cropArea), `cell #${c.n} is outside the crop area`);
    assert.deepEqual(c.header, bx(c.cell.x1, c.cell.y1, c.cell.x2, c.cell.y1 + COMP.headerH));
    assert.ok(inside(c.dst, c.cell) && c.dst.y1 >= c.header.y2 + COMP.border, `crop #${c.n} leaves its cell`);
    assert.ok(width(c.cell) >= headerMinWidth(c.n), `cell #${c.n} is too narrow for its label`);
  }
  assertDisjoint(
    l.crops.map((c) => c.cell),
    "crop cells",
  );
  assertDisjoint(
    l.context.map((c) => c.dst),
    "thumbnails",
  );
  assertDisjoint(
    l.marks.map((m) => m.badge),
    "badges",
  );

  const texts = [...l.marks.map((m) => m.text), ...l.ghosts.map((g) => g.text)];
  for (const m of l.marks) {
    for (const t of texts) assert.equal(inter(m.badge, t), 0, `badge ${m.n} covers a text box`);
    assert.equal(height(m.badge), COMP.badgeH);
    assert.equal(width(m.badge), badgeWidth(m.n));
    assert.equal(m.color, paletteColor(m.n));
    if (l.separator !== null) assert.ok(m.badge.x2 <= l.separator.x1, `badge ${m.n} crosses the separator`);
  }
  for (const c of l.context) {
    assert.ok(c.scale <= 1, "thumbnails are never upscaled");
    assert.ok(
      width(c.dst) <= width(c.src) && height(c.dst) <= height(c.src),
      "thumbnails are never upscaled",
    );
    if (l.separator !== null) assert.ok(c.dst.x2 <= l.separator.x1 - COMP.pad);
  }
  if (l.separator !== null) assert.equal(l.cropArea.x1, l.separator.x2 + COMP.gap);
  if (l.ok) {
    for (const c of l.crops) {
      assert.ok(
        c.effGlyph >= Math.min(GLYPHS.glyphMin[c.script], c.effGlyph / l.g) - 1e-9,
        `crop #${c.n} is below the glyph floor`,
      );
    }
  }
}

/** Three 800×2000 KO strip images with three bubbles each. */
function webtoonPack(): Pack {
  const images = [
    { w: 800, h: 2000 },
    { w: 800, h: 2000 },
    { w: 800, h: 2000 },
  ];
  const rows = [bx(80, 260, 420, 400), bx(380, 900, 720, 1080), bx(120, 1500, 470, 1610)];
  const units = images.flatMap((_, image) => rows.map((text) => ({ image, text, glyph: 24 })));
  return makePack(images, units, "band");
}

test("webtoon pack: every rectangle stays inside the canvas, crops and badges never overlap", () => {
  const l = layout(webtoonPack());
  assert.equal(l.ok, true, String(l.reason));
  assert.equal(l.reason, null);
  assert.equal(l.canvasIndex, 0);
  assert.deepEqual([l.W, l.H, l.mode, l.fits], [2048, 768, "full", true]);
  assert.equal(l.context.length, 3);
  assert.deepEqual(
    l.marks.map((m) => m.n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(
    l.crops.map((c) => [c.n, c.orig, c.source]),
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, n, `img${Math.floor((n - 1) / 3)}`]),
  );
  assertInvariants(l);
  for (const m of l.marks) assert.equal(inter(m.badge, m.frame), 0, `badge ${m.n} sits on its frame`);
  assert.ok(l.minEffGlyph >= GLYPHS.glyphMin.hangul, `min glyph ${l.minEffGlyph}`);
});

test("frames are the text boxes mapped onto the thumbnail and inflated by 3 px", () => {
  const p = makePack([{ w: 800, h: 2000 }], [{ image: 0, text: bx(200, 600, 500, 700) }], "band");
  const l = layout(p);
  const ctx = nth(l.context, 0);
  const sx = width(ctx.dst) / width(ctx.src);
  const sy = height(ctx.dst) / height(ctx.src);
  const m = nth(l.marks, 0);
  assert.ok(Math.abs(m.text.x1 - (ctx.dst.x1 + (200 - ctx.src.x1) * sx)) <= 1);
  assert.ok(Math.abs(m.text.y1 - (ctx.dst.y1 + (600 - ctx.src.y1) * sy)) <= 1);
  assert.ok(Math.abs(width(m.text) - 300 * sx) <= 2);
  assert.ok(Math.abs(height(m.text) - 100 * sy) <= 2);
  assert.deepEqual(m.frame, bx(m.text.x1 - 3, m.text.y1 - 3, m.text.x2 + 3, m.text.y2 + 3));
});

test("golden: one page, two units, worked out by hand from the B.4.4 constants", () => {
  const p = makePack(
    [{ w: 1000, h: 1420 }],
    [
      { image: 0, text: bx(100, 100, 400, 300) },
      { image: 0, text: bx(500, 900, 800, 1100) },
    ],
    "page",
  );
  const l = layout(p, BASIC);
  assert.deepEqual([l.ok, l.reason, l.W, l.H, l.g, l.minEffGlyph], [true, null, 2048, 768, 1, 30]);
  // Context: Wc = floor(0.30·2048) = 614, Hc = 768 − 16 = 752, s = min(614/1000, 752/1420) = 0.5296;
  // the 529×752 thumbnail sits at (pad, pad); the 4-px separator follows at 2·pad + 529.
  const s = 752 / 1420;
  assert.deepEqual(l.context, [
    { segment: 0, imageId: "img0", src: bx(0, 0, 1000, 1420), dst: bx(8, 8, 537, 760), scale: s },
  ]);
  assert.deepEqual(l.separator, bx(545, 0, 549, 768));
  assert.deepEqual(l.cropArea, bx(557, 8, 2040, 760));
  // Marks: text·(529/1000, 752/1420) + 8, rounded outward; frame = text + 3; ltr badge = top-left, 2 px above.
  assert.deepEqual(
    l.marks.map((m) => [m.n, m.text, m.frame, m.badge, m.color]),
    [
      [1, bx(60, 60, 220, 167), bx(57, 57, 223, 170), bx(57, 27, 85, 55), "#D32F2F"],
      [2, bx(272, 484, 432, 591), bx(269, 481, 435, 594), bx(269, 451, 297, 479), "#1976D2"],
    ],
  );
  // Crops: text + max(6, 0.3·24) = 7.2 px, rounded outward (316×216); k = 30/24 = 1.25 → 395×270 images in
  // 399×302 cells (2-px border, 28-px header), shelf-packed from the crop area's corner, 8 px apart.
  assert.deepEqual(
    l.crops.map((c) => [c.n, c.src, c.cell, c.header, c.dst, c.scale, c.effGlyph]),
    [
      [1, bx(92, 92, 408, 308), bx(557, 8, 956, 310), bx(557, 8, 956, 36), bx(559, 38, 954, 308), 1.25, 30],
      [
        2,
        bx(492, 892, 808, 1108),
        bx(964, 8, 1363, 310),
        bx(964, 8, 1363, 36),
        bx(966, 38, 1361, 308),
        1.25,
        30,
      ],
    ],
  );
});

test("band context spans the units ± 0.15·image width at full image width", () => {
  const p = makePack(
    [{ w: 800, h: 3000 }],
    [
      { image: 0, text: bx(100, 1000, 400, 1100) },
      { image: 0, text: bx(300, 1400, 700, 1500) },
    ],
    "band",
  );
  assert.deepEqual(nth(layout(p).context, 0).src, bx(0, 880, 800, 1620));
  const top = makePack([{ w: 800, h: 3000 }], [{ image: 0, text: bx(100, 50, 400, 150) }], "band");
  assert.deepEqual(nth(layout(top).context, 0).src, bx(0, 0, 800, 270));
});

test("crops reach the glyph target when space allows and report minEffGlyph", () => {
  const p = makePack(
    [{ w: 1000, h: 1400 }],
    [
      { image: 0, text: bx(100, 200, 300, 260), glyph: 15, script: "hangul" },
      { image: 0, text: bx(500, 200, 800, 240), glyph: 11, script: "latin" },
      { image: 0, text: bx(100, 600, 220, 760), glyph: 16, script: "cjk" },
    ],
    "page",
  );
  const l = layout(p);
  assert.equal(l.ok, true);
  assert.equal(l.g, 1);
  assert.deepEqual(
    l.crops.map((c) => c.effGlyph),
    [30, 22, 32],
  );
  assert.equal(l.minEffGlyph, 22);
  const c1 = nth(l.crops, 0);
  // text inflated by max(6, 0.3·15) = 6, then enlarged k = 30/15 = 2
  assert.deepEqual(c1.src, bx(94, 194, 306, 266));
  assert.deepEqual([width(c1.dst), height(c1.dst), c1.scale], [424, 144, 2]);
  // inflation grows with the glyph: max(6, 0.3·16) = 6 → still 6; 0.3·40 = 12 for big glyphs
  const big = makePack(
    [{ w: 1000, h: 1400 }],
    [{ image: 0, text: bx(100, 100, 300, 200), glyph: 40 }],
    "page",
  );
  assert.deepEqual(nth(layout(big).crops, 0).src, bx(88, 88, 312, 212));
  assertInvariants(l);
});

test("crop scale is clamped to [0.35, 4]; tiny glyphs only need full scale", () => {
  const p = makePack(
    [{ w: 1000, h: 2000 }],
    [
      { image: 0, text: bx(100, 100, 700, 500), glyph: 200 }, // SFX lettering
      { image: 0, text: bx(100, 900, 160, 912), glyph: 4 }, // cannot reach 20 px even at k = 4
    ],
    "page",
  );
  const l = layout(p);
  assert.equal(l.ok, true, String(l.reason));
  assert.equal(l.g, 1);
  assert.deepEqual(
    l.crops.map((c) => c.scale),
    [COMP.kMin, COMP.kMax],
  );
  assert.deepEqual(
    l.crops.map((c) => c.effGlyph),
    [70, 16],
  );
  // The same crop source next to the edge of its image is clipped to the image.
  const edge = makePack(
    [{ w: 1000, h: 2000 }],
    [{ image: 0, text: bx(0, 1990, 300, 2000), glyph: 20 }],
    "page",
  );
  assert.deepEqual(
    nth(layoutComposite(edge.segs, edge.marks, edge.crops, DENSE, "ltr", "full").crops, 0).src,
    {
      x1: 0,
      y1: 1984,
      x2: 306,
      y2: 2000,
    },
  );
});

test("thumbnails are never upscaled", () => {
  const p = makePack([{ w: 320, h: 400 }], [{ image: 0, text: bx(40, 40, 200, 120), glyph: 20 }], "page");
  const l = layout(p);
  const ctx = nth(l.context, 0);
  assert.equal(ctx.scale, 1);
  assert.deepEqual([width(ctx.dst), height(ctx.dst)], [320, 400]);
  assertInvariants(l);
});

test("a page thumbnail fills the context height; the separator follows the thumbnail width", () => {
  const p = makePack([{ w: 1000, h: 1420 }], [{ image: 0, text: bx(100, 100, 400, 300) }], "page");
  const l = layout(p);
  const ctx = nth(l.context, 0);
  assert.ok(height(ctx.dst) >= l.H - 2 * COMP.pad - 1, `thumbnail height ${height(ctx.dst)}`);
  assert.ok(width(ctx.dst) < Math.floor(0.3 * l.W), "narrower than the context area");
  assert.deepEqual(l.separator, bx(ctx.dst.x2 + COMP.pad, 0, ctx.dst.x2 + COMP.pad + COMP.sep, l.H));
  assertInvariants(l);
});

test("two pages sit side by side; rtl puts the first page on the right", () => {
  const units = [
    { image: 0, text: bx(100, 100, 400, 300) },
    { image: 1, text: bx(500, 900, 800, 1100) },
  ];
  const p = makePack(
    [
      { w: 1000, h: 1420 },
      { w: 1000, h: 1420 },
    ],
    units,
    "page",
  );
  const ltr = layout(p, DENSE, "ltr");
  const rtl = layout(p, DENSE, "rtl");
  const [l0, l1] = [nth(ltr.context, 0), nth(ltr.context, 1)];
  const [r0, r1] = [nth(rtl.context, 0), nth(rtl.context, 1)];
  assert.equal(l0.dst.y1, l1.dst.y1, "same row");
  assert.ok(l0.dst.x2 <= l1.dst.x1, "ltr: first page on the left");
  assert.ok(r1.dst.x2 <= r0.dst.x1, "rtl: first page on the right");
  assert.ok(width(l0.dst) + width(l1.dst) + COMP.gap <= Math.floor(0.3 * 2048));
  assertInvariants(ltr);
  assertInvariants(rtl);
});

test("rtl mirrors the badge preference (top-right first, top-left for ltr)", () => {
  const p = makePack([{ w: 800, h: 2000 }], [{ image: 0, text: bx(250, 900, 550, 1000) }], "band");
  const ltr = nth(layout(p, DENSE, "ltr").marks, 0);
  const rtl = nth(layout(p, DENSE, "rtl").marks, 0);
  assert.deepEqual(
    [ltr.badge.x1, ltr.badge.y2],
    [ltr.frame.x1, ltr.frame.y1 - COMP.badgeGap],
    "ltr: above the frame, left-aligned",
  );
  assert.deepEqual(
    [rtl.badge.x2, rtl.badge.y2],
    [rtl.frame.x2, rtl.frame.y1 - COMP.badgeGap],
    "rtl: above the frame, right-aligned",
  );
});

test("a blocked top position moves the badge to the side, never onto text", () => {
  // A column of five boxes 20 px apart at the right of the page: no room above boxes 2..5, room on the left.
  const units = [0, 1, 2, 3, 4].map((i) => ({ image: 0, text: bx(500, 100 + 140 * i, 800, 220 + 140 * i) }));
  const p = makePack([{ w: 1000, h: 1000 }], units, "page");
  const l = layout(p);
  assert.equal(l.ok, true, String(l.reason));
  assertInvariants(l);
  const [first, ...rest] = l.marks;
  assert.ok(first !== undefined && first.badge.y2 <= first.frame.y1, "the first box keeps the top position");
  for (const m of rest) {
    assert.ok(m.badge.x2 <= m.frame.x1, `badge ${m.n} moved left of its frame`);
    assert.ok(m.badge.y1 >= m.frame.y1 - COMP.badgeH && m.badge.y2 <= m.frame.y2 + COMP.badgeH);
  }
});

test("ghost units get a grey frame, no badge and no crop, and badges avoid their text", () => {
  const p = makePack(
    [{ w: 800, h: 2000 }],
    [
      { image: 0, text: bx(250, 700, 550, 860), ghost: true },
      { image: 0, text: bx(250, 880, 550, 1000) },
    ],
    "band",
  );
  const l = layout(p);
  assert.equal(l.ok, true, String(l.reason));
  assert.equal(l.ghosts.length, 1);
  assert.deepEqual(
    l.marks.map((m) => m.n),
    [1],
  );
  assert.equal(l.crops.length, 1);
  const ghost = nth(l.ghosts, 0);
  assert.equal(inter(nth(l.marks, 0).badge, ghost.text), 0);
  assert.equal(inter(nth(l.marks, 0).badge, ghost.frame), 0);
  // The band follows the numbered unit only (880 − 0.15·800); the ghost is cut at the band's top edge.
  const ctx = nth(l.context, 0);
  assert.equal(ctx.src.y1, 880 - 120);
  assert.equal(ghost.text.y1, ctx.dst.y1);
  assert.ok(height(ghost.text) > 0);
  assertInvariants(l);
});

test("each half of a split strip shows only its own rows, so splitting fixes a 'context' failure", () => {
  // Eight units spread down one 800×6000 strip: even on 2048×1152 their band is under 160 px wide. Ghosts must not
  // widen a half's band, or no split could ever fix it.
  const strip = [{ w: 800, h: 6000 }];
  const texts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => bx(250, 200 + 780 * i, 550, 320 + 780 * i));
  const whole = layout(
    makePack(
      strip,
      texts.map((text) => ({ image: 0, text })),
      "band",
    ),
  );
  assert.deepEqual([whole.ok, whole.reason, whole.canvasIndex], [false, "context", 1]);

  for (const half of [0, 1]) {
    const units = texts.map((text, i): UnitSpec =>
      Math.floor(i / 4) === half ? { image: 0, text } : { image: 0, text, ghost: true },
    );
    const l = layout(makePack(strip, units, "band"));
    assert.equal(l.ok, true, String(l.reason));
    assert.equal(l.canvasIndex, 0);
    const own = texts.slice(4 * half, 4 * half + 4);
    assert.deepEqual(nth(l.context, 0).src, bx(0, nth(own, 0).y1 - 120, 800, nth(own, 3).y2 + 120));
    assert.deepEqual(l.ghosts, [], "the other half lies outside the band and is not drawn");
    assertInvariants(l);
  }
});

test("a band that holds only ghosts spans them", () => {
  const p = makePack(
    [
      { w: 800, h: 2000 },
      { w: 800, h: 2000 },
    ],
    [
      { image: 0, text: bx(250, 300, 550, 400) },
      { image: 1, text: bx(250, 900, 550, 1000), ghost: true },
    ],
    "band",
  );
  const l = layout(p);
  assert.equal(l.ok, true, String(l.reason));
  assert.deepEqual(nth(l.context, 1).src, bx(0, 900 - 120, 800, 1000 + 120));
  assert.equal(l.ghosts.length, 1);
  assertInvariants(l);
});

test("an unavoidable collision fails with reason 'badges' instead of covering text", () => {
  // The only text box covers the whole page: no 28-px badge fits around it.
  // On 2048×768 the thumbnail fills the context height.
  const p = makePack([{ w: 1000, h: 1400 }], [{ image: 0, text: bx(0, 0, 1000, 1400), glyph: 100 }], "page");
  const l = layout(p, BASIC);
  assert.deepEqual([l.ok, l.reason, l.canvasIndex, l.fits], [false, "badges", 0, true]);
  assert.ok(l.separator !== null);
  assert.ok(inside(nth(l.marks, 0).badge, bx(0, 0, l.separator.x1, l.H)), "still inside the context area");
  // On 2048×1152 the same page is centred with free rows above it, where the badge goes.
  const dense = layout(p, DENSE);
  assert.deepEqual([dense.ok, dense.canvasIndex], [true, 1]);
  const m = nth(dense.marks, 0);
  assert.ok(m.badge.y2 <= m.frame.y1);
  assertInvariants(dense);
});

test("30 dense marks cannot fit: ok false with a reason; halves fit on the larger canvas", () => {
  // Two 1600×2200 pages, a 3×5 grid of 300×200 Korean text boxes on each.
  const pages = [
    { w: 1600, h: 2200 },
    { w: 1600, h: 2200 },
  ];
  const grid = (image: number, ghost: boolean): UnitSpec[] =>
    [0, 1, 2, 3, 4].flatMap((r) =>
      [0, 1, 2].map((c) => {
        const text = bx(175 + 475 * c, 200 + 400 * r, 475 + 475 * c, 400 + 400 * r);
        return ghost ? { image, text, glyph: 20, ghost: true as const } : { image, text, glyph: 20 };
      }),
    );
  const all = layout(makePack(pages, [...grid(0, false), ...grid(1, false)], "page"));
  assert.equal(all.ok, false);
  assert.equal(all.reason, "glyph");
  assert.equal(all.canvasIndex, 1, "2048×1152 was tried before giving up");
  assert.ok(all.minEffGlyph < GLYPHS.glyphMin.hangul);
  assert.equal(all.crops.length, 30);
  assertInvariants(all);

  // The packer splits by position; each half keeps both pages and draws the other half as ghosts.
  const first = layout(makePack(pages, [...grid(0, false), ...grid(1, true)], "page"));
  const second = layout(makePack(pages, [...grid(0, true), ...grid(1, false)], "page"));
  for (const half of [first, second]) {
    assert.equal(half.ok, true, String(half.reason));
    assert.equal(half.canvasIndex, 1);
    assert.equal(half.marks.length, 15);
    assert.equal(half.ghosts.length, 15);
    assert.ok(half.minEffGlyph >= GLYPHS.glyphMin.hangul);
    assertInvariants(half);
  }
  // gpt-4o cannot use 2048×1152: the halves still fail on 2048×768.
  const basic = layout(makePack(pages, [...grid(0, false), ...grid(1, true)], "page"), BASIC);
  assert.deepEqual([basic.ok, basic.reason, basic.canvasIndex], [false, "glyph", 0]);
});

test("crops that cannot fit even at g = 0.25 report overflow", () => {
  // 30 lettering blocks of 1200×800 px: even at g = 0.25 only 4 cells fit per row and 3 rows per canvas.
  const units = Array.from({ length: 30 }, (_, i) => ({
    image: 0,
    text: bx(100, 100 + 60 * i, 1300, 900 + 60 * i),
    glyph: 20,
  }));
  const crops = makePack([{ w: 2000, h: 3000 }], units, "band").crops;
  const l = layoutComposite([], [], crops, DENSE, "ltr", "crops-only");
  assert.deepEqual([l.ok, l.reason, l.fits, l.g, l.canvasIndex], [false, "overflow", false, COMP.gMin, 1]);
  assert.equal(l.crops.length, 30, "a best-effort placement is still returned");
});

test("bands narrower than 160 px fail with reason 'context'", () => {
  const images = Array.from({ length: 8 }, () => ({ w: 800, h: 2000 }));
  const units = images.flatMap((_, image) =>
    [200, 650, 1100, 1550].map((y) => ({ image, text: bx(250, y, 550, y + 200) })),
  );
  const l = layout(makePack(images, units, "band"));
  assert.equal(l.ok, false);
  assert.equal(l.reason, "context");
  assert.equal(l.canvasIndex, 1);
  assert.ok(nth(l.context, 0).scale * 800 < COMP.minBandPx);
});

test("more than two page thumbnails is refused without trying a larger canvas", () => {
  const pages = [0, 1, 2].map(() => ({ w: 1000, h: 1400 }));
  const l = layout(
    makePack(
      pages,
      [0, 1, 2].map((image) => ({ image, text: bx(100, 100, 400, 300) })),
      "page",
    ),
  );
  assert.deepEqual([l.ok, l.reason, l.canvasIndex], [false, "too-many-pages", 0]);
});

test("an empty pack is not ok", () => {
  const l = layoutComposite([], [], [], DENSE, "ltr", "full");
  assert.deepEqual([l.ok, l.reason, l.minEffGlyph, l.crops.length, l.canvasIndex], [false, "empty", 0, 0, 0]);
});

test("crops-only mode renumbers 1..k in reading order and fills the canvas", () => {
  const crop = (n: number, y: number): CropSpec => ({
    n,
    imageId: `img${n}`,
    text: bx(100, y, 400, y + 80),
    bounds: { w: 800, h: 2000 },
    glyphPx: 20,
    script: "hangul",
  });
  const junkMarks: Mark[] = [{ n: 1, segment: 9, text: bx(0, 0, 1, 1) }];
  const l = layoutComposite(
    [],
    junkMarks,
    [crop(12, 300), crop(3, 100), crop(7, 200)],
    BASIC,
    "rtl",
    "crops-only",
  );
  assert.equal(l.ok, true, String(l.reason));
  assert.equal(l.mode, "crops-only");
  assert.deepEqual(
    l.crops.map((c) => [c.n, c.orig, c.imageId]),
    [
      [1, 3, "img3"],
      [2, 7, "img7"],
      [3, 12, "img12"],
    ],
  );
  assert.deepEqual(
    l.crops.map((c) => c.color),
    [paletteColor(1), paletteColor(2), paletteColor(3)],
  );
  assert.deepEqual([l.context, l.marks, l.ghosts, l.separator], [[], [], [], null]);
  assert.deepEqual(l.cropArea, bx(COMP.pad, COMP.pad, l.W - COMP.pad, l.H - COMP.pad));
  assert.equal(nth(l.crops, 0).cell.x1, COMP.pad);
  assertInvariants(l);
});

test("seam crops are cut from the seam canvas", () => {
  const p = makePack([{ w: 800, h: 2000 }], [{ image: 0, text: bx(200, 1900, 500, 2000) }], "band");
  const seamCrop = {
    ...nth(p.crops, 0),
    text: bx(200, 400, 500, 640),
    bounds: { w: 800, h: 960 },
    fromSeam: "seam:a",
  };
  const l = layoutComposite(p.segs, p.marks, [seamCrop], DENSE, "ltr", "full");
  const c = nth(l.crops, 0);
  assert.deepEqual([c.imageId, c.source], ["img0", "seam:a"]);
  assert.deepEqual(c.src, bx(192, 392, 508, 648), "inflated by 0.3·24 = 7.2 px, rounded outward");
});

test("when reading order overflows, crops are retried sorted by height", () => {
  // At g = 0.25 the cells are 188 px wide: two per row in a 384-px area. Reading order alternates short and
  // tall cells (two 200-px rows overflow 284 px); sorted by height the two tall cells share the first row.
  const crop = (n: number, h: number): CropSpec => ({
    n,
    imageId: "img",
    text: bx(100, 100, 822, 100 + h),
    bounds: { w: 2000, h: 2000 },
    glyphPx: 22,
    script: "latin",
  });
  const prof: ModelProfileLike = { canvas: [{ W: 400, H: 300 }], ...GLYPHS };
  const l = layoutComposite(
    [],
    [],
    [crop(1, 58), crop(2, 658), crop(3, 58), crop(4, 658)],
    prof,
    "ltr",
    "crops-only",
  );
  assert.equal(l.fits, true);
  assert.equal(l.reason, "glyph", "fits, but 0.25·22 px is below the latin floor");
  const [s1, t1, s2, t2] = l.crops.map((c) => c.cell);
  assert.ok(s1 && t1 && s2 && t2);
  assert.equal(t1.y1, COMP.pad);
  assert.equal(t2.y1, COMP.pad);
  assert.ok(t1.x2 <= t2.x1);
  assert.ok(s1.y1 >= t1.y2 && s2.y1 >= t1.y2, "short cells on the second row");
  assert.ok(s1.x2 <= s2.x1);
  assertInvariants(l);
});

test("deterministic: the same input gives the same layout and never mutates it", () => {
  const p = webtoonPack();
  const frozen = structuredClone(p);
  deepFreeze(frozen);
  const a = layout(frozen, DENSE, "rtl");
  const b = layout(frozen, DENSE, "rtl");
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, "plain JSON data");
  assert.deepEqual(frozen, p);
});

test("malformed input throws RangeError", () => {
  const p = webtoonPack();
  const dup = [...p.crops, { ...nth(p.crops, 0) }];
  assert.throws(() => layoutComposite(p.segs, p.marks, dup, DENSE, "ltr", "full"), RangeError);
  const badSeg = [...p.marks, { n: 99, segment: 7, text: bx(0, 0, 10, 10) }];
  assert.throws(() => layoutComposite(p.segs, badSeg, p.crops, DENSE, "ltr", "full"), RangeError);
  const dupMark = [...p.marks, { ...nth(p.marks, 0) }];
  assert.throws(() => layoutComposite(p.segs, dupMark, p.crops, DENSE, "ltr", "full"), RangeError);
  assert.throws(() => layout(p, { canvas: [], ...GLYPHS }), RangeError);
  assert.throws(() => layout(p, { canvas: [{ W: 2048.5, H: 768 }], ...GLYPHS }), RangeError);
  const outside = [{ ...nth(p.crops, 0), text: bx(5000, 5000, 5100, 5100) }];
  assert.throws(() => layoutComposite([], [], outside, DENSE, "ltr", "crops-only"), RangeError);
  const zero = [{ ...nth(p.crops, 0), n: 0 }];
  assert.throws(() => layoutComposite([], [], zero, DENSE, "ltr", "crops-only"), RangeError);
  const nan = [{ ...nth(p.crops, 0), text: bx(Number.NaN, 0, 10, 10) }];
  assert.throws(() => layoutComposite([], [], nan, DENSE, "ltr", "crops-only"), RangeError);
  const nanMark = p.marks.map((m, i) =>
    i === 0 ? { ...m, text: bx(0, 0, Number.POSITIVE_INFINITY, 1) } : m,
  );
  assert.throws(() => layoutComposite(p.segs, nanMark, p.crops, DENSE, "ltr", "full"), RangeError);
  const badImage = p.segs.map((s, i) => (i === 0 ? { ...s, imgW: Number.POSITIVE_INFINITY } : s));
  assert.throws(() => layoutComposite(badImage, p.marks, p.crops, DENSE, "ltr", "full"), RangeError);
  // A numbered mark outside its segment's region would get a collapsed frame and a badge pointing at nothing.
  const lowerHalf = p.segs.map((s, i) => (i === 0 ? { ...s, src: bx(0, 1000, 800, 2000) } : s));
  assert.throws(
    () => layoutComposite(lowerHalf, p.marks, p.crops, DENSE, "ltr", "full"),
    /mark 1 lies outside the region of segment 0/,
  );
  const negative = [...p.marks, { n: 99, segment: -1, text: bx(0, 0, 10, 10) }];
  assert.throws(() => layoutComposite(p.segs, negative, p.crops, DENSE, "ltr", "full"), /missing segment -1/);
  // A profile without usable glyph sizes for a crop's script (e.g. read from JSON) would make every rectangle NaN.
  const latin = [{ ...nth(p.crops, 0), script: "latin" as const }];
  const noLatin = { ...DENSE, glyphTarget: { hangul: 30, cjk: 32, latin: Number.NaN } };
  assert.throws(
    () => layoutComposite([], [], latin, noLatin, "ltr", "crops-only"),
    /glyph sizes for script latin/,
  );
  const noFloor = { ...DENSE, glyphMin: { hangul: 20, cjk: 22, latin: 0 } };
  assert.throws(
    () => layoutComposite([], [], latin, noFloor, "ltr", "crops-only"),
    /glyph sizes for script latin/,
  );
});

test("a 2048×768-only profile (gpt-4o) fails where one with 2048×1152 (gpt-5.2) fits", () => {
  // Twelve KO units over six strip images: at the glyph floor the crops need more rows than 2048×768 has.
  const images = [0, 1, 2, 3, 4, 5].map(() => ({ w: 800, h: 1200 }));
  const units = images.flatMap((_, image) => [
    { image, text: bx(250, 150, 550, 410), glyph: 20 },
    { image, text: bx(250, 550, 550, 810), glyph: 20 },
  ]);
  const p = makePack(images, units, "band");
  const wide = layout(p, BASIC);
  const tall = layout(p, DENSE);
  assert.deepEqual([wide.ok, wide.reason, wide.canvasIndex, wide.H], [false, "glyph", 0, 768]);
  assert.deepEqual([tall.ok, tall.canvasIndex, tall.H], [true, 1, 1152]);
  assert.ok(tall.minEffGlyph >= 20);
  assertInvariants(tall);
});

test("helpers: palette cycle, badge and header widths", () => {
  assert.equal(paletteColor(1), COMP.palette[0]);
  assert.equal(paletteColor(8), COMP.palette[7]);
  assert.equal(paletteColor(9), COMP.palette[0]);
  assert.deepEqual([badgeWidth(7), badgeWidth(12), badgeWidth(123)], [COMP.badgeH, 38, 50]);
  assert.ok(headerMinWidth(5) < headerMinWidth(12));
});

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
}
