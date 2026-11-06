@echo off
setlocal
echo This replaces the app.asar of your INSTALLED DeepSeek Harness with the no-policy build.
echo Close DeepSeek Harness completely first, or the file is locked and this fails.
pause
set "INST=C:\Users\hiway\AppData\Local\Programs\DeepSeek Harness"
set "SRC=%~dp0"
if not exist "%INST%\resources\app.asar.orig" (
  copy /y "%INST%\resources\app.asar" "%INST%\resources\app.asar.orig"
  echo backed up original -^> app.asar.orig
)
copy /y "%SRC%resources\app.asar" "%INST%\resources\app.asar"
if exist "%SRC%resources\app.asar.unpacked" (
  if exist "%INST%\resources\app.asar.unpacked" rmdir /s /q "%INST%\resources\app.asar.unpacked"
  xcopy /e /i /y /q "%SRC%resources\app.asar.unpacked" "%INST%\resources\app.asar.unpacked" >nul
)
echo done. start DeepSeek Harness.
pause