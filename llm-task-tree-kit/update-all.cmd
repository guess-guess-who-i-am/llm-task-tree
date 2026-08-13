@echo off
setlocal
title LLM Task Tree - Update All Projects
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-all-projects.ps1" %*
if errorlevel 1 (
  echo.
  echo Batch update finished with errors.
  pause
  exit /b 1
)
echo.
echo Batch update complete.
pause
