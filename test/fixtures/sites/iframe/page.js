// /iframe/: fill the about:blank frame from the parent with DOM calls (it never navigates, so it keeps the
// parent's origin; content scripts reach it only with match_origin_as_fallback / match_about_blank).
(() => {
  if (typeof document === "undefined") {
    return;
  }
  const fx = window.__ctvFixture;
  const data = fx.data || {};
  const frame = document.getElementById("blank-frame");
  const doc = frame === null ? null : frame.contentDocument;
  if (doc === null || doc.body === null) {
    fx.log("blank-error", "no about:blank document");
    return;
  }
  const css = doc.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("/_shared/fixture.css", location.href).href;
  doc.head.append(css);
  doc.body.className = "frame-body";
  (data.images || []).forEach((view, i) => {
    const img = doc.createElement("img");
    img.id = `blank-p${i + 1}`;
    if (view.w && view.h) {
      img.width = view.w;
      img.height = view.h;
    }
    img.alt = `page ${i + 1}`;
    img.dataset.fixtureFile = view.file;
    img.src = view.src;
    doc.body.append(img);
  });
  fx.log("blank-filled", (data.images || []).length);
})();
