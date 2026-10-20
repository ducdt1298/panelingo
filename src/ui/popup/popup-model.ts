// Popup decisions without DOM or chrome (unit-tested): what the site card shows, what its controls do, and the
// tab's progress bar.

import type { ErrorInfo } from "../../shared/errors.ts";
import { msg } from "../../shared/i18n/index.ts";
import { DEFAULT_SITE, type Settings, type SiteSettings } from "../../shared/settings.ts";
import { siteKeyFor } from "../../shared/site.ts";
import type { TabProgress } from "../../shared/types.ts";

export type SiteView =
  | { kind: "unsupported" }
  | {
      kind: "site";
      siteKey: string;
      enabled: boolean;
      mode: SiteSettings["mode"];
      /** Image requests carry the site's cookies (sites that need sign-in). */
      cookies: boolean;
    };

/** The active tab's site; chrome://, file:, the Web Store and other non-http(s) pages are unsupported. */
export function siteView(
  tabUrl: string | undefined,
  sites: Readonly<Record<string, SiteSettings>>,
): SiteView {
  const siteKey = tabUrl === undefined ? null : siteKeyFor(tabUrl);
  if (siteKey === null) return { kind: "unsupported" };
  const site = sites[siteKey];
  return {
    kind: "site",
    siteKey,
    enabled: site?.enabled === true,
    mode: site?.mode ?? DEFAULT_SITE.mode,
    cookies: (site?.credentials ?? DEFAULT_SITE.credentials) === "include",
  };
}

export type ToggleStep = "consent" | "enable" | "disable";

/** Clicking the site toggle: the first enable ever must go through the privacy notice. */
export function toggleStep(enabled: boolean, settings: Settings): ToggleStep {
  if (enabled) return "disable";
  return settings.privacy.ackUploadNoticeAt === null ? "consent" : "enable";
}

export type VisibleOutcome =
  | { kind: "sent"; submitted: number }
  /** The page cannot be scripted (chrome://, Web Store, closed tab) or the injected script never answered. */
  | { kind: "unavailable" }
  | { kind: "error"; error: ErrorInfo };

export function visibleMessage(outcome: VisibleOutcome): string {
  switch (outcome.kind) {
    case "sent":
      return msg().popup.visibleSent(outcome.submitted);
    case "unavailable":
      return msg().popup.visibleUnavailable;
    case "error":
      return msg().popup.actionFailed(msg().errors[outcome.error.code].title);
  }
}

export interface ProgressView {
  /** Images that settled (translated, without text, refused…), failed ones excluded. */
  done: number;
  failed: number;
  total: number;
  /** Still translating (or paused) vs everything settled. */
  busy: boolean;
  text: string;
}

/** The progress bar for the tab's images; null when the tab has none (or the engine never saw it). */
export function progressView(progress: TabProgress | null): ProgressView | null {
  if (progress === null || progress.total === 0) return null;
  const busy = progress.working + progress.paused > 0;
  const done = progress.total - progress.working - progress.paused - progress.failed;
  return {
    done,
    failed: progress.failed,
    total: progress.total,
    busy,
    text: busy ? msg().ui.progress(done, progress.total) : msg().popup.progressDone(progress.total),
  };
}
