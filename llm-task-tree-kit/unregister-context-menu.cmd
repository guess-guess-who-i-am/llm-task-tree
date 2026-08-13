@echo off
setlocal
title 卸载 LLM Task Tree 右键菜单
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0unregister-context-menu.ps1"
echo 按任意键关闭...
pause >nul
