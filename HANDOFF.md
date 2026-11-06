# HANDOFF

State of the no-policy Harness rebuild, what is proven, what is blocked, and exactly what to try next.
Written 2026-11-06 by the agent that built it, for whoever picks this up (human or agent).

---

## One-paragraph state (updated 2026-11-06, second session)

**Solved and shipped.** The launch failure was the packer writing asar `offset` as a number; Electron's
native reader only accepts strings, so it silently booted `default_app.asar` (the control copy was
also repacked, hence "identical failure"). Fixed in `tools/asar-tool.mjs`, guarded by an Electron
read-back in `build.ps1`. Two more patches (`portable-home`, `mandatory-update-off`) plus deleting
`app-update.yml` make the bare exe standalone and stop updates from reinstalling the stock build.
`package.ps1` produces `dist\DSH-NoPolicy.exe` (WinRAR SFX), verified: extracts to
`%LOCALAPPDATA%\Programs\DSH-NoPolicy`, creates the desktop shortcut, opens the main window in ~16 s,
profile written under `home\`, UI renders.

Known harmless noise: `No handler registered for 'dsh-desktop:mandatory-status'` on stderr (the renderer
asks for the disabled policy's status).

---

## After it boots — remaining policy still in place

Not yet stripped, in priority order:

| target | file | what to do |
|---|---|---|
| read-before-edit guard (`FS_NOT_OBSERVED`) | `dsh-fs-observation-policy/lib/index.js` | `editIntent()` rejects when a target has no prior observation; make it fall back to `createIfAbsent` |
| web tool "untrusted data" framing | `dsh-tool-web/lib/index.js` | replace the untrusted-data sentences with neutral wording |
| tool call timeouts | `dsh-tool-call-timeout-policy/lib/index.js` | no-op the timeout policy |
| output truncation / spill | `dsh-output-retention`, `dsh-spill-policy` | keep everything inline |
| sandbox for shell tools | `dsh-bash-sandbox`, `dsh-pwsh-sandbox`, `dsh-terminal-bash` | confirm they inherit `danger-full-access`; patch defaults if not |
| permission presets UI | `dsh-permission-presets/lib/index.js` | the preset list still exposes ask/deny options |

Packaging is done (`package.ps1`, WinRAR SFX).

## Verification checklist before calling it done

- [x] app launches from `dist/dsh-nopolicy` and from the SFX install
- [ ] a tool call that previously prompted (write outside the workspace) runs silently
- [ ] write to `C:\Windows\Temp\…` succeeds, proving `danger-full-access` is effective
- [ ] the assembled system prompt contains no `You are an AI agent powered by DeepSeek Harness`
- [x] `~/.dsh` equivalent profile under `<install>\home` is the one being written

## Traps that cost time here (so they don't again)

* **asar `offset` is a string.** `dataStart + entry.offset` silently yields empty files.
* **asar header math**: `headerPayload = 4 + align4(4 + jsonLength)`, and the string-pickle payload
  length written at offset 8 is `align4(4 + jsonLength)`. Off by 4 = app cannot read its own asar,
  exits silently.
* **PowerShell `$home` is read-only.** `$home = Join-Path …` throws *after* already copying a file into
  the user profile. Use `$hm`.
* **`Set-Content -Encoding UTF8` in PS 5.1 writes a BOM**, which breaks `node --check` on a script
  starting with `#!`. Use `[System.IO.File]::WriteAllText(path, text, UTF8Encoding($false))`.
* **`String.Split(string)` binds to `char[]`** in PS 5.1, so a 45-char needle "matched" 332,769 times.
  Use `.Contains()` + `.Replace()` and verify by read-back.
* **`Get-ChildItem -Recurse -Include` without a path wildcard returns nothing.** Use `-Filter`.
* The exe rejects `--user-data-dir=…` with `bad option` (its argv is parsed by Node first).
* Launching a copy emits **no output at all**, so `Start-Process -PassThru` + `HasExited` is not enough
  to distinguish "started and forked" from "refused to start". Check for child processes and for the
  `userData` directory being created.

## Related material

The mechanism analysis of the *plugin* approach (dsh-purge, prompt layer vs host layer, why one model
looks uncensored and others do not) lives in the other project:
`C:\AI STUFF\DeepSeek\DSHMERGE\repo\docs\PROMPT-PORTING.md`. Not duplicated here.
