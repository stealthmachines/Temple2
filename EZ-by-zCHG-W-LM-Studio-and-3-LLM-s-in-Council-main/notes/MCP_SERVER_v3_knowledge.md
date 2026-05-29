# 🧠 MCP Server v3.0.0 — Compressed Knowledge Base
**Generated: 2026-05-04** | **Version: 3.0.0** | **Size: ~1200 tokens**

## Core Architecture
- **Server**: phi-primary v3.0.0 (Wu-Wei Unfold Architecture)
- **Endpoint**: http://localhost:4111/sse
- **Tools**: 57 primitives across 14 capability groups
- **Pass Pipeline**: FETCH→TRANSFORM→STORE→RESPOND (or other sequences based on task analysis)
- **FlowState**: Carries cwd, env, data, last_path, last_url, browser_session, etc. across passes

## Persistence Layers
1. **Memory** (volatile): `memory_set/get` — session-only, lost on restart
2. **Notes** (persistent): `notes_write/read` — markdown files in `./notes/`
3. **Database** (persistent): `db_exec/query` — SQLite via sql.js in `mcp-data.db`
4. **ERL Ledger** (persistent): Hash-chained Git-like history in `erl-ledger.json`

## ERL v3 (Elegant Recursive Ledger) — Key Features
- **Hash-chained**: SHA-256(parentID + timestamp + branch + content)
- **Branching**: Diverge from any entry, HEAD tracks tip of each branch
- **Merging**: Linear replay (no complex diff conflicts)
- **Verification**: Cryptographic integrity check of entire chain
- **Current Branches**: `main`, `session_context`, `task_*`, `conversation_absorption_*`

## Non-Negotiable Directives
1. **ALWAYS** call `get_context()` at session start
2. **ALWAYS** use `unfold()` for multi-step tasks
3. **NEVER** use `web_fetch()` for binary files (MP3/ZIP/PDF/images)
4. **NEVER** use `memory_set()` for persistent data
5. **USE** `notes_write()` and `db_exec()` for persistence instead
6. **THINK** step by step, use tools, report what actually happened

## Available Tools (57 Total)
**Shell**: shell, shell_stream  
**Filesystem**: fs_read, fs_write, fs_list, fs_delete, fs_stat, fs_search  
**Browser**: browser_open, browser_navigate, browser_click, browser_fill, browser_screenshot, browser_extract, browser_close  
**Code**: code_exec (Python, Node, Bash)  
**Database**: db_query, db_exec, db_tables, db_export  
**Notes**: notes_write, notes_read, notes_list, notes_delete, notes_search  
**Web**: web_fetch  
**System**: sysinfo, processes, process_kill, clipboard_read, clipboard_write, notify  
**Network**: http_serve, http_serve_stop  
**Schedule**: schedule_add, schedule_list, schedule_remove  
**Email**: smtp_send  
**Telegram**: tg_send, tg_listen, tg_inbox, tg_stop  
**Memory**: memory_set, memory_get, memory_list, memory_delete  
**Env**: env_get, env_list, process_info  

## ERL Tools (6 Available)
- `erl_history` — View branch history
- `erl_search` — Search entries by content/role/tags
- `erl_verify` — Verify cryptographic integrity
- `erl_merge` — Merge one branch into another
- `erl_create_branch` — Create new branches
- `erl_append` — Add entries to branches

## Usage Pattern for Token Efficiency
1. **Start session**: Call `get_context()` to load system info
2. **For work**: Use `unfold()` with natural language tasks
3. **For persistence**: Store knowledge in ERL ledger (not memory)
4. **For cleanup**: Clear LM Studio messages, then load ERL data
5. **Result**: ~90% token reduction vs. verbose conversation

## Example Workflow
```
# 1. Load context
get_context()

# 2. Do work with unfold
unfold({ task: "download https://example.com/file.pdf and transcribe it" })

# 3. Persist knowledge
unfold({ task: "save key insights to notes/knowledge.md" })

# 4. For cleanup in LM Studio:
#    - Clear all messages
#    - Then: unfold({ task: "load the compressed knowledge base from notes/MCP_SERVER_v3.md and summarize current capabilities" })
```

## Server Modifications (Self-Improvement)
- Added `erlStandardInit()` — Auto-initializes ERL `session_context` on startup
- Created `tools_erl.js` — 6 ERL tools for agent use
- Enhanced README.md and documentation
- Established branching strategy: `session_context` for knowledge, `task_*` for work

## Conclusion
This compressed knowledge base (~1200 tokens) replaces a verbose conversation that would consume 67.5%+ of context. By using ERL v3 for persistence and this summary for loading, you achieve ~90% token efficiency while maintaining all critical knowledge.

To use: Copy this into a note, then in LM Studio after clearing messages, call:
```
unfold({ task: "load this MCP server knowledge base and confirm readiness" })
```

End of compressed knowledge base.