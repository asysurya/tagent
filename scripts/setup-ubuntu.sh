#!/usr/bin/env bash
# =============================================================================
# Tagent — Ubuntu setup script
#
# Installs everything Tagent needs on Ubuntu 20.04 / 22.04 / 24.04 (and any
# Debian-based distro): bun runtime, repo dependencies, and the built web GUI.
#
# Usage:
#   bash scripts/setup-ubuntu.sh              # standard install
#   bash scripts/setup-ubuntu.sh --with-browser   # also install Playwright Chromium
#                                                 # for the `browser` tool (needs sudo)
# =============================================================================
set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
say()  { printf "%s\n" "${BOLD}\$ %s${RESET}" "$*"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "  ${YELLOW}⚠${RESET} %s\n" "$*"; }
fail() { printf "  ${RED}✗ %s${RESET}\n" "$*"; exit 1; }

cd "$(dirname "$0")/.."
echo "${BOLD}⚡ Tagent — Ubuntu setup${RESET} ($(date '+%Y-%m-%d %H:%M'))"
echo "${DIM}repo: $(pwd)${RESET}"
echo

# --- 1. OS check -------------------------------------------------------------
if [[ ! -f /etc/os-release ]]; then
  warn "This doesn't look like a Debian/Ubuntu system — continuing anyway."
else
  . /etc/os-release
  ok "detected ${PRETTY_NAME:-Linux}"
fi

# --- 2. git ------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  say "sudo apt-get install -y git"
  sudo apt-get update -qq && sudo apt-get install -y git
fi
ok "git $(git --version | awk '{print $3}')"

# --- 3. bun ------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    say "installing bun → curl -fsSL https://bun.sh/install | bash"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi
ok "bun $(bun --version)"

# --- 4. dependencies ---------------------------------------------------------
say "bun install"
bun install
ok "dependencies installed"

# --- 5. GUI bundle -----------------------------------------------------------
if [[ -f gui-dist/index.html ]]; then
  ok "web GUI bundle present (gui-dist/) — no build needed"
else
  say "bun run build:gui  ${DIM}(one-time static export of the web GUI)${RESET}"
  bun run build:gui
  ok "web GUI built → gui-dist/"
fi

# --- 6. optional: Playwright Chromium for the `browser` tool ------------------
if [[ "${1:-}" == "--with-browser" ]]; then
  say "bunx playwright install --with-deps chromium  ${DIM}(sudo for system libs)${RESET}"
  bunx playwright install --with-deps chromium
  ok "browser tool ready"
else
  echo
  warn "browser tool not installed (optional). To enable it later:"
  printf "     ${DIM}bash scripts/setup-ubuntu.sh --with-browser${RESET}\n"
fi

# --- done --------------------------------------------------------------------
echo
echo "${GREEN}${BOLD}⚡ Tagent is ready!${RESET}"
echo
echo "  Start it on any folder:"
echo "    ${BOLD}bun packages/cli/src/index.ts ~/my-project${RESET}"
echo
echo "  Then open ${BOLD}http://localhost:4020${RESET} in your browser."
echo "  First run: Settings (gear icon) → add an API key (OpenAI / Anthropic /"
echo "  Google / OpenRouter / Groq / Ollama / Z.ai) — or just try the built-in default."
echo
echo "  Useful: ${DIM}tagent <folder> --port N   # different port"
echo "          Ctrl+C to stop${RESET}"
