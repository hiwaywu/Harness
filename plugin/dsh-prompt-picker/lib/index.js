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
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const PREVIEW_CHARS = 1200;

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
      .filter((f) => f.toLowerCase().endsWith(".md") && !f.toLowerCase().startsWith("anchor"))
      .sort();
  } catch {}
  let active = "";
  try {
    active = readFileSync(activeFile(), "utf8").trim();
  } catch {}
  if (!names.includes(active)) active = names.includes("default.md") ? "default.md" : names[0] || "";
  return { names, active, anchors: anchorNames(), activeAnchor: activeAnchor() };
}

/** Anchor files are switchable separately from the operator prompt: anchor-*.md plus anchor.md. */
function anchorNames() {
  let names = [];
  try {
    names = readdirSync(promptsDir())
      .filter((f) => f.toLowerCase().endsWith(".md") && f.toLowerCase().startsWith("anchor"))
      .sort();
  } catch {}
  if (!names.includes("anchor.md")) names.unshift("anchor.md");
  return names;
}

function activeAnchor() {
  let name = "";
  try { name = readFileSync(join(home(), "anchor-active.txt"), "utf8").trim(); } catch {}
  const names = anchorNames();
  if (!names.includes(name)) name = names.includes("anchor.md") ? "anchor.md" : names[0] || "";
  return name;
}

/**
 * What the system prompt will actually load for one model, mirroring __npPromptFiles():
 * model key in prompt-map.json -> map.default -> prompt-active.txt -> prompts/default.md ->
 * home/prompt-inject.md -> any other .md. First non-empty file wins.
 */
function statusFor(model) {
  const { names, active } = list();
  let map = {};
  try { map = JSON.parse(readFileSync(join(home(), "prompt-map.json"), "utf8")); } catch {}
  const candidates = [];
  const push = (name) => {
    if (typeof name !== "string" || !name.trim()) return;
    const file = join(promptsDir(), name.trim());
    if (!candidates.includes(file)) candidates.push(file);
  };
  if (model) { push(map[model]); push(map[String(model).toLowerCase()]); }
  push(map.default);
  push(active);
  push("default.md");
  candidates.push(join(home(), "prompt-inject.md"));
  for (const name of names) {
    const file = join(promptsDir(), name);
    if (!candidates.includes(file)) candidates.push(file);
  }
  for (const file of candidates) {
    try {
      const text = readFileSync(file, "utf8");
      if (text.trim()) {
        return {
          active,
          resolved: file,
          source: file === join(promptsDir(), String(map[model] || "")) ? "model-map"
            : file === join(promptsDir(), String(map.default || "")) ? "map-default"
            : file === join(promptsDir(), active) ? "selection"
            : file.endsWith("prompt-inject.md") ? "legacy"
            : "fallback",
          bytes: text.length,
          head: text.trim().slice(0, 80),
          names,
          home: home(),
        };
      }
    } catch {}
  }
  return { active, resolved: null, bytes: 0, head: "", names, home: home(), error: "no non-empty prompt file found" };
}

function status() {
  return statusFor("");
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

  // GET /prompt-picker/read?name=<file> -> the first PREVIEW_CHARS of that prompt, so the settings
  // row can show what the file actually says instead of it being a mystery.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/prompt-picker/read",
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== "GET") { json(res, 405, { ok: false, error: "GET only" }); return; }
        let name = "";
        try { name = (new URL(req.url, "http://127.0.0.1").searchParams.get("name") || "").trim(); } catch {}
        const { names } = list();
        if (!name || !names.includes(name)) { json(res, 400, { ok: false, error: "unknown prompt: " + name, names }); return; }
        try {
          const text = readFileSync(join(promptsDir(), name), "utf8");
          json(res, 200, {
            ok: true,
            name,
            bytes: text.length,
            lines: text.split("\n").length,
            text: text.slice(0, PREVIEW_CHARS),
            truncated: text.length > PREVIEW_CHARS,
          });
        } catch (error) {
          json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      },
    }),
  "prompt-picker: GET /prompt-picker/read");

  // POST /prompt-picker/new  body {"name":"x.md","from":"<file>?"} -> create a prompt file.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/prompt-picker/new",
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== "POST") { json(res, 405, { ok: false, error: "POST only" }); return; }
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch {
          json(res, 400, { ok: false, error: "expected JSON body {\"name\": \"<file>.md\"}" });
          return;
        }
        let name = String(body.name || "").trim();
        if (!name.toLowerCase().endsWith(".md")) name += ".md";
        if (!/^[A-Za-z0-9._-]{1,64}\.md$/.test(name) || name.startsWith(".")) {
          json(res, 400, { ok: false, error: "name must be 1-64 chars of letters, digits, dot, dash, underscore, ending .md" });
          return;
        }
        const file = join(promptsDir(), name);
        if (existsSync(file)) { json(res, 409, { ok: false, error: "already exists: " + name, names: list().names }); return; }
        try {
          mkdirSync(promptsDir(), { recursive: true });
          let seedText = "";
          const from = String(body.from || "").trim();
          if (from && list().names.includes(from)) seedText = readFileSync(join(promptsDir(), from), "utf8");
          if (!seedText) seedText = "# " + name.replace(/\.md$/i, "") + "\n\n";
          writeFileSync(file, seedText, "utf8");
          json(res, 200, { ok: true, name, names: list().names });
        } catch (error) {
          json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      },
    }),
  "prompt-picker: POST /prompt-picker/new");

  // POST /prompt-picker/set-anchor  body {"name":"anchor-*.md"} -> switch the tail anchor only.
  // This is the A/B switch: plugin's original anchor vs the amended one, head prompt untouched.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/prompt-picker/set-anchor",
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== "POST") { json(res, 405, { ok: false, error: "POST only" }); return; }
        let want = "";
        try { want = String(JSON.parse(await readBody(req)).name || "").trim(); } catch {
          json(res, 400, { ok: false, error: "expected JSON body {\"name\": \"<anchor>.md\"}" });
          return;
        }
        const names = anchorNames();
        if (!want || !names.includes(want)) { json(res, 400, { ok: false, error: "unknown anchor: " + want, anchors: names }); return; }
        try {
          writeFileSync(join(home(), "anchor-active.txt"), want, "utf8");
          json(res, 200, { ok: true, activeAnchor: want, anchors: names });
        } catch (error) {
          json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      },
    }),
  "prompt-picker: POST /prompt-picker/set-anchor");

  // GET /prompt-picker/status?model=<id> -> which file the assembler would load for that model.
  // This is the observability hook: it answers "is the prompt actually wired?" without guessing.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/prompt-picker/status",
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== "GET") { json(res, 405, { ok: false, error: "GET only" }); return; }
        let model = "";
        try { model = (new URL(req.url, "http://127.0.0.1").searchParams.get("model") || "").trim(); } catch {}
        let map = {};
        try { map = JSON.parse(readFileSync(join(home(), "prompt-map.json"), "utf8")); } catch {}
        const body = statusFor(model);
        body.model = model || null;
        body.map = map;
        json(res, 200, body);
      },
    }),
  "prompt-picker: GET /prompt-picker/status");

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
