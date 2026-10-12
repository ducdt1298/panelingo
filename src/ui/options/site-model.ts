// The options page's per-site editor without DOM or chrome: the choices of each site setting, parsing of the
// editor's controls into a site patch (checked against migrateSite, the rules stored sites follow) and the
// extraFrameOrigins list. PURE.

import { siteKeyFor } from "../../shared/site.ts";
import { DEFAULT_SITE, migrateSite, type SiteSettings } from "../../shared/settings.ts";

export const SITE_MODES: ReadonlyArray<SiteSettings["mode"]> = ["auto", "manual"];
export const SITE_LAYOUTS: ReadonlyArray<SiteSettings["layout"]> = [
  "auto",
  "webtoon",
  "paged-rtl",
  "paged-ltr",
];
export const SITE_SOURCE_LANGS: ReadonlyArray<SiteSettings["sourceLang"]> = [
  "auto",
  "ja",
  "ko",
  "zh",
  "en",
  "es",
  "other",
];
export const SITE_REFERERS: ReadonlyArray<SiteSettings["referer"]> = ["auto", "page-url", "origin"];

/** Every per-site setting the options page edits (the row: enabled, mode; the editor: the rest). */
export const SITE_EDITOR_FIELDS: ReadonlyArray<keyof SiteSettings> = [
  "enabled",
  "mode",
  "layout",
  "sourceLang",
  "referer",
  "credentials",
  "includeSubdomains",
  "prefetchAhead",
  "extraFrameOrigins",
];

/** One control of the editor and its raw value (checkboxes give booleans, selects and the text area text). */
export type SiteInput =
  | { field: "enabled" | "includeSubdomains" | "credentials" | "prefetchAhead"; value: boolean }
  | { field: "mode" | "layout" | "sourceLang" | "referer"; value: string }
  | { field: "extraFrameOrigins"; value: string };

export type SiteEdit = { ok: true; patch: Partial<SiteSettings> } | { ok: false; invalid: string[] };

export interface FrameOrigins {
  /** Normalized origins (lowercase, no path), deduplicated, in input order. */
  origins: string[];
  /** Lines that are not http(s) URLs, as typed. */
  invalid: string[];
}

/**
 * The text area's lines → origins of reader frames. Paths are dropped (a pasted frame URL works), blank lines
 * ignored, and the site's own origin left out (the site itself is always covered).
 */
export function parseFrameOrigins(text: string, siteKey: string): FrameOrigins {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\r\n]+/u)) {
    const line = raw.trim().replace(/,$/u, "");
    if (line === "") continue;
    const origin = siteKeyFor(line);
    if (origin === null || !/^https?:\/\//iu.test(line)) invalid.push(line);
    else if (origin !== siteKey && !origins.includes(origin)) origins.push(origin);
  }
  return { origins, invalid };
}

/** The text area's content for a list of origins. */
export function framesText(origins: readonly string[]): string {
  return origins.join("\n");
}

function choice<T extends string>(choices: readonly T[], value: string): T | null {
  return choices.find((candidate) => candidate === value) ?? null;
}

function patchOf(input: SiteInput, siteKey: string): SiteEdit {
  switch (input.field) {
    case "enabled":
      return { ok: true, patch: { enabled: input.value } };
    case "includeSubdomains":
      return { ok: true, patch: { includeSubdomains: input.value } };
    case "prefetchAhead":
      return { ok: true, patch: { prefetchAhead: input.value } };
    case "credentials":
      return { ok: true, patch: { credentials: input.value ? "include" : "omit" } };
    case "mode": {
      const mode = choice(SITE_MODES, input.value);
      return mode === null ? { ok: false, invalid: [input.value] } : { ok: true, patch: { mode } };
    }
    case "layout": {
      const layout = choice(SITE_LAYOUTS, input.value);
      return layout === null ? { ok: false, invalid: [input.value] } : { ok: true, patch: { layout } };
    }
    case "sourceLang": {
      const sourceLang = choice(SITE_SOURCE_LANGS, input.value);
      return sourceLang === null
        ? { ok: false, invalid: [input.value] }
        : { ok: true, patch: { sourceLang } };
    }
    case "referer": {
      const referer = choice(SITE_REFERERS, input.value);
      return referer === null ? { ok: false, invalid: [input.value] } : { ok: true, patch: { referer } };
    }
    case "extraFrameOrigins": {
      const parsed = parseFrameOrigins(input.value, siteKey);
      return parsed.invalid.length > 0
        ? { ok: false, invalid: parsed.invalid }
        : { ok: true, patch: { extraFrameOrigins: parsed.origins } };
    }
  }
}

/**
 * One editor control → the site patch to save, or the rejected input. A patch is only returned when migrateSite
 * keeps every value of it, so the editor never saves something storage would silently replace.
 */
export function parseSiteEdit(siteKey: string, input: SiteInput): SiteEdit {
  const edit = patchOf(input, siteKey);
  if (!edit.ok) return edit;
  const migrated = migrateSite({ ...DEFAULT_SITE, ...edit.patch }, 0) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(edit.patch)) {
    if (JSON.stringify(migrated[key]) !== JSON.stringify(value))
      return { ok: false, invalid: [String(value)] };
  }
  return edit;
}
