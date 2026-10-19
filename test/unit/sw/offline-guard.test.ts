// Offline mode and the service worker's SSRF guard: the local model mirror of dev and test builds
// (settings.debug.offlineModelBaseUrl) is let through only when dev hosts are, and changing it re-installs the rules.

import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateSettings } from "../../../src/shared/settings.ts";
import { guardAllowOrigins } from "../../../src/sw/install.ts";
import { guardInputsChanged } from "../../../src/sw/settings-relay.ts";

test("the offline model mirror is allowed in dev and test builds only, by origin", () => {
  const settings = migrateSettings({
    api: { baseUrl: "https://api.example.invalid/v1" },
    debug: { offlineModelBaseUrl: "http://127.0.0.1:9123/mirror" },
  });
  assert.deepEqual(guardAllowOrigins(settings, false), ["https://api.example.invalid"]);
  assert.deepEqual(guardAllowOrigins(settings, true), [
    "https://api.example.invalid",
    "http://127.0.0.1:9123",
  ]);
  assert.deepEqual(
    guardAllowOrigins(migrateSettings({}), true),
    ["https://api.openai.com"],
    "none by default",
  );
});

test("changing the mirror re-installs the guard rules; switching engines alone does not", () => {
  assert.equal(guardInputsChanged({}, { debug: { offlineModelBaseUrl: "http://127.0.0.1:9123" } }), true);
  assert.equal(guardInputsChanged({}, { translate: { engine: "offline" } }), false);
});
