#!/usr/bin/env bash
# Lens — first-run bootstrap.
# Installs deps, builds, links the `lens` command, and runs interactive setup.
#
# Usage:  ./bootstrap.sh

set -euo pipefail

cd "$(dirname "$0")"

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
dim()    { printf '\033[2m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }

bold "🔍 Lens bootstrap"

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  red "Node.js is not installed. Install Node 20+ from https://nodejs.org and re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "Node $NODE_MAJOR detected — Lens needs Node 20+. Upgrade and re-run."
  exit 1
fi
green "✓ Node $(node -v)"

# 2. ripgrep check / install
if ! command -v rg >/dev/null 2>&1; then
  bold "→ Installing ripgrep..."
  if command -v brew >/dev/null 2>&1; then
    brew install ripgrep
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y ripgrep
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y ripgrep
  else
    red "ripgrep not found and no supported package manager (brew/apt/dnf) detected."
    red "Install ripgrep manually: https://github.com/BurntSushi/ripgrep#installation"
    exit 1
  fi
fi
green "✓ ripgrep $(rg --version | head -1 | awk '{print $2}')"

# 3. npm install
bold "→ Installing dependencies..."
npm install --silent
green "✓ deps installed"

# 4. build
bold "→ Building..."
npm run build --silent
green "✓ built dist/"

# Rebuild native addons for the current Node version
npm rebuild --silent
green "✓ native addons compiled"

# 5. link the lens binary onto PATH
bold "→ Linking the \`lens\` command globally..."
LENS_BIN="$(pwd)/dist/cli.js"
LINK_DIR="$HOME/.local/bin"
mkdir -p "$LINK_DIR"
printf '#!/usr/bin/env bash\nexec node "%s" "$@"\n' "$LENS_BIN" > "$LINK_DIR/lens"
chmod +x "$LINK_DIR/lens"
green "✓ lens command available on PATH (~/.local/bin/lens)"

# 6. interactive setup
bold "→ Launching interactive setup..."
exec node dist/cli.js setup
