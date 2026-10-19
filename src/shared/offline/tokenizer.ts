// Hugging Face tokenizer.json, the subset Marian (Opus-MT) and NLLB-200 use, without any dependency. PURE.
//
// Pipeline: normalizer → pre-tokenizer → model, as in the `tokenizers` library:
// - normalizers: Precompiled (SentencePiece's compiled character map, a double-array trie over UTF-8 bytes applied
//   per grapheme; without a map it is a no-op), Replace (string or regex), NFC/NFKC, Lowercase, Strip, Sequence;
// - pre-tokenizers: WhitespaceSplit, Metaspace (spaces → "▁", prefix "▁" per split, split before every "▁"),
//   Sequence;
// - models: Unigram (Viterbi over the vocabulary's log probabilities; characters no piece covers become the unknown
//   token, consecutive unknowns fused) and BPE (merges by rank inside each pre-token, unknown characters fused);
// - decoder: Metaspace ("▁" → space, the first one dropped), then the usual clean-up of spaces before punctuation.
// Post-processing (special tokens around the ids) is the caller's job: Marian appends </s>; NLLB puts the source
// language code first and </s> last. Special and added tokens never match raw text, so OCR output cannot inject
// control tokens. Marian exports name a wrong unk_id (the id of "."), so "<unk>" wins when the vocabulary has it.

export interface Tokenizer {
  /** Ids of the text's pieces, without special tokens. */
  encode(text: string): number[];
  /** The pieces for the text (debugging and tests). */
  tokenize(text: string): string[];
  /** Text of the ids; special tokens are skipped. */
  decode(ids: readonly number[]): string;
  tokenToId(token: string): number | undefined;
  idToToken(id: number): string | undefined;
  readonly unkId: number;
  readonly vocabSize: number;
  /** Ids of special tokens (added tokens flagged special, e.g. </s>, <pad>, language codes). */
  readonly specialIds: ReadonlySet<number>;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(what: string): never {
  throw new Error(`tokenizer.json: ${what}`);
}

/* ------------------------------------------------------------------ normalizers */

type Normalize = (text: string) => string;

/** SentencePiece's precompiled character map (spm_precompiled): [u32 trie size][double-array trie][strings]. */
export function precompiledNormalizer(base64: string): Normalize {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length < 4) fail("precompiled charsmap too short");
  const view = new DataView(bytes.buffer);
  const trieSize = view.getUint32(0, true);
  if (trieSize % 4 !== 0 || 4 + trieSize > bytes.length) fail("precompiled charsmap trie size");
  const array = new Uint32Array(trieSize / 4);
  for (let i = 0; i < array.length; i++) array[i] = view.getUint32(4 + i * 4, true);
  const strings = bytes.subarray(4 + trieSize);
  const utf8 = new TextEncoder();
  const decoder = new TextDecoder();

  const hasLeaf = (unit: number): boolean => ((unit >>> 8) & 1) === 1;
  const value = (unit: number): number => unit & 0x7fffffff;
  const label = (unit: number): number => unit & (0x80000000 | 0xff);
  const offset = (unit: number): number => (unit >>> 10) << ((unit & (1 << 9)) >>> 6);

  /** Offset of the replacement for the shortest key that prefixes `key`, or -1. */
  const firstMatch = (key: Uint8Array): number => {
    let pos = 0;
    let unit = array[pos] ?? 0;
    pos ^= offset(unit);
    for (const c of key) {
      if (c === 0) break;
      pos ^= c;
      unit = array[pos] ?? 0;
      if (label(unit) !== c) return -1;
      pos ^= offset(unit);
      if (hasLeaf(unit)) return value(array[pos] ?? 0);
    }
    return -1;
  };

  const transform = (chunk: string): string | null => {
    const index = firstMatch(utf8.encode(chunk));
    if (index < 0 || index >= strings.length) return null;
    let end = index;
    while (end < strings.length && strings[end] !== 0) end++;
    return decoder.decode(strings.subarray(index, end));
  };

  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return (text) => {
    let out = "";
    for (const { segment } of graphemes.segment(text)) {
      if (utf8.encode(segment).length < 6) {
        const whole = transform(segment);
        if (whole !== null) {
          out += whole;
          continue;
        }
      }
      for (const char of segment) out += transform(char) ?? char;
    }
    return out;
  };
}

function normalizerOf(config: unknown): Normalize {
  if (config === null || config === undefined) return (text) => text;
  if (!isRecord(config)) fail("normalizer");
  switch (config["type"]) {
    case "Sequence": {
      const steps = (Array.isArray(config["normalizers"]) ? config["normalizers"] : []).map(normalizerOf);
      return (text) => steps.reduce((acc, step) => step(acc), text);
    }
    case "Precompiled": {
      const map = config["precompiled_charsmap"];
      return typeof map === "string" && map !== "" ? precompiledNormalizer(map) : (text) => text;
    }
    case "Replace": {
      const pattern = config["pattern"];
      const content = typeof config["content"] === "string" ? config["content"] : "";
      if (isRecord(pattern) && typeof pattern["Regex"] === "string") {
        const regex = new RegExp(pattern["Regex"], "gu");
        return (text) => text.replace(regex, content);
      }
      if (isRecord(pattern) && typeof pattern["String"] === "string") {
        const literal = pattern["String"];
        return (text) => text.split(literal).join(content);
      }
      return fail("Replace pattern");
    }
    case "NFC":
    case "NFD":
    case "NFKC":
    case "NFKD": {
      const form = config["type"];
      return (text) => text.normalize(form);
    }
    case "Lowercase":
      return (text) => text.toLowerCase();
    case "Strip": {
      const left = config["strip_left"] !== false;
      const right = config["strip_right"] !== false;
      return (text) =>
        left && right ? text.trim() : left ? text.trimStart() : right ? text.trimEnd() : text;
    }
    default:
      return fail(`unsupported normalizer ${String(config["type"])}`);
  }
}

/* ------------------------------------------------------------------ pre-tokenizers */

type PreTokenize = (pieces: string[]) => string[];

function metaspacePrepend(config: Json): "always" | "first" | "never" {
  const scheme = config["prepend_scheme"];
  if (scheme === "always" || scheme === "first" || scheme === "never") return scheme;
  return config["add_prefix_space"] === false ? "never" : "always";
}

function preTokenizerOf(config: unknown): PreTokenize {
  if (config === null || config === undefined) return (pieces) => pieces;
  if (!isRecord(config)) fail("pre_tokenizer");
  switch (config["type"]) {
    case "Sequence": {
      const steps = (Array.isArray(config["pretokenizers"]) ? config["pretokenizers"] : []).map(
        preTokenizerOf,
      );
      return (pieces) => steps.reduce((acc, step) => step(acc), pieces);
    }
    case "WhitespaceSplit":
      return (pieces) => pieces.flatMap((piece) => piece.split(/\s+/u).filter((part) => part !== ""));
    case "Metaspace": {
      const replacement = typeof config["replacement"] === "string" ? config["replacement"] : "▁";
      const prepend = metaspacePrepend(config);
      const split = config["split"] !== false;
      return (pieces) =>
        pieces.flatMap((piece, index) => {
          let text = piece.split(" ").join(replacement);
          const add = prepend === "always" || (prepend === "first" && index === 0);
          if (add && !text.startsWith(replacement)) text = replacement + text;
          if (!split) return [text];
          const out: string[] = [];
          let start = 0;
          for (let i = text.indexOf(replacement, 1); i > 0; i = text.indexOf(replacement, i + 1)) {
            out.push(text.slice(start, i));
            start = i;
          }
          out.push(text.slice(start));
          return out.filter((part) => part !== "");
        });
    }
    default:
      return fail(`unsupported pre_tokenizer ${String(config["type"])}`);
  }
}

/* ------------------------------------------------------------------ models */

interface Model {
  encodeWord(word: string): number[];
  readonly vocab: readonly string[];
  readonly unkId: number;
}

interface TrieNode {
  next: Map<string, TrieNode>;
  id: number;
}

/** Unigram (SentencePiece) model: the most probable segmentation of each pre-token. */
function unigramModel(config: Json, excluded: ReadonlySet<string>): Model {
  const raw = config["vocab"];
  if (!Array.isArray(raw)) fail("Unigram vocab");
  const vocab: string[] = [];
  const scores: number[] = [];
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "number") {
      fail("Unigram vocab entry");
    }
    vocab.push(entry[0]);
    scores.push(entry[1]);
  }
  const ids = new Map<string, number>();
  vocab.forEach((piece, id) => {
    if (!ids.has(piece)) ids.set(piece, id);
  });
  const configured = typeof config["unk_id"] === "number" ? config["unk_id"] : null;
  const unkId = ids.get("<unk>") ?? configured ?? fail("Unigram without an unknown token");
  const minScore = scores.reduce((min, score) => Math.min(min, score), Number.POSITIVE_INFINITY);
  const unkScore = minScore - 10;

  const root: TrieNode = { next: new Map(), id: -1 };
  vocab.forEach((piece, id) => {
    if (piece === "" || excluded.has(piece) || ids.get(piece) !== id) return;
    let node = root;
    for (const char of piece) {
      let child = node.next.get(char);
      if (child === undefined) {
        child = { next: new Map(), id: -1 };
        node.next.set(char, child);
      }
      node = child;
    }
    node.id = id;
  });

  return {
    vocab,
    unkId,
    encodeWord(word) {
      const chars = [...word];
      const n = chars.length;
      const best = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY);
      const backId = new Int32Array(n + 1).fill(-1);
      const backStart = new Int32Array(n + 1).fill(-1);
      best[0] = 0;
      for (let start = 0; start < n; start++) {
        const base = best[start] ?? Number.NEGATIVE_INFINITY;
        if (base === Number.NEGATIVE_INFINITY) continue;
        let node: TrieNode | undefined = root;
        let single = false;
        for (let end = start; end < n && node !== undefined; end++) {
          node = node.next.get(chars[end] ?? "");
          if (node === undefined) break;
          if (node.id < 0) continue;
          if (end === start) single = true;
          const score = base + (scores[node.id] ?? 0);
          if (score > (best[end + 1] ?? Number.NEGATIVE_INFINITY)) {
            best[end + 1] = score;
            backId[end + 1] = node.id;
            backStart[end + 1] = start;
          }
        }
        if (!single) {
          const score = base + unkScore;
          if (score > (best[start + 1] ?? Number.NEGATIVE_INFINITY)) {
            best[start + 1] = score;
            backId[start + 1] = unkId;
            backStart[start + 1] = start;
          }
        }
      }
      const out: number[] = [];
      for (let end = n; end > 0;) {
        const id = backId[end] ?? unkId;
        const start = backStart[end] ?? end - 1;
        // Consecutive unknown characters become one unknown token.
        if (!(id === unkId && out[out.length - 1] === unkId)) out.push(id);
        end = start;
      }
      return out.reverse();
    },
  };
}

/** Byte-pair encoding model with ranked merges (SentencePiece BPE as exported for NLLB). */
function bpeModel(config: Json, excluded: ReadonlySet<string>): Model {
  const rawVocab = config["vocab"];
  if (!isRecord(rawVocab)) fail("BPE vocab");
  const ids = new Map<string, number>();
  let size = 0;
  for (const [piece, id] of Object.entries(rawVocab)) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0) fail("BPE vocab id");
    if (!excluded.has(piece)) ids.set(piece, id);
    size = Math.max(size, id + 1);
  }
  const vocab: string[] = new Array<string>(size).fill("");
  for (const [piece, id] of Object.entries(rawVocab)) vocab[id as number] = piece;
  const unkToken = typeof config["unk_token"] === "string" ? config["unk_token"] : null;
  const unkId = unkToken === null ? -1 : ((rawVocab[unkToken] as number | undefined) ?? -1);
  const fuseUnk = config["fuse_unk"] === true;
  const rawMerges = config["merges"];
  if (!Array.isArray(rawMerges)) fail("BPE merges");
  /** (left id, right id) → [rank, merged id]. */
  const merges = new Map<number, [number, number]>();
  const pairKey = (a: number, b: number): number => a * size + b;
  (rawMerges as unknown[]).forEach((merge, rank) => {
    let left: string;
    let right: string;
    if (typeof merge === "string") {
      const cut = merge.indexOf(" ", 1);
      if (cut < 0) fail("BPE merge");
      left = merge.slice(0, cut);
      right = merge.slice(cut + 1);
    } else if (Array.isArray(merge) && typeof merge[0] === "string" && typeof merge[1] === "string") {
      [left, right] = [merge[0], merge[1]];
    } else {
      return fail("BPE merge");
    }
    const a = ids.get(left);
    const b = ids.get(right);
    const merged = ids.get(left + right);
    if (a === undefined || b === undefined || merged === undefined) return;
    const key = pairKey(a, b);
    if (!merges.has(key)) merges.set(key, [rank, merged]);
  });
  const cache = new Map<string, number[]>();

  return {
    vocab,
    unkId,
    encodeWord(word) {
      const cached = cache.get(word);
      if (cached !== undefined) return cached;
      let symbols: number[] = [];
      for (const char of word) {
        const id = ids.get(char);
        if (id !== undefined) symbols.push(id);
        else if (unkId >= 0 && !(fuseUnk && symbols[symbols.length - 1] === unkId)) symbols.push(unkId);
      }
      // Merge the lowest-ranked adjacent pair until none is left (leftmost first on equal ranks).
      for (;;) {
        let bestRank = Number.POSITIVE_INFINITY;
        let bestAt = -1;
        let bestId = -1;
        for (let i = 0; i + 1 < symbols.length; i++) {
          const merge = merges.get(pairKey(symbols[i] ?? 0, symbols[i + 1] ?? 0));
          if (merge !== undefined && merge[0] < bestRank) {
            bestRank = merge[0];
            bestAt = i;
            bestId = merge[1];
          }
        }
        if (bestAt < 0) break;
        const next: number[] = [];
        for (let i = 0; i < symbols.length; i++) {
          const merge =
            i + 1 < symbols.length ? merges.get(pairKey(symbols[i] ?? 0, symbols[i + 1] ?? 0)) : undefined;
          if (merge !== undefined && merge[0] === bestRank && merge[1] === bestId) {
            next.push(bestId);
            i++;
          } else {
            next.push(symbols[i] ?? 0);
          }
        }
        symbols = next;
      }
      if (cache.size > 50_000) cache.clear();
      cache.set(word, symbols);
      return symbols;
    },
  };
}

/* ------------------------------------------------------------------ decoder */

type Decode = (tokens: readonly string[]) => string;

function decoderOf(config: unknown): Decode {
  if (!isRecord(config) || config["type"] !== "Metaspace") {
    if (config === null || config === undefined) return (tokens) => tokens.join("");
    if (isRecord(config)) fail(`unsupported decoder ${String(config["type"])}`);
    fail("decoder");
  }
  const replacement = typeof config["replacement"] === "string" ? config["replacement"] : "▁";
  const dropFirst = metaspacePrepend(config) !== "never";
  return (tokens) => {
    const text = tokens.join("").split(replacement).join(" ");
    return dropFirst && text.startsWith(" ") ? text.slice(1) : text;
  };
}

/** transformers' clean_up_tokenization: no space before punctuation and English contractions. */
export function cleanUpSpaces(text: string): string {
  return text
    .replace(/ \./gu, ".")
    .replace(/ \?/gu, "?")
    .replace(/ !/gu, "!")
    .replace(/ ,/gu, ",")
    .replace(/ ' /gu, "'")
    .replace(/ n't/gu, "n't")
    .replace(/ 'm/gu, "'m")
    .replace(/ 's/gu, "'s")
    .replace(/ 've/gu, "'ve")
    .replace(/ 're/gu, "'re");
}

/* ------------------------------------------------------------------ tokenizer */

/** Builds a tokenizer from a parsed tokenizer.json. Throws Error on anything it does not support. */
export function loadTokenizer(json: unknown): Tokenizer {
  if (!isRecord(json) || !isRecord(json["model"])) fail("no model");
  const added = Array.isArray(json["added_tokens"]) ? (json["added_tokens"] as unknown[]) : [];
  const addedTokens = new Map<string, { id: number; special: boolean }>();
  for (const token of added) {
    if (isRecord(token) && typeof token["content"] === "string" && typeof token["id"] === "number") {
      addedTokens.set(token["content"], { id: token["id"], special: token["special"] === true });
    }
  }
  const excluded = new Set(addedTokens.keys());
  const config = json["model"];
  const model =
    config["type"] === "Unigram"
      ? unigramModel(config, excluded)
      : config["type"] === "BPE"
        ? bpeModel(config, excluded)
        : fail(`unsupported model ${String(config["type"])}`);
  const normalize = normalizerOf(json["normalizer"]);
  const preTokenize = preTokenizerOf(json["pre_tokenizer"]);
  const decodeTokens = decoderOf(json["decoder"]);

  const tokenIds = new Map<string, number>();
  model.vocab.forEach((piece, id) => {
    if (piece !== "" && !tokenIds.has(piece)) tokenIds.set(piece, id);
  });
  for (const [content, { id }] of addedTokens) tokenIds.set(content, id);
  const idTokens = new Map<number, string>();
  model.vocab.forEach((piece, id) => idTokens.set(id, piece));
  for (const [content, { id }] of addedTokens) idTokens.set(id, content);
  const specialIds = new Set([...addedTokens.values()].filter((t) => t.special).map((t) => t.id));
  const vocabSize = Math.max(model.vocab.length, ...[...addedTokens.values()].map((t) => t.id + 1));

  const encode = (text: string): number[] => {
    const normalized = normalize(text);
    if (normalized === "") return [];
    return preTokenize([normalized]).flatMap((word) => model.encodeWord(word));
  };

  return {
    encode,
    tokenize: (text) => encode(text).map((id) => idTokens.get(id) ?? ""),
    decode(ids) {
      const tokens = ids.filter((id) => !specialIds.has(id)).map((id) => idTokens.get(id) ?? "");
      return cleanUpSpaces(decodeTokens(tokens));
    },
    tokenToId: (token) => tokenIds.get(token),
    idToToken: (id) => idTokens.get(id),
    unkId: model.unkId,
    vocabSize,
    specialIds,
  };
}
