"""Shared helpers for the fixture generator: seeded RNG, boxes, colours, prettier-stable JSON, hashing and
saving.

Everything here is deterministic: no clocks, no hash() of strings, no set iteration.
"""

import hashlib
import json
import math
import random
import unicodedata
from pathlib import Path

from PIL import Image

Box = tuple[int, int, int, int]
RGB = tuple[int, int, int]


# --------------------------------------------------------------------------- RNG


def rng_for(seed: int, *parts: object) -> random.Random:
    """Independent stream per (seed, fixture, ...): str seeds are hashed with SHA-512 by `random`."""
    return random.Random("ctv-fixtures/" + str(seed) + "/" + "/".join(str(p) for p in parts))


# --------------------------------------------------------------------------- boxes (x2/y2 exclusive)


def union(a: Box, b: Box) -> Box:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def union_all(boxes: list[Box]) -> Box:
    out = boxes[0]
    for b in boxes[1:]:
        out = union(out, b)
    return out


def inflate(b: Box, d: int) -> Box:
    return (b[0] - d, b[1] - d, b[2] + d, b[3] + d)


def shift(b: Box, dx: int, dy: int) -> Box:
    return (b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy)


def clip(b: Box, w: int, h: int) -> Box:
    return (max(0, min(b[0], w)), max(0, min(b[1], h)), max(0, min(b[2], w)), max(0, min(b[3], h)))


def overlaps(a: Box, b: Box) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def inside(inner: Box, outer: Box) -> bool:
    return inner[0] >= outer[0] and inner[1] >= outer[1] and inner[2] <= outer[2] and inner[3] <= outer[3]


def box_json(b: Box) -> Inline:
    return Inline(x1=int(b[0]), y1=int(b[1]), x2=int(b[2]), y2=int(b[3]))


# --------------------------------------------------------------------------- colours


def hexrgb(s: str) -> RGB:
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def mix(a: RGB, b: RGB, t: float) -> RGB:
    return (
        int(round(a[0] + (b[0] - a[0]) * t)),
        int(round(a[1] + (b[1] - a[1]) * t)),
        int(round(a[2] + (b[2] - a[2]) * t)),
    )


# --------------------------------------------------------------------------- JSON (prettier-stable)

PRINT_WIDTH = 110
INDENT = "  "


class Inline(dict):
    """A JSON object that prettier may print on one line (no newline after "{" in our output).

    Plain dicts are always printed expanded; prettier keeps an object expanded when the source has a
    newline between "{" and the first key, so both forms are stable under `prettier --check`.
    """


def str_width(s: str) -> int:
    """Display width as prettier's getStringWidth computes it (East Asian wide/fullwidth count 2)."""
    w = 0
    for ch in s:
        cp = ord(ch)
        if cp <= 0x1F or 0x7F <= cp <= 0x9F or 0x300 <= cp <= 0x36F:
            continue
        w += 2 if unicodedata.east_asian_width(ch) in ("F", "W") else 1
    return w


def _scalar(v: object) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if not math.isfinite(v):
            raise ValueError("non-finite float in JSON")
        s = f"{v:.4f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    raise TypeError(f"unsupported JSON value {type(v).__name__}")


def _flat(v: object) -> str:
    """Single-line rendering (only meaningful for Inline objects, lists and scalars)."""
    if isinstance(v, Inline):
        if not v:
            return "{}"
        return "{ " + ", ".join(_scalar(k) + ": " + _flat(x) for k, x in v.items()) + " }"
    if isinstance(v, dict):
        raise ValueError("expanded object cannot be flat")
    if isinstance(v, list):
        return "[" + ", ".join(_flat(x) for x in v) + "]"
    return _scalar(v)


def _has_forced_break(v: object) -> bool:
    if isinstance(v, Inline):
        return any(_has_forced_break(x) for x in v.values())
    if isinstance(v, dict):
        return len(v) > 0
    if isinstance(v, list):
        return _array_should_break(v) or any(_has_forced_break(x) for x in v)
    return False


def _array_should_break(items: list) -> bool:
    if len(items) <= 1:
        return False
    if all(isinstance(x, dict) and len(x) > 1 for x in items):
        return True
    if all(isinstance(x, list) and len(x) > 1 for x in items):
        return True
    return False


def _fmt(v: object, level: int, col: int, tail: int) -> str:
    """Render `v` starting at column `col`; `tail` = characters that follow on the same line (",")."""
    pad = INDENT * level
    inner = INDENT * (level + 1)
    if isinstance(v, dict):
        if not v:
            return "{}"
        if isinstance(v, Inline) and not _has_forced_break(v):
            flat = _flat(v)
            if col + str_width(flat) + tail <= PRINT_WIDTH:
                return flat
        parts = []
        keys = list(v.keys())
        for i, k in enumerate(keys):
            key = _scalar(k) + ": "
            t = 1 if i < len(keys) - 1 else 0
            start = len(inner) + str_width(key)
            parts.append(inner + key + _fmt(v[k], level + 1, start, t))
        return "{\n" + ",\n".join(parts) + "\n" + pad + "}"
    if isinstance(v, list):
        if not v:
            return "[]"
        if not _array_should_break(v) and not any(_has_forced_break(x) for x in v):
            flat = _flat(v)
            if col + str_width(flat) + tail <= PRINT_WIDTH:
                return flat
        parts = []
        for i, x in enumerate(v):
            t = 1 if i < len(v) - 1 else 0
            parts.append(inner + _fmt(x, level + 1, len(inner), t))
        return "[\n" + ",\n".join(parts) + "\n" + pad + "]"
    return _scalar(v)


def dumps(value: object) -> str:
    """JSON text that `prettier --check` (printWidth 110, json parser) accepts unchanged; LF line ends."""
    return _fmt(value, 0, 0, 0) + "\n"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(dumps(value).encode("utf-8"))


# --------------------------------------------------------------------------- files


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _clean(img: Image.Image) -> Image.Image:
    # New images carry no metadata, but make sure nothing (dpi, exif, icc, text) can leak into the file.
    img.info.clear()
    return img


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _clean(img).save(path, format="PNG", compress_level=6)


def save_webp(img: Image.Image, path: Path, quality: int = 85) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _clean(img).save(path, format="WEBP", quality=quality, method=6, lossless=False)


def save_jpeg(img: Image.Image, path: Path, quality: int = 90, subsampling: int = 2) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _clean(img).save(
        path, format="JPEG", quality=quality, subsampling=subsampling, optimize=False, progressive=False
    )
