"""Seeded webtoon chapters (800x2000 JPEG slices) and a 3-chapter series with recurring original names."""

import random

from fx_art import ART_KINDS, make_art
from fx_output import Ctx
from fx_pages import caption, dlg, draw_panel, free, sfx, sign, thought
from fx_units import Canvas, Deck, LayoutError, Line, Maker, Spec, stack
from fx_util import Box

W, H = 800, 2000
EDGE = 40  # no unit closer than this to the top/bottom of a slice
ART = [k for k in ART_KINDS if k != "speed"]


def compose(rng: random.Random) -> list[tuple[int, int, str | None, bool]]:
    """Vertical segments (y0, y1, art kind or None for a gutter, framed)."""
    pattern = rng.choices(["one", "two", "three"], weights=[0.3, 0.45, 0.25])[0]
    m1 = rng.choice([0, 0, 60, 140])
    m2 = rng.choice([0, 0, 80, 160])
    segs: list[tuple[int, int, str | None, bool]] = []

    def art() -> str:
        return rng.choice(ART)

    if pattern == "one":
        bounds = [(m1, H - m2)]
    elif pattern == "two":
        y1 = rng.randint(820, 1120)
        gap = rng.randint(140, 340)
        bounds = [(m1, y1), (y1 + gap, H - m2)]
    else:
        g1, g2 = rng.randint(100, 220), rng.randint(100, 220)
        usable = H - m1 - m2 - g1 - g2
        a = int(usable * rng.uniform(0.28, 0.4))
        b = int(usable * rng.uniform(0.28, 0.4))
        bounds = [(m1, m1 + a), (m1 + a + g1, m1 + a + g1 + b), (m1 + a + g1 + b + g2, H - m2)]
    y = 0
    for y0, y1 in bounds:
        if y0 > y:
            segs.append((y, y0, None, False))
        segs.append((y0, y1, art(), rng.random() < 0.5))
        y = y1
    if y < H:
        segs.append((y, H, None, False))
    return segs


def draw_segments(cv: Canvas, rng: random.Random, segs, gutter_rgb) -> None:
    cv.img.paste(gutter_rgb, (0, 0, W, H))
    for y0, y1, kind, framed in segs:
        if kind is None:
            continue
        dark = True if rng.random() < 0.2 else (False if rng.random() < 0.6 else None)
        if framed:
            draw_panel(
                cv,
                rng,
                (24, y0 + (12 if y0 > 0 else 0), W - 24, y1 - (12 if y1 < H else 0)),
                kind,
                dark,
                border=3,
            )
        else:
            cv.paste_art((0, y0, W, y1), make_art(kind, W, y1 - y0, rng, dark))


def region_of(seg) -> Box:
    y0, y1, _, framed = seg
    inset = 44 if framed else 30
    return (inset + 6, max(EDGE, y0 + 28), W - inset - 6, min(H - EDGE, y1 - 28))


class Decks:
    def __init__(self, ctx: Ctx, rng: random.Random) -> None:
        c = ctx.corpus
        self.dialogue = Deck(c.of_type("ko", "dialogue"), rng)
        self.thought = Deck(c.of_type("ko", "thought"), rng)
        self.narration = Deck(c.of_type("ko", "narration"), rng)
        self.sfx = Deck(c.of_type("ko", "sfx"), rng)
        self.sign = Deck(c.of_type("ko", "sign"), rng)


def unit_spec(rng: random.Random, decks: Decks, on_art: bool, used: list[str]) -> Spec:
    r = rng.random()
    avoid = tuple(used)
    if on_art:
        kinds = [
            (0.56, "dialogue"),
            (0.66, "thought"),
            (0.76, "caption"),
            (0.86, "free"),
            (0.94, "sfx"),
            (1.0, "sign"),
        ]
    else:
        kinds = [(0.75, "dialogue"), (0.87, "thought"), (1.0, "caption")]
    kind = next(k for t, k in kinds if r < t)
    if kind == "dialogue":
        ln = decks.dialogue.draw(avoid)
        spec = dlg(
            ln, rng, 28, outline_w=rng.choice([0, 2, 3, 4]) if on_art else rng.choice([2, 3, 4]), min_size=20
        )
    elif kind == "thought":
        ln = decks.thought.draw(avoid)
        spec = thought(ln, rng, 28, min_size=20)
    elif kind == "caption":
        ln = decks.narration.draw(avoid)
        spec = caption(ln, 26, min_size=20)
    elif kind == "free":
        ln = decks.narration.draw(avoid)
        spec = free(ln, 30, min_size=22)
    elif kind == "sfx":
        ln = decks.sfx.draw(avoid)
        spec = sfx(ln, rng, rng.randint(72, 110))
    else:
        ln = decks.sign.draw(avoid)
        spec = sign(ln, rng, 28)
    used.append(ln.id)
    return spec


def chapter_image(
    ctx: Ctx, rng: random.Random, decks: Decks, n_units: int, lines: list[Line] | None = None
) -> Canvas:
    """One 800x2000 slice with n_units units (or the given lines, in order)."""
    for _attempt in range(12):
        cv = Canvas(W, H, lang="ko", layout="strip")
        mk = Maker(ctx.fonts, rng)
        segs = compose(rng)
        gutter = (16, 16, 18) if rng.random() < 0.15 else (255, 255, 255)
        draw_segments(cv, rng, segs, gutter)
        regions = [(region_of(s), s[2] is not None) for s in segs]
        regions = [(r, art) for r, art in regions if r[3] - r[1] >= 150]
        cap = [max(0, (r[3] - r[1]) // 200) for r, _ in regions]
        n = n_units if lines is None else len(lines)
        if sum(cap) < n:
            continue
        # spread units over regions in order, proportionally to capacity
        counts = [0] * len(regions)
        order = list(range(len(regions)))
        for _ in range(n):
            free_slots = [i for i in order if counts[i] < cap[i]]
            i = max(free_slots, key=lambda j: (cap[j] - counts[j]) + rng.random())
            counts[i] += 1
        try:
            used: list[str] = []
            k = 0
            for (region, on_art), c in zip(regions, counts, strict=True):
                if not c:
                    continue
                specs = []
                for _ in range(c):
                    if lines is not None:
                        ln = lines[k]
                        k += 1
                        if ln.type == "narration":
                            specs.append(caption(ln, 26, min_size=20))
                        else:
                            specs.append(dlg(ln, rng, 28, outline_w=rng.choice([2, 3, 4]), min_size=20))
                    else:
                        specs.append(unit_spec(rng, decks, on_art, used))
                stack(cv, mk, region, specs, rng)
            return cv
        except LayoutError:
            continue
    raise LayoutError("could not lay out a chapter slice")


def unit_counts(rng: random.Random, n_text: int) -> list[int]:
    counts = rng.choices([2, 3, 4, 5, 6], weights=[0.3, 0.25, 0.2, 0.15, 0.1], k=n_text)
    target = round(3.5 * n_text)
    while sum(counts) != target:
        i = rng.randrange(n_text)
        if sum(counts) > target and counts[i] > 2:
            counts[i] -= 1
        elif sum(counts) < target and counts[i] < 6:
            counts[i] += 1
    return counts


def chapter(ctx: Ctx, name: str, n_images: int) -> None:
    rng = ctx.rng(name)
    decks = Decks(ctx, rng)
    text_idx = sorted(rng.sample(range(n_images), round(0.4 * n_images)))
    counts = dict(zip(text_idx, unit_counts(rng, len(text_idx)), strict=True))
    images = []
    for i in range(n_images):
        cv = chapter_image(ctx, rng, decks, counts.get(i, 0))
        if counts.get(i, 0) and len(cv.units) != counts[i]:
            raise LayoutError(f"{name}/{i + 1:03d}: {len(cv.units)} units, expected {counts[i]}")
        e = ctx.out.emit(cv, f"{name}/{i + 1:03d}", fmt="jpeg", mask=False, quality=90)
        images.append(e)
    total = sum(e["units"] for e in images)
    index = {"name": name, "lang": "ko", "layout": "strip", "units": total, "images": images}
    ctx.out.json(f"{name}/chapter.json", index)
    ctx.out.fixture(name, "chapter", "ko", "strip", images, index=f"{name}/chapter.json", units=total)


def chapters(ctx: Ctx, full: bool) -> None:
    chapter(ctx, "chapter-ko-60", 60)
    if full:
        chapter(ctx, "chapter-ko-200", 200)


SERIES_PLAN = {
    "ch01": ["k01", "k02", "k03", "k04", "k05", "k06", "k07", "k08", "k09", "k10", "k11", "k12"],
    "ch02": ["k25", "k13", "k14", "k15", "k16", "k17", "k18", "k19", "k20", "k21", "k22", "k23"],
    "ch03": ["k26", "k24", "k02", "k04", "k06", "k08", "k10", "k12", "k14", "k16", "k18", "k20"],
}


def series_ko_names(ctx: Ctx) -> None:
    name = "series-ko-names"
    rng = ctx.rng(name)
    decks = Decks(ctx, rng)
    chapters_out = []
    all_images = []
    for key, ids in SERIES_PLAN.items():
        lines = [ctx.corpus.get("ko", i) for i in ids]
        text_idx = sorted(rng.sample(range(8), 4))
        groups = [lines[0:3], lines[3:6], lines[6:9], lines[9:12]]
        images = []
        g = 0
        for i in range(8):
            if i in text_idx:
                cv = chapter_image(ctx, rng, decks, 0, groups[g])
                g += 1
            else:
                cv = chapter_image(ctx, rng, decks, 0)
            e = ctx.out.emit(cv, f"{name}/{key}/{i + 1:03d}", fmt="jpeg", mask=False, quality=90)
            images.append(e)
        chapters_out.append({"key": key, "lineIds": ids, "images": images})
        all_images.extend(images)
    index = {
        "name": name,
        "lang": "ko",
        "layout": "strip",
        "cast": ctx.corpus.cast["ko"],
        "chapters": chapters_out,
    }
    ctx.out.json(f"{name}/series.json", index)
    ctx.out.fixture(name, "series", "ko", "strip", all_images, index=f"{name}/series.json")
