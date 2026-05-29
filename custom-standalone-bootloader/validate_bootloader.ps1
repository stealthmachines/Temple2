$ErrorActionPreference = 'Stop'

$sectorPath = Join-Path $PSScriptRoot 'boot_stage1.sector.bin'
if (-not (Test-Path $sectorPath)) {
  throw "Missing $sectorPath. Run build_bootloader.ps1 first."
}

[byte[]]$sector = [System.IO.File]::ReadAllBytes($sectorPath)
if ($sector.Length -ne 512) {
  throw "Invalid sector size: $($sector.Length) (expected 512)."
}

$okSig = ($sector[510] -eq 0x55 -and $sector[511] -eq 0xAA)
if (-not $okSig) {
  throw "Missing boot signature 0x55AA."
}

Write-Host "[ok] sector size: 512"
Write-Host "[ok] boot signature: 0x55AA"
Write-Host "[ok] stage-1 is BIOS bootable"
