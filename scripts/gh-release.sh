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
## v0.9.0 — plan-interview + PRD flow, multi-key fallback chains, custom subagents & the native edition for Windows 7 / 32-bit

Plan mode becomes an interviewer, providers get an ordered failover chain,
subagents become customizable, edits get auto-diagnosed — and a from-scratch
Go port finally brings tagent to Windows 7/8 and 32-bit machines.

### Plan mode is now an interviewer
- **PLAN** mode asks focused questions about your project until the details are there, then delivers a `## Plan` + `## Verification` and stops for approval
- Approve → the plan is written to **PRD.md**, the session flips to build mode, implementation starts
- **BUILD** mode checks for `PRD.md` first: if there is none, the agent asks — continue without it, or switch to plan mode?
- The agent always knows which of the two jobs it is doing (system-prompt emphasis)

### Provider fallback — ordered multi-key chains
- Entries like `1. openrouter / keyA / modelX → 2. openrouter / keyB / modelX → 3. groq / keyC / modelY` — same provider under many keys, any mix, priority-ordered
- Automatic failover mid-run when a provider errors; the loop keeps going on the next entry
- TUI `/fallback add|rm|clear|list` · GUI Settings → ordered chain editor (reorder, per-entry key + label)

### Custom subagents
- Define specialists in `.tagent/agents/*.md` (workspace) or `~/.tagent/agents/*.md` (global): front-matter `name / description / model / tools / mode / maxTurns` + a system-prompt persona
- The `task` tool spawns them by name; per-agent model override; workspace overrides global
- TUI `/agents` · the GUI timeline shows every subagent run

### Auto-diagnostics after edits
- After each edit-turn, a configurable check command runs once (default `tsc --noEmit`, or `npm run lint`); failures are fed back with a fix-before-done instruction
- TUI `/diag [cmd|off|test]`

### Tougher networking
- DDG search "unknown certificate verification error" → automatic one-shot retry with relaxed TLS; `TAGENT_TLS_SKIP=1` forces relaxed mode (broken TLS interception / proxies)
- Tool internals never render as user messages in the web GUI anymore

### Web GUI — session management & polish
- Rename sessions inline, delete with confirmation, auto-titles from the first message
- Fixed: double-sent user messages, tool-result leak on session load, stream bleed when switching sessions mid-run

---

## tagent-native — Windows 7 / 8 / 32-bit at last

A from-scratch Go port (pure stdlib, `CGO_ENABLED=0`): true static single-file
executables around 10-15 MB. Same agent DNA — REPL + one-shot `run`,
OpenAI-compatible providers (zai / openrouter / groq / openai built in, plus any
custom endpoint), the multi-key fallback chain, five workspace-jailed tools
(read / write / edit / list / bash) — no runtime, no installer.

- `tagent-native-windows-386.exe` is a **PE32 i386** binary: runs on Windows 7, 8, 8.1, 10, 11 — **including 32-bit machines**
- The full edition (below) needs Windows 10+ 64-bit — the native edition is the answer for old hardware
- The native edition keeps the core agent loop; the web GUI, MCP, plugins and the 40-provider catalog stay full-edition features

---

## Single-file binaries: download, run, done

One self-contained executable per platform — like the Node.js/Python
downloads. No runtime, no install, no clone: grab the file for your OS,
run it, and both the TUI and the browser GUI just work (the web GUI is
embedded inside the binary and self-extracts on first run).

| File | Platform |
| --- | --- |
| `tagent-v0.9.0-windows-x64.exe` | Windows 10+ (64-bit) |
| `tagent-v0.9.0-windows-arm64.exe` | Windows 10+ on ARM |
| `tagent-v0.9.0-linux-x64` | Linux (glibc, 64-bit) |
| `tagent-v0.9.0-linux-arm64` | Linux ARM64 (incl. Raspberry Pi 5) |
| `tagent-v0.9.0-macos-x64` | macOS Intel |
| `tagent-v0.9.0-macos-arm64` | macOS Apple silicon |

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
chmod +x tagent-v0.9.0-linux-x64 && ./tagent-v0.9.0-linux-x64 doctor
# Windows (PowerShell) — the .exe runs as-is
.\tagent-v0.9.0-windows-x64.exe doctor
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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — plan-interview + PRD flow, fallback chains & the Windows 7/32-bit native edition" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
