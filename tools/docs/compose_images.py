"""Compose the README and Chrome Web Store images (docs/images) from the captures of e2e/docs-shots.ts.

    python -I -B tools/docs/compose_images.py --raw <captures> --out docs/images --root .

e2e/docs-shots.ts runs this after it captured the raw screenshots (generated fixtures only, translated
against the local mock server). Python 3.14 + Pillow 12.3, as for tools/fixtures. Titles use the Bangers and
Patrick Hand fonts from node_modules/@fontsource (SIL OFL, also bundled with the extension), else Pillow's
default font.

Outputs: before/after (ko-p01) and before-es/after-es (es-p01) at 600x900; popup, sidepanel and options at
CSS size; demo.gif; store-1..3 (1280x800), promo-small (440x280) and marquee (1400x560). A PNG over
MAX_PNG_BYTES is reduced to 256 colours; the GIF drops frames, then shrinks, until it is under MAX_GIF_BYTES.
"""

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

MAX_PNG_BYTES = 400_000
MAX_GIF_BYTES = 4_000_000
PAGE_SIZE = (600, 900)
# Brand colours of the logo (scripts/make-icons.py): indigo to a deep violet, amber accents.
BRAND = (79, 70, 229)
BRAND_DARK = (88, 28, 135)
INK = (33, 33, 33)
WHITE = (255, 255, 255)
YELLOW = (251, 191, 36)
RED = (218, 37, 29)
TAGLINE = "Read any comic, manga or webtoon\nin your language, right where it is."

ROOT = Path(".")
written: list[tuple[str, str]] = []


def font(name: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = ROOT / "node_modules" / "@fontsource" / name / "files" / f"{name}-latin-400-normal.woff"
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        return ImageFont.load_default(size)


def title_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return font("bangers", size)


def text_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return font("patrick-hand", size)


def save_png(img: Image.Image, path: Path, what: str) -> None:
    img.save(path, "PNG", optimize=True)
    if path.stat().st_size > MAX_PNG_BYTES:
        img.convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT).save(path, "PNG", optimize=True)
    written.append((path.name, f"{img.width}x{img.height}, {path.stat().st_size // 1024} KB: {what}"))


def scaled(img: Image.Image, factor: float) -> Image.Image:
    if factor == 1:
        return img.copy()
    return img.resize((round(img.width * factor), round(img.height * factor)), Image.Resampling.LANCZOS)


def fit(img: Image.Image, w: int, h: int) -> Image.Image:
    return scaled(img, min(w / img.width, h / img.height))


def gradient(w: int, h: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    column = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom, strict=True)))
    return column.resize((w, h))


def paste_card(
    base: Image.Image, img: Image.Image, xy: tuple[int, int], radius: int = 18, angle: float = 0
) -> None:
    """Paste with a thin dark border and a soft drop shadow, optionally rotated (xy: top left of the card)."""
    card = Image.new("RGBA", (img.width + 4, img.height + 4), (*INK, 255))
    card.paste(img.convert("RGB"), (2, 2))
    if angle:
        card = card.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
    alpha = card.getchannel("A")
    shadow = Image.new("RGBA", (card.width + 4 * radius, card.height + 4 * radius), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 110), (2 * radius, 2 * radius), alpha)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius / 2))
    x, y = xy[0] - 2, xy[1] - 2
    base.paste(shadow, (x - 2 * radius + 6, y - 2 * radius + 8), shadow)
    base.paste(card, (x, y), card)


def content_box(img: Image.Image, pad: int = 24) -> Image.Image:
    """Crops a screenshot to what differs from its background (the colour of its top-left corner)."""
    bg = Image.new("RGB", img.size, img.getpixel((2, 2)))
    box = ImageChops.difference(img, bg).convert("L").point(lambda v: 255 if v > 16 else 0).getbbox()
    if box is None:
        return img
    return img.crop(
        (
            max(0, box[0] - pad),
            max(0, box[1] - pad),
            min(img.width, box[2] + pad),
            min(img.height, box[3] + pad),
        )
    )


def centered_text(
    draw: ImageDraw.ImageDraw, cx: int, y: int, text: str, fnt, fill, stroke: int = 0
) -> tuple[int, int, int, int]:
    box = draw.textbbox((0, 0), text, font=fnt, stroke_width=stroke)
    x = cx - (box[2] - box[0]) // 2 - box[0]
    draw.text((x, y), text, font=fnt, fill=fill, stroke_width=stroke, stroke_fill=INK)
    return draw.textbbox((x, y), text, font=fnt, stroke_width=stroke)


def pill(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, fill, ink=WHITE) -> None:
    fnt = text_font(26)
    box = draw.textbbox(xy, text, font=fnt)
    draw.rounded_rectangle((box[0] - 14, box[1] - 6, box[2] + 14, box[3] + 8), radius=16, fill=fill)
    draw.text(xy, text, font=fnt, fill=ink)


def load(raw: Path, name: str) -> Image.Image:
    return Image.open(raw / name).convert("RGB")


# --------------------------------------------------------------------------- README images


def pages(raw: Path, out: Path) -> None:
    for name, suffix, lang in (("ko-p01", "", "Korean"), ("es-p01", "-es", "Spanish")):
        before = Image.open(ROOT / "test" / "fixtures" / "generated" / f"{name}.png").convert("RGB")
        save_png(
            before.resize(PAGE_SIZE, Image.Resampling.LANCZOS), out / f"before{suffix}.png", f"{name}, {lang}"
        )
        after = load(raw, f"after-{name}.png").resize(PAGE_SIZE, Image.Resampling.LANCZOS)
        save_png(after, out / f"after{suffix}.png", f"{name} translated into English")


def ui(raw: Path, out: Path, dpr: dict[str, float]) -> None:
    for name, what in (
        ("popup", "toolbar popup for the es-p01 tab"),
        ("sidepanel", "side panel transcript of es-p01"),
        ("options", "options page"),
    ):
        save_png(scaled(load(raw, f"{name}.png"), 1 / dpr.get(name, 1)), out / f"{name}.png", what)


def demo(raw: Path, out: Path) -> None:
    meta = json.loads((raw / "demo" / "frames.json").read_text(encoding="utf-8"))
    frames = [load(raw / "demo", f["file"]) for f in meta["frames"]]
    times = [int(f["t"]) for f in meta["frames"]]
    path = out / "demo.gif"
    step, width = 1, frames[0].width
    while True:
        picked = list(range(0, len(frames), step))
        durations = [times[picked[i + 1]] - times[j] for i, j in enumerate(picked[:-1])] + [1800]
        imgs = [fit(frames[i], width, 10_000) for i in picked]
        # One palette for every frame (they share the strip's colours), no dithering: smaller and steadier.
        sample = imgs[:: max(1, len(imgs) // 12)]
        sheet = Image.new("RGB", (imgs[0].width, imgs[0].height * len(sample)))
        for k, im in enumerate(sample):
            sheet.paste(im, (0, k * im.height))
        palette = sheet.quantize(255, method=Image.Quantize.MEDIANCUT)
        q = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in imgs]
        q[0].save(
            path,
            "GIF",
            save_all=True,
            append_images=q[1:],
            duration=[max(20, d) for d in durations],
            loop=0,
            disposal=1,
            optimize=False,
        )
        size = path.stat().st_size
        if size <= MAX_GIF_BYTES:
            break
        if step == 1:
            step = 2
        elif width > 640:
            width = 640
        else:
            print(f"warning: demo.gif is {size // 1024} KB", file=sys.stderr)
            break
    seconds = sum(durations) / 1000
    written.append(
        (
            "demo.gif",
            f"{q[0].width}x{q[0].height}, {len(q)} frames, {seconds:.1f} s, "
            f"{path.stat().st_size // 1024} KB: ko-strip01 translated while scrolling",
        )
    )


# --------------------------------------------------------------------------- store images


def header(img: Image.Image, title: str, subtitle: str) -> int:
    d = ImageDraw.Draw(img)
    box = centered_text(d, img.width // 2, 22, title, title_font(64), WHITE, stroke=3)
    box = centered_text(d, img.width // 2, box[3] + 8, subtitle, text_font(30), (225, 245, 240))
    return box[3] + 26


def store_1(raw: Path, out: Path) -> None:
    img = gradient(1280, 800, BRAND, BRAND_DARK)
    top = header(
        img, "Translate comics in place", "Original lettering erased, translation fitted to the balloon"
    )
    before = Image.open(ROOT / "test" / "fixtures" / "generated" / "ko-p01.png").convert("RGB")
    after = load(raw, "after-ko-p01.png")
    w = 590
    h = 800 - top - 30
    for k, (page, label, color) in enumerate(((before, "Korean", RED), (after, "English", BRAND_DARK))):
        crop = fit(page, w, 10_000).crop((0, 0, w, h))
        x = 640 - w - 18 if k == 0 else 640 + 18
        paste_card(img, crop, (x, top))
        pill(ImageDraw.Draw(img), (x + 16, top + h - 50), label, color)
    save_png(img, out / "store-1.png", "store: ko-p01 before and after")


def store_2(raw: Path, out: Path, dpr: dict[str, float]) -> None:
    img = gradient(1280, 800, BRAND, BRAND_DARK)
    panel = fit(load(raw, "sidepanel-strip.png"), 10_000, 740)
    strip = load(raw, "strip-section.png")
    left_w = 1280 - panel.width - 3 * 36
    d = ImageDraw.Draw(img)
    box = centered_text(d, 36 + left_w // 2, 30, "Made for webtoons", title_font(60), WHITE, stroke=3)
    box = centered_text(
        d,
        36 + left_w // 2,
        box[3] + 8,
        "Every line in a transcript you can edit",
        text_font(30),
        (225, 245, 240),
    )
    strip = fit(strip, left_w, 800 - box[3] - 50)
    paste_card(img, strip, (36 + (left_w - strip.width) // 2, box[3] + 24))
    paste_card(img, panel, (1280 - panel.width - 36, 30))
    save_png(img, out / "store-2.png", "store: ko-strip01 translated and its side panel transcript")


def store_3(raw: Path, out: Path, dpr: dict[str, float]) -> None:
    img = gradient(1280, 800, BRAND, BRAND_DARK)
    top = header(img, "Bring your own model", "Any OpenAI-compatible vision endpoint, cloud or local")
    room = 800 - top - 34
    popup = load(raw, "popup.png")
    # A 1x popup is not enlarged (it would blur); a 2x capture is shown at up to the full height.
    popup = fit(popup, 10_000, min(room, round(popup.height / dpr.get("popup", 1))))
    gap = 40
    options = fit(content_box(load(raw, "options.png")), 1280 - 2 * 50 - gap - popup.width, room)
    x = (1280 - options.width - popup.width - gap) // 2
    paste_card(img, options, (x, top))
    paste_card(img, popup, (x + options.width + gap, top))
    save_png(img, out / "store-3.png", "store: options page and popup")


def logo_block(img: Image.Image, x: int, cy: int, icon_px: int, name_px: int, tag: str, tag_px: int) -> None:
    icon = Image.open(ROOT / "assets" / "icons" / "logo-512.png").convert("RGBA")
    icon = icon.resize((icon_px, icon_px), Image.Resampling.LANCZOS)
    img.paste(icon, (x, cy - icon_px // 2), icon)
    d = ImageDraw.Draw(img)
    tx = x + icon_px + icon_px // 5
    name_font = title_font(name_px)
    nb = d.textbbox((0, 0), "Panelingo", font=name_font, stroke_width=4)
    tag_font = text_font(tag_px)
    lines = tag.split("\n")
    tb = [d.textbbox((0, 0), line, font=tag_font) for line in lines]
    total = (nb[3] - nb[1]) + 10 + sum(b[3] - b[1] + 6 for b in tb)
    y = cy - total // 2 - nb[1]
    d.text((tx, y), "Panelingo", font=name_font, fill=WHITE, stroke_width=4, stroke_fill=INK)
    y += nb[3] + 10
    for line, b in zip(lines, tb, strict=True):
        d.text((tx, y - b[1]), line, font=tag_font, fill=YELLOW)
        y += b[3] - b[1] + 6


def promo_small(out: Path) -> None:
    img = gradient(440, 280, BRAND, BRAND_DARK)
    logo_block(img, 26, 140, 112, 64, "Comics, manga, webtoons:\ntranslated in place", 25)
    save_png(img, out / "promo-small.png", "store: small promo tile")


def marquee(raw: Path, out: Path) -> None:
    img = gradient(1400, 560, BRAND, BRAND_DARK)
    logo_block(img, 70, 280, 170, 120, TAGLINE, 36)
    before = Image.open(ROOT / "test" / "fixtures" / "generated" / "ko-p01.png").convert("RGB")
    after = load(raw, "after-ko-p01.png")
    region = (40, 40, 1160, 1160)  # top panel and the middle row
    b = fit(before.crop(region), 330, 330)
    a = fit(after.crop(region), 400, 400)
    paste_card(img, b, (925, 58), angle=5)
    paste_card(img, a, (960, 110))
    save_png(img, out / "marquee.png", "store: marquee")


def main(argv: list[str]) -> int:
    global ROOT
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--raw", type=Path, required=True, help="captures written by e2e/docs-shots.ts")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent.parent)
    args = p.parse_args(argv)
    ROOT = args.root
    raw: Path = args.raw
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads((raw / "shots.json").read_text(encoding="utf-8"))
    dpr: dict[str, float] = meta.get("dpr", {})
    pages(raw, out)
    ui(raw, out, dpr)
    if (raw / "demo" / "frames.json").is_file():
        demo(raw, out)
        store_2(raw, out, dpr)
    store_1(raw, out)
    store_3(raw, out, dpr)
    promo_small(out)
    marquee(raw, out)
    for name, what in written:
        print(f"  {name:<16} {what}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
