#!/usr/bin/env bash
# Easy by zCHG.org — macOS / Linux one-click installer
#
# Usage:  bash install.sh
# Or:     chmod +x install.sh && ./install.sh
#
# Zero prerequisites — installs Node.js automatically if missing.
# Pass-through flags go to install.mjs:
#   --no-launch     install everything but don't start the stack
#   --skip-model    skip GGUF download (model already on disk)
#   --status        show current install state

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS="$(uname -s)"

# ── Pretty output ─────────────────────────────────────────────────────────────
ok()  { printf '\033[32m  [OK]\033[0m  %s\n' "$1"; }
inf() { printf '\033[36m  --> \033[0m  %s\n' "$1"; }
err() { printf '\033[31m  [X] \033[0m  %s\n' "$1"; }
hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }

printf '\n'
printf ' ======================================================\n'
printf '   Easy by zCHG.org  |  One-Click Installer\n'
printf ' ======================================================\n\n'

# ── Step 1: Ensure Node.js >= 18 ─────────────────────────────────────────────
hdr "Step 1/2 -- Node.js"

node_ok() {
  command -v node &>/dev/null || return 1
  local major; major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null)
  [ "${major:-0}" -ge 18 ]
}

if node_ok; then
  ok "Node.js $(node --version) detected"
else
  INSTALLED=0

  if [[ "$OS" == "Darwin" ]]; then
    # ── macOS: use Homebrew, installing it first if missing ──────────────────
    if ! command -v brew &>/dev/null; then
      inf "Homebrew not found — installing (may ask for your password) ..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      # Add brew to PATH for this session (Apple Silicon vs Intel)
      for PREFIX in /opt/homebrew /usr/local; do
        [ -x "$PREFIX/bin/brew" ] && eval "$("$PREFIX/bin/brew" shellenv)" && break
      done
    fi
    inf "Installing Node.js via Homebrew ..."
    brew install node && INSTALLED=1

  else
    # ── Linux: detect package manager ────────────────────────────────────────
    if command -v apt-get &>/dev/null; then
      inf "Installing Node.js LTS via NodeSource (Debian/Ubuntu) ..."
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
      sudo apt-get install -y nodejs && INSTALLED=1

    elif command -v dnf &>/dev/null; then
      inf "Installing Node.js LTS via NodeSource (Fedora/RHEL) ..."
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
      sudo dnf install -y nodejs && INSTALLED=1

    elif command -v yum &>/dev/null; then
      inf "Installing Node.js LTS via NodeSource (CentOS/RHEL) ..."
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
      sudo yum install -y nodejs && INSTALLED=1

    elif command -v pacman &>/dev/null; then
      inf "Installing Node.js via pacman (Arch Linux) ..."
      sudo pacman -S --noconfirm nodejs npm && INSTALLED=1

    elif command -v zypper &>/dev/null; then
      inf "Installing Node.js via zypper (openSUSE) ..."
      sudo zypper install -y nodejs npm && INSTALLED=1

    else
      # ── Fallback: download prebuilt binary directly from nodejs.org ─────
      inf "No known package manager — downloading Node.js binary from nodejs.org ..."
      ARCH="$(uname -m)"
      case "$ARCH" in
        x86_64)  NODE_ARCH=x64    ;;
        aarch64) NODE_ARCH=arm64  ;;
        armv7l)  NODE_ARCH=armv7l ;;
        *) err "Unsupported CPU architecture: $ARCH"; exit 1 ;;
      esac
      # Fetch current LTS version number
      NODE_VER=$(curl -fsSL "https://nodejs.org/dist/index.json" | \
        python3 -c "import sys,json; d=[x for x in json.load(sys.stdin) if x.get('lts')]; print(d[0]['version'])" 2>/dev/null || echo "v22.14.0")
      TARBALL="node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz"
      URL="https://nodejs.org/dist/${NODE_VER}/${TARBALL}"
      DEST="$HOME/.local"
      mkdir -p "$DEST"
      inf "Downloading $TARBALL (~30 MB) ..."
      curl -fsSL "$URL" -o "/tmp/$TARBALL"
      inf "Extracting to $DEST ..."
      tar -xJf "/tmp/$TARBALL" -C "$DEST" --strip-components=1
      export PATH="$DEST/bin:$PATH"
      INSTALLED=1
    fi
  fi

  if [ "$INSTALLED" -ne 1 ] || ! node_ok; then
    err "Could not install Node.js automatically."
    err "Please install it manually from: https://nodejs.org"
    err "Then run: bash install.sh"
    exit 1
  fi
  ok "Node.js $(node --version) installed and ready"
fi

# ── Step 2: Hand off to install.mjs ──────────────────────────────────────────
hdr "Step 2/2 -- MCP Stack"
inf "Handing off to install.mjs ..."
printf '\n'

cd "$DIR"
exec node install.mjs "$@"
