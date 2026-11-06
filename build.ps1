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
if (!text.includes("dsh-nopolicy")) { console.error("userData patch missing from main.js"); process.exit(1); }
console.log("archive OK, main.js carries the userData patch");
'@
$checkFile = Join-Path $work "verify.js"
[System.IO.File]::WriteAllText($checkFile, $check, (New-Object System.Text.UTF8Encoding($false)))
node $checkFile $asar
if ($LASTEXITCODE -ne 0) { Fail "archive verification failed" }

# Our own parser is lenient; Electron's native reader is not (it rejects numeric offsets and then
# silently boots default_app). Read the archive back through the app's own exe in node mode.
$probe = Join-Path $work "electron-probe.js"
[System.IO.File]::WriteAllText($probe, "const fs=require('fs');const a=process.argv[2];if(!fs.readFileSync(a+'/lib/main.js','utf8').includes('dsh-nopolicy'))process.exit(1);JSON.parse(fs.readFileSync(a+'/package.json','utf8'));process.exit(0);", (New-Object System.Text.UTF8Encoding($false)))
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
Copy-Item (Join-Path $here "scripts\*.cmd") $OutRoot -Force

Write-Host "`nbuilt: $OutRoot" -ForegroundColor Green
Write-Host "next : run scripts\Diagnose.cmd there with DeepSeek Harness CLOSED"
