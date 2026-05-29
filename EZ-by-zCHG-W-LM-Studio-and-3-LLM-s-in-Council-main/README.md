WARNING!  This repo gives bot DIRECT ACCESS to your filesystem.  So while it's easy to deploy, it's not for beginners.  DEMO at your own risk, and if you like it PAY ME FOR MY WORK per the license agreement.  This bot runs best at this time on a fresh install of Windows that you do not care about, with zero access to sensitive files.  You can easily accomplish this by purchasing a 128GB NVME, installing Windows (as I understand this means you only need one copy of Windows for both hard drives), then manually swapping back to your daily driver ([if you should ever want your old ass groove back](https://zchg.org/t/booting-existing-copy-of-windows-inside-of-ubuntu/878)), assuming you would ever choose to go back after experiencing the awesomeness of two local + one cloud bot accelerating your workflow.  Or, you know, containers, if you are intermediate.  You can direct a bot to help you to this end, or you may write to me - [charg.chg.wecharg@gmail.com](mailto:charg.chg.wecharg@gmail.com) if you're a premium customer and I'll bend over backwards to help you!  My rates are very reasonable!

# Easy by zCHG.org

> **Phi-resonant dual-MCP stack** — two LLM-backed MCP servers, a phi-emergent routing proxy, an ERL v3 hash-chained ledger, and a tri-voice conversation system grounded in the same φ = 1.618… constant as the Analog-Prime conscious platform.

---

## Stack at a Glance

| Process | Port | File | Purpose |
|---------|------|------|---------|
| MCP Server A | 4111 | `server.js` | Primary tools + LLM bridge |
| MCP Server B | 4112 | `server-dos.js` | Mirror — stochastic divergence |
| Coord-Proxy | 1618 | `coord-proxy.js` | Wu-Wei phi-routing (SOLO / RELAY / CHALLENGE) |
| Wu-Wei Daemon | — | `wuwei-routing/` | HDGL health writer |
| LM Studio | 1234 | *(external)* | **Never touch from code** |

```
Claude / Copilot
      │
      ├── MCP tools (SSE) ──► server.js :4111 ──► ERL ledger
      │                                        └► llm_query ──► LM Studio :1234
      └──────────────────────► server-dos.js :4112 (mirror)
                                    │
coord-proxy :1618 ─────────────────►│ phi-routes between :4111 / :4112 / :1234
```

---

## Prerequisites

**None.** The installer handles everything.

---

## One-Click Install + Run

### Windows
Double-click **`INSTALL.bat`** — that's it.

### macOS / Linux
```bash
bash install.sh
```

What happens automatically:
1. **Node.js LTS** installed if missing (Windows: winget or MSI; macOS: Homebrew; Linux: NodeSource/apt/dnf/pacman)
2. **npm packages** installed
3. **LM Studio** downloaded and installed silently
4. **Qwen3.5-9B GGUF** (~4 GB) downloaded and imported into LM Studio
5. **LM Studio server** started on :1234, model loaded into memory
6. **MCP stack** started (server.js :4111 + server-dos.js :4112 + coord-proxy :1618)

### Install options
```bash
node install.mjs --no-launch     # install everything but don't start the stack yet
node install.mjs --skip-model    # skip the 4 GB download (model already present)
node install.mjs --status        # show what's installed and what's missing
```

---

## Already installed? (just start the stack)

```bash
# Windows
start.bat

# macOS / Linux
bash start.sh

# or directly
node launch.mjs
```

`launch.mjs` auto-detects whether the LM Studio server is running and starts it if not. If no models are loaded it triggers a background `lms load`.

### launch.mjs options
```bash
node launch.mjs --no-proxy              # skip coord-proxy (if LM Studio isn't running)
node launch.mjs --status                # probe all ports + list loaded LLMs
node launch.mjs --load-model MODEL_ID   # ask LM Studio to load a specific model
node launch.mjs --help
npm run status
```

**Requires Node.js ≥ 18 and npm. Nothing else.**

```powershell
# Windows — double-click start.bat, or:
node launch.mjs

# macOS / Linux:
bash start.sh
# or: chmod +x start.sh && ./start.sh

# npm:
npm start
```

On first run, `launch.mjs` will automatically run `npm install` if `node_modules` is missing.

Options:
```
node launch.mjs --no-proxy              # skip coord-proxy (if LM Studio isn't running)
node launch.mjs --status                # probe all ports + list loaded LLMs
node launch.mjs --load-model MODEL_ID   # ask LM Studio to load a model (v0.3.x+ API)
node launch.mjs --help
npm run status
```

Ctrl+C (or SIGTERM) shuts down all child processes cleanly.

---

## ERL v3 — Hash-Chained Context Ledger

ERL (Emergent Reasoning Ledger) is a git-like hash-chained ledger stored in `erl-ledger.json`.

### Key properties

- **Phi-scored retrieval** — recency score uses `γ^k` decay (γ = 0.75, φ = 1.618 base constant)
- **Concurrent write safety** — spinlock via `erl-ledger.json.lock`
- **Merkle checkpoints** — root computed every 50 appends (`CHECKPOINT_INTERVAL`)
- **Branches** — `main`, `session_context`, `twin_flame_evals`, `twin_flame_probes`, `triad_session`
- **ERL merge** — deterministic merge with conflict detection

### Internal functions (Node.js)

| Function | Purpose |
|----------|---------|
| `erlAppend(ledger, { branch, role, content, tags })` | Append entry; returns entry with SHA-256 id |
| `erlBranch(ledger, { name, from_branch })` | Create branch |
| `erlHistory(ledger, { branch, limit })` | Retrieve recent entries |
| `erlVerify(ledger)` | Hash-chain integrity check |
| `erlSearch(ledger, { query, branch })` | Phi-scored semantic search |
| `erlMerge(ledger, { source, target })` | Merge two branches |
| `getLedger()` | Thread-safe read with spinlock |
| `erlSave(ledger)` | Thread-safe write with spinlock |

### MCP tools (callable over SSE)

`erl_append`, `erl_history`, `erl_search`, `erl_verify`, `erl_merge`, `erl_create_branch`, `context_save`, `context_retrieve`, `erl_fold`, `erl_cleanup`

---

## MCP Tool Reference (key tools)

### `llm_query`

Direct LLM inference through LM Studio. Logs response to ERL by default.

```json
{
  "prompt": "Your question",
  "model": "qwen3.5-9b@q2_k_xl:2",
  "max_tokens": 200,
  "temperature": 0.7,
  "log": true,
  "branch": "session_context"
}
```

Returns `{ response, prompt_hash, logged_to_erl, model, tokens }`.

**Timeout**: 90 000 ms. The first inference after a reboot is slow — do not lower below 90s.

**Safety rule**: Never call `llm_query` from `Promise.all` across multiple *different* model names simultaneously. LM Studio will evict the first model when the second request loads.

### `twin_flame_eval`

Log a self-evaluation for a model response. Schema is identical on both ports.

```json
{
  "confidence": 8,
  "response_summary": "brief description",
  "prompt": "original prompt",
  "model": "qwen3.5-9b@q2_k_xl:2",
  "branch": "twin_flame_evals",
  "tags": ["custom"]
}
```

Returns `{ logged, branch, entry_id, confidence }`.

### `twin_flame_probe`

Known-answer baseline + drift detection. Stores question/answer pairs and tracks hash drift over time.

### `twin_flame_divergence`

Compare the last N eval entries across both servers to measure response divergence.

### `phi_route`

Get the phi-routing decision for a prompt: `SOLO` (< 0.382), `RELAY` (0.382–0.618), or `CHALLENGE` (> 0.618).

---

## Demo Scripts

### `_twin_demo.mjs` — 2-voice stochastic divergence

Two instances of the same model answer the same question. Because sampling is non-deterministic, responses diverge even with identical weights. Measures **stochastic divergence** — how much randomness/temperature contributes to answer variance.

```powershell
node _twin_demo.mjs
```

### `_triad_demo.mjs` — 3-voice conversation

Three voices answer the same question. Responses are logged to ERL and a thematic alignment check is run.

- **Voice A** — `qwen3.5-9b@q2_k_xl:2` on port 4111
- **Voice B** — `qwen3.5-9b@q2_k_xl` on port 4112
- **Voice C** — GitHub Copilot (inline — no local endpoint needed)

```powershell
# Default run:
node _triad_demo.mjs

# Custom models (any LM Studio hot models):
node _triad_demo.mjs --modelA mistral-7b --modelB llama-3-8b

# Custom question:
node _triad_demo.mjs --question "What is the most important property of a distributed system?"

# Skip Copilot voice (2-model mode):
node _triad_demo.mjs --no-copilot

# Tune generation:
node _triad_demo.mjs --temp 0.9 --max-tokens 300
```

If a model is offline, its voice is skipped gracefully — the triad degrades to a duo without crashing.

### `_probe.mjs` — single-shot probe

Fire individual MCP tool calls for testing and inspection.

---

## Coord-Proxy — Wu-Wei Phi-Routing

`coord-proxy.js` (port 1618) sits between your client and LM Studio, routing requests based on a phi-hash of the prompt content:

| Score | Mode | Behaviour |
|-------|------|-----------|
| < 0.382 | SOLO | Forward directly to LM Studio :1234 |
| 0.382–0.618 | RELAY | Send to server A, relay result to server B for enrichment |
| > 0.618 | CHALLENGE | Send to both servers, have them evaluate each other |

```
phiScore = (sha256(prompt)[0:8] / 0xFFFFFFFF × φ) % 1
```

Distribution converges to φ-emergent proportions: **61.8% SOLO / 23.6% RELAY / 14.6% CHALLENGE**.

Check status:
```powershell
Invoke-RestMethod http://localhost:1618/status
```

---

## Architecture: 3 Mechanisms, Not Slop

Three multi-LLM mechanisms exist in this stack. They are not duplicates — they operate at different layers:

| Mechanism | Layer | Purpose |
|-----------|-------|---------|
| `_twin_demo.mjs` | Demo script | Measure stochastic variance between two samples of the same model |
| `_triad_demo.mjs` | Demo script | Explicit 3-voice conversation: 2 local LLMs + Copilot as participant |
| `coord-proxy.js` | Production routing | SOLO/RELAY/CHALLENGE phi-routing — routes traffic, not a conversation script |

The proxy is the actual production architecture. The demo scripts are measurement tools that use the same underlying transport.

---

## Phi Foundation & Analog-Prime Connection

This stack shares a mathematical foundation with the [Analog-Prime `conscious` platform](https://github.com/stealthmachines/Analog-Prime):

**PHI = 1.6180339887498948482** is the governing constant in both systems.

| This stack | Analog-Prime conscious |
|------------|----------------------|
| ERL recency decay: `γ^k`, γ = 0.75 | HDGL `Dₙ(r)` resonance: `√(φ·Fₙ·2ⁿ·Pₙ·Ω)·r^((n+1)/8)` |
| `phiHash(content) % 1` routing thresholds | Slot4096 phi-lattice bucket assignment |
| SOLO/RELAY/CHALLENGE tri-split | Markov trit gate: −1 / 0 / +1 (REJECT / UNCERTAIN / ACCEPT) |
| Three-voice triad convergence check | Kuramoto 8D oscillator phase-lock (`S(U) ≈ 1.531`) |
| ERL hash-chaining | PCR-style hash chains in PhiKernel |
| Wu-Wei routing (5 compression strategies) | Wu-Wei codec: WW_NONACTION / WW_GENTLE_STREAM / WW_BALANCED_PATH / WW_FLOWING_RIVER / WW_REPEATED_WAVES |

The **Markov trit gate** (−1/0/+1) is genuine tri-state logic — the same reason this stack avoids binary evaluations and uses 1–10 confidence scores. The three-voice triad demo is a digital analog of the Kuramoto synchronisation lock: each voice converges on an answer independently; the divergence metric measures how far apart the phases are.

---

## Browser Chat UI

Once the stack is running, open **http://localhost:1618** in any browser (the installer auto-opens it).

- Static welcome card on load — the UI leads, not the LLM
- `Enter` to send, `Shift+Enter` for newlines
- "Connecting…" status pill while the proxy starts; input locked until stack is up
- phi-routing (SOLO / RELAY / CHALLENGE) happens transparently in the proxy
- No WebSocket — plain HTTP POST to `/v1/chat/completions`

Alternate routes: `http://localhost:1618/` and `http://localhost:1618/chat` both serve the UI.

---

## Current Hot Models

```
qwen3.5-9b@q2_k_xl:2   ← slot 2, ctx 199 999  (persistent)
qwen3.5-9b@q2_k_xl     ← slot 1, ctx 200 000  (reload if evicted after reboot)
```

Check LM Studio's **Loaded Models** tab before running any demo.

---

## Safety Rules

1. **Never `Promise.all` across different model names** toward LM Studio — eviction kills one model.
2. **Never auto-discover models** with parallel probes — use confirmed names from the LM Studio UI.
3. **`llm_query` timeout is 90 000 ms** — first inference post-reboot can be slow.
4. **Port 1234 is LM Studio** — never send non-inference traffic; never restart it from code.

---

## File Map

```
# ── Entry points ─────────────────────────────────────────────────────────────
INSTALL.bat            Windows: double-click → installs + launches everything
install.sh             macOS/Linux: bash install.sh → installs + launches
install.mjs            Full cross-platform installer (Node, LM Studio, model, stack)
launch.mjs             Re-launcher after first install (auto-npm-installs if needed)
start.bat              Windows re-launch shortcut → node launch.mjs
start.sh               macOS/Linux re-launch shortcut → node launch.mjs

# ── Stack core ───────────────────────────────────────────────────────────────
server.js              MCP Server A — port 4111
server-dos.js          MCP Server B — port 4112 (mirror)
coord-proxy.js         Wu-Wei phi-routing proxy — port 1618
chat.html              Browser chat UI served at http://localhost:1618
start-server.js        Helper — starts MCP servers without the proxy

# ── Tools ────────────────────────────────────────────────────────────────────
tools_erl.js           ERL v3 tool exports
tools_cleanup.js       ERL fold / cleanup utilities
analog-container.mjs   AnalogContainer1 execution rail bootstrap

# ── Dev / demo scripts ───────────────────────────────────────────────────────
_twin_demo.mjs         2-voice stochastic divergence demo
_triad_demo.mjs        3-voice conversation demo (CLI-configurable)
_ask.mjs               Direct model query helper
_council.mjs           Multi-voice council query helper

# ── Config / docs ────────────────────────────────────────────────────────────
mcp.json               MCP server URLs for client registration
package.json           npm manifest (exact pinned versions, no ^ ranges)
SYSTEM_PROMPT.md       Wu-Wei v3.0.0 agentic system prompt (57+ tools)
SYSTEM_CONTEXT.md      Human-readable architecture reference
context_clearing_protocol.md  Protocol for ERL context management
notes/                 Architecture notes, ERL spec, implementation summaries
wuwei-routing/         HDGL routing configs and runtime state

# ── Runtime (auto-generated, gitignored) ─────────────────────────────────────
# erl-ledger.json      Hash-chained conversation ledger  [created on first run]
# mcp-data.db          SQLite tool storage               [created on first run]
# mcp-audit.log        Audit log                         [created on first run]
# SYSTEM_CONTEXT.json  Context snapshot                  [generated at server start]
```

---

## Ports Summary

| Port | Process | Notes |
|------|---------|-------|
| 4111 | server.js | Primary MCP server |
| 4112 | server-dos.js | Mirror MCP server |
| 1618 | coord-proxy.js | Wu-Wei routing proxy |
| 1234 | LM Studio | External — never modify |
