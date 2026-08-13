@echo off
setlocal
cd /d "%~dp0"
echo Starting block-flow prototype at http://127.0.0.1:5200
start "" "http://127.0.0.1:5200"
npm start
