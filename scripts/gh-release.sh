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

# ---------------------------------------------------------- 2. the release --
BODY=$(cat <<'EOF'
## v__VER__ — background tools, mode toolsets, multi-line input

The agent can now RUN things in the background and keep working. Modes
ship exactly the tools their job needs. And the input editor finally
writes real multi-line messages.

```
╭─ ✻ Tagent v__VER__ ── 💬 running the dev server ──────────╮
╰─ 🤖 build · glm-4.7 · 🔌 2✓ 31 · [██░░░░░░] 9% · 4m ────╯

  💻 bg_run      dev — bun run dev
    ⎿ ✓ running (pid 4821, 12s, 38 output lines)

  💻 bg_logs     dev
    ⎿ ✓ tick 14 · compiled successfully
```

### New: background processes (bg_run · bg_logs · bg_stop)

- `bg_run` spawns ANY long-running command in its own process group and
  returns immediately — dev servers, watchers, soak tests, slow installs
  keep running across turns while the agent keeps working
- `bg_logs` polls the process: status, uptime, output line count and the
  tail — a growing line count is the "still working" signal; `bg_stop`
  kills the whole tree. Early-crash detection returns the output when a
  command dies instantly. Nothing leaks past exit.

### Modes that know their job

- build mode ships only project-affecting tools — the QA report
  (test_report) is test mode's deliverable, not the builder's
- plan mode: investigate + interview — read/search/web/ask_user plus
  explore subagents (task is back in plan)
- test mode (QA) knows the workflow: PRD.md is the spec, WORKLOG.md is
  what actually shipped; it teaches bg_run for non-web processes
- MCP and plugin tools stay available in plan AND test mode — the
  permission gate still asks the human for every risky call

### Multi-line input, paste that behaves

- **Enter inserts a newline; shift+enter sends** (alt+enter and
  ctrl+enter too — works on legacy terminals, kitty keyboards report
  shift+enter natively)
- bracketed paste: multi-line pastes land as text in the editor — never
  an Enter-submit per line; pastes route into whatever editor owns
  focus, and a single trailing newline is dropped
- the editor box grows to 8 rows with cursor-following scroll

### Agent-set timeouts + readable errors

- bash timeout ceiling 5min → 60min, serve ready-wait likewise — the
  agent budgets long builds/installs itself instead of watching them die
  at the default; `TAGENT_MCP_CALL_TIMEOUT_MS` for slow MCP tools
- provider HTTP errors render for humans: an OpenRouter 402 now reads
  "add credits at …" instead of a triple raw-JSON dump
- markdown: inline `code` renders as a padded chip, fenced blocks get a
  cyan [lang] tag; banner/user cards clamp to the transcript width so
  narrow terminals (odd widths, split panes) never wrap box rails

---

## Single-file binaries: download, run, done

One self-contained executable per platform — like the Node.js/Python
downloads. No runtime, no install, no clone: grab the file for your OS,
run it, and both the TUI and the browser GUI just work (the web GUI is
embedded inside the binary and self-extracts on first run).

| File | Platform |
| --- | --- |
| `tagent-v__VER__-windows-x64.exe` | Windows 10+ (64-bit) |
| `tagent-v__VER__-windows-arm64.exe` | Windows 10+ on ARM |
| `tagent-v__VER__-linux-x64` | Linux (glibc, 64-bit) |
| `tagent-v__VER__-linux-arm64` | Linux ARM64 (incl. Raspberry Pi 5) |
| `tagent-v__VER__-macos-x64` | macOS Intel |
| `tagent-v__VER__-macos-arm64` | macOS Apple silicon |

| `SHA256SUMS.txt` | checksums for everything above |

Also linked from the website's [download page](https://tagent-website.vercel.app/download),
which auto-detects your platform.

### Native Windows — no WSL needed
- The builds run the full stack natively: TUI, daemon, web GUI, relay, the 40-provider catalog
- The bash tool uses Git for Windows' bash.exe (auto-detected, override with `TAGENT_BASH`); `tagent doctor` tells you if it's missing
- Home/config/sessions live in the real Windows user profile (`~/.tagent` via USERPROFILE)
- Windows 10+ 64-bit is required (Windows 7/8 and 32-bit are no longer covered)

**Install / upgrade**

```bash
# Linux / macOS
chmod +x tagent-v__VER__-linux-x64 && ./tagent-v__VER__-linux-x64 doctor
# Windows (PowerShell) — the .exe runs as-is
.\tagent-v__VER__-windows-x64.exe doctor
```

**Verify a download**

```bash
sha256sum --check SHA256SUMS.txt   # certutil -hashfile <file> SHA256 on Windows
```
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — background tools, mode toolsets, multi-line input" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
for f in "$OUT"/tagent-v* "$OUT"/SHA256SUMS.txt; do
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
