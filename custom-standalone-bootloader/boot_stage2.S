.code16
.section .text
.global _start

#define MBR_PART_TABLE_OFF 446
#define MBR_SIG_OFF 510
#define REDSEA_PT_TYPE 0x88
#define MBR_BUFFER 0x9000
#define REDSEA_BOOT_BUFFER 0x9200
#define DAP_BUFFER 0x9400
#define ROOTDIR_BUFFER 0x9600
#define BOOTINFO_BUFFER 0x9800
#define MODEL_PREFETCH_BUFFER 0xA000
#define MODEL_PREFETCH_SECTORS 8
#define STAGE3_LOAD_SEG 0x2000

_start:
    cli
    xorw %ax, %ax
    movw %ax, %ds
    movw %ax, %es
    sti

    # Force 80x25 text mode in case firmware splash remains active.
    movb $0x00, %ah
    movb $0x03, %al
    int $0x10

    movw $banner2, %si
    call print_string

    movb %dl, boot_drive

    xorw %ax, %ax
    movw %ax, current_lba+0
    movw %ax, current_lba+2
    movw %ax, current_lba+4
    movw %ax, current_lba+6
    movw %ax, target_segment
    movw $MBR_BUFFER, target_buffer
    movw $1, read_count
    call read_lba_sector
    jc disk_read_fail

    movw MBR_BUFFER+MBR_SIG_OFF, %ax
    cmpw $0xAA55, %ax
    jne no_redsea

    movw $MBR_BUFFER+MBR_PART_TABLE_OFF, %si
    movb $4, %cl

find_redsea_partition:
    movb 4(%si), %al
    cmpb $REDSEA_PT_TYPE, %al
    je redsea_partition_found
    addw $16, %si
    decb %cl
    jnz find_redsea_partition
    jmp no_redsea

redsea_partition_found:
    movw 8(%si), %ax
    movw %ax, current_lba+0
    movw 10(%si), %ax
    movw %ax, current_lba+2
    xorw %ax, %ax
    movw %ax, current_lba+4
    movw %ax, current_lba+6

    movw $REDSEA_BOOT_BUFFER, target_buffer
    call read_lba_sector
    jc disk_read_fail

    movb REDSEA_BOOT_BUFFER+3, %al
    cmpb $REDSEA_PT_TYPE, %al
    jne redsea_invalid
    movw REDSEA_BOOT_BUFFER+MBR_SIG_OFF, %ax
    cmpw $0xAA55, %ax
    jne redsea_invalid

    movw REDSEA_BOOT_BUFFER+24, %ax
    movw %ax, current_lba+0
    movw REDSEA_BOOT_BUFFER+26, %ax
    movw %ax, current_lba+2
    movw REDSEA_BOOT_BUFFER+28, %ax
    movw %ax, current_lba+4
    movw REDSEA_BOOT_BUFFER+30, %ax
    movw %ax, current_lba+6
    movw $ROOTDIR_BUFFER, target_buffer
    call read_lba_sector
    jc disk_read_fail

    movw $redsea_ok_msg, %si
    call print_string

    call find_stage3_in_root
    cmpb $1, %al
    jne stage3_not_found
    call cache_stage3_metadata
    movw $stage3_found_msg, %si
    call print_string

    call find_model_in_root
    cmpb $1, %al
    je model_found
    cmpb $2, %al
    je model_fallback

    movw $model_not_found_msg, %si
    call print_string
    jmp halt_forever

model_fallback:
    movw $model_fallback_msg, %si
    call print_string
    jmp model_found

model_found:
    call cache_model_metadata
    call write_bootinfo

    movw $model_found_msg, %si
    call print_string

    call prefetch_model_head
    jc model_prefetch_fail

    movw $model_prefetch_ok_msg, %si
    call print_string

    call continue_model_stream
    jc model_stream_fail

    movw $model_stream_ok_msg, %si
    call print_string
    movw $handoff_ready_msg, %si
    call print_string
    call load_stage3_and_jump
    jc stage3_load_fail
    movw $handoff_missing_msg, %si
    call print_string
    movw $press_key_reboot_msg, %si
    call print_string
    xorw %ax, %ax
    int $0x16
    int $0x19
    jmp halt_forever

model_prefetch_fail:
    movw $model_prefetch_fail_msg, %si
    call print_string
    jmp halt_forever

model_stream_fail:
    movw $model_stream_fail_msg, %si
    call print_string
    jmp halt_forever

stage3_not_found:
    movw $stage3_not_found_msg, %si
    call print_string
    jmp halt_forever

stage3_load_fail:
    movw $stage3_load_fail_msg, %si
    call print_string
    jmp halt_forever

no_redsea:
    movw $no_redsea_msg, %si
    call print_string
    jmp halt_forever

redsea_invalid:
    movw $redsea_invalid_msg, %si
    call print_string
    jmp halt_forever

disk_read_fail:
    movw $disk_read_fail_msg, %si
    call print_string
    jmp halt_forever

halt_forever:
    hlt
    jmp halt_forever

read_lba_sector:
    movb $0x10, DAP_BUFFER+0
    movb $0x00, DAP_BUFFER+1
    movw read_count, %ax
    movw %ax, DAP_BUFFER+2

    movw target_buffer, %ax
    movw %ax, DAP_BUFFER+4
    movw target_segment, %ax
    movw %ax, DAP_BUFFER+6

    movw current_lba+0, %ax
    movw %ax, DAP_BUFFER+8
    movw current_lba+2, %ax
    movw %ax, DAP_BUFFER+10
    movw current_lba+4, %ax
    movw %ax, DAP_BUFFER+12
    movw current_lba+6, %ax
    movw %ax, DAP_BUFFER+14

    movw $DAP_BUFFER, %si
    movb $0x42, %ah
    movb boot_drive, %dl
    int $0x13
    ret

find_model_in_root:
    movw $ROOTDIR_BUFFER, %bx
    movb $8, %cl
    xorw %ax, %ax
    movw %ax, fallback_entry_ptr

root_loop:
    movw %bx, %si
    movw 0(%si), %ax
    testw $0x0100, %ax
    jnz next_root_entry

    movb 2(%si), %al
    testb %al, %al
    jz next_root_entry

    addw $2, %si
    call match_model_name
    cmpb $1, %al
    je cache_model_entry_ptr

    movw fallback_entry_ptr, %ax
    testw %ax, %ax
    jnz next_root_entry
    movb 2(%bx), %al
    cmpb $'.', %al
    je next_root_entry
    movw %bx, fallback_entry_ptr

next_root_entry:
    addw $64, %bx
    decb %cl
    jnz root_loop

    movw fallback_entry_ptr, %ax
    testw %ax, %ax
    jz root_model_not_found
    movw %ax, model_entry_ptr
    movb $2, %al
    ret

root_model_not_found:
    movb $0, %al
    ret

cache_model_entry_ptr:
    movw %bx, model_entry_ptr

root_model_found:
    movb $1, %al
    ret

find_stage3_in_root:
    movw $ROOTDIR_BUFFER, %bx
    movb $8, %cl

stage3_root_loop:
    movw %bx, %si
    movw 0(%si), %ax
    testw $0x0100, %ax
    jnz stage3_next_root_entry

    movb 2(%si), %al
    testb %al, %al
    jz stage3_next_root_entry

    addw $2, %si
    call match_stage3_name
    cmpb $1, %al
    je cache_stage3_entry_ptr

stage3_next_root_entry:
    addw $64, %bx
    decb %cl
    jnz stage3_root_loop
    movb $0, %al
    ret

cache_stage3_entry_ptr:
    movw %bx, stage3_entry_ptr
    movb $1, %al
    ret

match_model_name:
    movw $model_file_name, %di

match_loop:
    movb (%si), %al
    movb (%di), %ah     /* use %ah, not %bl — %bx is the caller's entry pointer */
    cmpb %ah, %al
    jne match_fail
    testb %al, %al
    je match_ok
    incw %si
    incw %di
    jmp match_loop

match_fail:
    movb $0, %al
    ret

match_ok:
    movb $1, %al
    ret

match_stage3_name:
    movw $stage3_file_name, %di

match_stage3_loop:
    movb (%si), %al
    movb (%di), %ah     /* use %ah, not %bl — %bx is the caller's entry pointer */
    cmpb %ah, %al
    jne match_stage3_fail
    testb %al, %al
    je match_stage3_ok
    incw %si
    incw %di
    jmp match_stage3_loop

match_stage3_fail:
    movb $0, %al
    ret

match_stage3_ok:
    movb $1, %al
    ret

cache_stage3_metadata:
    movw stage3_entry_ptr, %bx

    movw 40(%bx), %ax
    movw %ax, stage3_lba+0
    movw 42(%bx), %ax
    movw %ax, stage3_lba+2
    movw 44(%bx), %ax
    movw %ax, stage3_lba+4
    movw 46(%bx), %ax
    movw %ax, stage3_lba+6

    movw 48(%bx), %ax
    movw %ax, stage3_size+0
    movw 50(%bx), %ax
    movw %ax, stage3_size+2
    movw 52(%bx), %ax
    movw %ax, stage3_size+4
    movw 54(%bx), %ax
    movw %ax, stage3_size+6
    ret

cache_model_metadata:
    movw model_entry_ptr, %bx

    movw 40(%bx), %ax
    movw %ax, model_lba+0
    movw 42(%bx), %ax
    movw %ax, model_lba+2
    movw 44(%bx), %ax
    movw %ax, model_lba+4
    movw 46(%bx), %ax
    movw %ax, model_lba+6

    movw 48(%bx), %ax
    movw %ax, model_size+0
    movw 50(%bx), %ax
    movw %ax, model_size+2
    movw 52(%bx), %ax
    movw %ax, model_size+4
    movw 54(%bx), %ax
    movw %ax, model_size+6
    ret

write_bootinfo:
    movb $'K', BOOTINFO_BUFFER+0
    movb $'2', BOOTINFO_BUFFER+1
    movb $'R', BOOTINFO_BUFFER+2
    movb $'S', BOOTINFO_BUFFER+3
    movw $1, BOOTINFO_BUFFER+4
    movw $1, BOOTINFO_BUFFER+6

    movw model_lba+0, %ax
    movw %ax, BOOTINFO_BUFFER+8
    movw model_lba+2, %ax
    movw %ax, BOOTINFO_BUFFER+10
    movw model_lba+4, %ax
    movw %ax, BOOTINFO_BUFFER+12
    movw model_lba+6, %ax
    movw %ax, BOOTINFO_BUFFER+14

    movw model_size+0, %ax
    movw %ax, BOOTINFO_BUFFER+16
    movw model_size+2, %ax
    movw %ax, BOOTINFO_BUFFER+18
    movw model_size+4, %ax
    movw %ax, BOOTINFO_BUFFER+20
    movw model_size+6, %ax
    movw %ax, BOOTINFO_BUFFER+22

    movw $MODEL_PREFETCH_BUFFER, BOOTINFO_BUFFER+24
    movw $MODEL_PREFETCH_SECTORS, BOOTINFO_BUFFER+26
    movb boot_drive, %al
    movb %al, BOOTINFO_BUFFER+28
    ret

prefetch_model_head:
    movw model_lba+0, %ax
    movw %ax, current_lba+0
    movw model_lba+2, %ax
    movw %ax, current_lba+2
    movw model_lba+4, %ax
    movw %ax, current_lba+4
    movw model_lba+6, %ax
    movw %ax, current_lba+6

    movw $MODEL_PREFETCH_BUFFER, target_buffer
    movw $MODEL_PREFETCH_SECTORS, read_count
    call read_lba_sector
    ret

continue_model_stream:
    movw model_lba+0, %ax
    movw %ax, current_lba+0
    movw model_lba+2, %ax
    movw %ax, current_lba+2
    movw model_lba+4, %ax
    movw %ax, current_lba+4
    movw model_lba+6, %ax
    movw %ax, current_lba+6

    movw $MODEL_PREFETCH_SECTORS, %ax
    addw %ax, current_lba+0
    adcw $0, current_lba+2
    adcw $0, current_lba+4
    adcw $0, current_lba+6

    movw $MODEL_PREFETCH_BUFFER, target_buffer
    movw $MODEL_PREFETCH_SECTORS, read_count
    movw $0x0000, target_segment
    call read_lba_sector
    ret

load_stage3_and_jump:
    movw stage3_lba+0, %ax
    movw %ax, current_lba+0
    movw stage3_lba+2, %ax
    movw %ax, current_lba+2
    movw stage3_lba+4, %ax
    movw %ax, current_lba+4
    movw stage3_lba+6, %ax
    movw %ax, current_lba+6

    # Compute sector count from size: (size_lo + 511) >> 9, clamped 1..127
    movw stage3_size+0, %ax
    addw $511, %ax
    jnc .s3_no_carry
    movw $0xFFFF, %ax   # saturate on carry -> will clamp to 127
.s3_no_carry:
    shrw $9, %ax
    cmpw $1, %ax
    jae .s3_cnt_ok
    movw $1, %ax
.s3_cnt_ok:
    cmpw $127, %ax
    jbe .s3_cnt_set
    movw $127, %ax
.s3_cnt_set:
    movw %ax, read_count

    movw $0x0000, target_buffer
    movw $STAGE3_LOAD_SEG, target_segment
    call read_lba_sector
    jc stage3_jump_fail

    movw $stage3_jump_msg, %si
    call print_string
    ljmp $STAGE3_LOAD_SEG, $0x0000

stage3_jump_fail:
    ret

print_string:
    lodsb
    testb %al, %al
    jz print_done
    movb $0x0e, %ah
    movw $0x000A, %bx
    int $0x10
    jmp print_string

print_done:
    ret

banner2:
    .ascii "KISS2 stage-2 BIOS loader online.\r\n"
    .byte 0

redsea_ok_msg:
    .ascii "RedSea partition detected and validated.\r\n"
    .byte 0

no_redsea_msg:
    .ascii "No RedSea partition (type 0x88) found.\r\n"
    .byte 0

redsea_invalid_msg:
    .ascii "RedSea partition found but boot record invalid.\r\n"
    .byte 0

disk_read_fail_msg:
    .ascii "Disk read failed during RedSea probe.\r\n"
    .byte 0

model_found_msg:
    .ascii "MODEL.BIN entry found in RedSea root.\r\n"
    .byte 0

model_prefetch_ok_msg:
    .ascii "MODEL.BIN head prefetched for handoff.\r\n"
    .byte 0

model_prefetch_fail_msg:
    .ascii "MODEL.BIN prefetch failed.\r\n"
    .byte 0

model_stream_ok_msg:
    .ascii "MODEL.BIN stream chunk+1 loaded.\r\n"
    .byte 0

model_stream_fail_msg:
    .ascii "MODEL.BIN stream continuation failed.\r\n"
    .byte 0

handoff_ready_msg:
    .ascii "BootInfo written at 0x9800 (K2RS).\r\n"
    .byte 0

stage3_found_msg:
    .ascii "STAGE3.BIN entry found in RedSea root.\r\n"
    .byte 0

stage3_jump_msg:
    .ascii "Jumping to STAGE3.BIN...\r\n"
    .byte 0

stage3_not_found_msg:
    .ascii "STAGE3.BIN entry not found in RedSea root.\r\n"
    .byte 0

stage3_load_fail_msg:
    .ascii "STAGE3.BIN load failed.\r\n"
    .byte 0

handoff_missing_msg:
    .ascii "No stage-3/kernel handoff yet; rebooting on keypress.\r\n"
    .byte 0

press_key_reboot_msg:
    .ascii "Press any key to reboot.\r\n"
    .byte 0

model_not_found_msg:
    .ascii "MODEL.BIN entry not found in RedSea root.\r\n"
    .byte 0

model_fallback_msg:
    .ascii "MODEL.BIN missing; using first valid RedSea root entry.\r\n"
    .byte 0

/* ── Runtime data variables ─────────────────────────────────────────────────
 * Must live in .text: the linker script discards .bss and .data.
 * Placed after all code so they don't interfere with instruction fetch.
 * Bootloader is loaded into a fixed physical address; these are mutable
 * storage baked into the flat binary. */

boot_drive:         .byte 0
                    .byte 0             /* alignment pad */
current_lba:        .word 0, 0, 0, 0   /* LBA48: 8 bytes */
target_segment:     .word 0
target_buffer:      .word 0
read_count:         .word 0
stage3_lba:         .word 0, 0, 0, 0   /* 8 bytes */
stage3_size:        .word 0, 0, 0, 0   /* 8 bytes */
model_lba:          .word 0, 0, 0, 0   /* 8 bytes */
model_size:         .word 0, 0, 0, 0   /* 8 bytes */
stage3_entry_ptr:   .word 0
model_entry_ptr:    .word 0
fallback_entry_ptr: .word 0
model_file_name:    .ascii "MODEL.BIN"
                    .byte 0
stage3_file_name:   .ascii "STAGE3.BIN"
                    .byte 0
