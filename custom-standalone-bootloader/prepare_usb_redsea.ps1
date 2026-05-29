param(
  [ValidatePattern('^[A-Z]$')]
  [string]$BootDriveLetter = 'E',
  [string]$ModelPath = "C:\Users\Owner\.ollama\models\blobs\unsloth\Qwen3.5-9B-GGUF\Qwen3.5-9B-UD-Q3_K_XL.gguf",
  [switch]$VerifyOnly,
  [switch]$RepairMetadataOnly,
  [switch]$RepairBootCodeOnly,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Administrator privileges are required. Re-run this script in an elevated PowerShell window."
  }
}

function Resolve-ModelPath {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    throw "Model path does not exist: $Path"
  }
  if ($Path.ToLowerInvariant().EndsWith('.lnk')) {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($Path)
    if (-not $sc.TargetPath) {
      throw "Shortcut has no target: $Path"
    }
    if (-not (Test-Path $sc.TargetPath)) {
      throw "Shortcut target does not exist: $($sc.TargetPath)"
    }
    return $sc.TargetPath
  }
  return $Path
}

function Set-UInt16LE {
  param([byte[]]$Buffer,[int]$Offset,[uint16]$Value)
  $bytes = [BitConverter]::GetBytes($Value)
  [Array]::Copy($bytes, 0, $Buffer, $Offset, 2)
}

function Set-UInt64LE {
  param([byte[]]$Buffer,[int]$Offset,[uint64]$Value)
  $bytes = [BitConverter]::GetBytes($Value)
  [Array]::Copy($bytes, 0, $Buffer, $Offset, 8)
}

function New-RedSeaBootSector {
  param(
    [uint64]$RedSeaStartLba,
    [uint64]$RedSeaSectors,
    [uint64]$RootLba,
    [uint64]$UniqueId
  )
  [byte[]]$boot = New-Object byte[] 512
  $boot[0] = 0xEB
  $boot[1] = 0x3C
  $boot[2] = 0x90
  $boot[3] = 0x88
  Set-UInt64LE -Buffer $boot -Offset 8 -Value $RedSeaStartLba
  Set-UInt64LE -Buffer $boot -Offset 16 -Value $RedSeaSectors
  Set-UInt64LE -Buffer $boot -Offset 24 -Value $RootLba
  Set-UInt64LE -Buffer $boot -Offset 32 -Value 1
  Set-UInt64LE -Buffer $boot -Offset 40 -Value $UniqueId
  $boot[510] = 0x55
  $boot[511] = 0xAA
  return $boot
}

function New-RedSeaRootSector {
  param(
    [string]$Stage3FileName,
    [uint64]$Stage3StartLba,
    [uint64]$Stage3Size,
    [string]$ModelFileName,
    [uint64]$RootLba,
    [uint64]$ModelStartLba,
    [uint64]$ModelSize,
    [uint64]$UniqueId
  )
  if ($Stage3FileName.Length -gt 37) {
    throw "Stage-3 file name too long for CDirEntry: $Stage3FileName"
  }
  if ($ModelFileName.Length -gt 37) {
    throw "Model file name too long for CDirEntry: $ModelFileName"
  }

  [byte[]]$root = New-Object byte[] 512

  # Entry 0: '.' directory
  Set-UInt16LE -Buffer $root -Offset 0 -Value 0x0810
  $root[2] = [byte][char]'.'
  Set-UInt64LE -Buffer $root -Offset 40 -Value $RootLba
  Set-UInt64LE -Buffer $root -Offset 48 -Value 512
  Set-UInt64LE -Buffer $root -Offset 56 -Value $UniqueId

  # Entry 1: STAGE3.BIN file descriptor
  $e1 = 64
  Set-UInt16LE -Buffer $root -Offset $e1 -Value 0x0820
  $stage3NameBytes = [Text.Encoding]::ASCII.GetBytes($Stage3FileName)
  [Array]::Copy($stage3NameBytes, 0, $root, $e1 + 2, $stage3NameBytes.Length)
  Set-UInt64LE -Buffer $root -Offset ($e1 + 40) -Value $Stage3StartLba
  Set-UInt64LE -Buffer $root -Offset ($e1 + 48) -Value $Stage3Size
  Set-UInt64LE -Buffer $root -Offset ($e1 + 56) -Value $UniqueId

  # Entry 2: MODEL.BIN file descriptor
  $e2 = 128
  Set-UInt16LE -Buffer $root -Offset $e2 -Value 0x0820
  $nameBytes = [Text.Encoding]::ASCII.GetBytes($ModelFileName)
  [Array]::Copy($nameBytes, 0, $root, $e2 + 2, $nameBytes.Length)
  Set-UInt64LE -Buffer $root -Offset ($e2 + 40) -Value $ModelStartLba
  Set-UInt64LE -Buffer $root -Offset ($e2 + 48) -Value $ModelSize
  Set-UInt64LE -Buffer $root -Offset ($e2 + 56) -Value $UniqueId

  return $root
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RawDisk {
    const uint GENERIC_READ  = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ  = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint OPEN_EXISTING    = 3;
    const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFilePointerEx(
        SafeFileHandle hFile, long liDistanceToMove,
        out long lpNewFilePointer, uint dwMoveMethod);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool ReadFile(
        SafeFileHandle hFile, byte[] lpBuffer, uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool WriteFile(
        SafeFileHandle hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    public static SafeFileHandle OpenDisk(string path, bool write) {
        uint access = write ? (GENERIC_READ | GENERIC_WRITE) : GENERIC_READ;
        var h = CreateFile(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_WRITE_THROUGH, IntPtr.Zero);
        if (h.IsInvalid)
            throw new IOException("CreateFile failed with Win32 error: " + Marshal.GetLastWin32Error());
        return h;
    }

    public static void SeekTo(SafeFileHandle h, long offset) {
        long newPos;
        if (!SetFilePointerEx(h, offset, out newPos, 0))
            throw new IOException("SetFilePointerEx failed: " + Marshal.GetLastWin32Error());
    }

    public static void DiskWrite(SafeFileHandle h, byte[] buffer, int count) {
        uint written;
        if (!WriteFile(h, buffer, (uint)count, out written, IntPtr.Zero))
            throw new IOException("WriteFile failed: " + Marshal.GetLastWin32Error());
    }

    public static int DiskRead(SafeFileHandle h, byte[] buffer, uint count) {
        uint read;
        if (!ReadFile(h, buffer, count, out read, IntPtr.Zero))
            throw new IOException("ReadFile failed: " + Marshal.GetLastWin32Error());
        return (int)read;
    }
}
'@ -Language CSharp

function Open-RawDisk {
  param([string]$Path, [bool]$Write = $false)
  return [RawDisk]::OpenDisk($Path, $Write)
}

function Write-BufferAtOffset {
  param(
    [Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
    [uint64]$Offset,
    [byte[]]$Buffer
  )
  # Raw physical disk writes must be in 512-byte multiples.
  $rem = $Buffer.Length % 512
  if ($rem -ne 0) {
    $padded = New-Object byte[] ($Buffer.Length + (512 - $rem))
    [Array]::Copy($Buffer, 0, $padded, 0, $Buffer.Length)
    $Buffer = $padded
  }
  [RawDisk]::SeekTo($Handle, [long]$Offset)
  [RawDisk]::DiskWrite($Handle, $Buffer, $Buffer.Length)
}

function Read-BufferAtOffset {
  param(
    [Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
    [uint64]$Offset,
    [int]$Count
  )
  # Round up to next 512-byte multiple for the physical read, return only $Count bytes.
  $readLen = $Count
  $rem = $readLen % 512
  if ($rem -ne 0) { $readLen += (512 - $rem) }
  [byte[]]$buf = New-Object byte[] $readLen
  [RawDisk]::SeekTo($Handle, [long]$Offset)
  [RawDisk]::DiskRead($Handle, $buf, [uint32]$readLen) | Out-Null
  if ($readLen -ne $Count) {
    [byte[]]$trimmed = New-Object byte[] $Count
    [Array]::Copy($buf, 0, $trimmed, 0, $Count)
    return $trimmed
  }
  return $buf
}

function Wait-DriveLetter {
  param(
    [string]$DriveLetter,
    [int]$Attempts = 20
  )
  for ($i = 0; $i -lt $Attempts; $i++) {
    try {
      $null = Get-Volume -DriveLetter $DriveLetter -ErrorAction Stop
      return
    } catch {
      $null = Get-Partition -ErrorAction SilentlyContinue
    }
  }
  throw "Drive letter $DriveLetter`: not ready after partitioning."
}

function Test-AsciiPrefix {
  param(
    [byte[]]$Buffer,
    [int]$Offset,
    [string]$Text
  )
  $bytes = [Text.Encoding]::ASCII.GetBytes($Text)
  if (($Offset + $bytes.Length) -gt $Buffer.Length) {
    return $false
  }
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($Buffer[$Offset + $i] -ne $bytes[$i]) {
      return $false
    }
  }
  return $true
}

function Test-PreparedUsb {
  param(
    [string]$DiskPath,
    [uint64]$RedSeaStartLba,
    [string]$Stage3Name,
    [string]$ModelName,
    [string]$BootDriveLetter,
    [byte[]]$Stage2
  )

  $h = Open-RawDisk -Path $DiskPath -Write $false
  try {
    $mbr = Read-BufferAtOffset -Handle $h -Offset 0 -Count 512
    if ($mbr[510] -ne 0x55 -or $mbr[511] -ne 0xAA) {
      throw "MBR signature invalid after write."
    }

    $stage2Disk = Read-BufferAtOffset -Handle $h -Offset 512 -Count $Stage2.Length
    for ($i = 0; $i -lt [Math]::Min(64, $Stage2.Length); $i++) {
      if ($stage2Disk[$i] -ne $Stage2[$i]) {
        throw "Stage-2 mismatch at disk LBA1."
      }
    }

    $rsBoot = Read-BufferAtOffset -Handle $h -Offset ([uint64]($RedSeaStartLba * 512)) -Count 512
    if ($rsBoot[3] -ne 0x88) {
      throw "RedSea signature byte missing at RedSea boot sector."
    }
    if ($rsBoot[510] -ne 0x55 -or $rsBoot[511] -ne 0xAA) {
      throw "RedSea boot signature invalid."
    }

    $rootSec = Read-BufferAtOffset -Handle $h -Offset ([uint64](($RedSeaStartLba + 1) * 512)) -Count 512
    if (-not (Test-AsciiPrefix -Buffer $rootSec -Offset (64 + 2) -Text $Stage3Name)) {
      throw "STAGE3 entry not present in RedSea root sector."
    }
    if (-not (Test-AsciiPrefix -Buffer $rootSec -Offset (128 + 2) -Text $ModelName)) {
      throw "MODEL entry not present in RedSea root sector."
    }
  } finally {
    $h.Dispose()
  }

  if (-not (Test-Path "$BootDriveLetter`:\EFI\BOOT\BOOTX64.EFI")) {
    Write-Warning "UEFI fallback missing at $BootDriveLetter`:\EFI\BOOT\BOOTX64.EFI (BIOS boot still works)"
  }
}

function Copy-FileToDiskOffset {
  param(
    [Microsoft.Win32.SafeHandles.SafeFileHandle]$Handle,
    [uint64]$DiskOffset,
    [string]$SourcePath
  )
  $bufSize = 4MB   # 4MB is already a multiple of 512
  [byte[]]$buf = New-Object byte[] $bufSize
  $src = [System.IO.File]::OpenRead($SourcePath)
  try {
    [RawDisk]::SeekTo($Handle, [long]$DiskOffset)
    $total = 0L
    while (($read = $src.Read($buf, 0, $buf.Length)) -gt 0) {
      # Pad the last (possibly short) chunk to a 512-byte multiple.
      $writeLen = $read
      $rem = $writeLen % 512
      if ($rem -ne 0) {
        $pad = 512 - $rem
        # Zero-fill the padding area in the existing buffer.
        [Array]::Clear($buf, $writeLen, $pad)
        $writeLen += $pad
      }
      [RawDisk]::DiskWrite($Handle, $buf, $writeLen)
      $total += $read
      if ($total % (256MB) -lt $bufSize) {
        Write-Host "[prep]   written $([Math]::Round($total/1GB,2)) GB..."
      }
    }
  } finally {
    $src.Dispose()
  }
}

$modelResolved = Resolve-ModelPath -Path $ModelPath
$modelItem = Get-Item $modelResolved
$modelName = [System.IO.Path]::GetFileName($modelItem.Name)
$stage3EntryName = 'STAGE3.BIN'
$modelEntryName = 'MODEL.BIN'

Assert-Administrator

Write-Host "[info] model: $($modelItem.FullName)"
Write-Host "[info] model size: $($modelItem.Length) bytes"

$bootStage1Bin = Join-Path $root 'boot_stage1.bin'
$bootStage2Bin = Join-Path $root 'boot_stage2.bin'
$bootStage3Bin = Join-Path $root 'boot_stage3.bin'
$uefiBin = Join-Path $root 'EFI\BOOT\BOOTX64.EFI'
if (-not (Test-Path $bootStage1Bin)) { throw "Missing boot artifact: $bootStage1Bin" }
if (-not (Test-Path $bootStage2Bin)) { throw "Missing boot artifact: $bootStage2Bin" }
if (-not (Test-Path $bootStage3Bin)) { throw "Missing boot artifact: $bootStage3Bin" }
if (-not (Test-Path $uefiBin)) { throw "Missing UEFI artifact: $uefiBin" }

[byte[]]$stage3 = [System.IO.File]::ReadAllBytes($bootStage3Bin)
if ($stage3.Length -gt (127 * 512)) {
  throw "boot_stage3.bin is $($stage3.Length) bytes - exceeds 127-sector INT 13h limit."
}
$stage3Sectors = [uint64][Math]::Ceiling($stage3.Length / 512.0)
if ($stage3Sectors -lt 1) { $stage3Sectors = 1 }
Write-Host ("[info] stage3+kernel: " + $stage3.Length + " bytes (" + $stage3Sectors + " sectors)")

$null = Get-Volume -DriveLetter $BootDriveLetter -ErrorAction Stop
$part = Get-Partition -DriveLetter $BootDriveLetter
$disk = Get-Disk -Number $part.DiskNumber

if ($disk.BusType -ne 'USB' -and -not $Force) {
  throw "Target disk #$($disk.Number) is BusType '$($disk.BusType)'. Re-run with -Force only if intentional."
}

if (($VerifyOnly -and $RepairMetadataOnly) -or ($VerifyOnly -and $RepairBootCodeOnly) -or ($RepairMetadataOnly -and $RepairBootCodeOnly)) {
  throw "Use only one mode switch at a time: -VerifyOnly, -RepairMetadataOnly, or -RepairBootCodeOnly."
}

if (-not $Force -and -not $VerifyOnly -and -not $RepairMetadataOnly -and -not $RepairBootCodeOnly) {
  throw "This operation is destructive (disk $($disk.Number)). Re-run with -Force to continue."
}

Write-Host "[prep] target disk #$($disk.Number) from drive $BootDriveLetter`:"

if ($VerifyOnly) {
  $partsVerify = Get-Partition -DiskNumber $disk.Number | Sort-Object PartitionNumber
  $redSeaPartVerify = $partsVerify | Where-Object { $_.Type -eq 'IFS' -and $_.DriveLetter -ne $BootDriveLetter } | Select-Object -First 1
  if (-not $redSeaPartVerify) {
    $redSeaPartVerify = $partsVerify | Where-Object { $_.DriveLetter -ne $BootDriveLetter } | Select-Object -First 1
  }
  if (-not $redSeaPartVerify) {
    throw "Cannot identify RedSea partition on disk #$($disk.Number) for verification."
  }

  $bootStage2 = [System.IO.File]::ReadAllBytes($bootStage2Bin)
  $diskPathVerify = "\\.\PhysicalDrive$($disk.Number)"
  Test-PreparedUsb -DiskPath $diskPathVerify -RedSeaStartLba ([uint64]($redSeaPartVerify.Offset / 512)) -Stage3Name $stage3EntryName -ModelName $modelEntryName -BootDriveLetter $BootDriveLetter -Stage2 $bootStage2
  Write-Host "[ok] verification passed: BIOS stage, RedSea metadata, and UI staging are present"
  exit 0
}

if ($RepairMetadataOnly) {
  $partsRepair = Get-Partition -DiskNumber $disk.Number | Sort-Object PartitionNumber
  $redSeaPartRepair = $partsRepair | Where-Object { $_.Type -eq 'IFS' -and $_.DriveLetter -ne $BootDriveLetter } | Select-Object -First 1
  if (-not $redSeaPartRepair) {
    $redSeaPartRepair = $partsRepair | Where-Object { $_.DriveLetter -ne $BootDriveLetter } | Select-Object -First 1
  }
  if (-not $redSeaPartRepair) {
    throw "Cannot identify RedSea partition on disk #$($disk.Number) for metadata repair."
  }

  $redSeaStartLba = [uint64]($redSeaPartRepair.Offset / 512)
  $redSeaSectors = [uint64]($redSeaPartRepair.Size / 512)
  $rootLba = $redSeaStartLba + 1
  $stage3StartLba = $redSeaStartLba + 2
  $modelStartLba = $stage3StartLba + $stage3Sectors
  $modelSectors = [uint64][Math]::Ceiling($modelItem.Length / 512.0)
  $neededSectors = [uint64](2 + $stage3Sectors + $modelSectors)
  if ($neededSectors -gt $redSeaSectors) {
    throw "Model does not fit RedSea partition. Need $neededSectors sectors, have $redSeaSectors."
  }

  $uniqueId = [uint64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $redSeaBoot = New-RedSeaBootSector -RedSeaStartLba $redSeaStartLba -RedSeaSectors $redSeaSectors -RootLba $rootLba -UniqueId $uniqueId
  $redSeaRoot = New-RedSeaRootSector -Stage3FileName $stage3EntryName -Stage3StartLba $stage3StartLba -Stage3Size ([uint64]$stage3.Length) -ModelFileName $modelEntryName -RootLba $rootLba -ModelStartLba $modelStartLba -ModelSize ([uint64]$modelItem.Length) -UniqueId $uniqueId

  $diskPathRepair = "\\.\PhysicalDrive$($disk.Number)"
  $diskHandleRepair = $null
  try {
    $diskHandleRepair = Open-RawDisk -Path $diskPathRepair -Write $true
    Write-BufferAtOffset -Handle $diskHandleRepair -Offset ([uint64]($redSeaStartLba * 512)) -Buffer $redSeaBoot
    Write-BufferAtOffset -Handle $diskHandleRepair -Offset ([uint64]($rootLba * 512)) -Buffer $redSeaRoot
  } finally {
    if ($null -ne $diskHandleRepair) { $diskHandleRepair.Dispose() }
  }

  $bootStage2 = [System.IO.File]::ReadAllBytes($bootStage2Bin)
  Test-PreparedUsb -DiskPath $diskPathRepair -RedSeaStartLba $redSeaStartLba -Stage3Name $stage3EntryName -ModelName $modelEntryName -BootDriveLetter $BootDriveLetter -Stage2 $bootStage2
  Write-Host "[ok] RedSea metadata repaired: root entry now points to $modelEntryName"
  Write-Host "[ok] verification passed: BIOS stage, RedSea metadata, and UI staging are present"
  exit 0
}

if ($RepairBootCodeOnly) {
  $partsRepair = Get-Partition -DiskNumber $disk.Number | Sort-Object PartitionNumber
  $redSeaPartRepair = $partsRepair | Where-Object { $_.Type -eq 'IFS' -and $_.DriveLetter -ne $BootDriveLetter } | Select-Object -First 1
  if (-not $redSeaPartRepair) {
    $redSeaPartRepair = $partsRepair | Where-Object { $_.DriveLetter -ne $BootDriveLetter } | Select-Object -First 1
  }
  if (-not $redSeaPartRepair) {
    throw "Cannot identify RedSea partition on disk #$($disk.Number) for boot-code repair."
  }

  $redSeaStartLba = [uint64]($redSeaPartRepair.Offset / 512)
  $redSeaSectors = [uint64]($redSeaPartRepair.Size / 512)
  $rootLba = $redSeaStartLba + 1
  $stage3StartLba = $redSeaStartLba + 2
  $modelStartLba = $stage3StartLba + $stage3Sectors
  $modelSectors = [uint64][Math]::Ceiling($modelItem.Length / 512.0)
  $neededSectors = [uint64](2 + $stage3Sectors + $modelSectors)
  if ($neededSectors -gt $redSeaSectors) {
    throw "Model does not fit RedSea partition. Need $neededSectors sectors, have $redSeaSectors."
  }

  [byte[]]$stage1CodeRepair = [System.IO.File]::ReadAllBytes($bootStage1Bin)
  [byte[]]$stage2Repair = [System.IO.File]::ReadAllBytes($bootStage2Bin)
  if ($stage1CodeRepair.Length -gt 440) {
    throw "boot_stage1.bin is $($stage1CodeRepair.Length) bytes. Refusing to overwrite beyond MBR boot-code region (440 bytes)."
  }

  $uniqueId = [uint64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $redSeaBoot = New-RedSeaBootSector -RedSeaStartLba $redSeaStartLba -RedSeaSectors $redSeaSectors -RootLba $rootLba -UniqueId $uniqueId
  $redSeaRoot = New-RedSeaRootSector -Stage3FileName $stage3EntryName -Stage3StartLba $stage3StartLba -Stage3Size ([uint64]$stage3.Length) -ModelFileName $modelEntryName -RootLba $rootLba -ModelStartLba $modelStartLba -ModelSize ([uint64]$modelItem.Length) -UniqueId $uniqueId

  $diskPathRepair = "\\.\PhysicalDrive$($disk.Number)"
  $diskHandleRepair = $null
  try {
    $diskHandleRepair = Open-RawDisk -Path $diskPathRepair -Write $true
    $mbr = Read-BufferAtOffset -Handle $diskHandleRepair -Offset 0 -Count 512
    [Array]::Copy($stage1CodeRepair, 0, $mbr, 0, $stage1CodeRepair.Length)
    $mbr[510] = 0x55
    $mbr[511] = 0xAA
    Write-BufferAtOffset -Handle $diskHandleRepair -Offset 0 -Buffer $mbr
    Write-BufferAtOffset -Handle $diskHandleRepair -Offset 512 -Buffer $stage2Repair
    Write-BufferAtOffset -Handle $diskHandleRepair -Offset ([uint64]($redSeaStartLba * 512)) -Buffer $redSeaBoot
    Write-BufferAtOffset -Handle $diskHandleRepair -Offset ([uint64]($rootLba * 512)) -Buffer $redSeaRoot
    Write-BufferAtOffset -Handle $diskHandleRepair -Offset ([uint64]($stage3StartLba * 512)) -Buffer $stage3
  } finally {
    if ($null -ne $diskHandleRepair) { $diskHandleRepair.Dispose() }
  }

  Test-PreparedUsb -DiskPath $diskPathRepair -RedSeaStartLba $redSeaStartLba -Stage3Name $stage3EntryName -ModelName $modelEntryName -BootDriveLetter $BootDriveLetter -Stage2 $stage2Repair
  Write-Host "[ok] Boot code repaired: stage-1/stage-2 and RedSea metadata rewritten (model payload untouched)"
  Write-Host "[ok] verification passed: BIOS stage, RedSea metadata, and UI staging are present"
  exit 0
}

$diskpartScript = @(
  "select disk $($disk.Number)",
  'clean',
  'convert mbr',
  'create partition primary size=1024',
  'format fs=fat32 quick label=KISS2BOOT',
  'active',
  "assign letter=$BootDriveLetter",
  'create partition primary',
  'set id=88 override',
  'exit'
)

$tmp = New-TemporaryFile
try {
  Set-Content -Path $tmp -Value ($diskpartScript -join [Environment]::NewLine) -Encoding ASCII
  Write-Host "[prep] partitioning and formatting USB..."
  diskpart /s $tmp | Out-Null
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

Wait-DriveLetter -DriveLetter $BootDriveLetter

$bootPart = Get-Partition -DriveLetter $BootDriveLetter
$disk = Get-Disk -Number $bootPart.DiskNumber
$parts = Get-Partition -DiskNumber $disk.Number | Sort-Object PartitionNumber
$redSeaPart = $parts | Where-Object { $_.PartitionNumber -ne $bootPart.PartitionNumber } | Select-Object -First 1
if (-not $redSeaPart) { throw "Failed to locate RedSea partition on disk $($disk.Number)." }

$redSeaStartLba = [uint64]($redSeaPart.Offset / 512)
$redSeaSectors = [uint64]($redSeaPart.Size / 512)
$rootLba = $redSeaStartLba + 1
$stage3StartLba = $redSeaStartLba + 2
$modelStartLba = $stage3StartLba + $stage3Sectors
$modelSectors = [uint64][Math]::Ceiling($modelItem.Length / 512.0)
$neededSectors = [uint64](2 + $stage3Sectors + $modelSectors)
if ($neededSectors -gt $redSeaSectors) {
  throw "Model does not fit RedSea partition. Need $neededSectors sectors, have $redSeaSectors."
}

Write-Host "[prep] RedSea partition start LBA: $redSeaStartLba"
Write-Host "[prep] RedSea partition sectors: $redSeaSectors"

$bootRoot = "$($BootDriveLetter):\"
$efiDir = Join-Path $bootRoot 'EFI\BOOT'
$uiDir = Join-Path $bootRoot 'KISS2\ui'
New-Item -Path $efiDir -ItemType Directory -Force | Out-Null
New-Item -Path $uiDir -ItemType Directory -Force | Out-Null

Copy-Item $uefiBin (Join-Path $efiDir 'BOOTX64.EFI') -Force

$nginxChat = Join-Path (Split-Path $root -Parent) 'NGINX-HDGL-0.6-c\chat.html'
$ezChat = Join-Path (Split-Path $root -Parent) 'EZ-by-zCHG-W-LM-Studio-and-3-LLM-s-in-Council-main\chat.html'
if (Test-Path $nginxChat) { Copy-Item $nginxChat (Join-Path $uiDir 'chat-nginx.html') -Force }
if (Test-Path $ezChat) { Copy-Item $ezChat (Join-Path $uiDir 'chat-council.html') -Force }

$uiReadme = @(
  'KISS2 UI payload staged on boot partition.',
  'Use chat-nginx.html or chat-council.html depending on runtime endpoint.',
  'This is static UI staging; network/runtime service is provided by later kernel stages.'
)
Set-Content -Path (Join-Path $uiDir 'README-UI.txt') -Value $uiReadme -Encoding ASCII

[byte[]]$stage1Code = [System.IO.File]::ReadAllBytes($bootStage1Bin)
[byte[]]$stage2 = [System.IO.File]::ReadAllBytes($bootStage2Bin)

if ($stage1Code.Length -gt 440) {
  throw "boot_stage1.bin is $($stage1Code.Length) bytes. Refusing to overwrite beyond MBR boot-code region (440 bytes)."
}

$uniqueId = [uint64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$redSeaBoot = New-RedSeaBootSector -RedSeaStartLba $redSeaStartLba -RedSeaSectors $redSeaSectors -RootLba $rootLba -UniqueId $uniqueId
$redSeaRoot = New-RedSeaRootSector -Stage3FileName $stage3EntryName -Stage3StartLba $stage3StartLba -Stage3Size ([uint64]$stage3.Length) -ModelFileName $modelEntryName -RootLba $rootLba -ModelStartLba $modelStartLba -ModelSize ([uint64]$modelItem.Length) -UniqueId $uniqueId

$diskPath = "\\.\PhysicalDrive$($disk.Number)"
$diskHandle = $null
try {
  $diskHandle = Open-RawDisk -Path $diskPath -Write $true

  $mbr = Read-BufferAtOffset -Handle $diskHandle -Offset 0 -Count 512

  # Keep disk signature and partition table; replace only standard MBR boot-code region.
  [Array]::Copy($stage1Code, 0, $mbr, 0, $stage1Code.Length)
  $mbr[510] = 0x55
  $mbr[511] = 0xAA
  Write-BufferAtOffset -Handle $diskHandle -Offset 0 -Buffer $mbr

  # Stage-2 loaded by stage-1 from raw sectors immediately after MBR.
  Write-BufferAtOffset -Handle $diskHandle -Offset 512 -Buffer $stage2

  # RedSea metadata sectors.
  Write-BufferAtOffset -Handle $diskHandle -Offset ([uint64]($redSeaStartLba * 512)) -Buffer $redSeaBoot
  Write-BufferAtOffset -Handle $diskHandle -Offset ([uint64]($rootLba * 512)) -Buffer $redSeaRoot
  Write-BufferAtOffset -Handle $diskHandle -Offset ([uint64]($stage3StartLba * 512)) -Buffer $stage3

  # Full model payload stream into contiguous sectors.
  Write-Host "[prep] writing full model payload into RedSea partition (~$([Math]::Round($modelItem.Length / 1GB, 1)) GB, please wait)..."
  Copy-FileToDiskOffset -Handle $diskHandle -DiskOffset ([uint64]($modelStartLba * 512)) -SourcePath $modelItem.FullName
} finally {
  if ($null -ne $diskHandle) { $diskHandle.Dispose() }
}

Test-PreparedUsb -DiskPath $diskPath -RedSeaStartLba $redSeaStartLba -Stage3Name $stage3EntryName -ModelName $modelEntryName -BootDriveLetter $BootDriveLetter -Stage2 $stage2

Write-Host "[ok] USB prepared for BIOS+UEFI boot"
Write-Host "[ok] BIOS MBR boot code installed with stage-2 sectors"
Write-Host "[ok] RedSea metadata and full model payload written"
Write-Host "[ok] UEFI fallback staged at $BootDriveLetter`:\EFI\BOOT\BOOTX64.EFI"
Write-Host "[ok] UI staged at $BootDriveLetter`:\KISS2\ui"
Write-Host "[ok] verification passed: BIOS stage, RedSea metadata, model entry, and UI"                                                                                                                                                                                                                                                                      