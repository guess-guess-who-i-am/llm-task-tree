@echo off
setlocal
title LLM Task Tree Setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0product-setup.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed.
  pause
  exit /b 1
)
echo.
echo Press any key to close...
pause >nul
