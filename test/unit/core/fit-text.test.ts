import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COLLISION_LEADING,
  FIT_DEFAULTS,
  HARMONISE,
  LINE_HEIGHT_PROBES,
  MALI_METRICS,
  PATRICK_HAND_METRICS,
  breakBalanced,
  fitText,
  fontSizeLimits,
  graphemes,
  harmonise,
  layoutText,
  lineBox,
  lineHeightFromInk,
  lineWidths,
  normalizeText,
  relayout,
  splitLongToken,
  tokenize,
} from "../../../src/shared/core/fit-text.ts";
import type {
  FitOptions,
  FitResult,
  FontMetrics,
  LineFrame,
  Measure,
} from "../../../src/shared/core/fit-text.ts";
import type { Box } from "../../../src/shared/types.ts";

/** Fake font: every code point is 0.5 em wide. */
const fake: Measure = (s, px) => [...s].length * 0.5 * px;
/** Ink band = em box (ascent + descent = 1), line-height 1.25. */
const METRICS: FontMetrics = { lineHeight: 1.25, ascent: 0.8, descent: 0.2 };
const OPTS: FitOptions = { measure: fake, metrics: METRICS };
const b = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = [
  "anh",
  "em",
  "đi",
  "không",
  "người",
  "nghiêng",
  "khuỷu",
  "thuyền",
  "được",
  "ngoằn",
  "Nguyễn",
  "đã",
  "rồi",
  "chứ",
  "lỗ",
  "mẫu",
  "ặc",
  "những",
  "lợn",
  "bỗng",
];

function sentence(rand: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(SYLLABLES[Math.floor(rand() * SYLLABLES.length)] ?? "anh");
  return out.join(" ");
}

/** Chord × safety at a line box top y (recomputed from first principles). */
function chordAt(r: FitResult, y: number, o: { safety: number; metrics: FontMetrics }): number {
  const w = r.region.x2 - r.region.x1;
  const h = r.region.y2 - r.region.y1;
  const a = (w * (1 - 2 * r.inset)) / 2;
  const bb = (h * (1 - 2 * r.inset)) / 2;
  if (r.shape === "rect") return 2 * a * o.safety;
  const cy = (r.region.y1 + r.region.y2) / 2;
  const band = (o.metrics.ascent + o.metrics.descent) * r.fontPx;
  const top = y + (r.lineHeightPx - band) / 2 - cy;
  const dy = Math.max(Math.abs(top), Math.abs(top + band));
  return 2 * a * Math.sqrt(1 - (dy / bb) ** 2) * o.safety;
}

/** Invariants every result must satisfy. */
function assertValid(
  r: FitResult,
  metrics: FontMetrics = METRICS,
  safety: number = FIT_DEFAULTS.safety,
): void {
  const cx = (r.region.x1 + r.region.x2) / 2;
  const cy = (r.region.y1 + r.region.y2) / 2;
  assert.ok(Math.abs(r.lineHeightPx - metrics.lineHeight * r.fontPx) < 1e-9, "line height = lh × px");
  r.lines.forEach((line, k) => {
    assert.ok(
      line.width <= line.maxWidth + 1e-9,
      `line ${k} "${line.text}" ${line.width} ≤ ${line.maxWidth}`,
    );
    assert.ok(Math.abs(line.width - fake(line.text, r.fontPx)) < 1e-9, "width is the measure of the line");
    assert.ok(Math.abs(line.x + line.width / 2 - cx) < 1e-9, "centred horizontally");
    assert.ok(
      Math.abs(line.maxWidth - chordAt(r, line.y, { safety, metrics })) < 1e-6,
      `maxWidth of line ${k} is its chord × safety`,
    );
    const expectBaseline = line.y + r.lineHeightPx / 2 + ((metrics.ascent - metrics.descent) * r.fontPx) / 2;
    assert.ok(Math.abs(line.baseline - expectBaseline) < 1e-9, "CSS half-leading baseline");
    assert.equal(line.text, line.text.normalize("NFC"), "lines are NFC");
  });
  if (r.step !== 4 && r.lines.length > 0) {
    for (let k = 1; k < r.lines.length; k++) {
      const gap = (r.lines[k]?.y ?? 0) - (r.lines[k - 1]?.y ?? 0);
      assert.ok(Math.abs(gap - r.lineHeightPx) < 1e-9, "consecutive line boxes");
    }
    const first = r.lines[0]?.y ?? 0;
    const blockMid = first + (r.lines.length * r.lineHeightPx) / 2;
    assert.ok(Math.abs(blockMid - cy) < 1e-9, "block centred vertically");
  }
}

describe("normalizeText and tokenize", () => {
  test("NFC, white-space runs collapse, no-break spaces stay inside their token", () => {
    const nfd = "Tiếng Việt".normalize("NFD");
    assert.notEqual(nfd, "Tiếng Việt");
    assert.equal(normalizeText(`  ${nfd} \t\n  có dấu `), "Tiếng Việt có dấu");
    assert.deepEqual(tokenize("Giá 10\u00A0000 đồng"), ["Giá", "10\u00A0000", "đồng"]);
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize(" \n\t "), []);
  });

  test("closing punctuation glues to the previous token, opening punctuation to the next", () => {
    assert.deepEqual(tokenize("Sao ?"), ["Sao?"]);
    assert.deepEqual(tokenize("Cái gì ?!"), ["Cái", "gì?!"]);
    assert.deepEqual(tokenize("Ừ ..."), ["Ừ..."]);
    assert.deepEqual(tokenize("Giảm 50 % !"), ["Giảm", "50%!"]);
    assert.deepEqual(tokenize("( Anh ấy ) đến"), ["(Anh", "ấy)", "đến"]);
    assert.deepEqual(tokenize("“ Đi thôi ” , nhé"), ["“Đi", "thôi”,", "nhé"]);
    assert.deepEqual(tokenize("« Chạy » !"), ["«Chạy»!"]);
  });

  test("lone ASCII quotes open or close by parity", () => {
    assert.deepEqual(tokenize('Anh nói " Đi thôi " rồi'), ["Anh", "nói", '"Đi', 'thôi"', "rồi"]);
    assert.deepEqual(tokenize('"Ừ" " được "'), ['"Ừ"', '"được"']);
  });

  test("a closing token at the start stays with the next token (space kept); a trailing opener joins the last", () => {
    assert.deepEqual(tokenize("… thôi được"), ["… thôi", "được"]);
    assert.deepEqual(tokenize("... !"), ["... !"]);
    assert.deepEqual(tokenize("Anh nói “"), ["Anh", "nói“"]);
    assert.deepEqual(tokenize("“"), ["“"]);
  });

  test("plain Vietnamese splits exactly at spaces (a syllable is never split)", () => {
    const rand = rng(7);
    for (let i = 0; i < 50; i++) {
      const s = sentence(rand, 1 + Math.floor(rand() * 30));
      assert.deepEqual(tokenize(s), s.split(" "));
    }
  });
});

describe("splitLongToken (overflow step 2)", () => {
  test("Vietnamese syllables and short tokens come back whole", () => {
    for (const t of ["nghiêng", "khuỷu", "Nguyễn", "người!!", "“được”", "ặc", "!!!!!!!!!!!!!!"]) {
      assert.deepEqual(splitLongToken(t), [{ text: t, join: "space" }]);
    }
  });

  test("breaks after the token's own hyphens and slashes first", () => {
    assert.deepEqual(splitLongToken("Seo-yeon-ah-ssi"), [
      { text: "Seo-", join: "space" },
      { text: "yeon-", join: "break" },
      { text: "ah-", join: "break" },
      { text: "ssi", join: "break" },
    ]);
    assert.deepEqual(
      splitLongToken("trước/sau/giữa").map((p) => p.text),
      ["trước/", "sau/", "giữa"],
    );
  });

  test("a part that is still too long breaks between letters, ≥ 2 letters per side", () => {
    const token = "Aaaaaaaaaargh!!";
    const pieces = splitLongToken(token);
    assert.equal(pieces.map((p) => p.text).join(""), token);
    assert.equal(pieces[0]?.join, "space");
    assert.ok(pieces.slice(1).every((p) => p.join === "hyphen"));
    assert.ok((pieces[0]?.text.length ?? 0) >= 2, "at least 2 letters before the first break");
    assert.ok((pieces.at(-1)?.text ?? "").startsWith("gh"), "at least 2 letters after the last break");
  });

  test("without letter breaks (step 0) only the token's own separators break", () => {
    assert.deepEqual(splitLongToken("Aaaaaaaaaargh!!", 9, false), [
      { text: "Aaaaaaaaaargh!!", join: "space" },
    ]);
    assert.deepEqual(
      splitLongToken("tài-khoản-bí-mật-số-một", 9, false).map((p) => [p.text, p.join]),
      [
        ["tài-", "space"],
        ["khoản-", "break"],
        ["bí-", "break"],
        ["mật-", "break"],
        ["số-", "break"],
        ["một", "break"],
      ],
    );
  });

  test("combining marks stay with their letter (graphemes)", () => {
    const token = "Ồooooooooooo".normalize("NFD");
    const pieces = splitLongToken(token);
    assert.ok(pieces.length > 1);
    assert.equal(pieces.map((p) => p.text).join(""), token);
    for (const p of pieces) assert.ok(!/^\p{M}/u.test(p.text), `"${p.text}" starts with a mark`);
    assert.equal(graphemes("Ồo".normalize("NFD")).length, 2);
  });
});

describe("lineWidths", () => {
  const frame: LineFrame = { a: 100, b: 50, shape: "ellipse", safety: 0.97, metrics: METRICS };

  test("an ellipse gives narrower lines at the top and bottom, symmetric", () => {
    const w = lineWidths(5, 12, frame);
    assert.ok(w !== null);
    assert.equal(w.length, 5);
    const [w0, w1, w2, w3, w4] = w as [number, number, number, number, number];
    assert.ok(w0 < w1 && w1 < w2, "widening towards the middle");
    assert.ok(w2 > w3 && w3 > w4, "narrowing towards the bottom");
    assert.ok(Math.abs(w0 - w4) < 1e-9 && Math.abs(w1 - w3) < 1e-9, "symmetric");
    assert.ok(w2 < 2 * frame.a * frame.safety);
  });

  test("the chord is taken at the band edge farthest from the centre", () => {
    // One line: band [-6, 6] → dy = 6. Two lines of L = 15: bands [-13.5, -1.5] and [1.5, 13.5] → dy = 13.5.
    const one = lineWidths(1, 12, frame);
    assert.ok(one !== null);
    assert.ok(Math.abs((one[0] ?? 0) - 200 * Math.sqrt(1 - (6 / 50) ** 2) * 0.97) < 1e-9);
    const two = lineWidths(2, 12, frame);
    assert.ok(two !== null);
    assert.ok(Math.abs((two[0] ?? 0) - 200 * Math.sqrt(1 - (13.5 / 50) ** 2) * 0.97) < 1e-9);
    // A taller ink band (ascent + descent 1.354 em) narrows the same lines.
    const tall = lineWidths(2, 12, { ...frame, metrics: PATRICK_HAND_METRICS });
    assert.ok(tall !== null && (tall[0] ?? 0) < (two[0] ?? 0));
  });

  test("pixelSnap reproduces Chrome's line box: whole-px ascent/descent, floored half-leading", () => {
    const metrics: FontMetrics = { lineHeight: 1.38, ascent: 1.042, descent: 0.312, pixelSnap: true };
    const f: LineFrame = { ...frame, metrics };
    // 11.25 px (values read back from Chrome 154 in RND-02): L = 1.38 × 11.25 = 15.525 → 994/64 = 15.53125 px;
    // ascent round(11.72) = 12, descent round(3.51) = 4 → content area 16 px, starting floor(−0.234) = −1 px from
    // the line top: band [−8.765625, 7.234375] around the centre of a one-line block.
    const one = lineWidths(1, 11.25, f);
    assert.ok(one !== null);
    assert.ok(Math.abs((one[0] ?? 0) - 200 * Math.sqrt(1 - (8.765625 / 50) ** 2) * 0.97) < 1e-9);
    // 14 px: L = 1236/64 = 19.3125, ascent 15 + descent 4 = 19 → offset floor(0.156) = 0: band [−9.65625, 9.34375].
    const two = lineWidths(1, 14, f);
    assert.ok(two !== null);
    assert.ok(Math.abs((two[0] ?? 0) - 200 * Math.sqrt(1 - (9.65625 / 50) ** 2) * 0.97) < 1e-9);
    const r = fitText("Ước gì được nghỉ học một bữa!", b(0, 0, 150, 100), { measure: fake, metrics });
    assert.equal(r.lineHeightPx * 64, Math.round(r.lineHeightPx * 64), "line-height on the 1/64 px grid");
    for (const line of r.lines) {
      const ascent = Math.round(1.042 * r.fontPx);
      const band = ascent + Math.round(0.312 * r.fontPx);
      const off = Math.floor(Math.trunc(Math.round((r.lineHeightPx - band) * 64) / 2) / 64);
      assert.ok(Math.abs(line.baseline - (line.y + off + ascent)) < 1e-9, "baseline = top + offset + ascent");
    }
  });

  test("pixelSnap at a layout zoom: Chrome 154's line boxes at 110%, 125% and 150% (read back in RND-02)", () => {
    // [zoom, px, content top, content height] for Patrick Hand at line-height 1.428 (Range rect / zoom, CSS px).
    // Chrome lays the line out in device px: e.g. 125% at 14 px is 17.5 px with ascent 18 + descent 5 = 23 device
    // px = 18.4 CSS px, where a CSS-px model says 15 + 4 = 19.
    const chrome: Array<[number, number, number, number]> = [
      [1.25, 11, 0, 14.4],
      [1.25, 14, 0, 18.4],
      [1.25, 20.5, 0, 28],
      [1.25, 24.25, 0.8, 32.8],
      [1.25, 30, 0.8, 40.8],
      [1.5, 14, 0, 19.3333],
      [1.5, 15.5, 0.6667, 20.6667],
      [1.5, 24.25, 0.6667, 32.6667],
      [1.5, 30, 0.6667, 40.6667],
      // 22.25 × 1.1 = 24.475 px, which Chrome's font cache cuts to 24.47: ascent 25 (not 26) + descent 8.
      [1.1, 22.25, 0, 30],
      [1, 20.5, 1, 27],
    ];
    for (const [zoom, px, top, height] of chrome) {
      const m = lineBox(px, PATRICK_HAND_METRICS, zoom);
      assert.ok(Math.abs(m.contentTop - top) < 0.001, `${zoom}/${px}: top ${m.contentTop} vs Chrome ${top}`);
      assert.ok(Math.abs(m.contentHeight - height) < 0.001, `${zoom}/${px}: ${m.contentHeight} vs ${height}`);
      assert.equal(m.lineHeight, Math.round(PATRICK_HAND_METRICS.lineHeight * px * 64) / 64);
      if (zoom === 1.25 || zoom === 1.5) {
        const css = lineBox(px, PATRICK_HAND_METRICS);
        const off = Math.max(Math.abs(css.contentTop - top), Math.abs(css.contentHeight - height));
        assert.ok(off > 0.3, `${zoom}/${px}: the CSS-px model misses Chrome's line box (${off} px)`);
      }
    }
    // Mali at 110%: 17.75 × 1.1 → 19.52 px: ascent 20 + descent 5 = 25 device px, 1 device px below the line top.
    const mali = lineBox(17.75, MALI_METRICS, 1.1);
    assert.ok(Math.abs(mali.contentTop - 1 / 1.1) < 1e-9 && Math.abs(mali.contentHeight - 25 / 1.1) < 1e-9);
    // Off-grid size at 100%: 16.8 px is cached as 16.79 px, so the ascent is round(17.495) = 17 (Chrome: 17).
    const odd = lineBox(16.8, PATRICK_HAND_METRICS);
    assert.equal(odd.baseline - odd.contentTop, 17);
    assert.equal(odd.contentHeight, 22);
  });

  test("zoom validation: lineWidths gives null, fitText and lineBox throw", () => {
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(lineWidths(1, 12, { ...frame, metrics: PATRICK_HAND_METRICS, zoom }), null);
      assert.throws(() => fitText("Chào", b(0, 0, 100, 60), { ...OPTS, zoom }), RangeError);
      assert.throws(() => lineBox(14, PATRICK_HAND_METRICS, zoom), RangeError);
    }
  });

  test("a rect gives every line the full inner width", () => {
    assert.deepEqual(lineWidths(3, 10, { ...frame, shape: "rect" }), [194, 194, 194]);
  });

  test("infeasible when the block is taller than 2b or a band reaches b", () => {
    assert.equal(lineWidths(7, 12, frame), null, "7 × 15 = 105 > 100");
    assert.notEqual(lineWidths(6, 12, { ...frame, shape: "rect" }), null, "6 × 15 = 90 ≤ 100");
    assert.equal(lineWidths(1, 100, frame), null, "band of 100 px in b = 50");
    assert.equal(lineWidths(0, 12, frame), null);
    assert.equal(lineWidths(1, 12, { ...frame, a: 0 }), null);
  });
});

describe("breakBalanced (DP)", () => {
  test("balances lines instead of filling the first one greedily", () => {
    // Greedy would put 5 tokens on line 1 (58 ≤ 60) and 1 on line 2; the DP splits 3 + 3.
    assert.deepEqual(breakBalanced([10, 10, 10, 10, 10, 10], 2, [60, 60]), [
      [0, 3, 34],
      [3, 6, 34],
    ]);
  });

  test("the widest line takes the most text", () => {
    const lines = breakBalanced([10, 10, 10, 10, 10, 10, 10], 2, [40, 80, 40]);
    assert.ok(lines !== null);
    const counts = lines.map(([i, j]) => j - i);
    assert.ok((counts[1] ?? 0) > (counts[0] ?? 0) && (counts[1] ?? 0) > (counts[2] ?? 0), `${counts.join()}`);
  });

  test("null when a token is wider than its line or there are fewer tokens than lines", () => {
    assert.equal(breakBalanced([10, 50, 10], 2, [40, 40]), null);
    assert.equal(breakBalanced([10, 10], 2, [40, 40, 40]), null);
  });

  test("matches a brute-force optimum of Σ(1 − W/width)² on random inputs", () => {
    const rand = rng(42);
    for (let round = 0; round < 300; round++) {
      const count = 1 + Math.floor(rand() * 9);
      const n = 1 + Math.floor(rand() * Math.min(4, count));
      const tw = Array.from({ length: count }, () => 5 + Math.floor(rand() * 30));
      const sw = 3;
      const widths = Array.from({ length: n }, () => 30 + Math.floor(rand() * 90));
      const width = (i: number, j: number): number =>
        tw.slice(i, j).reduce((s, x) => s + x, 0) + sw * (j - i - 1);
      let best = Infinity;
      const rec = (start: number, l: number, cost: number): void => {
        const limit = widths[l] ?? 0;
        if (l === n - 1) {
          const w = width(start, count);
          if (w <= limit) best = Math.min(best, cost + (1 - w / limit) ** 2);
          return;
        }
        for (let end = start + 1; end <= count - (n - 1 - l); end++) {
          const w = width(start, end);
          if (w > limit) break;
          rec(end, l + 1, cost + (1 - w / limit) ** 2);
        }
      };
      rec(0, 0, 0);
      const got = breakBalanced(tw, sw, widths);
      if (best === Infinity) {
        assert.equal(got, null, `round ${round}: brute force found no layout`);
        continue;
      }
      assert.ok(got !== null, `round ${round}: DP found no layout`);
      assert.equal(got.length, n);
      const cost = got.reduce((s, [i, j, w], l) => {
        assert.ok(j > i, "non-empty line");
        assert.ok(Math.abs(w - width(i, j)) < 1e-9);
        return s + (1 - w / (widths[l] ?? 1)) ** 2;
      }, 0);
      assert.ok(Math.abs(cost - best) < 1e-9, `round ${round}: DP cost ${cost} vs optimum ${best}`);
    }
  });
});

describe("fitText", () => {
  const region = b(10, 20, 230, 160);

  test("a short word in a large region is set at maxPx", () => {
    const r = fitText("Chào", region, OPTS);
    assert.equal(r.fontPx, FIT_DEFAULTS.maxPx);
    assert.equal(r.lines.length, 1);
    assert.equal(r.step, 0);
    assert.equal(r.overflow, false);
    assertValid(r);
  });

  test("lines respect the chord at their position: narrower at the top and bottom of an ellipse", () => {
    const r = fitText(
      "Mình đã đợi cậu ở đây gần một tiếng đồng hồ rồi đấy, sao bây giờ mới tới vậy hả?",
      region,
      OPTS,
    );
    assert.equal(r.step, 0);
    assert.ok(r.lines.length >= 3, `${r.lines.length} lines`);
    assertValid(r);
    const max = r.lines.map((l) => l.maxWidth);
    const mid = Math.floor(max.length / 2);
    assert.ok((max[0] ?? 0) < (max[mid] ?? 0) && (max.at(-1) ?? 0) < (max[mid] ?? 0));
  });

  test("lines are whole tokens in order: punctuation stays glued, no syllable is split", () => {
    const rand = rng(3);
    const regions = [b(0, 0, 150, 100), b(0, 0, 220, 140), b(0, 0, 300, 120), b(0, 0, 120, 260)];
    for (let i = 0; i < 120; i++) {
      const text = `${sentence(rand, 1 + Math.floor(rand() * 40))} ?`;
      const reg = regions[i % regions.length] ?? region;
      const r = fitText(text, reg, { ...OPTS, shape: i % 4 === 3 ? "rect" : "ellipse" });
      assertValid(r);
      if (r.overflow) continue;
      assert.equal(r.lines.map((l) => l.text).join(" "), tokenize(text).join(" "));
      assert.ok(
        r.lines.every((l) => !l.text.startsWith("?")),
        "the question mark never starts a line",
      );
    }
  });

  test("binary search: the largest feasible size on the grid, and every smaller one fits", () => {
    const rand = rng(11);
    for (let i = 0; i < 40; i++) {
      const text = sentence(rand, 2 + Math.floor(rand() * 25));
      const reg = b(0, 0, 120 + Math.floor(rand() * 200), 60 + Math.floor(rand() * 150));
      const opts: FitOptions = { ...OPTS, maxPx: 30 };
      const r = fitText(text, reg, opts);
      if (r.step !== 0) continue;
      const step = FIT_DEFAULTS.stepPx;
      assert.ok(r.fontPx === FIT_DEFAULTS.minPx || Number.isInteger(r.fontPx / step), "on the grid");
      for (let px = Math.floor(r.fontPx / step + 1) * step; px <= 30; px += step) {
        assert.equal(layoutText(text, reg, px, opts), null, `${px} px should not fit (${r.fontPx} chosen)`);
      }
      for (let px = r.fontPx; px >= FIT_DEFAULTS.minPx; px -= 1) {
        assert.notEqual(layoutText(text, reg, px, opts), null, `${px} px should fit (monotone)`);
      }
      assert.deepEqual(layoutText(text, reg, r.fontPx, opts)?.lines, r.lines, "same layout at that size");
    }
  });

  test("font size never grows with longer text and never shrinks with a larger region", () => {
    const words = sentence(rng(5), 40).split(" ");
    let prev = Infinity;
    for (let k = 1; k <= words.length; k++) {
      const r = fitText(words.slice(0, k).join(" "), region, OPTS);
      assert.ok(r.fontPx <= prev + 1e-9, `${k} words: ${r.fontPx} > ${prev}`);
      prev = r.fontPx;
    }
    const text = words.slice(0, 15).join(" ");
    let last = 0;
    for (let w = 80; w <= 400; w += 20) {
      const r = fitText(text, b(0, 0, w, w * 0.6), OPTS);
      assert.ok(r.fontPx >= last - 1e-9, `${w}: ${r.fontPx} < ${last}`);
      last = r.fontPx;
    }
  });

  test("at the chosen size no layout with fewer lines exists", () => {
    const text = "Đừng lo, mọi chuyện rồi sẽ ổn thôi mà, cứ tin mình đi nhé!";
    const r = fitText(text, region, OPTS);
    const tw = tokenize(text).map((t) => fake(t, r.fontPx));
    const a = ((region.x2 - region.x1) * (1 - 2 * FIT_DEFAULTS.inset)) / 2;
    const bb = ((region.y2 - region.y1) * (1 - 2 * FIT_DEFAULTS.inset)) / 2;
    for (let n = 1; n < r.lines.length; n++) {
      const widths = lineWidths(n, r.fontPx, {
        a,
        b: bb,
        shape: "ellipse",
        safety: FIT_DEFAULTS.safety,
        metrics: METRICS,
      });
      if (widths !== null) assert.equal(breakBalanced(tw, fake(" ", r.fontPx), widths), null);
    }
  });

  test("pixelSnap + zoom: every line's content area (Chrome's device-px box) stays inside the target", () => {
    /** How far (px) the farthest content-area corner of r's lines leaves r's target when Chrome renders at zoom. */
    const excess = (r: FitResult, zoom: number): number => {
      const box = lineBox(r.fontPx, PATRICK_HAND_METRICS, zoom);
      const cx = (r.region.x1 + r.region.x2) / 2;
      const cy = (r.region.y1 + r.region.y2) / 2;
      const a = ((r.region.x2 - r.region.x1) * (1 - 2 * r.inset)) / 2;
      const bb = ((r.region.y2 - r.region.y1) * (1 - 2 * r.inset)) / 2;
      let worst = -Infinity;
      for (const l of r.lines) {
        for (const x of [l.x, l.x + l.width]) {
          for (const y of [l.y + box.contentTop, l.y + box.contentTop + box.contentHeight]) {
            const dx = Math.abs(x - cx);
            const dy = Math.abs(y - cy);
            const e =
              r.shape === "rect"
                ? Math.max(dx - a, dy - bb)
                : dy >= bb
                  ? dy - bb + dx
                  : dx - a * Math.sqrt(1 - (dy / bb) ** 2);
            worst = Math.max(worst, e);
          }
        }
      }
      return worst;
    };
    const rand = rng(23);
    const regions = [
      b(12.5, 8.25, 162.5, 108.25),
      b(3, 7, 223, 147),
      b(0, 0.5, 300, 120.5),
      b(1, 1, 121, 261),
    ];
    for (const zoom of [0.9, 1.1, 1.25, 1.5]) {
      let unaware = 0;
      for (let i = 0; i < 160; i++) {
        const text = sentence(rand, 1 + Math.floor(rand() * 45));
        const reg = regions[i % regions.length] ?? region;
        const opts: FitOptions = {
          measure: fake,
          metrics: PATRICK_HAND_METRICS,
          shape: i % 4 === 3 ? "rect" : "ellipse",
          maxPx: 30,
        };
        const r = fitText(text, reg, { ...opts, zoom });
        assert.ok(excess(r, zoom) <= 1e-9, `zoom ${zoom} "${text}": ${excess(r, zoom)} px outside`);
        assert.equal(r.lineHeightPx, lineBox(r.fontPx, PATRICK_HAND_METRICS, zoom).lineHeight);
        for (const l of r.lines) {
          const box = lineBox(r.fontPx, PATRICK_HAND_METRICS, zoom);
          assert.ok(Math.abs(l.baseline - (l.y + box.baseline)) < 1e-9, "baseline from the zoomed line box");
        }
        if (excess(fitText(text, reg, opts), zoom) > 1e-9) unaware++;
      }
      assert.ok(
        unaware > 0,
        `zoom ${zoom}: layouts made without the zoom leave Chrome's target (${unaware})`,
      );
    }
    const text = "Mình nghĩ là chúng ta nên nghỉ một chút trước khi đi tiếp.";
    const ph: FitOptions = { measure: fake, metrics: PATRICK_HAND_METRICS };
    assert.deepEqual(
      fitText(text, region, { ...ph, zoom: 1 }),
      fitText(text, region, ph),
      "zoom 1 is the default",
    );
  });

  test("NFD input gives the same result as NFC input", () => {
    const text = "Ối giời ơi, cái lỗ hổng này to quá! Mẫu thử đâu rồi? Ặc… những thứ đó đã hỏng hết.";
    const nfd = text.normalize("NFD");
    assert.notEqual(nfd, text);
    const a = fitText(nfd, region, OPTS);
    assert.deepEqual(a, fitText(text, region, OPTS));
    assert.equal(a.text, text);
    assertValid(a);
  });

  test("deterministic and side-effect free", () => {
    const text = "Hôm nay trời đẹp quá, mình đi dạo một vòng quanh hồ nhé?";
    const opts: FitOptions = { ...OPTS, shape: "rect" };
    assert.deepEqual(fitText(text, region, opts), fitText(text, region, opts));
  });

  test("the measure is called with the size being tried", () => {
    const sizes = new Set<number>();
    fitText("Một hai ba bốn năm sáu bảy tám", region, {
      ...OPTS,
      measure: (s, px) => {
        sizes.add(px);
        return fake(s, px);
      },
    });
    assert.ok(
      sizes.size > 2 && [...sizes].every((px) => px >= FIT_DEFAULTS.minPx && px <= FIT_DEFAULTS.maxPx),
    );
  });

  test("empty text gives no lines; a degenerate region overflows without throwing", () => {
    const empty = fitText("  \n ", region, OPTS);
    assert.deepEqual([empty.lines.length, empty.fontPx, empty.overflow], [0, 0, false]);
    const flat = fitText("Xin chào", b(5, 5, 5, 40), OPTS);
    assert.equal(flat.overflow, true);
    assert.equal(flat.lines.length, 0);
  });

  test("rejects a non-positive minPx, stepPx, line-height or ink band", () => {
    assert.throws(() => fitText("a", region, { ...OPTS, minPx: 0 }), RangeError);
    assert.throws(() => fitText("a", region, { ...OPTS, stepPx: 0 }), RangeError);
    assert.throws(
      () => fitText("a", region, { ...OPTS, metrics: { ...METRICS, lineHeight: 0 } }),
      RangeError,
    );
    assert.throws(
      () => fitText("a", region, { ...OPTS, metrics: { lineHeight: 1.3, ascent: 0, descent: 0 } }),
      RangeError,
    );
  });
});

describe("overflow chain", () => {
  test("step 1: the same ellipse loosened to inset 0 when the asked one cannot hold the text at minPx", () => {
    // 100×40 at 11 px: two lines of ≤ 10 chars at inset 0.07, ≤ 13 chars at inset 0.
    const r = fitText("aaaa bbbb ccc ddd eee", b(0, 0, 100, 40), OPTS);
    assert.deepEqual([r.step, r.shape, r.inset, r.overflow], [1, "ellipse", 0, false]);
    assert.equal(r.fontPx, FIT_DEFAULTS.minPx);
    assertValid(r);
  });

  test("step 1 for a rect region loosens its inset to 0.04", () => {
    const r = fitText("aaaa bbbb cccc ddd eeee", b(0, 0, 100, 30), { ...OPTS, shape: "rect" });
    assert.deepEqual([r.step, r.shape, r.inset], [1, "rect", 0.04]);
    assertValid(r);
  });

  test("ellipseToRect reproduces B.9.2's rect step; the ellipsis step still keeps the asked ellipse", () => {
    const opts: FitOptions = { ...OPTS, chain: { ellipseToRect: true } };
    const r = fitText("aaaa bbbb cccc dddd eeee", b(0, 0, 100, 40), opts);
    assert.deepEqual([r.step, r.shape, r.inset], [1, "rect", 0.04]);
    assertValid(r);
    const cut = fitText(sentence(rng(4), 40), b(0, 0, 100, 40), opts);
    assert.deepEqual([cut.step, cut.shape, cut.inset], [4, "ellipse", FIT_DEFAULTS.inset]);
  });

  test("the default chain keeps every line inside the region's ellipse; B.9.2's rect step does not", () => {
    /** Largest corner excess (px) of r's content areas over the ellipse inscribed in `reg` (inset 0). */
    const outside = (r: FitResult, reg: Box): number => {
      const box = lineBox(r.fontPx, PATRICK_HAND_METRICS);
      const cx = (reg.x1 + reg.x2) / 2;
      const cy = (reg.y1 + reg.y2) / 2;
      const a = (reg.x2 - reg.x1) / 2;
      const bb = (reg.y2 - reg.y1) / 2;
      let worst = -Infinity;
      for (const l of r.lines) {
        for (const x of [l.x, l.x + l.width]) {
          for (const y of [l.y + box.contentTop, l.y + box.contentTop + box.contentHeight]) {
            worst = Math.max(worst, Math.hypot((x - cx) / a, (y - cy) / bb) - 1);
          }
        }
      }
      return worst;
    };
    const rand = rng(31);
    const reg = b(0, 0, 150, 100);
    const ph: FitOptions = { measure: fake, metrics: PATRICK_HAND_METRICS, maxPx: 30 };
    let fallbacks = 0;
    let rectOut = 0;
    for (let i = 0; i < 60; i++) {
      // 15-25 syllables: too long for step 0 in this bubble, mostly short enough for step 1.
      const text = sentence(rand, 15 + Math.floor(rand() * 11));
      const r = fitText(text, reg, ph);
      assert.ok(outside(r, reg) <= 1e-9, `default chain, step ${r.step}: ${outside(r, reg)}`);
      const old = fitText(text, reg, { ...ph, chain: { ellipseToRect: true, fullSearch: true } });
      if (old.step === 1) {
        fallbacks++;
        assert.equal(old.shape, "rect");
        if (outside(old, reg) > 1e-9) rectOut++;
      }
    }
    assert.ok(fallbacks > 5, `${fallbacks} B.9.2 rect fallbacks`);
    assert.ok(rectOut > fallbacks / 2, `${rectOut}/${fallbacks} B.9.2 rect fallbacks leave the ellipse`);
  });

  test("fallback steps stay at minPx (size continuous with step 0) unless fullSearch", () => {
    const text = "aaaa bbbb ccc ddd eee";
    const kept = fitText(text, b(0, 0, 100, 40), OPTS);
    assert.deepEqual([kept.step, kept.fontPx], [1, FIT_DEFAULTS.minPx]);
    const full = fitText(text, b(0, 0, 100, 40), { ...OPTS, chain: { fullSearch: true } });
    assert.equal(full.step, 1);
    assert.ok(full.fontPx > FIT_DEFAULTS.minPx, `${full.fontPx}`);
    assertValid(full);
  });

  test("step 2: an over-long token breaks with a hyphen; Vietnamese syllables stay whole", () => {
    const token = "Kkkkkkkkkkkkkkkkkkkkkkkkk";
    const r = fitText(`Ối ${token} nghiêng`, b(0, 0, 100, 200), { ...OPTS, shape: "rect" });
    assert.equal(r.step, 2);
    assert.equal(r.hyphenated, true);
    assert.equal(r.overflow, false);
    assertValid(r);
    const glued = r.lines.map((l) => l.text.replace(/-$/u, "")).join("");
    assert.ok(glued.includes(token), glued);
    assert.ok(r.lines.some((l) => l.text.endsWith("-")));
    assert.ok(
      r.lines.some((l) => l.text.split(" ").includes("nghiêng")),
      "the syllable is intact",
    );
  });

  test("step 3: the region grows (clipped to bounds, clear of other units) and the halo turns on", () => {
    const text = "aaaa bbbb cccc dddd eeee ffff gggg";
    const region = b(100, 100, 200, 130);
    assert.equal(fitText(text, region, OPTS).step, 4, "no bounds: straight to the ellipsis");
    const r = fitText(text, region, { ...OPTS, chain: { bounds: b(0, 0, 400, 400) } });
    assert.equal(r.step, 3);
    assert.equal(r.halo, true);
    assert.equal(r.shape, "rect");
    assert.deepEqual(r.region, b(85, 95.5, 215, 134.5));
    assertValid(r);

    // Clipped at x = 90 by the bounds and at x = 205 by a neighbouring unit: 115 px still holds 18-char lines.
    const chain = { bounds: b(90, 0, 400, 400), obstacles: [b(205, 90, 260, 140), b(0, 0, 10, 10)] };
    const clipped = fitText("aaaa bbbb cccc ddd eeee ffff ggg", region, { ...OPTS, chain });
    assert.equal(clipped.step, 3);
    assert.deepEqual(clipped.region, b(90, 95.5, 205, 134.5));
    assertValid(clipped);
    const cut = fitText(text, region, { ...OPTS, chain });
    assert.deepEqual(
      [cut.step, cut.region, cut.halo],
      [4, region, false],
      "the ellipsis step keeps the region",
    );
  });

  test("tall narrow regions may widen 30% per side", () => {
    const text = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo";
    const r = fitText(text, b(100, 100, 140, 220), { ...OPTS, chain: { bounds: b(0, 0, 400, 400) } });
    assert.ok(r.step >= 3);
    assert.deepEqual([r.region.x1, r.region.x2, r.region.y1, r.region.y2], [88, 152, 82, 238]);
  });

  test("a long token breaks after its own hyphens already at step 0 (no size drop, no added hyphen)", () => {
    const text = "Cậu đã đọc tin nhắn từ tài-khoản-bí-mật-số-một chưa?";
    const r = fitText(text, b(0, 0, 120, 260), { ...OPTS, shape: "rect", maxPx: 30 });
    assert.equal(r.step, 0);
    assert.equal(r.hyphenated, true);
    assert.ok(r.fontPx > FIT_DEFAULTS.minPx + 4, `${r.fontPx} px`);
    assert.ok(r.lines.every((l) => !l.text.endsWith("--")));
    assert.equal(
      r.lines
        .map((l) => l.text)
        .join(" ")
        .replace(/- /gu, "-"),
      normalizeText(text),
    );
    assertValid(r);
  });

  test("step 4: minPx, as many lines as fit, the last ending in an ellipsis; full text kept", () => {
    const text = sentence(rng(9), 60);
    const r = fitText(text, b(0, 0, 150, 60), OPTS);
    assert.equal(r.step, 4);
    assert.equal(r.overflow, true);
    assert.deepEqual(
      [r.shape, r.inset, r.halo],
      ["ellipse", FIT_DEFAULTS.ellipseInset, false],
      "the loosest ellipse, never a rect",
    );
    assert.equal(r.fontPx, FIT_DEFAULTS.minPx);
    assert.equal(r.text, text);
    assert.ok(r.lines.length >= 2);
    assert.ok((r.lines.at(-1)?.text ?? "").endsWith(FIT_DEFAULTS.ellipsis));
    for (const l of r.lines) assert.ok(l.width <= l.maxWidth + 1e-9);
    const shown = r.lines
      .map((l) => l.text)
      .join(" ")
      .slice(0, -1);
    assert.ok(text.startsWith(shown.replace(/[,;:.]+$/u, "")), `"${shown}" is a prefix`);
  });

  test("step 4 skips a top line too narrow for the first token and keeps the text whole when it then fits", () => {
    // 120×50 ellipse at 11 px: 3 slots of [44.6, 96.8, 44.6] px; no balanced 1-3 line layout exists (the first
    // token is 9 chars = 49.5 px; two lines hold 14 chars each), but slots 2 and 3 take everything.
    const r = fitText("aaaaaaaaa bbbbbbb ccccccc", b(0, 0, 120, 50), { ...OPTS, chain: false });
    assert.equal(r.step, 4);
    assert.equal(r.overflow, false);
    assert.deepEqual(
      r.lines.map((l) => l.text),
      ["aaaaaaaaa bbbbbbb", "ccccccc"],
    );
    const top = 25 - (3 * r.lineHeightPx) / 2;
    assert.ok(Math.abs((r.lines[0]?.y ?? 0) - (top + r.lineHeightPx)) < 1e-9, "slot 1, slot 0 left empty");
    for (const l of r.lines) assert.ok(l.width <= l.maxWidth);
  });

  test("chain: false goes straight from step 0 to the ellipsis", () => {
    const r = fitText("aaaa bbbb cccc dddd eeee", b(0, 0, 100, 40), { ...OPTS, chain: false });
    assert.equal(r.step, 4);
    assert.equal(r.overflow, true);
    assert.equal(r.shape, "ellipse");
  });

  test("a single token too long even for one line is cut at a grapheme before the ellipsis", () => {
    const r = fitText("Ặcccccccccccccccccccc", b(0, 0, 60, 30), { ...OPTS, chain: false });
    assert.equal(r.step, 4);
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0]?.text ?? "", /^Ặc+…$/u);
  });
});

describe("relayout and harmonise", () => {
  const regionA = b(0, 0, 220, 140);

  test("relayout keeps the region and shape at a new size", () => {
    const r = fitText("Chạy mau lên!", regionA, OPTS);
    const smaller = relayout(r, r.fontPx - 5, OPTS);
    assert.ok(smaller !== null);
    assert.equal(smaller.fontPx, r.fontPx - 5);
    assert.deepEqual([smaller.region, smaller.shape, smaller.step], [r.region, r.shape, r.step]);
    assertValid(smaller);
    assert.equal(relayout(r, 500, OPTS), null);
  });

  test("relayout after step 2 keeps the broken long token", () => {
    const opts: FitOptions = { ...OPTS, shape: "rect" };
    const r = fitText("Ối Kkkkkkkkkkkkkkkkkkkkkkkkk nghiêng", b(0, 0, 100, 200), opts);
    assert.equal(r.step, 2);
    const again = relayout(r, r.fontPx, opts);
    assert.ok(again !== null);
    assert.deepEqual(
      again.lines.map((l) => l.text),
      r.lines.map((l) => l.text),
    );
    assert.equal(relayout(fitText("  ", regionA, OPTS), 12, OPTS), null, "nothing to lay out");
  });

  test("units at ≥ 0.85 × basePx are capped at 1.1 × basePx; others stay", () => {
    const opts: FitOptions = { ...OPTS, maxPx: 60 };
    const big = fitText("Ừ", b(0, 0, 400, 300), opts);
    const mid = fitText("Ừ, mình biết rồi.", b(0, 0, 220, 140), opts);
    const small = fitText(sentence(rng(2), 30), b(0, 0, 150, 100), opts);
    const items = [
      { result: big, basis: true },
      { result: mid, basis: true },
      { result: small, basis: true },
      { result: mid, basis: false },
    ];
    const sizes = [big.fontPx, mid.fontPx, small.fontPx].sort((p, q) => p - q);
    const basePx = sizes[Math.ceil(HARMONISE.percentile * sizes.length) - 1] ?? 0;
    const out = harmonise(items, opts);
    assert.equal(out.length, 4);
    for (const [k, r] of out.entries()) {
      const before = items[k]?.result as FitResult;
      if (before.fontPx >= HARMONISE.floor * basePx) {
        assert.ok(Math.abs(r.fontPx - Math.min(before.fontPx, HARMONISE.cap * basePx)) < 1e-9, `item ${k}`);
      } else {
        assert.equal(r, before, `item ${k} untouched`);
      }
      assertValid(r);
    }
    assert.ok((out[0]?.fontPx ?? 0) < big.fontPx, "the oversized unit shrank");
    assert.deepEqual(harmonise([{ result: big, basis: false }], opts), [big], "no basis units: unchanged");
  });
});

describe("size policy and line-height", () => {
  test("11 CSS px floor, 30 CSS px and 1.15 × glyph ceiling, in natural px", () => {
    assert.deepEqual(fontSizeLimits(1, null), { minPx: 11, maxPx: 30 });
    assert.deepEqual(fontSizeLimits(0.5, 20), { minPx: 22, maxPx: 23 });
    assert.deepEqual(fontSizeLimits(0.5, 100), { minPx: 22, maxPx: 60 });
    assert.deepEqual(fontSizeLimits(2, 4), { minPx: 5.5, maxPx: 5.5 });
    assert.deepEqual(fontSizeLimits(0, null), { minPx: 11, maxPx: 30 });
  });

  test("line-height = ink ascent + descent + 0.05, clamped to [1.25, 1.45], +0.05 upper case", () => {
    assert.ok(Math.abs(lineHeightFromInk(1.0, 0.3) - 1.35) < 1e-12);
    assert.equal(lineHeightFromInk(0.8, 0.2), 1.25);
    assert.equal(lineHeightFromInk(1.3, 0.4), 1.45);
    assert.ok(Math.abs(lineHeightFromInk(1.0, 0.3, true) - 1.4) < 1e-12);
    assert.ok(LINE_HEIGHT_PROBES.ascent.includes("Ỗ") && LINE_HEIGHT_PROBES.descent.includes("ậ"));
  });

  test("font constants = RND-02 ink measurements + collision leading, Chrome line model on", () => {
    // Ink at 1000 px in Chrome 154: Patrick Hand 1015.625 + 312.5, Mali 1109.375 + 265.625.
    const patrick = lineHeightFromInk(1.015625, 0.3125) + COLLISION_LEADING;
    const mali = lineHeightFromInk(1.109375, 0.265625) + COLLISION_LEADING;
    assert.ok(Math.abs(PATRICK_HAND_METRICS.lineHeight - patrick) < 0.001, `${patrick}`);
    assert.ok(Math.abs(MALI_METRICS.lineHeight - mali) < 0.001, `${mali}`);
    assert.equal(PATRICK_HAND_METRICS.pixelSnap, true);
    assert.equal(MALI_METRICS.pixelSnap, true);
  });
});
