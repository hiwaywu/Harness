@echo off
cd /d "%~dp0"
set "DSH_HOME=%~dp0home"
set "ELECTRON_ENABLE_LOGGING=1"
echo ==== launch %DATE% %TIME% > "%~dp0diagnose.txt"
"%~dp0DeepSeek Harness.exe" >> "%~dp0diagnose.txt" 2>&1
echo ==== exit code: %ERRORLEVEL% >> "%~dp0diagnose.txt"
if exist "%APPDATA%\dsh-nopolicy" (echo userData: created >> "%~dp0diagnose.txt") else (echo userData: NOT created >> "%~dp0diagnose.txt")
echo ==== done >> "%~dp0diagnose.txt"
echo.
echo Result written to:
echo   %~dp0diagnose.txt
echo.
type "%~dp0diagnose.txt"
pause