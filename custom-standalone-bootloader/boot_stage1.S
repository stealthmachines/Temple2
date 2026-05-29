.code16
.section .text
.global _start

#ifndef STAGE2_SECTORS
#define STAGE2_SECTORS 1
#endif

#define STAGE2_LOAD_SEG 0x0800

_start:
    cli
    xorw %ax, %ax
    movw %ax, %ds
    movw %ax, %es
    movw %ax, %ss
    movw $0x7c00, %sp
    sti

    # Force 80x25 text mode so firmware splash does not hide loader output.
    movb $0x00, %ah
    movb $0x03, %al
    int $0x10

    movb %dl, boot_drive

    movw $banner, %si
    call print_string

    call load_stage2

    movw $stage2_msg, %si
    call print_string

    ljmp $STAGE2_LOAD_SEG, $0x0000

load_fail:
    movw $fail_msg, %si
    call print_string
    jmp hang

load_stage2:
    movw $STAGE2_LOAD_SEG, %ax
    movw %ax, %es
    xorw %bx, %bx

    movb $0x02, %ah
    movb $STAGE2_SECTORS, %al
    movb $0x00, %ch
    movb $0x02, %cl
    movb $0x00, %dh
    movb boot_drive, %dl
    int $0x13
    jc load_fail
    ret

hang:
    hlt
    jmp hang

print_string:
    lodsb
    testb %al, %al
    jz print_done
    movb $0x0e, %ah
    movw $0x0007, %bx
    int $0x10
    jmp print_string

print_done:
    ret

banner:
    .ascii "KISS2 custom stand-alone bootloader stage-1\r\n"
    .ascii "Loading stage-2 from disk...\r\n"
    .byte 0

stage2_msg:
    .ascii "Stage-2 handoff.\r\n"
    .byte 0

fail_msg:
    .ascii "Stage-2 load failed (INT13).\r\n"
    .byte 0

boot_drive:
    .byte 0
