"""Probe images for the quality benchmarks: res-grid (glyph size vs resolution), shapes (region
mapping), marks-N (numbered marks), erase-set (erase quality), action-01 (fight lines and SFX) and the
detector canary page."""

import math
import random
import shutil
from pathlib import Path

from PIL import Image, ImageDraw

from fx_art import colorize, gradient, screentone, smooth_noise
from fx_output import Ctx
from fx_pages import (
    caption,
    dlg,
    draw_panel,
    free,
    inner,
    page_number,
    page_rows,
    reading,
    sfx,
    sign,
    strip_segments,
    thought,
)
from fx_text import Block, layout_h, render_line
from fx_units import (
    BLACK,
    WHITE,
    Canvas,
    Deck,
    FreeDraft,
    Ink,
    LayoutError,
    Maker,
    row,
    stack,
    synthetic_line,
    unit_record,
)
from fx_util import Inline, box_json, clip, hexrgb, shift

# --------------------------------------------------------------------------- res-grid

GLYPH_HEIGHTS = [8, 10, 12, 14, 16, 20, 24, 32]
SCRIPTS = [
    # (script, lang, font role, alphabet, string length)
    (
        "hangul",
        "ko",
        "ko-bold",
        "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후",
        5,
    ),
    (
        "kana-kanji",
        "ja",
        "ja",
        "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"
        "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン"
        "山川田木水火金土月日空海花鳥風雪雨石森林",
        5,
    ),
    (
        "hanzi",
        "zh",
        "zh",
        "的一是不了人我在有他这中大来上个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小心多天而能好"
        "都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进"
        "把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东",
        5,
    ),
    ("latin", "en", "en", "ABCDEFGHKLMNPRSTUVWXYZ", 6),
]


def _font_for_height(mk: Maker, role: str, text: str, target: int) -> int:
    """Font size whose ink height for `text` is closest to `target` px."""
    best = None
    for s in range(4, 90):
        f = mk.fonts.get(role, s)
        b = f.getbbox(text, anchor="ls")
        h = b[3] - b[1]
        d = abs(h - target)
        if best is None or d < best[0]:
            best = (d, s)
        if h > target + 3:
            break
    assert best is not None
    return best[1]


def _label(cv: Canvas, mk: Maker, x: int, y: int, text: str, size: int = 18) -> None:
    f = mk.fonts.get("ui", size)
    w = int(f.getlength(text)) + 12
    d = ImageDraw.Draw(cv.img)
    d.rounded_rectangle(
        (x, y, x + w, y + size + 10), radius=5, fill=(236, 236, 236), outline=(120, 120, 120), width=1
    )
    d.text((x + 6, y + 5 + size), text, font=f, fill=(40, 40, 40), anchor="ls")


def res_grid(ctx: Ctx) -> None:
    name = "res-grid"
    rng = ctx.rng(name)
    strings = []
    for _script, _lang, _role, alpha, n in SCRIPTS:
        row_s = []
        for _ in GLYPH_HEIGHTS:
            row_s.append("".join(rng.choice(alpha) for _ in range(n)))
        strings.append(row_s)
    main = _res_canvas(ctx, rng, strings, 2048, 768, 192)
    e1 = ctx.out.emit(main, name, extra=_res_extra())
    tall = _res_canvas(ctx, rng, strings, 2048, 1152, 288)
    e2 = ctx.out.emit(tall, f"{name}-2048x1152", extra=_res_extra())
    small = _downscale(main, 2)
    e3 = ctx.out.emit(small, f"{name}-1024x384", extra=_res_extra(scaleFrom=e1["image"]))
    ctx.out.fixture(name, "probe", "ko", "paged-ltr", [e1, e2, e3])


def _res_extra(**more) -> dict:
    out = {"langs": ["ko", "ja", "zh", "en"], "glyphHeights": GLYPH_HEIGHTS}
    out.update(more)
    return out


def _res_canvas(ctx: Ctx, rng: random.Random, strings, w: int, h: int, pitch: int) -> Canvas:
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(w, h, lang="ko", layout="paged-ltr")
    cw = w // len(GLYPH_HEIGHTS)
    top = (h - pitch * len(SCRIPTS)) // 2
    d = ImageDraw.Draw(cv.img)
    for r, (script, lang, role, _alpha, _n) in enumerate(SCRIPTS):
        for c, target in enumerate(GLYPH_HEIGHTS):
            x0, y0 = c * cw, top + r * pitch
            d.rectangle((x0, y0, x0 + cw - 1, y0 + pitch - 1), outline=(214, 214, 214), width=1)
            n = r * len(GLYPH_HEIGHTS) + c + 1
            _label(cv, mk, x0 + 8, y0 + 8, f"#{n}")
            text = strings[r][c]
            size = _font_for_height(mk, role, text, target)
            run = render_line(mk.fonts.get(role, size), text)
            fb = run.fill.getbbox() or run.ink
            line = synthetic_line(text, "sign", lang)
            block = Block([run], [(0, 0)], "h", size, 0, [text])
            fd = FreeDraft(block, line, Ink(BLACK), margin=2)
            cx, cy = x0 + cw / 2, y0 + pitch / 2 + 14
            rec = cv.place(fd, int(round(cx - fd.w / 2)), int(round(cy - fd.h / 2)))
            rec["glyphPx"] = int(fb[3] - fb[1])
            rec["script"] = script
            rec["glyphTarget"] = target
    return cv


def _downscale(cv: Canvas, k: int) -> Canvas:
    out = Canvas(cv.w // k, cv.h // k, lang=cv.lang, layout=cv.layout)
    out.img = cv.img.resize((out.w, out.h), Image.Resampling.LANCZOS)
    out.mask = cv.mask.resize((out.w, out.h), Image.Resampling.BOX)
    for u in cv.units:
        v = dict(u)
        t = u["text"]
        region = (t["x1"] // k - 2, t["y1"] // k - 2, -(-t["x2"] // k) + 2, -(-t["y2"] // k) + 2)
        region = clip(region, out.w, out.h)
        bb = out.mask.crop(region).getbbox()
        assert bb is not None
        tb = shift(bb, region[0], region[1])
        v["text"] = box_json(tb)
        v["texts"] = [box_json(tb)]
        v["glyphPx"] = int(round(u["glyphPx"] / k))
        v["fontPx"] = int(round(u["fontPx"] / k))
        out.units.append(v)
    return out


# --------------------------------------------------------------------------- shapes

SHAPE_WORDS = ["ZUPRI", "KOLVA", "MIRTE", "BANOX", "TEVRA", "QUIDA"]
SHAPES = ["circle", "square", "triangle", "star", "hexagon", "diamond"]
COLORS = [
    ("red", "#d32f2f"),
    ("blue", "#1976d2"),
    ("green", "#388e3c"),
    ("yellow", "#fbc02d"),
    ("purple", "#7b1fa2"),
    ("orange", "#f57c00"),
]


def _shape_points(shape: str, cx: float, cy: float, r: float) -> list[tuple[float, float]] | None:
    if shape == "triangle":
        return [
            (cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in (-90, 30, 150)
        ]
    if shape == "star":
        pts = []
        for i in range(10):
            rr = r if i % 2 == 0 else r * 0.48
            a = math.radians(-90 + 36 * i)
            pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
        return pts
    if shape == "hexagon":
        return [
            (cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)))
            for a in range(0, 360, 60)
        ]
    if shape == "diamond":
        return [(cx, cy - r), (cx + r * 0.8, cy), (cx, cy + r), (cx - r * 0.8, cy)]
    return None


def shapes_probe(ctx: Ctx) -> None:
    name = "shapes"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(1200, 800, lang="en", layout="paged-ltr")
    cv.img.paste(gradient(1200, 800, (248, 246, 240), (226, 230, 236), "d1"), (0, 0))
    shapes = list(SHAPES)
    colors = list(COLORS)
    words = list(SHAPE_WORDS)
    rng.shuffle(shapes)
    rng.shuffle(colors)
    rng.shuffle(words)
    ss = 3
    for i in range(6):
        x0, y0 = (i % 3) * 400, (i // 3) * 400
        cx, cy, r = x0 + 210, y0 + 215, 150.0
        shape, (cname, chex) = shapes[i], colors[i]
        fill = hexrgb(chex)
        tile = Image.new("RGBA", (400 * ss, 400 * ss), fill + (0,))
        d = ImageDraw.Draw(tile)
        lx, ly = (cx - x0) * ss, (cy - y0) * ss
        pts = _shape_points(shape, lx, ly, r * ss)
        if shape == "circle":
            d.ellipse(
                (lx - r * ss, ly - r * ss, lx + r * ss, ly + r * ss),
                fill=fill + (255,),
                outline=(20, 20, 20, 255),
                width=3 * ss,
            )
        elif shape == "square":
            q = r * 0.85 * ss
            d.rectangle(
                (lx - q, ly - q, lx + q, ly + q), fill=fill + (255,), outline=(20, 20, 20, 255), width=3 * ss
            )
        else:
            assert pts is not None
            d.polygon(pts, fill=fill + (255,), outline=(20, 20, 20, 255), width=3 * ss)
        tile = tile.reduce(ss)
        bb = tile.getchannel("A").getbbox()
        assert bb is not None
        cv.img.paste(tile.convert("RGB"), (x0, y0), tile.getchannel("A"))
        bubble = shift(bb, x0, y0)
        # number badge, outside the shape
        bd = ImageDraw.Draw(cv.img)
        bd.ellipse((x0 + 14, y0 + 14, x0 + 62, y0 + 62), fill=(25, 25, 25))
        bd.text((x0 + 38, y0 + 38), str(i + 1), font=mk.fonts.get("ui", 28), fill=WHITE, anchor="mm")
        # the word inside the shape
        word = words[i]
        f = mk.fonts.get("ui", 30)
        run = render_line(f, word)
        ink = Ink(BLACK if cname == "yellow" else WHITE)
        ty = cy + (r * 0.18 if shape == "triangle" else 0)
        left = int(round(cx - (run.ink[0] + run.ink[2]) / 2))
        top = int(round(ty - (run.ink[1] + run.ink[3]) / 2))
        tb = cv.paste_run(run, left, top, ink)
        line = synthetic_line(word, "sign", "en")
        block = Block([run], [(0, 0)], "h", 30, 0, [word])
        rec = unit_record("bubble", line, bubble, [tb], block, shape)
        rec["color"] = cname
        rec["colorHex"] = chex
        rec["number"] = i + 1
        cv.footprints.append(bubble)
        cv.units.append({"id": i + 1, **rec})
    e = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "probe", "en", "paged-ltr", [e])


# --------------------------------------------------------------------------- marks-N

MARK_GRID = {5: (2, 3), 10: (2, 5), 16: (4, 4), 20: (4, 5), 30: (5, 6)}
MARK_SIZE = {5: 30, 10: 28, 16: 24, 20: 22, 30: 20}
BADGE_COLORS = ["#e53935", "#1e88e5", "#43a047", "#8e24aa", "#fb8c00", "#00897b", "#6d4c41", "#3949ab"]


def marks(ctx: Ctx, n: int) -> None:
    name = f"marks-{n}"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cols, rows_ = MARK_GRID[n]
    cv = Canvas(1200, 1800, lang="ko", layout="paged-ltr")
    rows = page_rows(
        1200,
        [((1800 - 80 - 16 * (rows_ - 1)) // rows_, [1 / cols] * cols)] * rows_,
        margin=40,
        gutter=16,
        top=40,
    )
    panels = reading(rows, False)[:n]
    kinds = ["gradient", "tone", "shapes", "radial", "stripes", "noise"]
    for i, p in enumerate(reading(rows, False)):
        draw_panel(cv, rng, p, kinds[i % len(kinds)], dark=False, border=3)
    deck = Deck(ctx.corpus.of_type("ko", "dialogue", "thought"), rng)
    size = MARK_SIZE[n]
    for p in panels:
        ln = deck.draw()
        spec = (thought if ln.type == "thought" else dlg)(ln, rng, size, min_size=13)
        # room for the numbered badge above the bubble in the marked variant
        stack(cv, mk, (p[0] + 12, p[1] + 36, p[2] - 12, p[3] - 12), [spec], rng)
    e = ctx.out.emit(cv, name)
    # marked variant: numbered badges just outside each bubble's top-left corner
    marked = cv.img.copy()
    d = ImageDraw.Draw(marked)
    f = mk.fonts.get("ui", 20)
    marks_out = []
    for u, p in zip(cv.units, panels, strict=True):
        b = u["bubble"]
        label = str(u["id"])
        bw_ = int(f.getlength(label)) + 14
        x1 = max(p[0] + 4, b["x1"])
        y1 = b["y1"] - 31
        if y1 < p[1] + 3 or x1 + bw_ > p[2] - 3:
            raise LayoutError(f"{name}: no room for badge {u['id']}")
        box = (x1, y1, x1 + bw_, y1 + 28)
        col = hexrgb(BADGE_COLORS[(u["id"] - 1) % len(BADGE_COLORS)])
        d.rounded_rectangle(
            (box[0], box[1], box[2] - 1, box[3] - 1), radius=6, fill=col, outline=WHITE, width=2
        )
        d.text(((box[0] + box[2]) / 2, (box[1] + box[3]) / 2 + 1), label, font=f, fill=WHITE, anchor="mm")
        marks_out.append(Inline(id=u["id"], x1=box[0], y1=box[1], x2=box[2], y2=box[3]))
    marked_rel = ctx.out.png(f"{name}.marked.png", marked)
    ctx.out.json(f"{name}.marks.json", {"image": marked_rel, "source": e["image"], "marks": marks_out})
    ctx.out.fixture(name, "probe", "ko", "paged-ltr", [e], marked=marked_rel, marks=f"{name}.marks.json")


def marks_all(ctx: Ctx) -> None:
    for n in (5, 10, 16, 20, 30):
        marks(ctx, n)


# --------------------------------------------------------------------------- erase-set

ERASE_BG = ["white", "color", "gradient", "tone", "noise"]
ERASE_INK = ["black", "white", "outline", "color", "thin"]
ERASE_LINES = [
    "d03", "d04", "d06", "d08", "d13", "d15", "d17", "d20", "d21", "d23", "d33", "d36", "d37",
    "d41", "d43", "d44", "d45", "d47", "d51", "d52", "d54", "d56", "d59", "d63", "t02",
]  # fmt: skip


def _erase_bg(kind: str, dark: bool, w: int, h: int, rng: random.Random) -> Image.Image:
    if kind == "white":
        return Image.new("RGB", (w, h), (24, 24, 28) if dark else (255, 255, 255))
    if kind == "color":
        return Image.new("RGB", (w, h), hexrgb("#283593") if dark else hexrgb("#ffe08a"))
    if kind == "gradient":
        return (
            gradient(w, h, hexrgb("#1a237e"), hexrgb("#6a1b9a"), "v")
            if dark
            else gradient(w, h, hexrgb("#fff3e0"), hexrgb("#ffcc80"), "v")
        )
    if kind == "tone":
        return (
            screentone(w, h, 6, 1.5, (210, 210, 210), (40, 40, 44))
            if dark
            else screentone(w, h, 6, 1.5, (60, 60, 60), (252, 252, 250))
        )
    g = smooth_noise(w, h, rng, cell=32)
    return colorize(g, (20, 24, 40), (90, 70, 110)) if dark else colorize(g, (170, 190, 205), (250, 236, 210))


def erase_set(ctx: Ctx) -> None:
    rng = ctx.rng("erase-set")
    mk = Maker(ctx.fonts, rng)
    W_, H_ = 640, 400
    cx, cy, a, b, ow = 320.0, 200.0, 290.0, 175.0, 4
    images = []
    k = 0
    for bg in ERASE_BG:
        for ink_name in ERASE_INK:
            dark = ink_name == "white"
            cv = Canvas(W_, H_, bg=(222, 222, 218), lang="ko", layout="paged-ltr")
            art = _erase_bg(bg, dark, W_, H_, rng)
            ss = 3
            m_in = Image.new("L", (W_ * ss, H_ * ss), 0)
            m_out = Image.new("L", (W_ * ss, H_ * ss), 0)
            ImageDraw.Draw(m_out).ellipse(
                ((cx - a - ow) * ss, (cy - b - ow) * ss, (cx + a + ow) * ss, (cy + b + ow) * ss), fill=255
            )
            ImageDraw.Draw(m_in).ellipse(
                ((cx - a) * ss, (cy - b) * ss, (cx + a) * ss, (cy + b) * ss), fill=255
            )
            m_in, m_out = m_in.reduce(ss), m_out.reduce(ss)
            cv.img.paste(BLACK, (0, 0), m_out)
            cv.img.paste(art, (0, 0), m_in)
            clean = cv.img.copy()
            ln = ctx.corpus.get("ko", ERASE_LINES[k % len(ERASE_LINES)])
            k += 1
            if ink_name == "black":
                ink, role, size, stroke = Ink(BLACK), "ko-bold", 32, 0
            elif ink_name == "white":
                ink, role, size, stroke = Ink((250, 250, 250)), "ko-bold", 32, 0
            elif ink_name == "outline":
                ink, role, size, stroke = Ink(WHITE, BLACK, 2), "ko-bold", 32, 2
            elif ink_name == "color":
                ink, role, size, stroke = (
                    Ink(hexrgb("#c62828") if bg != "color" else hexrgb("#1565c0")),
                    "ko-bold",
                    32,
                    0,
                )
            else:
                ink, role, size, stroke = Ink((34, 34, 34)), "ko-thin", 24, 0
            mk.check_glyphs(role, ln)
            blk = layout_h(mk.fonts.get(role, size), ln.text, "ko", size, 2.4, max_w=380, stroke=stroke)
            if blk is None:
                raise LayoutError(f"erase-set: cannot lay out {ln.id}")
            ib = blk.ink()
            ox = int(round(cx - (ib[0] + ib[2]) / 2))
            oy = int(round(cy - (ib[1] + ib[3]) / 2))
            texts = []
            for run, (px, py) in zip(blk.runs, blk.pos, strict=True):
                tb = cv.paste_run(run, ox + px - run.ax, oy + py - run.ay, ink)
                texts.append(tb)
                for qx, qy in ((tb[0], tb[1]), (tb[2], tb[1]), (tb[0], tb[3]), (tb[2], tb[3])):
                    if ((qx - cx) / a) ** 2 + ((qy - cy) / b) ** 2 > 1:
                        raise LayoutError("erase-set: text outside the bubble")
            bb = m_out.getbbox()
            assert bb is not None
            rec = unit_record("bubble", ln, bb, texts, blk, "ellipse")
            cv.units.append({"id": 1, **rec})
            stem = f"erase-set/{bg}-{ink_name}"
            clean_rel = ctx.out.png(f"{stem}.clean.png", clean)
            jpg_rel = ctx.out.jpeg(f"{stem}.q75.jpg", cv.img, quality=75, subsampling=2)
            e = ctx.out.emit(
                cv,
                stem,
                extra={
                    "background": bg,
                    "ink": ink_name,
                    "clean": clean_rel,
                    "jpeg": jpg_rel,
                    "outlineWidth": ow,
                },
            )
            e["background"], e["ink"] = bg, ink_name
            images.append(e)
    ctx.out.fixture("erase-set", "probe", "ko", "paged-ltr", images)


# --------------------------------------------------------------------------- action-01


def action_01(ctx: Ctx) -> None:
    name = "action-01"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(800, 2560, lang="ko", layout="strip")
    segs = [(40, 820, "speed-light"), (880, 1660, "speed-dark"), (1720, 2520, "speed-light")]
    strip_segments(cv, rng, segs, framed={0, 2})
    a = lambda i: ctx.corpus.get("ko", i)  # noqa: E731
    stack(cv, mk, (60, 70, 740, 790), [dlg(a("a01"), rng, 30), sfx(a("a09"), rng, 110)], rng)
    stack(
        cv,
        mk,
        (40, 900, 760, 1640),
        [dlg(a("a02"), rng, 30), sfx(a("a10"), rng, 100), dlg(a("a03"), rng, 30)],
        rng,
    )
    stack(cv, mk, (60, 1750, 740, 2490), [dlg(a("a06"), rng, 30), sfx(a("a11"), rng, 110)], rng)
    e = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "probe", "ko", "strip", [e])


# --------------------------------------------------------------------------- canary-01


def canary_01(ctx: Ctx, assets_dir: Path | None) -> None:
    name = "canary-01"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(800, 1200, lang="ko", layout="paged-ltr")
    rows = page_rows(800, [(420, [1.0]), (380, [0.55, 0.45]), (300, [1.0])], margin=30, gutter=16, top=30)
    p1, p2, p3, p4 = reading(rows, False)
    draw_panel(cv, rng, p1, "radial", dark=False)
    draw_panel(cv, rng, p2, "tone")
    cv.paste_art(p3, gradient(p3[2] - p3[0], p3[3] - p3[1], hexrgb("#0d1b2a"), hexrgb("#1b4965"), "v"))
    cv.frame(p3, 4)
    draw_panel(cv, rng, p4, "shapes", dark=False)
    c = ctx.corpus
    row(cv, mk, inner(p1), [dlg(c.get("ko", "d01"), rng, 26), thought(c.get("ko", "t08"), rng, 26)], rng)
    stack(cv, mk, inner(p2), [dlg(c.get("ja", "d20"), rng, 26)], rng)
    stack(cv, mk, inner(p3), [caption(c.get("en", "n03"), 22), free(c.get("ko", "n02"), 26)], rng)
    row(
        cv,
        mk,
        inner(p4),
        [
            sfx(c.get("ko", "x01"), rng, 80),
            sign(c.get("zh", "s13"), rng, 24),
            dlg(c.get("ko", "d26"), rng, 24),
        ],
        rng,
    )
    page_number(cv, mk, "1")
    e = ctx.out.emit(cv, name, mask=False, extra={"langs": ["ko", "ja", "zh", "en"]})
    ctx.out.fixture(name, "probe", "ko", "paged-ltr", [e])
    if assets_dir is not None:
        assets_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ctx.out.path(e["image"]), assets_dir / "canary-01.png")
        shutil.copyfile(ctx.out.path(e["gt"]), assets_dir / "canary-01.gt.json")
