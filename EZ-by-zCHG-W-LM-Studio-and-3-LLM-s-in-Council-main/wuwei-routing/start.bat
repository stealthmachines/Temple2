@echo off
setlocal enabledelayedexpansion

echo ========================================
echo HDGL Hybrid Routing System (Windows)
echo Working Dir: C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing
echo ========================================
echo.

cd /d "C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing"

:: Check if PowerShell is available
where powershell >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: PowerShell not found
    pause
    exit /b 1
)

:: Create directories if needed
if not exist "state" mkdir state
if not exist "logs" mkdir logs

echo Starting routing daemon...
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-routes.ps1

echo.
echo Daemon started. Press Ctrl+C to stop.
echo.
powershell -NoProfile -Command "Read-Host 'Press ENTER to stop daemon'" | out-null

:: Cleanup
echo.
echo Stopping daemon...
powershell -NoProfile -Command "if (Test-Path '.\daemon.pid') { $p = Get-Content '.\daemon.pid'; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Remove-Item '.\daemon.pid' -ErrorAction SilentlyContinue }"

echo Daemon stopped.
echo Routing state cleared.
echo.
echo ========================================
echo System stopped.
echo ========================================