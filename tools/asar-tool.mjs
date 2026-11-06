#!/usr/bin/env node
/**
 * asar-tool.mjs - minimal Electron ASAR extract / pack, no dependencies.
 *
 * Layout written by @electron/asar:
 *   [0..4)   uint32  payloadSize of the size-pickle  (= 4)
 *   [4..8)   uint32  payloadSize of the header-pickle
 *   [8..12)  uint32  jsonLength + 4  (string pickle payload size)
 *   [12..16) uint32  jsonLength
 *   [16..)   json bytes, padded to 4-byte alignment, then file data
 * File `offset` in the header is relative to the start of the data section,
 * which begins at 8 + headerPicklePayloadSize.
 *
 * Entries with "unpacked": true live in <archive>.unpacked/<path>, not inline.
 *
 * Usage:
 *   node asar-tool.mjs extract <archive.asar> <outDir>
 *   node asar-tool.mjs pack    <inDir> <archive.asar> [unpackedListJson]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";

const align4 = (n) => (n + 3) & ~3;

function parse(path) {
  const buf = readFileSync(path);
  const sizePicklePayload = buf.readUInt32LE(0);
  if (sizePicklePayload !== 4) throw new Error("unexpected size-pickle payload: " + sizePicklePayload);
  const headerPicklePayload = buf.readUInt32LE(4);
  const headerStart = 8;
  const strPicklePayload = buf.readUInt32LE(headerStart);
  const jsonLength = buf.readUInt32LE(headerStart + 4);
  const jsonStart = headerStart + 8;
  const json = JSON.parse(buf.subarray(jsonStart, jsonStart + jsonLength).toString("utf8"));
  const dataStart = headerStart + headerPicklePayload;
  return { buf, json, dataStart, headerPicklePayload };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + "/" + name : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, entry });
  }
}

function extract(archive, outDir) {
  const { buf, json, dataStart } = parse(archive);
  const files = [];
  walk(json, "", files);
  const unpackedRoot = archive + ".unpacked";
  let inline = 0;
  let unpacked = 0;
  const unpackedPaths = [];
  for (const { path: p, entry } of files) {
    const target = join(outDir, p);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.unpacked) {
      unpackedPaths.push(p);
      const src = join(unpackedRoot, p);
      if (existsSync(src)) { copyFileSync(src, target); unpacked += 1; }
      else { writeFileSync(target, ""); unpacked += 1; }
      continue;
    }
    const start = dataStart + Number(entry.offset || 0);
    writeFileSync(target, buf.subarray(start, start + Number(entry.size || 0)));
    inline += 1;
  }
  // also copy the unpacked tree wholesale, so sidecar files survive
  writeFileSync(join(outDir, ".asar-unpacked-list.json"), JSON.stringify(unpackedPaths, null, 0));
  console.log(`extracted inline=${inline} unpacked=${unpacked} -> ${outDir}`);
}

function collect(dir, prefix, files) {
  for (const name of readdirSync(dir)) {
    if (prefix === "" && name === ".asar-unpacked-list.json") continue;
    const full = join(dir, name);
    const st = statSync(full);
    const p = prefix ? prefix + "/" + name : name;
    if (st.isDirectory()) collect(full, p, files);
    else files.push({ path: p, size: st.size, full });
  }
}

function pack(inDir, archive, unpackedListPath) {
  const unpackedSet = new Set(
    unpackedListPath && existsSync(unpackedListPath)
      ? JSON.parse(readFileSync(unpackedListPath, "utf8"))
      : [],
  );
  const files = [];
  collect(inDir, "", files);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));

  const root = { files: {} };
  let offset = 0;
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      node.files[parts[i]] = node.files[parts[i]] || { files: {} };
      node = node.files[parts[i]];
    }
    const isUnpacked = unpackedSet.has(f.path);
    node.files[parts[parts.length - 1]] = isUnpacked
      ? { size: f.size, unpacked: true }
      : { size: f.size, offset };
    if (!isUnpacked) offset += f.size;
  }

  const json = Buffer.from(JSON.stringify(root), "utf8");
  // header pickle payload = its own size field (4) + string pickle payload
  // string pickle payload = string length field (4) + json bytes + padding to 4
  const strPayload = align4(4 + json.length);
  const headerPayload = 4 + strPayload;
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPayload, 4);
  const header = Buffer.alloc(headerPayload);
  header.writeUInt32LE(strPayload, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);

  const parts = [sizePickle, header];
  for (const f of files) {
    if (unpackedSet.has(f.path)) continue;
    parts.push(readFileSync(f.full));
  }
  writeFileSync(archive, Buffer.concat(parts));

  // rewrite the unpacked sidecar
  const unpackedRoot = archive + ".unpacked";
  if (unpackedSet.size) {
    mkdirSync(unpackedRoot, { recursive: true });
    for (const p of unpackedSet) {
      const src = join(inDir, p);
      if (!existsSync(src)) continue;
      const dst = join(unpackedRoot, p);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  console.log(`packed files=${files.length} unpacked=${unpackedSet.size} size=${(Buffer.concat(parts).length / 1048576).toFixed(1)}MB -> ${archive}`);
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "extract") extract(a, b);
else if (cmd === "pack") pack(a, b, process.argv[5]);
else { console.error("usage: extract <asar> <dir> | pack <dir> <asar> [unpackedList]"); process.exit(1); }
