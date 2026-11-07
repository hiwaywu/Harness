// inspect-asar.mjs - read specific runtime files out of a packed asar and report policy markers.
import { readFileSync } from "node:fs";

const asar = process.argv[2];
if (!asar) { console.error("usage: node inspect-asar.mjs <app.asar>"); process.exit(1); }

const buf = readFileSync(asar);
const headerPayload = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString("utf8"));
const dataStart = 8 + headerPayload;

function read(path) {
  let node = header;
  for (const key of path.split("/")) {
    if (!node.files || !node.files[key]) return null;
    node = node.files[key];
  }
  if (node.unpacked) return readFileSync(asar + ".unpacked/" + path, "utf8");
  const start = dataStart + Number(node.offset);
  return buf.subarray(start, start + Number(node.size)).toString("utf8");
}

const NM = "dsh/node_modules/@deepseek-ai";
const CHECKS = [
  ["identity sentence gone",  `${NM}/dsh-system-prompt/lib/index.js`, "You are an AI agent powered by DeepSeek Harness", false],
  ["identity section off",    `${NM}/dsh-system-prompt/lib/index.js`, "includeHarnessIdentity: z.boolean().default(false)", true],
  ["approval autogrant",      `${NM}/dsh-user-approval/lib/index.js`, "allowed-once", true],
  ["approval sentence gone",  `${NM}/dsh-user-approval/lib/index.js`, "Approval policy: ask", false],
  ["sandbox default open",    `${NM}/dsh-sandbox-policy/lib/index.js`, "danger-full-access", true],
  ["sandbox read-only gone",  `${NM}/dsh-sandbox-policy/lib/index.js`, 'default("read-only")', false],
  // The patch writes app.setPath("userData", join(dirname(process.execPath), "userdata")) — the old
  // needle "dsh-nopolicy" came from an earlier home-naming scheme and never matched the final patch.
  ["userData isolation",      "lib/main.js", 'setPath("userData"', true],
  // still-live policy
  ["read-before-edit guard",  `${NM}/dsh-fs-observation-policy/lib/index.js`, "FS_NOT_OBSERVED", true],
  ["web untrusted framing",   `${NM}/dsh-tool-web/lib/index.js`, "untrusted data", true],
  // Upstream no longer ships the literal "Approval policy" in presets (it lives in dsh-user-approval,
  // where approval-sentence-ask already neutralises it); the presets still expose approval switches.
  ["permission presets text", `${NM}/dsh-permission-presets/lib/index.js`, "approval", true],
  // is it still a working harness — tool names are read/write/edit as of this app version
  ["tool: fs",                `${NM}/dsh-tool-fs/lib/index.js`, '"edit"', true],
  ["tool: bash",              `${NM}/dsh-tool-bash/lib/index.js`, "bash", true],
  ["prompt registry",         `${NM}/dsh-system-prompt/lib/index.js`, "system-prompt/assemble", true],
];

let ok = 0;
for (const [label, file, needle, want] of CHECKS) {
  const text = read(file);
  if (text === null) { console.log(`MISSING FILE  ${label.padEnd(24)} ${file}`); continue; }
  const has = text.includes(needle);
  const pass = has === want;
  if (pass) ok += 1;
  console.log(`${pass ? "ok  " : "MISMATCH"}  ${label.padEnd(24)} present=${String(has).padEnd(5)} wanted=${want}`);
}
console.log(`\n${ok}/${CHECKS.length} as expected`);
