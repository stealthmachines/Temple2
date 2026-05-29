param(
  [switch]$SkipFirewall,
  [switch]$SkipNodeInstall
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Node {
  param([switch]$SkipInstall)

  if (Get-Command node -ErrorAction SilentlyContinue) {
    $v = node -v
    Write-Host "[OK] Node detected: $v"
    return
  }

  if ($SkipInstall) {
    throw "Node.js not found. Install Node.js 18+ and re-run."
  }

  Write-Host "[INFO] Node.js not found. Attempting winget install..."
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget not available. Install Node.js 18+ from https://nodejs.org and re-run."
  }

  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node install did not complete in this shell. Open a new shell and run start-kernel.bat."
  }

  Write-Host "[OK] Node installed: $(node -v)"
}

function Ensure-FirewallRule {
  param(
    [string]$RuleName,
    [int]$Port
  )

  $existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "[OK] Firewall rule exists: $RuleName"
    return
  }

  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  Write-Host "[OK] Firewall opened TCP $Port ($RuleName)"
}

Write-Host "=== KISS2 Fresh Install Preflight ==="
Ensure-Node -SkipInstall:$SkipNodeInstall

if (-not $SkipFirewall) {
  if (-not (Test-Admin)) {
    Write-Host "[WARN] Not running as Administrator; skipping firewall setup."
    Write-Host "[WARN] For LAN access, run this script as Admin once or open ports 1618 and 17800 manually."
  } else {
    Ensure-FirewallRule -RuleName "KISS2 LAN Chat 1618" -Port 1618
    Ensure-FirewallRule -RuleName "KISS2 Kernel API 17800" -Port 17800
  }
}

Write-Host "[DONE] Preflight complete."
Write-Host "[NEXT] Put your model .gguf and llama-server.exe next to boot-kernel.mjs, then run start-kernel.bat."
