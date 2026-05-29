ENTRY(_start)

SECTIONS {
    . = 0x00000000;

    .text : {
        *(.text*)
        *(.rodata*)
    }

    .data : ALIGN(16) {
        *(.data*)
    }

    . = ALIGN(16);
    __bss_start = .;
    .bss : {
        *(.bss*)
        *(COMMON)
    }
    . = ALIGN(16);
    __bss_end = .;

    /DISCARD/ : {
        *(.comment*)
        *(.eh_frame*)
        *(.note*)
        *(.rel*)
        *(.rela*)
    }
}
