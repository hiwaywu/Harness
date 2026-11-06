@echo off
setlocal
set "INST=C:\Users\hiway\AppData\Local\Programs\DeepSeek Harness"
if not exist "%INST%\resources\app.asar.orig" ( echo no backup found & pause & exit /b 1 )
copy /y "%INST%\resources\app.asar.orig" "%INST%\resources\app.asar"
echo restored original app.asar
pause