@echo off
setlocal
if "%~1"=="" (
  echo 缺少目标文件夹。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-task-tree.ps1" -ProjectRoot "%~1" -KitSource "%~dp0." -OpenAfterInstall
if errorlevel 1 (
  echo.
  echo 安装失败，请查看上方错误信息。
  pause
  exit /b 1
)
