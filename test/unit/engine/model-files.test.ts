import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelStore } from "../../../src/engine/contracts.ts";
import {
  BUILD_INFO_PATH,
  createModelFiles,
  parseBuildInfo,
  sha256Hex,
} from "../../../src/engine/model-files.ts";
import type { BuildInfo, FetchResponseLike, ModelFiles } from "../../../src/engine/model-files.ts";
import { createLogger } from "../../../src/platform/log.ts";
import { CtvError } from "../../../src/shared/errors.ts";
import type { ModelIntegrityRecord } from "../../../src/shared/records.ts";
import type { LogEntry } from "../../../src/shared/types.ts";

const BASE = "chrome-extension://test/";
const FP32 = "detector-v4-s.fixed.onnx";
const INT8 = "detector-v4-s_int8.onnx";

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** sha256 of the empty input, a well-known value. */
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

class FakeFiles {
  readonly files = new Map<string, unknown>();
  readonly requests: string[] = [];
  failNext: string | null = null;

  readonly fetch = (url: string): Promise<FetchResponseLike> => {
    this.requests.push(url);
    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;
      return Promise.reject(new TypeError(message));
    }
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const body = this.files.get(path);
    const ok = body !== undefined;
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      arrayBuffer: () =>
        Promise.resolve(body instanceof Uint8Array ? body.slice().buffer : new ArrayBuffer(0)),
      json: () =>
        body instanceof Uint8Array ? Promise.reject(new SyntaxError("not json")) : Promise.resolve(body),
    });
  };

  count(path: string): number {
    return this.requests.filter((u) => u === BASE + path).length;
  }
}

class FakeModelStore implements ModelStore {
  readonly records = new Map<string, ModelIntegrityRecord>();
  failGet = false;
  failPut = false;

  get(file: string): Promise<ModelIntegrityRecord | undefined> {
    if (this.failGet) return Promise.reject(new Error("idb get failed"));
    const record = this.records.get(file);
    return Promise.resolve(record === undefined ? undefined : { ...record });
  }

  put(record: ModelIntegrityRecord): Promise<void> {
    if (this.failPut) return Promise.reject(new Error("idb put failed"));
    this.records.set(record.file, { ...record });
    return Promise.resolve();
  }
}

interface Setup {
  files: FakeFiles;
  store: FakeModelStore;
  models: ModelFiles;
  hashes: () => number;
  logs: LogEntry[];
}

async function setup(
  options: {
    buildId?: string;
    store?: FakeModelStore;
    files?: FakeFiles;
    mutate?: (info: BuildInfo) => void;
  } = {},
): Promise<Setup> {
  const fp32 = bytesOf("fp32 model bytes");
  const int8 = bytesOf("int8 model");
  const files = options.files ?? new FakeFiles();
  const info: BuildInfo = {
    buildId: options.buildId ?? "0.1.0+20261010T000000.dev",
    mode: "dev",
    ort: "1.30.0",
    models: [
      { file: FP32, sha256: await sha256Hex(fp32), bytes: fp32.byteLength },
      { file: INT8, sha256: await sha256Hex(int8), bytes: int8.byteLength },
    ],
  };
  options.mutate?.(info);
  files.files.set(BUILD_INFO_PATH, info);
  files.files.set(`models/${FP32}`, fp32);
  files.files.set(`models/${INT8}`, int8);
  const store = options.store ?? new FakeModelStore();
  let hashed = 0;
  const logs: LogEntry[] = [];
  const models = createModelFiles({
    getURL: (path) => BASE + path,
    fetch: files.fetch,
    store,
    now: () => 1_700_000_000_000,
    log: createLogger("engine", { sinks: [(e) => logs.push(e)], minLevel: "debug" }),
    sha256: (bytes) => {
      hashed += 1;
      return sha256Hex(bytes);
    },
  });
  return { files, store, models, hashes: () => hashed, logs };
}

async function rejectsWithIntegrity(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CtvError);
    assert.equal(error.code, "detector.model_integrity");
    assert.match(error.message, message);
    return true;
  });
}

describe("sha256Hex", () => {
  test("uses crypto.subtle and returns lowercase hex", async () => {
    assert.equal(await sha256Hex(new Uint8Array(new ArrayBuffer(0))), EMPTY_SHA);
    assert.equal(
      await sha256Hex(bytesOf("abc")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseBuildInfo", () => {
  const entry = { file: FP32, sha256: EMPTY_SHA, bytes: 10 };

  test("accepts what scripts/build.ts writes", () => {
    assert.deepEqual(parseBuildInfo({ buildId: "b", mode: "test", ort: "1.30.0", models: [entry] }), {
      buildId: "b",
      mode: "test",
      ort: "1.30.0",
      models: [entry],
    });
  });

  test("rejects malformed files as detector.model_integrity", () => {
    const bad: unknown[] = [
      null,
      { mode: "dev", ort: "1", models: [] },
      { buildId: "b", models: [] },
      { buildId: "b", ort: "1", models: {} },
      { buildId: "b", ort: "1", models: [{ ...entry, sha256: "XYZ" }] },
      { buildId: "b", ort: "1", models: [{ ...entry, bytes: 0 }] },
      { buildId: "b", ort: "1", models: [{ ...entry, file: "" }] },
    ];
    for (const json of bad) {
      assert.throws(
        () => parseBuildInfo(json),
        (error: unknown) => error instanceof CtvError && error.code === "detector.model_integrity",
        JSON.stringify(json),
      );
    }
  });
});

describe("createModelFiles", () => {
  test("loads a model: checks bytes and sha256, records the verification for this build", async () => {
    const s = await setup();
    const bytes = await s.models.load(FP32);
    assert.equal(new TextDecoder().decode(bytes), "fp32 model bytes");
    assert.equal(s.hashes(), 1);
    const record = s.store.records.get(FP32);
    assert.deepEqual(record, {
      file: FP32,
      sha256: (await s.models.entry(FP32)).sha256,
      bytes: bytes.byteLength,
      verifiedForBuild: "0.1.0+20261010T000000.dev",
      ok: true,
      verifiedAt: 1_700_000_000_000,
    });
    assert.ok(s.logs.some((e) => e.msg === "model verified"));
  });

  test("the sha256 is verified once per build: same instance, a new engine, then a new build", async () => {
    const store = new FakeModelStore();
    const first = await setup({ store });
    await first.models.load(FP32);
    await first.models.load(FP32);
    assert.equal(first.hashes(), 1, "same engine: verified set");
    assert.equal(first.files.count(`models/${FP32}`), 2, "bytes are fetched (and length-checked) every time");

    const restarted = await setup({ store });
    await restarted.models.load(FP32);
    assert.equal(restarted.hashes(), 0, "new engine, same build: the store says verified");

    const rebuilt = await setup({ store, buildId: "0.1.0+20261011T000000.dev" });
    await rebuilt.models.load(FP32);
    assert.equal(rebuilt.hashes(), 1, "a new build hashes again");
    assert.equal(store.records.get(FP32)?.verifiedForBuild, "0.1.0+20261011T000000.dev");
  });

  test("each file is verified separately", async () => {
    const s = await setup();
    await s.models.load(FP32);
    await s.models.load(INT8);
    assert.equal(s.hashes(), 2);
    assert.deepEqual([...s.store.records.keys()].sort(), [INT8, FP32].sort());
  });

  test("a byte length mismatch fails before hashing", async () => {
    const s = await setup({
      mutate: (info) => {
        const fp32 = info.models[0];
        if (fp32 !== undefined) fp32.bytes += 1;
      },
    });
    await rejectsWithIntegrity(s.models.load(FP32), /16 bytes, expected 17/);
    assert.equal(s.hashes(), 0);
    assert.equal(s.store.records.size, 0);
  });

  test("a sha256 mismatch fails, is recorded as not ok, and is re-checked next time", async () => {
    const s = await setup({
      mutate: (info) => {
        const fp32 = info.models[0];
        if (fp32 !== undefined) fp32.sha256 = EMPTY_SHA;
      },
    });
    await rejectsWithIntegrity(s.models.load(FP32), /sha256 .* expected e3b0c44298fc/);
    const record = s.store.records.get(FP32);
    assert.equal(record?.ok, false);
    assert.notEqual(record?.sha256, EMPTY_SHA, "the measured hash is recorded");
    await rejectsWithIntegrity(s.models.load(FP32), /sha256/);
    assert.equal(s.hashes(), 2);
  });

  test("a stale record (other bytes or sha for the same build) does not skip the hash", async () => {
    const store = new FakeModelStore();
    const s = await setup({ store });
    const entry = await s.models.entry(FP32);
    store.records.set(FP32, {
      file: FP32,
      sha256: EMPTY_SHA,
      bytes: entry.bytes,
      verifiedForBuild: "0.1.0+20261010T000000.dev",
      ok: true,
      verifiedAt: 1,
    });
    await s.models.load(FP32);
    assert.equal(s.hashes(), 1);
  });

  test("a model missing from build-info or from the package is an integrity error", async () => {
    const s = await setup();
    await rejectsWithIntegrity(s.models.load("other.onnx"), /not listed/);
    s.files.files.delete(`models/${INT8}`);
    await rejectsWithIntegrity(s.models.load(INT8), /HTTP 404/);
    s.files.failNext = "Failed to fetch";
    await rejectsWithIntegrity(s.models.load(FP32), /Failed to fetch/);
  });

  test("build-info is read once; a failed read is retried on the next call", async () => {
    const s = await setup();
    s.files.failNext = "Failed to fetch";
    await rejectsWithIntegrity(s.models.buildInfo(), /build-info\.json: Failed to fetch/);
    const info = await s.models.buildInfo();
    assert.equal(info.ort, "1.30.0");
    await s.models.load(FP32);
    await s.models.load(INT8);
    assert.equal(s.files.count(BUILD_INFO_PATH), 2);
  });

  test("a build-info that is not JSON is an integrity error", async () => {
    const s = await setup();
    s.files.files.set(BUILD_INFO_PATH, bytesOf("<html>"));
    await rejectsWithIntegrity(s.models.buildInfo(), /not json/);
  });

  test("store failures only cost a re-hash; they never fail the load", async () => {
    const store = new FakeModelStore();
    store.failGet = true;
    store.failPut = true;
    const s = await setup({ store });
    const bytes = await s.models.load(FP32);
    assert.equal(bytes.byteLength, 16);
    assert.equal(s.hashes(), 1);
    assert.deepEqual(
      s.logs.filter((e) => e.code === "store.io").map((e) => e.msg),
      ["models store read failed", "models store write failed"],
    );
  });
});
