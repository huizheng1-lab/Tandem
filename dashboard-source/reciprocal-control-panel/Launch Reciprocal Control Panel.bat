@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js 20 or later, then run this file again.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dashboard.ps1" %*
if errorlevel 1 (
  echo.
  echo The reciprocal control panel could not be started.
  pause
  exit /b 1
)

endlocal
