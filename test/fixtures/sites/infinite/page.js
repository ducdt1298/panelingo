// /infinite/: when the sentinel under the last chapter comes near the viewport, append the next chapter
// (new <img> nodes) and history.pushState the chapter URL, like infinite-scroll readers.
(() => {
  if (typeof document === "undefined") {
    return;
  }
  const fx = window.__ctvFixture;
  const data = fx.data || {};
  const chapters = data.chapters || [];
  const sentinel = document.getElementById("sentinel");
  let last = data.ch || 1;

  const pageImage = (view, index, ch) => {
    const img = document.createElement("img");
    img.id = `c${ch}p${index + 1}`;
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
    img.alt = `chapter ${ch} page ${index + 1}`;
    img.dataset.fixtureFile = view.file;
    img.src = view.src;
    return img;
  };

  let io = null;
  const appendNext = () => {
    if (last >= chapters.length) {
      sentinel.textContent = "End of the series";
      if (io !== null) {
        io.disconnect();
      }
      return false;
    }
    const ch = last + 1;
    const section = document.createElement("section");
    section.className = "chapter";
    section.dataset.chapter = String(ch);
    const heading = document.createElement("h2");
    heading.textContent = `Chapter ${ch}`;
    section.append(heading, ...chapters[ch - 1].map((view, i) => pageImage(view, i, ch)));
    sentinel.before(section);
    last = ch;
    const url = new URL(location.href);
    url.searchParams.set("ch", String(ch));
    history.pushState({ ch }, "", url);
    fx.log("chapter", ch);
    return true;
  };

  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && appendNext()) {
        // Re-observe so a sentinel that is still in range triggers once more.
        io.unobserve(sentinel);
        io.observe(sentinel);
      }
    },
    { rootMargin: "800px 0px" },
  );
  io.observe(sentinel);
  fx.loadNext = appendNext;
})();
