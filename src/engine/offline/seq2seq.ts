// Greedy decoding of an encoder-decoder translation model exported by Hugging Face Optimum (Marian / Opus-MT and
// M2M100 / NLLB-200): encoder_model + decoder_model_merged (one graph with and without the key/value cache, chosen by
// use_cache_branch). A batch of sentences is encoded once (padded, with an attention mask); each step feeds every
// row's last token and the previous step's present.* tensors as past_key_values.*, and takes the best token of each
// row (pad never; no repeated 4-gram, which stops the loops greedy search falls into on garbled input) until every
// row produced </s> or reached its length limit. A decoder without past inputs is fed the whole prefix each step.

import type { Tokenizer } from "../../shared/offline/tokenizer.ts";
import type { OfflineOrt, OfflineSession, OfflineTensor } from "./ort.ts";

export interface Seq2SeqConfig {
  /** Decoder attention heads and their size (past_key_values shapes). */
  heads: number;
  headDim: number;
  decoderStartId: number;
  eosId: number;
  padId: number;
  /** Tokens never generated (Marian's pad, its bad_words_ids). */
  suppress: readonly number[];
}

/** Reads config.json (MarianConfig / M2M100Config) of an exported model. Throws Error when fields are missing. */
export function seq2seqConfig(json: unknown): Seq2SeqConfig {
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const int = (key: string): number => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`config.json: no ${key}`);
    }
    return value;
  };
  const heads = int("decoder_attention_heads");
  const dModel = int("d_model");
  if (heads === 0 || dModel % heads !== 0)
    throw new Error("config.json: d_model is not a multiple of the heads");
  const padId = int("pad_token_id");
  return {
    heads,
    headDim: dModel / heads,
    decoderStartId: int("decoder_start_token_id"),
    eosId: int("eos_token_id"),
    padId,
    suppress: [padId],
  };
}

export interface Seq2SeqModel {
  encoder: OfflineSession;
  decoder: OfflineSession;
  config: Seq2SeqConfig;
  tokenizer: Tokenizer;
}

/** Runs one session call under the engine's ORT lock. */
export type RunSession = (
  session: OfflineSession,
  feeds: Record<string, OfflineTensor>,
) => Promise<Readonly<Record<string, OfflineTensor>>>;

export interface GenerateOptions {
  /** Decoder tokens after the start token, forced (NLLB: the target language code). */
  prefix: readonly number[];
  /** Most tokens generated for a source of `n` tokens. */
  maxNew: (n: number) => number;
  /** Ban a token that would repeat an n-gram of this size (0 = off). */
  noRepeatNgram?: number;
}

export const NO_REPEAT_NGRAM = 4;

function float32(tensor: OfflineTensor | undefined, name: string): Float32Array {
  if (tensor === undefined || !(tensor.data instanceof Float32Array)) throw new Error(`decoder: no ${name}`);
  return tensor.data;
}

/** Tokens that would complete an n-gram the row already contains. */
function bannedNext(tokens: readonly number[], n: number): Set<number> {
  const banned = new Set<number>();
  if (n <= 0 || tokens.length < n - 1) return banned;
  const tail = tokens.slice(tokens.length - (n - 1));
  for (let i = 0; i + n - 1 < tokens.length; i++) {
    let same = true;
    for (let k = 0; k < n - 1 && same; k++) same = tokens[i + k] === tail[k];
    if (same) {
      const next = tokens[i + n - 1];
      if (next !== undefined) banned.add(next);
    }
  }
  return banned;
}

/** Index of the best logit of one row, skipping banned and suppressed tokens. */
export function bestToken(
  logits: Float32Array,
  offset: number,
  vocab: number,
  skip: ReadonlySet<number>,
): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let v = 0; v < vocab; v++) {
    const score = logits[offset + v] ?? Number.NEGATIVE_INFINITY;
    if (score > bestScore && !skip.has(v)) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

/**
 * Greedy generation for a batch of encoder inputs (ids with their special tokens). Returns the generated ids of each
 * row, without the start token, the forced prefix and </s>.
 */
export async function generate(
  ort: OfflineOrt,
  model: Pick<Seq2SeqModel, "encoder" | "decoder" | "config">,
  run: RunSession,
  inputs: ReadonlyArray<readonly number[]>,
  options: GenerateOptions,
): Promise<number[][]> {
  const { config, encoder, decoder } = model;
  const B = inputs.length;
  if (B === 0) return [];
  const S = Math.max(1, ...inputs.map((ids) => ids.length));
  const ids = new BigInt64Array(B * S).fill(BigInt(config.padId));
  const mask = new BigInt64Array(B * S);
  inputs.forEach((row, b) => {
    row.forEach((id, s) => {
      ids[b * S + s] = BigInt(id);
      mask[b * S + s] = 1n;
    });
  });
  const attention = ort.int64(mask, [B, S]);
  const encoded = await run(encoder, { input_ids: ort.int64(ids, [B, S]), attention_mask: attention });
  const hidden = encoded["last_hidden_state"] ?? Object.values(encoded)[0];
  if (hidden === undefined) throw new Error("encoder: no output");

  const pastNames = decoder.inputNames.filter((name) => name.startsWith("past_key_values."));
  const merged = pastNames.length > 0;
  const hasBranch = decoder.inputNames.includes("use_cache_branch");
  const suppress = new Set(config.suppress);
  const limits = inputs.map((row) => Math.max(1, options.maxNew(row.length)));
  const maxSteps = Math.max(...limits);
  const prefix = [config.decoderStartId, ...options.prefix];
  const generated: number[][] = inputs.map(() => []);
  const done = inputs.map(() => false);
  let past: Record<string, OfflineTensor> = {};
  if (merged) {
    for (const name of pastNames) {
      past[name] = ort.float32(new Float32Array(0), [B, config.heads, 0, config.headDim]);
    }
  }

  for (let step = 0; step < maxSteps && done.some((d) => !d); step++) {
    // First step: the whole prefix (no cache yet). Later steps: one token per row with the cache, or the whole
    // sequence again for a decoder without past inputs.
    const rows = generated.map((tokens, b) => {
      if (step === 0 || !merged) return [...prefix, ...tokens];
      return [done[b] === true ? config.padId : (tokens[tokens.length - 1] ?? config.padId)];
    });
    const T = Math.max(...rows.map((row) => row.length));
    const decoderIds = new BigInt64Array(B * T).fill(BigInt(config.padId));
    rows.forEach((row, b) => row.forEach((id, t) => (decoderIds[b * T + t] = BigInt(id))));
    const feeds: Record<string, OfflineTensor> = {
      input_ids: ort.int64(decoderIds, [B, T]),
      encoder_attention_mask: attention,
      encoder_hidden_states: hidden,
      ...past,
    };
    if (hasBranch) feeds["use_cache_branch"] = ort.bool(Uint8Array.of(merged && step > 0 ? 1 : 0), [1]);
    const out = await run(decoder, feeds);
    const logits = float32(out["logits"], "logits");
    const steps = out["logits"]?.dims[1] ?? T;
    const vocab = out["logits"]?.dims[2] ?? 0;
    for (let b = 0; b < B; b++) {
      if (done[b] === true) continue;
      const tokens = generated[b] ?? [];
      // Rows without a cache are right-padded: the next token follows the row's own last position.
      const at = merged && step > 0 ? steps - 1 : (rows[b]?.length ?? 1) - 1;
      const skip = new Set([...suppress, ...bannedNext(tokens, options.noRepeatNgram ?? NO_REPEAT_NGRAM)]);
      const next = bestToken(logits, (b * steps + at) * vocab, vocab, skip);
      if (next < 0 || next === config.eosId) {
        done[b] = true;
        continue;
      }
      tokens.push(next);
      if (tokens.length >= (limits[b] ?? 1)) done[b] = true;
    }
    if (merged) {
      const next: Record<string, OfflineTensor> = {};
      for (const name of pastNames) {
        // The cross-attention keys and values come from the first step only: the cached branch does not
        // recompute them (its present.*.encoder.* outputs are placeholders).
        const kept = step > 0 && name.includes(".encoder.") ? past[name] : undefined;
        const present = kept ?? out[name.replace("past_key_values", "present")];
        if (present === undefined) throw new Error(`decoder: no output for ${name}`);
        next[name] = present;
      }
      past = next;
    }
  }
  return generated;
}

/** Most new tokens for a source of n tokens: room for languages that need more tokens, bounded. */
export function defaultMaxNew(n: number): number {
  return Math.min(256, Math.ceil(n * 3) + 10);
}
