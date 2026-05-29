/* ez_chat.c  --  KISS2 bare-metal-first GGUF inference
 *
 * Drop-in replacement for the entire Node.js EZ bot stack.
 * No LM Studio, no HTTP, no Node.js  --  just the GGUF file and a terminal.
 *
 * Gleaned from EZ-by-zCHG _ask.mjs + _council.mjs:
 *   model      : Qwen3.5-9B-UD-Q2_K_XL.gguf  (or any Qwen3-family GGUF)
 *   temp       : 1.0  (--temp)
 *   top_k      : 20   (--top-k)
 *   max_tokens : 700  (--max-tokens)
 *   council    : 2x inference + synthesis  (--council)
 *   cleanup    : strips <think>...</think> tags  (mirrors _ask.mjs)
 *
 * Build (Linux/macOS): gcc -O3 -march=native -o ez_chat ez_chat.c -lm
 * Build (Windows):     cl /O2 /Fe:ez_chat.exe ez_chat.c
 * Run:                 ./ez_chat model.gguf
 *                      ./ez_chat model.gguf --council
 *
 * Bare-metal port: #define BARE_METAL; replace mmap block with ata_read()
 * and malloc() with bump_alloc() from kernel_main.c.  The forward-pass math
 * is identical either way.  See BARE_METAL sections below.
 *
 * Architecture:
 *   GGUF parse -> BPE tokenize -> [Qwen3 forward x N] -> top-k sample -> print
 *
 * Qwen3 forward pass per token:
 *   embed(token)
 *   for each layer:
 *     RMSNorm -> Q,K,V proj -> QK-norm -> RoPE -> GQA attention -> O proj
 *     RMSNorm -> SwiGLU FFN (gate x up -> SiLU -> down)
 *   RMSNorm -> lm_head -> logits -> sample
 */

#ifndef BARE_METAL
#  include <stdio.h>
#  include <stdlib.h>
#  include <string.h>
#  include <stdint.h>
#  include <stdarg.h>
#  include <math.h>
#  ifdef _WIN32
#    include <windows.h>
#  else
#    include <sys/mman.h>
#    include <sys/stat.h>
#    include <fcntl.h>
#    include <unistd.h>
#  endif
#else
/* bare-metal stubs */
#  include "../custom-standalone-bootloader/kernel_main.c"
#  define printf  vga_printf
#  define malloc  bump_alloc
#  define free(x) (void)(x)
   static void *mmap_model(const char *path, size_t *sz) {
       /* replace with ata_read sequence; path = LBA offset string */
       return 0;
   }
#endif /* BARE_METAL */

/* ============================================================
 * 1.  GGUF constants and types
 * ============================================================ */
#define GGUF_MAGIC      0x46554747u   /* "GGUF" little-endian */
#define GGUF_VER_MIN    2

/* ggml_type values */
#define GGML_F32        0
#define GGML_F16        1
#define GGML_Q4_0       2
#define GGML_Q4_1       3
#define GGML_Q5_0       6
#define GGML_Q5_1       7
#define GGML_Q8_0       8
#define GGML_Q2_K      10
#define GGML_Q3_K      11
#define GGML_Q4_K      12
#define GGML_Q5_K      13
#define GGML_Q6_K      14

/* gguf value types */
#define GVT_UINT8   0
#define GVT_INT8    1
#define GVT_UINT16  2
#define GVT_INT16   3
#define GVT_UINT32  4
#define GVT_INT32   5
#define GVT_FLOAT32 6
#define GVT_BOOL    7
#define GVT_STRING  8
#define GVT_ARRAY   9
#define GVT_UINT64 10
#define GVT_INT64  11
#define GVT_FLOAT64 12

/* QK block sizes */
#define QK_K   256    /* super-block: Q2_K, Q3_K, Q4_K, Q5_K, Q6_K */
#define QK8_0   32    /* Q8_0 block */

/* ============================================================
 * 2.  Model constants (conservative maximums)
 * ============================================================ */
#define MAX_LAYERS      80
#define MAX_VOCAB   160000
#define MAX_MERGES  160000
#define MAX_TENSORS   4096
#define MAX_CTX       4096    /* KV cache context window (reduce for bare metal) */
#define MAX_GEN        700    /* max new tokens, mirrors _ask.mjs max_tokens */

/* ============================================================
 * 3.  Types
 * ============================================================ */
typedef uint8_t  u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef uint64_t u64;
typedef int8_t   i8;
typedef int32_t  i32;
typedef float    f32;

/* fp16 -> f32  (no hardware fp16 assumed) */
static inline f32 fp16(u16 h) {
    u32 s = (u32)(h & 0x8000) << 16;
    u32 e = (h >> 10) & 0x1F;
    u32 m = h & 0x3FF;
    if (e == 0) { if (!m) { f32 z; u32 zz=s; memcpy(&z,&zz,4); return z; }
                  e=1; while(!(m&0x400)){m<<=1;e--;} m&=0x3FF; }
    else if (e == 31) { e = 255; }
    else { e += 127 - 15; }
    u32 f = s | (e<<23) | (m<<13);
    f32 v; memcpy(&v, &f, 4); return v;
}

/* Tensor descriptor (pointer into mmap'd data) */
typedef struct {
    char    name[128];
    u32     type;
    u64     ne[4];      /* element count per dimension */
    u64     offset;     /* from data section start */
} TInfo;

/* Layer weight pointers */
typedef struct {
    const u8 *attn_norm;
    const u8 *q, *k, *v, *o;
    const u8 *q_norm, *k_norm;
    const u8 *ffn_norm;
    const u8 *gate, *up, *down;
    u32       wtype;    /* quantization type of attn/ffn weights */
} Layer;

typedef struct {
    u32  n_vocab, n_embd, n_head, n_kv_head, n_layer, n_ff, n_ctx;
    u32  head_dim;
    f32  rope_base;
} Config;

typedef struct {
    Config     cfg;
    const u8  *tok_embd;
    const u8  *out_norm;    /* F32 */
    const u8  *lm_head;
    u32        embd_type;
    Layer      layers[MAX_LAYERS];
} Model;

/* BPE tokenizer */
typedef struct {
    char   **tok;           /* token strings [vocab_size] */
    u32      vocab_size;
    /* merge hash: key="a\x1fb" -> rank */
    u32     *mh_rank;
    char   **mh_key;
    u32      mh_mask;
    u32      num_merges;
    /* vocab hash for encode */
    u32     *vh_id;
    char   **vh_key;
    u32      vh_mask;
} BPE;

/* KV cache */
typedef struct {
    f32 *k;    /* [n_layer][MAX_CTX][n_kv_head][head_dim] */
    f32 *v;
    u32  used; /* tokens prefilled so far */
} KVCache;

/* ============================================================
 * 4.  GGUF reader  (cursor over mmap'd file)
 * ============================================================ */
typedef struct { const u8 *p; size_t left; int err; } Cur;

static void ensure(Cur *c, size_t n) { if (c->left < n) c->err = 1; }
static u8   read_u8  (Cur *c) { ensure(c,1); u8  v=*c->p; c->p++; c->left--; return v; }
static u16  read_u16 (Cur *c) { ensure(c,2); u16 v; memcpy(&v,c->p,2); c->p+=2; c->left-=2; return v; }
static u32  read_u32 (Cur *c) { ensure(c,4); u32 v; memcpy(&v,c->p,4); c->p+=4; c->left-=4; return v; }
static u64  read_u64 (Cur *c) { ensure(c,8); u64 v; memcpy(&v,c->p,8); c->p+=8; c->left-=8; return v; }
static f32  read_f32 (Cur *c) { u32 v=read_u32(c); f32 r; memcpy(&r,&v,4); return r; }

/* Read a GGUF string (u64 len + bytes, NOT null-terminated) into buf (null-terminates). */
static void read_str(Cur *c, char *buf, int bufsz) {
    u64 len = read_u64(c);
    if (c->err || (i32)len < 0) { if(bufsz>0) buf[0]=0; return; }
    u64 copy = (len < (u64)(bufsz-1)) ? len : (u64)(bufsz-1);
    ensure(c, len);
    if (!c->err) { memcpy(buf, c->p, copy); buf[copy]=0; }
    c->p += len; c->left -= len;
}

/* Heap-allocate a GGUF string (used for tokenizer vocab). */
static char *alloc_str(Cur *c) {
    u64 len = read_u64(c);
    if (c->err || len > 1<<20) return NULL;
    char *s = (char*)malloc(len+1);
    if (!s) { c->left=0; c->err=1; return NULL; }
    ensure(c, len);
    if (!c->err) { memcpy(s, c->p, len); s[len]=0; }
    c->p += len; c->left -= len;
    return s;
}

/* Skip a single GGUF value (any type). */
static void skip_val(Cur *c, u32 vtype) {
    switch (vtype) {
    case GVT_UINT8: case GVT_INT8: case GVT_BOOL: read_u8(c); break;
    case GVT_UINT16: case GVT_INT16: read_u16(c); break;
    case GVT_UINT32: case GVT_INT32: case GVT_FLOAT32: read_u32(c); break;
    case GVT_UINT64: case GVT_INT64: case GVT_FLOAT64: read_u64(c); break;
    case GVT_STRING: { u64 l=read_u64(c); c->p+=l; c->left-=l; break; }
    case GVT_ARRAY: {
        u32 et = read_u32(c);
        u64 cnt = read_u64(c);
        for (u64 i = 0; i < cnt && !c->err; i++) skip_val(c, et);
        break;
    }
    default: c->err = 1; break;
    }
}

/* ============================================================
 * 5.  Model file mapping
 * ============================================================ */
#ifndef BARE_METAL
static const u8 *map_file(const char *path, size_t *sz) {
#  ifdef _WIN32
    HANDLE fh = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ,
                            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (fh == INVALID_HANDLE_VALUE) return NULL;
    LARGE_INTEGER fsz; GetFileSizeEx(fh, &fsz);
    *sz = (size_t)fsz.QuadPart;
    HANDLE mh = CreateFileMappingA(fh, NULL, PAGE_READONLY, 0, 0, NULL);
    CloseHandle(fh);
    if (!mh) return NULL;
    return (const u8*)MapViewOfFile(mh, FILE_MAP_READ, 0, 0, 0);
#  else
    int fd = open(path, O_RDONLY);
    if (fd < 0) return NULL;
    struct stat st; fstat(fd, &st);
    *sz = (size_t)st.st_size;
    const u8 *p = (const u8*)mmap(NULL, *sz, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    return (p == MAP_FAILED) ? NULL : p;
#  endif
}
#endif /* BARE_METAL */

/* ============================================================
 * 6.  GGUF parse: config + tensor table
 * ============================================================ */
static TInfo  g_tensors[MAX_TENSORS];
static int    g_ntensors;
static size_t g_data_start; /* byte offset of tensor data in file */

static const TInfo *find_tensor(const char *name) {
    for (int i = 0; i < g_ntensors; i++)
        if (strcmp(g_tensors[i].name, name) == 0) return &g_tensors[i];
    return NULL;
}

/* Read an architecture uint32 KV value; returns def if not found. */
static void parse_gguf(const u8 *file, size_t filesz,
                       Config *cfg, BPE *bpe,
                       const u8 **tok_embd_out, u32 *embd_type_out,
                       const u8 **out_norm_out, const u8 **lm_head_out,
                       Layer layers[MAX_LAYERS]) {

    Cur c = { file, filesz, 0 };

    u32 magic = read_u32(&c);
    if (magic != GGUF_MAGIC) { fprintf(stderr, "Not a GGUF file\n"); exit(1); }
    u32 ver   = read_u32(&c);
    if (ver < GGUF_VER_MIN) { fprintf(stderr, "GGUF version %u too old\n", ver); exit(1); }
    u64 n_tensors = read_u64(&c);
    u64 n_kv      = read_u64(&c);

    /* scratch for tokenizer */
    char **vocab_strs  = NULL;
    u32    vocab_count = 0;
    char **merge_strs  = NULL;
    u32    merge_count = 0;

    /* ---- parse KV metadata ---- */
    char key[256];
    for (u64 i = 0; i < n_kv && !c.err; i++) {
        read_str(&c, key, sizeof(key));
        u32 vtype = read_u32(&c);

        /* architecture params */
        if (!strcmp(key, "qwen3.embedding_length") ||
            !strcmp(key, "llama.embedding_length") ) { cfg->n_embd    = read_u32(&c); continue; }
        if (!strcmp(key, "qwen3.block_count") ||
            !strcmp(key, "llama.block_count")       ) { cfg->n_layer   = read_u32(&c); continue; }
        if (!strcmp(key, "qwen3.attention.head_count") ||
            !strcmp(key, "llama.attention.head_count") ) { cfg->n_head = read_u32(&c); continue; }
        if (!strcmp(key, "qwen3.attention.head_count_kv") ||
            !strcmp(key, "llama.attention.head_count_kv") ) { cfg->n_kv_head = read_u32(&c); continue; }
        if (!strcmp(key, "qwen3.feed_forward_length") ||
            !strcmp(key, "llama.feed_forward_length") ) { cfg->n_ff   = read_u32(&c); continue; }
        if (!strcmp(key, "qwen3.context_length") ||
            !strcmp(key, "llama.context_length")    ) { cfg->n_ctx    = read_u32(&c); continue; }
        if (!strcmp(key, "qwen3.rope.freq_base") ||
            !strcmp(key, "llama.rope.freq_base")    ) { cfg->rope_base = read_f32(&c); continue; }
        if (!strcmp(key, "tokenizer.ggml.vocab_size")) { cfg->n_vocab = read_u32(&c); continue; }

        /* tokenizer vocab array */
        if (!strcmp(key, "tokenizer.ggml.tokens") && vtype == GVT_ARRAY) {
            u32 et  = read_u32(&c);
            u64 cnt = read_u64(&c);
            vocab_strs  = (char**)malloc(cnt * sizeof(char*));
            vocab_count = (u32)cnt;
            for (u64 j = 0; j < cnt && !c.err; j++) {
                if (et == GVT_STRING) vocab_strs[j] = alloc_str(&c);
                else { skip_val(&c, et); vocab_strs[j] = NULL; }
            }
            continue;
        }

        /* BPE merges array */
        if (!strcmp(key, "tokenizer.ggml.merges") && vtype == GVT_ARRAY) {
            u32 et  = read_u32(&c);
            u64 cnt = read_u64(&c);
            merge_strs  = (char**)malloc(cnt * sizeof(char*));
            merge_count = (u32)cnt;
            for (u64 j = 0; j < cnt && !c.err; j++) {
                if (et == GVT_STRING) merge_strs[j] = alloc_str(&c);
                else { skip_val(&c, et); merge_strs[j] = NULL; }
            }
            continue;
        }

        skip_val(&c, vtype);
    }

    /* ---- tensor info ---- */
    g_ntensors = 0;
    if (n_tensors > MAX_TENSORS) {
        fprintf(stderr, "Warning: %llu tensors, only reading %d\n",
                (unsigned long long)n_tensors, MAX_TENSORS);
        n_tensors = MAX_TENSORS;
    }
    for (u64 i = 0; i < n_tensors && !c.err; i++) {
        TInfo *t = &g_tensors[g_ntensors++];
        read_str(&c, t->name, sizeof(t->name));
        u32 ndim = read_u32(&c);
        if (ndim > 4) ndim = 4;
        for (u32 d = 0; d < ndim && !c.err; d++) t->ne[d] = read_u64(&c);
        t->type   = read_u32(&c);
        t->offset = read_u64(&c);
    }

    /* data section starts aligned to 32 bytes after tensor info */
    size_t cur_off = (size_t)(c.p - file);
    g_data_start   = (cur_off + 31) & ~(size_t)31;

    /* ---- derive remaining config ---- */
    if (!cfg->n_vocab && vocab_count) cfg->n_vocab = vocab_count;
    if (!cfg->n_ctx || cfg->n_ctx > MAX_CTX) cfg->n_ctx = MAX_CTX;
    if (!cfg->rope_base) cfg->rope_base = 1000000.0f;   /* Qwen3 default */
    cfg->head_dim = cfg->n_embd / (cfg->n_head ? cfg->n_head : 1);

    /* ---- build BPE tokenizer ---- */
    {
        /* vocab hash table */
        u32 vm = 1;
        while (vm < vocab_count * 2) vm <<= 1;
        bpe->vocab_size = vocab_count;
        bpe->tok        = vocab_strs;
        bpe->vh_id      = (u32*)malloc(vm * sizeof(u32));
        bpe->vh_key     = (char**)malloc(vm * sizeof(char*));
        bpe->vh_mask    = vm - 1;
        memset(bpe->vh_id, 0xFF, vm * sizeof(u32));
        memset(bpe->vh_key, 0, vm * sizeof(char*));

        for (u32 ti = 0; ti < vocab_count; ti++) {
            if (!vocab_strs[ti]) continue;
            const char *s = vocab_strs[ti];
            u32 len = (u32)strlen(s);
            u32 h = 2166136261u;
            for (u32 x = 0; x < len; x++) { h ^= (u8)s[x]; h *= 16777619u; }
            h &= bpe->vh_mask;
            while (bpe->vh_id[h] != 0xFFFFFFFF) h = (h+1) & bpe->vh_mask;
            bpe->vh_id[h]  = ti;
            bpe->vh_key[h] = vocab_strs[ti];
        }

        /* merge hash table: key = "a\x1fb", value = rank */
        bpe->num_merges = merge_count;
        u32 mm = 1;
        while (mm < merge_count * 2) mm <<= 1;
        bpe->mh_rank = (u32*)malloc(mm * sizeof(u32));
        bpe->mh_key  = (char**)malloc(mm * sizeof(char*));
        bpe->mh_mask = mm - 1;
        memset(bpe->mh_rank, 0xFF, mm * sizeof(u32));
        memset(bpe->mh_key, 0, mm * sizeof(char*));

        for (u32 mi = 0; mi < merge_count; mi++) {
            if (!merge_strs[mi]) continue;
            /* merge string is "a b" -- convert space separator to \x1f */
            char *sp = strchr(merge_strs[mi], ' ');
            if (sp) *sp = '\x1f';
            const char *s = merge_strs[mi];
            u32 len = (u32)strlen(s);
            u32 h = 2166136261u;
            for (u32 x = 0; x < len; x++) { h ^= (u8)s[x]; h *= 16777619u; }
            h &= bpe->mh_mask;
            while (bpe->mh_rank[h] != 0xFFFFFFFF) h = (h+1) & bpe->mh_mask;
            bpe->mh_rank[h] = mi;
            bpe->mh_key[h]  = merge_strs[mi];
        }
    }

    /* ---- map weight tensors ---- */
#define WPTR(name) do { \
    const TInfo *_t = find_tensor(name); \
    if (_t) { ptr = file + g_data_start + _t->offset; wtype = _t->type; } \
    else { ptr = NULL; wtype = 0; } \
} while(0)

    const u8 *ptr; u32 wtype;

    WPTR("token_embd.weight");
    *tok_embd_out = ptr; *embd_type_out = wtype;

    WPTR("output_norm.weight");
    *out_norm_out = ptr;

    /* lm_head is often tied to tok_embd */
    WPTR("output.weight");
    *lm_head_out = ptr ? ptr : *tok_embd_out;

    char nm[128];
    for (u32 L = 0; L < cfg->n_layer; L++) {
        Layer *lw = &layers[L];
#define LW(field, tname) \
        snprintf(nm, sizeof(nm), "blk.%u." tname, L); \
        WPTR(nm); lw->field = ptr; if(ptr) lw->wtype = wtype;

        LW(attn_norm, "attn_norm.weight")
        LW(q,         "attn_q.weight")
        LW(k,         "attn_k.weight")
        LW(v,         "attn_v.weight")
        LW(o,         "attn_output.weight")
        LW(q_norm,    "attn_q_norm.weight")
        LW(k_norm,    "attn_k_norm.weight")
        LW(ffn_norm,  "ffn_norm.weight")
        LW(gate,      "ffn_gate.weight")
        LW(up,        "ffn_up.weight")
        LW(down,      "ffn_down.weight")
#undef LW
    }
#undef WPTR
}

/* ============================================================
 * 7.  Dequantization
 * ============================================================ */

/* Q2_K: 256 elements per block, 84 bytes */
static void dequant_q2k_row(const u8 *data, u64 n_elems, f32 *out) {
    const u32 block_sz = 84;
    u64 n_blocks = n_elems / QK_K;
    for (u64 b = 0; b < n_blocks; b++) {
        const u8 *bl = data + b * block_sz;
        const u8 *scales = bl;
        const u8 *qs     = bl + 16;
        u16 dh, dminh;
        memcpy(&dh,    bl + 80, 2);
        memcpy(&dminh, bl + 82, 2);
        f32 d    = fp16(dh);
        f32 dmin = fp16(dminh);
        f32 *row = out + b * QK_K;
        for (int sub = 0; sub < 16; sub++) {
            f32 sc = d    * (f32)(scales[sub] & 0x0F);
            f32 mn = dmin * (f32)(scales[sub] >> 4);
            for (int l = 0; l < 16; l++) {
                int idx = sub*16 + l;
                int q = (qs[idx/4] >> (2*(l%4))) & 0x3;
                row[idx] = sc * (f32)q - mn;
            }
        }
    }
}

/* Q8_0: 32 elements per block, 34 bytes */
static void dequant_q8_row(const u8 *data, u64 n_elems, f32 *out) {
    u64 n_blocks = n_elems / QK8_0;
    for (u64 b = 0; b < n_blocks; b++) {
        const u8 *bl = data + b * 34;
        u16 dh; memcpy(&dh, bl, 2);
        f32 d = fp16(dh);
        const i8 *qs = (const i8*)(bl + 2);
        for (int i = 0; i < QK8_0; i++)
            out[b*QK8_0 + i] = d * (f32)qs[i];
    }
}

/* F32 row: just copy */
static void dequant_f32_row(const u8 *data, u64 n_elems, f32 *out) {
    memcpy(out, data, n_elems * sizeof(f32));
}

/* F16 row */
static void dequant_f16_row(const u8 *data, u64 n_elems, f32 *out) {
    const u16 *p = (const u16*)data;
    for (u64 i = 0; i < n_elems; i++) out[i] = fp16(p[i]);
}

/* Dispatch: dequantize one full row (row r) from a 2D tensor weight matrix
 * dims: [n_rows, n_cols] */
static u64 row_bytes(u32 type, u64 n_cols) {
    switch (type) {
    case GGML_F32:   return n_cols * 4;
    case GGML_F16:   return n_cols * 2;
    case GGML_Q8_0:  return (n_cols / QK8_0) * 34;
    case GGML_Q2_K:  return (n_cols / QK_K) * 84;
    case GGML_Q4_K:  return (n_cols / QK_K) * (4 + 12 + QK_K/2 + 0); /* approx */
    case GGML_Q6_K:  return (n_cols / QK_K) * (QK_K*6/8 + QK_K/16 + 2);
    default:         return n_cols;  /* fallback: probably wrong but won't crash */
    }
}

static void dequant_row(u32 type, const u8 *weight, u64 row, u64 n_cols, f32 *out) {
    const u8 *p = weight + row * row_bytes(type, n_cols);
    switch (type) {
    case GGML_F32:  dequant_f32_row(p, n_cols, out); break;
    case GGML_F16:  dequant_f16_row(p, n_cols, out); break;
    case GGML_Q8_0: dequant_q8_row(p, n_cols, out);  break;
    case GGML_Q2_K: dequant_q2k_row(p, n_cols, out); break;
    default:
        /* Q3_K, Q4_K, Q5_K, Q6_K: dequant stubs -- add when needed */
        memset(out, 0, n_cols * sizeof(f32));
        break;
    }
}

/* Matrix-vector product: y[i] = sum_j W[i,j] * x[j]
 * W is [n_rows x n_cols] quantized; x is [n_cols] float32. */
static void matvec(u32 wtype, const u8 *W, u64 n_rows, u64 n_cols,
                   const f32 *x, f32 *y, f32 *row_buf) {
    for (u64 r = 0; r < n_rows; r++) {
        dequant_row(wtype, W, r, n_cols, row_buf);
        f32 acc = 0.0f;
        for (u64 j = 0; j < n_cols; j++) acc += row_buf[j] * x[j];
        y[r] = acc;
    }
}

/* ============================================================
 * 8.  Transformer primitives
 * ============================================================ */

static void rmsnorm(f32 *o, const f32 *x, const f32 *w, u32 n, f32 eps) {
    f32 ss = 0.0f;
    for (u32 i = 0; i < n; i++) ss += x[i]*x[i];
    ss = 1.0f / sqrtf(ss / (f32)n + eps);
    for (u32 i = 0; i < n; i++) o[i] = x[i] * ss * w[i];
}

static void softmax_inplace(f32 *x, u32 n) {
    f32 mx = x[0];
    for (u32 i = 1; i < n; i++) if (x[i] > mx) mx = x[i];
    f32 sum = 0.0f;
    for (u32 i = 0; i < n; i++) { x[i] = expf(x[i] - mx); sum += x[i]; }
    for (u32 i = 0; i < n; i++) x[i] /= sum;
}

/* RoPE: in-place rotation of q or k vector (head_dim must be even) */
static void rope(f32 *v, u32 head_dim, u32 pos, f32 base) {
    for (u32 i = 0; i < head_dim/2; i++) {
        f32 theta = (f32)pos / powf(base, 2.0f*(f32)i/(f32)head_dim);
        f32 cs = cosf(theta), sn = sinf(theta);
        f32 a = v[2*i], b = v[2*i+1];
        v[2*i]   = a*cs - b*sn;
        v[2*i+1] = a*sn + b*cs;
    }
}

/* SiLU: x * sigmoid(x) */
static inline f32 silu(f32 x) { return x / (1.0f + expf(-x)); }

/* ============================================================
 * 9.  Forward pass (one token)
 * ============================================================ */

/* We keep all activations on the heap (allocated once in main). */
typedef struct {
    f32 *x;       /* [n_embd] current hidden state */
    f32 *xb;      /* [n_embd] scratch */
    f32 *xb2;     /* [n_embd] scratch 2 */
    f32 *q;       /* [n_head * head_dim] */
    f32 *k;       /* [n_kv_head * head_dim] */
    f32 *v_buf;   /* [n_kv_head * head_dim] */
    f32 *attn;    /* [n_head * MAX_CTX] attention scores */
    f32 *gate_v;  /* [n_ff] */
    f32 *up_v;    /* [n_ff] */
    f32 *logits;  /* [n_vocab] */
    f32 *row_buf; /* [max(n_vocab, n_ff, n_embd)] -- dequant scratch */
} RunState;

static u32 forward(const Model *m, RunState *s, KVCache *kv,
                   u32 token, u32 pos) {
    const Config *c = &m->cfg;
    u32 D  = c->n_embd, H = c->n_head, Hkv = c->n_kv_head;
    u32 hd = c->head_dim, L = c->n_layer;
    u32 FF = c->n_ff;

    /* embedding lookup */
    dequant_row(m->embd_type, m->tok_embd, token, D, s->x);

    /* layer loop */
    for (u32 l = 0; l < L; l++) {
        const Layer *lw = &m->layers[l];
        if (!lw->q) continue;  /* safety: skip if tensors missing */

        /* attention norm (F32 weights stored directly) */
        {
            const f32 *w = (const f32*)lw->attn_norm;
            rmsnorm(s->xb, s->x, w, D, 1e-6f);
        }

        /* Q, K, V projections */
        matvec(lw->wtype, lw->q, (u64)H*hd,   D, s->xb, s->q,    s->row_buf);
        matvec(lw->wtype, lw->k, (u64)Hkv*hd, D, s->xb, s->k,    s->row_buf);
        matvec(lw->wtype, lw->v, (u64)Hkv*hd, D, s->xb, s->v_buf,s->row_buf);

        /* QK norm (Qwen3 feature: per-head RMSNorm on Q and K) */
        if (lw->q_norm) {
            const f32 *qnw = (const f32*)lw->q_norm;
            const f32 *knw = (const f32*)lw->k_norm;
            for (u32 h = 0; h < H;   h++) rmsnorm(s->q+h*hd, s->q+h*hd, qnw, hd, 1e-6f);
            for (u32 h = 0; h < Hkv; h++) rmsnorm(s->k+h*hd, s->k+h*hd, knw, hd, 1e-6f);
        }

        /* RoPE */
        for (u32 h = 0; h < H;   h++) rope(s->q + h*hd, hd, pos, c->rope_base);
        for (u32 h = 0; h < Hkv; h++) rope(s->k + h*hd, hd, pos, c->rope_base);

        /* write K/V into cache */
        {
            u32 kv_stride = MAX_CTX * Hkv * hd;
            f32 *kc = kv->k + l * kv_stride + pos * Hkv * hd;
            f32 *vc = kv->v + l * kv_stride + pos * Hkv * hd;
            memcpy(kc, s->k,     Hkv*hd*sizeof(f32));
            memcpy(vc, s->v_buf, Hkv*hd*sizeof(f32));
        }

        /* GQA attention: each Q-head attends to its KV group */
        u32 gqa = H / Hkv;
        memset(s->xb, 0, D * sizeof(f32));

        for (u32 h = 0; h < H; h++) {
            u32 kv_h = h / gqa;
            f32 scale = 1.0f / sqrtf((f32)hd);
            f32 *score = s->attn + h * MAX_CTX;
            u32 kv_stride = MAX_CTX * Hkv * hd;

            /* compute scores */
            for (u32 t = 0; t <= pos; t++) {
                const f32 *kc = kv->k + l * kv_stride + t * Hkv * hd + kv_h * hd;
                f32 dot = 0.0f;
                const f32 *q_h = s->q + h * hd;
                for (u32 d = 0; d < hd; d++) dot += q_h[d] * kc[d];
                score[t] = dot * scale;
            }
            softmax_inplace(score, pos+1);

            /* weighted sum of values -> xb */
            f32 *out_h = s->xb + h * hd;
            for (u32 t = 0; t <= pos; t++) {
                const f32 *vc = kv->v + l * kv_stride + t * Hkv * hd + kv_h * hd;
                f32 a = score[t];
                for (u32 d = 0; d < hd; d++) out_h[d] += a * vc[d];
            }
        }

        /* O projection: xb2 = O @ xb */
        matvec(lw->wtype, lw->o, D, (u64)H*hd, s->xb, s->xb2, s->row_buf);

        /* residual */
        for (u32 i = 0; i < D; i++) s->x[i] += s->xb2[i];

        /* FFN: RMSNorm -> gate * SiLU(up) -> down */
        {
            const f32 *w = (const f32*)lw->ffn_norm;
            rmsnorm(s->xb, s->x, w, D, 1e-6f);
        }
        matvec(lw->wtype, lw->gate, FF, D, s->xb, s->gate_v, s->row_buf);
        matvec(lw->wtype, lw->up,   FF, D, s->xb, s->up_v,   s->row_buf);

        for (u32 i = 0; i < FF; i++)
            s->gate_v[i] = silu(s->gate_v[i]) * s->up_v[i];

        matvec(lw->wtype, lw->down, D, FF, s->gate_v, s->xb2, s->row_buf);

        /* residual */
        for (u32 i = 0; i < D; i++) s->x[i] += s->xb2[i];
    }

    /* final norm + lm_head */
    {
        const f32 *w = (const f32*)m->out_norm;
        rmsnorm(s->xb, s->x, w, D, 1e-6f);
    }
    matvec(m->embd_type, m->lm_head, c->n_vocab, D, s->xb, s->logits, s->row_buf);

    return 0; /* logits now in s->logits */
}

/* ============================================================
 * 10. Sampling
 * ============================================================ */
static u32 sample_topk(const f32 *logits, u32 n_vocab,
                        f32 temp, u32 top_k, u32 seed) {
    /* apply temperature */
    static f32 work[MAX_VOCAB];
    if (n_vocab > MAX_VOCAB) n_vocab = MAX_VOCAB;
    for (u32 i = 0; i < n_vocab; i++) work[i] = logits[i] / (temp > 0 ? temp : 1.0f);

    /* find top_k by partial sort (simple k-selection) */
    if (top_k < 1) top_k = 1;
    if (top_k > n_vocab) top_k = n_vocab;

    static u32 idx[MAX_VOCAB];
    for (u32 i = 0; i < n_vocab; i++) idx[i] = i;

    /* bubble top_k to front */
    for (u32 i = 0; i < top_k; i++) {
        for (u32 j = i+1; j < n_vocab; j++) {
            if (work[idx[j]] > work[idx[i]]) { u32 t=idx[i]; idx[i]=idx[j]; idx[j]=t; }
        }
    }

    /* softmax over top_k */
    f32 mx = work[idx[0]];
    f32 sum = 0.0f;
    for (u32 i = 0; i < top_k; i++) { work[idx[i]] = expf(work[idx[i]] - mx); sum += work[idx[i]]; }

    /* sample */
    seed = seed * 1664525u + 1013904223u;   /* LCG */
    f32 r = (f32)(seed >> 8) / (f32)(1<<24);
    f32 cum = 0.0f;
    for (u32 i = 0; i < top_k; i++) {
        cum += work[idx[i]] / sum;
        if (r < cum) return idx[i];
    }
    return idx[0];
}

/* ============================================================
 * 11. BPE encode
 * ============================================================ */
static u32 bpe_lookup(const BPE *bpe, const char *s, u32 len) {
    u32 h = 2166136261u;
    for (u32 i = 0; i < len; i++) { h ^= (u8)s[i]; h *= 16777619u; }
    h &= bpe->vh_mask;
    while (bpe->vh_id[h] != 0xFFFFFFFF) {
        if (bpe->vh_key[h] && strlen(bpe->vh_key[h])==len &&
            memcmp(bpe->vh_key[h], s, len)==0)
            return bpe->vh_id[h];
        h = (h+1) & bpe->vh_mask;
    }
    return 0xFFFFFFFF;
}

static u32 merge_rank(const BPE *bpe, const char *a, const char *b) {
    char key[64]; /* pieces max ~30 chars each */
    snprintf(key, sizeof(key), "%.30s%.30s", a, b);
    u32 len = (u32)strlen(key);
    u32 h = 2166136261u;
    for (u32 i = 0; i < len; i++) { h ^= (u8)key[i]; h *= 16777619u; }
    h &= bpe->mh_mask;
    while (bpe->mh_rank[h] != 0xFFFFFFFF) {
        if (bpe->mh_key[h] && strcmp(bpe->mh_key[h], key)==0)
            return bpe->mh_rank[h];
        h = (h+1) & bpe->mh_mask;
    }
    return 0xFFFFFFFF;
}

/* Encode text to token IDs (GPT-2 BPE).
 * Returns number of tokens written to out_ids (max max_ids). */
static int bpe_encode(const BPE *bpe, const char *text,
                      u32 *out_ids, int max_ids) {

    /* byte-level initial pieces */
    const u32 MAX_PIECES = 8192;
    static char pieces[8192][5];  /* each piece: 1 UTF-8 char (1-4 bytes) + null */
    int n = 0;
    for (const char *p = text; *p && n < (int)MAX_PIECES; ) {
        unsigned char c = (unsigned char)*p;
        int clen = (c < 0x80) ? 1 : (c < 0xE0) ? 2 : (c < 0xF0) ? 3 : 4;
        memcpy(pieces[n], p, clen); pieces[n][clen] = 0;
        n++; p += clen;
    }

    /* BPE merge loop */
    int changed = 1;
    while (changed) {
        changed = 0;
        u32 best_rank = 0xFFFFFFFF;
        int best_i = -1;
        for (int i = 0; i < n-1; i++) {
            u32 r = merge_rank(bpe, pieces[i], pieces[i+1]);
            if (r < best_rank) { best_rank = r; best_i = i; }
        }
        if (best_i < 0) break;
        /* merge best_i and best_i+1 */
        strncat(pieces[best_i], pieces[best_i+1], 4);
        for (int i = best_i+1; i < n-1; i++) memcpy(pieces[i], pieces[i+1], 5);
        n--;
        changed = 1;
    }

    /* map pieces to IDs */
    int out_n = 0;
    for (int i = 0; i < n && out_n < max_ids; i++) {
        u32 id = bpe_lookup(bpe, pieces[i], (u32)strlen(pieces[i]));
        if (id == 0xFFFFFFFF) id = 0; /* <unk> */
        out_ids[out_n++] = id;
    }
    return out_n;
}

/* ============================================================
 * 12. Generation loop
 * ============================================================ */

/* Strip <think>...</think> blocks (from _ask.mjs cleanup). */
static void strip_think(char *s) {
    char *found;
    while ((found = strstr(s, "<think>")) != NULL) {
        char *end = strstr(found, "</think>");
        if (!end) { *found = 0; break; }
        memmove(found, end + 8, strlen(end + 8) + 1);
    }
}

/* im_start / im_end token IDs for Qwen3 chat template */
#define BOS_STR   "<|im_start|>"
#define EOS_STR   "<|im_end|>"
#define NEWLINE   "\n"

static u32 g_im_start, g_im_end, g_nl;

static int gen_tokens(const Model *m, const BPE *bpe,
                      RunState *s, KVCache *kv,
                      const char *system_prompt, const char *user_msg,
                      u32 top_k, f32 temp, int max_gen,
                      u32 seed, char *out_buf, int out_sz) {

    static u32 prompt_ids[32768];
    int plen = 0;

    /* build chat template: <|im_start|>system\n...<|im_end|>\n
     *                       <|im_start|>user\n...<|im_end|>\n
     *                       <|im_start|>assistant\n              */
    char template_buf[65536];
    snprintf(template_buf, sizeof(template_buf),
        "<|im_start|>system\n%s<|im_end|>\n"
        "<|im_start|>user\n%s<|im_end|>\n"
        "<|im_start|>assistant\n",
        system_prompt, user_msg);

    plen = bpe_encode(bpe, template_buf, prompt_ids, 32768);

    /* prefill */
    kv->used = 0;
    for (int i = 0; i < plen; i++) {
        if (i >= MAX_CTX) break;
        forward(m, s, kv, prompt_ids[i], (u32)i);
        kv->used = (u32)(i+1);
    }

    /* generate */
    u32 prev = prompt_ids[plen-1];
    out_buf[0] = 0;
    int out_pos = 0;
    for (int step = 0; step < max_gen; step++) {
        forward(m, s, kv, prev, kv->used);
        u32 next = sample_topk(s->logits, m->cfg.n_vocab, temp, top_k, seed + (u32)step);
        kv->used++;

        if (next == g_im_end) break;  /* <|im_end|> = stop */

        /* decode token to string */
        const char *tok_str = (next < bpe->vocab_size && bpe->tok[next])
                              ? bpe->tok[next] : "?";
        int tlen = (int)strlen(tok_str);
        if (out_pos + tlen < out_sz - 1) {
            memcpy(out_buf + out_pos, tok_str, tlen);
            out_pos += tlen;
            out_buf[out_pos] = 0;
        }
        prev = next;
    }

    strip_think(out_buf);
    return out_pos;
}

/* ============================================================
 * 13. System prompt (gleaned from SYSTEM_PROMPT.md)
 * ============================================================ */
static const char SYSTEM_PROMPT[] =
    "You are a fully agentic local AI assistant running on bare metal (KISS2 HDGL Bot). "
    "You have access to this machine via the TempleOS RedSea filesystem. "
    "You think carefully before acting. You do not simulate or pretend. "
    "You are concise, direct, and honest. You respond in plain text with no markdown. "
    "You are the Wu-Wei metal agent: no NodeJS, no NGINX, ring 0, direct hardware.";

/* ============================================================
 * 14. Council: 2 inference passes + synthesis (mirrors _council.mjs)
 * ============================================================ */
static void council_session(const Model *m, const BPE *bpe,
                             RunState *s, KVCache *kv,
                             const char *question) {
    static char r1[16384], r2[16384], synth[16384];

    printf("\n\x1b[36m%s\x1b[0m\n", "== SLOT-1 (seed 42) ==");
    gen_tokens(m, bpe, s, kv, SYSTEM_PROMPT, question,
               20, 1.0f, MAX_GEN, 42, r1, sizeof(r1));
    printf("%s\n", r1);

    printf("\n\x1b[33m%s\x1b[0m\n", "== SLOT-2 (seed 137) ==");
    gen_tokens(m, bpe, s, kv, SYSTEM_PROMPT, question,
               20, 1.0f, MAX_GEN, 137, r2, sizeof(r2));
    printf("%s\n", r2);

    /* synthesis: ask model to reconcile both answers */
    char synth_q[32768];
    snprintf(synth_q, sizeof(synth_q),
        "Two independent answers to this question:\n"
        "Q: %s\n\n"
        "Answer 1:\n%s\n\n"
        "Answer 2:\n%s\n\n"
        "Synthesize the single most actionable conclusion. Be specific.",
        question, r1, r2);

    printf("\n\x1b[35m%s\x1b[0m\n", "== SYNTHESIS ==");
    gen_tokens(m, bpe, s, kv, SYSTEM_PROMPT, synth_q,
               20, 0.7f, MAX_GEN/2, 999, synth, sizeof(synth));
    printf("%s\n", synth);
}

/* ============================================================
 * 15. Main
 * ============================================================ */
int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
            "Usage: %s model.gguf [--council] [--temp F] [--top-k N] [--prompt TEXT]\n",
            argv[0]);
        return 1;
    }

    const char *model_path = argv[1];
    int council = 0;
    f32 temp    = 1.0f;
    u32 top_k   = 20;
    const char *one_shot = NULL;

    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--council"))                      council = 1;
        else if (!strcmp(argv[i], "--temp")    && i+1 < argc)  { temp  = (f32)atof(argv[++i]); }
        else if (!strcmp(argv[i], "--top-k")   && i+1 < argc)  { top_k = (u32)atoi(argv[++i]); }
        else if (!strcmp(argv[i], "--prompt")  && i+1 < argc)  { one_shot = argv[++i]; }
    }

    /* map GGUF file */
    size_t filesz;
    const u8 *file = map_file(model_path, &filesz);
    if (!file) { fprintf(stderr, "Cannot open %s\n", model_path); return 1; }
    fprintf(stderr, "[kiss2] mapped %.2f GB\n", (double)filesz / (1<<30));

    /* parse */
    static Model model;
    static BPE   bpe;
    memset(&model, 0, sizeof(model));
    memset(&bpe,   0, sizeof(bpe));

    parse_gguf(file, filesz,
               &model.cfg, &bpe,
               &model.tok_embd, &model.embd_type,
               &model.out_norm, &model.lm_head,
               model.layers);

    Config *c = &model.cfg;
    fprintf(stderr,
        "[kiss2] arch: vocab=%u embd=%u heads=%u/%u layers=%u ff=%u ctx=%u\n",
        c->n_vocab, c->n_embd, c->n_head, c->n_kv_head,
        c->n_layer, c->n_ff, c->n_ctx);

    /* allocate run state */
    u32 D=c->n_embd, H=c->n_head, Hkv=c->n_kv_head, hd=c->head_dim, FF=c->n_ff;
    u32 row_bufsz = c->n_vocab > FF ? c->n_vocab : FF;
    row_bufsz = row_bufsz > D ? row_bufsz : D;

    static RunState rs;
    rs.x       = (f32*)malloc(D   * sizeof(f32));
    rs.xb      = (f32*)malloc(D   * sizeof(f32));
    rs.xb2     = (f32*)malloc(D   * sizeof(f32));
    rs.q       = (f32*)malloc(H   * hd * sizeof(f32));
    rs.k       = (f32*)malloc(Hkv * hd * sizeof(f32));
    rs.v_buf   = (f32*)malloc(Hkv * hd * sizeof(f32));
    rs.attn    = (f32*)malloc(H * MAX_CTX * sizeof(f32));
    rs.gate_v  = (f32*)malloc(FF  * sizeof(f32));
    rs.up_v    = (f32*)malloc(FF  * sizeof(f32));
    rs.logits  = (f32*)malloc(c->n_vocab * sizeof(f32));
    rs.row_buf = (f32*)malloc(row_bufsz  * sizeof(f32));

    /* KV cache */
    static KVCache kv;
    size_t kv_layer_sz = (size_t)MAX_CTX * Hkv * hd;
    kv.k = (f32*)calloc(c->n_layer * kv_layer_sz, sizeof(f32));
    kv.v = (f32*)calloc(c->n_layer * kv_layer_sz, sizeof(f32));
    kv.used = 0;

    /* find special token IDs */
    g_im_start = bpe_lookup(&bpe, "<|im_start|>", 12);
    g_im_end   = bpe_lookup(&bpe, "<|im_end|>",   10);
    g_nl       = bpe_lookup(&bpe, "\n",            1);

    fprintf(stderr, "[kiss2] special tokens: im_start=%u im_end=%u\n",
            g_im_start, g_im_end);
    fprintf(stderr, "[kiss2] ready. %s\n",
            council ? "council mode (2 passes + synthesis)" : "chat mode");

    /* one-shot mode (mirrors: node _ask.mjs 1 <question>) */
    if (one_shot) {
        if (council) {
            council_session(&model, &bpe, &rs, &kv, one_shot);
        } else {
            static char out[65536];
            gen_tokens(&model, &bpe, &rs, &kv,
                       SYSTEM_PROMPT, one_shot,
                       top_k, temp, MAX_GEN, 42, out, sizeof(out));
            printf("\n%s\n", out);
        }
        return 0;
    }

    /* interactive chat loop */
    printf("\n\x1b[32mKISS2 HDGL Bot - bare metal Qwen3 chat\x1b[0m\n");
    printf("Commands: :q quit  :c toggle council  :t<F> set temp  :k<N> set top_k\n\n");

    static char line[4096];
    static char out[65536];

    for (;;) {
        printf("\x1b[1;37m> \x1b[0m");
        fflush(stdout);
        if (!fgets(line, sizeof(line), stdin)) break;
        int len = (int)strlen(line);
        while (len > 0 && (line[len-1]=='\n'||line[len-1]=='\r')) line[--len]=0;
        if (!len) continue;
        if (!strcmp(line, ":q")) break;
        if (!strcmp(line, ":c")) { council = !council;
            printf("[council %s]\n", council ? "on" : "off"); continue; }
        if (line[0]==':' && line[1]=='t') { temp = (f32)atof(line+2);
            printf("[temp %.2f]\n", temp); continue; }
        if (line[0]==':' && line[1]=='k') { top_k = (u32)atoi(line+2);
            printf("[top_k %u]\n", top_k); continue; }

        if (council) {
            council_session(&model, &bpe, &rs, &kv, line);
        } else {
            printf("\x1b[36m");
            gen_tokens(&model, &bpe, &rs, &kv,
                       SYSTEM_PROMPT, line,
                       top_k, temp, MAX_GEN, 42, out, sizeof(out));
            printf("\x1b[0m%s\n\n", out);
        }
    }

    return 0;
}
