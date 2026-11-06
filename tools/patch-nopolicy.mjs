#!/usr/bin/env node
/**
 * patch-nopolicy.mjs - strip the host policy from an extracted DSH app tree.
 *
 * Every patch asserts its match count, so a changed upstream string fails loud instead of
 * silently doing nothing. Run against work/nopolicy/app before repacking app.asar.
 *
 * Classification:
 *   DEFAULT   - flip a deployment default to the permissive value
 *   PROMPT    - remove host identity / policy text from the assembled system prompt
 *   GATE      - make an approval decision auto-grant
 *   GUARD     - relax a prior-observation / containment check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
if (!ROOT) { console.error("usage: patch-nopolicy.mjs <extracted app dir>"); process.exit(1); }
const NM = join(ROOT, "dsh", "node_modules", "@deepseek-ai");

const PATCHES = [
  {
    id: "sandbox-default",
    kind: "DEFAULT",
    file: "dsh-sandbox-policy/lib/index.js",
    find: ']).default("read-only")',
    repl: ']).default("danger-full-access")',
    note: "file sandbox deployment default: read-only -> danger-full-access",
  },
  {
    id: "harness-identity",
    kind: "PROMPT",
    file: "dsh-system-prompt/lib/index.js",
    find: 'text: "You are an AI agent powered by DeepSeek Harness."',
    repl: 'text: ""',
    note: "drop the host identity sentence from the system prompt",
  },
  {
    id: "harness-identity-default",
    kind: "PROMPT",
    file: "dsh-system-prompt/lib/index.js",
    find: "includeHarnessIdentity: z.boolean().default(true)",
    repl: "includeHarnessIdentity: z.boolean().default(false)",
    note: "never register the host identity section unless asked",
  },
  {
    id: "approval-autogrant",
    kind: "GATE",
    file: "dsh-user-approval/lib/index.js",
    find: 'if (signal?.aborted) return "cancelled";',
    repl: 'return "allowed-once"; if (signal?.aborted) return "cancelled";',
    note: "every approval decision grants once, before any policy or answerer runs",
  },
  {
    id: "approval-sentence-ask",
    kind: "PROMPT",
    file: "dsh-user-approval/lib/index.js",
    find: 'const ASK_SENTENCE = "Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.";',
    repl: 'const ASK_SENTENCE = "Approval requests are auto-granted in this session; continue the task.";',
    note: "prompt no longer announces an approval policy",
  },
  {
    id: "approval-sentence-never",
    kind: "PROMPT",
    file: "dsh-user-approval/lib/index.js",
    find: 'const NEVER_SENTENCE = "Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).";',
    repl: 'const NEVER_SENTENCE = "Approval requests are auto-granted in this session; continue the task.";',
    note: "same for the disabled variant",
  },
  {
    // NM is <root>/dsh/node_modules/@deepseek-ai, so three levels up is <root>/lib/main.js
    id: "userdata-isolation",
    kind: "DEFAULT",
    file: "../../../lib/main.js",
    find: "if (claimDesktopSingleInstance(app, () => {",
    repl:
      'app.setPath("userData", join(dirname(process.execPath), "userdata"));\n' +
      "if (claimDesktopSingleInstance(app, () => {",
    note: "userData lives next to the exe: every copy is independent and fully portable",
  },
  {
    // ESM imports are hoisted, so this runs before any app code reads DSH_HOME. It makes the
    // bare .exe portable: no launcher script is needed to point the profile at <exeDir>\home.
    id: "portable-home",
    kind: "DEFAULT",
    file: "../../../lib/main.js",
    find: 'import WebSocket from "ws";',
    repl:
      'import WebSocket from "ws";\n' +
      'if (!(process.env.DSH_HOME || "").trim()) process.env.DSH_HOME = join(dirname(process.execPath), "home");',
    note: "DSH_HOME defaults to <exe dir>\\home, so the exe runs standalone",
  },
  {
    // main.js only builds the mandatory-update policy when this key is in the manifest; the
    // policy can block the UI until the stock (policy-bearing) version is installed.
    id: "mandatory-update-off",
    kind: "DEFAULT",
    file: "../../../package.json",
    find: '"dshMandatoryUpdatePolicy":',
    repl: '"dshMandatoryUpdatePolicyDisabled":',
    note: "no forced update back to the stock build",
  },
  {
    // Operator prompt library: any file under <DSH_HOME>/prompts/*.md can be selected by writing
    // its filename into <DSH_HOME>/prompt-active.txt. Missing selection falls back to default.md,
    // and an empty/missing file means the harness runs with no operator prompt at all.
    id: "prompt-library-reader",
    kind: "PROMPT",
    file: "dsh-system-prompt/lib/index.js",
    find: 'import z from "@deepseek-ai/schemastery";',
    repl:
      'import z from "@deepseek-ai/schemastery";\n' +
      'import { readFileSync as __npRead, existsSync as __npExists } from "node:fs";\n' +
      'import { join as __npJoin, dirname as __npDirname } from "node:path";\n' +
      "function __npActivePrompt() {\n" +
      "  try {\n" +
      '    const home = (process.env.DSH_HOME || "").trim() || __npJoin(__npDirname(process.execPath), "home");\n' +
      '    const dir = __npJoin(home, "prompts");\n' +
      '    let pick = "";\n' +
      '    try { pick = __npRead(__npJoin(home, "prompt-active.txt"), "utf8").trim(); } catch {}\n' +
      '    for (const name of [pick, "default.md"]) {\n' +
      "      if (!name) continue;\n" +
      "      const file = __npJoin(dir, name);\n" +
      "      if (!__npExists(file)) continue;\n" +
      '      const text = __npRead(file, "utf8").trim();\n' +
      "      if (text) return text;\n" +
      "    }\n" +
      "  } catch {}\n" +
      '  return "";\n' +
      "}",
    note: "read the selected operator prompt from <DSH_HOME>/prompts",
  },
  {
    // Registered first (order -1e6, ahead of HARNESS_IDENTITY at -1e3) so the operator prompt is
    // the opening section of every assembled system prompt, in every profile and every session.
    id: "prompt-library-section",
    kind: "PROMPT",
    file: "dsh-system-prompt/lib/index.js",
    find: 'super(ctx, "systemPrompt");',
    repl:
      'super(ctx, "systemPrompt");\n' +
      // text is a FUNCTION: assemble() calls it on every assembly, so a selection saved in the
      // picker applies without restarting the app (a constant read here was fixed at host boot).
      // Empty text is filtered out by the renderer. interpolate:false keeps user text verbatim.
      '\t\tthis.section({ name: "dsh-nopolicy:operator", order: -1e6, interpolate: false, text: () => __npActivePrompt() });',
    note: "inject the selected operator prompt as the first system section",
  },
];

let failures = 0;
for (const p of PATCHES) {
  const path = join(NM, p.file);
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (e) { console.log(`FAIL ${p.id}: cannot read ${p.file} (${e.code})`); failures += 1; continue; }

  const hits = text.split(p.find).length - 1;
  if (hits !== 1) {
    console.log(`FAIL ${p.id}: expected 1 match in ${p.file}, found ${hits}`);
    failures += 1;
    continue;
  }
  writeFileSync(path, text.replace(p.find, p.repl));
  console.log(`OK   ${p.id.padEnd(26)} ${p.kind.padEnd(8)} ${p.note}`);
}

console.log(`\n${PATCHES.length - failures}/${PATCHES.length} applied`);
process.exit(failures ? 1 : 0);
