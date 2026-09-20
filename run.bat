@echo off
rem web-extractor - one-click launcher
rem Installs everything it needs into this folder. Nothing is installed system-wide.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1"
if errorlevel 1 (
  echo.
  echo Failed to start. See the messages above.
  pause
)
endlocal
