// analyze-sessions.mjs - per-turn timing, model and reply language from DSH session logs.
//
// Session files are concatenated zstd frames (one per append), so the sync decompressor only ever
// returns the first frame. Stream through the whole file instead.
//
//   node tools/analyze-sessions.mjs <sessionsDir> [maxSessions]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const [dir, maxArg] = process.argv.slice(2);
const maxSessions = Number(maxArg || 4);

function findAll(root) {
  const out = [];
  (function walk(d, depth) {
    if (depth > 3) return;
    let entries = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.endsWith(".zstd")) out.push({ path: full, mtime: st.mtimeMs, size: st.size });
    }
  })(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, maxSessions);
}

function decompressAll(buf) {
  const chunks = [];
  let offset = 0;
  while (offset < buf.length) {
    let consumed = 0;
    let out = null;
    try {
      out = zlib.zstdDecompressSync(buf.subarray(offset), {
        // @ts-ignore - chunkSize is accepted
        chunkSize: 1 << 20,
      });
      // find frame length: decompress returns data for one frame; advance by scanning magic
    } catch { /* fall through to magic scan */ }
    if (out && out.length) chunks.push(out);
    // advance to the next zstd frame magic 0x28 0xB5 0x2F 0xFD
    let next = -1;
    for (let i = offset + 4; i < buf.length - 3; i += 1) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) { next = i; break; }
    }
    if (next === -1) break;
    offset = next;
    consumed += 1;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cjkRatio(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk / Math.max(1, text.length);
}

for (const file of findAll(dir)) {
  let text = "";
  try { text = decompressAll(readFileSync(file.path)); } catch (e) { console.log(`FAIL ${file.path}: ${e.message}`); continue; }
  const events = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  console.log(`\n=== ${file.path.split("\\").slice(-2)[0]}  events=${events.length}`);

  let model = null;
  let pendingAt = null;
  let index = 0;
  for (const e of events) {
    const type = e.type || e.kind || "";
    const data = e.data || {};
    if (/model/i.test(JSON.stringify(e).slice(0, 400)) && !model) {
      const m = JSON.stringify(e).match(/"model":"([^"]+)"/);
      if (m) model = m[1];
    }
    if (type.includes("user") && type.includes("message")) {
      pendingAt = e.at || e.time || Date.now();
      const t = data.message?.content ?? data.content ?? "";
      const flat = typeof t === "string" ? t : JSON.stringify(t);
      index += 1;
      console.log(`  [turn ${index}] user @${new Date(pendingAt).toLocaleTimeString()}  ${flat.slice(0, 90).replace(/\s+/g, " ")}`);
    }
    if (type.includes("assistant") || type.includes("message")) {
      const t = data.message?.content ?? data.content ?? "";
      const flat = typeof t === "string" ? t : JSON.stringify(t);
      if (flat.length > 40) {
        const at = e.at || e.time || null;
        const ms = pendingAt && at ? at - pendingAt : null;
        console.log(`      reply${ms !== null ? ` in ${ms}ms` : ""}  cjk=${(cjkRatio(flat) * 100).toFixed(0)}%  ${flat.slice(0, 110).replace(/\s+/g, " ")}`);
      }
    }
  }
  if (model) console.log(`  model: ${model}`);
}
