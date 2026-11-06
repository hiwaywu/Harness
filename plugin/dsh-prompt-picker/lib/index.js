/**
 * @deepseek-ai/dsh-prompt-picker (host side)
 *
 * Two exact HTTP routes on the harness's own web server, behind the same trust fence
 * (connection.requestRejection) every built-in route uses:
 *   GET  /prompt-picker/list -> { names: string[], active: string }
 *   POST /prompt-picker/set  body {"name":"<file>.md"} -> { ok: true, active } | { ok: false, error }
 *
 * The selection is persisted as a filename in <DSH_HOME>/prompt-active.txt, which
 * dsh-system-prompt reads (patched) when a new session assembles its system prompt.
 *
 * Activation requires this package to be a dependency of dsh/package.json: the loader only
 * resolves names reachable from the install anchor's dependency graph (build.ps1 adds it).
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

export const name = "prompt-picker";
export const inject = ["webServer", "connection"];

function home() {
  const fromEnv = (process.env.DSH_HOME || "").trim();
  return fromEnv || join(dirname(process.execPath), "home");
}

const promptsDir = () => join(home(), "prompts");
const activeFile = () => join(home(), "prompt-active.txt");

function list() {
  let names = [];
  try {
    names = readdirSync(promptsDir())
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch {}
  let active = "";
  try {
    active = readFileSync(activeFile(), "utf8").trim();
  } catch {}
  if (!names.includes(active)) active = names.includes("default.md") ? "default.md" : names[0] || "";
  return { names, active };
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function apply(ctx) {
  const rejected = (req, res) => {
    const rejection = Reflect.get(ctx, "connection").requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/prompt-picker/list",
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== "GET") { json(res, 405, { ok: false, error: "GET only" }); return; }
        json(res, 200, list());
      },
    }),
  "prompt-picker: GET /prompt-picker/list");

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/prompt-picker/set",
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== "POST") { json(res, 405, { ok: false, error: "POST only" }); return; }
        let want = "";
        try {
          want = String(JSON.parse(await readBody(req)).name || "").trim();
        } catch {
          json(res, 400, { ok: false, error: "expected JSON body {\"name\": \"<file>.md\"}" });
          return;
        }
        const { names } = list();
        // Only names that exist in the listing: no paths, no traversal.
        if (!want || !names.includes(want)) {
          json(res, 400, { ok: false, error: "unknown prompt: " + want, names });
          return;
        }
        try {
          writeFileSync(activeFile(), want, "utf8");
        } catch (error) {
          json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
          return;
        }
        json(res, 200, { ok: true, active: want });
      },
    }),
  "prompt-picker: POST /prompt-picker/set");
}
