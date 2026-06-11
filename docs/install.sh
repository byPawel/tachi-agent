#!/bin/sh
# tachi-agent stack installer — tachi-agent + dokoro + tachibot-mcp.
#
#   curl -fsSL https://bypawel.github.io/tachi-agent/install.sh | sh
#
# What it does (idempotent — safe to re-run):
#   1. Ensures Node >= 22 (Homebrew / apt / dnf, fnm fallback without sudo).
#   2. Ensures Ollama (optional — the wizard offers OpenRouter instead).
#   3. npm install -g tachi-agent dokoro tachibot-mcp
#   4. Hands off to the interactive wizard: tachi-agent setup
#
# Flags / env:
#   TACHI_NO_WIZARD=1   (or --no-wizard)  install only, skip the wizard
#
# Never pipes anything to sudo. POSIX sh — no bashisms.

set -eu

NO_WIZARD="${TACHI_NO_WIZARD:-0}"
for arg in "$@"; do
  [ "$arg" = "--no-wizard" ] && NO_WIZARD=1
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) fail "unsupported OS: $OS — on Windows, run this inside WSL." ;;
esac

have() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

# ---------------------------------------------------------------------------
# 1. Node >= 22
# ---------------------------------------------------------------------------
NEED_NODE=1
if have node; then
  major="$(node_major)"
  case "$major" in
    ''|*[!0-9]*) ;; # unparsable — treat as missing
    *) [ "$major" -ge 22 ] && NEED_NODE=0 ;;
  esac
fi

if [ "$NEED_NODE" = 1 ]; then
  say "Node >= 22 not found — installing…"
  if [ "$OS" = "Darwin" ] && have brew; then
    brew install node
  elif have apt-get; then
    say "Installing Node 22 via NodeSource (needs sudo)…"
    curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
    sudo -E sh /tmp/nodesource_setup.sh
    sudo apt-get install -y nodejs
  elif have dnf; then
    sudo dnf install -y nodejs
  else
    say "No system package manager found — installing Node via fnm (no sudo)…"
    curl -fsSL https://fnm.vercel.app/install | sh -s -- --skip-shell
    FNM_DIR="${FNM_DIR:-$HOME/.local/share/fnm}"
    export PATH="$FNM_DIR:$PATH"
    have fnm || fail "fnm install failed — install Node >= 22 manually from https://nodejs.org"
    fnm install 22
    eval "$(fnm env)"
    fnm use 22
    warn "add 'eval \"\$(fnm env)\"' to your shell profile so node stays on PATH."
  fi
  have node || fail "Node install failed — install Node >= 22 manually from https://nodejs.org"
  major="$(node_major)"
  [ "$major" -ge 22 ] 2>/dev/null || fail "Node $(node -v) is still < 22 — upgrade and re-run."
fi
say "Node $(node -v) ✓"

# ---------------------------------------------------------------------------
# 2. Ollama (optional — wizard can use OpenRouter instead)
# ---------------------------------------------------------------------------
if have ollama; then
  say "Ollama ✓"
else
  say "Ollama not found — installing (the default local brain runs on it)…"
  OLLAMA_OK=0
  if [ "$OS" = "Darwin" ]; then
    if have brew && brew install --cask ollama; then OLLAMA_OK=1; fi
    [ "$OLLAMA_OK" = 1 ] || warn "could not install Ollama — get it from https://ollama.com/download (or pick OpenRouter in the wizard)."
  else
    if curl -fsSL https://ollama.com/install.sh | sh; then OLLAMA_OK=1; fi
    [ "$OLLAMA_OK" = 1 ] || warn "Ollama install failed — see https://ollama.com/download (or pick OpenRouter in the wizard)."
  fi
fi

# ---------------------------------------------------------------------------
# 3. The stack: tachi-agent + dokoro + tachibot-mcp
# ---------------------------------------------------------------------------
say "Installing the stack: tachi-agent + dokoro + tachibot-mcp…"
if ! npm install -g tachi-agent dokoro tachibot-mcp; then
  warn "npm install -g failed (likely EACCES on the global prefix)."
  printf '%s\n' \
    "" \
    "Fix without sudo (recommended):" \
    "  mkdir -p ~/.npm-global" \
    "  npm config set prefix ~/.npm-global" \
    "  export PATH=\"\$HOME/.npm-global/bin:\$PATH\"   # add to your shell profile too" \
    "then re-run:  curl -fsSL https://bypawel.github.io/tachi-agent/install.sh | sh" >&2
  exit 1
fi
say "Installed: tachi-agent $(tachi-agent --version 2>/dev/null || echo '?') · dokoro · tachibot-mcp"

# ---------------------------------------------------------------------------
# 4. Wizard hand-off
# ---------------------------------------------------------------------------
if [ "$NO_WIZARD" = 1 ]; then
  say "Skipping wizard (TACHI_NO_WIZARD). Run it later:  tachi-agent setup"
  exit 0
fi

if [ -r /dev/tty ]; then
  # `curl | sh` occupies stdin — give the wizard the real terminal.
  say "Starting the setup wizard…"
  tachi-agent setup < /dev/tty || {
    warn "wizard exited early — re-run anytime with:  tachi-agent setup"
  }
else
  say "No TTY available. Run the wizard later:  tachi-agent setup"
fi
