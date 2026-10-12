// /capture/<set>.html?set=<set>: draw the set's first image, from the other origin without CORS (so the canvas is
// tainted), into a canvas shown at its natural size (one CSS px per image px at devicePixelRatio 1). On the reader
// origin the image comes from the CDN; served by the CDN (/frame/capture/), it comes from the reader.
(() => {
  if (typeof document === "undefined") {
    return;
  }
  const fx = window.__ctvFixture;
  const data = fx.data || {};
  const host = document.getElementById("canvases");
  const view = (data.images || [])[0];
  if (!view) {
    fx.log("draw-error", "no image: open with ?set=<fixture set>");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.id = "c1";
  canvas.className = "page";
  canvas.dataset.fixtureFile = view.file;
  canvas.style.display = "block";
  canvas.style.margin = "16px auto";
  if (view.w && view.h) {
    canvas.width = view.w;
    canvas.height = view.h;
    canvas.style.width = `${view.w}px`;
    canvas.style.height = `${view.h}px`;
  }
  host.append(canvas);
  const img = new Image();
  const onCdn = data.cdn && location.origin === new URL(data.cdn).origin;
  img.src = onCdn ? `${data.reader}/img/${view.file.split("/").map(encodeURIComponent).join("/")}` : view.src;
  img
    .decode()
    .then(() => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.style.width = `${img.naturalWidth}px`;
      canvas.style.height = `${img.naturalHeight}px`;
      canvas.getContext("2d").drawImage(img, 0, 0);
      fx.drawn = true;
      document.documentElement.dataset.drawn = "1";
      fx.log("drawn", 1);
    })
    .catch((err) => fx.log("draw-error", String(err)));
})();
