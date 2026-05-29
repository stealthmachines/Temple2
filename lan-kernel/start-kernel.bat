@echo off
setlocal

where node >nul 2>&1
if errorlevel 1 (
	echo [KERNEL] Node.js is required but not found on PATH.
	echo [KERNEL] Install Node.js 18+ from https://nodejs.org and re-run this file.
	exit /b 1
)

REM Optional overrides:
REM   set MODEL_FILE=C:\path\to\model.gguf
REM   set LLAMA_SERVER_EXE=C:\path\to\llama-server.exe
REM   set BIND_HOST=0.0.0.0
REM   set START_HDGL=1
REM   set START_LLM=1

cd /d "%~dp0"
echo [KERNEL] Launching LAN boot kernel...
node boot-kernel.mjs
