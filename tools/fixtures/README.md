# tools/fixtures — synthetic comic fixtures with ground truth

Deterministic Pillow generator for the quality benchmarks and for unit, integration and E2E tests. Every
image is **original**: abstract panel art (gradients, noise, screentone, speed lines, geometric shapes; no
characters, people, logos or real pages) and sentences written for this project
(`test/fixtures/sentences/*.json`). Each image gets a ground-truth file `<name>.gt.json` next to it.

```powershell
npm run fixtures
# = python -I -B tools/fixtures/make_fixtures.py --out test/fixtures/generated --seed 1
```

The default run writes everything (about 805 files, 72 MB, about 30 s) into `test/fixtures/generated/`
(gitignored), then copies `canary-01.png` and `canary-01.gt.json` to `assets/canary/` (committed; shipped in
`dist/assets/canary/` for the WebGPU-vs-WASM detector canary).

| Flag                           | Effect                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `--seed N`                     | Seed (default 1). Same seed, same environment: byte-identical files.                    |
| `--lite`                       | Skip `chapter-ko-200` (saves about 10 s and 40 MB).                                     |
| `--only a,b`                   | Development: only these builders or fixtures; the manifest then lists only those files. |
| `--out DIR`                    | Output folder. A folder that is not empty must hold a `manifest.json` from this tool.   |
| `--assets auto\|always\|never` | Copy the canary to `assets/canary/`; `auto` = only for a full run into the default out. |
| `--font-dir`, `--sentences`    | Override `C:/Windows/Fonts` and `test/fixtures/sentences`.                              |

A full run first deletes the files listed by the previous `manifest.json` (and nothing else), so stale
fixtures cannot survive a change of the generator.

## Requirements

Python 3.14 with Pillow 12.3 (no other packages; libraqm is **not** needed: vertical Japanese is laid out
one glyph at a time). Fonts are read in place from the Windows font folder and are never copied into the
repo; the first existing file of each role is used and recorded in `manifest.json` (file, face index,
family, style, size, sha256).

| Role                            | Font file (TTC face)                                  | Used for                         |
| ------------------------------- | ----------------------------------------------------- | -------------------------------- |
| `ko-bold` / `ko` / `ko-thin`    | `malgunbd.ttf` / `malgun.ttf` / `malgunsl.ttf`        | Korean bubbles / captions / thin |
| `ja` / `ja-regular` / `ja-bold` | `YuGothM.ttc` (0) / `YuGothR.ttc` (0) / `YuGothB.ttc` | Japanese body / captions / SFX   |
| `zh` / `zh-bold`                | `msyh.ttc` (0) / `msyhbd.ttc` (0)                     | Simplified Chinese / SFX         |
| `en` / `en-regular` / `en-sfx`  | `comicbd.ttf` / `comic.ttf` / `impact.ttf`            | English and Spanish caps / SFX   |
| `ui` / `ui-regular`             | `arialbd.ttf` / `arial.ttf`                           | Labels, page numbers, watermarks |

Japanese vertical text: punctuation uses the Unicode vertical presentation forms (U+FE10..FE19,
U+FE30..FE44, mapped by Yu Gothic); `ー`, `〜`, `～` and dashes are rotated; small kana are nudged to the upper
right; runs of up to 3 ASCII letters or digits are set side by side in one cell (tate-chu-yoko). A Japanese
line with a longer Latin run (for example a canary token) is set horizontally instead. CJK wrapping follows
kinsoku rules and never splits ASCII runs, katakana words or the cast names of a line.

## Fixtures

Paths are relative to the output folder. `L` = language, `units` = ground-truth units per image.

| Fixture                                      | Files                                                             | Size                | L, layout                | Units                      | Purpose                                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------- | ------------------- | ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ko-p01` `ja-p01` `zh-p01` `en-p01` `es-p01` | `<name>.png`                                                      | 1200×1800           | per page                 | 9                          | Same parallel lines in 5 languages: caption, 4 dialogue, thought, sign, SFX, page number. Japanese: vertical, right-to-left panels. Spanish: capitals with ¿ ¡, ñ and accents                    |
| `names-ko` `names-ja` `names-zh`             | `<name>.png`                                                      | 800×2560, 1200×1800 | ko strip, ja rtl, zh ltr | 6 (+ page number on ja/zh) | Recurring made-up names (top-level `cast`), number canaries                                                                                                                                      |
| `color-01`                                   | `color-01.png`                                                    | 1200×1800           | ko paged-ltr             | 9                          | Coloured bubbles and ink, light-on-dark text                                                                                                                                                     |
| `gradient-01`                                | `gradient-01.png`                                                 | 1200×1800           | ko paged-ltr             | 6                          | Text directly over gradients and noise (text_free), borderless bubble                                                                                                                            |
| `dense-01` `dense-20` `dense-30`             | `<name>.png`                                                      | 1200×1800           | ko paged-ltr             | 10 / 20 / 30               | Many small bubbles                                                                                                                                                                               |
| `edge-01`                                    | `edge-01.png`                                                     | 1200×1800           | ko paged-ltr             | 8                          | Bubble cut by the page edge, 12 px text, 15° rotated shout, page number + watermark last                                                                                                         |
| `ko-strip01`                                 | `ko-strip01.png`                                                  | 800×7680            | ko strip                 | 17                         | Webtoon strip; no unit crosses y = 2560 / 5120                                                                                                                                                   |
| `ko-strip01-webp`                            | `ko-strip01-s1.webp` … `-s3.webp`                                 | 3 × 800×2560        | ko strip                 | per slice                  | WebP (q85) slices of ko-strip01 with their own ground truth (`parent.y0`)                                                                                                                        |
| `ko-strip02`                                 | `ko-strip02.png`                                                  | 720×9000            | ko strip                 | 14                         | 4 text_free narrations over gradients, 2 SFX, one 14 px unit, bubbles across y = 3000/6000                                                                                                       |
| `ko-seam01`                                  | `ko-seam01/ko-seam01-{1,2,3}.png`, `ko-seam01.layout.json`        | 3 × 720×3000        | ko strip                 | per image                  | ko-strip02 cut at y = 3000 / 6000. The first cut passes between two text lines, the second through a line                                                                                        |
| `es-strip01`                                 | `es-strip01.png`                                                  | 800×5120            | es strip                 | 11                         | Short Spanish webtoon strip: 4 panels, caption, text_free narration, thought, sign, SFX, canary `Melunde`; no unit crosses y = 2560                                                              |
| `chapter-ko-60`                              | `chapter-ko-60/001.jpg` … `060.jpg`, `chapter.json`               | 60 × 800×2000       | ko strip                 | 84 in total                | Seeded chapter: 24 slices (40%) with 2–6 units, incl. text_free and SFX; JPEG q90                                                                                                                |
| `chapter-ko-200`                             | `chapter-ko-200/001.jpg` … `200.jpg`, `chapter.json`              | 200 × 800×2000      | ko strip                 | 280 in total               | Same generator, 200 slices (soak). Skipped with `--lite`                                                                                                                                         |
| `series-ko-names`                            | `series-ko-names/ch0{1,2,3}/001.jpg` …, `series.json`             | 3 × 8 × 800×2000    | ko strip                 | 12 per chapter             | Three chapters with recurring original names (series memory)                                                                                                                                     |
| `res-grid`                                   | `res-grid.png`, `res-grid-2048x1152.png`, `res-grid-1024x384.png` | 2048×768 …          | mixed                    | 32                         | 4 scripts × glyph heights 8, 10, 12, 14, 16, 20, 24, 32 px of random strings; cell `#n` = unit id. The 2048×1152 copy keeps glyph sizes; the 1024×384 copy is the 2048×768 image downscaled ×0.5 |
| `shapes`                                     | `shapes.png`                                                      | 1200×800            | en                       | 6                          | numbered regions, each a distinct coloured shape with an invented word (`shape`, `color`, `colorHex`, `number`)                                                                                  |
| `marks-5` … `marks-30`                       | `marks-N.png`, `marks-N.marked.png`, `marks-N.marks.json`         | 1200×1800           | ko paged-ltr             | N                          | N bubbles; the marked copy adds numbered badges above each bubble                                                                                                                                |
| `erase-set`                                  | `erase-set/<bg>-<ink>.{png,clean.png,mask.png,q75.jpg}`           | 25 × 640×400        | ko                       | 1                          | 5 backgrounds (white, color, gradient, tone, noise) × 5 inks (black, white-on-dark, outline, color, thin); `clean` = same image without text                                                     |
| `action-01`                                  | `action-01.png`                                                   | 800×2560            | ko strip                 | 7                          | mild fictional confrontation lines and fight SFX (nothing graphic)                                                                                                                               |
| `canary-01`                                  | `canary-01.png` (+ copy in `assets/canary/`)                      | 800×1200            | mixed paged              | 9                          | detector canary: bubbles, cloud, caption, vertical Japanese, text_free, SFX, sign                                                                                                                |

Page-like PNGs also get `<name>.mask.png` (glyph coverage 0–255, including strokes) for erase scoring;
WebP slices, JPEG chapters and the canary do not.

## Ground truth (`<name>.gt.json`)

All boxes are integer natural pixels of that image, `{ "x1", "y1", "x2", "y2" }` with x2/y2 exclusive, and
are **exact ink boxes** measured from the rendered glyph masks (not font metrics).

```jsonc
{
  "image": "ko-p01.png", // relative to the output folder (forward slashes)
  "width": 1200,
  "height": 1800,
  "lang": "ko", // ko | ja | zh | en | es; mixed probes use the main language and list "langs"
  "layout": "paged-ltr", // paged-ltr | paged-rtl | strip
  "mask": "ko-p01.mask.png", // optional extras: mask, parent, cast, langs, glyphHeights, erase-set keys
  "units": [
    {
      "id": 1, // 1-based reading order
      "kind": "bubble", // bubble (balloon, cloud or caption box) | free (text on the art, SFX, signs)
      "type": "narration", // dialogue | thought | narration | sign | sfx | ignore
      "bubble": { "x1": 0, "y1": 0, "x2": 0, "y2": 0 }, // body incl. outline, tail excluded; null if free
      "text": { "x1": 0, "y1": 0, "x2": 0, "y2": 0 }, // union of the boxes in "texts"
      "texts": [{ "x1": 0, "y1": 0, "x2": 0, "y2": 0 }], // one ink box per line (h) or column (v)
      "orientation": "h", // h | v
      "glyphPx": 26, // median cross-axis ink extent of the lines/columns, fill only (no stroke)
      "original": "다음 날 아침", // exact text drawn, lines joined by one space (also for ja/zh)
      "speaker": null, // name lines carry the speaker
      "canary": null, // invented token that must appear verbatim in the translation
      // extras
      "lines": ["다음 날 아침"], // text of each entry of "texts"
      "vi": "Sáng hôm sau", // reference Vietnamese translation (null for page marks)
      "lang": "ko",
      "fontPx": 28,
      "shape": "rect", // ellipse | ellipse-borderless | cloud | rect | board | none | probe shape
    },
  ],
}
```

- **Detector classes** for scoring: a `bubble` unit gives one `bubble` box plus `text_bubble` text boxes; a
  `free` unit gives `text_free` boxes. Caption boxes (`shape: "rect"`) count as bubbles; painted signs
  (`shape: "board"`) are free text.
- **Reading order**: webtoon strips read top to bottom; pages read panel by panel (rows top to bottom, panels
  left to right, or right to left for `paged-rtl`), and inside a panel in drawing order (the first unit is
  the top-left one, top-right for Japanese). Units never overlap.
- **Page marks** (page number, watermark) have `type: "ignore"`, `edgeSmall: true` and come last.
- **Seams**: in `ko-seam01`, the two halves of a bubble cut by an image boundary are separate units with
  `"seam": { "seamId": "seam-1", "part": "upper" | "lower" }`, clipped to their image (`lines` keeps the
  lines that are at least partly visible). `ko-seam01.layout.json` lists the cuts, the images (`y0`, `y1`
  in the source strip), the page layouts with 0 px and 4 px gaps (`variants[].tops`), and the seams
  (`upper`/`lower` image + unit id, `sourceUnit` in ko-strip02, `cutThroughText`).
- `chapter.json` / `series.json` list the images in order with their unit counts; `series.json` also has the
  `cast` and the sentence ids per chapter. `marks-N.marks.json` lists the badge box per unit id.

`manifest.json` records the generator version, seed, Python/Pillow/FreeType/libwebp/libjpeg/zlib
versions, the fonts used (file, face index, family, sha256), the sentence files' sha256, the fixtures
(name, group, language, layout, images with unit counts) and **every output file with its size and
sha256**. JSON files are written in the exact layout Prettier produces (`printWidth` 110), so the committed
`assets/canary/canary-01.gt.json` passes `npm run format:check`.

## Sentences (`test/fixtures/sentences/{ko,ja,zh,en,es}.json`)

128 original lines per language (64 dialogue, 16 thought, 16 narration, 14 sign, 18 SFX). Lines that
share an `id` are parallel translations across the five languages, and `vi` is a reference Vietnamese
translation (used by the oracle mock and the rendering tests). 13 lines per language (10%) carry an invented
`canary` token (`Zorvaki`, `Melunde`, `KX-47`, …) written in Latin letters inside the CJK text, so a
translation must keep it verbatim; English lines are drawn in capitals, so compare canaries
case-insensitively. Also: `actionLines` (mild confrontation lines and fight SFX for `action-01`), `cast`
(made-up names with their Vietnamese rendering) and `nameLines` (`speaker`, `names`, number canaries).
`es.json` is the Spanish source set (as in Spanish scanlations): it translates the English lines and their
`actionLines` id for id, keeps the same `vi` and canaries, is drawn in capitals with `¿ ¡`, `ñ` and accents
using the English fonts, and has no `cast` or `nameLines`.

## Determinism

Each fixture draws from its own `random.Random` stream seeded with `(seed, fixture name)`, so `--only`
reproduces the same bytes as a full run. There are no clocks, no `hash()` of strings and no set iteration;
images are saved with fixed encoder parameters and no metadata (PNG holds only IHDR/IDAT/IEND, WebP only
VP8). With the same seed, Pillow build and font files the output is byte-identical; the manifest records
those versions and font hashes so a difference can be traced.

## Tests

```powershell
python -I -B -m unittest discover -s tools/fixtures -p "test_*.py" -v
```

About 25 s. The tests generate the set into a temporary folder and check the JSON layout rules, CJK
wrapping, the sentence corpus (counts, parallel ids, canaries, font coverage), every ground-truth file
(schema, box bounds, text inside its bubble, no overlaps, reading order, masks covering exactly the text
boxes), the fixture-specific requirements above, byte-identical output from a second Python process,
and that the committed canary matches seed 1. They are skipped when the Windows fonts are missing.
Optional linting: `python -m ruff check tools/fixtures` (config in `ruff.toml`).

## Modules

| File               | Content                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `make_fixtures.py` | CLI, output folder safety, manifest                                               |
| `fx_util.py`       | Seeded RNG, box helpers, Prettier-stable JSON writer, hashing, image saving       |
| `fx_fonts.py`      | Font roles and missing-glyph checks                                               |
| `fx_text.py`       | Tokenizing and wrapping (kinsoku), glyph-by-glyph vertical columns, ink masks     |
| `fx_art.py`        | Abstract panel art                                                                |
| `fx_units.py`      | Bubbles, clouds, captions, free text, SFX, signs; fitting, placement, GT records  |
| `fx_output.py`     | Output bookkeeping                                                                |
| `fx_pages.py`      | Language, names, colour, gradient, dense and edge pages; KO strips; slices; seams |
| `fx_chapters.py`   | Seeded chapters and the names series                                              |
| `fx_probes.py`     | res-grid, shapes, marks-N, erase-set, action-01, canary-01                        |
| `test_fixtures.py` | Tests                                                                             |
