#!/usr/bin/env bash
# Creates the GitHub release for the current version, cross-compiles the
# single-file binaries and uploads them (plus SHA256SUMS) as release assets.
#
# Usage: scripts/gh-release.sh <token> [version] [--no-build]
#   token    GitHub PAT with repo scope
#   version  defaults to the version in packages/core/src/version.ts
#   --no-build  skip compilation (use existing dist/tagent-v<version>/ binaries)
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN=""
VERSION_ARG=""
NO_BUILD=0
for a in "$@"; do
  case "$a" in
    --no-build) NO_BUILD=1 ;;
    --*) ;;
    *) if [ -z "$TOKEN" ]; then TOKEN="$a"; else VERSION_ARG="$a"; fi ;;
  esac
done
REPO="asysurya/tagent"
VERSION="${VERSION_ARG:-$(grep -oP "(?<=CURRENT_VERSION = ')[0-9][0-9a-zA-Z.]*" packages/core/src/version.ts)}"
if [ -z "${TOKEN:-}" ]; then echo "usage: $0 <token> [version] [--no-build]" >&2; exit 1; fi
if [ -z "${VERSION:-}" ]; then echo "[release] cannot determine version" >&2; exit 1; fi
OUT="dist/tagent-v$VERSION"

echo "[release] tagent v$VERSION → $OUT"

# ---------------------------------------------------------------- 1. build --
if [ "$NO_BUILD" -eq 1 ]; then
  echo "[release] --no-build: using existing binaries in $OUT"
  ls -lh "$OUT"
else
  bash scripts/build-binaries.sh "$VERSION"
fi

# ------------------------------------------------ 1b. native (Go) edition --
# tagent-native binaries (Win7/8/32-bit port) are built separately into
# native/dist/ — merge them into the release dir + regenerate merged sums.
if [ -d native/dist ]; then
  for f in native/dist/tagent-native-*; do
    [ -f "$f" ] && cp -f "$f" "$OUT/"
  done
fi
if ls "$OUT"/tagent-native-* >/dev/null 2>&1; then
  (cd "$OUT" && sha256sum tagent-v"$VERSION"-* tagent-native-* > SHA256SUMS.txt)
  echo "[release] native edition merged — checksums regenerated for all binaries"
fi

# ---------------------------------------------------------- 2. the release --
BODY=$(cat <<'EOF'
## v0.10.0 — the app TUI (full-screen, shortcut-driven) + tagent uninstall

`tagent start` now takes over the terminal like a real application — the
opencode/Claude Code feel: alternate screen, boxed input editor, scrollable
transcript, and shortcuts so you rarely type. Plus a proper uninstaller.

### The app TUI
- **Full-screen takeover**: header (workspace · mode chip · model · session), scrollable transcript, live status ticker, boxed input editor, shortcut footer
- **ctrl+x quick-action menu**: Continue, Explain last change, Run diagnostics, Summarize session, switch plan/build, new session, session list, pick model, undo checkpoint, skills, subagents, fallback chain, MCP, plugins, share — arrows + enter
- **Slash palette**: type `/` — every command with descriptions, filter as you type, tab completes
- **@file mentions**: type `@` for a workspace file list, tab inserts — the file rides into the next message
- **Input editor**: cursor movement, history ↑/↓, alt+enter newline, ctrl+u / ctrl+w
- **Overlays**: permission prompts and plan approvals render as bordered arrow-key dialogs; tool calls are compact one-line cards with status + duration
- **Scroll**: pgup/pgdn with a new-lines indicator; CJK-aware wrapping survives resize
- **ctrl+c** interrupts the run; twice exits — and the terminal is ALWAYS restored, even on crashes
- Falls back to the classic readline TUI on tiny terminals/pipes automatically; `--classic` forces it

### tagent uninstall
- One command removes everything: the `tagent` command, `~/.tagent` (config, credentials, caches), the bun link registration, the source repo and/or the downloaded binary
- The repo and binary each ask separately — they may contain your work; per-workspace `.tagent/` folders are reported, not touched

### Fixes since v0.9.0
- Source installs under proot/UserLAnd: `bun install --linker=hoisted` + post-install verification with a self-healing retry (the "Cannot find package 'socket.io'" trap)
- Scripts and `bin/tagent` now carry their executable bit in git — `git pull` no longer breaks the command

---

## tagent-native — Windows 7 / 8 / 32-bit

A from-scratch Go port (pure stdlib, `CGO_ENABLED=0`): true static single-file
executables around 10-15 MB. Same agent DNA — REPL + one-shot `run`,
OpenAI-compatible providers (zai / openrouter / groq / openai built in, plus any
custom endpoint), the multi-key fallback chain, five workspace-jailed tools
(read / write / edit / list / bash) — no runtime, no installer.

- `tagent-native-windows-386.exe` is a **PE32 i386** binary: runs on Windows 7, 8, 8.1, 10, 11 — **including 32-bit machines**

---

## Single-file binaries: download, run, done

One self-contained executable per platform — like the Node.js/Python
downloads. No runtime, no install, no clone: grab the file for your OS,
run it, and both the TUI and the browser GUI just work (the web GUI is
embedded inside the binary and self-extracts on first run).

| File | Platform |
| --- | --- |
| `tagent-v0.10.0-windows-x64.exe` | Windows 10+ (64-bit) |
| `tagent-v0.10.0-windows-arm64.exe` | Windows 10+ on ARM |
| `tagent-v0.10.0-linux-x64` | Linux (glibc, 64-bit) |
| `tagent-v0.10.0-linux-arm64` | Linux ARM64 (incl. Raspberry Pi 5) |
| `tagent-v0.10.0-macos-x64` | macOS Intel |
| `tagent-v0.10.0-macos-arm64` | macOS Apple silicon |

Native edition (Go):

| File | Platform |
| --- | --- |
| `tagent-native-windows-386.exe` | **Windows 7/8/8.1/10/11 — 32-bit & 64-bit** |
| `tagent-native-windows-amd64.exe` | Windows 7+ (64-bit, lightweight) |
| `tagent-native-linux-amd64` | Linux (static — any distro, any glibc) |
| `tagent-native-linux-arm64` | Linux ARM64 (static) |

| `SHA256SUMS.txt` | checksums for everything above |

Also linked from the website's [download page](https://tagent-website.vercel.app/download),
which auto-detects your platform — 32-bit Windows visitors get the native
edition automatically.

### Native Windows — no WSL needed
- The full builds run the full stack natively: TUI, daemon, web GUI, relay, the 40-provider catalog
- The bash tool uses Git for Windows' bash.exe (auto-detected, override with `TAGENT_BASH`); `tagent doctor` tells you if it's missing
- Home/config/sessions live in the real Windows user profile (`~/.tagent` via USERPROFILE)
- Windows 7/8/32-bit: use the native edition above

**Install / upgrade**

```bash
# Linux / macOS
chmod +x tagent-v0.10.0-linux-x64 && ./tagent-v0.10.0-linux-x64 doctor
# Windows (PowerShell) — the .exe runs as-is
.\tagent-v0.10.0-windows-x64.exe doctor
# Windows 7 / 32-bit — native edition
.\tagent-native-windows-386.exe
```

**Verify a download**

```bash
sha256sum --check SHA256SUMS.txt   # certutil -hashfile <file> SHA256 on Windows
```
EOF
)
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — the app TUI: full-screen, shortcut-driven · tagent uninstall" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

ID=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id') or '')")
URL=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('html_url') or json.load(sys.stdin).get('message'))")
echo "[release] $URL"
if [ -z "$ID" ]; then echo "$RELEASE_JSON" >&2; exit 1; fi

# ----------------------------------------------------------- 3. the assets --
# list already-uploaded assets → make re-runs idempotent
ASSETS_JSON=$(curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/releases/$ID/assets")
have_asset() {
  echo "$ASSETS_JSON" | python3 -c "import json,sys; print('\n'.join(a['name'] for a in json.load(sys.stdin)))" | grep -qx "$1"
}
shopt -s nullglob
for f in "$OUT"/tagent-v* "$OUT"/tagent-native-* "$OUT"/SHA256SUMS.txt; do
  name=$(basename "$f")
  if have_asset "$name"; then
    echo "[release] $name already uploaded — skipping"
    continue
  fi
  size=$(du -h "$f" | cut -f1)
  echo "[release] uploading $name ($size) …"
  curl -s -X POST \
    -H "Authorization: token $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$name" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('  → ' + (d.get('browser_download_url') or d.get('message')))"
done

echo "[release] done — $URL"
