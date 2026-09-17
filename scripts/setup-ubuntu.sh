#!/usr/bin/env bash
# =============================================================================
# Tagent — Ubuntu setup script (also works on Debian / WSL2 / UserLAnd)
#
# Installs everything Tagent needs on Ubuntu 20.04 / 22.04 / 24.04 (and any
# Debian-based distro, including Ubuntu running inside UserLAnd on Android):
# bun runtime, repo dependencies, and the pre-built web GUI.
#
# Usage:
#   bash scripts/setup-ubuntu.sh                  # standard install
#   bash scripts/setup-ubuntu.sh --with-browser    # also install Playwright
#                                                 # Chromium (heavy — skip on phones)
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

# UserLAnd on Android: Android kernel + proot. Everything still works, but we
# tune expectations (memory, no Playwright, phone-browser access).
MOBILE=0
if grep -qi android /proc/version 2>/dev/null || [[ -d /.proot ]] || [[ -n "${USERLAND:-}" ]]; then
  MOBILE=1
  ok "running under UserLAnd on Android ${DIM}(mobile mode)${RESET}"
fi

# Run as root (UserLAnd "root" sessions) → sudo is a no-op wrapper
SUDO=""
if [[ $(id -u) -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else
    warn "no sudo and not root — will try without it"
  fi
fi

# --- 2. git ------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  say "${SUDO} apt-get install -y git"
  ${SUDO} apt-get update -qq && ${SUDO} apt-get install -y git
fi
ok "git $(git --version | awk '{print $3}')"

# --- 3. curl (bun installer needs it; missing on minimal UserLAnd images) ----
if ! command -v curl >/dev/null 2>&1; then
  say "${SUDO} apt-get install -y curl"
  ${SUDO} apt-get update -qq && ${SUDO} apt-get install -y curl
fi
ok "curl $(curl --version | head -1 | awk '{print $2}')"

# --- 4. bun ------------------------------------------------------------------
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

# --- 5. dependencies ---------------------------------------------------------
say "bun install  ${DIM}$( [[ $MOBILE -eq 1 ]] && echo '(takes a few minutes on a phone)')${RESET}"
bun install
ok "dependencies installed"

# --- 6. GUI bundle -----------------------------------------------------------
if [[ -f gui-dist/index.html ]]; then
  ok "web GUI bundle present (gui-dist/) — no build needed"
else
  if [[ $MOBILE -eq 1 ]]; then
    fail "gui-dist/ missing. Re-clone the repo — building the GUI on a phone is not supported."
  fi
  say "bun run build:gui  ${DIM}(one-time static export of the web GUI)${RESET}"
  bun run build:gui
  ok "web GUI built → gui-dist/"
fi

# --- 7. optional: Playwright Chromium for the `browser` tool ------------------
if [[ "${1:-}" == "--with-browser" ]]; then
  if [[ $MOBILE -eq 1 ]]; then
    warn "phones rarely have enough RAM for headless Chromium — skipping."
    warn "the agent works fine without the browser tool."
  else
    say "bunx playwright install --with-deps chromium  ${DIM}(sudo for system libs)${RESET}"
    bunx playwright install --with-deps chromium
    ok "browser tool ready"
  fi
else
  echo
  warn "browser tool not installed (optional). To enable it later:"
  printf "     ${DIM}bash scripts/setup-ubuntu.sh --with-browser${RESET}\n"
fi

# --- done --------------------------------------------------------------------
echo
echo "${GREEN}${BOLD}⚡ Tagent is ready!${RESET}"
echo
if [[ $MOBILE -eq 1 ]]; then
  echo "  Start it on any folder (keep this terminal session open):"
  echo "    ${BOLD}bun packages/cli/src/index.ts ~/my-project --no-open${RESET}"
  echo
  echo "  Then open ${BOLD}http://localhost:4020${RESET} in your PHONE browser."
  echo "  ${DIM}UserLAnd shares the network with Android, so localhost works.${RESET}"
  echo
  echo "  Tips: ${DIM}disable battery optimization for UserLAnd;"
  echo "        expect slower installs than a PC; 2 GB+ free RAM recommended.${RESET}"
else
  echo "  Start it on any folder:"
  echo "    ${BOLD}bun packages/cli/src/index.ts ~/my-project${RESET}"
  echo
  echo "  Then open ${BOLD}http://localhost:4020${RESET} in your browser."
  echo "  First run: Settings (gear icon) → add an API key (OpenAI / Anthropic /"
  echo "  Google / OpenRouter / Groq / Ollama / Z.ai) — or just try the built-in default."
  echo
  echo "  Useful: ${DIM}tagent <folder> --port N     # different port"
  echo "          tagent <folder> --host 0.0.0.0    # reach the GUI from your LAN"
  echo "          Ctrl+C to stop${RESET}"
fi
