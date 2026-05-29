typedef unsigned long long UINTN;
typedef unsigned short CHAR16;
typedef void *EFI_HANDLE;
typedef UINTN EFI_STATUS;

#define EFI_SUCCESS 0

typedef struct SIMPLE_TEXT_OUTPUT_PROTOCOL SIMPLE_TEXT_OUTPUT_PROTOCOL;

typedef EFI_STATUS (*EFI_TEXT_STRING)(SIMPLE_TEXT_OUTPUT_PROTOCOL *This, CHAR16 *String);

struct SIMPLE_TEXT_OUTPUT_PROTOCOL {
    void *Reset;
    EFI_TEXT_STRING OutputString;
};

typedef struct {
    char _pad1[44];
    SIMPLE_TEXT_OUTPUT_PROTOCOL *ConOut;
} EFI_SYSTEM_TABLE;

EFI_STATUS efi_main(EFI_HANDLE ImageHandle, EFI_SYSTEM_TABLE *SystemTable) {
    (void)ImageHandle;

    if (SystemTable && SystemTable->ConOut && SystemTable->ConOut->OutputString) {
        SystemTable->ConOut->OutputString(SystemTable->ConOut, L"KISS2 UEFI boot path online.\r\n");
        SystemTable->ConOut->OutputString(SystemTable->ConOut, L"Stage-2 BIOS path exists separately.\r\n");
        SystemTable->ConOut->OutputString(SystemTable->ConOut, L"Next: custom kernel/runtime handoff.\r\n");
    }

    for (;;) {
        __asm__ volatile ("hlt");
    }

    return EFI_SUCCESS;
}
