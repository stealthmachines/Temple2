#!/usr/bin/env bash
# Easy by zCHG.org — macOS/Linux one-click launcher
# Run:  bash start.sh
# Or make executable:  chmod +x start.sh && ./start.sh

if ! command -v node &>/dev/null; then
  echo "[ERROR] node not found on PATH."
  echo "        Install Node.js from https://nodejs.org and try again."
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[ERROR] Node.js >= 18 required (found v$(node --version))."
  exit 1
fi

cd "$(dirname "$0")"
exec node launch.mjs "$@"
