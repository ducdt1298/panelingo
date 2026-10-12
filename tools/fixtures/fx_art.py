"""Abstract panel art: gradients, noise, screentone, speed lines and geometric shapes.

No characters, people, logos or recognizable scenes; only shapes and colour fields.
"""

import math
import random

from PIL import Image, ImageDraw, ImageOps

from fx_util import RGB, hexrgb, mix

PALETTES: list[list[str]] = [
    ["#2b3a67", "#496a81", "#66999b", "#b3af8f", "#ffc482"],
    ["#1d3557", "#457b9d", "#a8dadc", "#f1faee", "#e63946"],
    ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51"],
    ["#3d405b", "#81b29a", "#f2cc8f", "#e07a5f", "#f4f1de"],
    ["#22223b", "#4a4e69", "#9a8c98", "#c9ada7", "#f2e9e4"],
    ["#0b132b", "#1c2541", "#3a506b", "#5bc0be", "#6fffe9"],
    ["#582f0e", "#7f4f24", "#936639", "#a68a64", "#b6ad90"],
    ["#03045e", "#0077b6", "#00b4d8", "#90e0ef", "#caf0f8"],
]

ART_KINDS = ("gradient", "radial", "shapes", "tone", "noise", "speed", "blocks", "stripes")


def palette(rng: random.Random) -> list[RGB]:
    return [hexrgb(c) for c in rng.choice(PALETTES)]


def ramp_v(w: int, h: int) -> Image.Image:
    col = Image.new("L", (1, 256))
    col.putdata(list(range(256)))
    return col.resize((w, h), Image.Resampling.BILINEAR)


def ramp_h(w: int, h: int) -> Image.Image:
    row = Image.new("L", (256, 1))
    row.putdata(list(range(256)))
    return row.resize((w, h), Image.Resampling.BILINEAR)


def colorize(gray: Image.Image, c0: RGB, c1: RGB) -> Image.Image:
    return ImageOps.colorize(gray, black=c0, white=c1).convert("RGB")


def gradient(w: int, h: int, c0: RGB, c1: RGB, direction: str = "v") -> Image.Image:
    if direction == "v":
        g = ramp_v(w, h)
    elif direction == "h":
        g = ramp_h(w, h)
    elif direction == "d1":
        g = Image.blend(ramp_v(w, h), ramp_h(w, h), 0.5)
    else:
        g = Image.blend(ramp_v(w, h), ImageOps.mirror(ramp_h(w, h)), 0.5)
    return colorize(g, c0, c1)


def radial(w: int, h: int, c_in: RGB, c_out: RGB, cx: float, cy: float, r: float) -> Image.Image:
    g = Image.new("L", (w, h), 255)
    d = max(2, int(2 * r))
    disc = Image.radial_gradient("L").resize((d, d), Image.Resampling.BILINEAR)
    # Pillow's radial gradient is 0 at the centre and saturates at 255 on the inscribed circle.
    g.paste(disc, (int(cx - r), int(cy - r)))
    return colorize(g, c_in, c_out)


def smooth_noise(w: int, h: int, rng: random.Random, cell: int = 40, octaves: int = 3) -> Image.Image:
    acc: Image.Image | None = None
    weight = 0.0
    for o in range(octaves):
        c = max(2, cell >> o)
        sw, sh = w // c + 3, h // c + 3
        small = Image.frombytes("L", (sw, sh), rng.randbytes(sw * sh))
        layer = small.resize((sw * c, sh * c), Image.Resampling.BICUBIC).crop((c, c, c + w, c + h))
        amp = 0.5**o
        if acc is None:
            acc = layer
            weight = amp
        else:
            acc = Image.blend(acc, layer, amp / (weight + amp))
            weight += amp
    assert acc is not None
    return ImageOps.autocontrast(acc, cutoff=1)


def screentone(w: int, h: int, period: int, radius: float, ink: RGB, paper: RGB) -> Image.Image:
    """Anti-aliased halftone dots on an axis-aligned square grid (period and dot radius in px)."""
    ss = 4
    tile = Image.new("L", (period * ss, period * ss), 0)
    d = ImageDraw.Draw(tile)
    c = period * ss / 2
    r = radius * ss
    d.ellipse((c - r, c - r, c + r, c + r), fill=255)
    tile = tile.reduce(ss)
    big = Image.new("L", (period * 16, period * 16), 0)
    for ty in range(16):
        for tx in range(16):
            big.paste(tile, (tx * period, ty * period))
    mask = Image.new("L", (w, h), 0)
    for y in range(0, h, big.height):
        for x in range(0, w, big.width):
            mask.paste(big, (x, y))
    out = Image.new("RGB", (w, h), paper)
    out.paste(ink, (0, 0), mask)
    return out


def speed_lines(w: int, h: int, rng: random.Random, bg: RGB, ink: RGB, n: int = 90) -> Image.Image:
    ss = 2
    img = Image.new("RGB", (w * ss, h * ss), bg)
    d = ImageDraw.Draw(img)
    fx = rng.uniform(0.3, 0.7) * w * ss
    fy = rng.uniform(0.3, 0.7) * h * ss
    far = math.hypot(w, h) * ss
    inner = min(w, h) * ss * rng.uniform(0.12, 0.25)
    for _ in range(n):
        a = rng.uniform(0, 2 * math.pi)
        da = rng.uniform(0.002, 0.012)
        r0 = inner * rng.uniform(0.8, 1.6)
        p0 = (fx + r0 * math.cos(a), fy + r0 * math.sin(a))
        p1 = (fx + far * math.cos(a - da), fy + far * math.sin(a - da))
        p2 = (fx + far * math.cos(a + da), fy + far * math.sin(a + da))
        d.polygon([p0, p1, p2], fill=ink)
    return img.reduce(ss)


def shapes_art(w: int, h: int, rng: random.Random, pal: list[RGB]) -> Image.Image:
    img = gradient(w, h, pal[0], pal[1], rng.choice(["v", "d1", "d2"]))
    ss = 2
    layer = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(rng.randint(6, 14)):
        col = rng.choice(pal[1:]) + (rng.randint(110, 230),)
        kind = rng.random()
        cx, cy = rng.uniform(0, w) * ss, rng.uniform(0, h) * ss
        s = rng.uniform(0.06, 0.3) * min(w, h) * ss
        if kind < 0.35:
            d.ellipse((cx - s, cy - s, cx + s, cy + s), fill=col)
        elif kind < 0.65:
            d.rectangle((cx - s, cy - s * rng.uniform(0.3, 1.0), cx + s, cy + s), fill=col)
        elif kind < 0.9:
            pts = [
                (cx + s * math.cos(t), cy + s * math.sin(t)) for t in (rng.uniform(0, 6.3) for _ in range(3))
            ]
            d.polygon(pts, fill=col)
        else:
            d.line((cx - s, cy - s, cx + s, cy + s * rng.uniform(-1, 1)), fill=col, width=int(s * 0.12) + 2)
    layer = layer.reduce(ss)
    base = img.convert("RGBA")
    base.alpha_composite(layer)
    return base.convert("RGB")


def blocks_art(w: int, h: int, rng: random.Random, pal: list[RGB]) -> Image.Image:
    """Abstract stacked rectangles over a sky-like gradient (no recognizable buildings)."""
    img = gradient(w, h, pal[3] if len(pal) > 3 else pal[0], pal[0], "v")
    d = ImageDraw.Draw(img)
    x = -rng.randint(0, 40)
    base = h * rng.uniform(0.55, 0.9)
    while x < w:
        bw_ = rng.randint(max(20, w // 14), max(40, w // 5))
        top = base - rng.uniform(0.1, 0.5) * h
        d.rectangle((x, top, x + bw_, h), fill=rng.choice(pal[:3]))
        x += bw_ + rng.randint(-10, 6)
    return img


def stripes_art(w: int, h: int, rng: random.Random, pal: list[RGB]) -> Image.Image:
    img = Image.new("RGB", (w, h), pal[0])
    d = ImageDraw.Draw(img)
    step = rng.randint(18, 48)
    slope = rng.uniform(-0.8, 0.8)
    c2 = mix(pal[0], pal[1], 0.5)
    for i, x in enumerate(range(-h, w + h, step)):
        if i % 2:
            d.polygon([(x, 0), (x + step, 0), (x + step + slope * h, h), (x + slope * h, h)], fill=c2)
    return img


def make_art(kind: str, w: int, h: int, rng: random.Random, dark: bool | None = None) -> Image.Image:
    pal = palette(rng)
    if dark is True:
        pal = [mix(c, (0, 0, 0), 0.55) for c in pal]
    elif dark is False:
        pal = [mix(c, (255, 255, 255), 0.45) for c in pal]
    if kind == "gradient":
        return gradient(w, h, pal[0], pal[rng.randint(2, 4)], rng.choice(["v", "h", "d1", "d2"]))
    if kind == "radial":
        return radial(
            w, h, pal[4], pal[0], rng.uniform(0.2, 0.8) * w, rng.uniform(0.2, 0.8) * h, max(w, h) * 0.8
        )
    if kind == "shapes":
        return shapes_art(w, h, rng, pal)
    if kind == "tone":
        paper = (250, 250, 248) if not dark else (60, 60, 64)
        ink = (40, 40, 40) if not dark else (200, 200, 200)
        base = screentone(w, h, rng.choice([6, 7, 8]), rng.uniform(1.2, 2.4), ink, paper)
        return base
    if kind == "noise":
        g = smooth_noise(w, h, rng, cell=rng.choice([24, 40, 64]))
        return colorize(g, pal[0], pal[3])
    if kind == "speed":
        return speed_lines(w, h, rng, pal[4] if not dark else pal[0], pal[1])
    if kind == "blocks":
        return blocks_art(w, h, rng, pal)
    if kind == "stripes":
        return stripes_art(w, h, rng, pal)
    raise ValueError(kind)
