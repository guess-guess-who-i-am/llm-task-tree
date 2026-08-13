@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-task-tree.ps1"
if errorlevel 1 pause
