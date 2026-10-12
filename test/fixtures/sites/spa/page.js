// /spa/ and /spa/ch/<n>: client-side routing with pushState/popstate. Each render throws the old tree away and
// builds new <img> nodes (same URLs for the same chapter), like a framework re-render.
(() => {
  if (typeof document === "undefined") {
    return;
  }
  const fx = window.__ctvFixture;
  const data = fx.data || {};
  const chapters = data.chapters || [];
  const root = document.getElementById("root");
  let renders = 0;

  const current = () => {
    const m = /^\/spa\/ch\/(\d+)\/?$/.exec(location.pathname);
    const n = m === null ? 1 : Number(m[1]);
    return Math.min(Math.max(n, 1), Math.max(chapters.length, 1));
  };
  const href = (n) => `/spa/ch/${n}${location.search}`;
  const link = (text, n) => {
    const a = document.createElement("a");
    a.href = href(n);
    a.dataset.spa = String(n);
    a.textContent = text;
    return a;
  };

  const render = () => {
    const ch = current();
    const main = document.createElement("main");
    main.className = "reader";
    const title = document.createElement("h1");
    title.textContent = `Chapter ${ch}`;
    main.append(title);
    (chapters[ch - 1] || []).forEach((view, i) => {
      const img = document.createElement("img");
      img.id = `c${ch}p${i + 1}`;
      img.className = "page";
      if (data.lazy === "native") {
        img.loading = "lazy";
      }
      if (data.crossorigin) {
        img.crossOrigin = data.crossorigin;
      }
      if (view.w && view.h) {
        img.width = view.w;
        img.height = view.h;
      }
      img.alt = `chapter ${ch} page ${i + 1}`;
      img.dataset.fixtureFile = view.file;
      img.src = view.src;
      main.append(img);
    });
    const nav = document.createElement("nav");
    nav.className = "spa-nav";
    nav.append(
      ch > 1 ? link("Previous chapter", ch - 1) : document.createElement("span"),
      ch < chapters.length ? link("Next chapter", ch + 1) : document.createElement("span"),
    );
    main.append(nav);
    root.replaceChildren(main);
    renders += 1;
    document.title = `SPA reader | chapter ${ch}`;
    fx.log("render", { ch, renders });
  };

  const navigate = (n) => {
    history.pushState({ ch: n }, "", href(n));
    render();
  };

  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[data-spa]") : null;
    if (
      a === null ||
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    navigate(Number(a.dataset.spa));
  });
  window.addEventListener("popstate", render);
  document.getElementById("rerender")?.addEventListener("click", render);
  fx.navigate = navigate;
  fx.rerender = render;
  render();
})();
