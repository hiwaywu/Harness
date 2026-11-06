# HANDOFF

State of the no-policy Harness rebuild, what is proven, what is blocked, and exactly what to try next.
Written 2026-11-06 by the agent that built it, for whoever picks this up (human or agent).

---

## One-paragraph state

`app.asar` for DeepSeek Harness 0.2.1-rc.5 has been extracted, patched (7 asserted patches), repacked
and verified byte-readable, and assembled into a full separate install at `dist/dsh-nopolicy/`. The
installed app is **untouched**. The relocated copy does not launch: it exits with code 0 before any
application code runs, and a control copy with the *unmodified* asar behaves identically, so the cause
is not the patches. The remaining unknown is a startup gate inside the Electron binary that has not
been identified, and identifying it requires one launch with the installed app closed.

---

## Verified facts (do not re-derive)

| fact | evidence |
|---|---|
| install asar = 174.3 MB, SHA-256 `E1B6F25F…`, dated 10/29 10:02 | `Get-FileHash`, `Get-ChildItem` |
| extracted tree = 18,235 files (16,651 inline, 1,583 unpacked, 243.4 MB unpacked) | extractor output |
| real node_modules root is `app/dsh/node_modules/@deepseek-ai` (307 packages) | directory scan |
| patched asar = 170.7 MB, round-trips: `package.json` 797 B, `lib/main.js` 516,716 B, `dsh/package.json` 17,168 B | parse + read-back |
| `DeepSeek Harness.exe` is byte-identical to the original (246,343,144 B, SHA-256 `7AE939B5…`) | hash compare |
| relocated copy exits code 0, no stdout/stderr, no `userData` created | `Start-Process` + redirects |
| marker at line 1 of `lib/main.js` never fires → app code never executes | `marker.txt` absent |
| unmodified-asar control copy fails identically | `dist/control-orig/` |
| no absolute install path embedded in the exe (UTF-16 and ASCII checked) | byte scan |
| registry `InstallLocation` = `C:\Users\hiway\AppData\Local\Programs\DeepSeek Harness` | Uninstall key |
| `EnableEmbeddedAsarIntegrityValidation` string not present in the exe | byte scan |

## The blocker, precisely

`main.js:7658 claimDesktopSingleInstance()` is the only single-instance logic:

```js
function claimDesktopSingleInstance(application, focusOwner) {
  if (!application.requestSingleInstanceLock()) { application.quit(); return false; }
  application.on("second-instance", focusOwner);
  return true;
}
```

and `main.js:13184` gates all of startup on it. `app.quit()` with no error explains a silent exit 0 —
but the marker proves `main.js` is not reached at all, so something earlier is failing.

## Next experiment (the only one that cannot be run from inside the session)

The installed app hosts the agent doing the work, so it cannot be closed from within. Hand this to the
user:

1. Close DeepSeek Harness completely.
2. Run `dist\dsh-nopolicy\Diagnose.cmd` (sets `DSH_HOME`, `ELECTRON_ENABLE_LOGGING=1`, captures exit
   code, stdout/stderr and whether `%APPDATA%\dsh-nopolicy` was created into `diagnose.txt`).
3. Reopen DeepSeek Harness and read `diagnose.txt`.

Interpretation:

* **A window opens** → the gate was the shared single-instance object; `userData` isolation is enough.
  Proceed to "After it boots" below.
* **Still exits 0, silent** → Electron never loaded the app. Then, in this order:
  1. Check the Electron fuses on the exe (fuse bits are a numeric footer, not strings):
     `npx @electron/fuses read --app "dist\dsh-nopolicy\DeepSeek Harness.exe"` — if
     `EnableEmbeddedAsarIntegrityValidation` is on, only the original asar loads from the original
     location and this approach ends here; the remaining route is in-place patching.
  2. Run `dist\dsh-nopolicy\DeepSeek Harness.exe --enable-logging --v=1` from a console and read the
     Chromium log; Electron prints asar errors there.
  3. Try relocating to a path **without spaces** (e.g. `C:\dshnp\`) — untested, cheap.
  4. Compare against the installer's own layout expectation: `resources\version` = `44.7.0`,
     `app-update.yml` channel `nightly`, `resources\runtime\` holds `bin/ cli/ primary-runtime/
     office-skills/ versions.json`.
* **If it cannot be made relocatable**, the fallback that is guaranteed to run is
  `scripts\Apply-ToInstalled.cmd` (backs up to `app.asar.orig`, swaps the patched asar in) with
  `scripts\Revert.cmd` to undo. Same install, not side-by-side.

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

Then packaging: 7-Zip SFX to make one self-extracting `.exe`. **7-Zip is not installed** on this
machine — needs `7z.exe` + `7z.sfx`, or `iexpress`, or electron-builder's `portable` target.

## Verification checklist before calling it done

- [ ] app launches from `dist/dsh-nopolicy`
- [ ] a tool call that previously prompted (write outside the workspace) runs silently
- [ ] write to `C:\Windows\Temp\…` succeeds, proving `danger-full-access` is effective
- [ ] the assembled system prompt contains no `You are an AI agent powered by DeepSeek Harness`
- [ ] `~/.dsh` equivalent profile under `dist/dsh-nopolicy\home` is the one being written

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
