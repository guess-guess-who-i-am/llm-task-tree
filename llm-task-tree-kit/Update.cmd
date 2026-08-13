@echo off
setlocal
title LLM Task Tree - One Click Update
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0one-click-update.ps1"
if errorlevel 1 (
  echo.
  echo Update failed.
  pause
  exit /b 1
)
echo.
echo Done.
pause
