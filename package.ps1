# package.ps1 - wrap dist\dsh-nopolicy into one self-extracting DSH-NoPolicy.exe (WinRAR SFX).
#
#   .\build.ps1      # first: produce dist\dsh-nopolicy
#   .\package.ps1    # then : produce dist\DSH-NoPolicy.exe
#
# Running the exe extracts to %LOCALAPPDATA%\Programs\DSH-NoPolicy (no admin), drops a desktop
# shortcut "DeepSeek Harness (No Policy)", and starts the app. Files the app created later in
# home\ are not in the archive, so re-running it (e.g. after a rebuild) keeps the profile.

param(
  [string]$Src = (Join-Path $PSScriptRoot "dist\dsh-nopolicy"),
  [string]$Out = (Join-Path $PSScriptRoot "dist\DSH-NoPolicy.exe"),
  [string]$Rar = "$env:ProgramFiles\WinRAR\Rar.exe"
)
$ErrorActionPreference = "Stop"
function Fail($m) { Write-Host "FAIL: $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $Src "DeepSeek Harness.exe"))) { Fail "no build at $Src - run build.ps1 first" }
if (-not (Test-Path $Rar)) { Fail "WinRAR's Rar.exe not found at $Rar" }
if (Get-Process | Where-Object { $_.Path -like "$Src\*" }) { Fail "the build in $Src is running - close it first" }

$comment = @'
;The comment below contains SFX script commands
Title=DeepSeek Harness (No Policy)
Path=%LOCALAPPDATA%\Programs\DSH-NoPolicy
Silent=2
Overwrite=1
Setup="DeepSeek Harness.exe"
Shortcut=D, "DeepSeek Harness.exe", "", "DeepSeek Harness without the host policy layer", "DeepSeek Harness (No Policy)"
'@
$cfile = Join-Path $env:TEMP "dsh-sfx-comment.txt"
[System.IO.File]::WriteAllText($cfile, $comment, (New-Object System.Text.UTF8Encoding($false)))

if (Test-Path $Out) { Remove-Item $Out -Force }
Push-Location $Src
try {
  & $Rar a -sfx"$env:ProgramFiles\WinRAR\Default.SFX" -z"$cfile" -r -m3 -ma5 -idq `
    -x"diagnose.txt" -x"Diagnose.cmd" -x"Apply-ToInstalled.cmd" -x"Revert.cmd" -x"Start-NoPolicy.cmd" `
    $Out "*"
  if ($LASTEXITCODE -ne 0) { Fail "rar exited $LASTEXITCODE" }
} finally { Pop-Location }

& $Rar t -idq $Out
if ($LASTEXITCODE -ne 0) { Fail "archive test failed" }
Write-Host ("built: {0}  ({1:N0} MB)" -f $Out, ((Get-Item $Out).Length / 1MB)) -ForegroundColor Green
