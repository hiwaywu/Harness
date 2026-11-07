# preview/ — run the prompt-picker extension without the harness

The Settings row from `plugin/dsh-prompt-picker` normally needs the patched app (asar rebuild +
mount entry). This directory renders and drives the same code outside it, so the UI and the routes can
be tested in seconds instead of a 372 MB rebuild cycle.

```
node preview/server.mjs          # http://127.0.0.1:9188/   (?locale=en for English)
```

## What is real vs mocked

| piece | real? |
|---|---|
| `plugin/dsh-prompt-picker/lib/index.js` (`apply(ctx)`, all six routes) | **real, imported and mounted** |
| `plugin/dsh-prompt-picker/lib/client.js` (component, hooks, fetch calls) | **real, served verbatim, executed in the browser** |
| prompt files | `preview/home/prompts/` — copies of the repo's `prompts/` |
| host services `ctx.webServer / connection / locale / slots` | mocked (thinnest objects the extension calls) |
| React | `preview/runtime.js` micro-shim (`useState`, `useEffect`, `jsx-runtime`) |
| auth fence | off — the app's `connection.requestRejection` is stubbed to allow |

`DSH_HOME` is pointed at `preview/home`, which is exactly how the extension resolves its home in the
app, so `prompt-active.txt` / `anchor-active.txt` writes land in the fixture and never in a live
install.

## Routes exercised

```
GET  /prompt-picker/list
GET  /prompt-picker/read?name=<file>
GET  /prompt-picker/status[?model=<id>]
POST /prompt-picker/set          {"name":"<file>"}
POST /prompt-picker/new          {"name":"x.md","from":"<file>"}
POST /prompt-picker/set-anchor   {"name":"anchor-*.md"}
```

Smoke test:

```powershell
Invoke-WebRequest http://127.0.0.1:9188/prompt-picker/list -UseBasicParsing
curl.exe -s -X POST http://127.0.0.1:9188/prompt-picker/set -H "content-type: application/json" -d "{\"name\":\"plugin-en.md\"}"
Get-Content preview\home\prompt-active.txt      # single-click truth, not the UI
```

## Screenshots

`shot-en.png`, `shot-zh.png` — rendered with Edge headless:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu `
  --window-size=1180,820 --virtual-time-budget=4000 --screenshot=preview\shot-en.png `
  "http://127.0.0.1:9188/?locale=en"
```

## Limits

The shim is not React: no `key` reconciliation, no memo, no concurrent rendering, and a re-render
rebuilds the subtree (state survives because hook slots are keyed by index). It proves the component
mounts, its hooks run in a stable order, and its fetches hit working routes — it does not prove the
row inherits real Settings layout/theme, or that `settings.general.item` is the right slot id in the
app (that is asserted by the built app, not here).
