import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { onMessageFor } from "../../../src/platform/messaging.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import { catalogFor, msg, setLocale } from "../../../src/shared/i18n/index.ts";
import {
  DEFAULT_SETTINGS,
  migrateSite,
  type Settings,
  type SiteSettings,
} from "../../../src/shared/settings.ts";
import { swAllow, swHandlers } from "../../../src/sw/router.ts";
import {
  acceptNoticeAndEnable,
  activeTab,
  retranslateTab,
  translateVisible,
  updateSite,
} from "../../../src/ui/popup/popup-actions.ts";
import { siteView, toggleStep, visibleMessage } from "../../../src/ui/popup/popup-model.ts";
import type { FakeBrowserOptions } from "../../support/chrome-fake.ts";
import { startBrowser, stopBrowser } from "../sw/sw-helpers.ts";

afterEach(stopBrowser);

const acked: Settings = {
  ...DEFAULT_SETTINGS,
  privacy: { ...DEFAULT_SETTINGS.privacy, ackUploadNoticeAt: 1 },
};

describe("popup model", () => {
  test("siteView: http(s) tabs get their site (mode, cookies); other pages are unsupported", () => {
    const sites = {
      "https://reader.example": migrateSite({ enabled: true, mode: "manual" }, 1),
      "https://members.example": migrateSite({ enabled: true, credentials: "include" }, 1),
    };
    assert.deepEqual(siteView("https://reader.example/ch/1?p=2", sites), {
      kind: "site",
      siteKey: "https://reader.example",
      enabled: true,
      mode: "manual",
      cookies: false,
    });
    assert.deepEqual(siteView("https://members.example/library", sites), {
      kind: "site",
      siteKey: "https://members.example",
      enabled: true,
      mode: "auto",
      cookies: true,
    });
    assert.deepEqual(siteView("https://new.example/", sites), {
      kind: "site",
      siteKey: "https://new.example",
      enabled: false,
      mode: "auto",
      cookies: false,
    });
    for (const url of [undefined, "chrome://extensions/", "file:///C:/a.html", "about:blank"]) {
      assert.deepEqual(siteView(url, sites), { kind: "unsupported" }, String(url));
    }
  });

  test("toggleStep: the first enable needs the privacy notice; later enables and any disable do not", () => {
    assert.equal(toggleStep(false, DEFAULT_SETTINGS), "consent");
    assert.equal(toggleStep(false, acked), "enable");
    assert.equal(toggleStep(true, DEFAULT_SETTINGS), "disable");
    assert.equal(toggleStep(true, acked), "disable");
  });

  test("visibleMessage: msg().popup texts, English by default", () => {
    assert.equal(visibleMessage({ kind: "sent", submitted: 3 }), "Sent 3 images for translation.");
    assert.equal(visibleMessage({ kind: "sent", submitted: 1 }), "Sent 1 image for translation.");
    assert.equal(visibleMessage({ kind: "sent", submitted: 0 }), "No comic images visible.");
    assert.equal(visibleMessage({ kind: "sent", submitted: 0 }), msg().popup.visibleSent(0));
    assert.equal(visibleMessage({ kind: "unavailable" }), msg().popup.visibleUnavailable);
    assert.equal(
      visibleMessage({ kind: "error", error: { code: "site.disabled", message: "x", retryable: false } }),
      msg().popup.actionFailed(msg().errors["site.disabled"].title),
    );
    assert.equal(
      visibleMessage({ kind: "error", error: { code: "site.disabled", message: "x", retryable: false } }),
      "Could not do that: Translation is off for this site",
    );
  });

  test("visibleMessage follows the UI locale (vi), then English again", () => {
    const vi = catalogFor("vi");
    const error = {
      kind: "error",
      error: { code: "api.unreachable", message: "x", retryable: true },
    } as const;
    try {
      setLocale("vi");
      assert.equal(visibleMessage({ kind: "sent", submitted: 3 }), vi.popup.visibleSent(3));
      assert.notEqual(visibleMessage({ kind: "sent", submitted: 3 }), "Sent 3 images for translation.");
      assert.equal(visibleMessage({ kind: "unavailable" }), vi.popup.visibleUnavailable);
      assert.equal(visibleMessage(error), vi.popup.actionFailed(vi.errors["api.unreachable"].title));
    } finally {
      setLocale("en");
    }
    assert.equal(visibleMessage({ kind: "sent", submitted: 3 }), "Sent 3 images for translation.");
  });
});

async function popupWith(options: FakeBrowserOptions = {}): Promise<{
  browser: Awaited<ReturnType<typeof startBrowser>>["browser"];
  popup: ReturnType<Awaited<ReturnType<typeof startBrowser>>["browser"]["openExtensionPage"]>;
}> {
  const { browser, sw } = await startBrowser(options);
  sw.run(() => onMessageFor("sw", swHandlers, { allow: swAllow }));
  return { browser, popup: browser.openExtensionPage("popup", "ui/popup.html") };
}

describe("popup actions (through the service worker)", () => {
  test("activeTab is the active tab of the current window", async () => {
    const { browser, popup } = await popupWith();
    browser.openTab("https://a.example/");
    const b = browser.openTab("https://b.example/");
    assert.equal((await popup.run(() => activeTab()))?.id, b.id);
  });

  test("updateSite enables the site for the tab (registration + immediate injection); mode changes save", async () => {
    const { browser, popup } = await popupWith();
    const tab = browser.openTab("https://reader.example/ch/1");
    assert.equal(
      await popup.run(() => updateSite("https://reader.example", { enabled: true }, tab.id)),
      true,
    );
    assert.equal(browser.executeScriptCalls.length, 1);
    await popup.run(() => updateSite("https://reader.example", { mode: "manual" }, null));
    const stored = browser.storageGet("local", "site:https://reader.example") as SiteSettings;
    assert.deepEqual([stored.enabled, stored.mode], [true, "manual"]);
  });

  test("accepting the notice records the acknowledgement, then enables the site", async () => {
    const { browser, popup } = await popupWith();
    const tab = browser.openTab("https://reader.example/ch/1");
    const before = Date.now();
    const at = await popup.run(() => acceptNoticeAndEnable("https://reader.example", tab.id));
    assert.ok(at >= before);
    assert.equal((browser.storageGet("local", "settings") as Settings).privacy.ackUploadNoticeAt, at);
    assert.equal((browser.storageGet("local", "site:https://reader.example") as SiteSettings).enabled, true);
  });

  test("translateVisible: direct when the content script listens", async () => {
    const { browser, popup } = await popupWith();
    const tab = browser.openTab("https://reader.example/");
    browser
      .injectContent(tab.id)
      .run(() => onMessageFor("cs", { "cs:translate-visible": () => ({ submitted: 5 }) }));
    assert.deepEqual(await popup.run(() => translateVisible(tab.id)), { kind: "sent", submitted: 5 });
    assert.equal(browser.executeScriptCalls.length, 0);
  });

  test("translateVisible: injects in manual mode (sw:inject) when nothing listens, then sends", async () => {
    const { browser, popup } = await popupWith({
      onContentInjected: () => {
        onMessageFor("cs", { "cs:translate-visible": () => ({ submitted: 2 }) });
      },
    });
    const tab = browser.openTab("https://not-enabled.example/");
    assert.deepEqual(await popup.run(() => translateVisible(tab.id)), { kind: "sent", submitted: 2 });
    assert.deepEqual(
      browser.executeScriptCalls.map((call) => call.hasFunc),
      [true, false],
    );
    delete (globalThis as { __ctvManual?: number }).__ctvManual;
  });

  test("translateVisible: unscriptable pages and content-script errors", async () => {
    const { browser, popup } = await popupWith();
    const internal = browser.openTab("chrome://settings/");
    browser.failNext("scripting.executeScript", "Cannot access a chrome:// URL");
    assert.deepEqual(await popup.run(() => translateVisible(internal.id)), { kind: "unavailable" });

    const tab = browser.openTab("https://reader.example/");
    browser.injectContent(tab.id).run(() =>
      onMessageFor("cs", {
        "cs:translate-visible": () => {
          throw new CtvError("site.disabled", "turned off");
        },
      }),
    );
    const outcome = await popup.run(() => translateVisible(tab.id));
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.kind === "error" ? outcome.error.code : "", "site.disabled");
  });

  test("retranslateTab is a no-op without a running engine", async () => {
    const { browser, popup } = await popupWith({
      onOffscreenCreated: () => {
        onMessageFor("engine", { "en:retranslate": (payload) => ({ queued: payload.tabId * 10 }) });
      },
    });
    assert.equal(await popup.run(() => retranslateTab(3)), null);
    assert.equal(browser.offscreen, null);
    await browser.serviceWorker?.run(() =>
      chrome.offscreen.createDocument({
        url: "engine/offscreen.html",
        reasons: ["WORKERS"],
        justification: "t",
      }),
    );
    assert.equal(await popup.run(() => retranslateTab(3)), 30);
  });
});
