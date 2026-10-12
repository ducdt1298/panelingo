"""Draw the Panelingo logo and extension icons.

Original, font-free design: two overlapping comic speech balloons on a rounded indigo-to-violet tile. The white
balloon holds a Latin "A", the amber one a Han "文" (the character for "writing"), both built from plain strokes, so
the mark reads as "comics" and "translation" at once. Small sizes (16 and 32 px) use a simplified master without the
characters, with heavier outlines, so the balloons stay crisp.

Outputs:
    assets/icons/icon-{16,32,48,128}.png   manifest icons
    assets/icons/logo-512.png              README and store artwork

    python -I -B scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "icons"
BASE = 1024

TOP = (99, 102, 241)  # indigo
BOTTOM = (168, 85, 247)  # violet
WHITE = (255, 255, 255, 255)
AMBER = (251, 191, 36, 255)
INK = (17, 24, 39, 255)


def gradient_tile(size: int, inset: int, radius: int) -> Image.Image:
    """Rounded square with a diagonal indigo-to-violet gradient."""
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((inset, inset, size - inset, size - inset), radius=radius, fill=255)
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), mask)
    return tile


def balloon(d: ImageDraw.ImageDraw, box, tail, fill, outline: int) -> None:
    """Ellipse with a pointed tail; the outline runs around both without a seam."""
    x1, y1, x2, y2 = box
    # Outline pass: tail and ellipse drawn larger in ink, then the fill on top.
    d.polygon(tail, fill=INK)
    d.ellipse((x1 - outline, y1 - outline, x2 + outline, y2 + outline), fill=INK)
    inner_tail = shrink(tail, outline)
    d.polygon(inner_tail, fill=fill)
    d.ellipse(box, fill=fill)


def shrink(points, by: float):
    """Pulls a triangle's vertices towards its centroid so the ink border shows around the tail."""
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)
    out = []
    for x, y in points:
        dx, dy = x - cx, y - cy
        length = (dx * dx + dy * dy) ** 0.5 or 1
        k = max(0.0, (length - by * 1.6) / length)
        out.append((cx + dx * k, cy + dy * k))
    return out


def stroke(d: ImageDraw.ImageDraw, points, width: int) -> None:
    """A brush stroke with round ends and joints."""
    d.line(points, fill=INK, width=width, joint="curve")
    r = width / 2
    for x, y in (points[0], points[-1]):
        d.ellipse((x - r, y - r, x + r, y + r), fill=INK)


def letter_a(d: ImageDraw.ImageDraw, cx: float, cy: float, h: float, w: int) -> None:
    top = (cx, cy - h / 2)
    left = (cx - h * 0.42, cy + h / 2)
    right = (cx + h * 0.42, cy + h / 2)
    stroke(d, [left, top, right], w)
    stroke(d, [(cx - h * 0.24, cy + h * 0.14), (cx + h * 0.24, cy + h * 0.14)], w)


def han_wen(d: ImageDraw.ImageDraw, cx: float, cy: float, h: float, w: int) -> None:
    """文: a dot, a long horizontal stroke, then a left-falling and a right-falling stroke that cross."""
    stroke(d, [(cx - h * 0.04, cy - h * 0.5), (cx + h * 0.05, cy - h * 0.36)], w)
    stroke(d, [(cx - h * 0.46, cy - h * 0.2), (cx + h * 0.46, cy - h * 0.2)], w)
    stroke(d, [(cx + h * 0.28, cy - h * 0.1), (cx - h * 0.02, cy + h * 0.2), (cx - h * 0.44, cy + h * 0.5)], w)
    stroke(d, [(cx - h * 0.26, cy - h * 0.1), (cx + h * 0.06, cy + h * 0.24), (cx + h * 0.46, cy + h * 0.5)], w)


def draw_master(detailed: bool) -> Image.Image:
    img = gradient_tile(BASE, 24, 230)
    d = ImageDraw.Draw(img)
    outline = 34 if detailed else 56

    # Back balloon, upper left, white with "A".
    back = (110, 150, 640, 590)
    balloon(d, back, [(230, 500), (150, 700), (380, 560)], WHITE, outline)
    # Front balloon, lower right, amber with "文"; it overlaps the back one.
    front = (400, 430, 930, 870)
    balloon(d, front, [(800, 790), (900, 960), (660, 850)], AMBER, outline)

    if detailed:
        letter_a(d, 352, 345, 212, 54)
        han_wen(d, 665, 650, 270, 52)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    full = draw_master(detailed=True)
    simple = draw_master(detailed=False)
    for size, master in ((16, simple), (32, simple), (48, full), (128, full)):
        master.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
    full.resize((512, 512), Image.LANCZOS).save(OUT / "logo-512.png", optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
