// /canvas/?src=same|cors|cdn: draw each page into a <canvas>.
//   same: fetch the bytes from this origin (canvas stays readable)
//   cors: cross-origin <img crossorigin> with CORS headers (readable)
//   cdn:  cross-origin <img> without CORS (tainted: only a screen capture can read it)
(() => {
  if (typeof document === "undefined") {
    return;
  }
  const fx = window.__ctvFixture;
  const data = fx.data || {};
  const host = document.getElementById("canvases");

  const load = async (view) => {
    if (data.src === "same") {
      const res = await fetch(view.src, { credentials: "same-origin" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${view.src}`);
      }
      return createImageBitmap(await res.blob());
    }
    const img = new Image();
    if (data.src === "cors") {
      img.crossOrigin = "anonymous";
    }
    img.src = view.src;
    await img.decode();
    return img;
  };

  const draw = async (view, index) => {
    const canvas = document.createElement("canvas");
    canvas.id = `c${index + 1}`;
    canvas.className = "page";
    canvas.dataset.fixtureFile = view.file;
    if (view.w && view.h) {
      canvas.width = view.w;
      canvas.height = view.h;
    }
    host.append(canvas);
    const source = await load(view);
    canvas.width = source.naturalWidth || source.width;
    canvas.height = source.naturalHeight || source.height;
    canvas.getContext("2d").drawImage(source, 0, 0);
  };

  const views = data.images || [];
  Promise.all(views.map((view, i) => draw(view, i).catch((err) => fx.log("draw-error", String(err))))).then(
    () => {
      fx.drawn = true;
      document.documentElement.dataset.drawn = "1";
      fx.log("drawn", views.length);
    },
  );
})();
