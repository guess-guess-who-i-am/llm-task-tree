@echo off
setlocal
if "%~1"=="" (
  echo 缺少目标文件夹。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0context-menu-open.ps1" -ProjectRoot "%~1"
if errorlevel 1 exit /b 1
