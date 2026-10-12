// Options page parsing and ordering without DOM or chrome (unit-tested).

import { normalizeBaseUrl, type Settings, type SiteSettings } from "../../shared/settings.ts";

export const LOG_LEVELS: ReadonlyArray<Settings["debug"]["logLevel"]> = ["debug", "info", "warn", "error"];
export const CONCURRENCY_CHOICES: readonly number[] = [1, 2, 3, 4];

/** Well-known OpenAI-compatible endpoints that accept images; picking one fills the base URL and a model. */
export interface ApiPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** The provider needs an API key. */
  needsKey: boolean;
}

export const API_PRESETS: readonly ApiPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    needsKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    needsKey: true,
  },
  {
    id: "gemini",
    label: "Google Gemini (OpenAI mode)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    needsKey: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5vl:7b",
    needsKey: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "",
    needsKey: false,
  },
  { id: "vllm", label: "vLLM (local)", baseUrl: "http://127.0.0.1:8000/v1", model: "", needsKey: false },
];

/** The preset whose base URL matches, or null (custom endpoint). */
export function presetFor(baseUrl: string): ApiPreset | null {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  return API_PRESETS.find((preset) => preset.baseUrl === normalized) ?? null;
}

/**
 * An OpenAI-compatible base URL, normalized (a bare origin gets "/v1"), or null. Queries, fragments, credentials
 * and the 0.0.0.0 bind address (not a usable URL) are refused.
 */
export function parseBaseUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.hostname === "0.0.0.0") return null;
  return normalizeBaseUrl(url.href);
}

/** A model id: trimmed, non-empty, no whitespace inside. */
export function parseModel(input: string): string | null {
  const model = input.trim();
  return model !== "" && !/\s/u.test(model) ? model : null;
}

/** Requests in parallel: an integer 1..4, or null. */
export function parseConcurrency(input: string): number | null {
  const value = Number(input.trim());
  return Number.isInteger(value) && CONCURRENCY_CHOICES.includes(value) ? value : null;
}

export interface SiteRow {
  siteKey: string;
  enabled: boolean;
  mode: SiteSettings["mode"];
  addedAt: number;
}

/** Enabled sites first, then alphabetical. */
export function siteRows(sites: Readonly<Record<string, SiteSettings>>): SiteRow[] {
  return Object.entries(sites)
    .map(([siteKey, site]) => ({ siteKey, enabled: site.enabled, mode: site.mode, addedAt: site.addedAt }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.siteKey.localeCompare(b.siteKey));
}

/** "10/10/2026 14:05" in the local time zone. */
export function formatDateTime(date: Date, locale = "en"): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** File name for an exported debug log: panelingo-debug-<ISO time>.json (no characters Windows forbids). */
export function debugLogFileName(date: Date): string {
  return `panelingo-debug-${date.toISOString().replace(/[:.]/gu, "-")}.json`;
}
