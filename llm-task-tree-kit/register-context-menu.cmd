@echo off
setlocal
title 注册 LLM Task Tree 右键菜单
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-context-menu.ps1"
if errorlevel 1 (
  echo.
  echo 注册失败。
  pause
  exit /b 1
)
echo 按任意键关闭...
pause >nul
