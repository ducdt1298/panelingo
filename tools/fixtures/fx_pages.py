"""Page and strip fixtures: language pages, names, colour, gradient, dense, edge, KO strips, slices,
seams, the Spanish strip."""

import random

from PIL import ImageDraw

from fx_art import colorize, gradient, make_art, smooth_noise
from fx_output import Ctx
from fx_text import render_line, rotate_run
from fx_units import (
    BLACK,
    WHITE,
    BubbleDraft,
    BubbleStyle,
    Canvas,
    Deck,
    Ink,
    LayoutError,
    Line,
    Maker,
    RunDraft,
    Spec,
    font_role,
    place_at,
    row,
    stack,
    synthetic_line,
)
from fx_util import Box, Inline, hexrgb

LANG_SIZE = {"ko": 30, "ja": 30, "zh": 30, "en": 26, "es": 26}
CAPTION_FILL = (255, 248, 225)


# --------------------------------------------------------------------------- layout helpers


def page_rows(
    w: int, rows: list[tuple[int, list[float]]], margin: int = 50, gutter: int = 24, top: int = 50
) -> list[list[Box]]:
    out = []
    y = top
    for height, fracs in rows:
        x = margin
        avail = w - 2 * margin - gutter * (len(fracs) - 1)
        boxes = []
        for i, f in enumerate(fracs):
            pw = round(avail * f) if i < len(fracs) - 1 else (w - margin - x)
            boxes.append((x, y, x + pw, y + height))
            x += pw + gutter
        out.append(boxes)
        y += height + gutter
    return out


def reading(rows: list[list[Box]], rtl: bool) -> list[Box]:
    out: list[Box] = []
    for r in rows:
        out.extend(reversed(r) if rtl else r)
    return out


def inner(b: Box, d: int = 16) -> Box:
    return (b[0] + d, b[1] + d, b[2] - d, b[3] - d)


def draw_panel(
    cv: Canvas, rng: random.Random, box: Box, kind: str, dark: bool | None = None, border: int = 4
) -> None:
    art = make_art(kind, box[2] - box[0], box[3] - box[1], rng, dark)
    cv.paste_art(box, art)
    cv.frame(box, border)


def tail_angle(rng: random.Random) -> float:
    return rng.uniform(55, 80) if rng.random() < 0.5 else rng.uniform(100, 125)


# --------------------------------------------------------------------------- unit specs


def dlg(line: Line, rng: random.Random, size: int | None = None, **kw) -> Spec:
    vertical = bool(kw.pop("vertical", True)) and line.lang == "ja"
    style = kw.pop("style", None) or BubbleStyle(outline_w=kw.pop("outline_w", 4), tail=tail_angle(rng))
    return Spec(
        line,
        kind="bubble",
        size=size or LANG_SIZE[line.lang],
        vertical=vertical,
        style=style,
        aspect=1.8 if vertical else kw.pop("aspect", 2.2),
        **kw,
    )


def thought(line: Line, rng: random.Random, size: int | None = None, **kw) -> Spec:
    vertical = bool(kw.pop("vertical", True)) and line.lang == "ja"
    style = kw.pop("style", None) or BubbleStyle(shape="cloud", outline_w=3, tail=tail_angle(rng))
    return Spec(
        line,
        kind="thought",
        size=size or LANG_SIZE[line.lang],
        vertical=vertical,
        style=style,
        aspect=1.7,
        **kw,
    )


def caption(line: Line, size: int | None = None, fill=CAPTION_FILL, ink: Ink | None = None, **kw) -> Spec:
    vertical = bool(kw.pop("vertical", True)) and line.lang == "ja"
    return Spec(
        line,
        kind="caption",
        size=size or (LANG_SIZE[line.lang] - 2),
        weight="light",
        vertical=vertical,
        style=BubbleStyle(shape="rect", fill=fill, outline_w=3, tail=None),
        ink=ink or Ink(BLACK),
        aspect=1.6 if vertical else 3.0,
        **kw,
    )


def sfx(line: Line, rng: random.Random, size: int = 100, **kw) -> Spec:
    inks = [Ink((255, 214, 0), BLACK, 5), Ink((229, 57, 53), WHITE, 5), Ink(WHITE, BLACK, 5)]
    return Spec(
        line,
        kind="sfx",
        size=size,
        min_size=kw.pop("min_size", 40),
        vertical=line.lang == "ja",
        angle=kw.pop("angle", rng.uniform(-12, 12)),
        ink=kw.pop("ink", rng.choice(inks)),
        **kw,
    )


def sign(line: Line, rng: random.Random, size: int = 28, **kw) -> Spec:
    boards = [((121, 85, 72), (62, 39, 35)), ((21, 101, 192), (13, 71, 161)), ((46, 125, 50), (27, 94, 32))]
    board, edge = rng.choice(boards)
    return Spec(line, kind="sign", size=size, ink=Ink(WHITE), board=board, board_edge=edge, aspect=4.0, **kw)


def free(line: Line, size: int | None = None, ink: Ink | None = None, **kw) -> Spec:
    return Spec(
        line,
        kind="free",
        size=size or LANG_SIZE[line.lang],
        ink=ink or Ink(WHITE, BLACK, 3),
        aspect=kw.pop("aspect", 3.0),
        **kw,
    )


def edge_text(
    cv: Canvas,
    mk: Maker,
    text: str,
    cx: float,
    cy: float,
    size: int = 20,
    color=(96, 96, 96),
    angle: float = 0,
) -> dict:
    line = synthetic_line(text, "ignore", cv.lang)
    font = mk.fonts.get("ui-regular", size)
    run = render_line(font, text, 0)
    fb = run.fill.getbbox() or run.ink
    glyph = fb[3] - fb[1]
    orient = "h"
    if angle:
        run = rotate_run(run, angle)
        if abs(abs(angle) - 90) < 1:
            orient = "v"
    d = RunDraft(run, line, Ink(color), orient, size, glyph, margin=2, edge_small=True)
    return place_at(cv, d, cx, cy)


def page_number(cv: Canvas, mk: Maker, text: str) -> dict:
    return edge_text(cv, mk, text, cv.w / 2, cv.h - 22, size=20)


# --------------------------------------------------------------------------- language pages


def lang_page(ctx: Ctx, name: str, lang: str) -> None:
    rtl = lang == "ja"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(1200, 1800, lang=lang, layout="paged-rtl" if rtl else "paged-ltr")
    rows = page_rows(1200, [(520, [1.0]), (560, [0.55, 0.45]), (560, [0.42, 0.58])])
    panels = reading(rows, rtl)
    for p, kind in zip(panels, ["radial", "gradient", "shapes", "blocks", "tone"], strict=True):
        draw_panel(cv, rng, p, kind, dark=False if kind != "tone" else None)
    g = lambda i: ctx.corpus.get(lang, i)  # noqa: E731
    plan = [
        ("row", [caption(g("n03")), dlg(g("d01"), rng)]),
        ("stack", [dlg(g("d02"), rng)]),
        ("stack", [thought(g("t01"), rng)]),
        ("row" if rtl else "stack", [sign(g("s01"), rng, vertical=False), sfx(g("x01"), rng)]),
        ("row" if rtl else "stack", [dlg(g("d09"), rng), dlg(g("d14"), rng)]),
    ]
    for p, (mode, specs) in zip(panels, plan, strict=True):
        (row if mode == "row" else stack)(cv, mk, inner(p), specs, rng, rtl=rtl)
    page_number(cv, mk, "12")
    e = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "page", lang, cv.layout, [e])


def lang_pages(ctx: Ctx) -> None:
    # Spanish comes last: every page has its own random stream, so adding it changed none of the others.
    for lang in ("ko", "ja", "zh", "en", "es"):
        lang_page(ctx, f"{lang}-p01", lang)


# --------------------------------------------------------------------------- names


def names_ko(ctx: Ctx) -> None:
    name = "names-ko"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(800, 2560, lang="ko", layout="strip")
    g = lambda i: ctx.corpus.get("ko", i)  # noqa: E731
    segs = [(40, 820, "radial"), (900, 1660, "shapes"), (1740, 2520, "blocks")]
    plan = [["k01", "k02"], ["k03", "k04"], ["k05", "k06"]]
    for (y0, y1, kind), ids in zip(segs, plan, strict=True):
        draw_panel(cv, rng, (30, y0, 770, y1), kind, dark=False, border=3)
        stack(cv, mk, (50, y0 + 20, 750, y1 - 20), [dlg(g(i), rng, 28, outline_w=3) for i in ids], rng)
    e = ctx.out.emit(cv, name, extra={"cast": ctx.corpus.cast["ko"]})
    ctx.out.fixture(name, "page", "ko", cv.layout, [e])


def names_paged(ctx: Ctx, name: str, lang: str, ids: list[str]) -> None:
    rtl = lang == "ja"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(1200, 1800, lang=lang, layout="paged-rtl" if rtl else "paged-ltr")
    rows = page_rows(1200, [(540, [1.0]), (560, [0.5, 0.5]), (540, [1.0])])
    panels = reading(rows, rtl)
    for p, kind in zip(panels, ["gradient", "shapes", "radial", "stripes"], strict=True):
        draw_panel(cv, rng, p, kind, dark=False)
    g = lambda i: ctx.corpus.get(lang, i)  # noqa: E731
    groups = [ids[0:2], ids[2:3], ids[3:4], ids[4:6]]
    for p, grp in zip(panels, groups, strict=True):
        specs = [dlg(g(i), rng) for i in grp]
        (row if (len(specs) > 1 and (rtl or p[2] - p[0] > 800)) else stack)(
            cv, mk, inner(p), specs, rng, rtl=rtl
        )
    page_number(cv, mk, "3")
    e = ctx.out.emit(cv, name, extra={"cast": ctx.corpus.cast[lang]})
    ctx.out.fixture(name, "page", lang, cv.layout, [e])


def names_pages(ctx: Ctx) -> None:
    names_ko(ctx)
    names_paged(ctx, "names-ja", "ja", ["j01", "j02", "j03", "j04", "j05", "j06"])
    names_paged(ctx, "names-zh", "zh", ["z01", "z02", "z03", "z04", "z05", "z06"])


# --------------------------------------------------------------------------- colour / gradient


def color_01(ctx: Ctx) -> None:
    name = "color-01"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(1200, 1800, lang="ko", layout="paged-ltr")
    rows = page_rows(1200, [(540, [0.5, 0.5]), (560, [1.0]), (560, [0.58, 0.42])])
    panels = reading(rows, False)
    for p, kind in zip(panels, ["stripes", "gradient", "noise", "shapes", "radial"], strict=True):
        draw_panel(cv, rng, p, kind)
    g = lambda i: ctx.corpus.get("ko", i)  # noqa: E731

    def colored(i: str, fill: str, ink: str, outline: str = "#111111", shape: str = "bubble") -> Spec:
        st = BubbleStyle(
            shape="cloud" if shape == "thought" else "ellipse",
            fill=hexrgb(fill),
            outline=hexrgb(outline),
            outline_w=4 if shape != "thought" else 3,
            tail=tail_angle(rng),
        )
        return Spec(g(i), kind=shape, size=30, style=st, ink=Ink(hexrgb(ink)), aspect=2.2)

    plan = [
        ("stack", [colored("d22", "#fff176", "#3e2723")]),
        ("stack", [colored("d23", "#f8bbd0", "#4a148c", "#880e4f")]),
        (
            "row",
            [
                caption(g("n04"), fill=hexrgb("#212121"), ink=Ink(WHITE)),
                colored("d26", "#1a237e", "#ffffff", "#000000"),
                colored("d27", "#b3e5fc", "#0d47a1", "#01579b"),
            ],
        ),
        (
            "stack",
            [
                colored("d28", "#1b5e20", "#ffeb3b", "#000000"),
                sfx(g("x06"), rng, 90, ink=Ink((229, 57, 53), WHITE, 5)),
            ],
        ),
        ("stack", [colored("t05", "#e1bee7", "#311b92", "#4a148c", shape="thought")]),
    ]
    for p, (mode, specs) in zip(panels, plan, strict=True):
        (row if mode == "row" else stack)(cv, mk, inner(p), specs, rng)
    page_number(cv, mk, "8")
    e = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "page", "ko", cv.layout, [e])


def gradient_01(ctx: Ctx) -> None:
    name = "gradient-01"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(1200, 1800, lang="ko", layout="paged-ltr")
    rows = page_rows(1200, [(600, [1.0]), (520, [0.5, 0.5]), (520, [1.0])])
    panels = reading(rows, False)
    arts = [
        gradient(1100, 600, hexrgb("#0b132b"), hexrgb("#5bc0be"), "v"),
        gradient(538, 520, hexrgb("#fff3e0"), hexrgb("#ffb74d"), "d1"),
        gradient(538, 520, hexrgb("#4a148c"), hexrgb("#f48fb1"), "d2"),
        None,
    ]
    noise = smooth_noise(1100, 520, rng, cell=48)
    arts[3] = colorize(noise, hexrgb("#1b263b"), hexrgb("#778da9"))
    for p, art in zip(panels, arts, strict=True):
        assert art is not None
        cv.paste_art(p, art)
        cv.frame(p, 4)
    g = lambda i: ctx.corpus.get("ko", i)  # noqa: E731
    plan = [
        ("row", [free(g("n06"), 32), free(g("n07"), 30)]),
        ("stack", [free(g("d29"), 30, ink=Ink(BLACK, WHITE, 4))]),
        ("stack", [dlg(g("d30"), rng, outline_w=0)]),
        ("row", [free(g("n09"), 30), sfx(g("x04"), rng, 96, ink=Ink(WHITE, (13, 27, 42), 5))]),
    ]
    for p, (mode, specs) in zip(panels, plan, strict=True):
        (row if mode == "row" else stack)(cv, mk, inner(p, 24), specs, rng)
    e = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "page", "ko", cv.layout, [e])


# --------------------------------------------------------------------------- dense pages


def dense_page(
    ctx: Ctx, name: str, layout: list[tuple[int, list[float]]], per_panel: list[int], size: int
) -> None:
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(1200, 1800, lang="ko", layout="paged-ltr")
    rows = page_rows(1200, layout, margin=40, gutter=18, top=40)
    panels = reading(rows, False)
    kinds = ["gradient", "shapes", "tone", "radial", "stripes", "blocks", "noise"]
    for i, p in enumerate(panels):
        draw_panel(cv, rng, p, kinds[i % len(kinds)], dark=False, border=3)
    dlgs = Deck(ctx.corpus.of_type("ko", "dialogue"), rng)
    thoughts = Deck(ctx.corpus.of_type("ko", "thought"), rng)
    caps = Deck(ctx.corpus.of_type("ko", "narration"), rng)
    for p, n in zip(panels, per_panel, strict=True):
        specs = []
        for j in range(n):
            r = rng.random()
            if r < 0.12 and j == 0:
                specs.append(caption(caps.draw(), size - 2, min_size=14))
            elif r < 0.25:
                specs.append(thought(thoughts.draw(), rng, size, min_size=14))
            else:
                specs.append(dlg(dlgs.draw(), rng, size, outline_w=3, min_size=14))
        wide = p[2] - p[0] > 700
        (row if wide and n > 1 else stack)(cv, mk, inner(p, 10), specs, rng, gap=10)
    e = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "page", "ko", cv.layout, [e])


def dense_pages(ctx: Ctx) -> None:
    dense_page(
        ctx,
        "dense-01",
        [(400, [0.5, 0.5]), (400, [1.0]), (400, [0.5, 0.5]), (420, [1.0])],
        [2, 2, 2, 1, 1, 2],
        24,
    )
    dense_page(ctx, "dense-20", [(326, [0.5, 0.5])] * 5, [2] * 10, 22)
    dense_page(ctx, "dense-30", [(326, [1 / 3, 1 / 3, 1 / 3])] * 5, [2] * 15, 20)


# --------------------------------------------------------------------------- edge-01


def edge_01(ctx: Ctx) -> None:
    name = "edge-01"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(1200, 1800, lang="ko", layout="paged-ltr")
    g = lambda i: ctx.corpus.get("ko", i)  # noqa: E731
    # Row 1 bleeds off the right page edge.
    p1 = (50, 50, 1200, 600)
    cv.paste_art(p1, make_art("radial", p1[2] - p1[0], p1[3] - p1[1], rng, dark=False))
    ImageDraw.Draw(cv.img).line([(50, 50), (1200, 50)], fill=BLACK, width=4)
    ImageDraw.Draw(cv.img).line([(50, 50), (50, 600)], fill=BLACK, width=4)
    ImageDraw.Draw(cv.img).line([(50, 598), (1200, 598)], fill=BLACK, width=4)
    rows = page_rows(1200, [(560, [0.5, 0.5]), (520, [1.0])], top=624)
    p2, p3 = rows[0]
    p4 = rows[1][0]
    draw_panel(cv, rng, p2, "tone")
    draw_panel(cv, rng, p3, "speed", dark=False)
    draw_panel(cv, rng, p4, "blocks", dark=False)
    # (1) ordinary bubble, (2) bubble cut by the right page edge (its text stays on the page).
    stack(cv, mk, (70, 70, 640, 580), [dlg(g("d31"), rng)], rng)
    d = mk.make(dlg(g("d32"), rng, style=BubbleStyle(outline_w=4, tail=150)), 520, 420)
    assert isinstance(d, BubbleDraft)
    tx2 = d.block.ink()[2] + d.ox
    x = 1188 - tx2  # text ends 12 px before the page edge; the ellipse continues past it
    cv.place(d, x, 300 - d.h // 2, allow_outside=True)
    # (3) 12 px glyphs: a whisper bubble at an exact small size.
    stack(cv, mk, inner(p2, 30), [dlg(g("d38"), rng, 13, outline_w=2, exact_size=True, min_size=13)], rng)
    # (4) a shout written on the art, rotated 15 degrees.
    shout = g("d57")
    run = render_line(mk.fonts.get(font_role("ko", "body"), 34), shout.text, 4)
    fb = run.fill.getbbox() or run.ink
    rot = rotate_run(run, 15)
    rd = RunDraft(rot, shout, Ink(WHITE, BLACK, 4), "h", 34, fb[3] - fb[1])
    place_at(cv, rd, (p3[0] + p3[2]) / 2, (p3[1] + p3[3]) / 2)
    # (5) row 3: ordinary dialogue and a thought.
    row(cv, mk, inner(p4), [dlg(g("d33"), rng), thought(g("t06"), rng)], rng)
    # Edge marks, ordered last: page number, then a watermark-like line along the right edge.
    page_number(cv, mk, "37")
    edge_text(cv, mk, "panelworks.example", 1186, 1500, size=16, color=(150, 150, 150), angle=90)
    e = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "page", "ko", cv.layout, [e])


# --------------------------------------------------------------------------- KO strips


def strip_segments(
    cv: Canvas, rng: random.Random, segs: list[tuple[int, int, str | None]], framed: set[int]
) -> None:
    for i, (y0, y1, kind) in enumerate(segs):
        if kind is None:
            continue
        dark = None
        k = kind
        if kind.endswith("-dark"):
            k, dark = kind[: -len("-dark")], True
        elif kind.endswith("-light"):
            k, dark = kind[: -len("-light")], False
        if i in framed:
            box = (24, y0, cv.w - 24, y1)
            draw_panel(cv, rng, box, k, dark, border=3)
        else:
            cv.paste_art((0, y0, cv.w, y1), make_art(k, cv.w, y1 - y0, rng, dark))


def ko_strip01(ctx: Ctx) -> None:
    name = "ko-strip01"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(800, 7680, lang="ko", layout="strip")
    segs: list[tuple[int, int, str | None]] = [
        (40, 1000, "radial-light"),
        (1000, 1250, None),
        (1300, 2300, "shapes-light"),
        (2300, 2520, None),
        (2600, 3500, "gradient-dark"),
        (3500, 3800, None),
        (3880, 4950, "blocks-light"),
        (4950, 5080, None),
        (5160, 6200, "tone"),
        (6200, 6400, None),
        (6440, 7400, "noise-light"),
        (7400, 7640, None),
    ]
    strip_segments(cv, rng, segs, framed={2, 6, 10})
    g = lambda i: ctx.corpus.get("ko", i)  # noqa: E731
    S = 28

    def b(i: str, **kw) -> Spec:
        return dlg(g(i), rng, S, outline_w=kw.pop("outline_w", rng.choice([0, 2, 3])), **kw)

    plan: list[list[Spec]] = [
        [caption(g("n01"), 26), b("d03")],
        [b("d04", outline_w=3)],
        [b("d05"), thought(g("t02"), rng, S), sfx(g("x10"), rng, 90)],
        [],
        [free(g("n02"), 30), b("d06")],
        [b("d07", outline_w=3)],
        [b("d08"), sign(g("s05"), rng, 30)],
        [],
        [thought(g("t03"), rng, S), b("d10", outline_w=3), sfx(g("x05"), rng, 90)],
        [],
        [b("d11"), caption(g("n12"), 26)],
        [b("d12", outline_w=3)],
    ]
    for (y0, y1, _), specs in zip(segs, plan, strict=True):
        if specs:
            stack(cv, mk, (50, y0 + 24, 750, y1 - 24), specs, rng)
    full = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "strip", "ko", "strip", [full])
    # 3-slice WebP copy with consistent per-slice ground truth.
    slices = []
    for k, y0 in enumerate((0, 2560, 5120)):
        y1 = y0 + 2560
        sub = Canvas(800, 2560, lang="ko", layout="strip")
        sub.img = cv.img.crop((0, y0, 800, y1))
        sub.mask = cv.mask.crop((0, y0, 800, y1))
        for u in cv.units:
            ub = _unit_extent(u)
            if ub[1] >= y0 and ub[3] <= y1:
                sub.units.append(_shift_unit(u, -y0, len(sub.units) + 1))
            elif ub[1] < y1 and ub[3] > y0:
                raise LayoutError(f"{name}: unit {u['id']} crosses slice boundary at {y0}/{y1}")
        stem = f"{name}-s{k + 1}"
        e = ctx.out.emit(
            sub,
            stem,
            fmt="webp",
            mask=False,
            extra={"parent": Inline(image=full["image"], y0=y0)},
            quality=85,
        )
        slices.append(e)
    ctx.out.fixture(f"{name}-webp", "slices", "ko", "strip", slices, parent=full["image"])


def _unit_extent(u: dict) -> Box:
    boxes = [u["text"]] + ([u["bubble"]] if u["bubble"] else [])
    return (
        min(b["x1"] for b in boxes),
        min(b["y1"] for b in boxes),
        max(b["x2"] for b in boxes),
        max(b["y2"] for b in boxes),
    )


def _sb(b: dict, dy: int) -> Inline:
    return Inline(x1=b["x1"], y1=b["y1"] + dy, x2=b["x2"], y2=b["y2"] + dy)


def _shift_unit(u: dict, dy: int, new_id: int) -> dict:
    out = dict(u)
    out["id"] = new_id
    out["bubble"] = _sb(u["bubble"], dy) if u["bubble"] else None
    out["text"] = _sb(u["text"], dy)
    out["texts"] = [_sb(t, dy) for t in u["texts"]]
    return out


def _center_on_cut(d: BubbleDraft, cut: int, mode: str) -> int:
    """Top y so that the cut passes between the two lines ('gap') or through the middle of line 0 ('line')."""
    boxes = d.block.run_boxes()
    if mode == "gap":
        y = (boxes[0][3] + boxes[1][1]) / 2
    else:
        y = (boxes[0][1] + boxes[0][3]) / 2
    return int(round(cut - (y + d.oy)))


def ko_strip02_and_seam(ctx: Ctx) -> None:
    name = "ko-strip02"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    W, H = 720, 9000
    cv = Canvas(W, H, lang="ko", layout="strip")
    g = lambda i: ctx.corpus.get("ko", i)  # noqa: E731
    segs: list[tuple[int, int, str | None]] = [
        (40, 900, "gradient-light"),
        (960, 2000, None),
        (2050, 2800, "shapes-light"),
        (3200, 4200, "radial-light"),
        (4300, 5600, None),
        (6350, 7400, "blocks-light"),
        (7500, 8900, "noise-light"),
    ]
    strip_segments(cv, rng, segs, framed={0, 2, 5})
    # gradient panels carrying text_free narration
    cv.paste_art((0, 960, W, 2000), gradient(W, 1040, hexrgb("#0d1b2a"), hexrgb("#415a77"), "v"))
    cv.paste_art((0, 4300, W, 5600), gradient(W, 1300, hexrgb("#3c096c"), hexrgb("#ff9e00"), "v"))
    S = 26
    stack(cv, mk, (40, 80, 680, 860), [caption(g("n05"), 24)], rng)
    stack(cv, mk, (40, 1000, 680, 1960), [free(g("n06"), 28), free(g("n07"), 28)], rng)
    stack(cv, mk, (50, 2080, 670, 2770), [dlg(g("d16"), rng, S, outline_w=3), sfx(g("x07"), rng, 84)], rng)
    # bubble straddling y=3000; the cut passes between its two lines
    d17 = mk.make(dlg(g("d17"), rng, S, outline_w=3, force_lines=2), 600, 320)
    assert isinstance(d17, BubbleDraft) and len(d17.block.runs) == 2
    cv.place(d17, 120, _center_on_cut(d17, 3000, "gap"))
    stack(
        cv,
        mk,
        (50, 3230, 670, 4170),
        [
            dlg(g("d18"), rng, S, outline_w=0),
            dlg(g("d13"), rng, 15, outline_w=2, exact_size=True, min_size=15),
        ],
        rng,
    )
    stack(
        cv, mk, (40, 4340, 680, 5560), [free(g("n08"), 28), free(g("n09"), 28), sfx(g("x12"), rng, 96)], rng
    )
    # bubble straddling y=6000; the cut runs through its (single) text line
    d19 = mk.make(dlg(g("d19"), rng, S, outline_w=3, force_lines=1), 660, 300)
    assert isinstance(d19, BubbleDraft) and len(d19.block.runs) == 1
    cv.place(d19, 360 - d19.w // 2, _center_on_cut(d19, 6000, "line"))
    stack(cv, mk, (50, 6390, 670, 7360), [dlg(g("d20"), rng, S)], rng)
    stack(cv, mk, (50, 7540, 670, 8860), [dlg(g("d21"), rng, S, outline_w=3)], rng)
    if len(cv.units) != 14:
        raise LayoutError(f"{name}: expected 14 units, got {len(cv.units)}")
    full = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "strip", "ko", "strip", [full])
    seam_split(ctx, cv, full["image"], "ko-seam01", [3000, 6000])


def seam_split(ctx: Ctx, cv: Canvas, source: str, name: str, cuts: list[int]) -> None:
    edges = [0] + cuts + [cv.h]
    parts = []
    per_image_units: list[list[dict]] = []
    seams = []
    for k in range(len(edges) - 1):
        y0, y1 = edges[k], edges[k + 1]
        sub = Canvas(cv.w, y1 - y0, lang=cv.lang, layout="strip")
        sub.img = cv.img.crop((0, y0, cv.w, y1))
        sub.mask = cv.mask.crop((0, y0, cv.w, y1))
        for u in cv.units:
            ub = _unit_extent(u)
            if ub[3] <= y0 or ub[1] >= y1:
                continue
            if ub[1] >= y0 and ub[3] <= y1:
                sub.units.append(_shift_unit(u, -y0, len(sub.units) + 1))
                continue
            part = _clip_unit(u, y0, y1, len(sub.units) + 1)
            cut = y0 if ub[1] < y0 else y1
            seam_id = f"seam-{cuts.index(cut) + 1}"
            part["seam"] = Inline(seamId=seam_id, part="lower" if cut == y0 else "upper")
            sub.units.append(part)
        parts.append(sub)
        per_image_units.append(sub.units)
    images = []
    for k, sub in enumerate(parts):
        stem = f"{name}/{name}-{k + 1}"
        images.append(ctx.out.emit(sub, stem, extra={"parent": Inline(image=source, y0=edges[k])}))
    for i, cut in enumerate(cuts):
        sid = f"seam-{i + 1}"
        up = next(u for u in per_image_units[i] if u.get("seam", {}).get("seamId") == sid)
        lo = next(u for u in per_image_units[i + 1] if u.get("seam", {}).get("seamId") == sid)
        src = next(u for u in cv.units if _unit_extent(u)[1] < cut < _unit_extent(u)[3])
        through = any(t["y1"] < cut < t["y2"] for t in src["texts"])
        seams.append(
            {
                "seamId": sid,
                "cutY": cut,
                "sourceUnit": src["id"],
                "cutThroughText": through,
                "upper": Inline(image=images[i]["image"], id=up["id"]),
                "lower": Inline(image=images[i + 1]["image"], id=lo["id"]),
            }
        )
    layout = {
        "name": name,
        "source": source,
        "width": cv.w,
        "height": cv.h,
        "cuts": cuts,
        "images": [
            Inline(image=e["image"], gt=e["gt"], y0=edges[k], y1=edges[k + 1]) for k, e in enumerate(images)
        ],
        "variants": [
            {"name": f"gap-{gap}", "gapPx": gap, "tops": [edges[k] + gap * k for k in range(len(images))]}
            for gap in (0, 4)
        ],
        "seams": seams,
    }
    ctx.out.json(f"{name}.layout.json", layout)
    ctx.out.fixture(name, "seam", cv.lang, "strip", images, seamLayout=f"{name}.layout.json", source=source)


def _clip_unit(u: dict, y0: int, y1: int, new_id: int) -> dict:
    out = dict(u)
    out["id"] = new_id

    def c(b: dict) -> dict | None:
        ya, yb = max(b["y1"], y0), min(b["y2"], y1)
        if yb <= ya:
            return None
        return Inline(x1=b["x1"], y1=ya - y0, x2=b["x2"], y2=yb - y0)

    out["bubble"] = c(u["bubble"]) if u["bubble"] else None
    kept = [(c(t), ln) for t, ln in zip(u["texts"], u["lines"], strict=True)]
    kept = [(t, ln) for t, ln in kept if t is not None]
    if not kept:
        raise LayoutError(f"seam part of unit {u['id']} has no visible text in [{y0}, {y1})")
    out["texts"] = [t for t, _ in kept]
    out["lines"] = [ln for _, ln in kept]
    out["original"] = " ".join(out["lines"])
    xs = out["texts"]
    out["text"] = Inline(
        x1=min(t["x1"] for t in xs),
        y1=min(t["y1"] for t in xs),
        x2=max(t["x2"] for t in xs),
        y2=max(t["y2"] for t in xs),
    )
    return out


# --------------------------------------------------------------------------- Spanish strip


def es_strip01(ctx: Ctx) -> None:
    """A short Spanish webtoon strip (Spanish scanlation source): 4 art panels, captions, a canary, ¿ ¡ ñ and
    accents; no unit crosses y = 2560."""
    name = "es-strip01"
    rng = ctx.rng(name)
    mk = Maker(ctx.fonts, rng)
    cv = Canvas(800, 5120, lang="es", layout="strip")
    segs: list[tuple[int, int, str | None]] = [
        (40, 1000, "radial-light"),
        (1000, 1250, None),
        (1300, 2300, "shapes-light"),
        (2300, 2520, None),
        (2600, 3500, "gradient-dark"),
        (3500, 3800, None),
        (3880, 4950, "blocks-light"),
        (4950, 5080, None),
    ]
    strip_segments(cv, rng, segs, framed={0, 2, 6})
    g = lambda i: ctx.corpus.get("es", i)  # noqa: E731
    S = 28

    def b(i: str, **kw) -> Spec:
        return dlg(g(i), rng, S, outline_w=kw.pop("outline_w", rng.choice([0, 2, 3])), **kw)

    plan: list[list[Spec]] = [
        [caption(g("n01"), 26), b("d03")],
        [b("d04", outline_w=3)],
        [b("d25"), thought(g("t07"), rng, S), sfx(g("x10"), rng, 90)],
        [],
        [free(g("n02"), 30), b("d06")],
        [b("d07", outline_w=3)],
        [b("d10"), sign(g("s05"), rng, 30)],
        [],
    ]
    for (y0, y1, _), specs in zip(segs, plan, strict=True):
        if specs:
            stack(cv, mk, (50, y0 + 24, 750, y1 - 24), specs, rng)
    for u in cv.units:
        ub = _unit_extent(u)
        if ub[1] < 2560 < ub[3]:
            raise LayoutError(f"{name}: unit {u['id']} crosses y = 2560")
    e = ctx.out.emit(cv, name)
    ctx.out.fixture(name, "strip", "es", "strip", [e])


def strips(ctx: Ctx) -> None:
    ko_strip01(ctx)
    ko_strip02_and_seam(ctx)
    es_strip01(ctx)
