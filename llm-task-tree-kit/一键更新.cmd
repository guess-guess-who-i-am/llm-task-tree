@echo off
chcp 65001 >nul
setlocal
title LLM Task Tree - 一键更新
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0one-click-update.ps1"
if errorlevel 1 (
  echo.
  echo 更新失败。
  pause
  exit /b 1
)
echo.
echo 更新完成。
pause
