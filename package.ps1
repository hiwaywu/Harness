# package.ps1 - wrap dist\dsh-nopolicy into ONE double-click exe (WinRAR SFX) that also upgrades.
#
#   .\build.ps1      # first: produce dist\dsh-nopolicy
#   .\package.ps1    # then : produce dist\DSH-NoPolicy.exe
#
# Double-click behaviour, no manual steps:
#   1. Presetup: stop any copy running from the target dir, delete target\resources (stale asar)
#   2. Extract  : overwrite every app file (Overwrite=1)
#   3. Setup    : copy seed\ into home\ ONLY for files that do not exist yet (keeps your prompts,
#                 selection, sessions and login), create the desktop shortcut, start the app
#
# So re-running a newer exe is a normal upgrade: home\ survives, app files are replaced.

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

$stage = Join-Path $PSScriptRoot "dist\_stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Write-Host "staging app files (home\ goes to seed\)"
robocopy $Src $stage /E /NFL /NDL /NJH /NJS /NP /XD (Join-Path $Src "home") | Out-Null
if (Test-Path (Join-Path $Src "home")) {
  robocopy (Join-Path $Src "home") (Join-Path $stage "seed") /E /NFL /NDL /NJH /NJS /NP | Out-Null
}
foreach ($junk in @("diagnose.txt","Diagnose.cmd","Apply-ToInstalled.cmd","Revert.cmd","Start-NoPolicy.cmd","boot.log","boot.err.log")) {
  $p = Join-Path $stage $junk
  if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}

$presetup = @'
@echo off
setlocal
set "TARGET=%LOCALAPPDATA%\Programs\DSH-NoPolicy"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '%TARGET%\*' } | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>&1
ping -n 3 127.0.0.1 >nul
if exist "%TARGET%\resources" rmdir /s /q "%TARGET%\resources" >nul 2>&1
exit /b 0
'@
$setup = @'
@echo off
setlocal
set "TARGET=%~dp0"
if not exist "%TARGET%home" mkdir "%TARGET%home" >nul 2>&1
if exist "%TARGET%seed" robocopy "%TARGET%seed" "%TARGET%home" /E /XC /XN /XO /NFL /NDL /NJH /NJS /NP >nul 2>&1
rem Vendor-owned prompt files are always refreshed on upgrade; only default.md (the operator's own
rem prompt) is seeded when absent. Without this, an amended anchor never reaches an existing install.
if exist "%TARGET%seed\prompts" (
  if not exist "%TARGET%home\prompts" mkdir "%TARGET%home\prompts" >nul 2>&1
  for %%F in (anchor.md anchor-plugin.md plugin-en.md plugin-zh.md) do (
    if exist "%TARGET%seed\prompts\%%F" copy /y "%TARGET%seed\prompts\%%F" "%TARGET%home\prompts\%%F" >nul 2>&1
  )
)
if exist "%TARGET%seed" rmdir /s /q "%TARGET%seed" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $p=Join-Path $d 'DeepSeek Harness (No Policy).lnk'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); $s.TargetPath='%TARGET%DeepSeek Harness.exe'; $s.WorkingDirectory='%TARGET%'; $s.Description='DeepSeek Harness without the host policy layer'; $s.Save()" >nul 2>&1
start "" "%TARGET%DeepSeek Harness.exe"
exit /b 0
'@
[System.IO.File]::WriteAllText((Join-Path $stage "presetup.cmd"), $presetup, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $stage "setup.cmd"), $setup, (New-Object System.Text.UTF8Encoding($false)))

$comment = @'
;The comment below contains SFX script commands
Title=DeepSeek Harness (No Policy)
Path=%LOCALAPPDATA%\Programs\DSH-NoPolicy
Silent=2
Overwrite=1
Presetup=presetup.cmd
Setup=setup.cmd
'@
$cfile = Join-Path $env:TEMP "dsh-sfx-comment.txt"
[System.IO.File]::WriteAllText($cfile, $comment, (New-Object System.Text.UTF8Encoding($false)))

if (Test-Path $Out) { Remove-Item $Out -Force }
Push-Location $stage
try {
  & $Rar a -sfx"$env:ProgramFiles\WinRAR\Default.SFX" -z"$cfile" -r -m3 -ma5 -idq $Out "*"
  if ($LASTEXITCODE -ne 0) { Fail "rar exited $LASTEXITCODE" }
} finally { Pop-Location }

& $Rar t -idq $Out
if ($LASTEXITCODE -ne 0) { Fail "archive test failed" }
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ("built: {0}  ({1:N0} MB)" -f $Out, ((Get-Item $Out).Length / 1MB)) -ForegroundColor Green
