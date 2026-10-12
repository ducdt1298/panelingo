// /webtoon/?lazy=io: swap data-src (or ?attr=data-lazy-src|data-original) into src when the image comes within
// ?margin px of the viewport, like common lazy-loading libraries. Other lazy modes need no script.
(() => {
  if (typeof document === "undefined") {
    return;
  }
  const fx = window.__ctvFixture;
  const data = fx.data || {};
  if (data.lazy !== "io") {
    return;
  }
  const attr = data.attr || "data-src";
  const swap = (img) => {
    const src = img.getAttribute(attr);
    if (src !== null && img.getAttribute("src") !== src) {
      img.src = src;
      img.classList.add("loaded");
      fx.log("lazy-load", img.id);
    }
  };
  const images = document.querySelectorAll(`img[${attr}]`);
  if (!("IntersectionObserver" in window)) {
    images.forEach(swap);
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          swap(entry.target);
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: `${Number(data.margin) || 0}px 0px` },
  );
  images.forEach((img) => io.observe(img));
})();
