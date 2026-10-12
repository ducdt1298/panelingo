// /paged/?via=blob|data: fetch each page with CORS and show it through a blob: or data: URL,
// like readers that unscramble or proxy their images in script.
(() => {
  if (typeof document === "undefined") {
    return;
  }
  const fx = window.__ctvFixture;
  const toDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  for (const img of document.querySelectorAll("img[data-fetch-src]")) {
    const via = img.dataset.via;
    fetch(img.dataset.fetchSrc, { mode: "cors", credentials: "omit" })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.blob();
      })
      .then((blob) => (via === "data" ? toDataUrl(blob) : URL.createObjectURL(blob)))
      .then((url) => {
        img.src = url;
        fx.log("via-loaded", img.id);
      })
      .catch((err) => fx.log("via-error", `${img.id}: ${String(err)}`));
  }
})();
