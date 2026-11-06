# build.ps1 - rebuild the no-policy Harness install from the installed app.
#
#   .\build.ps1                     # extract, patch, pack, assemble into dist\dsh-nopolicy
#   .\build.ps1 -SkipAssemble      # only produce work\app-nopolicy.asar
#
# Every stage verifies its own output; a silent half-build is worse than a loud failure.

param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\DeepSeek Harness",
  [string]$OutRoot     = (Join-Path $PSScriptRoot "dist\dsh-nopolicy"),
  [switch]$SkipAssemble,
  [switch]$WithPluginPort,
  [switch]$NoPickerUi
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$work = Join-Path $here "work"
$app  = Join-Path $work "app"
$asar = Join-Path $work "app-nopolicy.asar"

function Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

Step "checking install"
if (-not (Test-Path (Join-Path $InstallRoot "resources\app.asar"))) { Fail "no app.asar under $InstallRoot" }
$srcAsar = Join-Path $InstallRoot "resources\app.asar"
$srcInfo = Get-Item $srcAsar
Write-Host ("source asar: {0:N1} MB, {1}" -f ($srcInfo.Length/1MB), $srcInfo.LastWriteTime)
Write-Host ("sha256     : " + (Get-FileHash $srcAsar -Algorithm SHA256).Hash.Substring(0,32) + "...")

Step "extracting"
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
New-Item -ItemType Directory -Path $work -Force | Out-Null
node (Join-Path $here "tools\asar-tool.mjs") extract $srcAsar $app
$count = (Get-ChildItem $app -Recurse -File | Measure-Object).Count
if ($count -lt 15000) { Fail "extract produced only $count files" }
Write-Host "extracted $count files"

Step "patching policy"
node (Join-Path $here "tools\patch-nopolicy.mjs") $app
if ($LASTEXITCODE -ne 0) { Fail "patch stage reported failures" }

Step "stripping the bundle persona prefix"
# dsh-web-app (and acp/headless/sdk/presets) ship:
#     - id: system-prompt
#       config:
#         personaPrefix: >-
#           You are a coding agent powered by the {{model}} model.
# That line tells every model which model it is, anchoring vendor habits (language, identity,
# refusal posture). It lives in YAML, not JS, so it is swept here.
$yamlFiles = Get-ChildItem (Join-Path $app "dsh\node_modules\@deepseek-ai") -Recurse -File -Include *.yml,*.yaml -ErrorAction SilentlyContinue
$stripped = 0
foreach ($y in $yamlFiles) {
  $text = [System.IO.File]::ReadAllText($y.FullName)
  if ($text -notmatch 'coding agent powered by') { continue }
  $next = [regex]::Replace($text, '(?m)^[ \t]*You are a coding agent powered by[^\r\n]*$', '')
  if ($next -ne $text) {
    [System.IO.File]::WriteAllText($y.FullName, $next, (New-Object System.Text.UTF8Encoding($false)))
    $stripped += 1
    Write-Host ("  stripped: " + $y.FullName.Replace($app + "\", ""))
  }
}
if ($stripped -eq 0) { Write-Host "  nothing to strip" -ForegroundColor Yellow } else { Write-Host "  files changed: $stripped" }

Step "porting dsh-purge patches (opt-in)"
# DISABLED BY DEFAULT. The ported agent-loop / streaming / settings patches caused a real regression:
# a sent message rendered as "thinking" and only appeared after switching sessions. Our own 11
# patches plus the prompt layer are enough for policy. Port only on request, in batches, with a test
# between each batch:
#     .\build.ps1 -WithPluginPort
$pluginRoot = Join-Path $here "vendor\dsh-purge"
if ($WithPluginPort -and (Test-Path (Join-Path $pluginRoot "lib\core.js"))) {
  node (Join-Path $here "tools\port-plugin-patches.mjs") $pluginRoot $app 2>&1 |
    Where-Object { $_ -match '^(plugin patches|applied|no pattern)' } |
    ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Fail "plugin patch port failed" }
} else {
  Write-Host "  skipped (policy comes from our 11 patches + prompt layer)" -ForegroundColor DarkGray
}

Step "mounting the prompt picker plugin"
$pluginSrc = Join-Path $here "plugin\dsh-prompt-picker"
if (-not (Test-Path (Join-Path $pluginSrc "package.json"))) { Fail "plugin source missing at $pluginSrc" }

# Bundle names are resolved through the app's own @deepseek-ai tree, so the plugin must live there
# (a bare app/node_modules copy is not on that resolution path and the entry is skipped silently).
$pluginDst = Join-Path $app "dsh\node_modules\@deepseek-ai\dsh-prompt-picker"
if (Test-Path $pluginDst) { Remove-Item $pluginDst -Recurse -Force }
New-Item -ItemType Directory -Path $pluginDst -Force | Out-Null
Copy-Item (Join-Path $pluginSrc "*") $pluginDst -Recurse -Force
if (-not (Test-Path (Join-Path $pluginDst "lib\client.js"))) { Fail "client bundle did not copy" }
if ($NoPickerUi) {
  # Diagnostic variant: strip the client half so nothing of ours runs inside the conversation UI.
  # The host routes and the file-based switching stay; only the settings row disappears.
  $pkgPath = Join-Path $pluginDst "package.json"
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $pkg.PSObject.Properties.Remove("dsh")
  [System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  $altPkg = Join-Path $pluginAlt "package.json"
  $alt = Get-Content $altPkg -Raw | ConvertFrom-Json
  $alt.PSObject.Properties.Remove("dsh")
  [System.IO.File]::WriteAllText($altPkg, ($alt | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  client UI stripped (no settings row in this build)" -ForegroundColor Yellow
}

# The loader only resolves plugin names reachable from the install anchor's dependency graph
# (dsh-app-boot collectInstallationScopePackages). The desktop host's anchor is the `dsh` package
# itself (dsh-desktop-host: <runtime>/node_modules/@deepseek-ai/dsh/package.json), NOT the runtime
# root dsh/package.json. A package on disk but not declared there is skipped SILENTLY - the 404.
$dshPkg = Join-Path $app "dsh\node_modules\@deepseek-ai\dsh\package.json"
$pkgJs = @'
const fs=require("fs");const p=process.argv[2];const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.dependencies=j.dependencies||{};j.dependencies["@deepseek-ai/dsh-prompt-picker"]="1.0.0";
fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
'@
$pkgFile = Join-Path $work "add-dep.js"
[System.IO.File]::WriteAllText($pkgFile, $pkgJs, (New-Object System.Text.UTF8Encoding($false)))
node $pkgFile $dshPkg
if (-not ([System.IO.File]::ReadAllText($dshPkg)).Contains('"@deepseek-ai/dsh-prompt-picker"')) { Fail "dependency did not land in the install anchor" }
Write-Host "declared @deepseek-ai/dsh-prompt-picker in @deepseek-ai/dsh/package.json (the install anchor)"

# Mount into the base bundle so every profile gets the row, no per-profile edit required.
$baseYml = Join-Path $app "dsh\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml"
if (-not (Test-Path $baseYml)) { Fail "dsh-base cordis.patch.yml not found" }
$mount = @'

# dsh-prompt-picker: settings row that lists <DSH_HOME>/prompts/*.md and saves the selection.
- insert:
    - id: prompt-picker
      name: '@deepseek-ai/dsh-prompt-picker'
'@
$yml = [System.IO.File]::ReadAllText($baseYml)
if (-not $yml.Contains("id: prompt-picker")) {
  [System.IO.File]::WriteAllText($baseYml, $yml.TrimEnd() + $mount + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "mounted @deepseek-ai/dsh-prompt-picker into dsh-base bundle"
} else {
  Write-Host "prompt-picker already present in dsh-base bundle"
}
if (-not ([System.IO.File]::ReadAllText($baseYml)).Contains("id: prompt-picker")) { Fail "mount did not land" }

Step "repacking"
node (Join-Path $here "tools\asar-tool.mjs") pack $app $asar (Join-Path $app ".asar-unpacked-list.json")
if ($LASTEXITCODE -ne 0) { Fail "pack failed" }

Step "verifying the packed archive"
$check = @'
const fs=require("fs");
const buf=fs.readFileSync(process.argv[2]);
const hp=buf.readUInt32LE(4), jl=buf.readUInt32LE(12);
if (buf.readUInt32LE(0)!==4) { console.error("bad size pickle"); process.exit(1); }
const json=JSON.parse(buf.subarray(16,16+jl).toString("utf8"));
const dataStart=8+hp;
const get=(p)=>{let n=json;for(const k of p){if(!n.files||!n.files[k])return null;n=n.files[k];}return n;};
for (const p of [["package.json"],["lib","main.js"],["dsh","package.json"]]) {
  const e=get(p); if(!e||e.unpacked){console.error("missing "+p.join("/"));process.exit(1);}
  const s=dataStart+Number(e.offset);
  if (s+Number(e.size)>buf.length) { console.error("out of range "+p.join("/")); process.exit(1); }
}
const main=get(["lib","main.js"]); const s=dataStart+Number(main.offset);
const text=buf.subarray(s,s+Number(main.size)).toString("utf8");
if (!text.includes("userdata")) { console.error("portable userData patch missing from main.js"); process.exit(1); }
console.log("archive OK, main.js carries the portable userData patch");
'@
$checkFile = Join-Path $work "verify.js"
[System.IO.File]::WriteAllText($checkFile, $check, (New-Object System.Text.UTF8Encoding($false)))
node $checkFile $asar
if ($LASTEXITCODE -ne 0) { Fail "archive verification failed" }

# Our own parser is lenient; Electron's native reader is not (it rejects numeric offsets and then
# silently boots default_app). Read the archive back through the app's own exe in node mode.
$probe = Join-Path $work "electron-probe.js"
[System.IO.File]::WriteAllText($probe, "const fs=require('fs');const a=process.argv[2];if(!fs.readFileSync(a+'/lib/main.js','utf8').includes('userdata'))process.exit(1);JSON.parse(fs.readFileSync(a+'/package.json','utf8'));process.exit(0);", (New-Object System.Text.UTF8Encoding($false)))
$env:ELECTRON_RUN_AS_NODE = "1"
$pp = Start-Process (Join-Path $InstallRoot "DeepSeek Harness.exe") -ArgumentList "`"$probe`"","`"$asar`"" -Wait -PassThru -NoNewWindow
$rc = $pp.ExitCode
Remove-Item Env:ELECTRON_RUN_AS_NODE
if ($rc -eq 0) { Write-Host "Electron's own reader opens the archive" }
if ($rc -ne 0) { Fail "Electron cannot read the packed archive" }

if ($SkipAssemble) { Write-Host "`nasar ready: $asar"; exit 0 }

Step "assembling $OutRoot"
if (Test-Path $OutRoot) { Remove-Item $OutRoot -Recurse -Force }
robocopy $InstallRoot $OutRoot /E /NFL /NDL /NJH /NJS /NP | Out-Null
foreach ($junk in @("app","app.dshpurge-prev","app.asar.rename-pending")) {
  $p = Join-Path $OutRoot "resources\$junk"
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "removed plugin leftover: $junk" }
}
$dstRes = Join-Path $OutRoot "resources"
# electron-updater only runs when app-update.yml exists; an update would reinstall the stock build
$upd = Join-Path $dstRes "app-update.yml"
if (Test-Path $upd) { Remove-Item $upd -Force; Write-Host "removed app-update.yml (auto-update off)" }
Copy-Item $asar (Join-Path $dstRes "app.asar") -Force
if (Test-Path (Join-Path $dstRes "app.asar.unpacked")) { Remove-Item (Join-Path $dstRes "app.asar.unpacked") -Recurse -Force }
Copy-Item "$asar.unpacked" (Join-Path $dstRes "app.asar.unpacked") -Recurse -Force

$hm = Join-Path $OutRoot "home"
New-Item -ItemType Directory -Path $hm -Force | Out-Null
foreach ($f in @(".credentials.yaml","prompt-inject.md")) {
  $src = Join-Path $env:USERPROFILE ".dsh\$f"
  if (Test-Path $src) { Copy-Item $src (Join-Path $hm $f) -Force }
}

# Operator prompt library. These are the REAL prompts, not stubs: the user's live prompt plus the
# two the plugin ships. dsh-system-prompt is patched to inject the selected one as the opening
# system section; prompt-active.txt names the selection and falls back to default.md.
$prompts = Join-Path $hm "prompts"
New-Item -ItemType Directory -Path $prompts -Force | Out-Null
# Self-contained: prompt sources are vendored under prompts\ in this repo, not read from another
# project. anchor.md is dsh-purge's ANCHOR_TEXT (MIT); plugin-en/zh are its shipped defaults.
$vendorPrompts = Join-Path $here "prompts"
foreach ($s in Get-ChildItem $vendorPrompts -File -Filter *.md -ErrorAction SilentlyContinue) {
  $text = [System.IO.File]::ReadAllText($s.FullName)
  if ($text.Trim().Length -eq 0) { Write-Host ("WARN vendored prompt is empty, skipped: " + $s.Name) -ForegroundColor Yellow; continue }
  [System.IO.File]::WriteAllText((Join-Path $prompts $s.Name), $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("prompt seeded: {0} ({1:N0} chars)" -f $s.Name, $text.Length)
}
# The operator's own prompt stays the default selection.
$userPrompt = Join-Path $env:USERPROFILE ".dsh\prompt-inject.md"
if (Test-Path $userPrompt) {
  Copy-Item $userPrompt (Join-Path $prompts "default.md") -Force
  Write-Host ("prompt seeded: default.md (operator prompt, {0:N0} chars)" -f ([System.IO.File]::ReadAllText($userPrompt)).Length)
}
$vendorSkills = Join-Path $here "skills\redteam"
if (Test-Path $vendorSkills) {
  $skillDst = Join-Path $hm "skills\redteam"
  New-Item -ItemType Directory -Path $skillDst -Force | Out-Null
  Copy-Item (Join-Path $vendorSkills "*.md") $skillDst -Force
  Write-Host ("skills seeded: {0} files -> home\skills\redteam" -f (Get-ChildItem $skillDst -Filter *.md | Measure-Object).Count)
}
if (-not (Test-Path (Join-Path $hm "prompt-active.txt"))) {
  [System.IO.File]::WriteAllText((Join-Path $hm "prompt-active.txt"), "default.md", (New-Object System.Text.UTF8Encoding($false)))
}
# Per-model map. Resolution at runtime: model key -> "default" -> prompt-active.txt ->
# prompts/default.md -> home/prompt-inject.md -> any other .md. Add keys freely, e.g.
#   {"default":"default.md","glm-5.3":"glm.md","deepseek-v4.1-flash":"ds.md"}
if (-not (Test-Path (Join-Path $hm "anchor-active.txt"))) {
  [System.IO.File]::WriteAllText((Join-Path $hm "anchor-active.txt"), "anchor.md", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "anchor selection seeded: anchor.md (amended); anchor-plugin.md is the plugin original"
}if (-not (Test-Path (Join-Path $hm "prompt-map.json"))) {
  $mapJson = '{"default":"default.md"}'
  [System.IO.File]::WriteAllText((Join-Path $hm "prompt-map.json"), $mapJson, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "prompt map seeded: default -> default.md"
}
Copy-Item (Join-Path $here "scripts\*.cmd") $OutRoot -Force

Write-Host "`nbuilt: $OutRoot" -ForegroundColor Green
Write-Host "next : run scripts\Diagnose.cmd there with DeepSeek Harness CLOSED"
