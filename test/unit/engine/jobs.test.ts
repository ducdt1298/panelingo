import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  attachJob,
  cleanGeometry,
  countStatuses,
  createJobTable,
  createWorkTable,
  detachJob,
  displayStatus,
  errorInfo,
  fitRegion,
  needsPass,
  newSlot,
  newWork,
  progressOf,
  scriptOf,
  setUnits,
  slotFromRecord,
  terminalError,
  terminalState,
  unitRender,
  viewOf,
  viewSignature,
  type GateView,
  type ImageJob,
  type UnitSlot,
} from "../../../src/engine/jobs.ts";
import type { ImageSubmit } from "../../../src/shared/protocol.ts";
import type { TranslationRecord } from "../../../src/shared/records.ts";
import type { UnitGeometry, UnitStatus } from "../../../src/shared/types.ts";
import { isWireSafe } from "../../../src/shared/wire.ts";

const OPEN: GateView = { privacy: null, health: null };

function bubbleUnit(key: string, order = 0): UnitGeometry {
  return {
    unitKey: key,
    kind: "bubble",
    bubble: { x1: 100, y1: 100, x2: 300, y2: 260 },
    text: { x1: 140, y1: 130, x2: 260, y2: 230 },
    texts: [{ x1: 140, y1: 130, x2: 260, y2: 230 }],
    orientation: "h",
    glyphPx: 24,
    order,
  };
}

function freeUnit(key: string, order = 0): UnitGeometry {
  return {
    unitKey: key,
    kind: "free",
    bubble: null,
    text: { x1: 0, y1: 10, x2: 100, y2: 50 },
    texts: [{ x1: 0, y1: 10, x2: 100, y2: 50 }],
    orientation: "v",
    glyphPx: 18,
    order,
  };
}

function record(unitKey: string, patch: Partial<TranslationRecord> = {}): TranslationRecord {
  return {
    contentKey: "s:abc",
    unitKey,
    seriesKey: null,
    type: "dialogue",
    speaker: "A",
    original: "안녕",
    translation: "Chào",
    manualTranslation: null,
    manual: 0,
    status: "ok",
    lang: "ko",
    model: "azure-gpt-5.2",
    promptVersion: 1,
    attempts: 1,
    updatedAt: 500,
    lastUsedAt: 500,
    ...patch,
  };
}

function submitOf(imageKey: string): ImageSubmit {
  return {
    imageKey,
    src: `https://cdn.example/${imageKey}.jpg`,
    natural: { w: 800, h: 1200 },
    displayed: { w: 400, h: 600 },
    element: "img",
    priority: 0,
    pos: { docOrder: 0, srcGen: 0, yTop: 0 },
    acquire: "url",
  };
}

function slotWith(status: UnitSlot["status"], manual: string | null = null): UnitSlot {
  const slot = newSlot(bubbleUnit(`k-${status}`));
  slot.status = status;
  slot.manual = manual;
  return slot;
}

describe("terminal state and badge error (A.7)", () => {
  const cases: Array<[Partial<Record<UnitStatus, number>>, number, string]> = [
    [{}, 0, "no-text"],
    [{ ok: 3 }, 3, "done"],
    [{ ok: 1, manual: 1, "keep-original": 1, ignored: 1 }, 4, "done"],
    [{ ok: 2, untranslated: 1 }, 3, "partial"],
    [{ refused: 3 }, 3, "refused"],
    [{ refused: 2, "keep-original": 1 }, 3, "refused"],
    [{ error: 3 }, 3, "error"],
    [{ error: 2, ignored: 1 }, 3, "error"],
    [{ error: 1, refused: 1 }, 2, "partial"],
    [{ untranslated: 2 }, 2, "partial"],
    [{ ok: 1, pending: 1 }, 2, "partial"],
  ];
  for (const [counts, total, expected] of cases) {
    test(`${JSON.stringify(counts)} → ${expected}`, () => {
      assert.equal(terminalState(counts, total), expected);
    });
  }

  test("terminalError explains partial, refused and error states", () => {
    const upstream = errorInfo("api.upstream", "502");
    assert.equal(terminalError("done", { ok: 1 }, null), null);
    assert.equal(terminalError("no-text", {}, null), null);
    assert.equal(terminalError("partial", { ok: 1, untranslated: 1 }, upstream)?.code, "llm.missing");
    assert.equal(terminalError("partial", { ok: 1, error: 1 }, upstream)?.code, "api.upstream");
    assert.equal(terminalError("partial", { ok: 1, refused: 1 }, null)?.code, "llm.refused");
    assert.equal(terminalError("refused", { refused: 2 }, null)?.code, "llm.refused");
    assert.equal(terminalError("error", { error: 2 }, upstream), upstream);
    assert.equal(terminalError("error", { error: 2 }, null)?.code, "llm.missing");
  });

  test("errorInfo takes retryable from the error registry", () => {
    assert.equal(errorInfo("api.bad_request", "x").retryable, false);
    assert.equal(errorInfo("privacy.consent", "x").retryable, true);
  });
});

describe("unit slots from stored records", () => {
  test("no record or a non-final status leaves the unit pending", () => {
    assert.equal(slotFromRecord("s:abc", bubbleUnit("a"), undefined).status, "pending");
    for (const status of ["pending", "translating", "stale"] as const) {
      const slot = slotFromRecord("s:abc", bubbleUnit("a"), record("a", { status }));
      assert.equal(slot.status, "pending");
      assert.equal(needsPass(slot), true);
    }
  });

  test("an AI record restores its outcome; text only for ok", () => {
    const ok = slotFromRecord("s:abc", bubbleUnit("a"), record("a"));
    assert.equal(ok.status, "ok");
    assert.equal(ok.result?.translation, "Chào");
    assert.equal(ok.attempts, 1);
    const kept = slotFromRecord(
      "s:abc",
      bubbleUnit("a"),
      record("a", { status: "keep-original", translation: "x" }),
    );
    assert.equal(kept.status, "keep-original");
    assert.equal(kept.result?.translation, "");
    assert.equal(kept.result?.model, "azure-gpt-5.2");
  });

  test("failed outcomes seed the automatic-pass history with their time", () => {
    const failed = slotFromRecord(
      "s:abc",
      bubbleUnit("a"),
      record("a", { status: "untranslated", translation: "" }),
    );
    assert.deepEqual(failed.autoPasses, [500]);
    assert.deepEqual(
      slotFromRecord("s:abc", bubbleUnit("a"), record("a", { status: "error" })).autoPasses,
      [500],
    );
  });

  test("a manual edit wins; the AI text underneath is kept", () => {
    const edited = slotFromRecord(
      "s:abc",
      bubbleUnit("a"),
      record("a", { manualTranslation: "Xin chào", manual: 1, status: "manual" }),
    );
    assert.equal(displayStatus(edited), "manual");
    assert.equal(edited.status, "ok");
    assert.equal(edited.result?.translation, "Chào");
    const before = slotFromRecord(
      "s:abc",
      bubbleUnit("a"),
      record("a", { manualTranslation: "Tự dịch", manual: 1, status: "manual", translation: "" }),
    );
    assert.equal(before.status, "pending");
    assert.equal(displayStatus(before), "manual");
    assert.equal(needsPass(before), false);
    const blank = slotFromRecord(
      "s:abc",
      bubbleUnit("a"),
      record("a", { manualTranslation: "  ", manual: 1 }),
    );
    assert.equal(blank.manual, null);
  });
});

describe("UnitRender", () => {
  test("before its erase patch a bubble fits in its box as an ellipse, with a plate over its text box", () => {
    const slot = slotFromRecord("s:abc", bubbleUnit("a"), record("a"));
    const render = unitRender(slot, { w: 800, h: 1200 });
    assert.deepEqual(render, {
      unitKey: "a",
      type: "dialogue",
      speaker: "A",
      original: "안녕",
      translation: "Chào",
      status: "ok",
      fit: {
        region: { x1: 100, y1: 100, x2: 300, y2: 260 },
        shape: "ellipse",
        orientation: "h",
        glyphPx: 24,
        script: "hangul",
      },
      erase: {
        kind: "box",
        rect: { ...bubbleUnit("a").text },
        bg: null,
        textColor: [0, 0, 0],
      },
    });
    assert.deepEqual(isWireSafe(render), { ok: true });
  });

  test("free text fits in its text box grown a little and clipped to the image, as a rect", () => {
    const render = unitRender(newSlot(freeUnit("f")), { w: 800, h: 1200 });
    // short side 40 → grow 4 px; x1 and the top are clipped at 0
    assert.deepEqual(render.fit, {
      region: { x1: 0, y1: 6, x2: 104, y2: 54 },
      shape: "rect",
      orientation: "v",
      glyphPx: 18,
      script: "cjk",
    });
    assert.deepEqual(render.erase.rect, freeUnit("f").text);
  });

  test("text whose bubble outline was missed grows by 15% of its short side, still an ellipse", () => {
    const unit: UnitGeometry = { ...bubbleUnit("o"), bubble: null };
    assert.deepEqual(fitRegion(unit, null), { x1: 125, y1: 115, x2: 275, y2: 245 });
    assert.equal(unitRender(newSlot(unit), null).fit.shape, "ellipse");
  });

  test("only ok and manual carry text; pending units carry no vi", () => {
    const refused = slotWith("refused");
    refused.result = {
      contentKey: "s:abc",
      unitKey: "k",
      status: "refused",
      type: "dialogue",
      speaker: "",
      original: "x",
      translation: "should not leak",
      lang: null,
      model: null,
    };
    assert.equal(unitRender(refused, null).translation, "");
    assert.equal(unitRender(slotWith("pending"), null).translation, "");
    assert.equal(unitRender(slotWith("pending"), null).status, "pending");
    const manual = slotWith("untranslated", "Bản sửa");
    assert.deepEqual(
      [unitRender(manual, null).status, unitRender(manual, null).translation],
      ["manual", "Bản sửa"],
    );
  });

  test("seam info is passed through", () => {
    const unit: UnitGeometry = { ...bubbleUnit("s"), seam: { seamId: "seam-1", part: "upper" } };
    assert.deepEqual(unitRender(newSlot(unit), null).seam, { seamId: "seam-1", part: "upper" });
  });

  test("cleanGeometry keeps only wire fields", () => {
    const noisy = {
      ...bubbleUnit("n"),
      score: 0.9,
      edge: null,
      edgeSmall: true,
    } as UnitGeometry & { score: number; edge: null };
    const clean = cleanGeometry(noisy);
    assert.deepEqual(Object.keys(clean).sort(), [
      "bubble",
      "edgeSmall",
      "glyphPx",
      "kind",
      "order",
      "orientation",
      "text",
      "texts",
      "unitKey",
    ]);
    const withUndefined = { ...bubbleUnit("u"), seam: undefined } as unknown as UnitGeometry;
    assert.deepEqual(isWireSafe(cleanGeometry(withUndefined)), { ok: true });
  });
});

describe("work state", () => {
  test("setUnits orders by reading order, drops duplicate keys and resolves stored units", () => {
    const work = newWork("s:abc", 0);
    setUnits(work, [bubbleUnit("b", 1), bubbleUnit("a", 0), bubbleUnit("a", 2)], [record("b")]);
    assert.equal(work.phase, "ready");
    assert.deepEqual(
      work.units.map((u) => u.unitKey),
      ["a", "b"],
    );
    assert.deepEqual([...work.slots.keys()], ["a", "b"]);
    assert.equal(work.slots.get("b")?.status, "ok");
    assert.deepEqual(progressOf(work), { done: 1, total: 2 });
    assert.deepEqual(countStatuses(work), { pending: 1, ok: 1 });
  });
});

describe("image views", () => {
  function attached(): { job: ImageJob; work: ReturnType<typeof newWork> } {
    const job = createJobTable().create("1:0:D", "1.0", submitOf("1.0"), null);
    const work = newWork("s:abc", 0);
    attachJob(job, work);
    return { job, work };
  }

  test("job phases before the work: queued, acquiring, failed with its error", () => {
    const table = createJobTable();
    const job = table.create("1:0:D", "1.0", submitOf("1.0"), null);
    assert.deepEqual(viewOf(job, OPEN), { state: "queued" });
    job.phase = "acquiring";
    assert.deepEqual(viewOf(job, OPEN), { state: "acquiring" });
    job.phase = "failed";
    job.error = errorInfo("image.http", "403");
    assert.deepEqual(viewOf(job, OPEN), { state: "error", error: job.error });
  });

  test("detecting, then no-text for an image without units", () => {
    const { job, work } = attached();
    assert.deepEqual(viewOf(job, OPEN), { state: "detecting" });
    setUnits(work, []);
    assert.deepEqual(viewOf(job, OPEN), { state: "no-text", progress: { done: 0, total: 0 } });
  });

  test("waiting until a pack is in flight, then translating, with progress", () => {
    const { job, work } = attached();
    setUnits(work, [bubbleUnit("a", 0), bubbleUnit("b", 1)]);
    const pack = { unitKeys: ["a", "b"], started: false };
    work.packs.add(pack);
    assert.deepEqual(viewOf(job, OPEN), { state: "waiting", progress: { done: 0, total: 2 } });
    pack.started = true;
    const slot = work.slots.get("a");
    if (slot !== undefined) slot.status = "ok";
    assert.deepEqual(viewOf(job, OPEN), { state: "translating", progress: { done: 1, total: 2 } });
  });

  test("the privacy gate pauses unsent work only; the health gate pauses in-flight work too", () => {
    const { job, work } = attached();
    setUnits(work, [bubbleUnit("a")]);
    const pack = { unitKeys: ["a"], started: false };
    work.packs.add(pack);
    const privacy = errorInfo("privacy.consent", "not confirmed");
    const health = errorInfo("api.unauthorized", "login");
    assert.deepEqual(viewOf(job, { privacy, health: null }), {
      state: "paused",
      progress: { done: 0, total: 1 },
      error: privacy,
    });
    pack.started = true;
    assert.equal(viewOf(job, { privacy, health: null }).state, "translating");
    assert.deepEqual(viewOf(job, { privacy: null, health }), {
      state: "paused",
      progress: { done: 0, total: 1 },
      error: health,
    });
  });

  test("a settled work shows its terminal state with the explaining error", () => {
    const { job, work } = attached();
    setUnits(work, [bubbleUnit("a", 0), bubbleUnit("b", 1)]);
    const [a, b] = [work.slots.get("a"), work.slots.get("b")];
    if (a === undefined || b === undefined) throw new Error("slots");
    a.status = "ok";
    b.status = "untranslated";
    const view = viewOf(job, OPEN);
    assert.equal(view.state, "partial");
    assert.equal(view.error?.code, "llm.missing");
    b.manual = "Sửa tay";
    assert.deepEqual(viewOf(job, OPEN), { state: "done", progress: { done: 2, total: 2 } });
  });

  test("viewSignature changes with state, progress and error", () => {
    const a = viewSignature({ state: "translating", progress: { done: 1, total: 3 } });
    const b = viewSignature({ state: "translating", progress: { done: 2, total: 3 } });
    const c = viewSignature({
      state: "paused",
      progress: { done: 2, total: 3 },
      error: errorInfo("cancelled", "x"),
    });
    assert.equal(new Set([a, b, c]).size, 3);
  });
});

describe("tables", () => {
  test("jobs are keyed by (frameKey, imageKey) and listed per frame", () => {
    const table = createJobTable();
    const a = table.create("1:0:D", "1.0", submitOf("1.0"), "u:https://cdn.example/1.0.jpg");
    const b = table.create("1:0:D", "2.0", submitOf("2.0"), null);
    const c = table.create("2:0:E", "1.0", submitOf("1.0"), null);
    assert.equal(table.get("1:0:D", "1.0"), a);
    assert.equal(table.get("2:0:E", "1.0"), c);
    assert.ok(a.seq < b.seq && b.seq < c.seq);
    assert.deepEqual(table.ofFrame("1:0:D"), [a, b]);
    table.remove(a);
    assert.equal(table.get("1:0:D", "1.0"), undefined);
    assert.equal(table.size, 2);
    assert.deepEqual(table.all(), [b, c]);
  });

  test("attach/detach keep job and work in sync; a second frame joins the same work", () => {
    const table = createJobTable();
    const one = table.create("1:0:D", "1.0", submitOf("1.0"), null);
    const two = table.create("2:0:E", "7.0", submitOf("7.0"), null);
    const work = newWork("s:abc", 0);
    attachJob(one, work);
    attachJob(two, work);
    assert.deepEqual([...work.jobs], [one, two]);
    assert.equal(two.contentKey, "s:abc");
    assert.equal(detachJob(one), work);
    assert.equal(one.work, null);
    assert.equal(one.contentKey, "s:abc");
    assert.deepEqual([...work.jobs], [two]);
    assert.equal(detachJob(one), null);
  });

  test("trim forgets idle works least recently used first, never one detecting, shown or with open packs", () => {
    const table = createWorkTable();
    const ready = (contentKey: string, lastUsedAt: number): ReturnType<typeof newWork> => {
      const work = newWork(contentKey, lastUsedAt);
      setUnits(work, []);
      return work;
    };
    const old = ready("s:old", 1);
    const busy = ready("s:busy", 0);
    busy.packs.add({ unitKeys: [], started: true });
    const shown = ready("s:shown", 0);
    attachJob(createJobTable().create("1:0:D", "1.0", submitOf("1.0"), null), shown);
    const detecting = newWork("s:detecting", 0);
    const recent = ready("s:recent", 9);
    for (const work of [old, busy, shown, detecting, recent]) table.add(work);
    assert.equal(table.trim(4), 1);
    assert.equal(table.get("s:old"), undefined);
    assert.equal(table.trim(1), 1);
    assert.deepEqual(
      table.values().map((w) => w.contentKey),
      ["s:busy", "s:shown", "s:detecting"],
    );
    const cleared = table.clear((work) => work.jobs.size > 0);
    assert.deepEqual(
      cleared.map((w) => w.contentKey),
      ["s:shown"],
    );
    assert.equal(table.size, 2);
  });
});

describe("scriptOf (sizes the translation like the original lettering)", () => {
  test("from the recognised original text, else the image language", () => {
    assert.equal(scriptOf("¡OYE TÚ, SÍ, TÚ!", null), "latin");
    assert.equal(scriptOf("안녕하세요", null), "hangul");
    assert.equal(scriptOf("おはよう", null), "cjk");
    assert.equal(scriptOf("你好", "ko"), "cjk");
    assert.equal(scriptOf("", "es"), "latin");
    assert.equal(scriptOf("...!?", "ko"), "hangul");
  });
});
