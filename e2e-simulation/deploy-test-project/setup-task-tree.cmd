@echo off
setlocal
title LLM Task Tree - 一键部署
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-task-tree.ps1"
if errorlevel 1 (
  echo.
  echo 部署失败，请查看上方错误信息。
  pause
  exit /b 1
)
