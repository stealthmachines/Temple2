#!/usr/bin/env pwsh
# HDGL-Inspired Phi Routing Script - Windows PowerShell
# Modified for Wu-Wei Architecture in state0 directory

param(
    [Parameter(Mandatory = $true)]
    [string]$Method,
    
    [Parameter(Mandatory = $true)]
    [string]$Path,
    
    [string[]]$Headers = @()
)

$STATE_DIR = "C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing\state"
$PID_FILE = "C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing\daemon.pid"
$LOG_DIR = "C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing\logs"

# Verify daemon is running
if (-not (Test-Path $PID_FILE)) {
    Write-Host "ERROR: Routing daemon not running" -ForegroundColor Red
    exit 1
}

try {
    $daemonPid = Get-Content $PID_FILE -ErrorAction SilentlyContinue
    $daemonProcess = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
    
    if (-not $daemonProcess) {
        Write-Host "ERROR: Daemon process not running (stale PID file)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "ERROR: Could not verify daemon process" -ForegroundColor Red
    exit 1
}

# Golden ratio approximation
$Phi = 1.6180339887

# Compute phi hash (simulates analog computation)
function Get-PhiHash {
    param([string]$input)
    
    # Multiple hash transformations
    $hash1 = Get-FileHash -String $input -Algorithm MD5 | Select-Object -ExpandProperty Hash
    $hash2 = Get-FileHash -String $hash1 -Algorithm SHA1 | Select-Object -ExpandProperty Hash
    
    # Extract numeric portion
    $hash = $hash2 -replace '[^0-9]', ''
    
    # Compute sum of digits
    $sum = 0
    for ($i = 0; $i -lt $hash.Length; $i++) {
        $digit = [int]$hash[$i]
        $sum += $digit
    }
    
    # Normalize to 0-1 range
    $result = $sum % 2
    
    return $result.ToString()
}

# Get active server from state
function Get-ActiveServer {
    if (Test-Path "$STATE_DIR\active_server") {
        return Get-Content "$STATE_DIR\active_server" -ErrorAction SilentlyContinue
    }
    return "local-mcp"
}

# Get target port based on server
function Get-ServerPort {
    param([string]$server)
    
    switch ($server) {
        "local-mcp" { return 3333 }
        "local-mcp-dos" { return 3334 }
        "primary-llm","llm" { return 1234 }
        "none" { return 0 }
        default { return 3333 }
    }
}

# Check server health
function Test-ServerHealth {
    param([int]$port)
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$port/sse" -Method Get -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

# Main routing logic
$startTime = Get-Date
$hash = Get-PhiHash -Input "$Method:$Path"

$activeServer = Get-ActiveServer

# Intelligent routing based on request type
switch ($Path) {
    "*llm*" {
        $activeServer = "primary-llm"
        Write-Host "  [INTELLIGENT] LLM request detected, routing to primary context" -ForegroundColor Yellow
    }
    "*dos*" -or "*batch*" -or "*multi*" {
        $activeServer = "local-mcp-dos"
        Write-Host "  [INTELLIGENT] DOS-related request, routing to local-mcp-dos" -ForegroundColor Yellow
    }
}

# Get target port
$targetPort = Get-ServerPort -server $activeServer

# Log routing decision
$logFile = Join-Path "$STATE_DIR" "requests-$(Get-Date -Format 'yyyyMMdd').log"
$timestamp = Get-Date -Format "o"
$routeInfo = "$timestamp | $Method | $Path | hash=$hash | routed_to=$activeServer | port=$targetPort"

$routeInfo | Out-File -FilePath $logFile -Append -Encoding UTF8

Write-Host "ROUTING_COMPLETE:server=$activeServer,port=$targetPort,hash=$hash" -ForegroundColor Cyan

# Display usage info if no port returned
if ($targetPort -eq 0) {
    Write-Host "ERROR: No active server available" -ForegroundColor Red
    Write-Host "Checking health..."
    Write-Host "  local-mcp (3333): $(if (Test-ServerHealth -port 3333) { 'HEALTHY' } else { 'UNHEALTHY' })" -ForegroundColor Gray
    Write-Host "  local-mcp-dos (3334): $(if (Test-ServerHealth -port 3334) { 'HEALTHY' } else { 'UNHEALTHY' })" -ForegroundColor Gray
    Write-Host "  LLM (1234): $(if (Test-ServerHealth -port 1234) { 'HEALTHY' } else { 'UNHEALTHY' })" -ForegroundColor Gray
    
    exit 1
}

# Output just the port for easy integration
Write-Host $targetPort

exit 0