// Content entry (main.ts): mode choice, site-key lookup, gates, the supersede/orphan handshake and the boot
// sequence with a fake environment. overlay/index.ts and acquire-local.ts (other modules, DOM-bound) are replaced
// by stubs through module hooks, so this file loads main.ts without a browser.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";
import type { Controller } from "../../../src/content/controller.ts";
import type { CommandTarget, TeardownReason } from "../../../src/content/messages.ts";
import type { BootEnv, StartConfig } from "../../../src/content/main.ts";
import type { SiteSettings } from "../../../src/shared/settings.ts";

const STUBS: Record<string, string> = {
  "./overlay/index.ts": "export const createOverlay = () => { throw new Error('overlay stub'); };",
  "./acquire-local.ts": "export const readLocalBytes = () => Promise.resolve(null);",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub !== undefined && context.parentURL?.endsWith("/src/content/main.ts") === true) {
      return { url: `ctv-stub:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("ctv-stub:")) {
      return { format: "module", source: STUBS[url.slice("ctv-stub:".length)] ?? "", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const main = await import("../../../src/content/main.ts");
const { ALIVE_ATTR, HOST_SELECTOR, MANUAL_FLAG_TTL_MS } = main;

const NOW = 1_800_000_000_000;

function site(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    enabled: true,
    mode: "auto",
    includeSubdomains: false,
    credentials: "omit",
    referer: "auto",
    sourceLang: "auto",
    layout: "webtoon",
    extraFrameOrigins: [],
    prefetchAhead: true,
    addedAt: 1,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ pure decisions */

test("manual flag: fresh for 10 s (with a little clock skew), ignored otherwise", () => {
  assert.equal(main.isManualFlagFresh(NOW - 1, NOW), true);
  assert.equal(main.isManualFlagFresh(NOW - MANUAL_FLAG_TTL_MS + 1, NOW), true);
  assert.equal(main.isManualFlagFresh(NOW - MANUAL_FLAG_TTL_MS, NOW), false);
  assert.equal(main.isManualFlagFresh(NOW + 500, NOW), true);
  assert.equal(main.isManualFlagFresh(NOW + 5_000, NOW), false);
  assert.equal(main.isManualFlagFresh(undefined, NOW), false);
  assert.equal(main.isManualFlagFresh(String(NOW), NOW), false);
  assert.equal(main.isManualFlagFresh(Number.NaN, NOW), false);
});

test("chooseMode: manual flag, else the enabled site's mode, else exit", () => {
  assert.equal(main.chooseMode({ manualFlag: NOW, now: NOW, site: null }), "manual");
  assert.equal(main.chooseMode({ manualFlag: NOW, now: NOW, site: site() }), "manual");
  assert.equal(main.chooseMode({ manualFlag: undefined, now: NOW, site: site() }), "auto");
  assert.equal(
    main.chooseMode({ manualFlag: undefined, now: NOW, site: site({ mode: "manual" }) }),
    "manual",
  );
  assert.equal(main.chooseMode({ manualFlag: undefined, now: NOW, site: site({ enabled: false }) }), null);
  assert.equal(main.chooseMode({ manualFlag: NOW - 60_000, now: NOW, site: null }), null);
});

test("pickSite: extraFrameOrigins cover a reader iframe from another origin; an own record wins even when off", () => {
  const host = { "site:https://host.example": site({ extraFrameOrigins: ["https://frames.example"] }) };
  assert.deepEqual(main.pickSite("https://frames.example", host, NOW)?.extraFrameOrigins, [
    "https://frames.example",
  ]);
  const covered = {
    "site:https://comic.example": site({ includeSubdomains: true }),
    "site:https://m.comic.example": site({ enabled: false }),
  };
  const own = main.pickSite("https://m.comic.example", covered, NOW);
  assert.equal(own?.enabled, false, "the frame's own (disabled) record, not the parent's");
  assert.equal(main.chooseMode({ manualFlag: undefined, now: NOW, site: own }), null);
  assert.equal(main.pickSite("https://img.comic.example", covered, NOW)?.includeSubdomains, true);
  assert.equal(main.pickSite("http://127.0.0.1:8080", covered, NOW), null);
  assert.equal(main.pickSite("null", host, NOW), null, "opaque origins have no site");
  assert.equal(main.pickSite("file:///C:/a.html", host, NOW), null);
});

test("pickSite: the frame's own record wins; a parent counts only with includeSubdomains", () => {
  const origin = "https://m.comic.example";
  assert.equal(main.pickSite(origin, {}, NOW), null);
  const own = main.pickSite(origin, { "site:https://m.comic.example": { enabled: false } }, NOW);
  assert.equal(own?.enabled, false);
  assert.equal(own?.addedAt, NOW, "migrated with defaults");
  assert.equal(main.pickSite(origin, { "site:https://comic.example": site() }, NOW), null);
  const parent = main.pickSite(
    origin,
    { "site:https://comic.example": site({ includeSubdomains: true }) },
    NOW,
  );
  assert.equal(parent?.enabled, true);
  assert.equal(parent?.layout, "webtoon");
});

test("gatesFor: prerendering always waits; auto mode on a never-seen page waits for visibility", () => {
  const base = { mode: "auto" as const, translateHiddenTabs: false, prerendering: false, visible: true };
  assert.deepEqual(main.gatesFor(base), { prerender: false, visible: false });
  assert.deepEqual(main.gatesFor({ ...base, visible: false }), { prerender: false, visible: true });
  assert.deepEqual(main.gatesFor({ ...base, visible: false, translateHiddenTabs: true }), {
    prerender: false,
    visible: false,
  });
  assert.deepEqual(main.gatesFor({ ...base, mode: "manual", visible: false }), {
    prerender: false,
    visible: false,
  });
  assert.deepEqual(main.gatesFor({ ...base, prerendering: true, visible: false }), {
    prerender: true,
    visible: true,
  });
});

test("randomHex and pageHints", () => {
  assert.equal(
    main.randomHex(4, (bytes) => bytes.fill(171)),
    "abababab",
  );
  assert.match(main.randomHex(8), /^[0-9a-f]{16}$/);
  const doc = { title: "Ch. 3", visibilityState: "hidden" } as Document;
  assert.deepEqual(main.pageHints(doc, { devicePixelRatio: 1.25 }, site()), {
    title: "Ch. 3",
    layout: "webtoon",
    visible: false,
    dpr: 1.25,
  });
  assert.equal(main.pageHints(doc, { devicePixelRatio: 0 }, null).layout, "auto");
  assert.equal(main.pageHints(doc, { devicePixelRatio: 0 }, null).dpr, 1);
});

/* ------------------------------------------------------------------ handshake */

class FakeHost {
  removed = false;
  remove(): void {
    this.removed = true;
  }
}

/** Enough of a Document for main.ts: events, the alive attribute, overlay hosts, visibility. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  prerendering = false;
  title = "Chapter";
  readonly attributes = new Map<string, string>();
  readonly hosts: FakeHost[] = [];
  readonly documentElement = {
    getAttribute: (name: string): string | null => this.attributes.get(name) ?? null,
    setAttribute: (name: string, value: string): void => {
      this.attributes.set(name, value);
    },
    removeAttribute: (name: string): void => {
      this.attributes.delete(name);
    },
  };

  querySelectorAll(selector: string): FakeHost[] {
    return selector === HOST_SELECTOR ? this.hosts.filter((host) => !host.removed) : [];
  }

  asDocument(): Document {
    return this as unknown as Document;
  }

  change(type: "visibilitychange" | "prerenderingchange", update: () => void): void {
    update();
    this.dispatchEvent(new Event(type));
  }
}

test("handshake: a healthy instance makes newcomers exit; an orphan tears down and lets them in", () => {
  const doc = new FakeDocument();
  let firstValid = true;
  let orphaned = 0;
  const first = main.handshake(
    doc.asDocument(),
    "aaa",
    () => firstValid,
    () => (orphaned += 1),
  );
  assert.equal(first.proceed, true);

  const second = main.handshake(
    doc.asDocument(),
    "bbb",
    () => true,
    () => undefined,
  );
  assert.equal(second.proceed, false, "the first instance answered the probe");
  assert.equal(doc.attributes.has(ALIVE_ATTR), false, "the newcomer clears the marker it read");

  firstValid = false;
  const third = main.handshake(
    doc.asDocument(),
    "ccc",
    () => true,
    () => undefined,
  );
  assert.equal(third.proceed, true, "an orphan does not answer");
  assert.equal(orphaned, 1);

  first.dispose();
  third.dispose();
  assert.equal(
    main.handshake(
      doc.asDocument(),
      "ddd",
      () => true,
      () => undefined,
    ).proceed,
    true,
  );
  doc.dispatchEvent(new CustomEvent("ctv:probe", { detail: { not: "a string" } }));
  assert.equal(doc.attributes.has(ALIVE_ATTR), false, "non-string details are ignored");
});

test("removeStaleHosts removes every overlay host left in the page", () => {
  const doc = new FakeDocument();
  doc.hosts.push(new FakeHost(), new FakeHost());
  assert.equal(main.removeStaleHosts(doc.asDocument()), 2);
  assert.equal(
    doc.hosts.every((host) => host.removed),
    true,
  );
});

/* ------------------------------------------------------------------ boot */

class FakeController implements Pick<
  Controller,
  "start" | "teardown" | "toggleOverlay" | "translateVisible" | "translateImage"
> {
  readonly calls: string[] = [];
  readonly teardowns: TeardownReason[] = [];
  onTeardown: ((reason: TeardownReason) => void) | null = null;

  start(): void {
    this.calls.push("start");
  }

  teardown(reason: TeardownReason): void {
    if (this.teardowns.length > 0) return;
    this.teardowns.push(reason);
    this.onTeardown?.(reason);
  }

  toggleOverlay(): boolean {
    this.calls.push("toggle");
    return false;
  }

  translateVisible(): number {
    this.calls.push("visible");
    return 2;
  }

  translateImage(srcUrl: string, force: boolean): boolean {
    this.calls.push(`image ${srcUrl} ${String(force)}`);
    return true;
  }
}

interface BootHarness {
  doc: FakeDocument;
  env: BootEnv;
  storage: Record<string, unknown>;
  starts: StartConfig[];
  controller: FakeController;
  target: CommandTarget | null;
  unlistened: number;
  /** readStorage() calls. */
  reads: number;
  valid: boolean;
  manualFlag: unknown;
  storageError: Error | null;
}

let h: BootHarness;

function makeHarness(doc = new FakeDocument()): BootHarness {
  const harness: BootHarness = {
    doc,
    env: null as unknown as BootEnv,
    storage: {},
    starts: [],
    controller: new FakeController(),
    target: null,
    unlistened: 0,
    reads: 0,
    valid: true,
    manualFlag: undefined,
    storageError: null,
  };
  harness.env = {
    doc: doc.asDocument(),
    origin: "https://reader.example",
    now: () => NOW,
    takeManualFlag: () => harness.manualFlag,
    readStorage: () => {
      harness.reads += 1;
      return harness.storageError === null
        ? Promise.resolve(harness.storage)
        : Promise.reject(harness.storageError);
    },
    isContextValid: () => harness.valid,
    listen: (target) => {
      harness.target = target;
      return () => {
        harness.unlistened += 1;
      };
    },
    start: (config) => {
      harness.starts.push(config);
      harness.controller.onTeardown = config.onTeardown;
      return harness.controller as unknown as Controller;
    },
  };
  return harness;
}

beforeEach(() => {
  h = makeHarness();
});

async function ticks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test("boot: an enabled auto site starts the controller with migrated settings; commands reach it", async () => {
  h.storage = { "site:https://reader.example": site(), settings: { discovery: { minNaturalSide: 400 } } };
  assert.equal(await main.bootContentScript(h.env), "started");
  assert.equal(h.reads, 1, "one read of the whole storage (settings and every site)");
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0]?.mode, "auto");
  assert.equal(h.starts[0]?.settings.discovery.minNaturalSide, 400);
  assert.equal(h.starts[0]?.site?.layout, "webtoon");
  assert.deepEqual(h.controller.calls, ["start"]);
  assert.ok(h.target !== null);
  assert.equal(await h.target.translateVisible(), 2);
  assert.equal(await h.target.translateImage("https://cdn.example/1.jpg", true), true);
  assert.deepEqual(h.controller.calls, ["start", "visible", "image https://cdn.example/1.jpg true"]);
});

test("boot: a reader iframe from another origin starts with the site that lists it in extraFrameOrigins", async () => {
  h.env = { ...h.env, origin: "https://frames.example" };
  h.storage = { "site:https://reader.example": site({ extraFrameOrigins: ["https://frames.example"] }) };
  assert.equal(await main.bootContentScript(h.env), "started");
  assert.equal(h.starts[0]?.mode, "auto");
  assert.equal(h.starts[0]?.site?.extraFrameOrigins[0], "https://frames.example");
});

test("boot: a fresh manual flag starts manual mode on a site that is not enabled", async () => {
  h.manualFlag = NOW - 2_000;
  assert.equal(await main.bootContentScript(h.env), "started");
  assert.equal(h.starts[0]?.mode, "manual");
  assert.equal(h.starts[0]?.site, null);
});

test("boot: a frame whose site is not enabled exits quietly and stops answering", async () => {
  h.storage = { "site:https://reader.example": site({ enabled: false }) };
  assert.equal(await main.bootContentScript(h.env), "not-enabled");
  assert.equal(h.starts.length, 0);
  assert.equal(h.unlistened, 1, "command handlers removed");
  const next = makeHarness(h.doc);
  next.storage = { "site:https://reader.example": site() };
  assert.equal(
    await main.bootContentScript(next.env),
    "started",
    "the exited instance no longer answers probes",
  );
});

test("boot: a second injection into a healthy frame exits before touching storage", async () => {
  h.storage = { "site:https://reader.example": site() };
  assert.equal(await main.bootContentScript(h.env), "started");
  const second = makeHarness(h.doc);
  assert.equal(await main.bootContentScript(second.env), "superseded");
  assert.equal(second.reads, 0);
  assert.equal(second.target, null);
});

test("boot: after an extension reload the orphan tears down and the newcomer removes its stale hosts", async () => {
  h.storage = { "site:https://reader.example": site() };
  assert.equal(await main.bootContentScript(h.env), "started");
  h.doc.hosts.push(new FakeHost());
  h.valid = false; // the extension was reloaded: the first instance is an orphan now

  const next = makeHarness(h.doc);
  next.storage = { "site:https://reader.example": site() };
  assert.equal(await main.bootContentScript(next.env), "started");
  assert.deepEqual(h.controller.teardowns, ["ctx.invalidated"]);
  assert.equal(h.unlistened, 1);
  assert.equal(h.doc.hosts[0]?.removed, true);
});

test("boot: prerendering and hidden pages wait for their gates; teardown while waiting stops the boot", async () => {
  h.storage = { "site:https://reader.example": site() };
  h.doc.prerendering = true;
  h.doc.visibilityState = "hidden";
  const booting = main.bootContentScript(h.env);
  await ticks();
  assert.equal(h.starts.length, 0, "nothing starts while prerendering");
  h.doc.change("prerenderingchange", () => {
    h.doc.prerendering = false;
  });
  await ticks();
  assert.equal(h.starts.length, 0, "auto mode also waits for the first visibility");
  h.doc.change("visibilitychange", () => {
    h.doc.visibilityState = "visible";
  });
  assert.equal(await booting, "started");

  const hidden = makeHarness();
  hidden.storage = { "site:https://reader.example": site() };
  hidden.doc.visibilityState = "hidden";
  const waiting = main.bootContentScript(hidden.env);
  await ticks();
  hidden.target?.teardown("site-disabled");
  assert.equal(await waiting, "stopped");
  assert.equal(hidden.starts.length, 0);
  assert.equal(await hidden.target?.toggleOverlay(), false, "commands after teardown get a neutral answer");
});

test("boot: hidden tabs start at once when translateHiddenTabs is on, and manual mode never waits", async () => {
  h.storage = {
    "site:https://reader.example": site(),
    settings: { discovery: { translateHiddenTabs: true } },
  };
  h.doc.visibilityState = "hidden";
  assert.equal(await main.bootContentScript(h.env), "started");
  const manual = makeHarness();
  manual.doc.visibilityState = "hidden";
  manual.manualFlag = NOW;
  assert.equal(await main.bootContentScript(manual.env), "started");
});

test("boot: an orphan whose storage read fails leaves quietly; a real start failure is reported in dev", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  h.storageError = new Error("Extension context invalidated.");
  h.valid = false;
  assert.equal(await main.bootContentScript(h.env), "stopped");
  assert.equal(h.starts.length, 0);
  assert.equal(h.unlistened, 1);
  assert.equal(warn.mock.callCount(), 0, "orphans stay silent (P1-04b)");

  const broken = makeHarness();
  broken.storage = { "site:https://reader.example": site() };
  broken.env = {
    ...broken.env,
    start: () => {
      throw new Error("overlay failed");
    },
  };
  assert.equal(await main.bootContentScript(broken.env), "stopped");
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(broken.unlistened, 1);
});

test("boot: a listener that cannot be installed ends the boot without a rejection", async () => {
  h.storage = { "site:https://reader.example": site() };
  h.valid = false;
  h.env = {
    ...h.env,
    listen: () => {
      throw new Error("Extension context invalidated.");
    },
  };
  assert.equal(await main.bootContentScript(h.env), "stopped");
  assert.equal(h.starts.length, 0);
});

test("boot: a teardown from the controller itself also removes the entry's listeners", async () => {
  h.storage = { "site:https://reader.example": site() };
  await main.bootContentScript(h.env);
  h.controller.teardown("ctx.invalidated");
  assert.equal(h.unlistened, 1);
  const next = makeHarness(h.doc);
  next.storage = { "site:https://reader.example": site() };
  assert.equal(
    await main.bootContentScript(next.env),
    "started",
    "the torn-down instance stopped answering probes",
  );
});
