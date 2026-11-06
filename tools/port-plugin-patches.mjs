// port-plugin-patches.mjs - apply dsh-purge's own patches to THIS rc.5 tree.
//
// Imports ALL_PATCHES from the extracted plugin (MIT, HunYiSage/dsh-purge), resolves each patch's
// module name to a file in the extracted app, and applies every replacement whose pattern is found.
// Asserted per replacement: a pattern that does not match is reported, never silently skipped.
//
//   node tools/port-plugin-patches.mjs <pluginRoot> <appRoot> [--dry]
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2).filter((a) => a !== "--dry");
const dry = process.argv.includes("--dry");
const [pluginRoot, appRoot] = args;
if (!pluginRoot || !appRoot) {
  console.error("usage: node tools/port-plugin-patches.mjs <pluginRoot> <appRoot> [--dry]");
  process.exit(1);
}

const core = await import(pathToFileURL(join(pluginRoot, "lib", "core.js")).href);
// Patches deliberately NOT ported. These touch the agent loop, streaming, session queue and rewind
// internals rather than refusal policy. They matched only partially against rc.5 and produced a
// real regression: a sent message rendered as "thinking" and never appeared until the session was
// re-opened. Policy patches are safe to port; stream/loop surgery is not.
const DENY = new Set([
  55,   // SYSTEM_PROMPT_REPLACE_HEAD
  56,   // REWIND_HIDE_CUT_ONLY
  66,   // SYSTEM_PROMPT_RENDER_GUARD
  67,   // AGENT_LOOP_MESSAGES_GUARD
  68,   // SYSTEM_NODES_CONTENT_GUARD
  74,   // ASSEMBLE_BEFORE_PRESTEP
  75,   // REWIND_RESET_TODOS
  77,   // REWIND_DROP_SENT_ON_APPEND
  85,   // SESSION_PROMPT_ALWAYS_FOLLOWUP
  86,   // SESSION_QUEUE_STEER_INTERRUPT
  87,   // HUNG_PROMPT_LF_NEEDLE
  69,   // MODEL_STREAM_RELEASE
  78,   // OVERLAY_RESTORE_FROM_BAK
]);

const patches = core.ALL_PATCHES.filter((p) => !DENY.has(p.id));

// ---- index candidate module files -------------------------------------------------------------
const files = [];
(function walk(dir, depth) {
  if (depth > 6) return;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, depth + 1);
    else if (name === "index.js" || name === "client.js") files.push({ path: full, text: null });
  }
})(appRoot, 0);

const ALIASES = {
  "pi-ai-completions": ["pi-ai", "openai-completions"],
  "pi-ai-responses-shared": ["pi-ai"],
  "pi-ai-anthropic-messages": ["pi-ai", "anthropic-messages"],
  "conversation-client": ["dsh-client-ui-conversation"],
  session: ["dsh-session-format"],
  "system-prompt": ["dsh-system-prompt"],
  "system-prompt-nested": ["dsh-system-prompt"],
  "llm-deepseek": ["dsh-llm-deepseek"],
};

const textOf = (entry) => {
  if (entry.text === null) { try { entry.text = readFileSync(entry.path, "utf8"); } catch { entry.text = ""; } }
  return entry.text;
};

function candidatesFor(moduleName) {
  const needles = ALIASES[moduleName] || [moduleName];
  return files.filter((f) => needles.every((n) => f.path.includes(n)));
}

function countHits(pattern, text) {
  try {
    if (pattern instanceof RegExp) {
      const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
      return (text.match(re) || []).length;
    }
    if (typeof pattern === "string" && pattern.length) return text.split(pattern).length - 1;
  } catch {}
  return 0;
}

function replaceOnce(pattern, text) {
  if (pattern instanceof RegExp) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let done = false;
    return text.replace(re, (...m) => { if (done) return m[0]; done = true; return m[0]; });
  }
  return text;
}

// ---- apply -------------------------------------------------------------------------------------
const report = { applied: [], partial: [], missed: [], unresolved: [] };

for (const patch of patches) {
  const modules = Array.isArray(patch.file) ? patch.file : [patch.file].filter(Boolean);
  const reps = (patch.replacements || []).filter((r) => r && r.pattern !== undefined);
  if (reps.length === 0) continue;

  // pick the single best candidate file for this patch
  let best = null;
  for (const module of modules) {
    for (const cand of candidatesFor(module)) {
      const text = textOf(cand);
      if (!text) continue;
      let hits = 0;
      for (const r of reps) if (countHits(r.pattern, text) > 0) hits += 1;
      if (!best || hits > best.hits) best = { cand, hits, module };
    }
  }
  if (!best || best.hits === 0) { report.unresolved.push(`#${patch.id} ${patch.name}`); continue; }

  let text = textOf(best.cand);
  let applied = 0;
  const missed = [];
  for (const rep of reps) {
    const hits = countHits(rep.pattern, text);
    if (hits === 0) { missed.push(rep); continue; }
    if (rep.pattern instanceof RegExp) {
      text = text.replace(rep.pattern, rep.replace);
    } else {
      // literal: replace every occurrence, matching the plugin's own replaceAll semantics
      text = text.split(rep.pattern).join(rep.replace);
    }
    applied += 1;
  }

  if (applied > 0 && !dry) writeFileSync(best.cand.path, text);
  const label = `#${patch.id} ${patch.name}`;
  if (missed.length === 0) report.applied.push(label);
  else report.partial.push(`${label} (${applied}/${reps.length})`);
}

const rel = (p) => p.replace(appRoot + "\\", "").replace(appRoot + "/", "");
console.log(`plugin patches total: ${patches.length}`);
console.log(`applied fully       : ${report.applied.length}`);
console.log(`applied partially   : ${report.partial.length}`);
console.log(`no pattern matched  : ${report.unresolved.length}${dry ? "  (dry run)" : ""}`);
console.log("");
for (const line of report.applied) console.log("  full   " + line);
for (const line of report.partial) console.log("  part   " + line);
for (const line of report.unresolved) console.log("  none   " + line);
