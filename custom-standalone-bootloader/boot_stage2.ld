ENTRY(_start)

SECTIONS {
  . = 0x8000;

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
