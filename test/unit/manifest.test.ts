import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  allManifestMessages,
  buildManifest,
  chromeLocaleDir,
  manifestMessages,
  RESERVED_SHORTCUTS,
} from "../../src/manifest.ts";
import { EN } from "../../src/shared/i18n/en.ts";
import { catalogFor, uiLocales } from "../../src/shared/i18n/index.ts";

test("content scripts are registered at runtime, never statically", () => {
  for (const mode of ["dev", "test", "prod"] as const) {
    const manifest = buildManifest({ version: "0.1.0", mode });
    assert.equal("content_scripts" in manifest, false, mode);
  }
});

test("no cross-origin isolation keys in v1 (single-threaded WASM fallback)", () => {
  const manifest = buildManifest({ version: "0.1.0", mode: "prod" }) as Record<string, unknown>;
  assert.equal(manifest["cross_origin_embedder_policy"], undefined);
  assert.equal(manifest["cross_origin_opener_policy"], undefined);
});

test("extension pages may compile WebAssembly but never eval", () => {
  const csp =
    buildManifest({ version: "0.1.0", mode: "prod" }).content_security_policy?.extension_pages ?? "";
  assert.match(csp, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
});

test("structured-clone messaging is paired with a Chrome 148 floor", () => {
  const manifest = buildManifest({ version: "0.1.0", mode: "prod" });
  assert.equal(manifest.message_serialization, "structured_clone");
  assert.ok(Number(manifest.minimum_chrome_version) >= 148);
});

test("suggested shortcuts avoid keys Chrome reserves on Windows", () => {
  const commands = buildManifest({ version: "0.1.0", mode: "prod" }).commands ?? {};
  const suggested = Object.values(commands)
    .map((command) =>
      typeof command.suggested_key === "string" ? command.suggested_key : command.suggested_key?.default,
    )
    .filter((key): key is string => typeof key === "string");
  assert.ok(suggested.length <= 4, "Chrome honours at most 4 suggested shortcuts");
  for (const key of suggested) {
    assert.equal(RESERVED_SHORTCUTS.includes(key), false, key);
  }
});

test("debug-only DNR feedback permission is not shipped in prod", () => {
  assert.equal(
    buildManifest({ version: "0.1.0", mode: "prod" }).permissions?.includes("declarativeNetRequestFeedback"),
    false,
  );
  assert.equal(
    buildManifest({ version: "0.1.0", mode: "dev" }).permissions?.includes("declarativeNetRequestFeedback"),
    true,
  );
});

test("only fonts are web-accessible, behind dynamic URLs", () => {
  const war = buildManifest({ version: "0.1.0", mode: "prod" }).web_accessible_resources ?? [];
  assert.equal(war.length, 1);
  assert.deepEqual(war[0]?.resources, ["assets/fonts/*.woff2"]);
  assert.equal(war[0]?.use_dynamic_url, true);
});

describe("localized manifest strings", () => {
  const manifest = buildManifest({ version: "0.1.0", mode: "prod" });

  /** Every __MSG_name__ the manifest references. */
  function referencedMessages(value: unknown): string[] {
    const names = JSON.stringify(value).matchAll(/__MSG_([A-Za-z0-9_@]+)__/gu);
    return [...new Set([...names].map((match) => match[1] ?? ""))].sort();
  }

  test("user-visible fields use __MSG_*__ names with English as the default locale", () => {
    assert.equal(manifest.default_locale, "en");
    assert.equal(manifest.name, "__MSG_extName__");
    assert.equal(manifest.description, "__MSG_extDescription__");
    assert.equal(manifest.action?.default_title, "__MSG_extName__");
    const commands = manifest.commands ?? {};
    assert.deepEqual(
      Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, command.description])),
      {
        "toggle-overlay": "__MSG_cmdToggleOverlay__",
        "translate-visible": "__MSG_cmdTranslateVisible__",
        "toggle-site": "__MSG_cmdToggleSite__",
        "open-side-panel": "__MSG_cmdOpenSidePanel__",
      },
    );
  });

  test("dev and test builds keep the localized name with a suffix", () => {
    assert.equal(buildManifest({ version: "0.1.0", mode: "dev" }).name, "__MSG_extName__ (dev)");
    assert.equal(buildManifest({ version: "0.1.0", mode: "test" }).name, "__MSG_extName__ (test)");
  });

  test("host access covers any comic CDN and any OpenAI-compatible endpoint", () => {
    assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
    assert.equal(manifest.version, "0.1.0");
  });

  test("chromeLocaleDir: Chrome's _locales folder names", () => {
    assert.equal(chromeLocaleDir("en"), "en");
    assert.equal(chromeLocaleDir("vi"), "vi");
    assert.equal(chromeLocaleDir("pt-br"), "pt_BR");
    assert.equal(chromeLocaleDir("zh-cn"), "zh_CN");
    assert.equal(chromeLocaleDir("zh-tw"), "zh_TW");
  });

  test("the short name is the app name and fits Chrome's 12-character launcher limit", () => {
    assert.equal(manifest.short_name, EN.ui.appName);
    assert.ok((manifest.short_name ?? "").length <= 12);
  });

  test("manifestMessages(EN) holds the English catalog strings", () => {
    const messages = manifestMessages(catalogFor("en"));
    assert.equal(messages["extName"]?.message, EN.ui.appName);
    assert.equal(messages["extDescription"]?.message, EN.manifest.description);
    assert.equal(messages["cmdToggleOverlay"]?.message, EN.manifest.commands["toggle-overlay"]);
    assert.equal(messages["cmdTranslateVisible"]?.message, EN.manifest.commands["translate-visible"]);
    assert.equal(messages["cmdToggleSite"]?.message, EN.manifest.commands["toggle-site"]);
    assert.equal(messages["cmdOpenSidePanel"]?.message, EN.manifest.commands["open-side-panel"]);
  });

  test("_locales: one messages.json per UI locale, English first, Vietnamese included", () => {
    const all = allManifestMessages();
    const dirs = all.map(([dir]) => dir);
    assert.equal(dirs[0], "en");
    assert.ok(dirs.includes("vi"));
    assert.deepEqual(
      dirs,
      uiLocales().map(({ code }) => chromeLocaleDir(code)),
    );
    assert.equal(new Set(dirs).size, dirs.length, "no duplicate folders");
  });

  test("every locale defines every referenced message, non-empty, with valid names", () => {
    const referenced = referencedMessages(manifest);
    assert.deepEqual(referenced, [
      "cmdOpenSidePanel",
      "cmdToggleOverlay",
      "cmdToggleSite",
      "cmdTranslateVisible",
      "extDescription",
      "extName",
    ]);
    for (const [dir, messages] of allManifestMessages()) {
      assert.deepEqual(Object.keys(messages).sort(), referenced, dir);
      for (const [name, entry] of Object.entries(messages)) {
        assert.match(name, /^[A-Za-z0-9_@]+$/u, `${dir}.${name}`);
        assert.ok(entry.message.trim() !== "", `${dir}.${name} is empty`);
        assert.ok(!entry.message.includes("$"), `${dir}.${name}: "$" starts a Chrome placeholder`);
      }
    }
  });

  test("the description fits Chrome's 132-character limit in every locale", () => {
    for (const [dir, messages] of allManifestMessages()) {
      const description = messages["extDescription"]?.message ?? "";
      assert.ok(description.length > 0 && description.length <= 132, `${dir}: ${description.length} chars`);
    }
  });

  test("the Vietnamese messages come from the Vietnamese catalog (English where it has no entry)", () => {
    const vi = new Map(allManifestMessages()).get("vi");
    const catalog = catalogFor("vi");
    assert.equal(vi?.["extDescription"]?.message, catalog.manifest.description);
    assert.equal(vi?.["cmdToggleSite"]?.message, catalog.manifest.commands["toggle-site"]);
  });
});
