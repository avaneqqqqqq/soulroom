@echo off
cd /d "%~dp0"
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop.cjs"
  exit /b
)
echo Desktop dependencies are missing. Run npm install in this folder, then open start.cmd again.
echo The desktop app is required for automatic Yandex and SoundCloud sign-in.
pause
