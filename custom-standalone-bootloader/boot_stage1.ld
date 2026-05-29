ENTRY(_start)

SECTIONS {
  . = 0x7C00;

  .text : {
    *(.text*)
    *(.rodata*)
  }

  /DISCARD/ : {
    *(.comment*)
    *(.eh_frame*)
    *(.note*)
    *(.rel*)
    *(.rela*)
    *(.data*)
    *(.bss*)
  }
}
