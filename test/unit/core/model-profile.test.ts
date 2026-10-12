import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MODEL_PROFILES,
  profileForModel,
  scriptForLang,
  type ModelProfileId,
} from "../../../src/shared/core/model-profile.ts";

describe("profileForModel (B.4.1)", () => {
  test("model ids of common OpenAI-compatible providers map to their family", () => {
    const cases: Array<[string | null | undefined, ModelProfileId]> = [
      // GPT-5 family, with or without a provider prefix or dash.
      ["gpt-5", "gpt5"],
      ["gpt-5.2", "gpt5"],
      ["gpt5-mini", "gpt5"],
      ["openai/gpt-5.1-chat", "gpt5"],
      ["azure-gpt-5.2", "gpt5"],
      ["AZURE-GPT-5.2-preview", "gpt5"],
      // GPT-4o and GPT-4.1 (tile models).
      ["gpt-4o", "gpt4o"],
      ["gpt-4o-mini", "gpt4o"],
      ["openai/gpt-4o-mini", "gpt4o"],
      ["chatgpt-4o-latest", "gpt4o"],
      ["gpt-4.1", "gpt4o"],
      ["gpt4.1-nano", "gpt4o"],
      // Gemini and Claude, through Google's OpenAI mode or a router.
      ["gemini-2.5-flash", "gemini"],
      ["google/gemini-2.0-flash-001", "gemini"],
      ["models/Gemini-1.5-Pro", "gemini"],
      ["claude-sonnet-4-5", "claude"],
      ["anthropic/claude-3.5-sonnet", "claude"],
      // Everything else (local vision models, unknown ids, nothing) → default.
      ["llava:13b", "default"],
      ["qwen2.5-vl-7b-instruct", "default"],
      ["gpt-4-turbo", "default"],
      ["", "default"],
      [null, "default"],
      [undefined, "default"],
    ];
    for (const [model, id] of cases) {
      assert.equal(profileForModel(model).id, id, String(model));
    }
  });

  test("the first matching family wins (gpt-5 before the 4o pattern)", () => {
    // "gpt-5-4o-experiment" contains both markers; GPT-5 is checked first.
    assert.equal(profileForModel("gpt-5-4o-experiment").id, "gpt5");
    assert.equal(profileForModel("gemini-4o-proxy").id, "gemini");
  });

  test("canvases and box budgets: gpt-4o 12, GPT-5 20 (measured), Gemini and Claude 16, default 12", () => {
    const wide = { W: 2048, H: 768 };
    const tall = { W: 2048, H: 1152 };
    assert.deepEqual(MODEL_PROFILES.gpt4o.canvas, [wide]);
    assert.equal(MODEL_PROFILES.gpt4o.boxBudget, 12);
    // Measured on GPT-5: 2048×1152 read worse than 2048×768, so the wide canvas is the only one.
    assert.deepEqual(MODEL_PROFILES.gpt5.canvas, [wide]);
    assert.equal(MODEL_PROFILES.gpt5.boxBudget, 20);
    // Gemini and Claude are not benched yet: provisional values with a taller fallback canvas.
    assert.deepEqual(MODEL_PROFILES.gemini.canvas, [wide, tall]);
    assert.equal(MODEL_PROFILES.gemini.boxBudget, 16);
    assert.deepEqual(MODEL_PROFILES.claude.canvas, [wide, tall]);
    assert.equal(MODEL_PROFILES.claude.boxBudget, 16);
    assert.deepEqual(MODEL_PROFILES.default.canvas, [wide]);
    assert.equal(MODEL_PROFILES.default.boxBudget, 12);
  });

  test("every profile id is its own key", () => {
    assert.deepEqual(Object.keys(MODEL_PROFILES).sort(), ["claude", "default", "gemini", "gpt4o", "gpt5"]);
    for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
      assert.equal(profile.id, key);
    }
  });

  test("glyph targets 30/32/22, minimums 20/22/14, JPEG q0.90 for every profile", () => {
    for (const profile of Object.values(MODEL_PROFILES)) {
      assert.deepEqual(profile.glyphTarget, { hangul: 30, cjk: 32, latin: 22 }, profile.id);
      assert.deepEqual(profile.glyphMin, { hangul: 20, cjk: 22, latin: 14 }, profile.id);
      assert.equal(profile.jpegQuality, 0.9, profile.id);
    }
  });

  test("profiles are immutable shared constants", () => {
    const profile = profileForModel("gpt-5.2");
    assert.equal(profile, MODEL_PROFILES.gpt5);
    assert.ok(Object.isFrozen(profile));
    assert.ok(Object.isFrozen(profile.canvas));
    assert.ok(Object.isFrozen(profile.glyphTarget));
    assert.ok(Object.isFrozen(MODEL_PROFILES));
  });
});

describe("scriptForLang", () => {
  test("language → glyph family", () => {
    assert.equal(scriptForLang("ko"), "hangul");
    assert.equal(scriptForLang("ja"), "cjk");
    assert.equal(scriptForLang("zh"), "cjk");
    assert.equal(scriptForLang("en"), "latin");
    assert.equal(scriptForLang("es"), "latin");
    // B.4.4 step 6: an unknown script uses the CJK targets (the largest crops, the safest).
    assert.equal(scriptForLang("other"), "cjk");
    assert.equal(scriptForLang("auto"), "cjk");
    assert.equal(scriptForLang(null), "cjk");
    assert.equal(scriptForLang(undefined), "cjk");
  });
});
