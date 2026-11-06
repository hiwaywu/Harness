// model-perf.mjs - why one model feels slow: turns, steps, tool calls and output per model.
//
// Session logs are concatenated zstd frames (one per append), so stream all frames and parse the
// JSONL. Model comes from request/header config.model; durations from turn/start -> turn/end.
//
//   node tools/model-perf.mjs <sessionsDir> [maxSessions]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const [dir, maxArg] = process.argv.slice(2);
const maxSessions = Number(maxArg || 40);

function frames(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    let d = null;
    try { d = zlib.zstdDecompressSync(buf.subarray(off)); } catch {}
    if (d && d.length) out.push(d);
    let next = -1;
    for (let i = off + 4; i < buf.length - 3; i += 1) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) { next = i; break; }
    }
    if (next === -1) break;
    off = next;
  }
  return Buffer.concat(out).toString("utf8");
}

function collect(root) {
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
      else if (name.endsWith(".zstd")) out.push({ path: full, mtime: st.mtimeMs });
    }
  })(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, maxSessions);
}

const byModel = new Map();
for (const file of collect(dir)) {
  let events = [];
  try {
    events = frames(readFileSync(file.path)).split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { continue; }

  let model = "?";
  let turnStart = null;
  let steps = 0;
  let tools = 0;
  let outChars = 0;
  let reasonChars = 0;

  const flush = (endAt) => {
    if (turnStart === null || !endAt) { turnStart = null; steps = 0; tools = 0; outChars = 0; reasonChars = 0; return; }
    const rec = byModel.get(model) || { turns: 0, ms: [], steps: [], tools: [], out: [], reason: [] };
    rec.turns += 1;
    rec.ms.push(Math.max(0, endAt - turnStart));
    rec.steps.push(steps);
    rec.tools.push(tools);
    rec.out.push(outChars);
    rec.reason.push(reasonChars);
    byModel.set(model, rec);
    turnStart = null; steps = 0; tools = 0; outChars = 0; reasonChars = 0;
  };

  for (const e of events) {
    const t = e.type || "";
    if (t === "request/header" && e.data?.header?.config?.model) model = e.data.header.config.model;
    if (t === "turn/start") { turnStart = e.time; steps = 0; tools = 0; outChars = 0; reasonChars = 0; }
    if (t === "step/start") steps += 1;
    if (t === "tool/call") tools += 1;
    if (t === "assistant/message") {
      const parts = e.data?.message?.content;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (p.type === "text") outChars += (p.text || "").length;
          if (p.type === "reasoning") reasonChars += (p.text || "").length;
        }
      }
    }
    if (t === "turn/end") flush(e.time);
  }
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

console.log("model".padEnd(24) + "turns".padStart(6) + "median".padStart(9) + "steps".padStart(7) + "tools".padStart(7) + "out ch".padStart(9) + "reason".padStart(8) + "ch/s".padStart(7));
console.log("-".repeat(77));
for (const [model, r] of [...byModel.entries()].sort((a, b) => med(b[1].ms) - med(a[1].ms))) {
  const ms = med(r.ms);
  const out = avg(r.out);
  console.log(
    model.slice(0, 23).padEnd(24) +
    String(r.turns).padStart(6) +
    (ms / 1000).toFixed(1).padStart(9) +
    avg(r.steps).toFixed(1).padStart(7) +
    avg(r.tools).toFixed(1).padStart(7) +
    Math.round(out).toString().padStart(9) +
    Math.round(avg(r.reason)).toString().padStart(8) +
    (ms > 0 ? (out / (ms / 1000)).toFixed(0) : "-").padStart(7),
  );
}
