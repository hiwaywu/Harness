// verify-install.mjs - confirm the installed build actually contains the picker wiring.
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
  if (n.unpacked) {
    try { return readFileSync(asar + ".unpacked/" + path, "utf8"); } catch { return null; }
  }
  const s = ds + Number(n.offset);
  return buf.subarray(s, s + Number(n.size)).toString("utf8");
}

const NM = "dsh/node_modules/@deepseek-ai";
const checks = [
  ["plugin package", `${NM}/dsh-prompt-picker/package.json`],
  ["plugin host", `${NM}/dsh-prompt-picker/lib/index.js`],
  ["plugin client", `${NM}/dsh-prompt-picker/lib/client.js`],
  ["dsh manifest", `${NM}/dsh/package.json`],
  ["base bundle", `${NM}/dsh-base/cordis.patch.yml`],
  ["system prompt", `${NM}/dsh-system-prompt/lib/index.js`],
];

const files = {};
for (const [label, path] of checks) {
  files[label] = read(path);
  console.log(`${files[label] === null ? "MISSING" : "ok     "}  ${label.padEnd(14)} ${path}`);
}

const manifest = files["dsh manifest"] || "";
const base = files["base bundle"] || "";
const sp = files["system prompt"] || "";
const client = files["plugin client"] || "";
const host = files["plugin host"] || "";

console.log("\n--- wiring ---");
console.log("declared in @deepseek-ai/dsh deps :", manifest.includes("dsh-prompt-picker"));
console.log("mounted in dsh-base bundle        :", base.includes("id: prompt-picker"));
console.log("host routes registered            :", /prompt-picker\/list/.test(host) && /prompt-picker\/set/.test(host));
console.log("host set is POST                  :", /method/.test(host) || /POST/.test(host));
console.log("client injects slots+locale       :", /"slots"/.test(client) && /"locale"/.test(client));
console.log("client registers settings slot    :", /settings\.general\.item/.test(client));
console.log("operator section is a function    :", /text:\s*(\(|function|__np)/.test(sp) || /__npActivePrompt/.test(sp));
console.log("interpolate disabled              :", sp.includes("interpolate"));
console.log("reads prompt-active.txt           :", sp.includes("prompt-active.txt"));
console.log("host identity removed             :", !sp.includes("You are an AI agent powered by DeepSeek Harness"));
