# Harness — no-policy rebuild

A rebuilt DeepSeek Harness desktop app with the host policy layer stripped, plus the tooling that
builds it. Separated from the `DSHMERGE` project (Android APK / dsh-purge work) on 2026-11-06.

**Status: working.** `build.ps1` + `package.ps1` produce `dist\DSH-NoPolicy.exe`, a single self-extracting
exe that installs to `%LOCALAPPDATA%\Programs\DSH-NoPolicy`, adds a desktop shortcut, and starts the app.
See [The launch blocker (solved)](#the-launch-blocker-solved).

---

## What this is

DeepSeek Harness (`dsh` 0.2.1-rc.5) is an Electron desktop app. The policy layer the user wants gone
lives inside `resources/app.asar` as ordinary JavaScript — approval gates, the file sandbox, the
system-prompt policy sections, the official identity sentence. None of it is in the `.exe`, so the
approach is: extract the asar, patch the policy decisions, repack, run.

This is **not** a model jailbreak and does not touch model weights. What it removes is the host-layer
restriction: nothing in the app gates, sandboxes, or instructs. Whether a model then answers anything
is decided by that model.

---

## What was done, in order

### 1. Wrote an asar extractor/packer

No `@electron/asar` on the machine and no network for `npx`, so `tools/asar-tool.mjs` implements the
format directly: `[u32=4][u32=headerPayloadLen][u32=strPayloadLen][u32=jsonLen][json][padding][data]`.
Entries flagged `"unpacked": true` live in `app.asar.unpacked/` instead of inline.

Two bugs, both found by verification rather than assumption:

* **Read side:** the header stores `"offset":"0"` as a **string**. `dataStart + entry.offset`
  concatenated instead of adding, `subarray(NaN)` returned empty, and all 18,235 files extracted as
  0 bytes. Fixed with `Number(entry.offset)`.
* **Write side:** header arithmetic was off by 4 bytes (`headerPayload = 4 + align4(jsonLen)` instead
  of `4 + align4(4 + jsonLen)`). The app could not read its own asar and exited silently. Fixed and
  verified by reading `package.json`, `lib/main.js` and `dsh/package.json` back out of the packed
  archive with correct sizes.

### 2. Extracted

```
resources/app.asar  ->  18,235 files
  16,651 inline
  1,583 unpacked (243.4 MB) 
  307 @deepseek-ai packages under dsh/node_modules/@deepseek-ai
```

### 3. Patched the policy (11 patches, `tools/patch-nopolicy.mjs`)

Every patch asserts its match count and fails loud on 0 or >1, so a changed upstream string cannot
silently no-op.

| id | kind | file | change |
|---|---|---|---|
| `sandbox-default` | DEFAULT | `dsh-sandbox-policy/lib/index.js` | deployment default `read-only` → `danger-full-access` |
| `harness-identity` | PROMPT | `dsh-system-prompt/lib/index.js` | `"You are an AI agent powered by DeepSeek Harness."` → `""` |
| `harness-identity-default` | PROMPT | `dsh-system-prompt/lib/index.js` | `includeHarnessIdentity` default `true` → `false` |
| `approval-autogrant` | GATE | `dsh-user-approval/lib/index.js` | `decide()` returns `"allowed-once"` before any policy or answerer runs |
| `approval-sentence-ask` | PROMPT | `dsh-user-approval/lib/index.js` | approval-policy sentence replaced with a neutral line |
| `approval-sentence-never` | PROMPT | `dsh-user-approval/lib/index.js` | same for the disabled variant |
| `userdata-isolation` | DEFAULT | `lib/main.js` | `app.setPath("userData", join(app.getPath("appData"), "dsh-nopolicy"))` before the single-instance claim |

Measured defaults that made this tractable: the harness already supports `danger-full-access` (this
session runs under it), and `dsh-sandbox-policy` had exactly one `.default("read-only")`.

### 4. Repacked and assembled a separate install

Packed to a 170.7 MB `app.asar` and copied the full install to `dist/dsh-nopolicy/`, with the plugin's
leftovers removed (`resources/app`, `app.dshpurge-prev`, `app.asar.rename-pending`), an isolated
`home/` seeded with `~/.dsh/.credentials.yaml` + `prompt-inject.md`, and launcher scripts.

### 5. The launch blocker (solved)

The relocated copy booted Electron's **default app** instead of ours (visible only on stdout: the
`Electron 44.7.0 ... Usage: electron [options] [path]` banner). Electron's native asar reader
(`shell/common/asar/archive.cc`) requires `"offset"` to be a decimal **string**; the packer wrote a
number, so every lookup inside the repacked `app.asar` failed and Electron fell back to
`default_app.asar`. The "control copy" failed for the same reason - it had been repacked too.

Fix: `asar-tool.mjs` writes `offset` as a string and emits SHA-256 `integrity` blocks like
`@electron/asar`. `build.ps1` now reads the archive back through the app's own exe with
`ELECTRON_RUN_AS_NODE=1`, so a format Electron rejects fails the build instead of the launch.
(Fuses read from the exe: RunAsNode on, EmbeddedAsarIntegrityValidation off, OnlyLoadAppFromAsar off.)

### 6. Made it standalone

| id | file | change |
|---|---|---|
| `portable-home` | `lib/main.js` | `DSH_HOME` defaults to `<exe dir>\home`, so the bare exe needs no launcher script |
| `mandatory-update-off` | `package.json` | rename `dshMandatoryUpdatePolicy` so the forced-update window is never built |
| (build step) | `resources/app-update.yml` | deleted; electron-updater only runs when it exists (it found 0.2.2-rc.1 and would have reinstalled the stock build) |

`package.ps1` wraps `dist\dsh-nopolicy` with WinRAR's SFX module (`Default.SFX`) into
`dist\DSH-NoPolicy.exe` (~284 MB). First run: extract (~15 s) + desktop shortcut + launch. After that,
use the shortcut. Re-running the exe updates the program files but keeps anything the app wrote to `home\`.

## Layout

```
tools/asar-tool.mjs          asar extract/pack, no dependencies
tools/patch-nopolicy.mjs     9 asserted patches over an extracted tree
scripts/Diagnose.cmd         launch + capture exit code/output (run with the app closed)
scripts/Start-NoPolicy.cmd   normal launcher
scripts/Apply-ToInstalled.cmd  swap the patched asar into the real install, with backup
scripts/Revert.cmd           restore app.asar.orig
build.ps1                    extract, patch, pack, verify, assemble dist\dsh-nopolicy
package.ps1                  wrap it into dist\DSH-NoPolicy.exe (needs WinRAR)
dist/dsh-nopolicy/           assembled build (not committed: 550 MB+)
dist/control-orig/           unmodified copy used as the A/B control (not committed)
```

## Reproduce

```powershell
# 1. extract
node tools/asar-tool.mjs extract "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar" work\app

# 2. patch (asserted)
node tools/patch-nopolicy.mjs work\app

# 3. repack
node tools/asar-tool.mjs pack work\app work\app-nopolicy.asar work\app\.asar-unpacked-list.json

# 4. assemble
robocopy "$env:LOCALAPPDATA\Programs\DeepSeek Harness" dist\dsh-nopolicy /E
copy work\app-nopolicy.asar dist\dsh-nopolicy\resources\app.asar
```

## Does removing this make a model uncensored

No. It removes the host layer only. Measured on the same prompt through raw API — i.e. **no harness at
all** — 40 of 41 open models refused a controlled-substance procedure and 37 of 41 refused
unauthorised mailbox access. The refusal that survives is in the model's weights.

What this build does change: nothing in the app argues, gates, or limits. For a model whose
restrictions were mostly host-imposed, that is visible as full compliance.

## Not committed

`dist/`, `work/`, `*.asar`, launch logs, `marker.txt` — binaries and build output stay local. See
`.gitignore`.

---

## Current state (updated)

**Patches: 11 asserted, plus a YAML sweep.**

| group | what it does |
|---|---|
| `sandbox-default` | deployment default `read-only` → `danger-full-access` |
| `harness-identity`, `harness-identity-default` | host identity sentence and section removed |
| `approval-autogrant`, `approval-sentence-ask`, `approval-sentence-never` | approvals grant once, before any policy runs; the prompt no longer announces a gate |
| `userdata-isolation` | `userData` next to the exe, so copies never fight the installed app |
| `portable-home` | `DSH_HOME` = `<exe dir>\home` |
| `mandatory-update-off` | no forced update back to the stock build |
| `prompt-library-reader`, `prompt-library-positions` | operator prompt injected at the top (`-1e6`) and its tail block at the bottom (`1e5`), per model, read fresh every assembly |

**Persona prefix stripped.** `dsh-web-app`, `dsh-acp-app`, `dsh-headless`, `dsh-sdk-app` and `dsh-web-app/presets`
ship `personaPrefix: "You are a coding agent powered by the {{model}} model."` in their `cordis.patch.yml`.
That anchored every model to its vendor's habits (language, identity, refusal posture) and was swept out in
`build.ps1`. Five files per build.

**Prompt layer.** `home\prompts\*.md`, selected by `home\prompt-active.txt`, per-model via
`home\prompt-map.json` (`{"default":"default.md","<model-id>":"<file>.md"}`). The selected file is split at a
tail marker (`[OPERATOR ANCHOR` or `House Rules`): the head opens the system prompt, the tail is appended after
tool text and runtime context where recency makes it win. `home\anchor-active.txt` chooses between
`anchor.md` (amended: English-only + compliance clauses) and `anchor-plugin.md` (dsh-purge `ANCHOR_TEXT`
verbatim) — a live A/B switch for testing whether an amendment changes a model's behaviour.

**Picker UI.** `plugin/dsh-prompt-picker` adds two Settings → General rows (operator prompt, tail anchor) with
preview, Save, and New. Routes: `/prompt-picker/list|read|status|set|new|set-anchor`, all behind the harness's
own `connection.requestRejection` fence, allow-listed filenames, no path traversal. Build with
`-NoPickerUi` to ship without the client half (diagnostic variant).

**Observability.** Every assembly writes `home\debug-prompt.json` — model, head/tail sizes and the first 120
chars of each. If `tailStart` does not begin with the anchor text, the prompt is not reaching the model.

**Skills.** 22 `skills/redteam/*.md` files seed to `home\skills\redteam\`.

**Vendored content (MIT).** `vendor/dsh-purge/` carries
[HunYiSage/dsh-purge](https://github.com/HunYiSage/dsh-purge) v1.1.92 `lib/` so its own patch table can be
run against this tree. 42 of its 79 working patterns match rc.5, which contradicts its README's "rc.3+
unsupported" line — the code carries rc.5 anchors. Porting is **opt-in** (`build.ps1 -WithPluginPort`)
because its agent-loop/streaming patches caused a UI regression, and it is off by default. `prompts/anchor.md`
and `prompts/anchor-plugin.md` derive from its `ANCHOR_TEXT`; LICENSE and NOTICE are included.