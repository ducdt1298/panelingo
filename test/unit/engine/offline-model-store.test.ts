// Offline model files (src/engine/offline/model-store.ts) with a fake fetch, a fake Cache Storage and a fake models
// store: download with progress, size and sha256 checks, the cache (no second download, no second hash), damaged
// cache entries, shared concurrent downloads, the dev mirror URL, and the error codes.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { ModelStore } from "../../../src/engine/contracts.ts";
import {
  cacheKey,
  createOfflineModelStore,
  integrityKey,
  type CacheLike,
  type DownloadResponse,
} from "../../../src/engine/offline/model-store.ts";
import { silentLogger } from "../../../src/platform/log.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { OfflineFile } from "../../../src/shared/offline/catalog.ts";
import type { ModelIntegrityRecord } from "../../../src/shared/records.ts";

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
const SHA = createHash("sha256").update(BYTES).digest("hex");

const FILE: OfflineFile = {
  model: "ocr-korean",
  kind: "ocr",
  role: "model",
  repo: "PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx",
  revision: "5c6f574b8e2230adf4287b33e736d71b9fabd28e",
  path: "inference.onnx",
  license: "Apache-2.0",
  bytes: BYTES.byteLength,
  sha256: SHA,
};

/** A response streaming `body` in chunks of `chunk` bytes. */
function response(body: Uint8Array, options: { status?: number; chunk?: number } = {}): DownloadResponse {
  const status = options.status ?? 200;
  const chunk = options.chunk ?? 256;
  let at = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: () => {
          if (at >= body.byteLength) return Promise.resolve({ done: true });
          const value = body.slice(at, at + chunk);
          at += chunk;
          return Promise.resolve({ done: false, value });
        },
        cancel: () => Promise.resolve(),
      }),
    },
    arrayBuffer: () => Promise.resolve(body.slice().buffer),
  };
}

function fakeCache(): CacheLike & { entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    match: (key) => {
      const bytes = entries.get(key);
      return Promise.resolve(
        bytes === undefined ? undefined : { arrayBuffer: () => Promise.resolve(bytes.slice().buffer) },
      );
    },
    put: (key, bytes) => {
      entries.set(key, bytes.slice());
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(entries.delete(key)),
  };
}

function fakeIntegrity(): ModelStore & { records: Map<string, ModelIntegrityRecord> } {
  const records = new Map<string, ModelIntegrityRecord>();
  return {
    records,
    get: (file) => Promise.resolve(records.get(file)),
    put: (record) => {
      records.set(record.file, record);
      return Promise.resolve();
    },
  };
}

interface Harness {
  urls: string[];
  hashes: number;
  cache: ReturnType<typeof fakeCache>;
  integrity: ReturnType<typeof fakeIntegrity>;
  store: ReturnType<typeof createOfflineModelStore>;
}

function harness(
  respond: (url: string) => Promise<DownloadResponse>,
  options: { base?: string; cache?: ReturnType<typeof fakeCache> | null } = {},
): Harness {
  const cache = options.cache === undefined ? fakeCache() : options.cache;
  const integrity = fakeIntegrity();
  const h: Harness = {
    urls: [],
    hashes: 0,
    cache: cache ?? fakeCache(),
    integrity,
    store: undefined as never,
  };
  h.store = createOfflineModelStore({
    fetch: (url) => {
      h.urls.push(url);
      return respond(url);
    },
    openCache: () => Promise.resolve(cache),
    integrity,
    baseUrl: () => options.base ?? "https://huggingface.co",
    now: () => 1_000,
    log: silentLogger,
    sha256: (bytes) => {
      h.hashes += 1;
      return Promise.resolve(createHash("sha256").update(bytes).digest("hex"));
    },
  });
  return h;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<CtvError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CtvError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

describe("downloading", () => {
  test("from the pinned Hugging Face URL, with progress; verified bytes are cached and recorded", async () => {
    const h = harness(() => Promise.resolve(response(BYTES)));
    const progress: number[] = [];
    const bytes = await h.store.load(FILE, (n) => progress.push(n));
    assert.deepEqual([...bytes], [...BYTES]);
    assert.deepEqual(h.urls, [`https://huggingface.co/${FILE.repo}/resolve/${FILE.revision}/inference.onnx`]);
    assert.deepEqual(progress, [256, 512, 768, 1000]);
    assert.ok(h.cache.entries.has(cacheKey(FILE)));
    assert.equal(h.integrity.records.get(integrityKey(FILE))?.ok, true);
    assert.equal(await h.store.cached(FILE), true);
  });

  test("the dev/test mirror gets the same path", async () => {
    const h = harness(() => Promise.resolve(response(BYTES)), { base: "http://127.0.0.1:9000" });
    await h.store.load(FILE);
    assert.deepEqual(h.urls, [`http://127.0.0.1:9000/${FILE.repo}/resolve/${FILE.revision}/inference.onnx`]);
  });

  test("works offline afterwards: a cached, recorded file is read without network or hashing", async () => {
    const cache = fakeCache();
    const first = harness(() => Promise.resolve(response(BYTES)), { cache });
    await first.store.load(FILE);
    const second = harness(() => Promise.reject(new TypeError("offline")), { cache });
    second.integrity.records.set(integrityKey(FILE), {
      file: integrityKey(FILE),
      sha256: SHA,
      bytes: FILE.bytes,
      verifiedForBuild: "offline",
      ok: true,
      verifiedAt: 1,
    });
    const bytes = await second.store.load(FILE);
    assert.equal(bytes.byteLength, FILE.bytes);
    assert.deepEqual(second.urls, []);
    assert.equal(second.hashes, 0);
  });

  test("a cached file without a record is hashed once; a damaged one is dropped and downloaded again", async () => {
    const cache = fakeCache();
    cache.entries.set(cacheKey(FILE), BYTES.slice());
    const h = harness(() => Promise.resolve(response(BYTES)), { cache });
    await h.store.load(FILE);
    assert.deepEqual([h.urls.length, h.hashes], [0, 1]);

    const damaged = fakeCache();
    const bad = BYTES.slice();
    bad[3] = (bad[3] ?? 0) ^ 0xff;
    damaged.entries.set(cacheKey(FILE), bad);
    const again = harness(() => Promise.resolve(response(BYTES)), { cache: damaged });
    const bytes = await again.store.load(FILE);
    assert.deepEqual([...bytes], [...BYTES]);
    assert.equal(again.urls.length, 1);
  });

  test("concurrent loads share one download", async () => {
    const h = harness(() => Promise.resolve(response(BYTES)));
    const [a, b] = await Promise.all([h.store.load(FILE), h.store.load(FILE)]);
    assert.equal(a, b);
    assert.equal(h.urls.length, 1);
  });

  test("without Cache Storage files still load (downloaded on every engine start)", async () => {
    const h = harness(() => Promise.resolve(response(BYTES)), { cache: null });
    await h.store.load(FILE);
    assert.equal(await h.store.cached(FILE), false);
  });
});

describe("failures", () => {
  test("a sha256 mismatch is offline.model_integrity and nothing is cached", async () => {
    const other = BYTES.slice().reverse();
    const h = harness(() => Promise.resolve(response(other)));
    await rejectsWith(h.store.load(FILE), "offline.model_integrity");
    assert.equal(h.cache.entries.size, 0);
    assert.equal(h.integrity.records.get(integrityKey(FILE))?.ok, false);
  });

  test("a wrong size is offline.model_integrity (short or too long)", async () => {
    const short = harness(() => Promise.resolve(response(BYTES.slice(0, 900))));
    await rejectsWith(short.store.load(FILE), "offline.model_integrity");
    const long = harness(() => Promise.resolve(response(new Uint8Array(1200))));
    await rejectsWith(long.store.load(FILE), "offline.model_integrity");
  });

  test("an HTTP status or a network error is offline.download, retryable; the next load tries again", async () => {
    let calls = 0;
    const h = harness(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(response(BYTES, { status: 404 }))
        : Promise.resolve(response(BYTES));
    });
    const error = await rejectsWith(h.store.load(FILE), "offline.download");
    assert.equal(error.retryable, true);
    assert.equal(error.status, 404);
    await h.store.load(FILE);
    const network = harness(() => Promise.reject(new TypeError("Failed to fetch")));
    await rejectsWith(network.store.load(FILE), "offline.download");
  });
});
