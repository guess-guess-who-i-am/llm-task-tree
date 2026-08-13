@echo off
setlocal
title LLM Task Tree Uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0product-uninstall.ps1"
pause
