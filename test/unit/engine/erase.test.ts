import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createEraser, measureGlyph, messageYield } from "../../../src/engine/erase.ts";
import type { DecodedImage } from "../../../src/engine/contracts.ts";
import { silentLogger } from "../../../src/platform/log.ts";
import { unitKeyOf } from "../../../src/shared/ids.ts";
import type { Box, UnitGeometry } from "../../../src/shared/types.ts";
import { nodeGfx } from "../../../tools/gfx-node.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const GT = path.join(ROOT, "test/fixtures/generated/ko-p01.gt.json");
const PNG = path.join(ROOT, "test/fixtures/generated/ko-p01.png");

interface GtUnit {
  id: number;
  kind: "bubble" | "free";
  type: string;
  bubble: Box | null;
  text: Box;
  texts: Box[];
  glyphPx: number;
}

function geometry(u: GtUnit, order: number): UnitGeometry {
  return {
    unitKey: unitKeyOf(u.text),
    kind: u.kind,
    bubble: u.bubble,
    text: u.text,
    texts: u.texts,
    orientation: "h",
    glyphPx: u.glyphPx,
    order,
  };
}

/** The caption as the detector returns it: boxes a few px larger than the ground truth, outline included. */
const CAPTION_DETECTED: UnitGeometry = {
  unitKey: "caption",
  kind: "bubble",
  bubble: { x1: 293.6, y1: 119.1, x2: 483.3, y2: 181.75 },
  text: { x1: 306.5, y1: 132.8, x2: 470.5, y2: 168.8 },
  texts: [{ x1: 306.5, y1: 132.8, x2: 470.5, y2: 168.8 }],
  orientation: "h",
  glyphPx: 20,
  order: 0,
};

async function decoded(): Promise<DecodedImage> {
  const image = await nodeGfx.loadImage(readFileSync(PNG));
  return {
    contentKey: "s:ko-p01",
    size: { w: image.width, h: image.height },
    bitmap: image as unknown as ImageBitmap,
    release: () => undefined,
  };
}

test("speech balloons get a mask patch (PNG) inside their outline, with the glyph measured from pixels", async () => {
  const gt = JSON.parse(readFileSync(GT, "utf8")) as { units: GtUnit[] };
  const dialogues = gt.units.filter((u) => u.type === "dialogue");
  const units = dialogues.map((u, i) => geometry(u, i));
  const eraser = createEraser({ gfx: nodeGfx, log: silentLogger });
  const results = eraser.start(await decoded(), units);
  assert.equal(results.size, units.length);
  for (const [i, u] of dialogues.entries()) {
    const out = await results.get(units[i]?.unitKey ?? "");
    assert.ok(out !== undefined);
    assert.equal(out.kind, "mask", `unit ${u.id}`);
    assert.ok(out.png !== null && out.png.byteLength > 8);
    // PNG signature, decodable, and exactly the patch rect.
    assert.deepEqual([...new Uint8Array(out.png.slice(0, 4))], [0x89, 0x50, 0x4e, 0x47]);
    const patch = await nodeGfx.loadImage(new Uint8Array(out.png));
    assert.equal(patch.width, out.rect.x2 - out.rect.x1);
    assert.equal(patch.height, out.rect.y2 - out.rect.y1);
    assert.ok(Math.abs(out.glyphPx - u.glyphPx) <= 2, `glyph ${out.glyphPx} vs ${u.glyphPx}`);
    assert.ok(out.interior !== null && u.bubble !== null);
    const inner = out.interior;
    assert.ok(
      inner.x1 >= u.bubble.x1 &&
        inner.x2 <= u.bubble.x2 &&
        inner.y1 >= u.bubble.y1 &&
        inner.y2 <= u.bubble.y2,
    );
    assert.ok(inner.x1 <= u.text.x1 && inner.x2 >= u.text.x2, "the interior contains the text");
    assert.equal(out.rectLike, false, "speech balloons are ellipses");
  }
});

test("a box caption whose detected box includes its frame is still erased cleanly and fits as a rect", async () => {
  const eraser = createEraser({ gfx: nodeGfx, log: silentLogger });
  const out = await eraser.start(await decoded(), [CAPTION_DETECTED]).get("caption");
  assert.ok(out !== undefined);
  assert.equal(out.kind, "mask");
  assert.deepEqual(out.bg, [255, 248, 225]);
  assert.equal(out.rectLike, true);
  assert.ok(out.interior !== null && out.interior.y1 > CAPTION_DETECTED.bubble!.y1 + 3, "inside the frame");
});

test("units are processed one per task and a failing read degrades to a plate over the text box", async () => {
  const yields: number[] = [];
  let n = 0;
  const eraser = createEraser({
    gfx: nodeGfx,
    log: silentLogger,
    yieldTask: () => {
      yields.push((n += 1));
      return Promise.resolve();
    },
  });
  const outside: UnitGeometry = {
    ...CAPTION_DETECTED,
    unitKey: "outside",
    bubble: null,
    text: { x1: 5000, y1: 5000, x2: 5100, y2: 5050 },
    texts: [],
  };
  const results = eraser.start(await decoded(), [CAPTION_DETECTED, outside]);
  const plate = await results.get("outside");
  assert.equal(plate?.kind, "box");
  assert.equal(plate?.png, null);
  assert.equal(yields.length, 2);
});

test("measureGlyph: the median pixel glyph over the text boxes, falling back to the geometry estimate", async () => {
  const image = await nodeGfx.loadImage(readFileSync(PNG));
  const read = { x1: 600, y1: 300, x2: 900, y2: 480 };
  const ctx = nodeGfx.createCanvas(300, 180).getContext("2d");
  assert.ok(ctx !== null);
  ctx.drawImage(image, read.x1, read.y1, 300, 180, 0, 0, 300, 180);
  const pixels = ctx.getImageData(0, 0, 300, 180);
  const unit: UnitGeometry = {
    ...CAPTION_DETECTED,
    text: { x1: 672, y1: 359, x2: 839, y2: 425 },
    texts: [
      { x1: 672, y1: 359, x2: 839, y2: 388 },
      { x1: 674, y1: 396, x2: 839, y2: 425 },
    ],
    glyphPx: 99,
  };
  assert.ok(Math.abs(measureGlyph(pixels, read, unit) - 29) <= 2);
  assert.equal(measureGlyph({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, read, unit), 99);
});

test("messageYield resolves on a message task (not a throttled timer)", async () => {
  await messageYield();
});

/* Spanish lettering fills its balloons: es-p01 boxes as the detector reported them. */

async function decodedEs(): Promise<DecodedImage> {
  const image = await nodeGfx.loadImage(readFileSync(path.join(ROOT, "test/fixtures/generated/es-p01.png")));
  return {
    contentKey: "s:es-p01",
    size: { w: image.width, h: image.height },
    bitmap: image as unknown as ImageBitmap,
    release: () => undefined,
  };
}

function detected(unitKey: string, bubble: Box, text: Box, glyphPx: number): UnitGeometry {
  return { unitKey, kind: "bubble", bubble, text, texts: [text], orientation: "h", glyphPx, order: 0 };
}

test("a caption whose text fills the box (no background ring) gets a flat fill of its interior, not a plate", async () => {
  const caption = detected(
    "es-caption",
    { x1: 242.6, y1: 155.5, x2: 452.2, y2: 243.4 },
    { x1: 255.2, y1: 171.3, x2: 440.1, y2: 234.0 },
    18,
  );
  const eraser = createEraser({ gfx: nodeGfx, log: silentLogger });
  const out = await eraser.start(await decodedEs(), [caption]).get("es-caption");
  assert.ok(out !== undefined);
  assert.equal(out.kind, "mask");
  assert.ok(out.png !== null && out.png.byteLength > 0, "a PNG patch");
  assert.deepEqual(out.bg, [255, 248, 225]);
  assert.deepEqual(out.textColor, [0, 0, 0]);
  assert.ok(out.interior !== null, "interior found");
  assert.deepEqual(out.rect, {
    x1: Math.ceil(out.interior.x1),
    y1: Math.ceil(out.interior.y1),
    x2: Math.floor(out.interior.x2),
    y2: Math.floor(out.interior.y2),
  });
});

test("long lines whose box corners cross an elliptical outline on screentone are still erased with a mask", async () => {
  const balloonOnTone = detected(
    "es-tone",
    { x1: 581.2, y1: 1212.6, x2: 916.5, y2: 1428.3 },
    { x1: 629.4, y1: 1251.5, x2: 871.6, y2: 1386.2 },
    21,
  );
  const eraser = createEraser({ gfx: nodeGfx, log: silentLogger });
  const out = await eraser.start(await decodedEs(), [balloonOnTone]).get("es-tone");
  assert.ok(out !== undefined);
  assert.equal(out.kind, "mask");
  assert.equal(out.rectLike, false);
});

test("tall vertical lines that fill an elliptical balloon keep sampling inside the ellipse (mask, not a plate)", async () => {
  const image = await nodeGfx.loadImage(readFileSync(path.join(ROOT, "test/fixtures/generated/ja-p01.png")));
  const decodedJa: DecodedImage = {
    contentKey: "s:ja-p01",
    size: { w: image.width, h: image.height },
    bitmap: image as unknown as ImageBitmap,
    release: () => undefined,
  };
  const tall: UnitGeometry = {
    ...detected(
      "ja-tall",
      { x1: 278.2, y1: 207.2, x2: 439.4, y2: 498.1 },
      { x1: 306.3, y1: 243.5, x2: 411.8, y2: 463.7 },
      25,
    ),
    orientation: "v",
  };
  const eraser = createEraser({ gfx: nodeGfx, log: silentLogger });
  const out = await eraser.start(decodedJa, [tall]).get("ja-tall");
  assert.ok(out !== undefined);
  assert.equal(out.kind, "mask");
  assert.equal(out.rectLike, false);
});
