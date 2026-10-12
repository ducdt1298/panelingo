// node scripts/package.ts [<build dir>]
//
// Zips a production build for the Chrome Web Store and GitHub releases: release/panelingo-<version>.zip with
// manifest.json at the archive root (the store's requirement), plus its SHA-256 in release/panelingo-<version>.zip.sha256.
// `npm run package` builds for production into release/dist first. The archive is written with Node's zlib only
// (deflate, CRC-32), in a stable order and with a fixed timestamp, so the same build always gives the same bytes.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { ROOT, rel } from "./lib/paths.ts";

interface Entry {
  name: string;
  data: Buffer;
}

/** 1980-01-01 00:00 in DOS date/time: no build time leaks into the archive. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** A zip archive (PKWARE APPNOTE 6.3: local headers, central directory, end record); deflate where it helps. */
export function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function main(): Promise<void> {
  const dir = path.resolve(ROOT, process.argv[2] ?? "release/dist");
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
    version: string;
    name: string;
  };
  if (
    /\((?:dev|test)\)/u.test(manifest.name) ||
    (await stat(path.join(dir, "ui", "debug.html")).catch(() => null))
  ) {
    throw new Error(`${rel(dir)} is not a production build (run node scripts/build.ts --prod first)`);
  }
  const names = (await listFiles(dir)).filter((name) => !name.endsWith(".map"));
  const entries = await Promise.all(
    names.map(async (name) => ({ name, data: await readFile(path.join(dir, ...name.split("/"))) })),
  );
  const archive = zip(entries);
  const out = path.join(ROOT, "release");
  await mkdir(out, { recursive: true });
  const file = path.join(out, `panelingo-${manifest.version}.zip`);
  await writeFile(file, archive);
  const sha = createHash("sha256").update(archive).digest("hex");
  await writeFile(`${file}.sha256`, `${sha}  ${path.basename(file)}\n`);
  console.log(
    `packaged ${entries.length} files → ${rel(file)} (${(archive.length / 1048576).toFixed(1)} MB, sha256 ${sha})`,
  );
}

// Run as a script (not when a test imports zip()).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
