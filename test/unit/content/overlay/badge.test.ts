import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HIDDEN_BADGE, badgeView, createBadge } from "../../../../src/content/overlay/badge.ts";
import type { BadgeContext, BadgeView } from "../../../../src/content/overlay/badge.ts";
import type { ImageStateInfo } from "../../../../src/content/contracts.ts";
import type { ErrorCode } from "../../../../src/shared/errors.ts";
import { catalogFor, msg, setLocale } from "../../../../src/shared/i18n/index.ts";
import type { ImageState } from "../../../../src/shared/types.ts";
import { asFake, fakeDocument } from "../../ui/fake-dom.ts";

// Texts of the active locale (English unless a test switches it).
const IMAGE_STATE_TEXT = msg().imageState;
const ERROR_TEXT = msg().errors;
const UI_TEXT = msg().ui;

const AUTO: BadgeContext = { mode: "auto", showDoneBadge: false };
const MANUAL: BadgeContext = { mode: "manual", showDoneBadge: false };

const error = (code: ErrorCode): ImageStateInfo => ({ error: { code, message: code, retryable: false } });

type Expect = Pick<BadgeView, "visible" | "tone" | "text" | "spinner" | "retry">;

const pick = (v: BadgeView): Expect => ({
  visible: v.visible,
  tone: v.tone,
  text: v.text,
  spinner: v.spinner,
  retry: v.retry,
});

const shown = (tone: BadgeView["tone"], text: string, extra: Partial<Expect> = {}): Expect => ({
  visible: true,
  tone,
  text,
  spinner: false,
  retry: false,
  ...extra,
});

const hidden: Expect = pick(HIDDEN_BADGE);

/** Every ImageState, without progress or error info, in auto mode. */
const AUTO_TABLE: Record<ImageState, Expect> = {
  queued: shown("muted", IMAGE_STATE_TEXT.queued),
  acquiring: shown("busy", IMAGE_STATE_TEXT.acquiring, { spinner: true }),
  detecting: shown("busy", IMAGE_STATE_TEXT.detecting, { spinner: true }),
  waiting: shown("busy", IMAGE_STATE_TEXT.waiting, { spinner: true }),
  translating: shown("busy", IMAGE_STATE_TEXT.translating, { spinner: true }),
  done: hidden,
  "no-text": hidden,
  partial: shown("warn", IMAGE_STATE_TEXT.partial),
  refused: shown("error", IMAGE_STATE_TEXT.refused),
  paused: shown("warn", IMAGE_STATE_TEXT.paused),
  error: shown("error", IMAGE_STATE_TEXT.error, { retry: true }),
  stale: shown("muted", IMAGE_STATE_TEXT.stale),
};

describe("badgeView", () => {
  test("every ImageState in auto mode", () => {
    assert.deepEqual(
      Object.keys(AUTO_TABLE).sort(),
      Object.keys(IMAGE_STATE_TEXT).sort(),
      "table covers every state",
    );
    for (const [state, expected] of Object.entries(AUTO_TABLE) as Array<[ImageState, Expect]>) {
      assert.deepEqual(pick(badgeView(state, undefined, AUTO)), expected, state);
    }
  });

  test("no state, no badge", () => {
    assert.deepEqual(badgeView(undefined, undefined, AUTO), HIDDEN_BADGE);
    assert.deepEqual(badgeView(undefined, undefined, MANUAL), HIDDEN_BADGE);
  });

  test("manual mode: no-text shows, partial and stale offer a retry; a refusal never does (D-005)", () => {
    for (const [state, expected] of Object.entries(AUTO_TABLE) as Array<[ImageState, Expect]>) {
      const manual = pick(badgeView(state, undefined, MANUAL));
      if (state === "no-text") assert.deepEqual(manual, shown("muted", IMAGE_STATE_TEXT["no-text"]));
      else if (state === "partial" || state === "stale")
        assert.deepEqual(manual, { ...expected, retry: true }, state);
      else assert.deepEqual(manual, expected, state);
    }
    assert.equal(badgeView("refused", undefined, MANUAL).retry, false);
  });

  test("done shows only with render.showDoneBadge", () => {
    assert.deepEqual(
      pick(badgeView("done", undefined, { ...AUTO, showDoneBadge: true })),
      shown("ok", IMAGE_STATE_TEXT.done),
    );
    assert.equal(badgeView("done", undefined, AUTO).visible, false);
  });

  test("progress: k/N on waiting, translating (with ETA) and partial", () => {
    const p = { progress: { done: 3, total: 12 } };
    assert.equal(
      badgeView("waiting", { progress: { done: 0, total: 12 } }, AUTO).text,
      `${IMAGE_STATE_TEXT.waiting} 0/12`,
    );
    assert.equal(badgeView("translating", p, AUTO).text, UI_TEXT.progress(3, 12));
    assert.equal(badgeView("translating", { ...p, etaSec: 4.6 }, AUTO).text, UI_TEXT.progress(3, 12, 4.6));
    assert.equal(
      badgeView("partial", { progress: { done: 10, total: 12 } }, AUTO).text,
      `${IMAGE_STATE_TEXT.partial} 10/12`,
    );
    assert.equal(badgeView("queued", p, AUTO).text, IMAGE_STATE_TEXT.queued, "queued ignores progress");
  });

  test("progress is sanitised: no total → plain label; done clamped to [0, total]", () => {
    assert.equal(
      badgeView("translating", { progress: { done: 0, total: 0 } }, AUTO).text,
      IMAGE_STATE_TEXT.translating,
    );
    assert.equal(
      badgeView("waiting", { progress: { done: 0, total: 0.4 } }, AUTO).text,
      IMAGE_STATE_TEXT.waiting,
      "a total that rounds to 0 is no total",
    );
    assert.equal(
      badgeView("translating", { progress: { done: Number.NaN, total: 5 } }, AUTO).text,
      IMAGE_STATE_TEXT.translating,
    );
    assert.equal(
      badgeView("translating", { progress: { done: 9, total: 5 } }, AUTO).text,
      UI_TEXT.progress(5, 5),
    );
    assert.equal(
      badgeView("waiting", { progress: { done: -2, total: 5.4 } }, AUTO).text,
      `${IMAGE_STATE_TEXT.waiting} 0/5`,
    );
  });

  test("paused and error show the msg().errors title, with its hint as the tooltip", () => {
    const paused = badgeView("paused", error("api.unreachable"), AUTO);
    assert.equal(paused.text, ERROR_TEXT["api.unreachable"].title);
    assert.equal(paused.title, ERROR_TEXT["api.unreachable"].hint);
    assert.equal(paused.tone, "warn");
    assert.equal(paused.retry, false);
    const consent = badgeView("paused", error("privacy.consent"), MANUAL);
    assert.equal(consent.text, ERROR_TEXT["privacy.consent"].title);
    const failed = badgeView("error", error("image.http"), AUTO);
    assert.deepEqual(pick(failed), shown("error", ERROR_TEXT["image.http"].title, { retry: true }));
    assert.equal(failed.title, ERROR_TEXT["image.http"].hint);
    assert.equal(badgeView("refused", undefined, AUTO).title, ERROR_TEXT["llm.refused"].hint);
  });

  test("an unknown error code (version skew) falls back to the plain state text", () => {
    const info = {
      error: { code: "future.code", message: "?", retryable: false },
    } as unknown as ImageStateInfo;
    assert.equal(badgeView("error", info, AUTO).text, IMAGE_STATE_TEXT.error);
    assert.equal(badgeView("paused", info, AUTO).text, IMAGE_STATE_TEXT.paused);
    assert.equal(badgeView("error", info, AUTO).title, "");
  });

  test('texts follow the UI locale: English by default, Vietnamese after setLocale("vi")', () => {
    assert.equal(badgeView("queued", undefined, AUTO).text, "Queued");
    assert.equal(badgeView("error", error("image.http"), AUTO).text, "Could not load the image");
    const vi = catalogFor("vi");
    try {
      assert.equal(setLocale("vi"), "vi");
      assert.notEqual(vi.imageState.queued, "Queued");
      assert.equal(badgeView("queued", undefined, AUTO).text, vi.imageState.queued);
      assert.equal(
        badgeView("translating", { progress: { done: 3, total: 12 } }, AUTO).text,
        vi.ui.progress(3, 12),
      );
      const failed = badgeView("error", error("image.http"), AUTO);
      assert.deepEqual(
        [failed.text, failed.title],
        [vi.errors["image.http"].title, vi.errors["image.http"].hint],
      );
    } finally {
      setLocale("en");
    }
    assert.equal(badgeView("queued", undefined, AUTO).text, "Queued", "back to English");
  });
});

describe("createBadge", () => {
  test("renders a view: tone class, data-state, text, hint tooltip, spinner and the retry button", () => {
    let retries = 0;
    const badge = createBadge(fakeDocument(), () => {
      retries += 1;
    });
    const root = asFake(badge.element);
    const [spinner, text, retry] = root.children;
    assert.equal(root["hidden"], true, "hidden until the first state");
    assert.equal(root.getAttribute("role"), "status");
    assert.equal(retry?.textContent, msg().ui.retranslate);
    assert.equal(retry?.textContent, "Translate again");

    badge.update(badgeView("error", error("image.http"), AUTO), "error");
    assert.equal(root["hidden"], false);
    assert.equal(root.className, "badge error");
    assert.equal(root.getAttribute("data-state"), "error");
    assert.equal(text?.textContent, msg().errors["image.http"].title);
    assert.equal(root.getAttribute("title"), msg().errors["image.http"].hint);
    assert.deepEqual([spinner?.["hidden"], retry?.["hidden"]], [true, false]);
    assert.deepEqual(
      retry?.fire("click"),
      { prevented: true, stopped: true },
      "the page never sees the click",
    );
    assert.equal(retries, 1);

    badge.update(badgeView("translating", { progress: { done: 1, total: 4 } }, AUTO), "translating");
    assert.equal(text?.textContent, msg().ui.progress(1, 4));
    assert.deepEqual([spinner?.["hidden"], retry?.["hidden"]], [false, true]);
    assert.equal(root.getAttribute("title"), null);

    badge.update(HIDDEN_BADGE, undefined);
    assert.equal(root["hidden"], true);
    assert.equal(root.getAttribute("data-state"), null);
  });

  test("a badge built while the locale is vi shows Vietnamese texts", () => {
    const vi = catalogFor("vi");
    try {
      setLocale("vi");
      const badge = createBadge(fakeDocument(), () => undefined);
      badge.update(badgeView("paused", error("api.unauthorized"), AUTO), "paused");
      const [, text, retry] = asFake(badge.element).children;
      assert.equal(retry?.textContent, vi.ui.retranslate);
      assert.equal(text?.textContent, vi.errors["api.unauthorized"].title);
      assert.equal(asFake(badge.element).getAttribute("title"), vi.errors["api.unauthorized"].hint);
    } finally {
      setLocale("en");
    }
  });
});
