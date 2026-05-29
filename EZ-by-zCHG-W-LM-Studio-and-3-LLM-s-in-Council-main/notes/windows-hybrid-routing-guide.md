# Windows Hybrid Routing Implementation

## Files Created (Need Manual Copy on Windows)

The scripts were created for Linux but need Windows-compatible versions. Here's the Windows adaptation:

### 1. routing-daemon.bat (Windows version)
```batch
@echo off
set STATE_DIR=C:\wuwei-routing\state
set LOG_DIR=C:\wuwei-routing\logs
set PID_FILE=C:\wuwei-routing\daemon.pid
set PORT_MCP=4111
set PORT_MCP_DOS=4112
set LLM_PORT=1234
set CYCLE_INTERVAL=30

:: Initialize
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Main loop
timeout /t %CYCLE_INTERVAL% /nobreak >nul 2>&1
goto :main
```

### 2. router-phi.bat (Windows version)
```batch
@echo off
set STATE_DIR=C:\wuwei-routing\state
set /p PORT=0

if not exist "%STATE_DIR%\active_server" (
    echo phi-primary > "%STATE_DIR%\active_server"
)

set /p ACTIVE_SERVER=< "%STATE_DIR%\active_server"
set PORT=4111
if "%ACTIVE_SERVER%"=="phi-mirror" set PORT=4112

echo ROUTING_COMPLETE:server=%ACTIVE_SERVER%,port=%PORT%
echo %PORT%
```

### 3. Quick Start Guide
```batch
:: Create directory
mkdir C:\wuwei-routing

:: Copy scripts (from Linux versions)
copy /opt/wuwei-routing/*.sh C:\wuwei-routing\

:: Convert to .bat or use PowerShell

:: Start daemon
.\routing-daemon.bat

:: Test routing
.\router-phi.bat GET /test
```

## Key Differences

1. **Path separators**: Use backslashes instead of forward slashes
2. **Date commands**: Use `Get-Date` in PowerShell instead of `date`
3. **String operations**: Use PowerShell string methods
4. **Hashing**: Use `System.Security.Cryptography` for crypto
5. **Process checks**: Use `Get-Process` instead of `ps`

## Testing

Once files are created and running:
1. Check daemon status: `Get-Process | Where-Object {$_.Id -eq $(Get-Content daemon.pid)}`
2. View routing: `Get-Content state\active_server`
3. Test router: `.\\router-phi.bat GET /mcp/test`

Would you like me to:
1. **Create Windows PowerShell versions** of the scripts?
2. **Generate a batch file** that does everything?
3. **Create a Visual Studio Code extension** for easy routing?

Let me know and I'll create the Windows-compatible implementation! 🪟