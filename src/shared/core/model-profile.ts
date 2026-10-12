// Composite profile per model family, chosen from the configured model id (settings.api.model). The GPT-5 values are
// measured (box budget 20 kept 100 % id mapping; 2048×1152 composites read worse than 2048×768); the others are
// conservative defaults. Vision models that tile images resize the short side to 768, hence the wide canvas. PURE.

import type { Lang, Script } from "../types.ts";

export type ModelProfileId = "gpt4o" | "gpt5" | "gemini" | "claude" | "default";

export interface CanvasSize {
  readonly W: number;
  readonly H: number;
}

export interface ModelProfile {
  readonly id: ModelProfileId;
  /** Composite canvases, tried in order (the taller one only when the wide one cannot hold the pack). */
  readonly canvas: readonly CanvasSize[];
  /** Starting number of units per request. */
  readonly boxBudget: number;
  /** Glyph height to scale crops to, in composite px. */
  readonly glyphTarget: Readonly<Record<Script, number>>;
  /** Smallest legible glyph height; below it the pack is split instead. */
  readonly glyphMin: Readonly<Record<Script, number>>;
  readonly jpegQuality: number;
}

const GLYPH_TARGET: Readonly<Record<Script, number>> = Object.freeze({ hangul: 30, cjk: 32, latin: 22 });
const GLYPH_MIN: Readonly<Record<Script, number>> = Object.freeze({ hangul: 20, cjk: 22, latin: 14 });
const WIDE: CanvasSize = Object.freeze({ W: 2048, H: 768 });
const TALL: CanvasSize = Object.freeze({ W: 2048, H: 1152 });

function profile(id: ModelProfileId, canvas: readonly CanvasSize[], boxBudget: number): ModelProfile {
  return Object.freeze({
    id,
    canvas: Object.freeze([...canvas]),
    boxBudget,
    glyphTarget: GLYPH_TARGET,
    glyphMin: GLYPH_MIN,
    jpegQuality: 0.9,
  });
}

export const MODEL_PROFILES: Readonly<Record<ModelProfileId, ModelProfile>> = Object.freeze({
  // Tile model: the shortest side becomes 768, so 2048×1152 would shrink to 1365×768.
  gpt4o: profile("gpt4o", [WIDE], 12),
  // Measured: 30 marks per composite still mapped 100 % (budget capped at 20); 2048×1152 was less legible.
  gpt5: profile("gpt5", [WIDE], 20),
  gemini: profile("gemini", [WIDE, TALL], 16),
  claude: profile("claude", [WIDE, TALL], 16),
  default: profile("default", [WIDE], 12),
});

const MATCHERS: ReadonlyArray<readonly [RegExp, ModelProfileId]> = [
  [/gpt-?5/iu, "gpt5"],
  [/gemini/iu, "gemini"],
  [/claude/iu, "claude"],
  [/4o|gpt-?4\.1/iu, "gpt4o"],
];

/** Profile for a model id (e.g. "gpt-5-mini", "openai/gpt-4o-mini", "gemini-2.5-flash", "llava:13b"). */
export function profileForModel(modelId: string | null | undefined): ModelProfile {
  const model = modelId ?? "";
  for (const [re, id] of MATCHERS) {
    if (re.test(model)) {
      return MODEL_PROFILES[id];
    }
  }
  return MODEL_PROFILES.default;
}

/**
 * Glyph family used to size crops for a source language: ko → hangul, ja/zh → cjk, en/es → latin. An
 * unknown script ("auto", "other", none) gets the CJK targets, the largest, because larger crops are safer.
 */
export function scriptForLang(lang: Lang | "auto" | null | undefined): Script {
  if (lang === "ko") {
    return "hangul";
  }
  if (lang === "en" || lang === "es") {
    return "latin";
  }
  return "cjk";
}
