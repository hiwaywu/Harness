# make-standalone.ps1 - wrap dist\dsh-nopolicy into ONE exe that installs once and then just launches.
#
#   .\build.ps1            # (only if the app itself changed) produce dist\dsh-nopolicy
#   .\make-standalone.ps1  # produce dist\DSH-NoPolicy.exe
#
# Packaging only: the build tree is zipped as-is (app.asar and app.asar.unpacked byte-identical,
# no pruning, no asar rewrite, fuses untouched). home\ is stored as seed\ and merged by the
# launcher's rules (standalone\Launcher.cs). package.ps1 (WinRAR SFX) stays as the reference.

param(
  [string]$Src = (Join-Path $PSScriptRoot "dist\dsh-nopolicy"),
  [string]$Out = (Join-Path $PSScriptRoot "dist\DSH-NoPolicy.exe")
)
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $Src "DeepSeek Harness.exe"))) { Fail "no build at $Src - run build.ps1 first" }
if (-not (Test-Path (Join-Path $Src "resources\app.asar"))) { Fail "no resources\app.asar in $Src" }
if (-not (Test-Path (Join-Path $Src "resources\app.asar.unpacked"))) { Fail "no resources\app.asar.unpacked in $Src" }
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { Fail ".NET Framework 4 csc.exe not found at $csc" }

$obj = Join-Path $PSScriptRoot "dist\_standalone"
if (Test-Path $obj) { Remove-Item $obj -Recurse -Force }
New-Item -ItemType Directory -Path $obj -Force | Out-Null

# 1. launcher stub
$stub = Join-Path $obj "stub.exe"
$icon = Join-Path $Src "resources\tray.ico"
$ref = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/out:$stub" "/win32icon:$icon" `
  "/r:$ref\System.IO.Compression.dll" "/r:$ref\Microsoft.CSharp.dll" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll `
  (Join-Path $PSScriptRoot "standalone\Launcher.cs")
if ($LASTEXITCODE -ne 0) { Fail "csc exited $LASTEXITCODE" }

# 2. payload zip: app files at root, home\ -> seed\, dev-only helpers left out
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$skip = @("diagnose.txt","Diagnose.cmd","Apply-ToInstalled.cmd","Revert.cmd","Start-NoPolicy.cmd","boot.log","boot.err.log")
# Never ship the operator's own secrets or identity inside a distributable exe. The installed folder
# already holds these on the operator's machine; a fresh machine signs in normally instead of
# inheriting someone else's credential store.
$neverShip = @("home\.credentials.yaml", "home\.anonymous-user-id")
$zipPath = Join-Path $obj "payload.zip"
$srcFull = (Resolve-Path $Src).Path.TrimEnd('\')
$zs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($zs, [System.IO.Compression.ZipArchiveMode]::Create)
$n = 0; $bytes = 0
try {
  foreach ($f in Get-ChildItem -LiteralPath $srcFull -Recurse -File -Force) {
    $rel = $f.FullName.Substring($srcFull.Length + 1)
    if ($skip -contains $rel) { continue }
    if ($neverShip -contains $rel) { Write-Host "  not shipped (personal): $rel" -ForegroundColor DarkYellow; continue }
    if ($rel -like "home\*") { $rel = "seed\" + $rel.Substring(5) }
    $name = $rel.Replace('\','/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $n++; $bytes += $f.Length
  }
} finally { $zip.Dispose(); $zs.Dispose() }
Write-Host ("payload: {0:N0} files, {1:N0} MB raw -> {2:N0} MB zipped" -f $n, ($bytes/1MB), ((Get-Item $zipPath).Length/1MB))

# 3. exe = stub + zip + trailer [64-byte build id][int64 zip length][magic]
$id = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
$zipLen = (Get-Item $zipPath).Length
if (Test-Path $Out) { Remove-Item $Out -Force }
$o = [System.IO.File]::Open($Out, [System.IO.FileMode]::CreateNew)
try {
  foreach ($part in @($stub, $zipPath)) {
    $i = [System.IO.File]::OpenRead($part); try { $i.CopyTo($o) } finally { $i.Dispose() }
  }
  $t = [System.Text.Encoding]::ASCII.GetBytes($id.PadRight(64).Substring(0,64))
  $o.Write($t, 0, 64)
  $l = [BitConverter]::GetBytes([int64]$zipLen); $o.Write($l, 0, 8)
  $m = [System.Text.Encoding]::ASCII.GetBytes("DSHNP001"); $o.Write($m, 0, 8)
} finally { $o.Dispose() }
Remove-Item $obj -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("built: {0}  ({1:N0} MB)  build-id {2}" -f $Out, ((Get-Item $Out).Length / 1MB), $id.Substring(0,12)) -ForegroundColor Green
