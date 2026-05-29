$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$clang = "C:\Program Files\LLVM\bin\clang.exe"
$ld = "C:\Program Files\LLVM\bin\ld.lld.exe"
$objcopy = "C:\Program Files\LLVM\bin\llvm-objcopy.exe"

function Invoke-Checked {
  param([string]$exe, [string[]]$argv)
  & $exe @argv
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $exe $($argv -join ' ')"
  }
}

function Set-UInt32LE {
  param(
    [byte[]]$Buffer,
    [int]$Offset,
    [uint32]$Value
  )
  $bytes = [BitConverter]::GetBytes($Value)
  [Array]::Copy($bytes, 0, $Buffer, $Offset, 4)
}

function Set-UInt64LE {
  param(
    [byte[]]$Buffer,
    [int]$Offset,
    [uint64]$Value
  )
  $bytes = [BitConverter]::GetBytes($Value)
  [Array]::Copy($bytes, 0, $Buffer, $Offset, 8)
}

foreach ($tool in @($clang, $ld, $objcopy)) {
  if (-not (Test-Path $tool)) {
    throw "Missing tool: $tool"
  }
}

Write-Host "[boot] assembling stage-1..."
Write-Host "[boot] assembling stage-2..."
Invoke-Checked $clang @("--target=i386-pc-none-elf","-m16","-ffreestanding","-fno-pic","-fno-pie","-c",".\\boot_stage2.S","-o",".\\boot_stage2.o")

Write-Host "[boot] linking stage-2..."
Invoke-Checked $ld @("-flavor","gnu","-m","elf_i386","-T",".\\boot_stage2.ld",".\\boot_stage2.o","-o",".\\boot_stage2.elf")

Write-Host "[boot] extracting stage-2 binary..."
Invoke-Checked $objcopy @("-O","binary",".\\boot_stage2.elf",".\\boot_stage2.bin")

Write-Host "[boot] assembling stage-3 (pmode bridge)..."
Invoke-Checked $clang @("--target=i386-pc-none-elf","-m16","-ffreestanding","-fno-pic","-fno-pie","-c",".\\boot_stage3.S","-o",".\\boot_stage3.o")

Write-Host "[boot] compiling kernel_main.c (freestanding 32-bit)..."
Invoke-Checked $clang @("--target=i386-pc-none-elf","-m32","-ffreestanding","-fno-pic","-fno-pie","-fno-stack-protector","-O2","-nostdlib","-c",".\\kernel_main.c","-o",".\\kernel_main.o")

Write-Host "[boot] linking stage-3 + kernel..."
Invoke-Checked $ld @("-flavor","gnu","-m","elf_i386","-T",".\\stage3_kernel.ld",".\\boot_stage3.o",".\\kernel_main.o","-o",".\\stage3_kernel.elf")

Write-Host "[boot] extracting stage-3+kernel binary..."
Invoke-Checked $objcopy @("-O","binary",".\\stage3_kernel.elf",".\\boot_stage3.bin")

[byte[]]$stage2 = [System.IO.File]::ReadAllBytes("$root\boot_stage2.bin")
[byte[]]$stage3 = [System.IO.File]::ReadAllBytes("$root\boot_stage3.bin")
$stage2Sectors = [int][Math]::Ceiling($stage2.Length / 512.0)
if ($stage2Sectors -lt 1) { $stage2Sectors = 1 }
if ($stage2Sectors -gt 32) {
  throw "Stage-2 too large for current stage-1 loader: $stage2Sectors sectors (max 32)."
}
# stage3 is now the full stage3+kernel binary — can be many KB
$stage3Sectors = [int][Math]::Ceiling($stage3.Length / 512.0)
if ($stage3Sectors -lt 1) { $stage3Sectors = 1 }
if ($stage3Sectors -gt 127) {
  throw "Stage-3+kernel too large: $stage3Sectors sectors (max 127 for single INT 13h call)."
}
Write-Host "[boot] stage-3+kernel: $($stage3.Length) bytes ($stage3Sectors sectors)"
[byte[]]$stage3Sector = New-Object byte[] ($stage3Sectors * 512)
[Array]::Copy($stage3, 0, $stage3Sector, 0, $stage3.Length)
[System.IO.File]::WriteAllBytes("$root\boot_stage3.sector.bin", $stage3Sector)

Write-Host "[boot] assembling stage-1..."
Invoke-Checked $clang @("--target=i386-pc-none-elf","-m16","-ffreestanding","-fno-pic","-fno-pie","-DSTAGE2_SECTORS=$stage2Sectors","-c",".\\boot_stage1.S","-o",".\\boot_stage1.o")

Write-Host "[boot] linking stage-1..."
Invoke-Checked $ld @("-flavor","gnu","-m","elf_i386","-T",".\\boot_stage1.ld",".\\boot_stage1.o","-o",".\\boot_stage1.elf")

Write-Host "[boot] extracting flat binary..."
Invoke-Checked $objcopy @("-O","binary",".\\boot_stage1.elf",".\\boot_stage1.bin")

[byte[]]$stage1 = [System.IO.File]::ReadAllBytes("$root\boot_stage1.bin")
if ($stage1.Length -gt 510) {
  throw "Stage-1 too large: $($stage1.Length) bytes (max 510)."
}

[byte[]]$sector = New-Object byte[] 512
[Array]::Copy($stage1, 0, $sector, 0, $stage1.Length)
$sector[510] = 0x55
$sector[511] = 0xAA
[System.IO.File]::WriteAllBytes("$root\boot_stage1.sector.bin", $sector)

# Build a simple 1.44MB bootable image with stage-1 in sector 0.
[byte[]]$image = New-Object byte[] (1474560)
[Array]::Copy($sector, 0, $image, 0, 512)

# Place stage-2 immediately after stage-1 (starting at LBA sector 1).
[Array]::Copy($stage2, 0, $image, 512, $stage2.Length)

# Add a RedSea partition entry (type 0x88) so stage-2 can probe it on test images.
$totalSectors = [int]($image.Length / 512)
$redSeaStartLba = 63
$redSeaSectors = 1024
if (($redSeaStartLba + $redSeaSectors) -gt $totalSectors) {
  throw "RedSea test partition does not fit image: start=$redSeaStartLba size=$redSeaSectors total=$totalSectors"
}

$entryOff = 446
$image[$entryOff + 0] = 0x80 # active
$image[$entryOff + 1] = 0x01 # CHS start head (placeholder)
$image[$entryOff + 2] = 0x01 # CHS start sector/cyl (placeholder)
$image[$entryOff + 3] = 0x00 # CHS start cylinder (placeholder)
$image[$entryOff + 4] = 0x88 # RedSea partition type
$image[$entryOff + 5] = 0xFE # CHS end head (placeholder)
$image[$entryOff + 6] = 0xFF # CHS end sector/cyl (placeholder)
$image[$entryOff + 7] = 0xFF # CHS end cylinder (placeholder)
Set-UInt32LE -Buffer $image -Offset ($entryOff + 8) -Value ([uint32]$redSeaStartLba)
Set-UInt32LE -Buffer $image -Offset ($entryOff + 12) -Value ([uint32]$redSeaSectors)
$image[510] = 0x55
$image[511] = 0xAA

# Write a minimal RedSea boot record at the partition start for probe validation.
$redSeaBootOff = $redSeaStartLba * 512
[byte[]]$redSeaBoot = New-Object byte[] 512
$redSeaRootLba   = $redSeaStartLba + 1
$redSeaStage3Lba = $redSeaStartLba + 2
$redSeaModelLba  = $redSeaStartLba + 2 + $stage3Sectors
$redSeaModelSize = 8GB
$redSeaBoot[0] = 0xEB
$redSeaBoot[1] = 0x3C
$redSeaBoot[2] = 0x90
$redSeaBoot[3] = 0x88 # CRedSeaBoot.signature / MBR_PT_REDSEA marker
Set-UInt64LE -Buffer $redSeaBoot -Offset 8 -Value ([uint64]$redSeaStartLba)  # drv_offset
Set-UInt64LE -Buffer $redSeaBoot -Offset 16 -Value ([uint64]$redSeaSectors)  # sects
Set-UInt64LE -Buffer $redSeaBoot -Offset 24 -Value ([uint64]$redSeaRootLba)  # root_clus
Set-UInt64LE -Buffer $redSeaBoot -Offset 32 -Value ([uint64]1)               # bitmap_sects
$uniqueId = [uint64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
Set-UInt64LE -Buffer $redSeaBoot -Offset 40 -Value $uniqueId                 # unique_id
$redSeaBoot[510] = 0x55
$redSeaBoot[511] = 0xAA
[Array]::Copy($redSeaBoot, 0, $image, $redSeaBootOff, 512)

# Place STAGE3.BIN (now stage3+kernel) in RedSea test area.
[Array]::Copy($stage3Sector, 0, $image, ($redSeaStage3Lba * 512), $stage3Sector.Length)

# Write a minimal RedSea root directory block with STAGE3.BIN + MODEL.BIN entries.
[byte[]]$rootDir = New-Object byte[] 512

# Entry 0: "." directory metadata.
$rootDir[0] = 0x10
$rootDir[1] = 0x08 # RS_ATTR_DIR | RS_ATTR_CONTIGUOUS
[Text.Encoding]::ASCII.GetBytes(".") | ForEach-Object -Begin { $i = 0 } -Process { $rootDir[2 + $i] = $_; $i++ }
Set-UInt64LE -Buffer $rootDir -Offset 40 -Value ([uint64]$redSeaRootLba)
Set-UInt64LE -Buffer $rootDir -Offset 48 -Value ([uint64]512)
Set-UInt64LE -Buffer $rootDir -Offset 56 -Value $uniqueId

# Entry 1: STAGE3.BIN contiguous payload descriptor.
$entry1 = 64
$rootDir[$entry1 + 0] = 0x20
$rootDir[$entry1 + 1] = 0x08 # RS_ATTR_ARCHIVE | RS_ATTR_CONTIGUOUS
$stage3NameBytes = [Text.Encoding]::ASCII.GetBytes("STAGE3.BIN")
[Array]::Copy($stage3NameBytes, 0, $rootDir, $entry1 + 2, $stage3NameBytes.Length)
Set-UInt64LE -Buffer $rootDir -Offset ($entry1 + 40) -Value ([uint64]$redSeaStage3Lba)
Set-UInt64LE -Buffer $rootDir -Offset ($entry1 + 48) -Value ([uint64]$stage3.Length)  # exact byte size so stage2 loads correct sector count
Set-UInt64LE -Buffer $rootDir -Offset ($entry1 + 56) -Value $uniqueId

# Entry 2: MODEL.BIN contiguous payload descriptor.
$entry2 = 128
$rootDir[$entry2 + 0] = 0x20
$rootDir[$entry2 + 1] = 0x08 # RS_ATTR_ARCHIVE | RS_ATTR_CONTIGUOUS
$modelNameBytes = [Text.Encoding]::ASCII.GetBytes("MODEL.BIN")
[Array]::Copy($modelNameBytes, 0, $rootDir, $entry2 + 2, $modelNameBytes.Length)
Set-UInt64LE -Buffer $rootDir -Offset ($entry2 + 40) -Value ([uint64]$redSeaModelLba)
Set-UInt64LE -Buffer $rootDir -Offset ($entry2 + 48) -Value ([uint64]$redSeaModelSize)
Set-UInt64LE -Buffer $rootDir -Offset ($entry2 + 56) -Value $uniqueId

[Array]::Copy($rootDir, 0, $image, ($redSeaRootLba * 512), 512)

[System.IO.File]::WriteAllBytes("$root\kiss2_boot.img", $image)

Write-Host "[ok] built .\boot_stage1.sector.bin (512 bytes, boot signature 0x55AA)"
Write-Host "[ok] built .\boot_stage2.bin ($($stage2.Length) bytes, $stage2Sectors sector(s))"
Write-Host "[ok] built .\boot_stage3.bin (stage3+kernel: $($stage3.Length) bytes, $stage3Sectors sector(s))"
Write-Host "[ok] built .\kiss2_boot.img (1.44MB boot image)"
Write-Host "[ok] RedSea test partition type 0x88 at LBA $redSeaStartLba ($redSeaSectors sectors)"
Write-Host "[ok] RedSea root: STAGE3.BIN at LBA $redSeaStage3Lba, MODEL.BIN at LBA $redSeaModelLba"
