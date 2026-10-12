// src/engine/composite.ts on tools/gfx-node.ts: real layout, render and JPEG encode over the synthetic ko-p01 page.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  createComposite,
  encodeTestUnits,
  estimateBodyBytes,
  JPEG_DATA_URL_PREFIX,
  PROMPT_ALLOWANCE_BYTES,
} from "../../../src/engine/composite.ts";
import type {
  CompositeRequest,
  CoreDeps,
  DecodedImage,
  PackUnit,
  ServiceFactories,
  SettingsSource,
} from "../../../src/engine/contracts.ts";
import { silentLogger } from "../../../src/platform/log.ts";
import { COMP, paletteColor } from "../../../src/shared/core/composite-layout.ts";
import { MODEL_PROFILES } from "../../../src/shared/core/model-profile.ts";
import { layoutPack } from "../../../src/shared/core/packing.ts";
import { SHRINK_JPEG_QUALITY } from "../../../src/shared/core/retry-policy.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { CanvasLike, Gfx, ImageDataLike } from "../../../src/shared/gfx.ts";
import { unitKeyOf } from "../../../src/shared/ids.ts";
import { migrateSettings, type Settings } from "../../../src/shared/settings.ts";
import type { Box, Size } from "../../../src/shared/types.ts";
import { fromBase64 } from "../../../src/shared/wire.ts";
import {
  answerFromGroundTruth,
  decodeTestUnits,
  encodeTestUnits as oracleEncode,
  GroundTruthStore,
} from "../../../tools/mock-openai/oracle.ts";
import { nodeGfx } from "../../../tools/gfx-node.ts";

// Compile-time contract: the factory fits ServiceFactories.
type Assert<T extends true> = T;
export type _FactoryFits = Assert<
  typeof createComposite extends ServiceFactories["createComposite"] ? true : false
>;

const GT_DIR = fileURLToPath(new URL("../../fixtures/generated/", import.meta.url));
const PROFILE = MODEL_PROFILES.gpt5;

interface GtFile {
  width: number;
  height: number;
  units: Array<{
    id: number;
    kind: "bubble" | "free";
    bubble: Box | null;
    text: Box;
    texts: Box[];
    orientation: "h" | "v";
    glyphPx: number;
  }>;
}

function packUnitsOf(stem: string, file = `${stem}.png`): { size: Size; units: PackUnit[] } {
  const gt = JSON.parse(readFileSync(`${GT_DIR}${stem}.gt.json`, "utf8")) as GtFile;
  const size = { w: gt.width, h: gt.height };
  const units = gt.units.map((u, order): PackUnit => {
    const unitKey = unitKeyOf(u.bubble ?? u.text);
    return {
      contentKey: `s:${stem}`,
      unitKey,
      geometry: {
        unitKey,
        kind: u.kind,
        bubble: u.bubble,
        text: u.text,
        texts: u.texts,
        orientation: u.orientation,
        glyphPx: u.glyphPx,
        order,
      },
      imageSize: size,
      script: "hangul",
      src: file,
    };
  });
  return { size, units };
}

function decoded(contentKey: string, size: Size, bitmap: object): DecodedImage {
  return { contentKey, size, bitmap: bitmap as ImageBitmap, release: () => undefined };
}

function settingsSource(settings: Settings): SettingsSource {
  return {
    current: () => settings,
    site: () => {
      throw new Error("not used");
    },
    sites: () => ({}),
    apply: () => undefined,
    onChange: () => () => undefined,
  };
}

interface SpyGfx extends Gfx {
  qualities: number[];
  canvases: number;
}

function spyGfx(): SpyGfx {
  const spy: SpyGfx = {
    qualities: [],
    canvases: 0,
    createCanvas(w: number, h: number): CanvasLike {
      spy.canvases += 1;
      return nodeGfx.createCanvas(w, h);
    },
    encodeJpeg(canvas: CanvasLike, quality: number): Promise<Uint8Array> {
      spy.qualities.push(quality);
      return nodeGfx.encodeJpeg(canvas, quality);
    },
    encodePng: (canvas) => nodeGfx.encodePng(canvas),
    loadImage: (bytes) => nodeGfx.loadImage(bytes),
  };
  return spy;
}

function harness(gfx: Gfx = nodeGfx): { settings: Settings; deps: CoreDeps & { gfx: Gfx } } {
  const settings = migrateSettings(undefined);
  const deps: CoreDeps & { gfx: Gfx } = {
    gfx,
    log: silentLogger,
    settings: settingsSource(settings),
    clock: {
      now: () => performance.now(),
      setTimer: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    },
  };
  return { settings, deps };
}

function nth<T>(items: readonly T[], i: number): T {
  const item = items[i];
  assert.ok(item !== undefined, `missing item ${i}`);
  return item;
}

async function pixelsOf(jpeg: Uint8Array): Promise<ImageDataLike> {
  const image = await nodeGfx.loadImage(jpeg);
  const canvas = nodeGfx.createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  assert.ok(ctx !== null);
  ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, image.width, image.height);
  return ctx.getImageData(0, 0, image.width, image.height);
}

function rgbAt(img: ImageDataLike, x: number, y: number): [number, number, number] {
  const i = 4 * (Math.floor(y) * img.width + Math.floor(x));
  return [img.data[i] ?? -1, img.data[i + 1] ?? -1, img.data[i + 2] ?? -1];
}

function hexRgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function near(a: readonly number[], b: readonly number[], tol: number): boolean {
  return a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tol);
}

/** Seeded noise page: JPEG cannot compress it, so composites over it are large. */
async function noisePage(size: Size): Promise<object> {
  const canvas = createCanvas(size.w, size.h);
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(size.w, size.h);
  let state = 12345;
  for (let i = 0; i < data.data.length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    data.data[i] = i % 4 === 3 ? 255 : state >>> 24;
  }
  ctx.putImageData(data, 0, 0);
  return nodeGfx.loadImage(await canvas.encode("png"));
}

function request(
  units: readonly PackUnit[],
  images: ReadonlyMap<string, DecodedImage>,
  extra: Partial<CompositeRequest> = {},
): CompositeRequest {
  return { units, mode: "full", profile: PROFILE, dir: "ltr", jpegQuality: 0.9, images, ...extra };
}

describe("createComposite", () => {
  const page = packUnitsOf("ko-p01");
  let images: Map<string, DecodedImage>;

  before(async () => {
    const bitmap = await nodeGfx.loadImage(readFileSync(`${GT_DIR}ko-p01.png`));
    images = new Map([["s:ko-p01", decoded("s:ko-p01", page.size, bitmap)]]);
  });

  test("full mode: a decodable 2048×768 JPEG, marks n = index + 1, coloured crop headers", async () => {
    const result = await createComposite(harness().deps).build(request(page.units, images));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.size, { w: 2048, h: 768 });
    assert.deepEqual(
      result.marks,
      page.units.map((u, i) => ({ n: i + 1, contentKey: "s:ko-p01", unitKey: u.unitKey })),
    );
    assert.deepEqual([...result.jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.ok(result.dataUrl.startsWith(JPEG_DATA_URL_PREFIX));
    assert.deepEqual(fromBase64(result.dataUrl.slice(JPEG_DATA_URL_PREFIX.length)), result.jpeg);

    const img = await pixelsOf(result.jpeg);
    assert.equal(img.width, 2048);
    assert.equal(img.height, 768);
    const layout = layoutPack(page.units, PROFILE, "ltr", "full");
    for (const crop of layout.crops) {
      const x = crop.header.x2 - 4;
      const y = (crop.header.y1 + crop.header.y2) / 2;
      assert.ok(near(rgbAt(img, x, y), hexRgb(paletteColor(crop.n)), 40), `header colour of crop #${crop.n}`);
    }
    const sep = layout.separator;
    assert.ok(sep !== null);
    assert.ok(near(rgbAt(img, (sep.x1 + sep.x2) / 2, 384), hexRgb(COMP.ink), 40), "black separator");
  });

  test("testUnits round-trips through the mock server's oracle decoding and ground-truth matching", async () => {
    const result = await createComposite(harness().deps).build(request(page.units, images));
    assert.ok(result.ok && result.testUnits !== undefined);
    const decodedUnits = decodeTestUnits(result.testUnits);
    assert.deepEqual(
      decodedUnits,
      page.units.map((u, i) => ({ n: i + 1, src: "ko-p01.png", box: u.geometry.text })),
    );
    const oracle = await answerFromGroundTruth(decodedUnits, new GroundTruthStore(GT_DIR), "safe");
    assert.deepEqual(oracle.report.unmatched, []);
    assert.deepEqual(
      oracle.report.matched.map((m) => [m.n, m.gtId, m.by]),
      page.units.map((_, i) => [i + 1, String(i + 1), "text"]),
    );
    assert.equal(oracle.report.lang, "ko");
    // Same bytes as the oracle's own (Buffer-based) encoder.
    assert.equal(encodeTestUnits(page.units), oracleEncode(decodedUnits));
  });

  test("crops-only mode: the given units renumbered 1..k, no context area", async () => {
    const units = [nth(page.units, 2), nth(page.units, 6)];
    const result = await createComposite(harness().deps).build(
      request(units, images, { mode: "crops-only" }),
    );
    assert.ok(result.ok);
    assert.deepEqual(result.size, { w: 2048, h: 768 });
    assert.deepEqual(
      result.marks.map((m) => [m.n, m.unitKey]),
      [
        [1, units[0]?.unitKey],
        [2, units[1]?.unitKey],
      ],
    );
    assert.ok(result.testUnits !== undefined);
    assert.deepEqual(
      decodeTestUnits(result.testUnits).map((u) => [u.n, u.box]),
      [
        [1, units[0]?.geometry.text],
        [2, units[1]?.geometry.text],
      ],
    );
    const layout = layoutPack(units, PROFILE, "ltr", "crops-only");
    assert.equal(layout.separator, null);
    assert.equal(layout.context.length, 0);
  });

  test("a layout that is not ok fails without drawing or encoding (the caller splits)", async () => {
    const strip = packUnitsOf("ko-strip01");
    const gfx = spyGfx();
    const result = await createComposite(harness(gfx).deps).build(request(strip.units, new Map()));
    assert.deepEqual(result, { ok: false, reason: "context" });
    assert.equal(gfx.canvases, 0);
    assert.deepEqual(gfx.qualities, []);
  });

  test("over the request body cap: re-encoded once at q0.80, then CompositeFail when still too large", async () => {
    const noise = new Map([["s:ko-p01", decoded("s:ko-p01", page.size, await noisePage(page.size))]]);
    const gfx = spyGfx();
    const { settings, deps } = harness(gfx);
    const builder = createComposite(deps);
    const at = async (jpegQuality: number): Promise<number> => {
      settings.translate.requestBodyCapMb = 40;
      const result = await builder.build(request(page.units, noise, { jpegQuality }));
      assert.ok(result.ok);
      return result.jpeg.byteLength;
    };
    const big = await at(0.9);
    const small = await at(SHRINK_JPEG_QUALITY);
    assert.ok(big > small, `q0.90 ${big} B should exceed q0.80 ${small} B`);

    gfx.qualities.length = 0;
    settings.translate.requestBodyCapMb =
      (estimateBodyBytes(big) + estimateBodyBytes(small)) / 2 / 1024 / 1024;
    const shrunk = await builder.build(request(page.units, noise));
    assert.ok(shrunk.ok);
    assert.equal(shrunk.jpeg.byteLength, small);
    assert.deepEqual(gfx.qualities, [0.9, SHRINK_JPEG_QUALITY]);

    gfx.qualities.length = 0;
    settings.translate.requestBodyCapMb = (estimateBodyBytes(small) - 1) / 1024 / 1024;
    assert.deepEqual(await builder.build(request(page.units, noise)), { ok: false, reason: "too-large" });
    assert.deepEqual(gfx.qualities, [0.9, SHRINK_JPEG_QUALITY]);

    // A request already at q0.80 (the translator's shrink retry) is encoded once.
    gfx.qualities.length = 0;
    const again = await builder.build(request(page.units, noise, { jpegQuality: SHRINK_JPEG_QUALITY }));
    assert.deepEqual(again, { ok: false, reason: "too-large" });
    assert.deepEqual(gfx.qualities, [SHRINK_JPEG_QUALITY]);
  });

  test("estimateBodyBytes: base64 of the JPEG plus the prompt allowance", () => {
    assert.equal(estimateBodyBytes(0), JPEG_DATA_URL_PREFIX.length + PROMPT_ALLOWANCE_BYTES);
    assert.equal(estimateBodyBytes(3), JPEG_DATA_URL_PREFIX.length + 4 + PROMPT_ALLOWANCE_BYTES);
    assert.equal(estimateBodyBytes(4), JPEG_DATA_URL_PREFIX.length + 8 + PROMPT_ALLOWANCE_BYTES);
  });

  test("a unit without its decoded image or with geometry outside it is an engine.internal error", async () => {
    const builder = createComposite(harness().deps);
    await assert.rejects(builder.build(request(page.units, new Map())), (error: unknown) => {
      return (
        error instanceof CtvError &&
        error.code === "engine.internal" &&
        /no decoded image/.test(error.message)
      );
    });
    const outside = { ...nth(page.units, 0) };
    outside.geometry = { ...outside.geometry, text: { x1: 5000, y1: 5000, x2: 5100, y2: 5050 } };
    await assert.rejects(builder.build(request([outside], images)), (error: unknown) => {
      return error instanceof CtvError && error.code === "engine.internal";
    });
  });

  test("a failing encoder rejects with a CtvError (engine.internal), never a raw error", async () => {
    const gfx: Gfx = { ...nodeGfx, encodeJpeg: () => Promise.reject(new Error("encoder out of memory")) };
    await assert.rejects(
      createComposite(harness(gfx).deps).build(request(page.units, images)),
      (error: unknown) => {
        return (
          error instanceof CtvError &&
          error.code === "engine.internal" &&
          /encoder out of memory/.test(error.message)
        );
      },
    );
  });

  test("no testUnits outside test builds", async () => {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals.__TEST__;
    globals.__TEST__ = false;
    try {
      const result = await createComposite(harness().deps).build(request(page.units.slice(0, 2), images));
      assert.ok(result.ok);
      assert.equal("testUnits" in result, false);
    } finally {
      globals.__TEST__ = previous;
    }
  });
});
