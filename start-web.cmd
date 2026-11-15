@echo off
cd /d "%~dp0"
start "soulroom server" /b node server/index.mjs
timeout /t 2 /nobreak >nul
start http://127.0.0.1:5288
