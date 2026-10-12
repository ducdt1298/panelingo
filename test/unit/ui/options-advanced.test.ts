// The real Options entry (src/ui/options/options.ts) against the chrome fake: the collapsed Advanced section built
// from the declarative table (save on change, clamping, resets), the per-site editor (saved through sw:site-set, so
// the content-script registration follows), settings export/import, and labels for every control.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { catalogFor, msg } from "../../../src/shared/i18n/index.ts";
import { DEFAULT_SETTINGS, type Settings, type SiteSettings } from "../../../src/shared/settings.ts";
import { ADVANCED_FIELDS, fieldId, fieldText } from "../../../src/ui/options/advanced-model.ts";
import { SETTINGS_EXPORT_FORMAT } from "../../../src/ui/options/settings-transfer.ts";
import { until } from "../sw/sw-helpers.ts";
import type { FakeElement } from "./fake-dom.ts";
import { closePage, json, openPage, texts, type PageRun } from "./page-harness.ts";

const BASE_URL = "http://127.0.0.1:11434/v1";
const SITE = "https://reader.example";

const restores: Array<() => void> = [];
afterEach(async () => {
  while (restores.length > 0) restores.pop()?.();
  await closePage();
});

/** Answers window.confirm() with `answer` and records the questions. */
function stubConfirm(answer: boolean): string[] {
  const asked: string[] = [];
  const holder = globalThis as { confirm?: unknown };
  const previous = holder.confirm;
  holder.confirm = (text: string) => {
    asked.push(text);
    return answer;
  };
  restores.push(() => {
    holder.confirm = previous;
  });
  return asked;
}

async function openOptions(
  options: { locale?: string; settings?: Record<string, unknown>; sites?: Record<string, unknown> } = {},
): Promise<PageRun> {
  const run = await openPage({
    page: "options",
    ids: ["app"],
    settings: {
      ui: { locale: options.locale ?? "en" },
      api: { baseUrl: BASE_URL, model: "qwen2.5vl:7b", apiKey: "sk-local" },
      ...options.settings,
    },
    sites: options.sites ?? {},
    answer: () => json(200, { data: [] }),
  });
  await until(() => run.dom.byId("app").findById("advanced") !== null, "options rendered");
  return run;
}

function byId(run: PageRun, id: string): FakeElement {
  const el = run.dom.byId("app").findById(id);
  if (el === null) throw new Error(`no #${id}`);
  return el;
}

function stored(run: PageRun): Settings {
  return run.browser.storageGet("local", "settings") as Settings;
}

function storedSite(run: PageRun, siteKey = SITE): SiteSettings {
  return run.browser.storageGet("local", `site:${siteKey}`) as SiteSettings;
}

function rowOf(run: PageRun, path: string): FakeElement {
  const row = byId(run, "advanced")
    .findAll("div")
    .find((div) => div.getAttribute("data-path") === path);
  if (row === undefined) throw new Error(`no row ${path}`);
  return row;
}

function rowMessage(run: PageRun, path: string): string {
  return (
    rowOf(run, path)
      .findAll("p")
      .find((p) => p.className === "field-msg")?.textContent ?? ""
  );
}

/** Types a value into an Advanced control and leaves it (the change event). */
function change(run: PageRun, id: string, value: string | boolean): void {
  const control = byId(run, id);
  if (typeof value === "boolean") control["checked"] = value;
  else control.value = value;
  run.dispatch(control, "change");
}

/** Every form control of the page has an accessible name: a <label for>, a wrapping <label> or aria-label. */
function unlabeled(root: FakeElement): string[] {
  const labelled = new Set(
    root
      .findAll("label")
      .map((label) => label.getAttribute("for"))
      .filter((id): id is string => id !== null),
  );
  const wrapped = new Set(root.findAll("label").flatMap((label) => [...label.findAll("input")]));
  return ["input", "select", "textarea"]
    .flatMap((tag) => root.findAll(tag))
    .filter((el) => el["hidden"] !== true && el.getAttribute("type") !== "file")
    .filter((el) => {
      const id = el.getAttribute("id");
      return !(id !== null && labelled.has(id)) && !wrapped.has(el) && el.getAttribute("aria-label") === null;
    })
    .map((el) => `${el.tagName}#${el.getAttribute("id") ?? "?"}`);
}

describe("options page: Advanced section", () => {
  test("collapsed <details>, one labeled row per table entry grouped by section, values from storage", async () => {
    const run = await openOptions({ settings: { render: { maxFontPx: 40 }, api: { temperature: null } } });
    const details = byId(run, "advanced-details");
    assert.equal(details.tagName, "DETAILS");
    assert.notEqual(details["open"], true, "collapsed by default");
    assert.deepEqual(texts(details.findAll("summary")[0] as FakeElement, "h2"), [
      msg().optionsAdvanced.heading,
    ]);
    assert.deepEqual(
      texts(details, "legend"),
      [
        "api",
        "translate",
        "detector",
        "engine",
        "discovery",
        "render",
        "memory",
        "cache",
        "privacy",
        "debug",
      ].map((section) => (msg().optionsAdvanced.groups as Record<string, string>)[section]),
    );
    for (const field of ADVANCED_FIELDS) {
      const id = fieldId(field);
      const control = byId(run, id);
      const label = details.findAll("label").find((candidate) => candidate.getAttribute("for") === id);
      assert.equal(label?.textContent, fieldText(field, msg()).label, field.path);
      assert.equal(control.getAttribute("aria-describedby"), `${id}-hint`, field.path);
    }
    assert.equal(byId(run, "adv-render-maxFontPx").value, "40");
    assert.equal(byId(run, "adv-render-maxFontPx").getAttribute("min"), "16");
    assert.equal(byId(run, "adv-api-temperature").value, "");
    assert.equal(byId(run, "adv-api-firstByteTimeoutMs").value, "180", "milliseconds shown as seconds");
    assert.equal(byId(run, "adv-privacy-maxImageBytes").value, "32", "bytes shown as MiB");
    assert.equal(byId(run, "adv-memory-enabled")["checked"], true);
    assert.equal(byId(run, "adv-detector-backend").value, "auto");
    assert.equal(rowOf(run, "render.maxFontPx").className, "adv-field modified");
    assert.equal(rowOf(run, "render.minFontPx").className, "adv-field");
    const hint = byId(run, "adv-render-maxFontPx-hint").textContent;
    assert.ok(hint.endsWith("Default: 64 · Allowed: 16 to 120"), hint);
  });

  test("every control of the page has a label", async () => {
    const run = await openOptions({ sites: { [SITE]: { enabled: true } } });
    run.dispatch(byId(run, "site-1-toggle"), "click");
    assert.deepEqual(unlabeled(run.dom.byId("app")), []);
  });

  test("a change is saved; out-of-range values are clamped and reported; invalid input is refused", async () => {
    const run = await openOptions();
    change(run, "adv-render-maxFontPx", "40");
    await until(() => stored(run).render.maxFontPx === 40, "maxFontPx saved");
    await until(() => rowMessage(run, "render.maxFontPx") === msg().options.saved, "saved message");
    assert.equal(byId(run, "adv-render-maxFontPx").value, "40");

    change(run, "adv-render-maxFontPx", "500");
    await until(() => stored(run).render.maxFontPx === 120, "clamped to the limit");
    assert.equal(rowMessage(run, "render.maxFontPx"), msg().optionsAdvanced.adjusted("120"));
    assert.equal(byId(run, "adv-render-maxFontPx").value, "120");

    change(run, "adv-render-maxFontPx", "big");
    assert.equal(rowMessage(run, "render.maxFontPx"), msg().optionsAdvanced.notANumber);
    assert.equal(stored(run).render.maxFontPx, 120, "nothing saved");

    change(run, "adv-api-firstByteTimeoutMs", "30");
    await until(() => stored(run).api.firstByteTimeoutMs === 30_000, "seconds stored as ms");
    change(run, "adv-api-temperature", "");
    await until(() => stored(run).api.temperature === null, "empty = provider default");
    change(run, "adv-memory-enabled", false);
    await until(() => !stored(run).memory.enabled, "checkbox saved");
    change(run, "adv-detector-backend", "wasm");
    await until(() => stored(run).detector.backend === "wasm", "select saved");
    change(run, "adv-render-font", "mali");
    await until(() => stored(run).render.font === "mali", "font saved");
    change(run, "adv-render-peekKey", "Key H");
    assert.equal(rowMessage(run, "render.peekKey"), msg().optionsAdvanced.badKey);
    change(run, "adv-render-peekKey", " KeyH ");
    await until(() => stored(run).render.peekKey === "KeyH", "key code saved");
    assert.equal(stored(run).api.baseUrl, BASE_URL, "other settings untouched");
    assert.equal(stored(run).api.apiKey, "sk-local");
  });

  test("a related setting is respected: maxInFlight never drops below the parallel requests", async () => {
    const run = await openOptions({ settings: { api: { concurrency: 3 } } });
    change(run, "adv-api-maxInFlight", "1");
    await until(() => rowMessage(run, "api.maxInFlight") !== "", "message");
    assert.equal(rowMessage(run, "api.maxInFlight"), msg().optionsAdvanced.adjusted("3"));
    assert.equal(stored(run).api.maxInFlight, 3);
    assert.equal(byId(run, "adv-api-maxInFlight").value, "3");
  });

  test("Reset puts one row back to its default; Reset all (after confirming) restores every row", async () => {
    const run = await openOptions({
      settings: { render: { maxFontPx: 40, showDoneBadge: true }, memory: { historyMaxLines: 3 } },
    });
    const reset = rowOf(run, "render.maxFontPx").findAll("button")[0] as FakeElement;
    assert.equal(reset["disabled"], false);
    assert.equal(
      reset.getAttribute("aria-label"),
      msg().optionsAdvanced.resetLabel("Largest text size (pixels)"),
    );
    assert.equal((rowOf(run, "render.minFontPx").findAll("button")[0] as FakeElement)["disabled"], true);
    run.dispatch(reset, "click");
    await until(() => stored(run).render.maxFontPx === DEFAULT_SETTINGS.render.maxFontPx, "row reset");
    assert.equal(byId(run, "adv-render-maxFontPx").value, "64");
    assert.equal(
      byId(run, "adv-render-maxFontPx")["focuses"],
      1,
      "focus moves from the disabled button to the input",
    );
    assert.equal(stored(run).memory.historyMaxLines, 3, "other rows kept");

    const declined = stubConfirm(false);
    run.dispatch(byId(run, "adv-reset-all"), "click");
    assert.deepEqual(declined, [msg().optionsAdvanced.resetAllConfirm]);
    assert.equal(stored(run).memory.historyMaxLines, 3, "not reset without confirmation");
    restores.pop()?.();
    stubConfirm(true);
    run.dispatch(byId(run, "adv-reset-all"), "click");
    await until(
      () => stored(run).memory.historyMaxLines === DEFAULT_SETTINGS.memory.historyMaxLines,
      "reset",
    );
    assert.equal(stored(run).render.showDoneBadge, false);
    assert.equal(stored(run).api.baseUrl, BASE_URL, "basic settings are not part of the section");
    assert.equal(byId(run, "adv-render-showDoneBadge")["checked"], false);
    assert.ok(texts(byId(run, "advanced"), "p").includes(msg().optionsAdvanced.resetAllDone));
  });

  test("a change made elsewhere (another tab, an import) shows up in the controls", async () => {
    const run = await openOptions();
    await run.context.run(() =>
      chrome.storage.local.set({
        settings: { ...stored(run), memory: { ...stored(run).memory, historyMaxLines: 7 } },
      }),
    );
    await until(() => byId(run, "adv-memory-historyMaxLines").value === "7", "control updated");
  });

  test("Vietnamese: labels, groups and hints come from the vi catalog", async () => {
    const vi = catalogFor("vi");
    const run = await openOptions({ locale: "vi" });
    const details = byId(run, "advanced-details");
    assert.deepEqual(texts(details.findAll("summary")[0] as FakeElement, "h2"), [vi.optionsAdvanced.heading]);
    const label = details.findAll("label").find((el) => el.getAttribute("for") === "adv-render-maxFontPx");
    assert.equal(label?.textContent, vi.optionsAdvanced.fields["render.maxFontPx"].label);
    assert.notEqual(label?.textContent, catalogFor("en").optionsAdvanced.fields["render.maxFontPx"].label);
  });
});

describe("options page: per-site editor", () => {
  test("Settings opens the editor; each control saves through sw:site-set and the registration follows", async () => {
    const run = await openOptions({ sites: { [SITE]: { enabled: true, mode: "auto" } } });
    const toggle = byId(run, "site-1-toggle");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-label"), msg().optionsAdvanced.site.settingsFor(SITE));
    assert.equal(run.dom.byId("app").findById("site-1-editor"), null, "closed by default");
    run.dispatch(toggle, "click");
    assert.equal(byId(run, "site-1-toggle").getAttribute("aria-expanded"), "true");
    const editor = byId(run, "site-1-editor");
    assert.equal(editor.getAttribute("data-site"), SITE);
    assert.deepEqual(texts(editor, "label"), [
      msg().optionsAdvanced.site.layout,
      msg().sidepanel.glossary.sourceLang,
      msg().optionsAdvanced.site.referer,
      ` ${msg().popup.cookies}`,
      ` ${msg().optionsAdvanced.site.subdomains}`,
      ` ${msg().optionsAdvanced.site.prefetch}`,
      msg().optionsAdvanced.site.frames,
    ]);
    assert.equal(byId(run, "site-1-prefetchAhead").checked, true, "preparing images ahead is on by default");

    change(run, "site-1-layout", "paged-rtl");
    await until(() => storedSite(run).layout === "paged-rtl", "layout saved");
    change(run, "site-1-sourceLang", "ko");
    await until(() => storedSite(run).sourceLang === "ko", "source language saved");
    change(run, "site-1-referer", "page-url");
    await until(() => storedSite(run).referer === "page-url", "referer saved");
    change(run, "site-1-credentials", true);
    await until(() => storedSite(run).credentials === "include", "cookies saved");
    change(run, "site-1-prefetchAhead", false);
    await until(() => storedSite(run).prefetchAhead === false, "prefetch ahead saved");
    change(run, "site-1-includeSubdomains", true);
    await until(
      () =>
        run.browser.registeredScripts.get("ctv-main")?.matches?.includes("https://*.reader.example/*") ===
        true,
      "registration covers the subdomains",
    );
    assert.equal(byId(run, "site-1-editor").findAll("p").at(-1)?.textContent, msg().options.saved);
    assert.equal(
      byId(run, "site-1-layout").value,
      "paged-rtl",
      "the editor stays open with the stored values",
    );

    change(run, "site-1-mode", "manual");
    await until(() => storedSite(run).mode === "manual", "mode saved from the row");
    assert.equal(storedSite(run).enabled, true);
  });

  test("reader frames: invalid lines are reported and kept for fixing; valid origins are saved and registered", async () => {
    const run = await openOptions({ sites: { [SITE]: { enabled: true } } });
    run.dispatch(byId(run, "site-1-toggle"), "click");
    change(run, "site-1-extraFrameOrigins", "https://viewer.example/ch/1\nviewer2.example");
    const note = byId(run, "site-1-editor").findAll("p").at(-1)?.textContent;
    assert.equal(note, msg().optionsAdvanced.site.framesInvalid("viewer2.example"));
    assert.equal(byId(run, "site-1-extraFrameOrigins").value, "https://viewer.example/ch/1\nviewer2.example");
    assert.deepEqual(storedSite(run).extraFrameOrigins, [], "nothing saved");

    change(run, "site-1-extraFrameOrigins", "https://viewer.example/ch/1\nhttps://VIEWER2.example");
    await until(() => storedSite(run).extraFrameOrigins.length === 2, "frames saved");
    assert.deepEqual(storedSite(run).extraFrameOrigins, [
      "https://viewer.example",
      "https://viewer2.example",
    ]);
    await until(
      () =>
        run.browser.registeredScripts.get("ctv-main")?.matches?.includes("https://viewer2.example/*") ===
        true,
      "frame origins registered",
    );
    assert.equal(
      byId(run, "site-1-extraFrameOrigins").value,
      "https://viewer.example\nhttps://viewer2.example",
    );
  });

  test("a save does not rebuild the editor: text being typed in another field survives", async () => {
    const run = await openOptions({ sites: { [SITE]: { enabled: true } } });
    run.dispatch(byId(run, "site-1-toggle"), "click");
    const frames = byId(run, "site-1-extraFrameOrigins");
    change(run, "site-1-layout", "webtoon");
    // The user moves on and types while the layout save is still on its way.
    run.dom.document.activeElement = frames;
    frames.value = "https://viewer.exa";
    await until(() => storedSite(run).layout === "webtoon", "layout saved");
    await until(
      () => byId(run, "site-1-editor").findAll("p").at(-1)?.textContent === msg().options.saved,
      "note",
    );
    assert.equal(byId(run, "site-1-extraFrameOrigins"), frames, "the same text area");
    assert.equal(frames.value, "https://viewer.exa");
    run.dom.document.activeElement = null;
  });

  test("turning a site on before the privacy notice was confirmed asks first", async () => {
    const run = await openOptions({ sites: { [SITE]: { enabled: false } } });
    change(run, "site-1-enabled", true);
    const notice = byId(run, "sites")
      .findAll("div")
      .find((div) => div.className === "notice");
    assert.ok(notice !== undefined, "privacy notice shown");
    assert.equal(storedSite(run).enabled, false);
    run.dispatch(notice.byText("button", msg().ui.privacyAccept), "click");
    await until(() => storedSite(run).enabled, "enabled after confirming");
    assert.notEqual(stored(run).privacy.ackUploadNoticeAt, null);
  });

  test("Remove deletes the site and closes its editor", async () => {
    const run = await openOptions({ sites: { [SITE]: { enabled: true } } });
    run.dispatch(byId(run, "site-1-toggle"), "click");
    run.dispatch(byId(run, "site-1-remove"), "click");
    await until(() => run.browser.storageGet("local", `site:${SITE}`) === undefined, "removed");
    await until(() => texts(byId(run, "sites"), "p").includes(msg().options.sitesEmpty), "empty list");
  });
});

describe("options page: back up and restore", () => {
  /** Captures the Blob of the next download (URL.createObjectURL) as text. */
  function captureDownloads(): Blob[] {
    const blobs: Blob[] = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:test";
    };
    URL.revokeObjectURL = () => undefined;
    restores.push(() => {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    });
    return blobs;
  }

  test("Export downloads settings and sites; the API key only when ticked", async () => {
    const blobs = captureDownloads();
    const run = await openOptions({ sites: { [SITE]: { enabled: true, layout: "webtoon" } } });
    run.dispatch(byId(run, "export-settings"), "click");
    await until(() => blobs.length === 1, "downloaded");
    const first = JSON.parse((await blobs[0]?.text()) ?? "") as Record<string, Record<string, unknown>>;
    assert.equal(first["format"], SETTINGS_EXPORT_FORMAT);
    assert.ok(!("apiKey" in (first["settings"]?.["api"] as object)));
    assert.equal((first["sites"]?.[SITE] as SiteSettings).layout, "webtoon");
    assert.equal(run.dom.document.body.findAll("a").length, 0, "the temporary link is removed");

    byId(run, "export-api-key")["checked"] = true;
    run.dispatch(byId(run, "export-settings"), "click");
    await until(() => blobs.length === 2, "downloaded again");
    const second = JSON.parse((await blobs[1]?.text()) ?? "") as { settings: { api: { apiKey: string } } };
    assert.equal(second.settings.api.apiKey, "sk-local");
  });

  test("Import validates the file, asks, stores settings and sites, and lists what changed", async () => {
    const run = await openOptions();
    const picker = byId(run, "import-file");
    run.dispatch(byId(run, "import-settings"), "click");
    assert.equal(picker["clicks"], 1, "the button opens the file picker");

    const pick = (text: string): void => {
      picker["files"] = [new File([text], "settings.json", { type: "application/json" })];
      run.dispatch(picker, "change");
    };
    const message = (): string =>
      byId(run, "transfer")
        .findAll("p")
        .find((p) => p.className === "message")?.textContent ?? "";

    pick("{nope");
    await until(() => message() === msg().optionsAdvanced.transfer.notJson, "invalid JSON refused");
    pick(JSON.stringify({ format: "something-else", version: 1, settings: {} }));
    await until(() => message() === msg().optionsAdvanced.transfer.notSettings, "other file refused");

    const asked = stubConfirm(true);
    const file = {
      format: SETTINGS_EXPORT_FORMAT,
      version: 1,
      settings: {
        api: { baseUrl: BASE_URL, model: "llava:13b" },
        render: { maxFontPx: 48 },
        ui: { locale: "en" },
      },
      sites: { [SITE]: { enabled: true, mode: "manual", sourceLang: "ja" } },
    };
    pick(JSON.stringify(file));
    await until(() => storedSite(run)?.mode === "manual", "site imported");
    assert.deepEqual(asked, [msg().optionsAdvanced.transfer.importConfirm]);
    const settings = stored(run);
    assert.deepEqual(
      [settings.api.model, settings.render.maxFontPx, settings.api.apiKey],
      ["llava:13b", 48, "sk-local"],
      "the current API key is kept",
    );
    assert.equal(storedSite(run).sourceLang, "ja");
    await until(
      () => run.browser.registeredScripts.size === 1,
      "imported sites registered through sw:site-set",
    );
    await until(() => message() !== msg().optionsAdvanced.transfer.notSettings, "summary");
    assert.equal(message(), msg().optionsAdvanced.transfer.imported(2, 1));
    assert.deepEqual(texts(byId(run, "transfer"), "code"), ["api.model", "render.maxFontPx"]);
    assert.ok(texts(byId(run, "transfer"), "p").includes(msg().optionsAdvanced.transfer.keyKept));
    await until(() => byId(run, "model").value === "llava:13b", "the endpoint form follows the import");
    await until(
      () => byId(run, "adv-render-maxFontPx").value === "48",
      "the Advanced form follows the import",
    );
    assert.equal(run.reloads(), 0, "same UI language: no reload");
  });

  test("an import that changes the interface language reloads the page", async () => {
    const run = await openOptions();
    stubConfirm(true);
    const picker = byId(run, "import-file");
    const file = { format: SETTINGS_EXPORT_FORMAT, version: 1, settings: { ui: { locale: "vi" } } };
    picker["files"] = [new File([JSON.stringify(file)], "s.json")];
    run.dispatch(picker, "change");
    await until(() => run.reloads() === 1, "reloaded");
    assert.equal(stored(run).ui.locale, "vi");
  });
});
