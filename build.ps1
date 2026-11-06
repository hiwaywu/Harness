# build.ps1 - rebuild the no-policy Harness install from the installed app.
#
#   .\build.ps1                     # extract, patch, pack, assemble into dist\dsh-nopolicy
#   .\build.ps1 -SkipAssemble      # only produce work\app-nopolicy.asar
#
# Every stage verifies its own output; a silent half-build is worse than a loud failure.

param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\DeepSeek Harness",
  [string]$OutRoot     = (Join-Path $PSScriptRoot "dist\dsh-nopolicy"),
  [switch]$SkipAssemble
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
$pluginLib = "C:\AI STUFF\DeepSeek\DSHMERGE\work\payload\app\node_modules\dsh-purge\lib"
$seeds = @(
  @{ name = "default.md";        path = (Join-Path $env:USERPROFILE ".dsh\prompt-inject.md") },
  @{ name = "plugin-en.md";      path = (Join-Path $pluginLib "default-prompt-inject.en.md") },
  @{ name = "plugin-zh.md";      path = (Join-Path $pluginLib "default-prompt-inject.zh.md") }
)
foreach ($s in $seeds) {
  if (-not (Test-Path $s.path)) { Write-Host ("WARN prompt source missing: " + $s.name) -ForegroundColor Yellow; continue }
  $text = [System.IO.File]::ReadAllText($s.path)
  # Only empty files are refused: that is the real failure mode (bad source path, truncated copy).
  # A deliberately short prompt is legitimate and ships as-is.
  if ($text.Trim().Length -eq 0) { Write-Host ("WARN prompt is empty, skipped: " + $s.name) -ForegroundColor Yellow; continue }
  if ($text.Trim().Length -lt 200) { Write-Host ("note: {0} is short ({1:N0} chars) - shipping as-is" -f $s.name, $text.Trim().Length) -ForegroundColor DarkYellow }
  [System.IO.File]::WriteAllText((Join-Path $prompts $s.name), $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("prompt seeded: {0} ({1:N0} chars)" -f $s.name, $text.Length)
}
if (-not (Test-Path (Join-Path $hm "prompt-active.txt"))) {
  [System.IO.File]::WriteAllText((Join-Path $hm "prompt-active.txt"), "default.md", (New-Object System.Text.UTF8Encoding($false)))
}
Copy-Item (Join-Path $here "scripts\*.cmd") $OutRoot -Force

Write-Host "`nbuilt: $OutRoot" -ForegroundColor Green
Write-Host "next : run scripts\Diagnose.cmd there with DeepSeek Harness CLOSED"
