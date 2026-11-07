/**
 * preview/server.mjs — run the prompt-picker extension without the harness.
 *
 * What is real here:
 *   - plugin/dsh-prompt-picker/lib/index.js  is imported and apply(ctx) is called for real, so every
 *     host route (/list, /read, /new, /set, /set-anchor, /status) is the shipped handler code.
 *   - plugin/dsh-prompt-picker/lib/client.js  is served verbatim and executed in the browser.
 *   - the prompt files are the repo's own prompts/, copied into preview/home/prompts/.
 *
 * What is mocked:
 *   - ctx.webServer / ctx.connection / ctx.locale / ctx.slots — the four host services, replaced by
 *     the thinnest objects the extension actually calls.
 *
 * Usage:  node preview/server.mjs [port]        (default 9188)
 *         open http://127.0.0.1:9188/
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const homeDir = join(here, "home");
const port = Number(process.argv[2] || 9188);

process.env.DSH_HOME = homeDir; // the extension resolves its home exactly as in the app

const plugin = await import(pathToFileURL(join(repo, "plugin", "dsh-prompt-picker", "lib", "index.js")).href);

const routes = new Map();
const ctx = {
  effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {}; },
  webServer: {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  },
  connection: { requestRejection: () => undefined }, // preview has no auth fence; the app's does
};
plugin.apply(ctx);

const clientSource = readFileSync(join(repo, "plugin", "dsh-prompt-picker", "lib", "client.js"));
const runtimeSource = readFileSync(join(here, "runtime.js"));

const page = `<!doctype html>
<meta charset="utf-8">
<title>dsh-prompt-picker — extension preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.45 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
         background: #14161a; color: #e6e8eb; }
  header { padding: 14px 22px 10px; border-bottom: 1px solid rgba(127,127,127,.25); }
  header h1 { margin: 0 0 3px; font-size: 15px; font-weight: 650; }
  header .sub { opacity: .62; font-size: 12px; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 10px 22px; font-size: 12px;
         border-bottom: 1px solid rgba(127,127,127,.15); }
  .bar button { background: #23272e; color: #e6e8eb; border: 1px solid rgba(127,127,127,.35);
                border-radius: 6px; padding: 3px 10px; cursor: pointer; }
  .bar button:disabled { opacity: .45; cursor: default; }
  main { padding: 4px 22px 22px; }
  .panel { border: 1px solid rgba(127,127,127,.25); border-radius: 8px; padding: 4px 14px 12px;
           background: rgba(255,255,255,.02); }
  .panel > .rowlabel { font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
                       opacity: .45; padding-top: 10px; }
  footer { padding: 0 22px 26px; font-size: 11px; opacity: .7; }
  pre.json { margin: 6px 0 0; padding: 10px; background: rgba(127,127,127,.10); border-radius: 6px;
             border: 1px solid rgba(127,127,127,.22); white-space: pre-wrap; font-size: 11px;
             font-family: ui-monospace, Consolas, monospace; }
</style>
<header>
  <h1>dsh-prompt-picker — extension preview</h1>
  <div class="sub">real <code>lib/index.js</code> routes + real <code>lib/client.js</code> component, mocked host services</div>
</header>
<div class="bar">
  <span>locale:</span>
  <button id="zh">中文</button><button id="en">English</button>
  <span style="opacity:.5">|</span>
  <button id="reload">re-read /list</button>
  <span id="meta" style="opacity:.6"></span>
</div>
<main>
  <div class="panel">
    <div class="rowlabel">settings.general.item — as the row renders in Settings → General</div>
    <div id="mount"></div>
  </div>
</main>
<footer>
  <div>host truth — <code>GET /prompt-picker/status</code> (what the assembler would load):</div>
  <pre class="json" id="status">…</pre>
</footer>
<script src="/runtime.js"></script>
<script src="/client.js"></script>
<script>
  const mount = document.getElementById("mount");
  const wantLocale = (new URLSearchParams(location.search).get("locale") || "zh").toLowerCase();
  PreviewHost.boot(mount, wantLocale === "en" ? "en" : "zh");
  const meta = document.getElementById("meta");
  meta.textContent = "entry " + (PreviewHost.entryId || "?") +
    " · inject [" + (PreviewHost.injectList || []).join(", ") + "]" +
    " · slot " + (PreviewHost.spec ? PreviewHost.spec.name + "#" + PreviewHost.spec.id : "none");
  document.getElementById("zh").onclick = () => PreviewHost.setLocale("zh");
  document.getElementById("en").onclick = () => PreviewHost.setLocale("en");
  document.getElementById("reload").onclick = () => location.reload();
  fetch("/prompt-picker/status")
    .then((r) => r.json())
    .then((data) => { document.getElementById("status").textContent = JSON.stringify(data, null, 2); })
    .catch((error) => { document.getElementById("status").textContent = "status failed: " + error; });
</script>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  try {
    if (routes.has(path)) {
      const route = routes.get(path);
      Promise.resolve(route.handler(req, res)).catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(error) }));
      });
      return;
    }
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
      return;
    }
    if (path === "/client.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(clientSource);
      return;
    }
    if (path === "/runtime.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(runtimeSource);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found: " + path + "\nroutes mounted: " + [...routes.keys()].join(", "));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("preview server error: " + (error && error.stack ? error.stack : error));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("preview: http://127.0.0.1:" + port + "/");
  console.log("DSH_HOME=" + homeDir);
  console.log("routes: " + [...routes.keys()].join(", "));
});
