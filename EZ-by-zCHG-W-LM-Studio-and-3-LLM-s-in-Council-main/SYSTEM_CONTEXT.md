# MCP Server Context — 2026-05-29T00:06:54.831Z

## Host
- OS: win32 (x64) | Windows: true
- Shell: cmd.exe
- CWD: C:\Users\Owner\Documents\Josef's Code 2026\KISS2 HDGL Bot\EZ-by-zCHG-W-LM-Studio-and-3-LLM-s-in-Council-main
- User: desktop-2nek92i\owner @ DESKTOP-2NEK92I

## Available Shell Tools
- ✓ node: v24.15.0
- ✓ python: Python 3.10.6
- ✓ git: git version 2.42.0.windows.1
- ✓ curl: curl 8.19.0 (Windows) libcurl/8.19.0 Schannel zlib/1.3.1 WinIDN WinLDAP
- ✓ wget: GNU Wget 1.25.0 built on cygwin.
- ✓ ffmpeg: ffmpeg version 8.0-essentials_build-www.gyan.dev Copyright (c) 2000-2025 the FFmpeg developers
- ✓ whisper: C:\Users\Owner\AppData\Local\Programs\Python\Python310\Scripts\whisper.exe
- ✓ pwsh: PowerShell 7.6.2
- ✓ winget: v1.28.240

## Missing Shell Tools
- ✗ npm
- ✗ pip
- ✗ choco

## Agent Decision Tree
- 1. Is this the start of a session? → call get_context() first, always.
- 2. Does the task involve more than one step? → use unfold(). Do not chain primitives manually.
- 3. Does it involve a URL? → check if binary (mp3/zip/pdf/exe) → unfold(), never web_fetch for binary.
- 4. Does it involve audio/video/transcription? → unfold() → server selects Transcription River.
- 5. Is it one known single operation I'm certain about? → use the appropriate primitive directly.
- 6. Am I unsure which primitive to use? → use unfold() and describe the task.
- 7. Do I need to remember something across sessions? → notes_write or db_exec, not memory_set.
- 8. Is the task complete? → report what actually happened, including pass_results from unfold.

## Hard Rules
- ALWAYS call get_context at session start.
- ALWAYS use unfold() for multi-step tasks.
- NEVER use web_fetch for binary files (MP3, ZIP, PDF, images). Use unfold() or shell+curl.
- NEVER assume a tool works — check tool_capabilities[tool].status first.
- NEVER use memory_set for data that must survive a restart — use notes or db.
- If whisper is missing and transcription is needed, install it first: pip install openai-whisper
- If ffmpeg is missing and audio conversion is needed, install it first.

## Shell Guidance
- Python binary: python
- Download command: curl -L -o "<dest>" "<url>"
- ffmpeg: ✓
- whisper: ✓

## Pass Architecture
unfold() selects from these named strategies based on task signals:
- **Transcription River**: FETCH → TRANSFORM(ffmpeg) → TRANSFORM(whisper) → STORE → RESPOND
- **Download and Convert**: FETCH → TRANSFORM → STORE → RESPOND
- **Web Harvest**: FETCH → CODE → STORE → RESPOND
- **Pure Fetch**: FETCH → RESPOND
- **Browser Quest**: BROWSE → [STORE] → RESPOND
- **Code and Store**: CODE → STORE → RESPOND  (run/execute + save/write — checked before Shell Strike)
- **Installation Stream**: SHELL → SHELL → RESPOND
- **Shell Strike**: SHELL → RESPOND  (single execution, no save)
- **Write Then Read**: STORE → RECALL → RESPOND  (write file then read it back)
- **Memory River**: RECALL → [CODE] → RESPOND
- **File Read**: RECALL → RESPOND
- **Notification Wave**: [FETCH|SHELL] → NOTIFY → RESPOND
- **Non-Action**: RESPOND (direct answer, no tools needed)

## Recipes (this machine)
### download_binary
```
shell({ command: 'curl -L -o "C:\\tmp\\file.mp3" "https://example.com/file.mp3"' })
```

### download_and_transcribe
```
unfold({ task: "download https://example.com/file.mp3 and transcribe it" })
```

### install_whisper
```
shell({ command: "python -m pip install openai-whisper" })
```

### install_ffmpeg
```
shell({ command: "winget install ffmpeg" })
```

### run_python
```
code_exec({ language: "python", code: "print('hello')" })
```

### browse_page
```
unfold({ task: "browse https://example.com and extract the main content" })
```

### save_to_db
```
db_exec({ sql: "CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY, data TEXT, ts TEXT)" })
```

### telegram_send
```
Set TG_BOT_TOKEN env var first
```

### schedule_daily
```
schedule_add({ id: "daily_task", expression: "0 9 * * *", command: "echo daily" })
```

## Persistence
- **memory**: memory_set/get | persists: false | Session working state, temp values
- **notes**: notes_write/read | persists: true | Text output, transcripts, logs, markdown
- **database**: db_exec/query | persists: true | Structured data, records, search
- **files**: fs_write/read | persists: true | Arbitrary files, scripts, exports