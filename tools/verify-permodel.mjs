// verify-permodel.mjs - confirm the operator prompt is wired per model.
import { readFileSync } from "node:fs";

const asar = process.argv[2];
const buf = readFileSync(asar);
const hp = buf.readUInt32LE(4);
const jl = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + jl).toString("utf8"));
const ds = 8 + hp;

function read(path) {
  let n = header;
  for (const k of path.split("/")) {
    if (!n.files || !n.files[k]) return null;
    n = n.files[k];
  }
  if (n.unpacked) { try { return readFileSync(asar + ".unpacked/" + path, "utf8"); } catch { return null; } }
  const s = ds + Number(n.offset);
  return buf.subarray(s, s + Number(n.size)).toString("utf8");
}

const NM = "dsh/node_modules/@deepseek-ai";
const sp = read(`${NM}/dsh-system-prompt/lib/index.js`) || "";
const plugin = read(`${NM}/dsh-prompt-picker/lib/index.js`) || "";
const client = read(`${NM}/dsh-prompt-picker/lib/client.js`) || "";
const manifest = read(`${NM}/dsh/package.json`) || "";

const checks = [
  ["reads prompt-map.json", sp.includes("prompt-map.json")],
  ["per-model resolver", sp.includes("__npPromptForModel")],
  ["registered as context", sp.includes("this.context({") && sp.includes("dsh-nopolicy:operator")],
  ["reads assembly model", sp.includes("assembly.agent")],
  ["never-empty fallback chain", sp.includes("prompt-inject.md") && sp.includes("default.md")],
  ["host identity removed", !sp.includes("You are an AI agent powered by DeepSeek Harness")],
  ["picker plugin declared", manifest.includes("dsh-prompt-picker")],
  ["picker status route", plugin.includes("/prompt-picker/status")],
  ["picker list route", plugin.includes("/prompt-picker/list")],
  ["picker set route", plugin.includes("/prompt-picker/set")],
  ["client registed settings row", client.includes("settings.general.item")],
];
let ok = 0;
for (const [label, pass] of checks) { if (pass) ok += 1; console.log(`${pass ? "ok  " : "FAIL"}  ${label}`); }
console.log(`\n${ok}/${checks.length}`);
