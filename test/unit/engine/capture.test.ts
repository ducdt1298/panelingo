// Engine capture sessions (ladder step 3): refusals, the cap:prepare / cap:ready handshake, sw:capture, cropping a
// single capture and stitching bands, interruptions, timeouts and one session per tab.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureRefusal,
  createCaptureAssist,
  failError,
  type CaptureAssist,
} from "../../../src/engine/capture.ts";
import type { AcquireContext, FrameInfo } from "../../../src/engine/contracts.ts";
import { createLogger } from "../../../src/platform/log.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { CanvasLike, Ctx2DLike, Gfx, LoadedImage } from "../../../src/shared/gfx.ts";
import type { EngineToCs, ImageSubmit, ReqOf, ResOf, SwApi } from "../../../src/shared/protocol.ts";
import { migrateSettings, migrateSite } from "../../../src/shared/settings.ts";
import type { RectCss } from "../../../src/shared/types.ts";

class ManualClock {
  t = 0;
  private timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  readonly now = (): number => this.t;
  readonly setTimer = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  advance(ms: number): void {
    this.t += ms;
    for (const timer of this.timers) {
      if (timer.live && timer.at <= this.t) {
        timer.live = false;
        timer.fn();
      }
    }
  }
}

async function turns(n = 20): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

interface Draw {
  src: [number, number, number, number];
  dst: [number, number, number, number];
}

class FakeGfx implements Gfx {
  readonly canvases: Array<{ w: number; h: number; draws: Draw[] }> = [];
  shot = { w: 1280, h: 900 };
  closed = 0;
  createCanvas(w: number, h: number): CanvasLike {
    const record = { w, h, draws: [] as Draw[] };
    this.canvases.push(record);
    const ctx = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage: (...args: number[]) => {
        const [, sx, sy, sw, sh, dx, dy, dw, dh] = [0, ...args.slice(1)];
        record.draws.push({
          src: [sx ?? 0, sy ?? 0, sw ?? 0, sh ?? 0],
          dst: [dx ?? 0, dy ?? 0, dw ?? 0, dh ?? 0],
        });
      },
    } as unknown as Ctx2DLike;
    return { width: w, height: h, getContext: () => ctx };
  }
  encodeJpeg(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array([0xff]));
  }
  encodePng(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  }
  loadImage(): Promise<LoadedImage> {
    return Promise.resolve({
      width: this.shot.w,
      height: this.shot.h,
      close: () => {
        this.closed += 1;
      },
    });
  }
}

const FRAME_KEY = "7:0:DOC";

function frame(patch: Partial<FrameInfo> = {}): FrameInfo {
  return {
    frameKey: FRAME_KEY,
    tabId: 7,
    frameId: 0,
    documentId: "DOC",
    url: "https://reader.example/ch/1",
    origin: "https://reader.example",
    siteKey: "https://reader.example",
    mode: "auto",
    codec: "sc",
    page: { title: "", layout: "auto", visible: true, dpr: 1 },
    viewport: null,
    focusSeq: 1,
    ...patch,
  };
}

function ctxOf(patch: Partial<FrameInfo> = {}, site = { enabled: true }): AcquireContext {
  return { frame: frame(patch), site: migrateSite(site, 0), settings: migrateSettings({}) };
}

function submitOf(imageKey = "1.0"): ImageSubmit {
  return {
    imageKey,
    src: "https://reader.example/ch/1#ctv-canvas-1.0",
    natural: { w: 1200, h: 1800 },
    displayed: { w: 1200, h: 1800 },
    element: "canvas",
    priority: 0,
    pos: { docOrder: 0, srcGen: 0, yTop: 0 },
    acquire: "capture",
  };
}

interface Harness {
  clock: ManualClock;
  gfx: FakeGfx;
  posts: EngineToCs[];
  sw: Array<ReqOf<SwApi, "sw:capture">>;
  assist: CaptureAssist;
  prepares(): Array<Extract<EngineToCs, { type: "cap:prepare" }>>;
  ready(rect: RectCss, reqId?: string, extra?: { viewport?: { w: number; h: number }; clip?: RectCss }): void;
}

function harness(
  options: { siteEnabled?: (frame: FrameInfo, ctx: AcquireContext) => boolean } = {},
): Harness {
  const clock = new ManualClock();
  const gfx = new FakeGfx();
  const posts: EngineToCs[] = [];
  const sw: Array<ReqOf<SwApi, "sw:capture">> = [];
  const assist = createCaptureAssist({
    clock,
    log: createLogger("engine", { minLevel: "error", sinks: [] }),
    gfx,
    post: (frameKey, message) => {
      assert.equal(frameKey, FRAME_KEY);
      posts.push(message);
      return true;
    },
    callSw: (_type, payload): Promise<ResOf<SwApi, "sw:capture">> => {
      sw.push(payload);
      return Promise.resolve({
        png: new ArrayBuffer(8),
        scale: gfx.shot.w / payload.viewport.w,
        visible: payload.rect,
      });
    },
    swCodec: () => "sc",
    ...(options.siteEnabled === undefined ? {} : { siteEnabled: options.siteEnabled }),
  });
  const h: Harness = {
    clock,
    gfx,
    posts,
    sw,
    assist,
    prepares: () =>
      posts.filter((m): m is Extract<EngineToCs, { type: "cap:prepare" }> => m.type === "cap:prepare"),
    ready: (rect, reqId, extra = {}) => {
      const id = reqId ?? h.prepares().at(-1)?.reqId ?? "";
      assist.receive(FRAME_KEY, {
        type: "cap:ready",
        reqId: id,
        rect,
        viewport: extra.viewport ?? { w: 1280, h: 900 },
        dpr: 1,
        ...(extra.clip === undefined ? {} : { clip: extra.clip }),
      });
    },
  };
  return h;
}

async function rejection(promise: Promise<unknown>): Promise<CtvError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CtvError, String(error));
    return error;
  }
  throw new Error("expected a rejection");
}

test("captureRefusal: enabled sites (or their reader frames), a visible tab and an image on screen only", () => {
  const submit = submitOf();
  assert.equal(captureRefusal(submit, ctxOf()), null, "no viewport sample yet: the frame decides");
  assert.equal(captureRefusal(submit, ctxOf({}, { enabled: false }))?.detail, "site");
  assert.equal(captureRefusal(submit, ctxOf({ frameId: 3 })), null, "reader iframes are captured too");
  assert.equal(captureRefusal(submit, ctxOf({}, { enabled: false }), true), null, "the caller decides");
  const hidden = captureRefusal(
    submit,
    ctxOf({ page: { title: "", layout: "auto", visible: false, dpr: 1 } }),
  );
  assert.equal(hidden?.code, "image.capture_blocked");
  const viewport = { scrollY: 0, innerHeight: 900, secondsPerScreen: 4, onScreen: ["2.0"] };
  const off = captureRefusal(submit, ctxOf({ viewport }));
  assert.equal(off?.code, "image.capture_unavailable");
  assert.equal(off?.detail, "offscreen");
  assert.equal(captureRefusal(submit, ctxOf({ viewport: { ...viewport, onScreen: ["1.0"] } })), null);
  assert.deepEqual(
    (["hidden", "not-visible", "moved", "timeout", "frame"] as const).map((reason) => [
      failError(reason).code,
      failError(reason).detail,
    ]),
    [
      ["image.capture_blocked", "hidden"],
      ["image.capture_unavailable", "offscreen"],
      ["image.capture_unavailable", "interrupted"],
      ["image.capture_unavailable", "timeout"],
      ["image.capture_blocked", "frame"],
    ],
  );
});

test("an image that fits: one prepare, one sw:capture, cropped to its rect; the frame is told when it is over", async () => {
  const h = harness();
  const result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  assert.deepEqual(
    h.prepares().map((m) => ({ imageKey: m.imageKey, band: m.band })),
    [{ imageKey: "1.0", band: undefined }],
  );
  h.ready({ left: 40, top: 53, width: 1200, height: 800 });
  const image = await result;
  assert.deepEqual(
    {
      source: image.source,
      lowRes: image.lowRes,
      mime: image.mime,
      url: image.url,
      bytes: image.bytes.byteLength,
    },
    { source: "capture", lowRes: true, mime: "image/png", url: null, bytes: 4 },
  );
  assert.deepEqual(h.sw, [
    {
      tabId: 7,
      rect: { left: 40, top: 53, width: 1200, height: 800 },
      viewport: { w: 1280, h: 900 },
      codec: "sc",
    },
  ]);
  assert.deepEqual(h.gfx.canvases, [
    { w: 1200, h: 800, draws: [{ src: [40, 53, 1200, 800], dst: [0, 0, 1200, 800] }] },
  ]);
  assert.equal(h.gfx.closed, 1, "the screenshot is closed at once");
  assert.equal(h.posts.at(-1)?.type, "cap:done");
});

test("a tall image: bands scrolled to the capture window one by one and stitched at device scale", async () => {
  const h = harness();
  h.gfx.shot = { w: 2560, h: 1800 };
  const result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  h.ready({ left: 40, top: 53, width: 1200, height: 1800 });
  for (const top of [0, 504, 1008, 1170]) {
    await turns();
    const prepare = h.prepares().at(-1);
    assert.deepEqual(prepare?.band, { top, height: 630, left: 0, width: 1200 });
    h.ready({ left: 40, top: 135 - top, width: 1200, height: 1800 });
  }
  await result;
  const [canvas] = h.gfx.canvases;
  assert.equal(h.gfx.canvases.length, 1);
  assert.deepEqual([canvas?.w, canvas?.h], [2400, 3600]);
  assert.deepEqual(
    canvas?.draws.map((d) => d.dst),
    [
      [0, 0, 2400, 1260],
      [0, 1008, 2400, 1260],
      [0, 2016, 2400, 1260],
      [0, 2340, 2400, 1260],
    ],
  );
  assert.deepEqual(canvas?.draws[1]?.src, [80, 270, 2400, 1260]);
  assert.equal(h.sw.length, 4);
  assert.equal(new Set(h.prepares().map((m) => m.reqId)).size, 1, "one session");
  assert.equal(h.posts.filter((m) => m.type === "cap:done").length, 1);
});

test("the reader scrolls during the bands: the session stops with 'interrupted' and the page is released", async () => {
  const h = harness();
  const result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  const reqId = h.prepares()[0]?.reqId ?? "";
  h.ready({ left: 40, top: 53, width: 1200, height: 1800 });
  await turns();
  h.ready({ left: 40, top: 135, width: 1200, height: 1800 });
  await turns();
  h.assist.receive(FRAME_KEY, { type: "cap:fail", reqId, reason: "moved" });
  const error = await rejection(result);
  assert.equal(error.code, "image.capture_unavailable");
  assert.equal(error.detail, "interrupted");
  assert.deepEqual(h.posts.at(-1), { type: "cap:done", reqId });
});

test("refusals from the frame, no answer, a layout change, too many bands, a frame that goes away", async () => {
  let h = harness();
  let result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  h.assist.receive(FRAME_KEY, {
    type: "cap:fail",
    reqId: h.prepares()[0]?.reqId ?? "",
    reason: "not-visible",
  });
  assert.equal((await rejection(result)).detail, "offscreen");

  h = harness();
  result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  h.clock.advance(5_000);
  assert.equal((await rejection(result)).detail, "timeout");
  assert.equal(h.posts.at(-1)?.type, "cap:done");

  h = harness();
  result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  h.ready({ left: 40, top: 53, width: 1200, height: 1800 });
  await turns();
  h.ready({ left: 40, top: 135, width: 1100, height: 1800 });
  assert.equal((await rejection(result)).detail, "interrupted", "the image changed size");

  h = harness();
  result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  h.ready({ left: 40, top: 0, width: 800, height: 20_000 });
  assert.equal((await rejection(result)).code, "image.too_large");

  h = harness();
  result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  h.ready({ left: 1300, top: 0, width: 1200, height: 800 });
  assert.equal((await rejection(result)).detail, "offscreen", "entirely off to the side");

  h = harness();
  result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  h.assist.frameGone(FRAME_KEY);
  assert.equal((await rejection(result)).detail, "timeout");
  h.assist.receive(FRAME_KEY, {
    type: "cap:ready",
    reqId: "nobody",
    rect: { left: 0, top: 0, width: 1, height: 1 },
    viewport: { w: 1, h: 1 },
    dpr: 1,
  });

  h = harness();
  await assert.rejects(h.assist.capture(submitOf(), ctxOf({}, { enabled: false })), /enabled sites/);
  assert.equal(h.posts.length, 0, "a refused capture never touches the page");
});

test("one session per tab: the next image waits until the first one is done", async () => {
  const h = harness();
  const first = h.assist.capture(submitOf("1.0"), ctxOf());
  const second = h.assist.capture(submitOf("2.0"), ctxOf());
  await turns();
  assert.deepEqual(
    h.prepares().map((m) => m.imageKey),
    ["1.0"],
  );
  h.ready({ left: 40, top: 53, width: 1200, height: 800 });
  await first;
  await turns();
  assert.deepEqual(
    h.prepares().map((m) => m.imageKey),
    ["1.0", "2.0"],
  );
  h.ready({ left: 40, top: 53, width: 1200, height: 800 });
  await second;
});

test("a wide and tall image: a grid of tiles, each scrolled to the window start, stitched in place", async () => {
  const h = harness();
  h.gfx.shot = { w: 800, h: 900 };
  const view = { w: 800, h: 900 };
  const result = h.assist.capture(submitOf(), ctxOf());
  await turns();
  h.ready({ left: 10, top: 40, width: 1200, height: 1800 }, undefined, { viewport: view });
  const asked: Array<[number, number]> = [];
  for (let i = 0; i < 12; i += 1) {
    await turns();
    const band = h.prepares().at(-1)?.band;
    assert.ok(band !== undefined && band.left !== undefined && band.width === 560 && band.height === 630);
    asked.push([band.top, band.left]);
    // The frame scrolled the tile to (120, 135).
    h.ready({ left: 120 - band.left, top: 135 - band.top, width: 1200, height: 1800 }, undefined, {
      viewport: view,
    });
  }
  await result;
  assert.deepEqual(asked.slice(0, 4), [
    [0, 0],
    [0, 448],
    [0, 640],
    [504, 0],
  ]);
  const [canvas] = h.gfx.canvases;
  assert.deepEqual([canvas?.w, canvas?.h, canvas?.draws.length], [1200, 1800, 12]);
  assert.deepEqual(canvas?.draws[1], { src: [120, 135, 560, 630], dst: [448, 0, 560, 630] });
  assert.deepEqual(canvas?.draws.at(-1)?.dst, [640, 1170, 560, 630]);
});

test("a reader iframe: tiles follow its clip, and only what shows through the clip is drawn", async () => {
  const h = harness({ siteEnabled: () => true });
  const clip = { left: 100, top: 200, width: 800, height: 500 };
  const result = h.assist.capture(submitOf(), ctxOf({ frameId: 2 }, { enabled: false }));
  await turns();
  // 600×600 at (150, 250): wider than nothing, but taller than the 500 px clip.
  h.ready({ left: 150, top: 250, width: 600, height: 600 }, undefined, { clip });
  const tops: number[] = [];
  for (;;) {
    await turns();
    const last = h.posts.at(-1);
    if (last?.type !== "cap:prepare") break;
    const band = last.band;
    assert.ok(band !== undefined);
    assert.equal(band.height, 350, "70% of the clip, not of the viewport");
    tops.push(band.top);
    h.ready({ left: 150, top: 200 + 75 - band.top, width: 600, height: 600 }, undefined, { clip });
  }
  await result;
  assert.deepEqual(tops, [0, 250]);
  const draws = h.gfx.canvases[0]?.draws ?? [];
  assert.deepEqual(
    draws.map((d) => d.src[1] >= 200 && d.src[1] + d.src[3] <= 700),
    [true, true],
    "nothing from outside the clip",
  );
  assert.deepEqual(h.sw[0]?.viewport, { w: 1280, h: 900 }, "the top viewport goes to sw:capture");
});

test("site check: the injected resolver decides (extraFrameOrigins), a frame without a position is refused", async () => {
  const refused = harness({ siteEnabled: () => false });
  await assert.rejects(refused.assist.capture(submitOf(), ctxOf()), /enabled sites/);
  const h = harness({ siteEnabled: (frame) => frame.frameId === 2 });
  const result = h.assist.capture(submitOf(), ctxOf({ frameId: 2 }, { enabled: false }));
  await turns();
  h.assist.receive(FRAME_KEY, { type: "cap:fail", reqId: h.prepares()[0]?.reqId ?? "", reason: "frame" });
  const error = await rejection(result);
  assert.deepEqual([error.code, error.detail], ["image.capture_blocked", "frame"]);
});
