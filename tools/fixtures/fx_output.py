"""Output bookkeeping: every written file is recorded (relative path) so manifest.json can list its sha256."""

import random
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from fx_fonts import Fonts
from fx_units import Canvas, Corpus
from fx_util import rng_for, save_jpeg, save_png, save_webp, write_json


class Output:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.files: list[str] = []
        self.fixtures: list[dict] = []

    def path(self, rel: str) -> Path:
        return self.root / rel

    def _add(self, rel: str) -> str:
        if rel in self.files:
            raise ValueError(f"file written twice: {rel}")
        self.files.append(rel)
        return rel

    def png(self, rel: str, img: Image.Image) -> str:
        save_png(img, self.path(rel))
        return self._add(rel)

    def webp(self, rel: str, img: Image.Image, quality: int = 85) -> str:
        save_webp(img, self.path(rel), quality)
        return self._add(rel)

    def jpeg(self, rel: str, img: Image.Image, quality: int = 90, subsampling: int = 2) -> str:
        save_jpeg(img, self.path(rel), quality, subsampling)
        return self._add(rel)

    def json(self, rel: str, obj: object) -> str:
        write_json(self.path(rel), obj)
        return self._add(rel)

    def emit(
        self,
        cv: Canvas,
        stem: str,
        fmt: str = "png",
        mask: bool = True,
        extra: dict | None = None,
        quality: int = 90,
    ) -> dict:
        """Write <stem>.<fmt>, optionally <stem>.mask.png, and <stem>.gt.json; return the image entry."""
        ext = {"png": "png", "webp": "webp", "jpeg": "jpg"}[fmt]
        image = f"{stem}.{ext}"
        if fmt == "png":
            self.png(image, cv.img)
        elif fmt == "webp":
            self.webp(image, cv.img, quality)
        else:
            self.jpeg(image, cv.img, quality)
        top: dict = {}
        if mask:
            top["mask"] = self.png(f"{stem}.mask.png", cv.mask)
        if extra:
            top.update(extra)
        gt = f"{stem}.gt.json"
        self.json(gt, cv.gt(image, top))
        return {"image": image, "gt": gt, "width": cv.w, "height": cv.h, "units": len(cv.units)}

    def fixture(
        self, name: str, group: str, lang: str, layout: str, images: list[dict], **more: object
    ) -> None:
        entry: dict = {"name": name, "group": group, "lang": lang, "layout": layout}
        entry.update(more)
        entry["images"] = images
        self.fixtures.append(entry)


@dataclass
class Ctx:
    out: Output
    fonts: Fonts
    corpus: Corpus
    seed: int

    def rng(self, *parts: object) -> random.Random:
        return rng_for(self.seed, *parts)
