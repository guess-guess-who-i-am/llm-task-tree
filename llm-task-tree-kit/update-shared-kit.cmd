@echo off
setlocal
title LLM Task Tree - Update Shared Kit
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-shared-kit.ps1" %*
if errorlevel 1 (
  echo.
  echo Shared kit update failed.
  pause
  exit /b 1
)
echo.
pause
