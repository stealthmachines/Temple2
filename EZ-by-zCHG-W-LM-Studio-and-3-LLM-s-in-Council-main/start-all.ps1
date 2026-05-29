#!/usr/bin/env pwsh
# start-all.ps1  —  Launch the full MCP stack in one command.
#
# Opens four named terminal windows (Windows Terminal / conhost):
#   [1] server.js       port 3333  — MCP primary
#   [2] server-dos.js   port 3334  — MCP peer
#   [3] coord-proxy.js  port 1233  — HDGL phi-routing proxy (sits in front of LM Studio :1234)
#   [4] wuwei daemon    —           health.json writer + HDGL active-server pointer
#
# Usage:
#   .\start-all.ps1              # start everything
#   .\start-all.ps1 -NoProxy     # skip coord-proxy (if LM Studio isn't running)
#   .\start-all.ps1 -NoDaemon    # skip wuwei daemon
#   .\start-all.ps1 -Status      # probe ports only, don't start anything

param(
    [switch]$NoProxy,
    [switch]$NoDaemon,
    [switch]$Status
)

$ROOT  = Split-Path -Parent $MyInvocation.MyCommand.Path
$WUWEI = Join-Path $ROOT "wuwei-routing"

function Test-Port($port) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $ar  = $tcp.BeginConnect('127.0.0.1', $port, $null, $null)
        $ok  = $ar.AsyncWaitHandle.WaitOne(500)
        $tcp.Close()
        return $ok
    } catch { return $false }
}

function Show-Status {
    Write-Host ""
    Write-Host "── Stack status ──────────────────────────────────────"
    @(
        @{ port=3333; label="server.js      (MCP primary)" },
        @{ port=3334; label="server-dos.js  (MCP peer)   " },
        @{ port=1233; label="coord-proxy.js (HDGL proxy) " },
        @{ port=1234; label="LM Studio      (LLM backend)" }
    ) | ForEach-Object {
        $ok = Test-Port $_.port
        $sym = if ($ok) { "✓" } else { "✗" }
        $col = if ($ok) { "Green" } else { "DarkGray" }
        Write-Host ("  {0}  :{1}  {2}" -f $sym, $_.port, $_.label) -ForegroundColor $col
    }
    Write-Host ""
}

if ($Status) { Show-Status; exit 0 }

# ── Helper: open a new cmd window and run a command ──────────────────────────
function Start-Node($title, $cmdline, $dir = $ROOT) {
    Start-Process cmd -ArgumentList "/k title $title & $cmdline" -WorkingDirectory $dir
}

Write-Host ""
Write-Host "Starting MCP stack..." -ForegroundColor Cyan
Write-Host "Root: $ROOT"
Write-Host ""

# [1] MCP primary
if (-not (Test-Port 3333)) {
    Write-Host "  → server.js        :3333" -ForegroundColor Green
    Start-Node "MCP :3333" "node server.js"
    Start-Sleep -Milliseconds 800
} else {
    Write-Host "  ✓ server.js        :3333  already running" -ForegroundColor DarkGray
}

# [2] MCP peer
if (-not (Test-Port 3334)) {
    Write-Host "  → server-dos.js    :3334" -ForegroundColor Yellow
    Start-Node "MCP :3334" "set MCP_PORT=3334 && node server-dos.js"
    Start-Sleep -Milliseconds 800
} else {
    Write-Host "  ✓ server-dos.js    :3334  already running" -ForegroundColor DarkGray
}

# [3] coord-proxy (HDGL phi-router in front of LM Studio)
if (-not $NoProxy) {
    if (-not (Test-Port 1233)) {
        Write-Host "  → coord-proxy.js   :1233" -ForegroundColor Magenta
        Start-Node "HDGL :1233" "node coord-proxy.js"
        Start-Sleep -Milliseconds 600
    } else {
        Write-Host "  ✓ coord-proxy.js   :1233  already running" -ForegroundColor DarkGray
    }
} else {
    Write-Host "  –  coord-proxy skipped (-NoProxy)" -ForegroundColor DarkGray
}

# [4] wuwei routing daemon (writes health.json, tracks active_server)
if (-not $NoDaemon) {
    $daemonPid = Join-Path $WUWEI "daemon.pid"
    $running   = $false
    if (Test-Path $daemonPid) {
        $pid = Get-Content $daemonPid -ErrorAction SilentlyContinue
        if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) { $running = $true }
    }
    if (-not $running) {
        Write-Host "  → wuwei daemon     (health.json)" -ForegroundColor Cyan
        Start-Node "wuwei-daemon" "pwsh -NoProfile -ExecutionPolicy Bypass -File start-routes.ps1" $WUWEI
    } else {
        Write-Host "  ✓ wuwei daemon     already running (pid $pid)" -ForegroundColor DarkGray
    }
} else {
    Write-Host "  –  wuwei daemon skipped (-NoDaemon)" -ForegroundColor DarkGray
}

# ── Wait a moment then show status ───────────────────────────────────────────
Write-Host ""
Write-Host "Waiting for ports to open..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3
Show-Status

Write-Host "LM Studio (:1234) — start manually in LM Studio app if needed."
Write-Host "To stop everything:  Get-Process node | Stop-Process -Force"
Write-Host ""
