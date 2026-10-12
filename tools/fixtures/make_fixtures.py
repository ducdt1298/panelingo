"""Deterministic synthetic fixture generator (Python 3.14 + Pillow 12.3).

    python -I -B tools/fixtures/make_fixtures.py --out test/fixtures/generated --seed 1 [--lite]

Draws ORIGINAL pages only (abstract shapes and gradients, sentences from test/fixtures/sentences) with
Windows system fonts read in place, and writes for every image a ground-truth <name>.gt.json, plus
manifest.json listing each output file with its sha256. Same seed + same Pillow/fonts => identical bytes.
See tools/fixtures/README.md.
"""

import argparse
import hashlib
import json
import platform
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# `python -I` does not put the script directory on sys.path; the helper modules live next to this file.
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import PIL  # noqa: E402
from PIL import features  # noqa: E402

from fx_chapters import chapters, series_ko_names  # noqa: E402
from fx_fonts import Fonts  # noqa: E402
from fx_output import Ctx, Output  # noqa: E402
from fx_pages import (  # noqa: E402
    color_01,
    dense_pages,
    edge_01,
    gradient_01,
    lang_pages,
    names_pages,
    strips,
)
from fx_probes import action_01, canary_01, erase_set, marks_all, res_grid, shapes_probe  # noqa: E402
from fx_units import Corpus  # noqa: E402
from fx_util import sha256_file, write_json  # noqa: E402

GENERATOR_VERSION = "1.0.0"
REPO = HERE.parent.parent
DEFAULT_OUT = REPO / "test" / "fixtures" / "generated"
DEFAULT_SENTENCES = REPO / "test" / "fixtures" / "sentences"
DEFAULT_ASSETS = REPO / "assets" / "canary"

# Builder name -> fixture names it produces (for --only).
BUILDERS: dict[str, list[str]] = {
    "lang-pages": ["ko-p01", "ja-p01", "zh-p01", "en-p01", "es-p01"],
    "names": ["names-ko", "names-ja", "names-zh"],
    "color-01": ["color-01"],
    "gradient-01": ["gradient-01"],
    "dense": ["dense-01", "dense-20", "dense-30"],
    "edge-01": ["edge-01"],
    "strips": ["ko-strip01", "ko-strip01-webp", "ko-strip02", "ko-seam01", "es-strip01"],
    "chapters": ["chapter-ko-60", "chapter-ko-200"],
    "series": ["series-ko-names"],
    "res-grid": ["res-grid"],
    "shapes": ["shapes"],
    "marks": ["marks-5", "marks-10", "marks-16", "marks-20", "marks-30"],
    "erase-set": ["erase-set"],
    "action-01": ["action-01"],
    "canary-01": ["canary-01"],
}


def rel_path(p: Path) -> str:
    return p.resolve().relative_to(REPO).as_posix() if REPO in p.resolve().parents else p.name


def sha256_text(p: Path) -> str:
    return hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument(
        "--out", type=Path, default=DEFAULT_OUT, help="output folder (default test/fixtures/generated)"
    )
    p.add_argument("--seed", type=int, default=1)
    p.add_argument(
        "--lite", action="store_true", help="skip chapter-ko-200 (200 slices) for quick development runs"
    )
    p.add_argument("--only", default="", help="comma-separated builder or fixture names (development only)")
    p.add_argument("--font-dir", type=Path, default=Path("C:/Windows/Fonts"))
    p.add_argument("--sentences", type=Path, default=DEFAULT_SENTENCES)
    p.add_argument(
        "--assets",
        choices=["auto", "always", "never"],
        default="auto",
        help="copy canary-01 to assets/canary: auto = only when --out is test/fixtures/generated",
    )
    return p.parse_args(argv)


def selected(only: str) -> list[str]:
    if not only:
        return list(BUILDERS)
    want = [w.strip() for w in only.split(",") if w.strip()]
    out = []
    for b, names in BUILDERS.items():
        if b in want or any(n in want for n in names):
            out.append(b)
    unknown = [w for w in want if w not in BUILDERS and not any(w in n for n in BUILDERS.values())]
    if unknown:
        raise SystemExit(f"unknown fixture(s): {', '.join(unknown)}")
    return out


def prepare_out(out: Path, clean: bool) -> None:
    """Refuse folders this generator did not write; on a full run, delete the files our previous manifest
    lists (never anything else) so stale fixtures cannot linger."""
    m = out / "manifest.json"
    if not m.is_file():
        if out.exists() and any(p.is_file() for p in out.rglob("*")):
            raise SystemExit(
                f"refusing to write into non-empty {out}: it has no manifest.json from this generator"
            )
        return
    doc = json.loads(m.read_text(encoding="utf-8"))
    if doc.get("generator") != "tools/fixtures/make_fixtures.py":
        raise SystemExit(f"{m} was not written by this generator; refusing to touch {out}")
    if not clean:
        return
    root = out.resolve()
    for f in doc.get("files", []):
        p = (out / f["path"]).resolve()
        if root in p.parents and p.is_file():
            p.unlink()
    m.unlink()
    for d in sorted((p for p in out.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        if not any(d.iterdir()):
            d.rmdir()


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(errors="backslashreplace")  # non-ASCII paths on a cp1252 console
    t0 = time.perf_counter()
    out_dir: Path = args.out.resolve()
    builders = selected(args.only)
    prepare_out(out_dir, clean=not args.only)
    out_dir.mkdir(parents=True, exist_ok=True)
    fonts = Fonts(args.font_dir)
    corpus = Corpus(args.sentences)
    ctx = Ctx(Output(out_dir), fonts, corpus, args.seed)
    canonical = out_dir == DEFAULT_OUT.resolve()
    copy_assets = args.assets == "always" or (args.assets == "auto" and canonical and not args.only)
    for b in builders:
        t = time.perf_counter()
        if b == "lang-pages":
            lang_pages(ctx)
        elif b == "names":
            names_pages(ctx)
        elif b == "color-01":
            color_01(ctx)
        elif b == "gradient-01":
            gradient_01(ctx)
        elif b == "dense":
            dense_pages(ctx)
        elif b == "edge-01":
            edge_01(ctx)
        elif b == "strips":
            strips(ctx)
        elif b == "chapters":
            chapters(ctx, not args.lite)
        elif b == "series":
            series_ko_names(ctx)
        elif b == "res-grid":
            res_grid(ctx)
        elif b == "shapes":
            shapes_probe(ctx)
        elif b == "marks":
            marks_all(ctx)
        elif b == "erase-set":
            erase_set(ctx)
        elif b == "action-01":
            action_01(ctx)
        elif b == "canary-01":
            canary_01(ctx, DEFAULT_ASSETS if copy_assets else None)
        print(f"  {b:<12} {time.perf_counter() - t:6.2f} s")
    files = [
        {"path": rel, "bytes": ctx.out.path(rel).stat().st_size, "sha256": sha256_file(ctx.out.path(rel))}
        for rel in ctx.out.files
    ]
    manifest = {
        "generator": "tools/fixtures/make_fixtures.py",
        "generatorVersion": GENERATOR_VERSION,
        "seed": args.seed,
        "lite": bool(args.lite),
        "only": args.only or None,
        "python": platform.python_version(),
        "pillow": PIL.__version__,
        "freetype": features.version("freetype2"),
        "libwebp": features.version("webp"),
        "libjpeg": features.version("jpg"),
        "zlib": features.version("zlib"),
        "raqm": bool(features.check("raqm")),
        "fonts": fonts.manifest(),
        # LF-normalized so a CRLF checkout (.gitattributes text=auto) records the same hash
        "sentences": [{"path": rel_path(p), "sha256": sha256_text(p)} for p in corpus.files],
        "fixtures": ctx.out.fixtures,
        "files": files,
    }
    write_json(out_dir / "manifest.json", manifest)
    n_units = sum(e["units"] for f in ctx.out.fixtures for e in f["images"])
    print(
        f"wrote {len(files)} files ({sum(f['bytes'] for f in files) / 1e6:.1f} MB), "
        f"{len(ctx.out.fixtures)} fixtures, {n_units} units in {time.perf_counter() - t0:.1f} s -> {out_dir}"
    )
    if copy_assets:
        print(f"copied canary-01.png and canary-01.gt.json to {DEFAULT_ASSETS}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
