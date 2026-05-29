# LAN Boot Kernel (KISS2)

This boot kernel unifies all three repos for LAN chat access:

- EZ stack: MCP A/B + coord proxy + chat UI (`/chat`)
- conscious: optional `prime_ui` command bridge (`/kernel/prime`)
- NGINX-HDGL: optional daemon auto-start + health probe

## Quick start (Windows)

1. (Recommended on a fresh PC) Run preflight in PowerShell:
	- `powershell -ExecutionPolicy Bypass -File .\\install-fresh.ps1`
1. Put your model file next to this bootloader (or set `MODEL_FILE`).
2. Put `llama-server.exe` next to this bootloader (or set `LLAMA_SERVER_EXE`).
3. Run `start-kernel.bat`.
4. Open `http://<your-lan-ip>:1618/chat` from any device on your LAN.

## Is this a bootloader?

This is an application-level LAN boot orchestrator, not a BIOS/UEFI bootloader.
It is suitable for "fresh machine install" of your local bot stack and can auto-provision runtime dependencies for the EZ layer.

## Environment variables

- `MODEL_FILE`: absolute path to your `.gguf` model file.
- `LLAMA_SERVER_EXE`: path to `llama-server.exe`.
- `START_LLM`: `1` or `0` (default `1`).
- `START_HDGL`: `1` or `0` (default `1`).
- `BIND_HOST`: listener host for LAN (default `0.0.0.0`).
- `COORD_PORT`: chat/proxy port (default `1618`).
- `KERNEL_PORT`: kernel API port (default `17800`).

## Endpoints

- Chat UI: `GET /chat` (served by coord proxy)
- Chat API: `POST /v1/chat/completions`
- Kernel status: `GET /kernel/status`
- conscious bridge: `POST /kernel/prime` with JSON body `{ "key": "5" }`

## Notes

- Existing EZ files were patched for LAN host binding (`0.0.0.0`) and same-origin chat calls.
- On first run, the boot kernel auto-runs `npm install` in the EZ repo if dependencies are missing.
- Fresh-machine helper script: `install-fresh.ps1` (Node check/install + optional firewall rules).
- If HDGL daemon binary does not exist yet, boot continues without it.
- If model runner is missing, boot continues and expects an already-running local LLM endpoint.
