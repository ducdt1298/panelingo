// Controller wiring with a fake overlay, a fake engine client and a fake discovery: auto/manual submission, ladder
// step 1, engine messages → overlay, overlay events → engine/SW, priorities, cs:log batching and teardown (L7).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type {
  CreateOverlay,
  EngineClient,
  EngineClientState,
  ImageElement,
  ImageStateInfo,
  LocalBytes,
  Overlay,
  OverlayEvents,
  OverlayOptions,
  ReadLocalOptions,
  TrackedImage,
} from "../../../src/content/contracts.ts";
import {
  LOG_BATCH,
  LOG_FLUSH_MS,
  LOG_KEEP,
  createController,
  isPainted,
  maxLocalBytes,
  stateInfo,
  type ClientHooks,
  type Controller,
} from "../../../src/content/controller.ts";
import type { Discovery, DiscoveryEvents, SubmitBase } from "../../../src/content/discovery.ts";
import type { TeardownReason } from "../../../src/content/messages.ts";
import type { Horizon } from "../../../src/shared/core/priority.ts";
import type { ContentSummary } from "../../../src/content/test-hooks.ts";
import type { CsToEngine, EngineToCs, EngineToCsMap, ImageSubmit } from "../../../src/shared/protocol.ts";
import { DEFAULT_SETTINGS, migrateSettings } from "../../../src/shared/settings.ts";
import type {
  Codec,
  EngineStatus,
  ImageState,
  Size,
  UnitGeometry,
  UnitRender,
} from "../../../src/shared/types.ts";
import { WIRE_HARD_LIMIT } from "../../../src/shared/wire.ts";

/* ------------------------------------------------------------------ fakes */

const STATUS: EngineStatus = {
  phase: "ready",
  build: "engine-test",
  api: { readiness: "ready", model: null, cause: null, checkedAt: 0 },
  detector: { backend: "none", state: "unloaded", canary: "pending" },
  queue: {
    queued: 0,
    inFlight: 0,
    urgentInFlight: 0,
    done: 0,
    failed: 0,
    pausedBy: null,
    concurrency: 2,
    boxBudget: 20,
  },
  uploads: { today: 0, bytesToday: 0 },
};

class ManualTimers {
  #now = 0;
  #seq = 0;
  readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimer(fn: () => void, ms: number): () => void {
    this.#seq += 1;
    const id = this.#seq;
    this.timers.set(id, { at: this.#now + ms, fn });
    return () => {
      this.timers.delete(id);
    };
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = target;
  }
}

class FakeOverlay implements Overlay {
  readonly calls: string[] = [];
  /** noteUserRequest() calls (kept apart from `calls`). */
  readonly userRequests: string[] = [];
  readonly units: Array<{ imageKey: string; natural: Size; unit: UnitRender }> = [];
  readonly states: Array<{ imageKey: string; state: ImageState; info: ImageStateInfo | undefined }> = [];
  options: OverlayOptions | null = null;
  events: OverlayEvents | null = null;
  visible = true;
  destroyed = false;

  attach(image: TrackedImage): void {
    this.calls.push(`attach ${image.imageKey}`);
  }

  setUnits(imageKey: string, natural: Size, units: readonly UnitGeometry[]): void {
    this.calls.push(`units ${imageKey} ${natural.w}x${natural.h} ${units.length}`);
  }

  setUnit(imageKey: string, natural: Size, unit: UnitRender): void {
    this.units.push({ imageKey, natural, unit });
  }

  setState(imageKey: string, state: ImageState, info?: ImageStateInfo): void {
    this.states.push({ imageKey, state, info });
  }

  showPrivacyNotice(imageKey: string): void {
    this.calls.push(`privacy ${imageKey}`);
  }

  noteUserRequest(imageKey: string): void {
    this.userRequests.push(imageKey);
  }

  detach(imageKey: string): void {
    this.calls.push(`detach ${imageKey}`);
  }

  scrollToUnit(imageKey: string, unitKey: string): boolean {
    this.calls.push(`scroll ${imageKey} ${unitKey}`);
    return imageKey !== "unknown";
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  relayout(): void {
    this.calls.push("relayout");
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeClient implements EngineClient {
  state: EngineClientState = "idle";
  codec: Codec = "sc";
  readonly submits: ImageSubmit[] = [];
  readonly posts: CsToEngine[] = [];
  readonly forgets: string[][] = [];
  readonly handlers = new Map<string, Set<(message: EngineToCs) => void>>();
  readonly stateListeners = new Set<(state: EngineClientState) => void>();
  closed = false;

  submit(submit: ImageSubmit): void {
    this.submits.push(submit);
  }

  post(message: CsToEngine): boolean {
    this.posts.push(message);
    return this.state === "open";
  }

  on<K extends keyof EngineToCsMap>(
    type: K,
    handler: (message: { readonly type: K } & EngineToCsMap[K]) => void,
  ): () => void {
    const set = this.handlers.get(type) ?? new Set();
    this.handlers.set(type, set);
    const fn = handler as (message: EngineToCs) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  forget(imageKeys: readonly string[]): void {
    this.forgets.push([...imageKeys]);
  }

  onState(listener: (state: EngineClientState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    this.setState("dead");
  }

  setState(state: EngineClientState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }

  emit(message: EngineToCs): void {
    for (const handler of [...(this.handlers.get(message.type) ?? [])]) handler(message);
  }

  postsOf<T extends CsToEngine["type"]>(type: T): Array<Extract<CsToEngine, { type: T }>> {
    return this.posts.filter((m): m is Extract<CsToEngine, { type: T }> => m.type === type);
  }
}

function element(name: "img" | "canvas" = "img"): ImageElement {
  return {
    localName: name,
    naturalWidth: 800,
    naturalHeight: 1200,
    width: 800,
    height: 1200,
  } as unknown as ImageElement;
}

class FakeDiscovery implements Discovery {
  events: DiscoveryEvents | null = null;
  readonly images = new Map<string, TrackedImage>();
  readonly priorities = new Map<string, number>();
  readonly bySrc = new Map<string, TrackedImage>();
  readonly visible = new Set<string>();
  readonly horizons: Horizon[] = [];
  /** describe() extras per imageKey (tier B: natural null, prefetch, altSrcs). */
  readonly extras = new Map<string, Partial<SubmitBase>>();
  started = false;
  destroyed = false;

  add(imageKey: string, priority: number, el: ImageElement = element()): TrackedImage {
    const image = { imageKey, element: el };
    this.images.set(imageKey, image);
    this.priorities.set(imageKey, priority);
    this.bySrc.set(`https://cdn.example/${imageKey}.jpg`, image);
    return image;
  }

  start(): void {
    this.started = true;
    for (const image of this.images.values()) this.events?.onCandidate(image);
  }

  get(imageKey: string): TrackedImage | null {
    return this.images.get(imageKey) ?? null;
  }

  candidates(): TrackedImage[] {
    return [...this.images.values()];
  }

  onScreen(): TrackedImage[] {
    return [...this.images.values()].filter((image) => this.visible.has(image.imageKey));
  }

  priorityOf(imageKey: string): number {
    return this.priorities.get(imageKey) ?? 1e9;
  }

  describe(imageKey: string): SubmitBase | null {
    const image = this.images.get(imageKey);
    if (image === undefined) return null;
    return {
      imageKey,
      src: `https://cdn.example/${imageKey}.jpg`,
      natural: { w: 800, h: 1200 },
      displayed: { w: 720, h: 1080 },
      element: image.element.localName === "canvas" ? "canvas" : "img",
      priority: this.priorityOf(imageKey),
      pos: { docOrder: 0, srcGen: 0, yTop: 0 },
      ...this.extras.get(imageKey),
    };
  }

  setHorizon(horizon: Horizon): void {
    this.horizons.push(horizon);
  }

  findBySrc(srcUrl: string): TrackedImage | null {
    const image = this.bySrc.get(srcUrl) ?? null;
    if (image !== null && !this.images.has(image.imageKey)) {
      this.images.set(image.imageKey, image);
      this.events?.onCandidate(image);
    }
    return image;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/* ------------------------------------------------------------------ harness */

let timers: ManualTimers;
let overlay: FakeOverlay;
let client: FakeClient;
let discovery: FakeDiscovery;
let hooks: ClientHooks | null;
let reads: Array<{ src: string; options: ReadLocalOptions }>;
let readable: Set<string>;
let acks: number;
let teardowns: TeardownReason[];
let summaries: ContentSummary[];

beforeEach(() => {
  timers = new ManualTimers();
  overlay = new FakeOverlay();
  client = new FakeClient();
  discovery = new FakeDiscovery();
  hooks = null;
  reads = [];
  readable = new Set();
  acks = 0;
  teardowns = [];
  summaries = [];
});

/** A document without a window (defaultView null): no peek-key listeners. */
const NO_WINDOW = { defaultView: null } as unknown as Document;

function make(
  mode: "auto" | "manual" = "auto",
  options: { doc?: Document; settings?: unknown } = {},
): Controller {
  const createOverlay: CreateOverlay = (_doc, options, events) => {
    overlay.options = options;
    overlay.events = events;
    return overlay;
  };
  return createController({
    doc: options.doc ?? NO_WINDOW,
    mode,
    settings: migrateSettings(options.settings),
    siteEnabled: mode === "auto",
    createOverlay,
    readLocalBytes: (_element, src, options): Promise<LocalBytes | null> => {
      reads.push({ src, options });
      if (!readable.has(src)) return Promise.resolve(null);
      return Promise.resolve({
        bytes: Uint8Array.from([7, 7]).buffer,
        mime: "image/png",
        source: "cs-fetch",
      });
    },
    createDiscovery: (events) => {
      discovery.events = events;
      return discovery;
    },
    createClient: (clientHooks) => {
      hooks = clientHooks;
      return client;
    },
    clock: timers,
    ackPrivacy: () => {
      acks += 1;
      return Promise.resolve({ at: 1 });
    },
    onTeardown: (reason) => teardowns.push(reason),
    onSummary: (summary) => summaries.push(summary),
  });
}

/** Lets the async ladder-step-1 reads and submissions finish. */
async function idle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function unit(unitKey: string, status: UnitRender["status"], translation = "Chào"): UnitRender {
  return {
    unitKey,
    type: "dialogue",
    speaker: "",
    original: "안녕",
    translation,
    status,
    fit: { region: { x1: 0, y1: 0, x2: 10, y2: 10 }, shape: "ellipse", orientation: "h", glyphPx: 20 },
    erase: { kind: "none", rect: { x1: 0, y1: 0, x2: 10, y2: 10 }, bg: null, textColor: [0, 0, 0] },
  };
}

/* ------------------------------------------------------------------ pure helpers */

test("maxLocalBytes, stateInfo and isPainted", () => {
  assert.equal(maxLocalBytes("sc", 40 * 2 ** 20), WIRE_HARD_LIMIT - 64 * 1024);
  assert.equal(maxLocalBytes("sc", 1_000_000), 1_000_000);
  assert.equal(maxLocalBytes("b64", 40 * 2 ** 20), 6 * 2 ** 20 - 64 * 1024, "base64 inflates by 4/3");
  assert.deepEqual(stateInfo({}), {});
  const error = { code: "image.http" as const, message: "403", retryable: false };
  assert.deepEqual(stateInfo({ progress: { done: 1, total: 4 }, etaSec: 9, error }), {
    progress: { done: 1, total: 4 },
    etaSec: 9,
    error,
  });
  assert.equal(isPainted(unit("u", "ok")), true);
  assert.equal(isPainted(unit("u", "manual")), true);
  assert.equal(isPainted(unit("u", "ok", "  ")), false, "never paint a plate without a translation");
  assert.equal(isPainted(unit("u", "keep-original")), false);
  assert.equal(isPainted(unit("u", "untranslated")), false);
});

/* ------------------------------------------------------------------ submission */

test("auto mode: every candidate gets an overlay and is submitted in priority order, with bytes when readable", async () => {
  discovery.add("A", 2);
  discovery.add("B", 0.5);
  discovery.add("C", 5, element("canvas"));
  readable.add("https://cdn.example/A.jpg");
  const controller = make("auto");
  assert.deepEqual(overlay.options, {
    shadowMode: "open",
    mode: "auto",
    minFontPx: DEFAULT_SETTINGS.render.minFontPx,
    maxFontPx: DEFAULT_SETTINGS.render.maxFontPx,
    showDoneBadge: DEFAULT_SETTINGS.render.showDoneBadge,
    font: "patrick-hand",
    eraseSfx: false,
    sfxLabels: true,
    popupWithAltClick: true,
    target: "en",
    verticalText: "auto",
  });
  controller.start();
  assert.deepEqual(overlay.calls, ["attach A", "attach B", "attach C"]);
  await idle();
  assert.deepEqual(
    client.submits.map((s) => s.imageKey),
    ["B", "A", "C"],
  );
  const [b, a, c] = client.submits;
  assert.equal(b?.acquire, "url");
  assert.equal(a?.acquire, "bytes");
  assert.equal(a?.mime, "image/png");
  assert.equal(a?.source, "cs-fetch");
  assert.ok(a?.bytes instanceof ArrayBuffer);
  assert.equal(c?.acquire, "capture", "a canvas without local bytes cannot be fetched by URL");
  assert.equal("force" in (a ?? {}), false);
  assert.deepEqual(reads[0]?.options, {
    maxBytes: maxLocalBytes("sc", DEFAULT_SETTINGS.privacy.maxImageBytes),
    corsProbe: true,
  });
  assert.deepEqual(summaries.at(-1)?.images, { A: "submitted", B: "submitted", C: "submitted" });
});

test("manual mode: overlays only; hover requests, translate-visible and translate-image submit on demand", async () => {
  discovery.add("A", 1);
  discovery.add("B", 2);
  discovery.add("C", 3);
  discovery.visible.add("A");
  discovery.visible.add("B");
  const controller = make("manual");
  controller.start();
  await idle();
  assert.equal(client.submits.length, 0);
  assert.deepEqual(overlay.calls, ["attach A", "attach B", "attach C"]);
  assert.equal(reads.length, 0);

  overlay.events?.onTranslateRequest("A");
  await idle();
  assert.deepEqual(
    client.submits.map((s) => s.imageKey),
    ["A"],
  );
  assert.equal(reads[0]?.options.corsProbe, false, "no CORS probe on a site the user did not enable");
  assert.equal(controller.translateVisible(), 1, "A is already in progress");
  await idle();
  assert.equal(controller.translateImage("https://cdn.example/C.jpg", true), true);
  assert.equal(controller.translateImage("https://cdn.example/none.jpg", false), false);
  await idle();
  assert.deepEqual(
    client.submits.map((s) => [s.imageKey, s.force === true]),
    [
      ["A", false],
      ["B", false],
      ["C", true],
    ],
  );
});

test("translate-image on an image discovery had not tracked attaches it first", async () => {
  const late = { imageKey: "Z", element: element() };
  discovery.bySrc.set("https://cdn.example/Z.jpg", late);
  const controller = make("manual");
  controller.start();
  assert.equal(controller.translateImage("https://cdn.example/Z.jpg", false), true);
  await idle();
  assert.deepEqual(overlay.calls, ["attach Z"]);
  assert.deepEqual(
    client.submits.map((s) => s.imageKey),
    ["Z"],
  );
});

test("reread rebuilds a submit with a fresh read and keeps force; a gone image gives null", async () => {
  discovery.add("A", 1);
  readable.add("https://cdn.example/A.jpg");
  make("manual").start();
  assert.ok(hooks !== null);
  // What the engine client keeps after posting: the submit without its bytes.
  const original: ImageSubmit = {
    imageKey: "A",
    src: "https://cdn.example/A.jpg",
    natural: { w: 800, h: 1200 },
    displayed: { w: 720, h: 1080 },
    element: "img",
    priority: 1,
    pos: { docOrder: 0, srcGen: 0, yTop: 0 },
    acquire: "bytes",
  };
  const again = await hooks.reread({ ...original, force: true });
  assert.equal(again?.acquire, "bytes");
  assert.equal(again?.force, true);
  assert.ok(again?.bytes instanceof ArrayBuffer);
  assert.equal(await hooks.reread({ ...original, imageKey: "missing" }), null);
});

/* ------------------------------------------------------------------ engine → overlay */

test("engine messages reach the overlay; painted units are counted for the summary", async () => {
  discovery.add("A", 1);
  make("auto").start();
  await idle();
  client.setState("open");
  client.emit({
    type: "en:hello",
    v: 1,
    build: "b",
    probe: new ArrayBuffer(3),
    codec: "sc",
    frameKey: "1:0:D",
    status: STATUS,
  });
  client.emit({
    type: "img:units",
    imageKey: "A",
    contentKey: "s:1",
    natural: { w: 1600, h: 2400 },
    units: [],
  });
  client.emit({ type: "img:unit", imageKey: "A", unit: unit("u1", "ok") });
  client.emit({ type: "img:unit", imageKey: "A", unit: unit("u2", "untranslated", "") });
  client.emit({
    type: "img:bulk",
    imageKey: "A",
    contentKey: "s:1",
    natural: { w: 1600, h: 2400 },
    units: [unit("u3", "manual"), unit("u4", "keep-original", "안녕")],
  });
  client.emit({ type: "img:state", imageKey: "A", state: "translating", progress: { done: 2, total: 4 } });
  client.emit({ type: "img:unit", imageKey: "unknown", unit: unit("x", "ok") });
  assert.ok(overlay.calls.includes("units A 1600x2400 0"));
  assert.deepEqual(
    overlay.units.map((u) => [u.unit.unitKey, `${u.natural.w}x${u.natural.h}`]),
    [
      ["u1", "1600x2400"],
      ["u2", "1600x2400"],
      ["u3", "1600x2400"],
      ["u4", "1600x2400"],
    ],
  );
  assert.deepEqual(overlay.states.at(-1), {
    imageKey: "A",
    state: "translating",
    info: { progress: { done: 2, total: 4 } },
  });
  const last = summaries.at(-1);
  assert.equal(last?.frameKey, "1:0:D");
  assert.deepEqual(last?.painted, { A: 2 });
  assert.equal(last?.paintedTotal, 2);
  assert.equal(last?.images["A"], "translating");
});

test("img:unit before img:units falls back to the element's natural size", async () => {
  discovery.add("A", 1);
  make("auto").start();
  client.emit({ type: "img:unit", imageKey: "A", unit: unit("u1", "ok") });
  assert.deepEqual(overlay.units[0]?.natural, { w: 800, h: 1200 });
  await idle();
});

test("privacy consent: one notice per page; accepting it calls sw:ack-privacy", async () => {
  discovery.add("A", 1);
  discovery.add("B", 2);
  make("auto").start();
  await idle();
  const consent = { code: "privacy.consent" as const, message: "no consent", retryable: false };
  client.emit({ type: "img:state", imageKey: "A", state: "paused", error: consent });
  client.emit({ type: "img:state", imageKey: "B", state: "paused", error: consent });
  assert.deepEqual(
    overlay.calls.filter((c) => c.startsWith("privacy")),
    ["privacy A"],
  );
  overlay.events?.onPrivacyAccepted();
  await idle();
  assert.equal(acks, 1);
  client.emit({ type: "img:state", imageKey: "B", state: "paused", error: consent });
  assert.deepEqual(
    overlay.calls.filter((c) => c.startsWith("privacy")),
    ["privacy A", "privacy B"],
  );
});

test("privacy notice after a decline: a new user request may show it again; a state change frees it", async () => {
  discovery.add("A", 1);
  discovery.add("B", 2);
  make("manual").start();
  const consent = { code: "privacy.consent" as const, message: "no consent", retryable: false };
  overlay.events?.onTranslateRequest("A");
  await idle();
  client.emit({ type: "img:state", imageKey: "A", state: "paused", error: consent });
  // The user declined in the overlay (the controller is not told), then asks for B.
  overlay.events?.onTranslateRequest("B");
  await idle();
  client.emit({ type: "img:state", imageKey: "B", state: "paused", error: consent });
  assert.deepEqual(
    overlay.calls.filter((c) => c.startsWith("privacy")),
    ["privacy A", "privacy B"],
  );
  // B's notice goes away when B moves on; A, still waiting, may show it again.
  client.emit({
    type: "img:state",
    imageKey: "B",
    state: "error",
    error: { code: "image.http", message: "x", retryable: false },
  });
  client.emit({ type: "img:state", imageKey: "A", state: "paused", error: consent });
  assert.deepEqual(
    overlay.calls.filter((c) => c.startsWith("privacy")),
    ["privacy A", "privacy B", "privacy A"],
  );
});

test("menu and command requests tell the overlay, so a declined privacy notice may show again", async () => {
  discovery.add("A", 1);
  discovery.add("B", 2);
  const controller = make("manual");
  controller.start();
  await idle();
  assert.deepEqual(overlay.userRequests, []);
  assert.equal(controller.translateImage("https://cdn.example/A.jpg", false), true);
  assert.equal(controller.translateImage("https://cdn.example/B.jpg", true), true);
  overlay.events?.onTranslateRequest("A");
  assert.deepEqual(overlay.userRequests, ["A", "B", "A"]);
});

test("overlay events: overflow → unit:overflow; retries pick img:retry or a new submit", async () => {
  discovery.add("A", 1);
  discovery.add("B", 2);
  discovery.add("C", 3);
  make("auto").start();
  await idle();
  client.setState("open");
  overlay.events?.onOverflow("A", "u1", true);
  assert.deepEqual(client.postsOf("unit:overflow"), [
    { type: "unit:overflow", imageKey: "A", unitKey: "u1", overflow: true },
  ]);

  client.emit({ type: "img:state", imageKey: "A", state: "partial" });
  overlay.events?.onTranslateRequest("A");
  assert.deepEqual(client.postsOf("img:retry"), [{ type: "img:retry", imageKey: "A" }]);

  const unavailable = { code: "engine.unavailable" as const, message: "gave up", retryable: false };
  client.emit({ type: "img:state", imageKey: "B", state: "error", error: unavailable });
  overlay.events?.onTranslateRequest("B");
  await idle();
  const resubmitted = client.submits.filter((s) => s.imageKey === "B");
  assert.equal(resubmitted.length, 2);
  assert.equal("force" in (resubmitted[1] ?? {}), false, "the engine never saw it: a plain submit");

  client.setState("idle");
  client.emit({
    type: "img:state",
    imageKey: "C",
    state: "error",
    error: { code: "image.http", message: "403", retryable: false },
  });
  overlay.events?.onTranslateRequest("C");
  await idle();
  assert.equal(
    client.submits.filter((s) => s.imageKey === "C").at(-1)?.force,
    true,
    "not connected: forced resubmit",
  );

  client.emit({ type: "img:state", imageKey: "A", state: "done" });
  const before = client.submits.length;
  overlay.events?.onTranslateRequest("A");
  await idle();
  assert.equal(client.submits.length, before, "a finished image is not sent again without force");
});

test("stale results are re-translated (forced) on request; translate-visible leaves stale and refused images alone", async () => {
  discovery.add("A", 1);
  discovery.add("B", 2);
  discovery.add("C", 3);
  for (const key of ["A", "B", "C"]) discovery.visible.add(key);
  const controller = make("auto");
  controller.start();
  await idle();
  client.setState("open");
  client.emit({ type: "img:state", imageKey: "A", state: "stale" });
  client.emit({ type: "img:state", imageKey: "B", state: "refused" });
  client.emit({
    type: "img:state",
    imageKey: "C",
    state: "error",
    error: { code: "image.http", message: "502", retryable: true },
  });
  assert.equal(controller.translateVisible(), 1, "only the failed image is asked again");
  assert.deepEqual(client.postsOf("img:retry"), [{ type: "img:retry", imageKey: "C" }]);

  overlay.events?.onTranslateRequest("A");
  await idle();
  const resent = client.submits.filter((s) => s.imageKey === "A");
  assert.equal(resent.length, 2);
  assert.equal(resent[1]?.force, true, "img:retry would replay the stale result");
  assert.equal(client.postsOf("img:retry").length, 1);
});

test("removal detaches the overlay and forgets only submitted images", async () => {
  discovery.add("A", 1);
  make("manual").start();
  discovery.events?.onRemoved("A");
  assert.deepEqual(overlay.calls, ["attach A", "detach A"]);
  assert.equal(client.forgets.length, 0);
  discovery.add("B", 1);
  discovery.events?.onCandidate({ imageKey: "B", element: element() });
  overlay.events?.onTranslateRequest("B");
  await idle();
  discovery.events?.onRemoved("B");
  assert.deepEqual(client.forgets, [["B"]]);
  discovery.events?.onRemoved("B");
  assert.deepEqual(client.forgets, [["B"]], "unknown keys are ignored");
});

test("viewport samples go to the engine; img:priority only for active images whose priority changed", async () => {
  discovery.add("A", 1);
  discovery.add("B", 2);
  make("auto").start();
  await idle();
  client.emit({ type: "img:state", imageKey: "B", state: "done" });
  const viewport = { scrollY: 900, innerHeight: 1000, secondsPerScreen: 3.5, onScreen: ["A"] };
  discovery.events?.onViewport(viewport, [
    { imageKey: "A", priority: 0.25 },
    { imageKey: "B", priority: 0.75 },
  ]);
  discovery.events?.onViewport(viewport, [
    { imageKey: "A", priority: 0.25 },
    { imageKey: "B", priority: 0.5 },
  ]);
  assert.deepEqual(client.postsOf("cs:viewport"), [
    { type: "cs:viewport", ...viewport },
    { type: "cs:viewport", ...viewport },
  ]);
  assert.deepEqual(client.postsOf("img:priority"), [
    { type: "img:priority", items: [{ imageKey: "A", priority: 0.25 }] },
  ]);
  discovery.events?.onResize();
  assert.equal(overlay.calls.at(-1), "relayout");
});

test("img:done finishes an image; cap:prepare without a window is declined at once", async () => {
  discovery.add("A", 1);
  make("auto").start();
  await idle();
  client.emit({ type: "img:done", imageKey: "A", contentKey: "s:1", counts: { ok: 2 } });
  assert.equal(summaries.at(-1)?.images["A"], "done");
  client.emit({ type: "cap:prepare", reqId: "engine-1-x", imageKey: "A" });
  assert.deepEqual(client.postsOf("cap:fail"), [
    { type: "cap:fail", reqId: "engine-1-x", reason: "not-visible" },
  ]);
});

test("img:scroll-to (side panel 'Show') asks the overlay to scroll to the unit", async () => {
  discovery.add("A", 1);
  make("auto").start();
  await idle();
  client.emit({ type: "img:scroll-to", imageKey: "A", unitKey: "u1" });
  client.emit({ type: "img:scroll-to", imageKey: "unknown", unitKey: "u9" });
  assert.deepEqual(
    overlay.calls.filter((call) => call.startsWith("scroll")),
    ["scroll A u1", "scroll unknown u9"],
  );
});

/* ------------------------------------------------------------------ logs and teardown */

test("cs:log: batched every 2 s, ≤ 50 entries per message, ≤ 500 kept, only while connected", () => {
  const controller = make("manual");
  for (let i = 0; i < 600; i += 1) controller.log.info(`m${i}`);
  timers.advance(10 * LOG_FLUSH_MS);
  assert.equal(client.postsOf("cs:log").length, 0, "nothing is sent while not connected");
  client.setState("open");
  timers.advance(LOG_FLUSH_MS - 1);
  assert.equal(client.postsOf("cs:log").length, 0);
  timers.advance(1);
  const first = client.postsOf("cs:log")[0];
  assert.equal(first?.entries.length, LOG_BATCH);
  assert.equal(first?.entries[0]?.msg, `m${600 - LOG_KEEP}`, "the oldest entries were dropped");
  assert.equal(first?.entries[0]?.ctx, "cs");
  timers.advance(LOG_FLUSH_MS);
  assert.equal(client.postsOf("cs:log")[1]?.entries[0]?.msg, `m${600 - LOG_KEEP + LOG_BATCH}`);
  client.setState("backoff");
  timers.advance(10 * LOG_FLUSH_MS);
  assert.equal(client.postsOf("cs:log").length, 2, "the timer stops when the port goes away");
});

test("teardown: discovery, client, overlay and timers go away once; a dead client tears down the controller", async () => {
  discovery.add("A", 1);
  const controller = make("auto");
  controller.start();
  await idle();
  client.setState("open");
  controller.log.info("pending log");
  client.setState("dead");
  assert.deepEqual(teardowns, ["ctx.invalidated"]);
  assert.equal(discovery.destroyed, true);
  assert.equal(client.closed, true);
  assert.equal(overlay.destroyed, true);
  assert.equal(timers.timers.size, 0);
  assert.equal(summaries.at(-1)?.tornDown, true);
  assert.deepEqual(summaries.at(-1)?.images, {});

  controller.teardown("site-disabled");
  assert.deepEqual(teardowns, ["ctx.invalidated"], "idempotent");
  discovery.events?.onCandidate({ imageKey: "Z", element: element() });
  assert.equal(controller.translateVisible(), 0);
  assert.equal(controller.translateImage("https://cdn.example/A.jpg", false), false);
  assert.equal(controller.toggleOverlay(), false);
  assert.ok(!overlay.calls.includes("attach Z"));
});

test("toggleOverlay flips the overlay visibility", () => {
  const controller = make("auto");
  assert.equal(controller.toggleOverlay(), false);
  assert.equal(controller.toggleOverlay(), true);
});

/* ------------------------------------------------------------------ peek at the original */

type Listener = (event: unknown) => void;

/** Just enough of a window for keys.ts: capture-phase key listeners, blur, and document visibility. */
class FakeWindow {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly document = {
    visibilityState: "visible",
    listeners: new Map<string, Set<Listener>>(),
    addEventListener(type: string, listener: Listener): void {
      const set = this.listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(type, set);
    },
    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    },
  };

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  key(type: "keydown" | "keyup", code: string): void {
    const event = {
      type,
      code,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      target: null,
      composedPath: () => [],
      preventDefault: () => undefined,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** Listeners still registered on the window and its document. */
  count(): number {
    let total = 0;
    for (const set of [...this.listeners.values(), ...this.document.listeners.values()]) total += set.size;
    return total;
  }
}

function docWith(win: FakeWindow): Document {
  return { defaultView: win } as unknown as Document;
}

test("peek: holding render.peekKey hides the overlay, releasing it shows it again; teardown removes the listeners", () => {
  const win = new FakeWindow();
  const controller = make("auto", { doc: docWith(win) });
  controller.start();
  assert.ok(win.count() > 0, "key listeners installed on start");
  const peekKey = migrateSettings(undefined).render.peekKey;
  assert.notEqual(peekKey, "");

  win.key("keydown", peekKey);
  assert.equal(overlay.visible, false, "peeking at the original");
  win.key("keyup", peekKey);
  assert.equal(overlay.visible, true, "translation back");

  win.key("keydown", "KeyA");
  assert.equal(overlay.visible, true, "other keys do not peek");

  controller.teardown("site-disabled");
  assert.equal(win.count(), 0, "listeners removed on teardown");
});

test("peek: an overlay the user hid stays hidden after the peek; a custom key and no key at all", () => {
  const win = new FakeWindow();
  const controller = make("auto", { doc: docWith(win), settings: { render: { peekKey: "KeyQ" } } });
  controller.start();
  win.key("keydown", migrateSettings(undefined).render.peekKey);
  assert.equal(overlay.visible, true, "the default key no longer peeks");
  win.key("keydown", "KeyQ");
  assert.equal(overlay.visible, false);
  win.key("keyup", "KeyQ");
  assert.equal(overlay.visible, true);

  assert.equal(controller.toggleOverlay(), false);
  win.key("keydown", "KeyQ");
  win.key("keyup", "KeyQ");
  assert.equal(overlay.visible, false, "the peek does not show an overlay the user hid");
  controller.teardown("site-disabled");

  const quiet = new FakeWindow();
  make("auto", { doc: docWith(quiet), settings: { render: { peekKey: "", peekWithAlt: false } } }).start();
  assert.equal(quiet.count(), 0, "peek disabled: no listeners");
});

test("bubble popup events: an edit → unit:edit, translate again → unit:retranslate; false when not sent", async () => {
  discovery.add("A", 1);
  const controller = make("auto", { settings: { render: { font: "mali", popupWithAltClick: false } } });
  controller.start();
  await idle();
  assert.equal(overlay.options?.font, "mali");
  assert.equal(overlay.options?.popupWithAltClick, false);
  const events = overlay.events;
  assert.ok(events?.onEditUnit !== undefined && events.onRetranslateUnit !== undefined);
  assert.equal(events.onEditUnit("A", "u1", "Chào cậu"), false, "no engine connection yet");
  client.setState("open");
  assert.equal(events.onEditUnit("A", "u1", "Chào cậu"), true);
  assert.equal(events.onEditUnit("A", "u1", null), true);
  assert.equal(events.onRetranslateUnit("A", "u1"), true);
  assert.equal(events.onEditUnit("gone", "u1", "x"), false, "an image this frame does not track");
  assert.equal(events.onRetranslateUnit("gone", "u1"), false);
  assert.deepEqual(client.postsOf("unit:edit").slice(1), [
    { type: "unit:edit", imageKey: "A", unitKey: "u1", translation: "Chào cậu" },
    { type: "unit:edit", imageKey: "A", unitKey: "u1", translation: null },
  ]);
  assert.deepEqual(client.postsOf("unit:retranslate"), [
    { type: "unit:retranslate", imageKey: "A", unitKey: "u1" },
  ]);
  controller.teardown("superseded");
  assert.equal(events.onRetranslateUnit("A", "u1"), false, "after teardown");
});

/* ------------------------------------------------------------------ look-ahead and screen capture */

function waitingState(
  imageKey: string,
  state: ImageState,
  error?: { code: string; detail?: string },
): EngineToCs {
  const message = { type: "img:state", imageKey, state } as Extract<EngineToCs, { type: "img:state" }>;
  if (error !== undefined) {
    return {
      ...message,
      error: {
        code: error.code,
        message: "x",
        retryable: true,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
    } as EngineToCs;
  }
  return message;
}

test("tier B: prefetch submits skip the local read; the translate window, a load or a user request asks again", async () => {
  discovery.add("A", 0.1);
  discovery.add("L", 5);
  discovery.add("M", 20);
  discovery.add("N", 30);
  for (const key of ["L", "M", "N"]) discovery.extras.set(key, { natural: null, prefetch: true });
  readable.add("https://cdn.example/L.jpg");
  make("auto").start();
  await idle();
  assert.deepEqual(
    discovery.horizons[0],
    { screens: 15, maxImages: 25 },
    "initial detect horizon from settings",
  );
  const first = new Map(client.submits.map((s) => [s.imageKey, s]));
  assert.equal(first.get("L")?.prefetch, true);
  assert.equal(first.get("L")?.acquire, "url");
  assert.equal(first.get("A")?.prefetch, undefined);
  assert.deepEqual(
    reads.map((r) => r.src),
    ["https://cdn.example/A.jpg"],
    "no ladder-step-1 read for images without pixels",
  );
  assert.deepEqual(summaries.at(-1)?.prefetch, ["L", "M", "N"]);
  // en:horizons: the detect horizon goes to discovery; L (5 screens) is inside a 6-screen translate window.
  client.emit({ type: "en:horizons", translateScreens: 6, detectScreens: 20, detectMaxImages: 30 });
  assert.deepEqual(discovery.horizons.at(-1), { screens: 20, maxImages: 30 });
  await idle();
  const second = client.submits.slice(4);
  assert.deepEqual(
    second.map((s) => [s.imageKey, s.prefetch, s.natural, s.acquire]),
    [["L", undefined, null, "url"]],
  );
  // The reader moves: M comes into the window. N is loaded by the page.
  discovery.events?.onViewport({ scrollY: 5000, innerHeight: 1000, secondsPerScreen: 4, onScreen: [] }, [
    { imageKey: "M", priority: 4 },
    { imageKey: "N", priority: 25 },
  ]);
  discovery.extras.set("N", {});
  discovery.events?.onLoaded?.("N");
  await idle();
  assert.deepEqual(
    client.submits.slice(5).map((s) => [s.imageKey, s.prefetch]),
    [
      ["M", undefined],
      ["N", undefined],
    ],
  );
  assert.deepEqual(summaries.at(-1)?.prefetch, []);
});

test("a user request for a prefetched image asks for its translation at once", async () => {
  discovery.add("L", 9);
  discovery.extras.set("L", { natural: null, prefetch: true });
  const controller = make("auto");
  controller.start();
  await idle();
  assert.equal(client.submits[0]?.prefetch, true);
  assert.equal(controller.translateImage("https://cdn.example/L.jpg", false), true);
  await idle();
  assert.equal(client.submits.length, 2);
  assert.equal(client.submits[1]?.prefetch, undefined);
});

test("a capture that could not run is retried once the image is on screen and the reader has stopped scrolling", async () => {
  discovery.add("A", 0.2);
  make("auto").start();
  await idle();
  client.setState("open");
  const sample = (scrollY: number, onScreen: string[]): void =>
    discovery.events?.onViewport({ scrollY, innerHeight: 900, secondsPerScreen: 4, onScreen }, [
      { imageKey: "A", priority: 0.2 },
    ]);
  sample(0, []);
  client.emit(waitingState("A", "error", { code: "image.capture_unavailable", detail: "offscreen" }));
  timers.advance(5_000);
  assert.equal(client.postsOf("img:retry").length, 0, "not on screen");
  discovery.visible.add("A");
  sample(800, ["A"]);
  timers.advance(600);
  sample(900, ["A"]);
  timers.advance(1_000);
  assert.equal(client.postsOf("img:retry").length, 0, "still scrolling");
  timers.advance(900);
  assert.deepEqual(client.postsOf("img:retry"), [{ type: "img:retry", imageKey: "A" }]);
  assert.deepEqual(client.postsOf("cs:viewport").at(-1)?.onScreen, ["A"], "fresh on-screen list first");
  // Five automatic tries at most.
  for (let i = 0; i < 8; i += 1) {
    client.emit(waitingState("A", "error", { code: "image.capture_unavailable", detail: "interrupted" }));
    timers.advance(2_000);
  }
  assert.equal(client.postsOf("img:retry").length, 5);
  // A refusal (tab hidden, site off) is never retried automatically.
  discovery.add("B", 0.5);
  discovery.events?.onCandidate({ imageKey: "B", element: element() });
  await idle();
  discovery.visible.add("B");
  client.emit(waitingState("B", "error", { code: "image.capture_blocked", detail: "hidden" }));
  timers.advance(5_000);
  assert.equal(client.postsOf("img:retry").filter((m) => m.imageKey === "B").length, 0);
  assert.equal(summaries.at(-1)?.errors["B"], "image.capture_blocked");
});

test("a capture retry after the port went idle is a new submit (it reconnects; the engine restarts the image)", async () => {
  discovery.add("A", 0.2);
  make("auto").start();
  await idle();
  assert.equal(client.submits.length, 1);
  client.setState("idle"); // nothing pending for 5 s: the port closed
  discovery.visible.add("A");
  client.emit(waitingState("A", "error", { code: "image.capture_unavailable", detail: "offscreen" }));
  timers.advance(1_300);
  await idle();
  assert.equal(client.postsOf("img:retry").length, 1, "tried first");
  assert.equal(client.submits.length, 2, "then submitted again");
  assert.equal(client.submits[1]?.imageKey, "A");
  assert.equal(client.submits[1]?.force, undefined, "not a forced re-translation");
});

test("img:units from a screen capture marks the image lowRes; cap:done is handled", async () => {
  discovery.add("A", 0.2);
  make("auto").start();
  await idle();
  client.emit({
    type: "img:units",
    imageKey: "A",
    contentKey: "s:1",
    natural: { w: 600, h: 900 },
    units: [],
    lowRes: true,
  });
  assert.deepEqual(summaries.at(-1)?.lowRes, ["A"]);
  client.emit({ type: "cap:done", reqId: "nobody" });
  assert.equal(summaries.at(-1)?.tornDown, false);
});

test("lettering target: resolved like the engine (setting, UI language, browser languages); verticalText passed", () => {
  make("auto", { settings: { translate: { targetLang: "ja" }, render: { verticalText: "never" } } });
  assert.equal(overlay.options?.target, "ja");
  assert.equal(overlay.options?.verticalText, "never");
  make("auto", { settings: { translate: { targetLang: "auto" }, ui: { locale: "zh-tw" } } });
  assert.equal(overlay.options?.target, "zh-tw");
  const doc = { defaultView: { navigator: { languages: ["ko-KR", "en-US"] } } } as unknown as Document;
  make("auto", { doc, settings: { translate: { targetLang: "auto" } } });
  assert.equal(overlay.options?.target, "ko");
});
