@echo off
:: Easy by zCHG.org — Windows one-click launcher
:: Double-click this file to start the full stack.
:: Requires Node.js ≥ 18 installed and on PATH.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node.exe not found on PATH.
    echo         Install Node.js from https://nodejs.org and try again.
    pause
    exit /b 1
)

node launch.mjs %*
pause
