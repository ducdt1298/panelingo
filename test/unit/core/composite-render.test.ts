import assert from "node:assert/strict";
import { test } from "node:test";
import { COMP, layoutComposite } from "../../../src/shared/core/composite-layout.ts";
import type { CompositeLayout, CropSpec, Mark, Segment } from "../../../src/shared/core/composite-layout.ts";
import { renderComposite } from "../../../src/shared/core/composite-render.ts";
import { height, width } from "../../../src/shared/geometry.ts";
import type {
  CanvasLike,
  Ctx2DLike,
  ImageDataLike,
  ImageSourceLike,
  LineJoinLike,
  SmoothingQualityLike,
  TextAlignLike,
  TextBaselineLike,
} from "../../../src/shared/gfx.ts";
import type { Box } from "../../../src/shared/types.ts";

// Compile-time contract: the browser's contexts and canvases satisfy the Gfx ports unchanged.
type Assert<T extends true> = T;
export type _OffscreenCtx = Assert<OffscreenCanvasRenderingContext2D extends Ctx2DLike ? true : false>;
export type _WindowCtx = Assert<CanvasRenderingContext2D extends Ctx2DLike ? true : false>;
export type _OffscreenCanvas = Assert<OffscreenCanvas extends CanvasLike ? true : false>;
export type _HtmlCanvas = Assert<HTMLCanvasElement extends CanvasLike ? true : false>;

interface Call {
  op: string;
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  smoothing: boolean;
  quality: SmoothingQualityLike;
}

function style(v: string | object): string {
  return typeof v === "string" ? v : "[object]";
}

/** Records every drawing call with the state that applies to it. */
class RecordingCtx implements Ctx2DLike {
  fillStyle: string | object = "#123456";
  strokeStyle: string | object = "#123456";
  lineWidth = 1;
  lineJoin: LineJoinLike = "miter";
  font = "10px sans-serif";
  textAlign: TextAlignLike = "start";
  textBaseline: TextBaselineLike = "alphabetic";
  imageSmoothingEnabled = false;
  imageSmoothingQuality: SmoothingQualityLike = "low";
  depth = 0;
  readonly calls: Call[] = [];

  private rec(op: string, args: unknown[]): void {
    this.calls.push({
      op,
      args,
      fillStyle: style(this.fillStyle),
      strokeStyle: style(this.strokeStyle),
      lineWidth: this.lineWidth,
      font: this.font,
      smoothing: this.imageSmoothingEnabled,
      quality: this.imageSmoothingQuality,
    });
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec("fillRect", [x, y, w, h]);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.rec("strokeRect", [x, y, w, h]);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.rec("clearRect", [x, y, w, h]);
  }
  beginPath(): void {
    this.rec("beginPath", []);
  }
  moveTo(x: number, y: number): void {
    this.rec("moveTo", [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.rec("lineTo", [x, y]);
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    this.rec("arc", [x, y, r, a0, a1]);
  }
  closePath(): void {
    this.rec("closePath", []);
  }
  fill(): void {
    this.rec("fill", []);
  }
  stroke(): void {
    this.rec("stroke", []);
  }
  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.rec("fillText", [text, x, y, maxWidth]);
  }
  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.rec("strokeText", [text, x, y, maxWidth]);
  }
  measureText(text: string): { width: number } {
    return { width: 10 * text.length };
  }
  drawImage(image: ImageSourceLike, ...rect: number[]): void {
    this.rec("drawImage", [image, ...rect]);
  }
  save(): void {
    this.depth++;
    this.rec("save", []);
  }
  restore(): void {
    this.depth--;
    this.rec("restore", []);
  }
  getImageData(_x: number, _y: number, w: number, h: number): ImageDataLike {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(imageData: ImageDataLike, dx: number, dy: number): void {
    this.rec("putImageData", [imageData.width, imageData.height, dx, dy]);
  }
}

const PROFILE = {
  canvas: [{ W: 2048, H: 768 }],
  glyphTarget: { hangul: 30, cjk: 32, latin: 22 },
  glyphMin: { hangul: 20, cjk: 22, latin: 14 },
} as const;

function bx(x1: number, y1: number, x2: number, y2: number): Box {
  return { x1, y1, x2, y2 };
}

function nth<T>(items: readonly T[], i: number): T {
  const item = items[i];
  assert.ok(item !== undefined, `missing item ${i}`);
  return item;
}

/** Two strip images, two numbered units each, plus one ghost on the second image. */
function sampleLayout(): CompositeLayout {
  const segs: Segment[] = ["a", "b"].map((id) => ({
    imageId: id,
    kind: "band",
    src: bx(0, 0, 800, 2000),
    imgW: 800,
    imgH: 2000,
  }));
  const texts = [
    bx(100, 300, 400, 420),
    bx(380, 900, 700, 1040),
    bx(150, 400, 450, 520),
    bx(300, 1100, 650, 1200),
  ];
  const marks: Mark[] = texts.map((text, i) => ({ n: i + 1, segment: i < 2 ? 0 : 1, text }));
  marks.push({ n: 0, segment: 1, text: bx(200, 700, 500, 800), ghost: true });
  const crops: CropSpec[] = texts.map((text, i) => ({
    n: i + 1,
    imageId: i < 2 ? "a" : "b",
    text,
    bounds: { w: 800, h: 2000 },
    glyphPx: 24,
    script: "hangul",
  }));
  const l = layoutComposite(segs, marks, crops, PROFILE, "ltr", "full");
  assert.equal(l.ok, true, String(l.reason));
  return l;
}

function sources(): { lookup: (id: string) => ImageSourceLike; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookup: (id: string) => {
      asked.push(id);
      return { id };
    },
  };
}

function render(l: CompositeLayout): RecordingCtx {
  const ctx = new RecordingCtx();
  renderComposite(l, sources().lookup, ctx);
  return ctx;
}

function rectArgs(b: Box): number[] {
  return [b.x1, b.y1, width(b), height(b)];
}

function indexOfCall(calls: readonly Call[], pred: (c: Call) => boolean, from = 0): number {
  for (let i = from; i < calls.length; i++) if (pred(nth(calls, i))) return i;
  return -1;
}

test("paints a white background first and restores the context last", () => {
  const l = sampleLayout();
  const ctx = render(l);
  const calls = ctx.calls;
  assert.equal(nth(calls, 0).op, "save");
  assert.deepEqual(nth(calls, 1).op, "fillRect");
  assert.deepEqual(nth(calls, 1).args, [0, 0, l.W, l.H]);
  assert.equal(nth(calls, 1).fillStyle, COMP.paper);
  assert.equal(nth(calls, calls.length - 1).op, "restore");
  assert.equal(ctx.depth, 0);
});

test("draws context, ghosts, frames, badges, separator and crops in that order", () => {
  const l = sampleLayout();
  const calls = render(l).calls;
  const draws = calls.filter((c) => c.op === "drawImage");
  assert.equal(draws.length, l.context.length + l.crops.length);

  // Context thumbnails: src rectangle → dst rectangle, from the right image.
  l.context.forEach((c, i) => {
    assert.deepEqual(nth(draws, i).args, [{ id: c.imageId }, ...rectArgs(c.src), ...rectArgs(c.dst)]);
  });
  l.crops.forEach((c, i) => {
    assert.deepEqual(nth(draws, l.context.length + i).args, [
      { id: c.source },
      ...rectArgs(c.src),
      ...rectArgs(c.dst),
    ]);
  });

  const lastContext = calls.indexOf(nth(draws, l.context.length - 1));
  const firstGhost = indexOfCall(calls, (c) => c.op === "strokeRect" && c.lineWidth === COMP.ghostWidth);
  const firstFrame = indexOfCall(calls, (c) => c.op === "strokeRect" && c.lineWidth === COMP.frameWidth);
  const firstBadge = indexOfCall(calls, (c) => c.op === "beginPath");
  assert.ok(l.separator !== null);
  const sepArgs = rectArgs(l.separator);
  const separator = indexOfCall(calls, (c) => c.op === "fillRect" && c.fillStyle === COMP.ink);
  const firstCrop = calls.indexOf(nth(draws, l.context.length));
  assert.deepEqual(nth(calls, separator).args, sepArgs);
  assert.ok(lastContext < firstGhost, "ghosts after thumbnails");
  assert.ok(firstGhost < firstFrame, "frames after ghosts");
  assert.ok(firstFrame < firstBadge, "badges after frames");
  assert.ok(firstBadge < separator, "separator after badges");
  assert.ok(separator < firstCrop, "crops last");
});

test("every image is drawn with high-quality smoothing", () => {
  for (const c of render(sampleLayout()).calls.filter((call) => call.op === "drawImage")) {
    assert.equal(c.smoothing, true);
    assert.equal(c.quality, "high");
  }
});

test("frames use the mark colours; ghosts are thin grey frames without badges", () => {
  const l = sampleLayout();
  const calls = render(l).calls;
  // Odd widths (3 and 1 px) are drawn half a pixel in so the strokes stay crisp.
  const crisp = (b: Box): number[] => [b.x1 + 0.5, b.y1 + 0.5, width(b), height(b)];
  const frames = calls.filter((c) => c.op === "strokeRect" && c.lineWidth === COMP.frameWidth);
  assert.deepEqual(
    frames.map((c) => [c.strokeStyle, ...c.args]),
    l.marks.map((m) => [m.color, ...crisp(m.frame)]),
  );
  const ghosts = calls.filter((c) => c.op === "strokeRect" && c.lineWidth === COMP.ghostWidth);
  assert.equal(ghosts.length, 1);
  assert.deepEqual(
    ghosts.map((c) => [c.strokeStyle, ...c.args]),
    l.ghosts.map((g) => [COMP.ghostColor, ...crisp(g.frame)]),
  );
});

test("badges are coloured pills with white digits on a black stroke", () => {
  const l = sampleLayout();
  const calls = render(l).calls;
  const fills = calls.filter((c) => c.op === "fill");
  assert.deepEqual(
    fills.map((c) => c.fillStyle),
    l.marks.map((m) => m.color),
  );
  const strokes = calls.filter((c) => c.op === "strokeText");
  assert.deepEqual(
    strokes.map((c) => [nth(c.args, 0), c.strokeStyle, c.lineWidth, c.font]),
    l.marks.map((m) => [String(m.n), COMP.ink, COMP.badgeTextStroke, COMP.badgeFont]),
  );
  const digits = calls.filter((c) => c.op === "fillText" && c.font === COMP.badgeFont);
  assert.deepEqual(
    digits.map((c) => [nth(c.args, 0), c.fillStyle]),
    l.marks.map((m) => [String(m.n), COMP.paper]),
  );
  // Text is centred in the badge and clamped to fit inside it.
  l.marks.forEach((m, i) => {
    const [, x, y, maxWidth] = nth(digits, i).args as [string, number, number, number];
    assert.equal(x, (m.badge.x1 + m.badge.x2) / 2);
    assert.equal(y, (m.badge.y1 + m.badge.y2) / 2);
    assert.ok(maxWidth > 0 && maxWidth < width(m.badge));
  });
  // The pill path stays inside the badge box.
  for (const c of calls.filter((call) => call.op === "arc")) {
    const [x, y, r] = c.args as [number, number, number];
    assert.ok(
      l.marks.some(
        (m) => x - r >= m.badge.x1 && x + r <= m.badge.x2 && y - r >= m.badge.y1 && y + r <= m.badge.y2,
      ),
    );
  }
});

test("crop cells get a colour fill and a white '#n' header label", () => {
  const l = sampleLayout();
  const calls = render(l).calls;
  const cells = calls.filter((c) => c.op === "fillRect" && l.crops.some((k) => k.color === c.fillStyle));
  assert.deepEqual(
    cells.map((c) => c.args),
    l.crops.map((c) => rectArgs(c.cell)),
  );
  const headers = calls.filter((c) => c.op === "fillText" && c.font === COMP.headerFont);
  assert.deepEqual(
    headers.map((c) => [nth(c.args, 0), c.fillStyle]),
    l.crops.map((c) => [`#${c.n}`, COMP.paper]),
  );
  l.crops.forEach((c, i) => {
    const [, x, y] = nth(headers, i).args as [string, number, number];
    assert.equal(x, c.header.x1 + COMP.headerPadX);
    assert.equal(y, (c.header.y1 + c.header.y2) / 2);
  });
});

test("crops-only layouts draw no separator, frames or badges", () => {
  const crops: CropSpec[] = [5, 9].map((n) => ({
    n,
    imageId: "a",
    text: bx(100, 100 * n, 400, 100 * n + 60),
    bounds: { w: 800, h: 2000 },
    glyphPx: 20,
    script: "hangul",
  }));
  const l = layoutComposite([], [], crops, PROFILE, "ltr", "crops-only");
  const calls = render(l).calls;
  assert.equal(calls.filter((c) => c.op === "strokeRect" || c.op === "beginPath").length, 0);
  assert.equal(calls.filter((c) => c.op === "fillRect" && c.fillStyle === COMP.ink).length, 0);
  assert.deepEqual(
    calls.filter((c) => c.op === "fillText").map((c) => nth(c.args, 0)),
    ["#1", "#2"],
  );
});

test("seam crops are drawn from the seam canvas and each source is looked up once", () => {
  const segs: Segment[] = [{ imageId: "a", kind: "band", src: bx(0, 0, 800, 2000), imgW: 800, imgH: 2000 }];
  const marks: Mark[] = [
    { n: 1, segment: 0, text: bx(100, 300, 400, 400) },
    { n: 2, segment: 0, text: bx(200, 1900, 500, 2000) },
  ];
  const crops: CropSpec[] = [
    {
      n: 1,
      imageId: "a",
      text: bx(100, 300, 400, 400),
      bounds: { w: 800, h: 2000 },
      glyphPx: 24,
      script: "hangul",
    },
    {
      n: 2,
      imageId: "a",
      text: bx(200, 400, 500, 640),
      bounds: { w: 800, h: 960 },
      glyphPx: 24,
      script: "hangul",
      fromSeam: "seam:a|b",
    },
  ];
  const l = layoutComposite(segs, marks, crops, PROFILE, "ltr", "full");
  const src = sources();
  const ctx = new RecordingCtx();
  renderComposite(l, src.lookup, ctx);
  assert.deepEqual(src.asked, ["a", "seam:a|b"]);
  const draws = ctx.calls.filter((c) => c.op === "drawImage").map((c) => nth(c.args, 0));
  assert.deepEqual(draws, [{ id: "a" }, { id: "a" }, { id: "seam:a|b" }]);
});

test("a narrow crop in a cell widened for its label keeps a white margin", () => {
  const crops: CropSpec[] = [
    {
      n: 10,
      imageId: "a",
      text: bx(100, 100, 108, 400),
      bounds: { w: 800, h: 2000 },
      glyphPx: 32,
      script: "cjk",
    },
  ];
  const l = layoutComposite([], [], crops, PROFILE, "ltr", "crops-only");
  const c = nth(l.crops, 0);
  assert.ok(width(c.dst) + 2 * COMP.border < width(c.cell), "cell wider than the crop");
  const fills = render(l).calls.filter((call) => call.op === "fillRect");
  const inner = [c.cell.x1 + COMP.border, c.header.y2 + COMP.border, width(c.cell) - 4, height(c.cell) - 32];
  assert.ok(
    fills.some(
      (call) => call.fillStyle === COMP.paper && JSON.stringify(call.args) === JSON.stringify(inner),
    ),
  );
});

test("rendering is deterministic", () => {
  const l = sampleLayout();
  assert.deepEqual(render(l).calls, render(l).calls);
});

test("the context state is restored even when a source lookup fails", () => {
  const ctx = new RecordingCtx();
  assert.throws(
    () =>
      renderComposite(
        sampleLayout(),
        () => {
          throw new Error("bitmap closed");
        },
        ctx,
      ),
    /bitmap closed/,
  );
  assert.equal(ctx.depth, 0);
  assert.equal(nth(ctx.calls, ctx.calls.length - 1).op, "restore");
});
