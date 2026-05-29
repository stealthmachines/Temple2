# KISS2 Custom Stand-Alone Bootloader (BIOS Stage-1 + Stage-2 + UEFI Path, RedSea-First)

This folder contains real bare-metal boot paths:

- BIOS stage-1 boot sector that loads stage-2 from disk sectors
- BIOS stage-2 RedSea probe loader
- UEFI boot application (`EFI/BOOT/BOOTX64.EFI`)

## What this is

- Stand-alone stage-1 BIOS boot sector (`boot_stage1.S`)
- Stand-alone stage-2 BIOS loader (`boot_stage2.S`)
- RedSea partition probing in stage-2 (MBR type `0x88` + RedSea boot record check)
- Root directory probe for `MODEL.BIN` in stage-2 (first RedSea payload contract)
- Root directory probe for `STAGE3.BIN` and `MODEL.BIN` in stage-2
- Stage-2 writes `K2RS` boot handoff metadata at physical address `0x9800`
- Stage-2 prefetches initial `MODEL.BIN` sectors into `0xA000`
- Stage-2 then consumes handoff metadata to load the next sequential `MODEL.BIN` chunk
- Stage-2 loads `STAGE3.BIN` from RedSea and jumps to it
- Linker script for boot address `0x7C00` (`boot_stage1.ld`)
- Build pipeline using LLVM tools already present on your machine
- Produces:
  - `boot_stage1.sector.bin` (exactly 512 bytes, includes `0x55AA` signature)
  - `boot_stage2.bin` (loaded by stage-1 via BIOS INT 13h)
  - `boot_stage3.bin` (loaded by stage-2 via BIOS INT 13h)
  - `kiss2_boot.img` (1.44MB bootable image with stage-1 in sector 0)
  - Test MBR entry type `0x88`, minimal RedSea boot record at LBA 63, and root metadata containing `MODEL.BIN`
  - Embedded `MODEL.BIN` metadata size set to `8GB` for large-payload path validation
  - `BOOTX64.EFI` and `EFI/BOOT/BOOTX64.EFI` (UEFI fallback path)

## RedSea commitment

- This project is now committed to a RedSea-first BIOS path.
- Stage-2 explicitly looks for an MBR partition of type `0x88` and validates a RedSea boot record signature.
- FAT32 remains only for optional UEFI compatibility files (`EFI/BOOT/BOOTX64.EFI`) and is not the primary filesystem direction.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File .\build_bootloader.ps1
```

## Build UEFI path

```powershell
powershell -ExecutionPolicy Bypass -File .\build_uefi.ps1
```

## Validate

```powershell
powershell -ExecutionPolicy Bypass -File .\validate_bootloader.ps1
```

## Prepare Real USB (RedSea-first)

This script creates a Terry-style layout with RedSea as primary model filesystem:

- Partition 1: FAT32 boot/UEFI compatibility (`EFI/BOOT/BOOTX64.EFI`)
- Partition 2: RedSea type `0x88` with full contiguous model payload
- BIOS MBR stage-1 + stage-2 written to raw disk sectors
- UI files staged under `KISS2/ui` on boot partition

```powershell
powershell -ExecutionPolicy Bypass -File .\prepare_usb_redsea.ps1 -BootDriveLetter E -ModelPath "C:\path\to\model.gguf" -Force
```

Verification-only (non-destructive):

```powershell
powershell -ExecutionPolicy Bypass -File .\prepare_usb_redsea.ps1 -BootDriveLetter E -ModelPath "C:\path\to\model.gguf" -VerifyOnly
```

## Test in VM (if QEMU installed)

```powershell
qemu-system-x86_64 -drive format=raw,file=kiss2_boot.img
```

Expected screen output:

- `KISS2 custom stand-alone bootloader stage-1`
- `Loading stage-2 from disk...`
- `KISS2 stage-2 BIOS loader online.`
- `RedSea partition detected and validated.`
- `MODEL.BIN entry found in RedSea root.`
- `MODEL.BIN head prefetched for handoff.`
- `MODEL.BIN stream chunk+1 loaded.`
- `BootInfo written at 0x9800 (K2RS).`
- `Jumping to STAGE3.BIN...`
- `KISS2 stage-3 reached.`

## Next stage (planned)

1. Parse RedSea directory entries and locate a fixed model payload file.
2. Stream payload sectors from RedSea into protected-mode handoff buffer.
3. Implement common handoff protocol between BIOS and UEFI paths.
4. Integrate chat runtime components progressively.

This intentionally does **not** depend on Windows at runtime; Windows is only used here as the build host.
