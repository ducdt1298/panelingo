// Per-image status badge: a small pill at the top-right of the image (sticky while a tall strip scrolls by), text
// from src/shared/i18n, pointer-events none except its retry button. badgeView is the pure state → view mapping;
// createBadge owns the few DOM nodes.

import { isErrorCode } from "../../shared/errors.ts";
import type { ErrorInfo } from "../../shared/errors.ts";
import { msg } from "../../shared/i18n/index.ts";
import type { ErrorText } from "../../shared/i18n/index.ts";
import type { ImageState } from "../../shared/types.ts";
import type { ImageStateInfo } from "../contracts.ts";
import { element, isolate } from "./dom.ts";

export type BadgeTone = "muted" | "busy" | "ok" | "warn" | "error";

export interface BadgeView {
  visible: boolean;
  tone: BadgeTone;
  text: string;
  /** Remediation hint (tooltip / accessible description); "" when none. */
  title: string;
  spinner: boolean;
  /** Show the "Translate again" button (→ OverlayEvents.onTranslateRequest). */
  retry: boolean;
}

export interface BadgeContext {
  mode: "auto" | "manual";
  showDoneBadge: boolean;
}

export const HIDDEN_BADGE: Readonly<BadgeView> = {
  visible: false,
  tone: "muted",
  text: "",
  title: "",
  spinner: false,
  retry: false,
};

function errorText(error: ErrorInfo | undefined): ErrorText | null {
  return error !== undefined && isErrorCode(error.code) ? msg().errors[error.code] : null;
}

function validProgress(info: ImageStateInfo | undefined): { done: number; total: number } | null {
  const p = info?.progress;
  if (p === undefined || !Number.isFinite(p.done) || !Number.isFinite(p.total)) return null;
  const total = Math.round(p.total);
  return total > 0 ? { done: Math.min(total, Math.max(0, Math.round(p.done))), total } : null;
}

function view(
  tone: BadgeTone,
  text: string,
  extra: Partial<Omit<BadgeView, "visible" | "tone" | "text">> = {},
): BadgeView {
  return { visible: true, tone, text, title: "", spinner: false, retry: false, ...extra };
}

/**
 * The badge for an image state. Hidden: no state, done (unless render.showDoneBadge), no-text in auto mode.
 * Retry: on error always; in manual mode also on partial and stale (auto mode retries by itself; a refusal gets
 * no button: it is never retried automatically).
 */
export function badgeView(
  state: ImageState | undefined,
  info: ImageStateInfo | undefined,
  ctx: BadgeContext,
): BadgeView {
  if (state === undefined) return { ...HIDDEN_BADGE };
  const manual = ctx.mode === "manual";
  const progress = validProgress(info);
  const counted = (label: string): string =>
    progress === null ? label : `${label} ${progress.done}/${progress.total}`;
  const err = errorText(info?.error);
  switch (state) {
    case "queued":
      return view("muted", msg().imageState.queued);
    case "acquiring":
    case "detecting":
      return view("busy", msg().imageState[state], { spinner: true });
    case "waiting":
      return view("busy", counted(msg().imageState.waiting), { spinner: true });
    case "translating":
      return view(
        "busy",
        progress === null
          ? msg().imageState.translating
          : msg().ui.progress(progress.done, progress.total, info?.etaSec),
        { spinner: true },
      );
    case "done":
      return ctx.showDoneBadge ? view("ok", msg().imageState.done) : { ...HIDDEN_BADGE };
    case "no-text":
      return manual ? view("muted", msg().imageState["no-text"]) : { ...HIDDEN_BADGE };
    case "partial":
      return view("warn", counted(msg().imageState.partial), { retry: manual });
    case "refused":
      return view("error", msg().imageState.refused, { title: msg().errors["llm.refused"].hint });
    case "paused":
      return view("warn", err?.title ?? msg().imageState.paused, { title: err?.hint ?? "" });
    case "error":
      return view("error", err?.title ?? msg().imageState.error, { title: err?.hint ?? "", retry: true });
    case "stale":
      return view("muted", msg().imageState.stale, { retry: manual });
  }
}

export interface BadgeHandle {
  readonly element: HTMLDivElement;
  update(view: BadgeView, state: ImageState | undefined): void;
}

export function createBadge(doc: Document, onRetry: () => void): BadgeHandle {
  const root = element(doc, "div", "badge muted");
  root.hidden = true;
  root.setAttribute("role", "status");
  const spinner = element(doc, "span", "spinner");
  spinner.hidden = true;
  const text = element(doc, "span", "text");
  const retry = element(doc, "button", "retry");
  retry.type = "button";
  retry.hidden = true;
  retry.textContent = msg().ui.retranslate;
  isolate(retry, onRetry);
  root.append(spinner, text, retry);
  return {
    element: root,
    update(next, state) {
      root.hidden = !next.visible;
      root.className = `badge ${next.tone}`;
      if (state === undefined) root.removeAttribute("data-state");
      else root.setAttribute("data-state", state);
      spinner.hidden = !next.spinner;
      text.textContent = next.text;
      retry.hidden = !next.retry;
      if (next.title === "") root.removeAttribute("title");
      else root.setAttribute("title", next.title);
    },
  };
}
