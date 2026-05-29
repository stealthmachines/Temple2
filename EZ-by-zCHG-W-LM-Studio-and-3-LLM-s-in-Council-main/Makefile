# Makefile for ez_chat -- KISS2 bare-metal GGUF inference
# Replaces the entire Node.js EZ bot stack with one C binary.
#
# Usage:
#   make               -- build release (Linux/macOS)
#   make debug         -- build with sanitizers
#   make run           -- run with MODEL path (set MODEL= env var)
#   make council       -- run in council mode
#
# Windows (Developer Command Prompt):
#   cl /O2 /Fe:ez_chat.exe ez_chat.c
#   ez_chat.exe "%USERPROFILE%\.lmstudio\models\...\Qwen3.5-9B-UD-Q2_K_XL.gguf"

CC      = gcc
CFLAGS  = -O3 -march=native -std=c11 -Wall -Wextra -Wpedantic
LDFLAGS = -lm

# Default model path (mirrors LM Studio default cache location)
MODEL  ?= $(HOME)/.lmstudio/models/unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-UD-Q2_K_XL.gguf

.PHONY: all debug run council clean

all: ez_chat

ez_chat: ez_chat.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)
	@echo "Built $@  --  $(shell ls -sh $@)"

debug: ez_chat.c
	$(CC) -O0 -g -fsanitize=address,undefined -o ez_chat_dbg $< -lm

run: ez_chat
	./ez_chat "$(MODEL)"

council: ez_chat
	./ez_chat "$(MODEL)" --council

clean:
	rm -f ez_chat ez_chat_dbg *.o
