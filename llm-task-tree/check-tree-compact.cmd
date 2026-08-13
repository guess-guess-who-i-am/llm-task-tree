@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-tree-compact.ps1" %*
exit /b %ERRORLEVEL%
