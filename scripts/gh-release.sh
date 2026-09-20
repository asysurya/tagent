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
## v__VER__ — the glow-up: real TUI libraries

The TUI now runs on real terminal libraries instead of hand-rolled width
math, and it shows: **rounded cards**, **emoji tool icons**, **box markdown
tables**, and — the actual point — **lines that finally align**.

```
╭─ ✻ Tagent v__VER__ ──────────────────────────────────────────╮
│ 📂 workspace /home/z/my-project/demo-workspace               │
│ 🤖 model     glm-4.7 (zai) · ctx 0/131.1k [░░░░░░░░░░] 0%    │
│ 🔌 mcp       none — /mcp adds Model Context Protocol servers │
│ 🌐 web gui   off — /webgui on or start with --web-gui        │
╰──────────────────────────────────────────────────────────────╯

╭─ ❯ you ─────────────────────────────────────────────────────╮
│ halo 你好 ✅ cek alignment bawah ini ya                     │
╰──────────────────────────────────────────────────────────────╯

  💻 bash        git status
    ⎿ ✓ 2.1s — 3 lines
```

### New: shared UI kit (`ui.ts`)

- **string-width + strip-ansi** — true Unicode display width: CJK extension
  blocks, emoji presentation (✅ ⚡ …), ZWJ families, combining marks. The
  old hand-rolled table missed whole ranges — that is why columns wobbled
- **figures** — cross-platform symbols (✔ ✘ ❯ ↑↓) with automatic ASCII
  fallback on legacy terminals
- **cli-boxes** — the `╭─╮ ╰─╯` round border preset; **picocolors** for
  color; **wrap-ansi** for hard word wrap
- one kit, four consumers: the inline TUI, the classic TUI, the markdown
  renderer and the select menus all measure with the same functions

### The glow-up

- boot banner is a rounded card with an emoji row per fact and a value
  column that is ALWAYS aligned (the old hardcoded padding was off by one
  column on two rows — `mcp` and `web gui`)
- your messages echo as opencode-style rounded cards (`╭─ ❯ you ──╮`) —
  CJK and emoji in the text can no longer break the right rail
- tool lines carry emoji icons (📖 read · 💻 bash · 🔍 search · 🌐 fetch ·
  💬 ask · 🧠 memory · 🤖 subagent …) on a fixed tool-name column, so
  durations and summaries line up; results keep the `⎿` connector
- markdown pipe tables render as full box tables (`╭┬╮ ├──┼──┤ ╰┴╯`) with
  left/center/right alignment preserved
- assistant messages get Claude Code's orange ● bullet; the status row has
  a moon-phase spinner (🌑🌒🌓) with 🤔/⚡/🌊 phase emoji
- `/help`, `/tools`, `/models`, `/mcp`, `/sessions` menus pad with true
  width — emoji or CJK in names no longer shear the columns

### Also

- full test coverage: 46 ui-kit unit tests plus the whole regression battery
  re-run green (tui-app, tui-md, markdown 95, compact 49, context-loop 30,
  ask 38, cache 38, features, select, host, PTY suites)

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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — context window bar + deterministic memory compaction" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
