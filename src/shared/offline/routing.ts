// Offline mode routing (docs/OFFLINE-MODE.md): which OCR model reads a language, and which translation models take a
// source language to the target language. Opus-MT has one model per direction: a direct model when one is in the
// catalog, else source → English → target when both legs exist, else the pair is not supported. NLLB-200 translates
// any pair of its languages in one step. PURE.

import type { Lang } from "../types.ts";

export type OfflineModelChoice = "opus-mt" | "nllb-600m";

export const NLLB_MODEL = "nllb-200-distilled-600m";

/** PaddleOCR recognizer per source language. */
export const OCR_MODEL: Readonly<Record<Exclude<Lang, "other">, string>> = {
  ko: "ocr-korean",
  ja: "ocr-cjk",
  zh: "ocr-cjk",
  en: "ocr-en",
  es: "ocr-latin",
};

/** NLLB-200 (FLORES-200) codes of the source languages the OCR reads. */
export const NLLB_SOURCE: Readonly<Record<Exclude<Lang, "other">, string>> = {
  ko: "kor_Hang",
  ja: "jpn_Jpan",
  zh: "zho_Hans",
  en: "eng_Latn",
  es: "spa_Latn",
};

/** NLLB-200 codes of the target languages (src/shared/languages.ts TARGET_LANGUAGES). */
export const NLLB_TARGET: Readonly<Record<string, string>> = {
  en: "eng_Latn",
  vi: "vie_Latn",
  es: "spa_Latn",
  "pt-br": "por_Latn",
  fr: "fra_Latn",
  de: "deu_Latn",
  it: "ita_Latn",
  id: "ind_Latn",
  tl: "tgl_Latn",
  pl: "pol_Latn",
  tr: "tur_Latn",
  ja: "jpn_Jpan",
  "zh-cn": "zho_Hans",
  "zh-tw": "zho_Hant",
  ko: "kor_Hang",
};

/** Opus-MT language code of a target language (Opus-MT names models by ISO 639-1 codes). */
function opusTarget(target: string): string {
  return target.split("-")[0] ?? target;
}

export function opusModel(source: string, target: string): string {
  return `opus-mt-${source}-${target}`;
}

export interface MtLeg {
  /** Model id in the offline catalog. */
  model: string;
  /** The model's own code for the source and target (Opus-MT: ISO 639-1; NLLB: FLORES-200). */
  source: string;
  target: string;
}

export type MtRoute =
  /** The page is already in the target language: keep the original text. */
  | { kind: "same" }
  | {
      kind: "translate";
      legs: MtLeg[];
      /** TranslationRecord.model, e.g. "offline:opus-mt-ko-en". */ label: string;
    }
  | { kind: "unsupported"; reason: string };

/** Target languages written in the source language's own script and language (no translation needed). */
function sameLanguage(source: Lang, target: string): boolean {
  if (source === "zh") return target === "zh-cn" || target === "zh-tw";
  return source === opusTarget(target) && target !== "pt-br";
}

/**
 * The translation route for one source language. `available` lists the model ids of the catalog (build-info.json),
 * so a pair is only offered when every leg can be downloaded.
 */
export function planRoute(
  source: Lang,
  target: string,
  choice: OfflineModelChoice,
  available: ReadonlySet<string>,
): MtRoute {
  if (source === "other") return { kind: "unsupported", reason: "the page language is unknown" };
  if (sameLanguage(source, target)) return { kind: "same" };
  if (choice === "nllb-600m") {
    const to = NLLB_TARGET[target];
    if (to === undefined) return { kind: "unsupported", reason: `NLLB-200 has no ${target}` };
    if (!available.has(NLLB_MODEL))
      return { kind: "unsupported", reason: `${NLLB_MODEL} is not in this build` };
    return {
      kind: "translate",
      legs: [{ model: NLLB_MODEL, source: NLLB_SOURCE[source], target: to }],
      label: `offline:${NLLB_MODEL}`,
    };
  }
  const to = opusTarget(target);
  // Opus-MT en-* models write European Portuguese or other variants; only plain codes are routed.
  if (target.includes("-")) return { kind: "unsupported", reason: `no Opus-MT model writes ${target}` };
  const direct = opusModel(source, to);
  let legs: MtLeg[];
  if (available.has(direct)) {
    legs = [{ model: direct, source, target: to }];
  } else if (
    source !== "en" &&
    to !== "en" &&
    available.has(opusModel(source, "en")) &&
    available.has(opusModel("en", to))
  ) {
    legs = [
      { model: opusModel(source, "en"), source, target: "en" },
      { model: opusModel("en", to), source: "en", target: to },
    ];
  } else {
    return { kind: "unsupported", reason: `no Opus-MT model for ${source} → ${target}` };
  }
  return { kind: "translate", legs, label: `offline:${legs.map((leg) => leg.model).join("+")}` };
}

/** Models a route needs: the OCR recognizer plus every translation leg. */
export function routeModels(source: Exclude<Lang, "other">, route: MtRoute): string[] {
  return [OCR_MODEL[source], ...(route.kind === "translate" ? route.legs.map((leg) => leg.model) : [])];
}

/**
 * Which engine and offline model produced a stored translation (TranslationRecord.model): AI records ("api"),
 * Opus-MT records, NLLB records. A record only counts as cached for the engine currently configured.
 */
export function translationSource(model: string): "api" | "offline:opus-mt" | "offline:nllb-600m" {
  if (!model.startsWith("offline:")) return "api";
  return model.startsWith(`offline:${NLLB_MODEL}`) ? "offline:nllb-600m" : "offline:opus-mt";
}

/** The translationSource the current settings produce. */
export function currentSource(engine: "api" | "offline", choice: OfflineModelChoice): string {
  return engine === "api" ? "api" : `offline:${choice}`;
}
