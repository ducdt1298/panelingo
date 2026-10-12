import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, inflateRawSync } from "node:zlib";
import { zip } from "../../../scripts/package.ts";

interface Read {
  name: string;
  method: number;
  data: Buffer;
}

/** Walks the central directory of an archive and reads every entry back through its local header. */
function unzip(archive: Buffer): Read[] {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, "end of central directory record");
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const out: Read[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50, "central directory header");
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    assert.equal(archive.readUInt32LE(local), 0x04034b50, "local file header");
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const body = archive.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), crc, `${name}: CRC-32`);
    out.push({ name, method, data });
    at += 46 + nameLength;
  }
  return out;
}

test("zip: entries round-trip with names, contents and CRCs; compressible files are deflated", () => {
  const text = Buffer.from("manifest ".repeat(200));
  const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) % 256));
  const entries = [
    { name: "manifest.json", data: text },
    { name: "assets/icons/icon-16.png", data: random },
    { name: "_locales/pt_BR/messages.json", data: Buffer.from("{}") },
  ];
  const read = unzip(zip(entries));
  assert.deepEqual(
    read.map((r) => [r.name, r.data.toString("hex")]),
    entries.map((e) => [e.name, e.data.toString("hex")]),
  );
  assert.equal(read[0]?.method, 8, "repetitive text is deflated");
  assert.equal(read[2]?.method, 0, "a tiny file is stored as is");
});

test("zip: the same input always gives the same bytes (fixed timestamps)", () => {
  const entries = [{ name: "a.txt", data: Buffer.from("same") }];
  assert.deepEqual(zip(entries), zip(entries));
});
