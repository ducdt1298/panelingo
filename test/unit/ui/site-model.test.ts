// The options page's per-site editor model (src/ui/options/site-model.ts): choice lists agree with migrateSite,
// reader-frame origins are normalized and validated, and each control maps to a site patch storage keeps as is.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SITE, migrateSite, type SiteSettings } from "../../../src/shared/settings.ts";
import {
  framesText,
  parseFrameOrigins,
  parseSiteEdit,
  SITE_EDITOR_FIELDS,
  SITE_LAYOUTS,
  SITE_MODES,
  SITE_REFERERS,
  SITE_SOURCE_LANGS,
} from "../../../src/ui/options/site-model.ts";

const SITE = "https://reader.example";

describe("site choices", () => {
  test("every choice survives migrateSite and anything else falls back to the default", () => {
    const lists: Array<[keyof SiteSettings, readonly string[]]> = [
      ["mode", SITE_MODES],
      ["layout", SITE_LAYOUTS],
      ["sourceLang", SITE_SOURCE_LANGS],
      ["referer", SITE_REFERERS],
    ];
    for (const [key, choices] of lists) {
      assert.ok(choices.includes(DEFAULT_SITE[key as keyof typeof DEFAULT_SITE] as string), `${key} default`);
      for (const value of choices)
        assert.equal(migrateSite({ [key]: value }, 0)[key], value, `${key} ${value}`);
      assert.equal(migrateSite({ [key]: "bogus" }, 0)[key], DEFAULT_SITE[key as keyof typeof DEFAULT_SITE]);
    }
  });

  test("the editor covers every stored site setting except the internal one", () => {
    const stored = Object.keys(migrateSite({}, 0)).filter((key) => key !== "addedAt");
    assert.deepEqual([...SITE_EDITOR_FIELDS].sort(), stored.sort());
  });
});

describe("parseFrameOrigins", () => {
  test("lines become lowercase origins (paths dropped), deduplicated, the site itself left out", () => {
    const text = [
      " https://Viewer.Example.com/reader/ch-1 ",
      "",
      "https://viewer.example.com",
      "http://cdn.example.net:8080/x,",
      "https://reader.example/frame",
      "\r",
    ].join("\n");
    assert.deepEqual(parseFrameOrigins(text, SITE), {
      origins: ["https://viewer.example.com", "http://cdn.example.net:8080"],
      invalid: [],
    });
    assert.deepEqual(parseFrameOrigins("", SITE), { origins: [], invalid: [] });
  });

  test("anything that is not an http(s) URL is reported as typed", () => {
    assert.deepEqual(
      parseFrameOrigins(
        "viewer.example.com\nftp://cdn.example.com\nhttps://ok.example\nhttp:host.example",
        SITE,
      ),
      {
        origins: ["https://ok.example"],
        invalid: ["viewer.example.com", "ftp://cdn.example.com", "http:host.example"],
      },
    );
  });

  test("framesText lists one origin per line (it parses back to the same list)", () => {
    const origins = ["https://a.example", "https://b.example:8443"];
    assert.equal(framesText(origins), "https://a.example\nhttps://b.example:8443");
    assert.deepEqual(parseFrameOrigins(framesText(origins), SITE).origins, origins);
  });
});

describe("parseSiteEdit", () => {
  test("each control maps to its patch", () => {
    assert.deepEqual(parseSiteEdit(SITE, { field: "enabled", value: true }), {
      ok: true,
      patch: { enabled: true },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "mode", value: "manual" }), {
      ok: true,
      patch: { mode: "manual" },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "layout", value: "paged-rtl" }), {
      ok: true,
      patch: { layout: "paged-rtl" },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "sourceLang", value: "ko" }), {
      ok: true,
      patch: { sourceLang: "ko" },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "referer", value: "origin" }), {
      ok: true,
      patch: { referer: "origin" },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "credentials", value: true }), {
      ok: true,
      patch: { credentials: "include" },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "credentials", value: false }), {
      ok: true,
      patch: { credentials: "omit" },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "includeSubdomains", value: true }), {
      ok: true,
      patch: { includeSubdomains: true },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "prefetchAhead", value: false }), {
      ok: true,
      patch: { prefetchAhead: false },
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "extraFrameOrigins", value: "https://v.example/x\n" }), {
      ok: true,
      patch: { extraFrameOrigins: ["https://v.example"] },
    });
  });

  test("values outside the choices and invalid frame origins are refused", () => {
    assert.deepEqual(parseSiteEdit(SITE, { field: "layout", value: "vertical" }), {
      ok: false,
      invalid: ["vertical"],
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "sourceLang", value: "fr" }), {
      ok: false,
      invalid: ["fr"],
    });
    assert.deepEqual(parseSiteEdit(SITE, { field: "mode", value: "" }), { ok: false, invalid: [""] });
    assert.deepEqual(parseSiteEdit(SITE, { field: "extraFrameOrigins", value: "https://ok.example\nnope" }), {
      ok: false,
      invalid: ["nope"],
    });
  });

  test("every accepted patch is kept unchanged by migrateSite", () => {
    for (const layout of SITE_LAYOUTS) {
      const edit = parseSiteEdit(SITE, { field: "layout", value: layout });
      assert.ok(edit.ok);
      assert.equal(migrateSite({ ...DEFAULT_SITE, ...edit.patch }, 0).layout, layout);
    }
  });
});
