# HANDOFF — finish the operator-prompt picker UI

> **STATUS 2026-11-06: DONE.** Settings → General shows an "Operator prompt" row; saving writes
> `home\prompt-active.txt`; the selected file is read on every system-prompt assembly (no restart).
>
> Root causes, for the record:
> 1. **404 = package not resolvable.** The loader only resolves names reachable from the install
>    anchor's dependency graph, and the desktop host's anchor is
>    `dsh/node_modules/@deepseek-ai/dsh/package.json` (not `dsh/package.json`). `build.ps1` now adds
>    `@deepseek-ai/dsh-prompt-picker` there. Being on disk and in a bundle row is not enough: the
>    row is skipped silently.
> 2. **App crash loop after that.** The client module did not export `inject`, so `ctx.slots` /
>    `ctx.locale` were undefined, `apply` threw, and web boot treats a failed entry as FATAL
>    (`web boot: 1 entry did not activate`). Fixed (`inject = ["slots","locale"]`) and `apply` is now
>    guarded so this optional row can never take the app down again.
> 3. **Selection only applied at host boot.** The section text was read once in the `SystemPrompt`
>    constructor. It is now `text: () => __npActivePrompt()` (evaluated per assembly) with
>    `interpolate: false`, so `{{...}}` in a prompt file can no longer throw.
> 4. Routes now sit behind `connection.requestRejection` (same trust fence as built-in routes) and
>    `set` is a POST with a JSON body, so a random web page cannot switch the prompt.
>
> Verified: route 401 unauthenticated / 200 authenticated with the real file list; UI save wrote
> `plugin-en.md` to `prompt-active.txt` (then restored to `default.md`); the patched module assembled
> with a temp home switches section text a.md → b.md without restart and drops it when files are
> missing; exe upgrade kept all `home\` files. Not verified: a live model turn.
>
> Correction to the text below: "relocating the built app fails to boot even unpatched" was the asar
> numeric-offset bug, fixed earlier; relocation works.


Job for the next agent. The harness build itself works; **one feature is unfinished: a working
prompt selector in the app UI.** Fix that, verify it, stop.

Do not change the text of any file under `home/prompts/`. Those files are user-owned content. This
handoff is only about the *mechanism*: listing them, selecting one, and applying the selection.

---

## Objective

In the running app, **Settings → General** should show a row that lets the user choose which file
from `<DSH_HOME>/prompts/*.md` is used as the operator prompt, with a Save button. Saving writes the
chosen filename to `<DSH_HOME>/prompt-active.txt`. A new session then uses that file as the first
system-prompt section.

That is the whole feature. Anything that achieves it is acceptable — a settings row, a dock panel, a
slash command with a picker, or a plugin settings form. The current attempt (settings row) does not
render and its host route 404s, so the plugin is not being activated at all.

---

## Project

```
C:\AI STUFF\Claude\Harness
├── build.ps1          extract → patch → mount plugin → pack → assemble dist\dsh-nopolicy
├── package.ps1        dist\dsh-nopolicy → dist\DSH-NoPolicy.exe (WinRAR SFX, self-upgrading)
├── tools\asar-tool.mjs           asar extract/pack, no deps
├── tools\patch-nopolicy.mjs      11 asserted patches
├── tools\inspect-asar.mjs        read files out of a packed asar
├── tools\inspect-plugin.mjs      diagnose plugin presence in dsh-base + asar
├── plugin\dsh-prompt-picker\     the picker plugin (package.json, lib\index.js, lib\client.js)
└── dist\dsh-nopolicy\            the built app tree (gitignored)
```

Rebuild: `powershell -File .\build.ps1` then `powershell -File .\package.ps1`.
Install: double-click `dist\DSH-NoPolicy.exe` (closes the old copy, keeps `home\`, relaunches).

Installed location: `%LOCALAPPDATA%\Programs\DSH-NoPolicy`.
Data home: that folder's `home\` (`DSH_HOME` is forced to `<exe dir>\home` by a patch).

---

## What is already done and verified

1. **Patch pipeline** — 11 patches, each asserting its match count (`tools\patch-nopolicy.mjs`).
   Relevant to this job:
   - `prompt-library-reader` adds `__npActivePrompt()` to
     `dsh-system-prompt/lib/index.js`: reads `<DSH_HOME>/prompt-active.txt`, falls back to
     `default.md`, returns `""` if nothing usable.
   - `prompt-library-section` registers it in the `SystemPrompt` constructor as
     `{ name: "dsh-nopolicy:operator", order: -1e6 }` — ahead of `HARNESS_IDENTITY` at `-1e3`, so it
     opens every assembled system prompt.
   - `harness-identity` / `harness-identity-default` — host identity sentence removed and its section
     no longer registered, so nothing competes with the operator prompt.
   - `sandbox-default` → `danger-full-access`; `approval-autogrant` → approvals return
     `allowed-once`; approval prompt sentences neutralised.
   - `userdata-isolation` → `app.setPath("userData", join(dirname(process.execPath), "userdata"))`;
     `portable-home` → `DSH_HOME` defaults to `<exe dir>\home`; `mandatory-update-off`.
2. **Prompts are seeded** into `home\prompts\` by `build.ps1`, and `home\prompt-active.txt` is
   written with the first available name.
3. **Plugin source exists** at `plugin\dsh-prompt-picker\`:
   - `lib\index.js` — host side. Declares `export const inject = ["webServer"]` and registers two
     exact routes: `GET /prompt-picker/list` and `GET /prompt-picker/set?name=<file>`.
   - `lib\client.js` — `window.__ModuleLoader__.load({ id: "dsh-prompt-picker", factory })` bundle
     using `require("react")` + `react/jsx-runtime`, registering a component into the
     `settings.general.item` slot through `ctx.slots.inject(...)/ctx.slots.register(...)`, copied in
     style from `@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js`.
4. **Mount** — `build.ps1` copies the plugin to BOTH
   `dsh/node_modules/@deepseek-ai/dsh-prompt-picker` and `node_modules/dsh-prompt-picker`, then
   appends to `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: prompt-picker
         name: '@deepseek-ai/dsh-prompt-picker'
   ```

   Verified present in the packed asar by `tools\inspect-plugin.mjs`.

---

## The failure

The row does not appear in Settings → General, and the host route is not registered:

```
GET http://127.0.0.1:<port>/prompt-picker/list   ->  404
```

That 404 is the important fact: the **plugin never activated**. The client row was never the
problem. So the bug is in the host plugin: name resolution, `inject` availability, or the mount
being overridden.

An earlier attempt placed the package only at `app/node_modules/dsh-prompt-picker` and produced the
same 404 — moving it into the `@deepseek-ai` tree did not change the result.

### Ranked suspects

1. **`inject: ["webServer"]` may not be the real service name, or that service is absent in the
   `desktop` profile.** Check `@deepseek-ai/dsh-host-webserver/lib/index.js` for the service string
   (`super(ctx, "...")`) and then check which bundle in the `desktop` profile actually mounts it.
   If it is absent, activation fails and the entry is skipped silently. Either inject the correct
   name or expose the routes through the mechanism the profile does have (e.g. `dsh-api-gateway`
   remote methods or a client-visible remote service).
2. **The profile's own patch layer may override the base bundle row.** The `desktop` profile has its
   own `cordis.patch.yml` (in `home\profiles\desktop\`). Bundle patches are applied in order and the
   user's profile layer wins per row id. Confirm the row survives by inspecting the activated
   plugin list (Settings → Built-in plugins may show it).
3. **Client bundle id must match the package name.** `lib\client.js` declares
   `id: "dsh-prompt-picker"` while the package is now `@deepseek-ai/dsh-prompt-picker`. Align them,
   or confirm from `dsh-client-modules` how the id is used.
4. **Slot name.** `settings.general.item` is inferred from the permission-presets bundle. Confirm by
   grepping that bundle and `@deepseek-ai/dsh-client-ui-settings-general` for slot names before
   writing more code.
5. **`dsh.client` metadata may need an explicit entry path** rather than the implicit
   `lib/client.js`.

### Diagnostic loop to use

```powershell
# 1. which port is the app serving?
$pids = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*DSH-NoPolicy*' -and $_.Name -eq 'DeepSeek Harness.exe' }).ProcessId
Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } | Select LocalPort

# 2. is the host route live?
Invoke-WebRequest "http://127.0.0.1:<port>/prompt-picker/list" -UseBasicParsing

# 3. is the plugin in the archive and mounted?
node tools\inspect-plugin.mjs "$env:LOCALAPPDATA\Programs\DSH-NoPolicy\resources\app.asar"
```

Get the route to answer before touching any React code. A live route plus no row = client problem.
A 404 = host problem, keep digging there.

---

## Acceptance criteria

1. `GET /prompt-picker/list` (or whatever transport you choose) returns the filenames currently in
   `home\prompts\` plus the active one.
2. Selecting a different file and saving updates `home\prompt-active.txt` — verify by reading the
   file, not by trusting the UI.
3. A **new** session then assembles its system prompt from the newly selected file. Verify
   structurally: temporarily rename the selected file and confirm the assembled prompt loses it, or
   instrument `__npActivePrompt()` to log the resolved path. Do not judge by model behaviour — this
   is a plumbing check.
4. Existing patches keep their assertions passing, and `build.ps1` still reports the archive OK.
5. The installer still upgrades in one double-click: close app → run exe → app reopens, `home\` data
   preserved.

---

## Things that will waste your time

- `asar` header: file `offset` values are **strings**; `dataStart + Number(entry.offset)`.
  Packer header math is `headerPayload = 4 + align4(4 + jsonLength)`; string-pickle length written at
  offset 8 is `align4(4 + jsonLength)`. Off by 4 and the app cannot read its own archive and exits
  silently.
- The app **exits code 0 with no output** when it refuses to boot (e.g. single-instance lock). Never
  conclude "it started" from `Start-Process` alone — check listening ports and whether the `userdata`
  / `home` directories were created.
- PowerShell 5.1: `$home` is read-only; `Set-Content -Encoding UTF8` writes a BOM (breaks
  `node --check` on a `#!` script); `String.Split(string)` binds to `char[]`.
- Relocating the built app to another folder fails to boot even unpatched — do not spend time on
  portability here, that is a separate job.
- WinRAR's SFX is at `%ProgramFiles%\WinRAR\Rar.exe`; `package.ps1` needs the source build not
  running.
