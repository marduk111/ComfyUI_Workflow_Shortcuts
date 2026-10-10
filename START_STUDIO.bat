@echo off
title AI Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Please install it from https://nodejs.org then double-click this file again.
  echo.
  pause
  exit /b 1
)

node "studio\start.js"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo   Something went wrong. The message above should say what.
  echo.
  pause
)
exit /b %ERR%
