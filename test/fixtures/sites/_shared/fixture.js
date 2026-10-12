// Shared helper of the fixture pages (plain script, no build step, Trusted Types safe: no HTML sinks).
// Exposes window.__ctvFixture for E2E: the page data (#ctv-fixture-data), CSP violations and a small event log.
(() => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return; // not a browser (e.g. picked up by a bare `node --test`)
  }
  const state = {
    page: document.documentElement.dataset.page || "",
    data: null,
    violations: [],
    events: [],
    prerenderedAtLoad: document.prerendering === true,
    log(type, detail) {
      state.events.push({
        t: Math.round(performance.now()),
        type,
        detail: detail === undefined ? null : detail,
      });
    },
  };
  window.__ctvFixture = state;

  document.addEventListener("securitypolicyviolation", (e) => {
    state.violations.push({
      directive: e.effectiveDirective,
      blockedURI: e.blockedURI,
      sample: e.sample,
      sourceFile: e.sourceFile,
      line: e.lineNumber,
    });
  });
  document.addEventListener("prerenderingchange", () => state.log("activated"));
  window.addEventListener("pageshow", (e) => state.log("pageshow", { persisted: e.persisted }));

  const el = document.getElementById("ctv-fixture-data");
  if (el !== null) {
    try {
      state.data = JSON.parse(el.textContent || "null");
    } catch (err) {
      state.log("data-error", String(err));
    }
  }
})();
