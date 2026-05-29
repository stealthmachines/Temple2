/* KISS2 boot_stage3.S - real-mode to protected-mode bridge
 * Loaded by stage2 at STAGE3_LOAD_SEG:0 = physical 0x20000.
 * Linked at 0x0000 so all label offsets are 0-based.
 * DS = CS (= 0x2000) so DS:offset accesses our data at 0x20000+offset.
 *
 * Sequence (from TempleOS KStart16.HC / KStart32.HC):
 *   1. Validate K2RS handoff at 0x9800
 *   2. Enable A20 (fast gate, port 0x92)
 *   3. Patch GDT linear base at runtime: CS<<4 + gdt_table
 *   4. Patch far-jump target at runtime: CS<<4 + pmode32_entry
 *   5. lgdt, CR0.PE=1, far jmp -> 32-bit protected mode
 *   6. pmode32_entry: set segments, stack, zero BSS, call kernel_main
 */

.code16
.section .text
.global _start

.set STAGE3_BASE,   0x20000
.set BOOTINFO_BASE, 0x9800
.set KERNEL_STACK,  0x90000
.set SEL_CS32,      0x08
.set SEL_DS32,      0x10

_start:
    cli
    movw    %cs, %ax
    movw    %ax, %ds
    movw    %ax, %ss
    movw    $0x0FFE, %sp
    sti

    movw    $str_banner, %si
    call    puts16

    /* Validate K2RS at 0x9800 using ES=0 */
    xorw    %ax, %ax
    movw    %ax, %es
    movb    %es:BOOTINFO_BASE+0, %al
    cmpb    $0x4B, %al
    jne     1f
    movb    %es:BOOTINFO_BASE+1, %al
    cmpb    $0x32, %al
    jne     1f
    movb    %es:BOOTINFO_BASE+2, %al
    cmpb    $0x52, %al
    jne     1f
    movb    %es:BOOTINFO_BASE+3, %al
    cmpb    $0x53, %al
    jne     1f

    movw    $str_k2rs_ok, %si
    call    puts16
    jmp     2f
1:
    movw    $str_k2rs_bad, %si
    call    puts16
3:
    hlt
    jmp     3b

2:
    /* Enable A20 fast gate */
    inb     $0x92, %al
    orb     $0x02, %al
    andb    $0xFE, %al
    outb    %al, $0x92

    movw    $str_a20, %si
    call    puts16

    /* Patch GDTR base: CS*16 + gdt_table */
    movw    %cs, %ax
    movzwl  %ax, %eax
    shll    $4, %eax
    addl    $gdt_table, %eax
    movl    %eax, gdtr_base

    /* Patch far-jump target: STAGE3_BASE + pmode32_entry */
    movl    $STAGE3_BASE, %eax
    addl    $pmode32_entry, %eax
    movl    %eax, farjmp_addr

    cli
    lgdt    gdtr
    movl    %cr0, %eax
    orl     $0x01, %eax
    movl    %eax, %cr0

    /* Far jump: opcode 66 EA <imm32> <imm16> */
    .byte 0x66, 0xEA
farjmp_addr:
    .long 0
    .word SEL_CS32

4:
    hlt
    jmp     4b

/* puts16: DS:SI -> NUL-terminated, BIOS teletype */
puts16:
    lodsb
    testb   %al, %al
    jz      5f
    movb    $0x0E, %ah
    movw    $0x000F, %bx
    int     $0x10
    jmp     puts16
5:
    ret

/* String data as plain bytes to avoid encoding issues */
str_banner:
    .byte 75,73,83,83,50,32,83,51,58,32,112,109,111,100,101,13,10,0

str_k2rs_ok:
    .byte 75,50,82,83,32,79,75,13,10,0

str_a20:
    .byte 65,50,48,32,111,110,13,10,0

str_k2rs_bad:
    .byte 75,50,82,83,32,66,65,68,13,10,0

/* GDT */
    .align 8
gdt_table:
    .quad 0x0000000000000000
    .quad 0x00CF9A000000FFFF
    .quad 0x00CF92000000FFFF
gdt_end:

gdtr:
    .word gdt_end - gdt_table - 1
gdtr_base:
    .long 0

/* ================================================================
 * 32-bit protected mode entry
 * ================================================================ */
    .code32
pmode32_entry:
    movw    $SEL_DS32, %ax
    movw    %ax, %ds
    movw    %ax, %es
    movw    %ax, %fs
    movw    %ax, %gs
    movw    %ax, %ss
    movl    $KERNEL_STACK, %esp
    cld

    /* Zero BSS */
    movl    $__bss_start, %edi
    movl    $__bss_end,   %ecx
    subl    %edi, %ecx
    xorl    %eax, %eax
    rep     stosb

    call    kernel_main

6:
    hlt
    jmp     6b
