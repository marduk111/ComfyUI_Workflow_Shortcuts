@echo off
title AI Studio - Installer
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo.
  echo   This installer needs Windows PowerShell, which every Windows 10/11 PC has.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALL.ps1"
echo.
echo   When everything says OK, double-click START_STUDIO.bat to launch the studio.
echo.
pause
exit /b 0
