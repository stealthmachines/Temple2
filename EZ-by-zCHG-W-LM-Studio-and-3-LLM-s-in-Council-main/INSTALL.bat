@echo off
:: Easy by zCHG.org — One-Click Installer (Windows)
:: Double-click this file. Nothing else required — not even Node.js.
::
:: This script uses PowerShell (built into Windows 10/11) to:
::   1. Install Node.js LTS automatically (via winget or direct MSI download)
::   2. Download and install LM Studio silently
::   3. Download the Qwen3.5-9B model (~4 GB)
::   4. Start LM Studio server + load the model
::   5. Launch the MCP stack

title Easy by zCHG.org -- One-Click Installer
cd /d "%~dp0"

echo.
echo  ======================================================
echo   Easy by zCHG.org  ^|  One-Click Installer
echo   Starting...
echo  ======================================================
echo.

:: PowerShell 5.1 is built into every Windows 10/11 machine.
:: -ExecutionPolicy Bypass lets unsigned scripts run without any prior setup.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-bootstrap.ps1" %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo  Installation encountered an error. See messages above.
    echo.
    pause
    exit /b 1
)

