"""Translation units (bubbles, caption boxes, thought clouds, free text, SFX, signs, page marks), their
placement on a canvas, and the ground-truth records written next to every image.

A *draft* is a fully laid-out unit in local coordinates with a footprint (w, h); placing it at (x, y) draws it
and appends its ground-truth record. Units are drawn in reading order, so the record id is the reading order.
"""

import json
import math
import random
from dataclasses import dataclass, field, replace
from pathlib import Path

from PIL import Image, ImageDraw

from fx_fonts import Fonts
from fx_text import (
    TCY_MAX,
    Block,
    Run,
    ascii_runs,
    layout_h,
    layout_v,
    render_column,
    render_line,
    rotate_run,
)
from fx_util import RGB, Box, box_json, clip, inflate, inside, overlaps, shift, union_all

SS = 3  # supersampling factor for shapes
BLACK: RGB = (17, 17, 17)
WHITE: RGB = (255, 255, 255)


# --------------------------------------------------------------------------- sentences


# Corpus languages (test/fixtures/sentences/<lang>.json); Spanish is set with the English fonts.
LANGS = ("ko", "ja", "zh", "en", "es")


@dataclass(frozen=True)
class Line:
    id: str
    type: str
    text: str
    lang: str
    vi: str | None = None
    canary: str | None = None
    speaker: str | None = None
    names: tuple[str, ...] = ()


class Corpus:
    """test/fixtures/sentences/{ko,ja,zh,en,es}.json (original lines, parallel ids across languages)."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.files: list[Path] = []
        self.lines: dict[str, list[Line]] = {}
        self.action: dict[str, list[Line]] = {}
        self.name_lines: dict[str, list[Line]] = {}
        self.cast: dict[str, list[dict]] = {}
        for lang in LANGS:
            p = folder / f"{lang}.json"
            self.files.append(p)
            doc = json.loads(p.read_text(encoding="utf-8"))
            self.lines[lang] = [self._line(x, lang) for x in doc["lines"]]
            self.action[lang] = [self._line(x, lang) for x in doc.get("actionLines", [])]
            self.name_lines[lang] = [self._line(x, lang) for x in doc.get("nameLines", [])]
            self.cast[lang] = list(doc.get("cast", []))

    @staticmethod
    def _line(x: dict, lang: str) -> Line:
        return Line(
            id=x["id"],
            type=x["type"],
            text=x["text"],
            lang=lang,
            vi=x.get("vi"),
            canary=x.get("canary"),
            speaker=x.get("speaker"),
            names=tuple(x.get("names", [])),
        )

    def get(self, lang: str, line_id: str) -> Line:
        for pool in (self.lines[lang], self.action[lang], self.name_lines[lang]):
            for ln in pool:
                if ln.id == line_id:
                    return ln
        raise KeyError(f"{lang}:{line_id}")

    def of_type(self, lang: str, *types: str) -> list[Line]:
        return [ln for ln in self.lines[lang] if ln.type in types]


class Deck:
    """Deal lines without replacement; reshuffle (deterministically) only when exhausted."""

    def __init__(self, items: list[Line], rng: random.Random) -> None:
        self.items = list(items)
        self.rng = rng
        self.pool: list[Line] = []

    def draw(self, avoid: tuple[str, ...] = ()) -> Line:
        if not self.pool:
            self.pool = list(self.items)
            self.rng.shuffle(self.pool)
        for i in range(len(self.pool) - 1, -1, -1):
            if self.pool[i].id not in avoid:
                return self.pool.pop(i)
        return self.pool.pop()


def synthetic_line(
    text: str, type_: str, lang: str, vi: str | None = None, canary: str | None = None
) -> Line:
    return Line(id="gen", type=type_, text=text, lang=lang, vi=vi, canary=canary)


# --------------------------------------------------------------------------- styles


@dataclass(frozen=True)
class Ink:
    fill: RGB = BLACK
    stroke: RGB | None = None
    stroke_w: int = 0


FONT_ROLE = {
    ("ko", "body"): "ko-bold",
    ("ko", "light"): "ko",
    ("ko", "thin"): "ko-thin",
    ("ko", "sfx"): "ko-bold",
    ("ja", "body"): "ja",
    ("ja", "light"): "ja-regular",
    ("ja", "thin"): "ja-regular",
    ("ja", "sfx"): "ja-bold",
    ("zh", "body"): "zh",
    ("zh", "light"): "zh",
    ("zh", "thin"): "zh",
    ("zh", "sfx"): "zh-bold",
    ("en", "body"): "en",
    ("en", "light"): "en-regular",
    ("en", "thin"): "en-regular",
    ("en", "sfx"): "en-sfx",
    ("es", "body"): "en",
    ("es", "light"): "en-regular",
    ("es", "thin"): "en-regular",
    ("es", "sfx"): "en-sfx",
}


def font_role(lang: str, weight: str) -> str:
    return FONT_ROLE[(lang, weight)]


def needs_horizontal(line: Line) -> bool:
    """Japanese lines with an ASCII run longer than the tate-chu-yoko limit are set horizontally."""
    return any(len(r) > TCY_MAX for r in ascii_runs(line.text))


# --------------------------------------------------------------------------- canvas


class LayoutError(RuntimeError):
    pass


class Canvas:
    def __init__(self, w: int, h: int, bg: RGB = WHITE, lang: str = "ko", layout: str = "paged-ltr") -> None:
        self.w, self.h = w, h
        self.img = Image.new("RGB", (w, h), bg)
        self.mask = Image.new("L", (w, h), 0)
        self.lang = lang
        self.layout = layout
        self.units: list[dict] = []
        self.footprints: list[Box] = []

    def paste_art(self, box: Box, art: Image.Image) -> None:
        self.img.paste(art, (box[0], box[1]))

    def frame(self, box: Box, width: int = 4, color: RGB = BLACK) -> None:
        if width <= 0:
            return
        d = ImageDraw.Draw(self.img)
        d.rectangle((box[0], box[1], box[2] - 1, box[3] - 1), outline=color, width=width)

    def place(self, draft: Draft, x: int, y: int, allow_outside: bool = False) -> dict:
        fp = (x, y, x + draft.w, y + draft.h)
        if not allow_outside and not inside(fp, (0, 0, self.w, self.h)):
            raise LayoutError(f"unit outside the image: {fp} in {self.w}x{self.h}")
        for f in self.footprints:
            if overlaps(fp, f):
                raise LayoutError(f"unit footprint {fp} overlaps {f}")
        self.footprints.append(fp)
        rec = draft.draw(self, x, y)
        rec = {"id": len(self.units) + 1, **rec}
        self.units.append(rec)
        return rec

    def paste_run(self, run: Run, left: int, top: int, ink: Ink) -> Box:
        if ink.stroke is not None and run.outer is not None:
            self.img.paste(ink.stroke, (left, top), run.outer)
        self.img.paste(ink.fill, (left, top), run.fill)
        self.mask.paste(255, (left, top), run.coverage)
        return clip(shift(run.ink, left, top), self.w, self.h)

    def gt(self, image: str, extra: dict | None = None) -> dict:
        doc: dict = {
            "image": image,
            "width": self.w,
            "height": self.h,
            "lang": self.lang,
            "layout": self.layout,
        }
        if extra:
            doc.update(extra)
        doc["units"] = self.units
        return doc


def unit_record(
    kind: str,
    line: Line,
    bubble: Box | None,
    texts: list[Box],
    block: Block,
    shape: str,
    glyph_px: int | None = None,
    lines: list[str] | None = None,
) -> dict:
    lines = lines if lines is not None else list(block.lines)
    rec = {
        "kind": kind,
        "type": line.type,
        "bubble": box_json(bubble) if bubble is not None else None,
        "text": box_json(union_all(texts)),
        "texts": [box_json(t) for t in texts],
        "orientation": block.orientation,
        "glyphPx": int(glyph_px if glyph_px is not None else block.glyph_px()),
        "original": " ".join(lines),
        "speaker": line.speaker,
        "canary": line.canary,
        "lines": lines,
        "vi": line.vi,
        "lang": line.lang,
        "fontPx": int(block.font_px),
        "shape": shape,
    }
    return rec


# --------------------------------------------------------------------------- drafts


class Draft:
    w: int = 0
    h: int = 0

    def draw(self, cv: Canvas, x: int, y: int) -> dict:  # pragma: no cover - interface
        raise NotImplementedError


def _incenter_shrink(tri: list[tuple[float, float]], d: float) -> list[tuple[float, float]] | None:
    (ax, ay), (bx, by), (cx, cy) = tri
    a = math.hypot(bx - cx, by - cy)
    b = math.hypot(ax - cx, ay - cy)
    c = math.hypot(ax - bx, ay - by)
    p = a + b + c
    if p <= 0:
        return None
    ix = (a * ax + b * bx + c * cx) / p
    iy = (a * ay + b * by + c * cy) / p
    area = abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
    r = 2 * area / p
    if r <= d + 0.5:
        return None
    k = (r - d) / r
    return [(ix + (x - ix) * k, iy + (y - iy) * k) for x, y in tri]


@dataclass
class BubbleStyle:
    shape: str = "ellipse"  # ellipse | cloud | rect
    fill: RGB = WHITE
    outline: RGB = BLACK
    outline_w: int = 4
    tail: float | None = 110.0  # degrees, 90 = straight down; None = no tail
    k: float | None = None  # ellipse slack factor (None = from the block aspect)
    pad: float | None = None


class BubbleDraft(Draft):
    def __init__(self, block: Block, line: Line, ink: Ink, style: BubbleStyle, rng: random.Random) -> None:
        self.block, self.line, self.ink, self.style = block, line, ink, style
        tx1, ty1, tx2, ty2 = block.ink()
        cx, cy = (tx1 + tx2) / 2, (ty1 + ty2) / 2
        hw, hh = (tx2 - tx1) / 2, (ty2 - ty1) / 2
        p = style.pad if style.pad is not None else max(8.0, 0.42 * block.font_px)
        ow = style.outline_w
        shapes_outer: list[tuple] = []  # ("e", cx, cy, a, b) | ("r", x1, y1, x2, y2) | ("p", pts)
        shapes_inner: list[tuple] = []
        tail_outer: list[tuple] = []
        tail_inner: list[tuple] = []
        self.ellipse: tuple[float, float, float, float] | None = None
        self.rect: Box | None = None
        if style.shape in ("ellipse", "cloud"):
            r = (hw + p) / (hh + p) if hw >= hh else (hh + p) / (hw + p)
            k = style.k if style.k is not None else max(1.26, min(1.414, 1.414 - 0.08 * (r - 1)))
            q = 1 / math.sqrt(1 - 1 / (k * k))
            if hw >= hh:
                a, b = (hw + p) * k, (hh + p) * q
            else:
                a, b = (hw + p) * q, (hh + p) * k
            self.ellipse = (cx, cy, a, b)
            shapes_inner.append(("e", cx, cy, a, b))
            shapes_outer.append(("e", cx, cy, a + ow, b + ow))
            if style.shape == "cloud":
                rs = max(7.0, min(26.0, 0.17 * min(a, b)))
                perim = math.pi * (3 * (a + b) - math.sqrt((3 * a + b) * (a + 3 * b)))
                n = max(10, int(perim / (1.45 * rs)))
                for i in range(n):
                    t = 2 * math.pi * i / n
                    px, py = cx + a * math.cos(t), cy + b * math.sin(t)
                    shapes_inner.append(("e", px, py, rs, rs))
                    shapes_outer.append(("e", px, py, rs + ow, rs + ow))
            if style.tail is not None:
                th = math.radians(style.tail)
                if style.shape == "cloud":
                    rs0 = max(6.0, min(18.0, 0.12 * min(a, b)))
                    dist = 1.0
                    for f in (0.75, 0.5, 0.32):
                        rr = rs0 * f * 1.6
                        dist += rr * 1.9 + 4
                        ex = cx + (a + rs0 + dist) * math.cos(th)
                        ey = cy + (b + rs0 + dist) * math.sin(th)
                        tail_inner.append(("e", ex, ey, rr, rr))
                        tail_outer.append(("e", ex, ey, rr + ow, rr + ow))
                else:
                    dl = math.radians(rng.uniform(9, 13))
                    skew = math.radians(rng.uniform(-14, 14))
                    length = max(14.0, min(60.0, 0.42 * b))
                    p1 = (cx + 0.8 * a * math.cos(th - dl), cy + 0.8 * b * math.sin(th - dl))
                    p2 = (cx + 0.8 * a * math.cos(th + dl), cy + 0.8 * b * math.sin(th + dl))
                    tip = (
                        cx + (a + ow + length) * math.cos(th + skew),
                        cy + (b + ow + length) * math.sin(th + skew),
                    )
                    tri = [p1, p2, tip]
                    tail_outer.append(("p", tri))
                    inner = _incenter_shrink(tri, ow) if ow > 0 else tri
                    if inner is not None:
                        tail_inner.append(("p", inner))
        elif style.shape == "rect":
            ri = (tx1 - p, ty1 - p, tx2 + p, ty2 + p)
            self.rect = (
                int(math.floor(ri[0])),
                int(math.floor(ri[1])),
                int(math.ceil(ri[2])),
                int(math.ceil(ri[3])),
            )
            shapes_inner.append(("r",) + self.rect)
            shapes_outer.append(("r",) + inflate(self.rect, ow))
        else:
            raise ValueError(style.shape)
        if ow <= 0:
            shapes_outer, tail_outer = [], []
        # footprint in block coordinates
        allb = [_shape_bbox(s) for s in (shapes_outer or shapes_inner) + (tail_outer or tail_inner)]
        fx1 = min(b[0] for b in allb) - 1
        fy1 = min(b[1] for b in allb) - 1
        fx2 = max(b[2] for b in allb) + 1
        fy2 = max(b[3] for b in allb) + 1
        self.ox, self.oy = -int(math.floor(fx1)), -int(math.floor(fy1))
        self.w = int(math.ceil(fx2)) + self.ox
        self.h = int(math.ceil(fy2)) + self.oy
        self.shapes_outer, self.shapes_inner = shapes_outer, shapes_inner
        self.tail_outer, self.tail_inner = tail_outer, tail_inner

    def draw(self, cv: Canvas, x: int, y: int) -> dict:
        st = self.style
        edge = st.outline if st.outline_w > 0 else st.fill
        tile = Image.new("RGBA", (self.w * SS, self.h * SS), edge + (0,))
        body = Image.new("L", (self.w * SS, self.h * SS), 0)
        d = ImageDraw.Draw(tile)
        db = ImageDraw.Draw(body)
        for s in self.shapes_outer + self.tail_outer:
            _draw_shape(d, s, st.outline + (255,), self.ox, self.oy)
        for s in self.shapes_inner + self.tail_inner:
            _draw_shape(d, s, st.fill + (255,), self.ox, self.oy)
        for s in self.shapes_outer or self.shapes_inner:
            _draw_shape(db, s, 255, self.ox, self.oy)
        tile = tile.reduce(SS)
        body = body.reduce(SS)
        cv.img.paste(tile.convert("RGB"), (x, y), tile.getchannel("A"))
        bb = body.getbbox() or (0, 0, 1, 1)
        bubble = clip(shift(bb, x, y), cv.w, cv.h)
        texts = []
        for run, (px, py) in zip(self.block.runs, self.block.pos, strict=True):
            left = x + self.ox + px - run.ax
            top = y + self.oy + py - run.ay
            tb = cv.paste_run(run, left, top, self.ink)
            texts.append(tb)
            self._check_inside(shift(run.ink, left, top), x, y)
        shape = st.shape if st.outline_w > 0 else st.shape + "-borderless"
        return unit_record("bubble", self.line, bubble, texts, self.block, shape)

    def _check_inside(self, tb: Box, x: int, y: int) -> None:
        if self.ellipse is not None:
            cx, cy, a, b = self.ellipse
            cx, cy = cx + self.ox + x, cy + self.oy + y
            for px, py in ((tb[0], tb[1]), (tb[2], tb[1]), (tb[0], tb[3]), (tb[2], tb[3])):
                if ((px - cx) / a) ** 2 + ((py - cy) / b) ** 2 > 1.0001:
                    raise LayoutError(f"text corner ({px},{py}) outside its bubble")
        elif self.rect is not None:
            r = shift(self.rect, self.ox + x, self.oy + y)
            if not inside(tb, r):
                raise LayoutError("text outside its caption box")


def _shape_bbox(s: tuple) -> tuple[float, float, float, float]:
    if s[0] == "e":
        _, cx, cy, a, b = s
        return (cx - a, cy - b, cx + a, cy + b)
    if s[0] == "r":
        return (s[1], s[2], s[3], s[4])
    xs = [p[0] for p in s[1]]
    ys = [p[1] for p in s[1]]
    return (min(xs), min(ys), max(xs), max(ys))


def _draw_shape(d: ImageDraw.ImageDraw, s: tuple, color, ox: int, oy: int) -> None:
    if s[0] == "e":
        _, cx, cy, a, b = s
        cx, cy = cx + ox, cy + oy
        d.ellipse(((cx - a) * SS, (cy - b) * SS, (cx + a) * SS - 1, (cy + b) * SS - 1), fill=color)
    elif s[0] == "r":
        _, x1, y1, x2, y2 = s
        d.rectangle(((x1 + ox) * SS, (y1 + oy) * SS, (x2 + ox) * SS - 1, (y2 + oy) * SS - 1), fill=color)
    else:
        d.polygon([((px + ox) * SS, (py + oy) * SS) for px, py in s[1]], fill=color)


class FreeDraft(Draft):
    """Text drawn directly on the art (no container): narration, shouts, captions without a box."""

    def __init__(self, block: Block, line: Line, ink: Ink, margin: int = 6, shape: str = "none") -> None:
        self.block, self.line, self.ink, self.shape = block, line, ink, shape
        ib = block.ink()
        self.ox, self.oy = margin - ib[0], margin - ib[1]
        self.w = ib[2] - ib[0] + 2 * margin
        self.h = ib[3] - ib[1] + 2 * margin
        self.edge_small = False

    def draw(self, cv: Canvas, x: int, y: int) -> dict:
        texts = []
        for run, (px, py) in zip(self.block.runs, self.block.pos, strict=True):
            texts.append(cv.paste_run(run, x + self.ox + px - run.ax, y + self.oy + py - run.ay, self.ink))
        rec = unit_record("free", self.line, None, texts, self.block, self.shape)
        if self.edge_small:
            rec["edgeSmall"] = True
        return rec


class RunDraft(Draft):
    """A single (optionally rotated) run: SFX, rotated shouts, watermarks."""

    def __init__(
        self,
        run: Run,
        line: Line,
        ink: Ink,
        orientation: str,
        font_px: int,
        glyph_px: int,
        margin: int = 6,
        shape: str = "none",
        edge_small: bool = False,
    ) -> None:
        self.run, self.line, self.ink = run, line, ink
        self.orientation, self.font_px, self.glyph_px = orientation, font_px, glyph_px
        self.shape, self.edge_small = shape, edge_small
        ib = run.ink
        self.ox, self.oy = margin - ib[0], margin - ib[1]
        self.w = ib[2] - ib[0] + 2 * margin
        self.h = ib[3] - ib[1] + 2 * margin

    def draw(self, cv: Canvas, x: int, y: int) -> dict:
        tb = cv.paste_run(self.run, x + self.ox, y + self.oy, self.ink)
        block = Block([self.run], [(0, 0)], self.orientation, self.font_px, 0, [self.line.text])
        rec = unit_record("free", self.line, None, [tb], block, self.shape, glyph_px=self.glyph_px)
        if self.edge_small:
            rec["edgeSmall"] = True
        return rec


class SignDraft(Draft):
    """A painted board (part of the art) carrying text: detector class text_free, LLM type 'sign'."""

    def __init__(self, block: Block, line: Line, ink: Ink, board: RGB, edge: RGB, posts: bool) -> None:
        self.block, self.line, self.ink, self.board, self.edge, self.posts = (
            block,
            line,
            ink,
            board,
            edge,
            posts,
        )
        ib = block.ink()
        p = max(10, int(0.5 * block.font_px))
        self.board_box = (ib[0] - p, ib[1] - p, ib[2] + p, ib[3] + p)
        post_h = int(0.9 * block.font_px) if posts else 0
        self.ox, self.oy = 2 - self.board_box[0], 2 - self.board_box[1]
        self.w = self.board_box[2] - self.board_box[0] + 4
        self.h = self.board_box[3] - self.board_box[1] + 4 + post_h

    def draw(self, cv: Canvas, x: int, y: int) -> dict:
        bb = shift(self.board_box, x + self.ox, y + self.oy)
        d = ImageDraw.Draw(cv.img)
        if self.posts:
            pw = max(6, (bb[2] - bb[0]) // 16)
            for px in (bb[0] + (bb[2] - bb[0]) // 4, bb[0] + 3 * (bb[2] - bb[0]) // 4):
                d.rectangle((px - pw // 2, bb[3] - 2, px + pw // 2, y + self.h - 1), fill=self.edge)
        rad = max(4, (bb[3] - bb[1]) // 8)
        d.rounded_rectangle(
            (bb[0], bb[1], bb[2] - 1, bb[3] - 1), radius=rad, fill=self.board, outline=self.edge, width=3
        )
        texts = []
        for run, (px, py) in zip(self.block.runs, self.block.pos, strict=True):
            texts.append(cv.paste_run(run, x + self.ox + px - run.ax, y + self.oy + py - run.ay, self.ink))
        return unit_record("free", self.line, None, texts, self.block, "board")


# --------------------------------------------------------------------------- factories (fit to a budget)


@dataclass
class Spec:
    """What to draw; `make(max_w, max_h)` lays it out at the largest size that fits (or returns None)."""

    line: Line
    kind: str = "bubble"  # bubble | caption | thought | free | sfx | sign
    size: int = 30
    min_size: int = 16
    weight: str = "body"
    ink: Ink = field(default_factory=Ink)
    style: BubbleStyle | None = None
    aspect: float = 2.0
    vertical: bool = False
    angle: float = 0.0
    board: RGB = (121, 85, 72)
    board_edge: RGB = (62, 39, 35)
    posts: bool = True
    exact_size: bool = False
    force_lines: int | None = None

    def score_weight(self) -> float:
        return float(max(4, len(self.line.text)))


class Maker:
    """Lays out specs with the system fonts; `make` searches size, aspect and ellipse slack until it fits."""

    def __init__(self, fonts: Fonts, rng: random.Random) -> None:
        self.fonts = fonts
        self.rng = rng
        self._checked: set[tuple[str, str]] = set()

    def check_glyphs(self, role: str, line: Line) -> None:
        key = (role, line.text)
        if key in self._checked:
            return
        missing = self.fonts.missing(role, line.text)
        if missing:
            cps = " ".join(f"U+{ord(c):04X}" for c in missing)
            raise LayoutError(f"font role {role} lacks glyphs {cps} for line {line.lang}:{line.id}")
        self._checked.add(key)

    def _tcy(self, role: str, size: int):
        def pick(text: str):
            f = self.fonts.get(role, size)
            w = f.getlength(text)
            s = size if w <= 0.95 * size else max(8, int(size * 0.95 * size / w))
            return self.fonts.get(role, s)

        return pick

    def block(
        self, spec: Spec, size: int, max_w: int, max_h: int, stroke: int = 0, aspect: float | None = None
    ) -> Block | None:
        line = spec.line
        aspect = spec.aspect if aspect is None else aspect
        role = font_role(line.lang, spec.weight)
        self.check_glyphs(role, line)
        font = self.fonts.get(role, size)
        vertical = spec.vertical and line.lang == "ja" and not needs_horizontal(line)
        if vertical:
            return layout_v(
                font,
                line.text,
                size,
                aspect,
                max_h=max_h,
                stroke=stroke,
                tcy_font=self._tcy(role, size),
                keep=line.names,
            )
        gap = 1.18 if line.lang in ("en", "es") else 1.24
        return layout_h(
            font,
            line.text,
            line.lang,
            size,
            aspect,
            max_w=max_w,
            stroke=stroke,
            line_gap=gap,
            force_lines=spec.force_lines,
            keep=line.names,
        )

    def make(self, spec: Spec, max_w: int, max_h: int) -> Draft | None:
        """Largest size (then the first aspect variant) whose footprint fits max_w x max_h."""
        size = spec.size
        # last variant forces a single line/column: the flattest/tallest layout possible
        variants = (spec.aspect, spec.aspect * 1.8, spec.aspect / 1.8, 40.0)
        ks: tuple[float | None, ...] = (None, 1.2) if spec.kind in ("bubble", "thought") else (None,)
        while size >= spec.min_size:
            for aspect in variants:
                for k in ks:
                    d = self._try(spec, size, max_w, max_h, aspect, k)
                    if d is not None and d.w <= max_w and d.h <= max_h:
                        return d
                if spec.kind == "sfx":
                    break
            if spec.exact_size:
                return None
            size = size - max(1, round(size * 0.06))
        return None

    def _try(
        self, spec: Spec, size: int, max_w: int, max_h: int, aspect: float, k: float | None
    ) -> Draft | None:
        line = spec.line
        kind = spec.kind
        if kind in ("bubble", "caption", "thought"):
            style = spec.style or BubbleStyle()
            if kind == "caption":
                style = replace(style, shape="rect", tail=None)
            elif kind == "thought":
                style = replace(style, shape="cloud")
            if k is not None:
                style = replace(style, k=k)
            # text budget: the container adds roughly 1.4-1.9x in each direction
            blk = self.block(spec, size, int(max_w / 1.45), int(max_h / 1.45), aspect=aspect)
            if blk is None:
                return None
            return BubbleDraft(blk, line, spec.ink, style, self.rng)
        if kind == "free":
            blk = self.block(spec, size, max_w - 12, max_h - 12, stroke=spec.ink.stroke_w, aspect=aspect)
            if blk is None:
                return None
            return FreeDraft(blk, line, spec.ink)
        if kind == "sign":
            blk = self.block(spec, size, max_w - 2 * size, max_h - 2 * size, aspect=aspect)
            if blk is None:
                return None
            return SignDraft(blk, line, spec.ink, spec.board, spec.board_edge, spec.posts)
        if kind == "sfx":
            role = font_role(line.lang, "sfx")
            self.check_glyphs(role, line)
            font = self.fonts.get(role, size)
            st = spec.ink.stroke_w
            if spec.vertical and line.lang == "ja":
                run = render_column(font, line.text, size, size * 1.0, st, self._tcy(role, size))
                orient = "v"
                gb = run.fill.getbbox() or run.ink
                glyph = gb[2] - gb[0]
            else:
                run = render_line(font, line.text, st)
                orient = "h"
                gb = run.fill.getbbox() or run.ink
                glyph = gb[3] - gb[1]
            if spec.angle:
                run = rotate_run(run, spec.angle)
            return RunDraft(run, line, spec.ink, orient, size, glyph)
        raise ValueError(kind)


# --------------------------------------------------------------------------- placement


def stack(
    cv: Canvas,
    mk: Maker,
    region: Box,
    specs: list[Spec],
    rng: random.Random,
    rtl: bool = False,
    gap: int = 18,
    zigzag: bool = True,
    x_jitter: float = 1.0,
) -> list[dict]:
    """Stack units top to bottom inside `region` (reading order = list order), alternating sides."""
    if not specs:
        return []
    rx1, ry1, rx2, ry2 = region
    rw, rh = rx2 - rx1, ry2 - ry1
    n = len(specs)
    avail = rh - gap * (n - 1)
    total_w = sum(s.score_weight() for s in specs)
    drafts: list[Draft] = []
    # First try every unit at its preferred size; fall back to proportional height budgets when crowded.
    first = [mk.make(s, rw, avail) for s in specs]
    if all(d is not None for d in first) and sum(d.h for d in first if d) + gap * (n - 1) <= rh:
        drafts = [d for d in first if d is not None]
    else:
        for s in specs:
            budget = max(40, int(avail * (0.35 + 0.65 * s.score_weight() / total_w) / (0.35 * n + 0.65)))
            d = mk.make(s, rw, min(budget, avail))
            if d is None:
                raise LayoutError(f"cannot fit {s.kind} {s.line.lang}:{s.line.id} into {rw}x{budget}")
            drafts.append(d)
    used = sum(d.h for d in drafts) + gap * (n - 1)
    if used > rh:
        raise LayoutError(f"stack overflow {used} > {rh} in region {region}")
    spare = rh - used
    weights = [rng.uniform(0.3, 1.0) for _ in range(n + 1)]
    sw = sum(weights)
    y = ry1 + spare * weights[0] / sw
    out = []
    for i, d in enumerate(drafts):
        slack = rw - d.w
        if n == 1 or not zigzag:
            f = rng.uniform(0.15, 0.85) if x_jitter else 0.5
        elif i % 2 == 0:
            f = rng.uniform(0.0, 0.3 * x_jitter)
        else:
            f = rng.uniform(1 - 0.3 * x_jitter, 1.0)
        if rtl:
            f = 1 - f
        x = rx1 + int(slack * f)
        out.append(cv.place(d, x, int(y)))
        y += d.h + gap + spare * weights[i + 1] / sw
    return out


def row(
    cv: Canvas,
    mk: Maker,
    region: Box,
    specs: list[Spec],
    rng: random.Random,
    rtl: bool = False,
    gap: int = 18,
) -> list[dict]:
    """Units side by side (first unit on the left, or on the right when rtl), each lower than the previous
    one, so both band order and the manga corner rule read them in list order."""
    if not specs:
        return []
    rx1, ry1, rx2, ry2 = region
    rw, rh = rx2 - rx1, ry2 - ry1
    n = len(specs)
    avail = rw - gap * (n - 1)
    first = [mk.make(s, avail, rh) for s in specs]
    if all(d is not None for d in first) and sum(d.w for d in first if d) + gap * (n - 1) <= rw:
        drafts = [d for d in first if d is not None]
    else:
        total = sum(s.score_weight() for s in specs)
        drafts = []
        for s in specs:
            budget = max(60, int(avail * (0.35 + 0.65 * s.score_weight() / total) / (0.35 * n + 0.65)))
            d = mk.make(s, min(budget, avail), rh)
            if d is None:
                raise LayoutError(f"cannot fit {s.kind} {s.line.lang}:{s.line.id} into {budget}x{rh}")
            drafts.append(d)
    used = sum(d.w for d in drafts) + gap * (n - 1)
    if used > rw:
        raise LayoutError(f"row overflow {used} > {rw} in region {region}")
    spare = rw - used
    weights = [rng.uniform(0.3, 1.0) for _ in range(n + 1)]
    sw = sum(weights)
    xs = []
    x = spare * weights[0] / sw
    for i, d in enumerate(drafts):
        xs.append(x)
        x += d.w + gap + spare * weights[i + 1] / sw
    out = []
    prev_top = None
    for i, d in enumerate(drafts):
        left = rx1 + int(xs[i]) if not rtl else rx2 - int(xs[i]) - d.w
        slack = rh - d.h
        f = (i + rng.uniform(0.0, 0.6)) / max(1, n - 1 + 0.6) if n > 1 else rng.uniform(0.1, 0.9)
        top = ry1 + int(slack * min(1.0, f))
        if prev_top is not None and top <= prev_top:
            top = min(ry1 + slack, prev_top + 8)
        prev_top = top
        out.append(cv.place(d, left, top))
    return out


def place_at(cv: Canvas, d: Draft, cx: float, cy: float, allow_outside: bool = False) -> dict:
    """Place a draft centred on (cx, cy)."""
    return cv.place(d, int(round(cx - d.w / 2)), int(round(cy - d.h / 2)), allow_outside=allow_outside)
