// Overlay styles: one constructable sheet per document adopted by every shadow root (no <style>, no url(), nothing a
// page CSP or Trusted Types can block), plus the inline !important host reset that page CSS cannot override. Unit
// geometry is in natural px under the layer's scale transform; the UI layer and the bubble popup are in CSS px.

import { COMIC_FONT_STACK, FONT_FAMILIES } from "../fonts.ts";
import { FACES, cjkFaces } from "../lettering.ts";

/** Above page content when hosts live in the shared documentElement root. */
export const ROOT_Z_INDEX = "2147483000";

/**
 * The font list and weight of each lettering face, chosen by the unit's data-face (render.ts buildUnitNode): the
 * bundled faces, then the CJK system-font faces. Vertical units (data-vertical) set their columns top to bottom.
 */
const FACE_CSS = [
  ...Object.values(FACES).map((face) => ({
    key: face.key,
    stack: FONT_FAMILIES[face.family].stack,
    weight: face.weight,
  })),
  ...cjkFaces(),
]
  .map(
    (face) =>
      `.unit[data-face="${face.key}"] .line { font-family: ${face.stack}; font-weight: ${face.weight}; }`,
  )
  .join("\n");

export const OVERLAY_CSS = `
[hidden] { display: none !important; }
.clip { position: absolute; left: 0; top: 0; right: 0; bottom: 0; overflow: hidden; pointer-events: none; }
.layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; }
.unit { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.plates { position: absolute; pointer-events: none; }
.plates.clipped { overflow: hidden; }
.plates.ellipse { border-radius: 50%; }
.plate, .cover, .patch { position: absolute; box-sizing: border-box; margin: 0; padding: 0; border: 0; pointer-events: none; }
.plate.ellipse { border-radius: 50%; }
.line {
  position: absolute; box-sizing: content-box; margin: 0; padding: 0; border: 0; overflow: visible;
  font-family: ${COMIC_FONT_STACK}; font-weight: 400; font-style: normal; font-stretch: normal;
  font-kerning: normal; font-synthesis: none; font-variant: normal; font-feature-settings: normal;
  letter-spacing: normal; word-spacing: normal; text-transform: none; text-indent: 0; text-decoration: none;
  white-space: pre; text-align: center; pointer-events: none; user-select: none; -webkit-user-select: none;
}
${FACE_CSS}
.unit[data-vertical] .line { writing-mode: vertical-rl; text-orientation: mixed; }
.ui {
  position: absolute; left: 0; top: 0; right: 0; bottom: 0; pointer-events: none; color: #fff;
  font-family: system-ui, "Segoe UI", Roboto, Arial, sans-serif; font-size: 12px; line-height: 16px;
  text-align: left;
}
.stack {
  position: sticky; top: 0; box-sizing: border-box; padding: 8px; pointer-events: none;
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
}
.row { display: flex; align-items: center; gap: 6px; pointer-events: none; }
.badge {
  display: inline-flex; align-items: center; gap: 6px; max-width: 280px; box-sizing: border-box;
  padding: 3px 10px; border-radius: 999px; background: rgba(60, 64, 67, 0.88); color: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); white-space: nowrap; pointer-events: none;
}
.badge .text { overflow: hidden; text-overflow: ellipsis; }
.badge.muted { background: rgba(95, 99, 104, 0.82); }
.badge.busy { background: rgba(26, 115, 232, 0.92); }
.badge.ok { background: rgba(24, 128, 56, 0.92); }
.badge.warn { background: rgba(176, 96, 0, 0.94); }
.badge.error { background: rgba(197, 34, 31, 0.94); }
.spinner {
  flex: none; width: 10px; height: 10px; box-sizing: border-box; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff; animation: ctv-spin 0.8s linear infinite;
}
@keyframes ctv-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
button {
  pointer-events: auto; margin: 0; border: 0; border-radius: 999px; padding: 3px 10px; cursor: pointer;
  font: inherit; line-height: 16px; background: #fff; color: #202124; white-space: nowrap;
}
button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
.hover-btn {
  padding: 5px 14px; font-weight: 600; background: #1a73e8; color: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
.retry { padding: 1px 8px; }
.notice {
  pointer-events: auto; box-sizing: border-box; width: 320px; max-width: calc(100vw - 16px);
  padding: 12px 14px; border-radius: 10px; background: #fff; color: #202124;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35); font-size: 13px; line-height: 1.45;
  white-space: normal; cursor: auto; user-select: text; -webkit-user-select: text;
}
.notice .title { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
.notice .body { margin: 0 0 10px; }
.notice .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.notice .accept { background: #1a73e8; color: #fff; }
.notice .decline { background: #e8eaed; color: #202124; }
.popup {
  position: fixed; left: 8px; top: 8px; box-sizing: border-box; width: 320px; max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px); overflow: auto; padding: 12px 14px; border-radius: 10px;
  background: #fff; color: #202124; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35); pointer-events: auto;
  font-family: system-ui, "Segoe UI", Roboto, Arial, sans-serif; font-size: 13px; line-height: 1.45;
  text-align: left; white-space: normal; cursor: auto; user-select: text; -webkit-user-select: text;
}
.popup:focus { outline: none; }
.popup:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
.popup .head { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
.popup .title { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.popup .tag {
  flex: none; padding: 0 8px; border-radius: 999px; background: #e8f0fe; color: #1967d2; font-size: 11px;
}
.popup .label { margin: 8px 0 2px; color: #5f6368; font-size: 11px; font-weight: 600; }
.popup .text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.popup .original { color: #3c4043; }
.popup .editor {
  display: block; box-sizing: border-box; width: 100%; min-height: 72px; margin: 0; padding: 6px 8px;
  border: 1px solid #dadce0; border-radius: 6px; background: #fff; color: #202124; font: inherit; resize: vertical;
}
.popup .editor:focus { outline: 2px solid #8ab4f8; outline-offset: 0; }
.popup .note, .popup .status { margin: 6px 0 0; color: #5f6368; font-size: 12px; }
.popup .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-top: 10px; }
.popup .actions.extra { justify-content: flex-start; margin-top: 6px; }
.popup .actions button { background: #e8eaed; color: #202124; }
.popup .actions .primary { background: #1a73e8; color: #fff; }
.popup button:disabled { opacity: 0.5; cursor: default; }
`;

/** Inline reset of every host (and of the shared root): `all` first, longhands after it override it. */
export const HOST_RESET: ReadonlyArray<readonly [string, string]> = [
  ["all", "initial"],
  ["display", "block"],
  ["position", "absolute"],
  ["direction", "ltr"],
  ["overflow", "visible"],
  ["pointer-events", "none"],
  ["contain", "layout style"],
  ["visibility", "hidden"],
];

/** The shared documentElement root: a zero-size box at the document origin whose children use page coordinates. */
export const ROOT_RESET: ReadonlyArray<readonly [string, string]> = [
  ["all", "initial"],
  ["display", "block"],
  ["position", "absolute"],
  ["direction", "ltr"],
  ["left", "0"],
  ["top", "0"],
  ["width", "0"],
  ["height", "0"],
  ["overflow", "visible"],
  ["pointer-events", "none"],
  ["contain", "layout style"],
  ["z-index", ROOT_Z_INDEX],
];

const sheets = new WeakMap<Document, CSSStyleSheet>();

/** The overlay sheet of `doc`, built once and shared by all of its shadow roots. */
export function overlaySheet(doc: Document): CSSStyleSheet {
  let sheet = sheets.get(doc);
  if (sheet === undefined) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(OVERLAY_CSS);
    sheets.set(doc, sheet);
  }
  return sheet;
}
