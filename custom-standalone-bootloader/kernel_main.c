/* KISS2 bare-metal kernel — kernel_main.c
 * Freestanding C, no libc, no OS.  Ring 0.  TempleOS spirit.
 *
 * Compiled: clang --target=i386-pc-none-elf -m32 -ffreestanding
 *           -fno-pic -fno-pie -fno-stack-protector -O2 -nostdlib
 *
 * Hardware drivers:
 *   VGA text console  (0xB8000, 80x25)
 *   PS/2 keyboard     (ports 0x60 / 0x64, scancode set 1)
 *   ATA PIO LBA48     (ports 0x1F0-0x1F7, primary controller)
 *
 * Boot protocol:
 *   K2RS struct at 0x9800 (written by stage2)
 *   GGUF head prefetched to 0xA000 (8 sectors = 4096 bytes, stage2)
 */

/* ================================================================
 * Types
 * ================================================================ */
typedef unsigned char      u8;
typedef unsigned short     u16;
typedef unsigned int       u32;
typedef unsigned long long u64;
typedef signed int         s32;

#define NULL ((void*)0)

/* ================================================================
 * Port I/O
 * ================================================================ */
static inline u8  inb(u16 p) { u8  v; __asm__ volatile("inb %1,%0":"=a"(v):"dN"(p)); return v; }
static inline u16 inw(u16 p) { u16 v; __asm__ volatile("inw %1,%0":"=a"(v):"dN"(p)); return v; }
static inline void outb(u16 p, u8  v) { __asm__ volatile("outb %0,%1"::"a"(v),"dN"(p)); }

/* ================================================================
 * VGA text console (80x25, attribute 0x07 = light grey on black)
 * ================================================================ */
#define VGA_BASE  0xB8000U
#define VGA_COLS  80
#define VGA_ROWS  25
#define VGA_ATTR  0x0700U   /* white on black */
#define VGA_HATTR 0x0F00U   /* bright white — for headers */
#define VGA_GATTR 0x0A00U   /* green — for bot output */
#define VGA_YATTR 0x0E00U   /* yellow — for prompts */

static volatile u16 *vga = (volatile u16*)VGA_BASE;
static int vga_row = 0, vga_col = 0;
static u16 vga_cur_attr = VGA_ATTR;

static void vga_cursor_hw(void) {
    u16 pos = (u16)(vga_row * VGA_COLS + vga_col);
    outb(0x3D4, 0x0F); outb(0x3D5, (u8)(pos & 0xFF));
    outb(0x3D4, 0x0E); outb(0x3D5, (u8)((pos >> 8) & 0xFF));
}

static void vga_scroll(void) {
    for (int r = 0; r < VGA_ROWS - 1; r++)
        for (int c = 0; c < VGA_COLS; c++)
            vga[r * VGA_COLS + c] = vga[(r + 1) * VGA_COLS + c];
    for (int c = 0; c < VGA_COLS; c++)
        vga[(VGA_ROWS - 1) * VGA_COLS + c] = VGA_ATTR | ' ';
    vga_row = VGA_ROWS - 1;
}

static void vga_clear(void) {
    for (int i = 0; i < VGA_ROWS * VGA_COLS; i++)
        vga[i] = VGA_ATTR | ' ';
    vga_row = vga_col = 0;
    vga_cursor_hw();
}

static void vga_putc(char c) {
    if (c == '\n') {
        vga_col = 0;
        if (++vga_row >= VGA_ROWS) vga_scroll();
    } else if (c == '\r') {
        vga_col = 0;
    } else if (c == '\b') {
        if (vga_col > 0) {
            vga_col--;
            vga[vga_row * VGA_COLS + vga_col] = VGA_ATTR | ' ';
        }
    } else {
        vga[vga_row * VGA_COLS + vga_col] = vga_cur_attr | (u8)c;
        if (++vga_col >= VGA_COLS) {
            vga_col = 0;
            if (++vga_row >= VGA_ROWS) vga_scroll();
        }
    }
    vga_cursor_hw();
}

static void vga_puts(const char *s) { while (*s) vga_putc(*s++); }

static void vga_puth8(u8 v) {
    static const char h[] = "0123456789ABCDEF";
    vga_putc(h[v >> 4]);
    vga_putc(h[v & 0xF]);
}

static void vga_puth32(u32 v) {
    vga_puts("0x");
    for (int i = 28; i >= 0; i -= 4) vga_puth8((u8)((v >> i) & 0xF));
}

static void vga_putn(u32 v) {
    if (v == 0) { vga_putc('0'); return; }
    char buf[12]; int n = 0;
    while (v) { buf[n++] = (char)('0' + v % 10); v /= 10; }
    while (n--) vga_putc(buf[n]);
}

static void vga_set_attr(u16 a) { vga_cur_attr = a; }

static void vga_fill_line(char c, int len) {
    for (int i = 0; i < len; i++) vga_putc(c);
}

/* ================================================================
 * PS/2 keyboard — scancode set 1 -> ASCII (US layout)
 * ================================================================ */
static const char sc_ascii[128] = {
/* 0x00 */ 0,   0x1B,'1','2','3','4','5','6','7','8','9','0','-','=','\b','\t',
/* 0x10 */ 'q', 'w', 'e','r','t','y','u','i','o','p','[',']','\n', 0,
/* 0x1E */ 'a', 's', 'd','f','g','h','j','k','l',';','\'','`', 0, '\\',
/* 0x2C */ 'z', 'x', 'c','v','b','n','m',',','.','/', 0, '*', 0, ' ',
/* 0x3A */ 0,0,0,0,0,0,0,0,0,0,  /* caps, F1-F10 */
/* 0x44 */ 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
/* 0x60 */ 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
};

static char kb_getc(void) {
    u8 sc;
    for (;;) {
        while (!(inb(0x64) & 0x01)) {}  /* wait: OBF=1 means data ready */
        sc = inb(0x60);
        if (sc & 0x80) continue;        /* key-up: ignore */
        if (sc < 128 && sc_ascii[sc])
            return sc_ascii[sc];
    }
}

/* ================================================================
 * ATA PIO — LBA48, primary controller (0x1F0)
 * For IDE / SATA drives.  USB drives need a separate USB driver.
 * ================================================================ */
#define ATA_DATA     0x1F0
#define ATA_ERR      0x1F1
#define ATA_COUNT    0x1F2
#define ATA_LBA0     0x1F3
#define ATA_LBA1     0x1F4
#define ATA_LBA2     0x1F5
#define ATA_DRIVE    0x1F6
#define ATA_CMD      0x1F7
#define ATA_STATUS   0x1F7
#define ATA_ALT_ST   0x3F6     /* alternate status (no interrupt clear) */

#define ATA_BSY      0x80
#define ATA_DRQ      0x08
#define ATA_ERR_BIT  0x01
#define ATA_READ48   0x24

static void ata_delay400(void) {
    /* 400ns delay: read alternate status 4 times */
    inb(ATA_ALT_ST); inb(ATA_ALT_ST);
    inb(ATA_ALT_ST); inb(ATA_ALT_ST);
}

static int ata_wait_bsy(void) {
    for (u32 i = 0; i < 0x100000; i++) {
        if (!(inb(ATA_STATUS) & ATA_BSY)) return 0;
    }
    return -1; /* timeout */
}

static int ata_wait_drq(void) {
    for (u32 i = 0; i < 0x100000; i++) {
        u8 st = inb(ATA_STATUS);
        if (st & ATA_ERR_BIT) return -1;
        if (st & ATA_DRQ)     return 0;
    }
    return -1;
}

/* Read 'nsect' sectors from LBA48 into buf.
 * Returns 0 on success, -1 on error. */
static int ata_read(u64 lba, u32 nsect, void *buf) {
    u8 *p = (u8*)buf;
    while (nsect) {
        u32 batch = nsect > 256 ? 256 : nsect; /* max per command */
        u8  cnt   = (batch == 256) ? 0 : (u8)batch;

        if (ata_wait_bsy()) return -1;

        outb(ATA_DRIVE, 0x40);              /* LBA48, master drive */
        ata_delay400();

        /* High bytes (previous register cycle) */
        outb(ATA_COUNT, (u8)((batch >> 8) & 0xFF));
        outb(ATA_LBA0,  (u8)((lba >> 24) & 0xFF));
        outb(ATA_LBA1,  (u8)((lba >> 32) & 0xFF));
        outb(ATA_LBA2,  (u8)((lba >> 40) & 0xFF));

        /* Low bytes */
        outb(ATA_COUNT, cnt);
        outb(ATA_LBA0,  (u8)((lba >>  0) & 0xFF));
        outb(ATA_LBA1,  (u8)((lba >>  8) & 0xFF));
        outb(ATA_LBA2,  (u8)((lba >> 16) & 0xFF));

        outb(ATA_CMD,   ATA_READ48);

        for (u32 s = 0; s < batch; s++) {
            if (ata_wait_drq()) return -1;
            /* Read 256 words (512 bytes) */
            for (int w = 0; w < 256; w++) {
                u16 d = inw(ATA_DATA);
                *p++ = (u8)(d & 0xFF);
                *p++ = (u8)(d >> 8);
            }
        }
        lba   += batch;
        nsect -= batch;
    }
    return 0;
}

/* ================================================================
 * K2RS boot handoff (written at 0x9800 by stage2)
 * ================================================================ */
#define BOOTINFO_BASE 0x9800U

typedef struct __attribute__((packed)) {
    char  sig[4];           /* 'K','2','R','S' */
    u16   flags;
    u16   version;
    u64   model_lba;        /* LBA of MODEL.BIN on RedSea partition */
    u64   model_size;       /* bytes */
    u16   prefetch_buf;     /* 0xA000 — first 8 sectors already there */
    u16   prefetch_sects;   /* 8 */
    u8    boot_drive;       /* BIOS drive (0x80 = first HDD) */
    u8    pad[3];
} K2RS;

/* ================================================================
 * GGUF file format (llama.cpp-compatible)
 * ================================================================ */
#define GGUF_MAGIC_LE 0x46554747UL  /* 'GGUF' little-endian */

typedef struct __attribute__((packed)) {
    u32 magic;
    u32 version;
    u64 tensor_count;
    u64 kv_count;
} GGUFHeader;

/* ================================================================
 * Minimal string helpers (no libc)
 * ================================================================ */
static u32 kstrlen(const char *s) { u32 n=0; while(*s++) n++; return n; }

static void *kmemset(void *d, int c, u32 n) {
    u8 *p = d; while(n--) *p++ = (u8)c; return d;
}

/* ================================================================
 * Simple bump allocator — starts at 2MB, above all boot code
 * ================================================================ */
static u8 *heap_top = (u8*)0x00200000UL;

static void *kmalloc(u32 sz) {
    void *p = heap_top;
    heap_top += (sz + 15) & ~15U;  /* 16-byte align */
    return p;
}

/* ================================================================
 * Chat / readline
 * ================================================================ */
#define LINE_MAX 256

static char input_buf[LINE_MAX];

static int readline(char *buf, int max) {
    int n = 0;
    for (;;) {
        char c = kb_getc();
        if (c == '\n') {
            buf[n] = '\0';
            vga_putc('\n');
            return n;
        }
        if (c == '\b' && n > 0) {
            n--;
            vga_putc('\b');
            continue;
        }
        if (n < max - 1) {
            buf[n++] = c;
            vga_putc(c);
        }
    }
}

/* ================================================================
 * Model streaming state
 * ================================================================ */
static u8 sector_buf[512];   /* one-sector scratch */

static int try_load_gguf_header(K2RS *bi, GGUFHeader *out) {
    /* Stage2 prefetched first 8 sectors (4KB) to bi->prefetch_buf (0xA000) */
    GGUFHeader *pre = (GGUFHeader*)(u32)bi->prefetch_buf;
    if (pre->magic == GGUF_MAGIC_LE) {
        *out = *pre;
        return 1;
    }
    /* Prefetch didn't work — try ATA direct */
    if (ata_read(bi->model_lba, 1, sector_buf) == 0) {
        GGUFHeader *dh = (GGUFHeader*)sector_buf;
        if (dh->magic == GGUF_MAGIC_LE) {
            *out = *dh;
            return 2;  /* 2 = loaded via ATA */
        }
    }
    return 0;
}

/* ================================================================
 * Inference stub
 * For now: echo + note. Real transformer goes here.
 * ================================================================ */
static void infer(const char *prompt, GGUFHeader *hdr) {
    (void)prompt; (void)hdr;
    /* TODO: tokenise -> matmul -> detokenise
     * Requires:
     *  - vocab loaded from GGUF metadata
     *  - weight tensors streamed from RedSea via ATA PIO
     *  - attention + MLP in fixed-point or float32
     */
    vga_set_attr(VGA_GATTR);
    vga_puts("bot> [stub] model loaded, inference not yet wired.\n");
    vga_set_attr(VGA_ATTR);
}

/* ================================================================
 * kernel_main — entered from pmode32_entry
 * ================================================================ */
void kernel_main(void) {
    vga_clear();

    /* ---- Banner ---- */
    vga_set_attr(VGA_HATTR);
    vga_puts("KISS2 HDGL Bare-Metal Kernel\n");
    vga_fill_line('=', 40); vga_putc('\n');
    vga_set_attr(VGA_ATTR);
    vga_puts("Ring 0.  No OS.  TempleOS spirit.\n\n");

    /* ---- K2RS info ---- */
    K2RS *bi = (K2RS*)BOOTINFO_BASE;
    vga_puts("Boot drive : 0x"); vga_puth8(bi->boot_drive); vga_putc('\n');
    vga_puts("Model LBA  : ");
    vga_puth32((u32)(bi->model_lba >> 32));
    vga_puth32((u32)(bi->model_lba));
    vga_putc('\n');
    vga_puts("Model size : ");
    /* Show in GB if > 1G, else MB */
    if (bi->model_size >= (u64)1024*1024*1024) {
        vga_putn((u32)(bi->model_size >> 30));
        vga_puts(" GB\n");
    } else {
        vga_putn((u32)(bi->model_size >> 20));
        vga_puts(" MB\n");
    }
    vga_putc('\n');

    /* ---- GGUF header ---- */
    GGUFHeader hdr;
    kmemset(&hdr, 0, sizeof hdr);

    vga_puts("Checking GGUF header...\n");
    int rc = try_load_gguf_header(bi, &hdr);
    if (rc == 1) {
        vga_puts("GGUF found in prefetch buffer.\n");
    } else if (rc == 2) {
        vga_puts("GGUF found via ATA PIO.\n");
    } else {
        vga_set_attr(0x0C00); /* bright red */
        vga_puts("GGUF magic not found.\n");
        vga_puts("(USB drives require a USB driver — ATA PIO only works on IDE/SATA)\n");
        vga_set_attr(VGA_ATTR);
    }

    if (rc) {
        vga_puts("GGUF version : "); vga_putn(hdr.version);    vga_putc('\n');
        vga_puts("Tensors      : "); vga_putn((u32)hdr.tensor_count); vga_putc('\n');
        vga_puts("KV pairs     : "); vga_putn((u32)hdr.kv_count);     vga_putc('\n');
    }
    vga_putc('\n');

    /* ---- Chat loop ---- */
    vga_set_attr(VGA_HATTR);
    vga_puts("KISS2 bot ready.\n");
    vga_set_attr(VGA_ATTR);
    vga_puts("Type a message and press Enter.  (Ctrl-R not yet wired.)\n\n");

    for (;;) {
        vga_set_attr(VGA_YATTR);
        vga_puts("you> ");
        vga_set_attr(VGA_ATTR);

        int len = readline(input_buf, LINE_MAX);
        (void)len;

        infer(input_buf, rc ? &hdr : NULL);
    }
}
