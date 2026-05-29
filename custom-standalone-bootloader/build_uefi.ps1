$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$clang = "C:\Program Files\LLVM\bin\clang.exe"
if (-not (Test-Path $clang)) {
  throw "Missing tool: $clang"
}

function Invoke-Checked {
  param([string]$exe, [string[]]$argv)
  & $exe @argv
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $exe $($argv -join ' ')"
  }
}

Write-Host "[uefi] building BOOTX64.EFI..."
Invoke-Checked $clang @(
  "--target=x86_64-unknown-windows",
  "-ffreestanding",
  "-fshort-wchar",
  "-fno-stack-protector",
  "-mno-red-zone",
  "-nostdlib",
  "-Wl,/subsystem:efi_application",
  "-Wl,/entry:efi_main",
  "-Wl,/nodefaultlib",
  "-Wl,/out:BOOTX64.EFI",
  ".\\uefi_boot.c"
)

$efiOut = Join-Path $root 'BOOTX64.EFI'
if (-not (Test-Path $efiOut)) {
  throw "UEFI build failed: BOOTX64.EFI not produced."
}

$efiDir = Join-Path $root 'EFI\BOOT'
New-Item -Path $efiDir -ItemType Directory -Force | Out-Null
Copy-Item $efiOut (Join-Path $efiDir 'BOOTX64.EFI') -Force

Write-Host "[ok] built .\BOOTX64.EFI"
Write-Host "[ok] staged UEFI fallback path .\EFI\BOOT\BOOTX64.EFI"
