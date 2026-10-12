// Lettering faces: which font letters which kind of line, with the line metrics fitText needs and the cap height
// that sizes the translation like the original lettering (overlay/render.ts matchFontPx). PURE.
//
// dialogue / thought → settings.render.font: Patrick Hand ("CTV Comic", the default) or Mali 400 ("CTV Round");
// narration (captions) → Mali 400; sign → Mali 700; sfx → Bangers ("CTV SFX"). Translations into Japanese, Chinese
// or Korean use the system's CJK fonts instead (CJK_FONT_STACKS, measured at runtime), sized by ink height, and
// Japanese and Traditional Chinese are lettered vertically in vertical balloons (letterVertically).
//
// Every constant below was measured in Chrome 154 on the bundled @fontsource 5.3.0 files (latin + vietnamese), the
// way the Patrick Hand constants were: font box ascent/descent at 1000 px, the ink of LINE_HEIGHT_PROBES at 1000 px
// for the line-height, and the ink ascent of "H" at 100 px for the cap height. test/unit/content/lettering.test.ts
// re-measures the cap heights with @napi-rs/canvas.

import {
  COLLISION_LEADING,
  MALI_METRICS,
  PATRICK_HAND_METRICS,
  lineHeightFromInk,
} from "../shared/core/fit-text.ts";
import type { FontMetrics } from "../shared/core/fit-text.ts";
import type { LineType, Script } from "../shared/types.ts";
import { CAP_HEIGHT_EM } from "./overlay/render.ts";
import type { FamilyKey } from "./fonts.ts";

/** Mali 700: the same font box as 400 (1.05/0.25 em); ink 1.171875 + 0.265625 em → lineHeightFromInk 1.45. */
export const MALI_BOLD_METRICS: Readonly<FontMetrics> = {
  lineHeight: lineHeightFromInk(1.171875, 0.265625) + COLLISION_LEADING,
  ascent: 1.05,
  descent: 0.25,
  pixelSnap: true,
};

/**
 * Bangers 400: font box 0.883/0.181 em; ink 1.390625 + 0.203125 em (Vietnamese marks stacked on its tall capitals)
 * → lineHeightFromInk 1.45, + COLLISION_LEADING.
 */
export const BANGERS_METRICS: Readonly<FontMetrics> = {
  lineHeight: lineHeightFromInk(1.390625, 0.203125) + COLLISION_LEADING,
  ascent: 0.883,
  descent: 0.181,
  pixelSnap: true,
};

/** Cap height ("H" ink ascent at 100 px) in em; Patrick Hand's is overlay/render.ts CAP_HEIGHT_EM. */
export const CAP_HEIGHTS = {
  patrickHand: CAP_HEIGHT_EM,
  mali: 0.73,
  maliBold: 0.73,
  bangers: 0.74,
} as const;

export type FaceKey = "comic" | "round" | "round-bold" | "sfx";

export interface LetterFace {
  readonly key: FaceKey;
  /** The font family (fonts.ts FONT_FAMILIES) holding this face. */
  readonly family: FamilyKey;
  /** CSS font-weight of the DOM lines and of the canvas measure. */
  readonly weight: 400 | 700;
  /** Line metrics once the family has loaded (a fallback font is measured instead). */
  readonly metrics: Readonly<FontMetrics>;
  /** Cap height in em once the family has loaded. */
  readonly capHeightEm: number;
  /** Ink ascent of LINE_HEIGHT_PROBES.ascent (stacked marks on capitals) in em, at 1000 px in Chrome 154. */
  readonly inkAscentEm: number;
}

export const FACES: Readonly<Record<FaceKey, LetterFace>> = {
  comic: {
    key: "comic",
    family: "comic",
    weight: 400,
    metrics: PATRICK_HAND_METRICS,
    capHeightEm: CAP_HEIGHTS.patrickHand,
    inkAscentEm: 1.015625,
  },
  round: {
    key: "round",
    family: "round",
    weight: 400,
    metrics: MALI_METRICS,
    capHeightEm: CAP_HEIGHTS.mali,
    inkAscentEm: 1.109375,
  },
  "round-bold": {
    key: "round-bold",
    family: "round",
    weight: 700,
    metrics: MALI_BOLD_METRICS,
    capHeightEm: CAP_HEIGHTS.maliBold,
    inkAscentEm: 1.171875,
  },
  sfx: {
    key: "sfx",
    family: "sfx",
    weight: 400,
    metrics: BANGERS_METRICS,
    capHeightEm: CAP_HEIGHTS.bangers,
    inkAscentEm: 1.390625,
  },
};

/** settings.render.font: the dialogue font. */
export type DialogueFont = "patrick-hand" | "mali";

/** The face a unit of `type` is lettered in. */
export function faceFor(type: LineType, dialogueFont: DialogueFont = "patrick-hand"): FaceKey {
  switch (type) {
    case "narration":
      return "round";
    case "sign":
      return "round-bold";
    case "sfx":
      return "sfx";
    case "dialogue":
    case "thought":
    case "ignore":
      return dialogueFont === "mali" ? "round" : "comic";
  }
}

/**
 * The families an overlay with these settings can letter in: loaded together when the first units of a page arrive,
 * so every face is ready by the time its translations stream in. `sfxShown`: SFX are labelled or erased.
 */
export function familiesInUse(dialogueFont: DialogueFont, sfxShown: boolean): FamilyKey[] {
  const types: LineType[] = ["dialogue", "thought", "narration", "sign"];
  if (sfxShown) types.push("sfx");
  return [...new Set(types.map((type) => FACES[faceFor(type, dialogueFont)].family))];
}

/** The faces that live in one family (they load together). */
export function facesOf(family: FamilyKey): LetterFace[] {
  return Object.values(FACES).filter((face) => face.family === family);
}

/* ------------------------------------------------------------------ CJK targets */

/** Targets lettered with the system's CJK fonts (no CJK font is bundled). */
export type CjkTarget = "ja" | "zh-cn" | "zh-tw" | "ko";

/**
 * Font list per CJK target, the fonts Windows, macOS, Android and common Linux setups ship for that language (the
 * Japanese, Simplified, Traditional and Korean glyph forms differ). Measured at runtime like a fallback font.
 */
export const CJK_FONT_STACKS: Readonly<Record<CjkTarget, string>> = {
  ja:
    '"Yu Gothic UI", "Yu Gothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", ' +
    '"Noto Sans JP", "Source Han Sans JP", Meiryo, sans-serif',
  "zh-cn":
    '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", ' +
    '"Noto Sans SC", "Source Han Sans SC", sans-serif',
  "zh-tw":
    '"Microsoft JhengHei UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", "Noto Sans TC", ' +
    '"Source Han Sans TC", sans-serif',
  ko: '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", "Noto Sans KR", "Source Han Sans KR", sans-serif',
};

export function cjkTargetOf(code: string): CjkTarget | null {
  return code === "ja" || code === "zh-cn" || code === "zh-tw" || code === "ko" ? code : null;
}

/** Targets written top to bottom: lettered vertically in vertical balloons with render.verticalText "auto". */
const VERTICAL_TARGETS: ReadonlySet<CjkTarget> = new Set(["ja", "zh-tw"]);

/** The CJK face of a unit: bold for signs and sound effects ("cjk-ja-bold"), regular otherwise ("cjk-ja"). */
export function cjkFaceKey(target: CjkTarget, type: LineType): string {
  return type === "sign" || type === "sfx" ? `cjk-${target}-bold` : `cjk-${target}`;
}

/** Every CJK face: key, font list and weight (the overlay sheet has a rule per face). */
export function cjkFaces(): Array<{ key: string; stack: string; weight: 400 | 700 }> {
  return (Object.keys(CJK_FONT_STACKS) as CjkTarget[]).flatMap((target) => [
    { key: `cjk-${target}`, stack: CJK_FONT_STACKS[target], weight: 400 as const },
    { key: `cjk-${target}-bold`, stack: CJK_FONT_STACKS[target], weight: 700 as const },
  ]);
}

/**
 * Size match of CJK lettering (overlay/render.ts matchFontPx with the face's ink height): a Han character's ink is
 * as tall as a Hangul or Han glyph of the original, and a little taller than the capitals of Latin lettering (in
 * mixed type, Han ink is about 1.2 × the cap height at the same size).
 */
export const CJK_INK_MATCH: Readonly<Record<Script, number>> = { latin: 1.2, hangul: 1, cjk: 1 };

/** Ink height of "国" in em when it cannot be measured (typical of CJK sans-serif faces). */
export const CJK_INK_EM = 0.88;

/** Probes whose ink sets the line-height of CJK lettering (measure.ts measureFontMetrics). */
export const CJK_LINE_PROBES = { ascent: "国鬱あア「", descent: "国鬱あア」" } as const;

/**
 * The unit is lettered top to bottom: render.verticalText "auto", a target written vertically (Japanese,
 * Traditional Chinese) and a vertical (tategaki) source balloon. Every other combination stays horizontal.
 */
export function letterVertically(
  target: string,
  verticalText: "auto" | "never",
  orientation: "h" | "v",
): boolean {
  const cjk = cjkTargetOf(target);
  return verticalText === "auto" && orientation === "v" && cjk !== null && VERTICAL_TARGETS.has(cjk);
}
