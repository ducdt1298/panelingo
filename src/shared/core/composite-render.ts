// Draws a CompositeLayout through Ctx2DLike. PURE: the same code runs on OffscreenCanvas in the engine
// (src/engine/composite.ts) and on @napi-rs/canvas in Node (tools/gfx-node.ts). Deterministic: one layout always
// issues the same drawing calls in the same order.
//
// Order: white background → context thumbnails (high-quality smoothing, never upscaled by the layout) → grey ghost
// frames → coloured frames → badges (coloured pill with a black/white outline, white digits on a black stroke)
// → black separator → crop cells (colour fill = border + header strip, the crop, white "#n").
// The caller encodes the canvas (JPEG at the profile's jpegQuality, 0.90). Layouts with ok: false may be rendered
// for inspection only.

import { height, width } from "../geometry.ts";
import type { Ctx2DLike, ImageSourceLike } from "../gfx.ts";
import type { Box } from "../types.ts";
import { COMP } from "./composite-layout.ts";
import type { CompositeLayout, CropPlacement } from "./composite-layout.ts";

/** Returns the decoded image (or seam canvas) for a context `imageId` or crop `source` key. */
export type SourceLookup = (imageId: string) => ImageSourceLike;

function fillBox(ctx: Ctx2DLike, b: Box): void {
  ctx.fillRect(b.x1, b.y1, width(b), height(b));
}

/** Odd line widths are offset by half a pixel so the stroke covers whole pixels (crisp edges). */
function strokeBox(ctx: Ctx2DLike, b: Box, lineWidth: number): void {
  const o = (lineWidth % 2) / 2;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(b.x1 + o, b.y1 + o, width(b), height(b));
}

function drawRegion(ctx: Ctx2DLike, image: ImageSourceLike, src: Box, dst: Box): void {
  ctx.drawImage(image, src.x1, src.y1, width(src), height(src), dst.x1, dst.y1, width(dst), height(dst));
}

/** Pill inset by the outline width so the 4-px black stroke ends exactly at the badge box. */
function drawBadge(ctx: Ctx2DLike, b: Box, label: string, color: string): void {
  const inset = COMP.badgeOutline;
  const x1 = b.x1 + inset;
  const x2 = b.x2 - inset;
  const y1 = b.y1 + inset;
  const y2 = b.y2 - inset;
  const r = (y2 - y1) / 2;
  const cx = (b.x1 + b.x2) / 2;
  const cy = (y1 + y2) / 2;
  ctx.beginPath();
  ctx.moveTo(x1 + r, y1);
  ctx.lineTo(x2 - r, y1);
  ctx.arc(x2 - r, cy, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x1 + r, y2);
  ctx.arc(x1 + r, cy, r, Math.PI / 2, (3 * Math.PI) / 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineWidth = 2 * inset;
  ctx.strokeStyle = COMP.ink;
  ctx.stroke();
  ctx.lineWidth = inset;
  ctx.strokeStyle = COMP.paper;
  ctx.stroke();

  const maxWidth = width(b) - 2 * (inset + COMP.badgeTextStroke);
  ctx.font = COMP.badgeFont;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = COMP.badgeTextStroke;
  ctx.strokeStyle = COMP.ink;
  ctx.strokeText(label, cx, cy, maxWidth);
  ctx.fillStyle = COMP.paper;
  ctx.fillText(label, cx, cy, maxWidth);
}

function drawCrop(ctx: Ctx2DLike, image: ImageSourceLike, c: CropPlacement): void {
  ctx.fillStyle = c.color;
  fillBox(ctx, c.cell);
  const inner: Box = {
    x1: c.cell.x1 + COMP.border,
    y1: c.header.y2 + COMP.border,
    x2: c.cell.x2 - COMP.border,
    y2: c.cell.y2 - COMP.border,
  };
  if (width(c.dst) < width(inner) || height(c.dst) < height(inner)) {
    // A cell widened for its header label: keep the margin beside a narrow crop white.
    ctx.fillStyle = COMP.paper;
    fillBox(ctx, inner);
  }
  drawRegion(ctx, image, c.src, c.dst);
  ctx.fillStyle = COMP.paper;
  ctx.font = COMP.headerFont;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(
    `#${c.n}`,
    c.header.x1 + COMP.headerPadX,
    (c.header.y1 + c.header.y2) / 2,
    width(c.header) - 2 * COMP.headerPadX,
  );
}

/** Draws `layout` onto `ctx`, which must be at least layout.W × layout.H. Sources are looked up once per key. */
export function renderComposite(layout: CompositeLayout, getSource: SourceLookup, ctx: Ctx2DLike): void {
  const sources = new Map<string, ImageSourceLike>();
  const source = (key: string): ImageSourceLike => {
    let image = sources.get(key);
    if (image === undefined) {
      image = getSource(key);
      sources.set(key, image);
    }
    return image;
  };

  ctx.save();
  try {
    ctx.fillStyle = COMP.paper;
    ctx.fillRect(0, 0, layout.W, layout.H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    for (const c of layout.context) drawRegion(ctx, source(c.imageId), c.src, c.dst);

    ctx.lineJoin = "miter";
    ctx.strokeStyle = COMP.ghostColor;
    for (const g of layout.ghosts) strokeBox(ctx, g.frame, COMP.ghostWidth);
    for (const m of layout.marks) {
      ctx.strokeStyle = m.color;
      strokeBox(ctx, m.frame, COMP.frameWidth);
    }
    for (const m of layout.marks) drawBadge(ctx, m.badge, String(m.n), m.color);

    if (layout.separator !== null) {
      ctx.fillStyle = COMP.ink;
      fillBox(ctx, layout.separator);
    }
    for (const c of layout.crops) drawCrop(ctx, source(c.source), c);
  } finally {
    ctx.restore();
  }
}
