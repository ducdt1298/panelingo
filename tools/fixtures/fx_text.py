"""Text layout and glyph rendering.

Pillow here has no libraqm, so vertical Japanese is laid out one glyph at a time: punctuation uses the Unicode
vertical presentation forms (U+FE10..FE19, U+FE30..FE44, mapped by Yu Gothic), long-vowel marks and dashes are
rotated, small kana are nudged to the upper right, and short runs of ASCII letters/digits are set
tate-chu-yoko (side by side inside one cell). Every line or column is rendered into its own coverage mask, so
the ground truth boxes are exact ink boxes, not font metrics.
"""

import math
from dataclasses import dataclass, field

from PIL import Image, ImageDraw, ImageFont

from fx_util import Box, shift, union_all

Font = ImageFont.FreeTypeFont

# Vertical presentation forms (logical char -> glyph drawn in a vertical column).
VERT = {
    "、": "︑",
    "。": "︒",
    "，": "︐",
    "…": "︙",
    "‥": "︰",
    "「": "﹁",
    "」": "﹂",
    "『": "﹃",
    "』": "﹄",
    "（": "︵",
    "）": "︶",
    "！": "︕",
    "？": "︖",
    "：": "︓",
    "；": "︔",
    "【": "︻",
    "】": "︼",
    "—": "︱",
}
ROTATE = set("ー〜～―─-")
SMALL_KANA = set("ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ")
# Kinsoku: characters that may not start / end a line or column.
NO_START = set(
    "、。，．・：；？！ー〜～…‥」』）】〉》〕｝ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ!?,.:;)]}%"
)
NO_END = set("「『（【〈《〔｛([{")
CJK_LANGS = ("ja", "zh")


def is_ascii_alnum(ch: str) -> bool:
    return ch.isascii() and (ch.isalnum() or ch in "-'.:")


@dataclass
class Run:
    """One rendered line (horizontal) or column (vertical) in a local tile.

    `fill` is the glyph coverage mask; `outer` covers fill + stroke (None without stroke). (ax, ay) is the
    anchor inside the tile: baseline-left for lines, centre-top for columns, tile centre for rotated runs.
    """

    text: str
    fill: Image.Image
    outer: Image.Image | None
    ax: int
    ay: int
    ink: Box

    @property
    def coverage(self) -> Image.Image:
        return self.outer if self.outer is not None else self.fill


@dataclass
class Block:
    """Runs positioned in block coordinates (anchor positions); orientation 'h' (lines) or 'v' (columns)."""

    runs: list[Run]
    pos: list[tuple[int, int]]
    orientation: str
    font_px: int
    stroke: int = 0
    lines: list[str] = field(default_factory=list)

    def run_boxes(self) -> list[Box]:
        return [shift(r.ink, px - r.ax, py - r.ay) for r, (px, py) in zip(self.runs, self.pos, strict=True)]

    def ink(self) -> Box:
        return union_all(self.run_boxes())

    def glyph_px(self) -> int:
        """Median cross-axis extent of the glyph fill (no stroke) per line (h) or column (v).

        This is what a row/column ink profile measures, i.e. what src/shared/core/glyph.ts estimates.
        """
        ext = []
        for r in self.runs:
            b = r.fill.getbbox() or r.ink
            ext.append(b[3] - b[1] if self.orientation == "h" else b[2] - b[0])
        ext.sort()
        return int(ext[len(ext) // 2])


# --------------------------------------------------------------------------- tokenizing and wrapping


def _is_katakana(ch: str) -> bool:
    """Katakana block U+30A0..U+30FF (incl. the long-vowel mark), except the middle dot."""
    return "゠" <= ch <= "ヿ" and ch != "・"


def tokens_for(text: str, lang: str, keep: tuple[str, ...] = ()) -> tuple[list[str], str]:
    """Break opportunities: words for ko/en (joined by spaces); characters for ja/zh with kinsoku, never
    splitting ASCII runs, Japanese katakana words, or the names in `keep`."""
    if lang not in CJK_LANGS:
        return text.split(), " "
    span = [-1] * len(text)
    sid = 0
    for word in keep:
        start = 0
        while word and (i := text.find(word, start)) >= 0:
            for j in range(i, i + len(word)):
                span[j] = sid
            sid += 1
            start = i + len(word)
    i = 0
    while i < len(text):
        if span[i] < 0 and (is_ascii_alnum(text[i]) or (lang == "ja" and _is_katakana(text[i]))):
            kata = _is_katakana(text[i])
            j = i
            while (
                j < len(text) and span[j] < 0 and (_is_katakana(text[j]) if kata else is_ascii_alnum(text[j]))
            ):
                j += 1
            for k in range(i, j):
                span[k] = sid
            sid += 1
            i = j
        else:
            i += 1
    toks: list[str] = []
    i = 0
    while i < len(text):
        j = i + 1
        if span[i] >= 0:
            while j < len(text) and span[j] == span[i]:
                j += 1
        tok = text[i:j]
        i = j
        if toks and (tok[0] in NO_START or toks[-1][-1] in NO_END or tok.isspace()):
            toks[-1] += tok
        else:
            toks.append(tok)
    return toks, ""


def wrap(tokens: list[str], sep: str, fits) -> list[str]:
    lines: list[str] = []
    cur = ""
    for tok in tokens:
        cand = tok if not cur else cur + sep + tok
        if not cur or fits(cand):
            cur = cand
        else:
            lines.append(cur)
            cur = tok
    if cur:
        lines.append(cur)
    return [ln.strip() for ln in lines]


def balanced_lines(tokens: list[str], sep: str, width_of, n: int) -> list[str]:
    """Smallest width (binary search) at which greedy wrapping gives at most n lines."""
    lo = max(int(math.ceil(width_of(t))) for t in tokens)
    hi = max(lo, int(math.ceil(width_of(sep.join(tokens)))))
    while lo < hi:
        mid = (lo + hi) // 2
        if len(wrap(tokens, sep, lambda s, m=mid: width_of(s) <= m)) <= n:
            hi = mid
        else:
            lo = mid + 1
    return wrap(tokens, sep, lambda s: width_of(s) <= lo)


# --------------------------------------------------------------------------- rendering


def render_line(font: Font, text: str, stroke: int = 0) -> Run:
    left, top, right, bottom = font.getbbox(text, anchor="ls", stroke_width=stroke)
    pad = 2 + stroke
    w = right - left + 2 * pad
    h = bottom - top + 2 * pad
    ax, ay = pad - left, pad - top
    fill = Image.new("L", (w, h), 0)
    ImageDraw.Draw(fill).text((ax, ay), text, font=font, fill=255, anchor="ls")
    outer = None
    if stroke:
        outer = Image.new("L", (w, h), 0)
        ImageDraw.Draw(outer).text(
            (ax, ay), text, font=font, fill=255, anchor="ls", stroke_width=stroke, stroke_fill=255
        )
    cov = outer if outer is not None else fill
    ink = cov.getbbox() or (ax, ay - 1, ax + 1, ay)
    return Run(text, fill, outer, ax, ay, ink)


def rotate_run(run: Run, angle: float) -> Run:
    """Rotate counter-clockwise by `angle` degrees about the tile centre; the anchor becomes the centre."""
    fill = run.fill.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    outer = run.outer.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True) if run.outer else None
    cov = outer if outer is not None else fill
    ink = cov.getbbox() or (0, 0, 1, 1)
    return Run(run.text, fill, outer, fill.width // 2, fill.height // 2, ink)


def em_center_dy(font: Font) -> float:
    """Vertical offset from the baseline to the centre of an ideograph's ink (negative = above baseline)."""
    _, top, _, bottom = font.getbbox("国", anchor="ls")
    return (top + bottom) / 2.0


TCY_MAX = 3


def ascii_runs(text: str) -> list[str]:
    runs: list[str] = []
    i = 0
    while i < len(text):
        if is_ascii_alnum(text[i]):
            j = i
            while j < len(text) and is_ascii_alnum(text[j]):
                j += 1
            runs.append(text[i:j])
            i = j
        else:
            i += 1
    return runs


def column_cells(text: str) -> list[str]:
    """Split a vertical column into cells: one char each; ASCII runs of up to TCY_MAX chars share one cell
    (tate-chu-yoko). Longer runs never reach here: such lines are laid out horizontally."""
    cells: list[str] = []
    i = 0
    while i < len(text):
        if is_ascii_alnum(text[i]):
            j = i
            while j < len(text) and is_ascii_alnum(text[j]):
                j += 1
            if j - i <= TCY_MAX:
                cells.append(text[i:j])
            else:
                cells.extend(text[i:j])
            i = j
        else:
            cells.append(text[i])
            i += 1
    return cells


def _draw_glyph_tile(font: Font, ch: str, size: int, stroke: int, emc: float, outer: bool) -> Image.Image:
    side = 2 * size + 4 * stroke + 4
    tile = Image.new("L", (side, side), 0)
    adv = font.getlength(ch)
    x = side / 2 - adv / 2
    y = side / 2 - emc
    kw = {"stroke_width": stroke, "stroke_fill": 255} if outer and stroke else {}
    ImageDraw.Draw(tile).text((round(x), round(y)), ch, font=font, fill=255, anchor="ls", **kw)
    return tile


def render_column(font: Font, text: str, size: int, adv: float, stroke: int = 0, tcy_font=None) -> Run:
    """Render a vertical column; anchor = (centre x, top of the first cell)."""
    cells = column_cells(text)
    emc = em_center_dy(font)
    pad = 4 + stroke
    w = int(size * 1.6) + 2 * pad
    h = int(math.ceil(len(cells) * adv)) + int(size * 0.4) + 2 * pad
    cx = w // 2
    top = pad + int(size * 0.2)
    layers = [(False, Image.new("L", (w, h), 0))]
    if stroke:
        layers.append((True, Image.new("L", (w, h), 0)))
    for j, cell in enumerate(cells):
        cy = top + (j + 0.5) * adv
        for is_outer, img in layers:
            if len(cell) > 1 or is_ascii_alnum(cell):
                # tate-chu-yoko: the run sits side by side, scaled to fit one cell width
                f2 = tcy_font(cell) if tcy_font else font
                run = render_line(f2, cell, stroke if is_outer else 0)
                cov = run.coverage
                ix = (run.ink[0] + run.ink[2]) / 2
                iy = (run.ink[1] + run.ink[3]) / 2
                img.paste(255, (round(cx - ix), round(cy - iy)), cov)
                continue
            ch = VERT.get(cell, cell)
            tile = _draw_glyph_tile(font, ch, size, stroke, emc, is_outer)
            if cell in ROTATE:
                tile = tile.rotate(-90, resample=Image.Resampling.BICUBIC)
            dx, dy = 0.0, 0.0
            if cell in SMALL_KANA:
                dx, dy = 0.1 * size, -0.12 * size
            img.paste(255, (round(cx + dx - tile.width / 2), round(cy + dy - tile.height / 2)), tile)
    fill = layers[0][1]
    outer = layers[1][1] if stroke else None
    cov = outer if outer is not None else fill
    ink = cov.getbbox() or (cx, top, cx + 1, top + 1)
    return Run(text, fill, outer, cx, top, ink)


# --------------------------------------------------------------------------- blocks


def layout_h(
    font: Font,
    text: str,
    lang: str,
    size: int,
    aspect: float,
    max_w: int | None = None,
    stroke: int = 0,
    max_lines: int = 6,
    line_gap: float = 1.22,
    align: str = "center",
    force_lines: int | None = None,
    keep: tuple[str, ...] = (),
) -> Block | None:
    """Horizontal block whose ink aspect (w/h) is closest to `aspect`; None if nothing fits max_w."""
    tokens, sep = tokens_for(text, lang, keep)
    width_of = font.getlength
    best: tuple[float, list[str]] | None = None
    lh = size * line_gap
    candidates = [force_lines] if force_lines else range(1, min(max_lines, len(tokens)) + 1)
    for n in candidates:
        lines = balanced_lines(tokens, sep, width_of, n)
        wmax = max(width_of(ln) for ln in lines)
        if max_w is not None and wmax + 2 * stroke > max_w:
            continue
        hh = (len(lines) - 1) * lh + size
        score = abs(math.log((wmax / hh) / aspect))
        if best is None or score < best[0] - 1e-9:
            best = (score, lines)
    if best is None:
        return None
    lines = best[1]
    runs = [render_line(font, ln, stroke) for ln in lines]
    wmax = max(width_of(ln) for ln in lines)
    pos = []
    for i, ln in enumerate(lines):
        adv = width_of(ln)
        x = (wmax - adv) / 2 if align == "center" else 0
        pos.append((int(round(x)), int(round(size + i * lh))))
    return Block(runs, pos, "h", size, stroke, lines)


def layout_v(
    font: Font,
    text: str,
    size: int,
    aspect: float,
    max_h: int | None = None,
    stroke: int = 0,
    max_cols: int = 6,
    pitch: float = 1.32,
    adv: float = 1.04,
    tcy_font=None,
    keep: tuple[str, ...] = (),
) -> Block | None:
    """Vertical block (columns right to left) whose ink aspect (h/w) is closest to `aspect`."""
    tokens, _ = tokens_for(text, "ja", keep)
    cells_of = lambda s: len(column_cells(s))  # noqa: E731
    best: tuple[float, list[str]] | None = None
    a = size * adv
    for n in range(1, min(max_cols, len(tokens)) + 1):
        cols = balanced_lines(tokens, "", cells_of, n)
        ncells = max(cells_of(c) for c in cols)
        hh = ncells * a
        if max_h is not None and hh + 2 * stroke > max_h:
            continue
        ww = (len(cols) - 1) * size * pitch + size
        score = abs(math.log((hh / ww) / aspect))
        if best is None or score < best[0] - 1e-9:
            best = (score, cols)
    if best is None:
        return None
    cols = best[1]
    runs = [render_column(font, c, size, a, stroke, tcy_font) for c in cols]
    n = len(cols)
    pos = []
    for i in range(n):
        # column 0 is the rightmost one
        cx = (n - 1 - i) * size * pitch + size / 2
        pos.append((int(round(cx)), 0))
    return Block(runs, pos, "v", size, stroke, cols)
