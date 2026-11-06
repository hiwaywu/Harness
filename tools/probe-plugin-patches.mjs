// probe-plugin-patches.mjs - how many of dsh-purge's 86 patches actually match THIS rc.5 tree?
//
// Imports ALL_PATCHES straight out of the extracted plugin, resolves each patch's module name to a
// file in the extracted app tree, and tests the literal/regex patterns. Read-only.
//
//   node tools/probe-plugin-patches.mjs <pluginRoot> <appRoot>
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

const [pluginRoot, appRoot] = process.argv.slice(2);
if (!pluginRoot || !appRoot) {
  console.error("usage: node tools/probe-plugin-patches.mjs <pluginRoot> <appRoot>");
  process.exit(1);
}

const core = await import(pathToFileURL(join(pluginRoot, "lib", "core.js")).href);
const patches = core.ALL_PATCHES;
console.log(`plugin patches: ${patches.length}`);

// index every candidate module file once
const files = [];
(function walk(dir, depth) {
  if (depth > 6) return;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (name === "node_modules" || name.startsWith("@") || depth < 5) walk(full, depth + 1);
    } else if (name === "index.js" || name === "client.js") {
      files.push({ path: full, text: null });
    }
  }
})(appRoot, 0);
console.log(`candidate module files: ${files.length}`);

const textOf = (entry) => {
  if (entry.text === null) { try { entry.text = readFileSync(entry.path, "utf8"); } catch { entry.text = ""; } }
  return entry.text;
};

/** Resolve a plugin module name to files by path fragment, mirroring the plugin's aliases. */
function candidatesFor(moduleName) {
  const aliases = {
    "pi-ai-completions": ["pi-ai", "openai-completions"],
    "pi-ai-responses-shared": ["pi-ai"],
    "pi-ai-anthropic-messages": ["pi-ai", "anthropic-messages"],
    "conversation-client": ["dsh-client-ui-conversation"],
    session: ["dsh-session-format"],
    "system-prompt": ["dsh-system-prompt"],
    "system-prompt-nested": ["dsh-system-prompt"],
    "llm-deepseek": ["dsh-llm-deepseek"],
  };
  const needles = aliases[moduleName] || [moduleName];
  return files.filter((f) => needles.every((n) => f.path.includes(n)));
}

function patternHits(pattern, text) {
  try {
    if (pattern instanceof RegExp) {
      const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
      const re = new RegExp(pattern.source, flags);
      return (text.match(re) || []).length;
    }
    if (typeof pattern === "string" && pattern.length > 0) {
      return text.split(pattern).length - 1;
    }
  } catch {}
  return 0;
}

const rows = [];
for (const patch of patches) {
  const modules = Array.isArray(patch.file) ? patch.file : [patch.file].filter(Boolean);
  const reps = Array.isArray(patch.replacements) ? patch.replacements : [];
  let best = { module: null, hits: 0 };
  for (const module of modules) {
    for (const cand of candidatesFor(module)) {
      const text = textOf(cand);
      if (!text) continue;
      let hits = 0;
      for (const rep of reps) if (patternHits(rep.pattern, text) > 0) hits += 1;
      if (hits > best.hits) best = { module, hits, path: cand.path };
    }
  }
  rows.push({ id: patch.id, name: patch.name, layer: patch.layer_en || patch.layer, reps: reps.length, ...best });
}

const applicable = rows.filter((r) => r.hits > 0);
const total = rows.filter((r) => r.reps > 0);
console.log(`\npatches with replacements: ${total.length}`);
console.log(`patterns matching this tree: ${applicable.length}`);
console.log(`patterns NOT matching:       ${total.length - applicable.length}`);

console.log("\n=== would apply here ===");
for (const r of applicable.sort((a, b) => a.id - b.id)) {
  console.log(`  #${String(r.id).padEnd(3)} ${String(r.name).padEnd(34)} ${r.hits}/${r.reps} matched  ${r.module}`);
}

console.log("\n=== would NOT apply (anchor drift) ===");
for (const r of total.filter((x) => x.hits === 0).sort((a, b) => a.id - b.id)) {
  console.log(`  #${String(r.id).padEnd(3)} ${String(r.name).padEnd(34)} ${r.reps} patterns  ${(r.module || (Array.isArray(r.module) ? "" : "")) || "no module resolved"}`);
}
