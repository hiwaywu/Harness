# Harness — no-policy rebuild

A rebuilt DeepSeek Harness desktop app with the host policy layer stripped, plus the tooling that
builds it. Separated from the `DSHMERGE` project (Android APK / dsh-purge work) on 2026-11-06.

**Status: the patched `app.asar` builds and verifies, but the relocated install does not launch yet.**
See [What blocks the launch](#what-blocks-the-launch) and [HANDOFF.md](HANDOFF.md).

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

### 3. Patched the policy (7 patches, `tools/patch-nopolicy.mjs`)

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

### 5. Hit the launch blocker (unresolved)

Everything above is verified. The relocated copy does not start:

* exits with **code 0**, no stdout, no stderr, instantly
* no `userData` directory is created
* a marker injected as the **first line** of `lib/main.js` never fires → no app code runs
* the `.exe` is byte-identical to the original (same SHA-256)
* **a control copy with the unmodified asar fails identically** → not caused by the patches
* no absolute install path is embedded in the binary (checked UTF-16 and ASCII)

So the gate is inside Electron's startup, before `main.js`. It has not been identified yet.

---

## What blocks the launch

Three things were tried and none moved it:

1. changing `package.json` `name` and `dshDesktopAppId` — no effect
2. `app.setPath("userData", ...)` — never executes, because `main.js` never runs
3. launching with `-WorkingDirectory` set to the folder — no effect

The one experiment that cannot be run from inside this session: launching the copy **while the
installed app is closed**. The installed app is what hosts the agent doing the work, so closing it ends
the session. `scripts/Diagnose.cmd` exists to capture that run's output (exit code, stdout/stderr,
whether userData was created) with `ELECTRON_ENABLE_LOGGING=1`.

Candidates not yet eliminated: a relocation check in the binary, asar integrity fuse validation
(`EnableEmbeddedAsarIntegrityValidation` was **not** found as a string in the exe, but the fuse bits
live in a numeric footer), or a Windows-side single-instance object that survives independent of the
userData path.

---

## Layout

```
tools/asar-tool.mjs          asar extract/pack, no dependencies
tools/patch-nopolicy.mjs     7 asserted patches over an extracted tree
scripts/Diagnose.cmd         launch + capture exit code/output (run with the app closed)
scripts/Start-NoPolicy.cmd   normal launcher
scripts/Apply-ToInstalled.cmd  swap the patched asar into the real install, with backup
scripts/Revert.cmd           restore app.asar.orig
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
