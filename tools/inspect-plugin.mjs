// inspect-plugin.mjs - why did dsh-prompt-picker not load?
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
  if (n.unpacked) return readFileSync(asar + ".unpacked/" + path, "utf8");
  const s = ds + Number(n.offset);
  return buf.subarray(s, s + Number(n.size)).toString("utf8");
}

console.log("plugin package in asar :", !!read("node_modules/dsh-prompt-picker/package.json"));
console.log("plugin host code       :", !!read("node_modules/dsh-prompt-picker/lib/index.js"));

const base = read("dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml") || "";
console.log("mount row present      :", base.includes("id: prompt-picker"));

// which id does the webserver plugin use, and is it enabled in the base bundle?
const lines = base.split("\n");
for (let i = 0; i < lines.length; i += 1) {
  if (/webserver|host-webserver/i.test(lines[i])) {
    console.log("webserver row          :", lines.slice(Math.max(0, i - 2), i + 2).join(" | ").trim());
  }
}

// tail of the yaml, to confirm our append is still valid YAML structure
console.log("\n--- last 12 lines of dsh-base/cordis.patch.yml ---");
console.log(lines.slice(-12).join("\n"));
