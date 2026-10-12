"""System fonts used to draw fixtures (read from the Windows font folder, never copied into the repo).

Each role lists candidates in order of preference; the first file that exists is used and recorded in
manifest.json with its face index, family/style names, size and sha256.
"""

from pathlib import Path

from PIL import ImageFont

from fx_util import sha256_file

# role -> [(file, ttc face index)]
FONT_ROLES: dict[str, list[tuple[str, int]]] = {
    "ko": [("malgun.ttf", 0)],
    "ko-bold": [("malgunbd.ttf", 0), ("malgun.ttf", 0)],
    "ko-thin": [("malgunsl.ttf", 0), ("malgun.ttf", 0)],
    "ja": [("YuGothM.ttc", 0), ("YuGothR.ttc", 0)],
    "ja-regular": [("YuGothR.ttc", 0), ("YuGothM.ttc", 0)],
    "ja-bold": [("YuGothB.ttc", 0), ("YuGothM.ttc", 0)],
    "zh": [("msyh.ttc", 0)],
    "zh-bold": [("msyhbd.ttc", 0), ("msyh.ttc", 0)],
    "en": [("comicbd.ttf", 0), ("comic.ttf", 0), ("arialbd.ttf", 0)],
    "en-regular": [("comic.ttf", 0), ("arial.ttf", 0)],
    "en-sfx": [("impact.ttf", 0), ("comicbd.ttf", 0), ("arialbd.ttf", 0)],
    "ui": [("arialbd.ttf", 0), ("arial.ttf", 0)],
    "ui-regular": [("arial.ttf", 0)],
}

# A code point no font maps: renders the .notdef glyph, used to detect missing glyphs.
_NOTDEF_PROBE = "\U0010fffd"


class FontError(RuntimeError):
    pass


class Fonts:
    def __init__(self, font_dir: Path) -> None:
        self.font_dir = font_dir
        self._resolved: dict[str, tuple[Path, int]] = {}
        self._cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}
        self._used: dict[str, tuple[Path, int]] = {}
        self._notdef: dict[str, bytes] = {}

    def resolve(self, role: str) -> tuple[Path, int]:
        if role not in self._resolved:
            for name, index in FONT_ROLES[role]:
                p = self.font_dir / name
                if p.is_file():
                    self._resolved[role] = (p, index)
                    break
            else:
                tried = ", ".join(n for n, _ in FONT_ROLES[role])
                raise FontError(f"no font for role {role!r} in {self.font_dir} (tried {tried})")
        return self._resolved[role]

    def get(self, role: str, size: int) -> ImageFont.FreeTypeFont:
        key = (role, int(size))
        f = self._cache.get(key)
        if f is None:
            path, index = self.resolve(role)
            f = ImageFont.truetype(str(path), int(size), index=index, layout_engine=ImageFont.Layout.BASIC)
            self._cache[key] = f
            self._used[role] = (path, index)
        return f

    def has_glyph(self, role: str, ch: str) -> bool:
        if ch.isspace():
            return True
        f = self.get(role, 48)
        if role not in self._notdef:
            self._notdef[role] = _mask_signature(f, _NOTDEF_PROBE)
        return _mask_signature(f, ch) != self._notdef[role]

    def missing(self, role: str, text: str) -> list[str]:
        out: list[str] = []
        for ch in text:
            if ch not in out and not self.has_glyph(role, ch):
                out.append(ch)
        return out

    def manifest(self) -> list[dict]:
        rows = []
        for role in sorted(self._used):
            path, index = self._used[role]
            f = self.get(role, 48)
            family, style = f.getname()
            rows.append(
                {
                    "role": role,
                    "file": path.name,
                    "index": index,
                    "family": family,
                    "style": style,
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
        return rows


def _mask_signature(font: ImageFont.FreeTypeFont, ch: str) -> bytes:
    m = font.getmask(ch)
    return bytes(str(m.size), "ascii") + b"|" + bytes(m)
