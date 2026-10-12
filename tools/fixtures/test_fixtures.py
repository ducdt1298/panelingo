"""Tests for the synthetic fixture generator.

    python -I -B -m unittest discover -s tools/fixtures -p "test_*.py" -v

The generator tests need the Windows fonts listed in fx_fonts.FONT_ROLES; they are skipped elsewhere.
"""

import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from PIL import Image, ImageChops, ImageDraw  # noqa: E402

import make_fixtures  # noqa: E402
from fx_fonts import Fonts  # noqa: E402
from fx_text import VERT, column_cells, tokens_for  # noqa: E402
from fx_units import Corpus, Line, needs_horizontal  # noqa: E402
from fx_util import Inline, dumps, rng_for, str_width  # noqa: E402

REPO = HERE.parent.parent
SENTENCES = REPO / "test" / "fixtures" / "sentences"
ASSETS = REPO / "assets" / "canary"
FONT_DIR = Path("C:/Windows/Fonts")
NEEDED_FONTS = ["malgun.ttf", "malgunbd.ttf", "malgunsl.ttf", "YuGothM.ttc", "YuGothR.ttc", "YuGothB.ttc"]
NEEDED_FONTS += ["msyh.ttc", "msyhbd.ttc", "comic.ttf", "comicbd.ttf", "arial.ttf", "arialbd.ttf"]
HAVE_FONTS = all((FONT_DIR / f).is_file() for f in NEEDED_FONTS)

TYPES = {"dialogue", "thought", "narration", "sign", "sfx", "ignore"}
LANGS = {"ko", "ja", "zh", "en", "es"}
SCRIPT_LANGS = {"ko", "ja", "zh", "en"}  # res-grid: one script each (Spanish is Latin like English)
LAYOUTS = {"paged-ltr", "paged-rtl", "strip"}
UNIT_KEYS = ["id", "kind", "type", "bubble", "text", "texts", "orientation", "glyphPx", "original"]
UNIT_KEYS += ["speaker", "canary"]
REQUIRED_FIXTURES = [
    "ko-p01",
    "ja-p01",
    "zh-p01",
    "en-p01",
    "es-p01",
    "names-ko",
    "names-ja",
    "names-zh",
    "color-01",
    "gradient-01",
    "dense-01",
    "dense-20",
    "dense-30",
    "edge-01",
    "ko-strip01",
    "ko-strip01-webp",
    "ko-strip02",
    "ko-seam01",
    "es-strip01",
    "chapter-ko-60",
    "series-ko-names",
    "res-grid",
    "shapes",
    "marks-5",
    "marks-10",
    "marks-16",
    "marks-20",
    "marks-30",
    "erase-set",
    "action-01",
    "canary-01",
]


def tup(b: dict) -> tuple[int, int, int, int]:
    return (b["x1"], b["y1"], b["x2"], b["y2"])


def overlaps(a, b) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def inside(a, b) -> bool:
    return a[0] >= b[0] and a[1] >= b[1] and a[2] <= b[2] and a[3] <= b[3]


def extent(u: dict) -> tuple[int, int, int, int]:
    return tup(u["bubble"]) if u["bubble"] else tup(u["text"])


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def png_chunks(data: bytes) -> list[bytes]:
    assert data[:8] == bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    out, i = [], 8
    while i < len(data):
        n = int.from_bytes(data[i : i + 4], "big")
        out.append(data[i + 4 : i + 8])
        i += 12 + n
    return out


def webp_chunks(data: bytes) -> list[bytes]:
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    out, i = [], 12
    while i < len(data):
        n = int.from_bytes(data[i + 4 : i + 8], "little")
        out.append(data[i : i + 4])
        i += 8 + n + (n & 1)
    return out


def run_generator(args: list[str]) -> str:
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = make_fixtures.main(args)
    if rc != 0:
        raise AssertionError(f"generator exited with {rc}")
    return buf.getvalue()


# --------------------------------------------------------------------------- JSON emitter


class JsonEmitterTest(unittest.TestCase):
    def test_round_trip(self) -> None:
        rng = rng_for(7, "json")
        for _ in range(200):
            value = {
                "image": "a/b.png",
                "n": rng.randint(-5, 5000),
                "f": round(rng.uniform(0, 3), 3),
                "units": [
                    {
                        "box": Inline(x1=rng.randint(0, 9999), y1=1, x2=2, y2=3),
                        "texts": [Inline(x1=i, y1=i, x2=i + 1, y2=i + 1) for i in range(rng.randint(0, 3))],
                        "lines": ["가나다라마바사" * rng.randint(0, 4), "LINE"],
                        "s": None,
                        "b": rng.random() < 0.5,
                    }
                ],
                "empty": [],
                "emptyObj": {},
            }
            text = dumps(value)
            self.assertTrue(text.endswith("\n") and "\r" not in text)
            self.assertEqual(json.loads(text), json.loads(json.dumps(value)))

    def test_prettier_layout_rules(self) -> None:
        one = dumps({"texts": [Inline(x1=1, y1=2, x2=3, y2=4)]})
        self.assertIn('"texts": [{ "x1": 1, "y1": 2, "x2": 3, "y2": 4 }]', one)
        two = dumps({"texts": [Inline(x1=1, y1=2, x2=3, y2=4), Inline(x1=5, y1=6, x2=7, y2=8)]})
        self.assertIn('"texts": [\n    { "x1": 1, "y1": 2, "x2": 3, "y2": 4 },\n', two)
        # CJK counts double: 2 x 25 syllables + quotes overflow 110 columns once indented
        lines = dumps({"lines": ["가" * 25, "나" * 25]})
        self.assertIn('"lines": [\n    "', lines)
        self.assertEqual(str_width("가A"), 3)
        self.assertEqual(dumps({"x": 1e-05, "y": 0.5, "z": 2.0}), '{\n  "x": 0,\n  "y": 0.5,\n  "z": 2\n}\n')

    def test_every_line_fits_or_is_unbreakable(self) -> None:
        doc = {"units": [{"original": "가" * 80, "box": Inline(x1=1, y1=1, x2=2, y2=2)}]}
        for ln in dumps(doc).split("\n"):
            if str_width(ln) > 110:
                self.assertRegex(ln.strip(), r'^"[^"]+": ".*",?$')


# --------------------------------------------------------------------------- text helpers


class TextTest(unittest.TestCase):
    def test_tokens(self) -> None:
        self.assertEqual(tokens_for("비가 곧 그칠 거야.", "ko"), (["비가", "곧", "그칠", "거야."], " "))
        toks, sep = tokens_for("ごめん、ミルセア。電車が止まってたんだ。", "ja", ("ミルセア",))
        self.assertEqual(sep, "")
        self.assertIn("ミルセア。", toks)  # name kept whole, closing punctuation attached
        self.assertIn("ん、", toks)  # kinsoku: no line starts with 、
        toks, _ = tokens_for("ここのコーヒー、意外とおいしいね。", "ja")
        self.assertIn("コーヒー、", toks)
        toks, _ = tokens_for("易墨川，你又迟到了20分钟！", "zh", ("易墨川",))
        self.assertEqual(toks[0], "易墨川，")
        self.assertIn("20", toks)
        self.assertEqual(toks[-1], "钟！")

    def test_vertical_cells(self) -> None:
        self.assertEqual(column_cells("もう3時"), ["も", "う", "3", "時"])
        self.assertEqual(column_cells("24時間"), ["24", "時", "間"])
        self.assertTrue(needs_horizontal(Line("x", "dialogue", "Melundeのパン屋", "ja")))
        self.assertTrue(needs_horizontal(Line("x", "dialogue", "KX-47号室", "ja")))
        self.assertFalse(needs_horizontal(Line("x", "dialogue", "もう3時だよ。", "ja")))


# --------------------------------------------------------------------------- sentence corpus


class SentencesTest(unittest.TestCase):
    docs: dict

    @classmethod
    def setUpClass(cls) -> None:
        cls.docs = {
            lang: json.loads((SENTENCES / f"{lang}.json").read_text(encoding="utf-8")) for lang in LANGS
        }

    def test_counts_types_and_parallel_ids(self) -> None:
        ids = None
        for lang, doc in self.docs.items():
            lines = doc["lines"]
            self.assertGreaterEqual(len(lines), 120, lang)
            got = [ln["id"] for ln in lines]
            self.assertEqual(len(got), len(set(got)), f"{lang}: duplicate ids")
            ids = ids or got
            self.assertEqual(got, ids, f"{lang}: ids must be parallel to the other languages")
            for ln in lines + doc["actionLines"] + doc["nameLines"]:
                self.assertIn(ln["type"], TYPES)
                self.assertTrue(ln["text"].strip() and ln["vi"].strip(), ln["id"])
            for t in ("dialogue", "thought", "narration", "sign", "sfx"):
                self.assertGreaterEqual(sum(1 for ln in lines if ln["type"] == t), 12, f"{lang} {t}")

    def test_canaries(self) -> None:
        for lang, doc in self.docs.items():
            lines = doc["lines"]
            with_canary = [ln for ln in lines if ln.get("canary")]
            ratio = len(with_canary) / len(lines)
            self.assertTrue(0.09 <= ratio <= 0.15, f"{lang}: canary ratio {ratio:.3f}")
            for ln in with_canary + [x for x in doc["nameLines"] if x.get("canary")]:
                self.assertIn(ln["canary"].lower(), ln["text"].lower(), ln["id"])
                self.assertIn(ln["canary"].lower(), ln["vi"].lower(), ln["id"])

    def test_names(self) -> None:
        for lang in ("ko", "ja", "zh"):
            doc = self.docs[lang]
            cast = {c["name"] for c in doc["cast"]} | {a for c in doc["cast"] for a in c.get("aliases", [])}
            self.assertGreaterEqual(len(doc["nameLines"]), 6)
            for ln in doc["nameLines"]:
                for n in ln["names"]:
                    self.assertIn(n, cast)
                    self.assertIn(n, ln["text"])

    @unittest.skipUnless(HAVE_FONTS, "Windows fonts not available")
    def test_fonts_cover_every_line(self) -> None:
        fonts = Fonts(FONT_DIR)
        roles = {"ko": ["ko-bold", "ko"], "ja": ["ja", "ja-regular", "ja-bold"], "zh": ["zh", "zh-bold"]}
        roles["en"] = ["en", "en-regular"]
        roles["es"] = ["en", "en-regular"]
        corpus = Corpus(SENTENCES)
        for lang, rs in roles.items():
            for ln in corpus.lines[lang] + corpus.action[lang] + corpus.name_lines[lang]:
                for role in rs:
                    self.assertEqual(fonts.missing(role, ln.text), [], f"{role} {lang}:{ln.id}")
        for role in roles["ja"]:  # vertical presentation forms used for Japanese columns
            self.assertEqual(fonts.missing(role, "".join(VERT.values())), [], role)
        for ln in corpus.of_type("es", "sfx") + [x for x in corpus.action["es"] if x.type == "sfx"]:
            self.assertEqual(fonts.missing("en-sfx", ln.text), [], f"en-sfx es:{ln.id}")

    def test_spanish_lines_translate_the_english_ones(self) -> None:
        """es.json is a Spanish scanlation-style corpus: same ids, types, vi and canaries as en.json, drawn in
        capitals with Spanish punctuation and letters."""
        en, es = self.docs["en"], self.docs["es"]
        for key in ("lines", "actionLines"):
            self.assertEqual([x["id"] for x in es[key]], [x["id"] for x in en[key]], key)
            for a, b in zip(en[key], es[key], strict=True):
                self.assertEqual((a["type"], a["vi"], a.get("canary")), (b["type"], b["vi"], b.get("canary")))
                self.assertEqual(b["text"], b["text"].upper(), b["id"])
                self.assertNotEqual(b["text"], a["text"], b["id"])
        text = " ".join(x["text"] for x in es["lines"])
        for ch in "¿¡ÑÁÉÍÓÚ":
            self.assertIn(ch, text)


# --------------------------------------------------------------------------- generated fixtures


@unittest.skipUnless(HAVE_FONTS, "Windows fonts not available")
class GeneratedFixturesTest(unittest.TestCase):
    tmp: tempfile.TemporaryDirectory
    out: Path
    manifest: dict
    gts: dict[str, dict]

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory(prefix="ctv-fixtures-")
        cls.out = Path(cls.tmp.name) / "generated"
        run_generator(["--out", str(cls.out), "--seed", "1", "--lite", "--assets", "never"])
        cls.manifest = json.loads((cls.out / "manifest.json").read_text(encoding="utf-8"))
        cls.gts = {}
        for f in cls.manifest["files"]:
            if f["path"].endswith(".gt.json"):
                cls.gts[f["path"]] = json.loads((cls.out / f["path"]).read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def fixture(self, name: str) -> dict:
        return next(f for f in self.manifest["fixtures"] if f["name"] == name)

    def gt_of(self, image_entry: dict) -> dict:
        return self.gts[image_entry["gt"]]

    # ---- manifest

    def test_manifest_lists_every_file_with_its_hash(self) -> None:
        listed = {f["path"]: f for f in self.manifest["files"]}
        on_disk = {p.relative_to(self.out).as_posix() for p in self.out.rglob("*") if p.is_file()}
        self.assertEqual(on_disk - {"manifest.json"}, set(listed))
        for rel, f in listed.items():
            p = self.out / rel
            self.assertEqual(p.stat().st_size, f["bytes"], rel)
            self.assertEqual(sha256(p), f["sha256"], rel)
        m = self.manifest
        self.assertEqual(m["seed"], 1)
        self.assertEqual(m["generator"], "tools/fixtures/make_fixtures.py")
        self.assertTrue(m["pillow"] and m["generatorVersion"] and m["fonts"])
        for font in m["fonts"]:
            self.assertTrue((FONT_DIR / font["file"]).is_file())
            self.assertRegex(font["sha256"], r"^[0-9a-f]{64}$")
        names = {f["name"] for f in m["fixtures"]}
        for want in REQUIRED_FIXTURES:
            self.assertIn(want, names)

    def test_no_metadata_chunks_in_images(self) -> None:
        """Only pixel chunks: no time stamps, text, EXIF/XMP or ICC that could vary between runs."""
        for f in self.manifest["files"]:
            p = self.out / f["path"]
            if p.suffix == ".png":
                self.assertEqual(
                    set(png_chunks(p.read_bytes())) - {b"IHDR", b"IDAT", b"IEND"}, set(), f["path"]
                )
            elif p.suffix == ".webp":
                self.assertEqual(webp_chunks(p.read_bytes()), [b"VP8 "], f["path"])

    # ---- ground truth invariants

    def test_ground_truth_invariants(self) -> None:
        for rel, gt in self.gts.items():
            with self.subTest(gt=rel):
                self.check_gt(rel, gt)

    def check_gt(self, rel: str, gt: dict) -> None:
        img_path = self.out / gt["image"]
        self.assertTrue(img_path.is_file(), gt["image"])
        W, H = gt["width"], gt["height"]
        with Image.open(img_path) as im:
            self.assertEqual(im.size, (W, H))
        self.assertIn(gt["lang"], LANGS)
        self.assertIn(gt["layout"], LAYOUTS)
        units = gt["units"]
        self.assertEqual([u["id"] for u in units], list(range(1, len(units) + 1)))
        edge_seen = False
        for u in units:
            for k in UNIT_KEYS:
                self.assertIn(k, u)
            self.assertIn(u["kind"], ("bubble", "free"))
            self.assertIn(u["type"], TYPES)
            self.assertIn(u["orientation"], ("h", "v"))
            self.assertIn(u["lang"], LANGS)
            self.assertIsInstance(u["glyphPx"], int)
            self.assertTrue(4 <= u["glyphPx"] <= 400, u["glyphPx"])
            self.assertEqual(u["kind"] == "bubble", u["bubble"] is not None)
            boxes = [u["text"], *u["texts"]] + ([u["bubble"]] if u["bubble"] else [])
            for b in boxes:
                self.assertTrue(all(isinstance(b[k], int) for k in ("x1", "y1", "x2", "y2")))
                self.assertTrue(0 <= b["x1"] < b["x2"] <= W and 0 <= b["y1"] < b["y2"] <= H, b)
            ts = [tup(t) for t in u["texts"]]
            self.assertEqual(
                tup(u["text"]),
                (min(t[0] for t in ts), min(t[1] for t in ts), max(t[2] for t in ts), max(t[3] for t in ts)),
            )
            self.assertEqual(len(u["texts"]), len(u["lines"]))
            self.assertEqual(u["original"], " ".join(u["lines"]))
            if u["bubble"]:
                self.assertTrue(inside(tup(u["text"]), tup(u["bubble"])), u["id"])
            if u["canary"] is not None:
                self.assertIn(u["canary"].lower(), u["original"].lower())
            if u.get("edgeSmall"):
                edge_seen = True
                self.assertEqual(u["type"], "ignore")
            else:
                self.assertFalse(edge_seen, "edge units must be ordered last")
        # units never overlap each other
        for i, a in enumerate(units):
            for b in units[i + 1 :]:
                self.assertFalse(overlaps(extent(a), extent(b)), f"{a['id']} overlaps {b['id']}")
        # webtoon strips are stacked: reading order = top to bottom
        if gt["layout"] == "strip":
            tops = [extent(u)[1] for u in units if not u.get("edgeSmall")]
            self.assertEqual(tops, sorted(tops))
        if "mask" in gt:
            self.check_mask(gt)

    def check_mask(self, gt: dict) -> None:
        with Image.open(self.out / gt["mask"]) as m:
            mask = m.convert("L")
        self.assertEqual(mask.size, (gt["width"], gt["height"]))
        boxes = Image.new("L", mask.size, 0)
        d = ImageDraw.Draw(boxes)
        for u in gt["units"]:
            for t in u["texts"]:
                self.assertIsNotNone(mask.crop(tup(t)).getbbox(), f"no ink in text box of unit {u['id']}")
                d.rectangle((t["x1"], t["y1"], t["x2"] - 1, t["y2"] - 1), fill=255)
        outside = ImageChops.multiply(mask, ImageChops.invert(boxes))
        self.assertIsNone(outside.getbbox(), f"{gt['mask']}: ink outside every text box")

    # ---- fixture specifics

    def test_language_pages(self) -> None:
        for lang in ("ko", "ja", "zh", "en", "es"):
            gt = self.gt_of(self.fixture(f"{lang}-p01")["images"][0])
            self.assertEqual((gt["width"], gt["height"]), (1200, 1800))
            self.assertEqual(gt["layout"], "paged-rtl" if lang == "ja" else "paged-ltr")
            types = [u["type"] for u in gt["units"]]
            for t in ("dialogue", "thought", "narration", "sign", "sfx", "ignore"):
                self.assertIn(t, types, lang)
            if lang == "ja":
                self.assertGreaterEqual(sum(1 for u in gt["units"] if u["orientation"] == "v"), 5)

    def test_strip01_and_webp_slices(self) -> None:
        full = self.gt_of(self.fixture("ko-strip01")["images"][0])
        self.assertEqual((full["width"], full["height"]), (800, 7680))
        slices = self.fixture("ko-strip01-webp")["images"]
        self.assertEqual([s["image"] for s in slices], [f"ko-strip01-s{k}.webp" for k in (1, 2, 3)])
        rebuilt = []
        for k, s in enumerate(slices):
            gt = self.gt_of(s)
            self.assertEqual((gt["width"], gt["height"]), (800, 2560))
            self.assertEqual(gt["parent"], {"image": "ko-strip01.png", "y0": 2560 * k})
            for u in gt["units"]:
                rebuilt.append((u["original"], extent(u)[1] + 2560 * k))
        self.assertEqual(rebuilt, [(u["original"], extent(u)[1]) for u in full["units"]])

    def test_es_strip01(self) -> None:
        gt = self.gt_of(self.fixture("es-strip01")["images"][0])
        units = gt["units"]
        self.assertEqual((gt["width"], gt["height"]), (800, 5120))
        self.assertEqual((gt["lang"], gt["layout"]), ("es", "strip"))
        self.assertEqual(len(units), 11)
        self.assertEqual({u["lang"] for u in units}, {"es"})
        self.assertTrue({"dialogue", "thought", "narration", "sign", "sfx"} <= {u["type"] for u in units})
        self.assertEqual({u["kind"] for u in units}, {"bubble", "free"})
        self.assertEqual([u["canary"] for u in units if u["canary"]], ["Melunde"])
        self.assertTrue(all(u["vi"] for u in units))
        self.assertFalse(any(extent(u)[1] < 2560 < extent(u)[3] for u in units), "a unit crosses y = 2560")
        text = " ".join(u["original"] for u in units)
        for ch in "¿Ñ":
            self.assertIn(ch, text)
        page = self.gt_of(self.fixture("es-p01")["images"][0])
        page_text = " ".join(u["original"] for u in page["units"])
        for ch in "¿¡ÑÓ":
            self.assertIn(ch, page_text)

    def test_strip02(self) -> None:
        gt = self.gt_of(self.fixture("ko-strip02")["images"][0])
        units = gt["units"]
        self.assertEqual((gt["width"], gt["height"]), (720, 9000))
        self.assertEqual(len(units), 14)
        self.assertEqual(sum(1 for u in units if u["kind"] == "free" and u["type"] == "narration"), 4)
        self.assertEqual(sum(1 for u in units if u["type"] == "sfx"), 2)
        self.assertTrue(any(u["glyphPx"] == 14 for u in units), "a 14 px text unit")
        for cut in (3000, 6000):
            self.assertEqual(sum(1 for u in units if extent(u)[1] < cut < extent(u)[3]), 1, cut)

    def test_seam_split(self) -> None:
        layout = json.loads((self.out / "ko-seam01.layout.json").read_text(encoding="utf-8"))
        self.assertEqual(layout["cuts"], [3000, 6000])
        self.assertEqual([v["gapPx"] for v in layout["variants"]], [0, 4])
        self.assertEqual(layout["variants"][1]["tops"], [0, 3004, 6008])
        images = self.fixture("ko-seam01")["images"]
        self.assertEqual([e["height"] for e in images], [3000, 3000, 3000])
        gts = [self.gt_of(e) for e in images]
        self.assertEqual(len(layout["seams"]), 2)
        self.assertEqual([s["cutThroughText"] for s in layout["seams"]], [False, True])
        for i, s in enumerate(layout["seams"]):
            up = gts[i]["units"][s["upper"]["id"] - 1]
            lo = gts[i + 1]["units"][s["lower"]["id"] - 1]
            self.assertEqual(up["seam"], {"seamId": s["seamId"], "part": "upper"})
            self.assertEqual(lo["seam"], {"seamId": s["seamId"], "part": "lower"})
            self.assertEqual(up["bubble"]["y2"], 3000)
            self.assertEqual(lo["bubble"]["y1"], 0)
        full = self.gt_of(self.fixture("ko-strip02")["images"][0])
        whole = sum(1 for g in gts for u in g["units"] if "seam" not in u)
        self.assertEqual(whole + 2, len(full["units"]))

    def test_chapter_60(self) -> None:
        index = json.loads((self.out / "chapter-ko-60" / "chapter.json").read_text(encoding="utf-8"))
        imgs = index["images"]
        self.assertEqual(len(imgs), 60)
        self.assertEqual(sum(1 for e in imgs if e["units"]), 24)
        self.assertEqual(index["units"], 84)
        self.assertTrue(all(2 <= e["units"] <= 6 for e in imgs if e["units"]))
        self.assertTrue(all((e["width"], e["height"]) == (800, 2000) for e in imgs))
        types = {u["type"] for e in imgs for u in self.gt_of(e)["units"]}
        kinds = {u["kind"] for e in imgs for u in self.gt_of(e)["units"]}
        self.assertTrue({"dialogue", "narration", "sfx"} <= types and kinds == {"bubble", "free"})
        self.assertNotIn("chapter-ko-200", {f["name"] for f in self.manifest["fixtures"]})  # --lite

    def test_series_names_recur(self) -> None:
        index = json.loads((self.out / "series-ko-names" / "series.json").read_text(encoding="utf-8"))
        self.assertEqual([c["key"] for c in index["chapters"]], ["ch01", "ch02", "ch03"])
        cast = [c["name"] for c in index["cast"] if c["role"] == "character"]
        per_name: dict[str, set[str]] = {n: set() for n in cast}
        for ch in index["chapters"]:
            text = " ".join(u["original"] for e in ch["images"] for u in self.gt_of(e)["units"])
            for n in cast:
                if n in text:
                    per_name[n].add(ch["key"])
        for n, chs in per_name.items():
            self.assertGreaterEqual(len(chs), 2, n)

    def test_res_grid(self) -> None:
        entries = self.fixture("res-grid")["images"]
        sizes = [(e["width"], e["height"]) for e in entries]
        self.assertEqual(sizes, [(2048, 768), (2048, 1152), (1024, 384)])
        for e in entries[:2]:
            units = self.gt_of(e)["units"]
            self.assertEqual(len(units), 32)
            for u in units:
                self.assertLessEqual(abs(u["glyphPx"] - u["glyphTarget"]), 2, u["id"])
            self.assertEqual({u["lang"] for u in units}, SCRIPT_LANGS)

    def test_shapes_marks_erase_action_canary(self) -> None:
        shapes = self.gt_of(self.fixture("shapes")["images"][0])["units"]
        self.assertEqual(len({u["shape"] for u in shapes}), 6)
        self.assertEqual(len({u["color"] for u in shapes}), 6)
        self.assertEqual([u["number"] for u in shapes], [1, 2, 3, 4, 5, 6])
        for n in (5, 10, 16, 20, 30):
            f = self.fixture(f"marks-{n}")
            self.assertEqual(len(self.gt_of(f["images"][0])["units"]), n)
            marks = json.loads((self.out / f["marks"]).read_text(encoding="utf-8"))["marks"]
            self.assertEqual([m["id"] for m in marks], list(range(1, n + 1)))
            self.assertTrue((self.out / f["marked"]).is_file())
        erase = self.fixture("erase-set")["images"]
        self.assertEqual(len(erase), 25)
        self.assertEqual(len({(e["background"], e["ink"]) for e in erase}), 25)
        self.assertEqual(len({self.gt_of(e)["units"][0]["original"] for e in erase}), 25)
        for e in erase:
            gt = self.gt_of(e)
            with Image.open(self.out / gt["image"]) as a, Image.open(self.out / gt["clean"]) as b:
                diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB")).convert("L")
            with Image.open(self.out / gt["mask"]) as m:
                stray = ImageChops.multiply(
                    diff.point(lambda v: 255 if v else 0),
                    ImageChops.invert(m.convert("L").point(lambda v: 255 if v else 0)),
                )
            self.assertIsNone(stray.getbbox(), f"{gt['image']}: pixels changed outside the glyph mask")
            self.assertTrue((self.out / gt["jpeg"]).is_file())
        action = self.gt_of(self.fixture("action-01")["images"][0])["units"]
        self.assertGreaterEqual(sum(1 for u in action if u["type"] == "sfx"), 2)
        canary = self.gt_of(self.fixture("canary-01")["images"][0])
        self.assertEqual({u["kind"] for u in canary["units"]}, {"bubble", "free"})
        self.assertGreaterEqual(len({u["lang"] for u in canary["units"]}), 4)
        self.assertIn("v", {u["orientation"] for u in canary["units"]})

    def test_edge_page(self) -> None:
        gt = self.gt_of(self.fixture("edge-01")["images"][0])
        units = gt["units"]
        self.assertTrue(any(u["bubble"] and u["bubble"]["x2"] == gt["width"] for u in units), "cut bubble")
        self.assertTrue(any(u["glyphPx"] <= 13 for u in units if not u.get("edgeSmall")), "12 px text")
        self.assertEqual([u.get("edgeSmall", False) for u in units[-2:]], [True, True])
        self.assertEqual(units[-1]["orientation"], "v")

    def test_dense_counts(self) -> None:
        for name, n in (("dense-01", 10), ("dense-20", 20), ("dense-30", 30)):
            self.assertEqual(len(self.gt_of(self.fixture(name)["images"][0])["units"]), n)

    # ---- determinism and safety

    def test_byte_identical_in_a_fresh_process(self) -> None:
        """A second interpreter (different string-hash seed) must reproduce the same bytes."""
        subset = "lang-pages,names,strips,erase-set,canary-01,marks,series"
        with tempfile.TemporaryDirectory(prefix="ctv-fixtures-b-") as tmp:
            out = Path(tmp) / "g"
            cmd = [
                sys.executable,
                "-I",
                "-B",
                str(HERE / "make_fixtures.py"),
                "--out",
                str(out),
                "--seed",
                "1",
            ]
            subprocess.run([*cmd, "--only", subset, "--assets", "never"], check=True, capture_output=True)
            second = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        first = {f["path"]: f["sha256"] for f in self.manifest["files"]}
        self.assertGreater(len(second["files"]), 100)
        for f in second["files"]:
            self.assertEqual(first.get(f["path"]), f["sha256"], f["path"])

    def test_seed_changes_output(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ctv-fixtures-c-") as tmp:
            out = Path(tmp) / "g"
            run_generator(["--out", str(out), "--seed", "2", "--only", "ko-p01", "--assets", "never"])
            self.assertNotEqual(sha256(out / "ko-p01.png"), sha256(self.out / "ko-p01.png"))

    def test_committed_canary_matches_seed_1(self) -> None:
        if not (ASSETS / "canary-01.png").is_file():
            self.skipTest("assets/canary/canary-01.png not generated yet")
        self.assertEqual(sha256(ASSETS / "canary-01.png"), sha256(self.out / "canary-01.png"))
        # text files may be checked out with CRLF (.gitattributes: text=auto); compare LF-normalized text
        committed = (ASSETS / "canary-01.gt.json").read_bytes().replace(b"\r\n", b"\n")
        self.assertEqual(committed, (self.out / "canary-01.gt.json").read_bytes())

    def test_refuses_foreign_output_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ctv-fixtures-d-") as tmp:
            (Path(tmp) / "keep.txt").write_text("not ours", encoding="utf-8")
            with self.assertRaises(SystemExit), redirect_stdout(io.StringIO()):
                make_fixtures.main(["--out", tmp, "--assets", "never"])
            self.assertTrue((Path(tmp) / "keep.txt").is_file())

    def test_full_run_removes_only_files_it_wrote(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ctv-fixtures-e-") as tmp:
            out = Path(tmp) / "g"
            run_generator(["--out", str(out), "--only", "shapes", "--assets", "never"])
            stray = out / "stray.txt"
            stray.write_text("x", encoding="utf-8")
            make_fixtures.prepare_out(out, clean=False)  # --only runs keep earlier files
            self.assertTrue((out / "shapes.png").exists())
            make_fixtures.prepare_out(out, clean=True)  # what a full run does first
            self.assertFalse((out / "shapes.png").exists() or (out / "manifest.json").exists())
            self.assertTrue(stray.exists(), "files not listed in our manifest are never deleted")


if __name__ == "__main__":
    unittest.main()
