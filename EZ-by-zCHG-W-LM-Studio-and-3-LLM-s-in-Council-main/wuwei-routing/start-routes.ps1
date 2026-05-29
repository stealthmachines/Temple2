#!/usr/bin/env pwsh
# HDGL Hybrid Routing Daemon - Windows PowerShell Version
# Modified for Wu-Wei Architecture in state0 directory

$STATE_DIR = "C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing\state"
$LOG_DIR = "C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing\logs"
$PID_FILE = "C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing\daemon.pid"

# Create directories
$null = New-Item -Path $STATE_DIR -ItemType Directory -Force -ErrorAction SilentlyContinue
$null = New-Item -Path $LOG_DIR -ItemType Directory -Force -ErrorAction SilentlyContinue

# Generate initial state
$timestamp = Get-Date -Format "o"
$cycleId = Get-Random -Maximum 1000000

$healthState = @{
    timestamp = $timestamp
    cycle_id = $cycleId
    local_mcp     = @{ port = 3333; status = "UNKNOWN"; last_check = "never"; llm_context = 200000 }
    local_mcp_dos = @{ port = 3334; status = "UNKNOWN"; last_check = "never"; llm_context = 199999 }
    llm = @{ port = 1234; status = "UNKNOWN"; last_check = "never" }
}

$activeServer = "local-mcp"
$lastCycle = $timestamp

# Write initial state
$healthState | ConvertTo-Json -Depth 10 | Out-File -FilePath "$STATE_DIR\health.json"
$activeServer | Out-File -FilePath "$STATE_DIR\active_server" -Encoding UTF8
$lastCycle | Out-File -FilePath "$STATE_DIR\last_cycle" -Encoding UTF8

# Version info
$versionInfo = @"
HDGL Hybrid Routing Daemon v1.0
Wu-Wei Architecture Integration
Created: $timestamp
Directory: C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing
"@
$versionInfo | Out-File -FilePath "$STATE_DIR\version" -Encoding UTF8

# Health check via TCP port probe (SSE endpoints hold connections open, HTTP checks always timeout)
function Test-ServerHealth {
    param([int]$port)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $connect = $tcp.BeginConnect('127.0.0.1', $port, $null, $null)
        $wait = $connect.AsyncWaitHandle.WaitOne(500, $false)
        if ($wait -and $tcp.Connected) {
            $tcp.Close()
            return $true
        }
        $tcp.Close()
        return $false
    } catch {
        return $false
    }
}

# LLM health check via LM Studio REST API
function Test-LlmHealth {
    param([int]$port)
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/v1/models" -Method Get -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

# Main daemon loop
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "HDGL Hybrid Routing Daemon v1.0" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Monitoring: local-mcp (3333), local-mcp-dos (3334), LLM (1234)" -ForegroundColor Yellow
Write-Host "Cycle interval: 10s" -ForegroundColor Yellow
Write-Host "PID: $PID" -ForegroundColor Yellow
Write-Host "Working Dir: C:\Users\Owner\Downloads\MCP-Jailbreak-0.3 (1)\state0\wuwei-routing" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Daemon started. Press Ctrl+C to stop..." -ForegroundColor Green

$currentCycle = 0
$runOnce = $true

while ($true) {
    if ($runOnce -or $currentCycle -gt 0) {
        $timestamp = Get-Date -Format "o"
        $cycleId = Get-Random -Maximum 1000000
        $logFile = Join-Path $LOG_DIR "daemon-$(Get-Date -Format 'yyyyMMdd').log"

        Write-Host "[$cycleId] [$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting HDGL-style cycle" -ForegroundColor Gray | Tee-Object -FilePath $logFile

        # Check health
        $mcpStatus = if (Test-ServerHealth -port 3333) { "HEALTHY" } else { "UNHEALTHY" }
        $mcpDosStatus = if (Test-ServerHealth -port 3334) { "HEALTHY" } else { "UNHEALTHY" }
        $llmStatus = if (Test-LlmHealth -port 1234) { "HEALTHY" } else { "UNHEALTHY" }

        Write-Host "  [local-mcp:3333]: $mcpStatus" -ForegroundColor Gray | Tee-Object -Append -FilePath $logFile
        Write-Host "  [local-mcp-dos:3334]: $mcpDosStatus" -ForegroundColor Gray | Tee-Object -Append -FilePath $logFile
        Write-Host "  [LLM:1234]: $llmStatus" -ForegroundColor Gray | Tee-Object -Append -FilePath $logFile

        # Update health state
        $healthState.timestamp = $timestamp
        $healthState.cycle_id = $cycleId
        $healthState.local_mcp.status = $mcpStatus
        $healthState.local_mcp.last_check = $timestamp
        $healthState.local_mcp_dos.status = $mcpDosStatus
        $healthState.local_mcp_dos.last_check = $timestamp
        $healthState.llm.status = $llmStatus
        $healthState.llm.last_check = $timestamp

        # Determine active server
        $activeServer = "local-mcp"
        $cycleHash = "{0:X8}" -f (Get-Random -Maximum ([int]::MaxValue))

        if ($mcpStatus -eq "UNHEALTHY" -and $mcpDosStatus -eq "HEALTHY") {
            $activeServer = "local-mcp-dos"
            Write-Host "  [FAILOVER] Switched to local-mcp-dos (local-mcp unhealthy)" -ForegroundColor Red | Tee-Object -Append -FilePath $logFile
        } elseif ($mcpStatus -eq "UNHEALTHY" -and $mcpDosStatus -eq "UNHEALTHY") {
            $activeServer = "none"
            Write-Host "  [ERROR] Both MCP servers unhealthy - routing disabled" -ForegroundColor Red | Tee-Object -Append -FilePath $logFile
        } elseif ($mcpStatus -eq "HEALTHY" -and $mcpDosStatus -eq "HEALTHY") {
            # Load balance using time-based decision
            $epoch = Get-Date -UFormat "%s"
            $decision = $epoch % 2
            if ($decision -eq 1) {
                $activeServer = "local-mcp-dos"
            }
            Write-Host "  [ROUTING] Active server = $activeServer (phi-cycle hash: $cycleHash)" -ForegroundColor Cyan | Tee-Object -Append -FilePath $logFile
        } elseif ($mcpStatus -eq "HEALTHY" -and $mcpDosStatus -eq "UNHEALTHY") {
            $activeServer = "local-mcp"
            Write-Host "  [FAILOVER] Switched to local-mcp (local-mcp-dos unhealthy)" -ForegroundColor Red | Tee-Object -Append -FilePath $logFile
        }

        # Save state
        $healthState | ConvertTo-Json -Depth 10 | Out-File -FilePath "$STATE_DIR\health.json"
        $activeServer | Out-File -FilePath "$STATE_DIR\active_server" -Encoding UTF8
        $timestamp | Out-File -FilePath "$STATE_DIR\last_cycle" -Encoding UTF8

        # Check LLM
        if ($llmStatus -eq "UNHEALTHY") {
            Write-Host "  [WARNING] LLM server (1234) is unhealthy - consider fallback context" -ForegroundColor Yellow | Tee-Object -Append -FilePath $logFile
        }

        Write-Host "  [CYCLE] Complete. Active: $activeServer" -ForegroundColor Gray | Tee-Object -Append -FilePath $logFile

        $runOnce = $false
        $currentCycle = 0
    }

    # Wait for next cycle
    Start-Sleep -Seconds 10
    $currentCycle++
}