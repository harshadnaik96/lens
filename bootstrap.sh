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

# 2. npm install
bold "→ Installing dependencies..."
npm install --silent
green "✓ deps installed"

# 3. build
bold "→ Building..."
npm run build --silent
green "✓ built dist/"

# 4. npm link
bold "→ Linking the \`lens\` command globally..."
if npm link >/dev/null 2>&1; then
  green "✓ lens command available on PATH"
else
  dim "(npm link needed sudo on this system — retrying)"
  sudo npm link
  green "✓ lens command available on PATH"
fi

# 5. interactive setup
bold "→ Launching interactive setup..."
exec lens setup
