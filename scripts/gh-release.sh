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
## v__VER__ — Chips: background badges on tool titles & reports

Titles get a background. Every tool box now opens with a filled
chip — 💻 bash on tomato, 🔌 MCP on red, 📖 reads on blue — and
the results, verdicts and reports follow one pill vocabulary:
✔ done on green, ✗ error on red, ⊘ denied on yellow. Every
report (MCP servers · repo sync · skills · memory · checkpoints)
opens with a themed header chip, MCP server states ride their
own chips, and the sync history chips each round. Each of the
six themes ships its own hand-tuned badge table — switched live
by /theme like everything else, degrading to plain text (same
widths) under NO_COLOR. `tagent doctor` matches on the CLI side.

```
╭─[💻 bash]──────────────────────────╮
│ bash setup.sh --with-flags             │
│ [✔ done] 0.8s — setup complete         │
╰───────────────────────────────────╯

  [🔌 MCP] servers (3)
    [ ready ✓ ]  context7       · 12 tools
    [ error ]    memory         · 0 tools
         ✗ No space left on device
         → free disk, then /mcp reload

  [⎇ sync] repo — status
      12:00:01 [ pushed ] manual — /push  · a1b2c3d
```

### Tool titles & status pills

- tool-call titles ride a bg chip: `╭─[💻 bash]──…` — the icon
  + name on the category color, the border still carrying the
  tool's hue behind it (composed in segments so the chip's
  reset never bleeds into the rail)
- result rows ride status pills — ✔ done / ✗ error / ⊘ denied
  — next to duration and the output tail
- run verdicts and auto-sync banners carry the chip in the top
  rail (✔ done green · ■ stopped yellow · ✗ error red · ⎇ auto-sync)

### Reports with chip headers

- `/mcp list` — 🔌 MCP header chip, per-server state chips
  (ready ✓ / error / connecting / off) with names still aligned
- `/repo status` — ⎇ sync header chip, history rounds chipped
  (pushed · pulled · error), `/push` and manual sync report
  ↑ pushed / ✗ pills
- `/skills`, `/memory`, `/checkpoints` — 🎯 · 🧠 · 💾 headers
  with counts; permission verdicts, compaction, notify errors
  and the chat-error line all ride the same pills

### Per-theme badge tables

- nine hand-tuned badge pairs per theme: dark uses the classic
  Unix combos (white on red/blue, black on green/yellow/cyan),
  tokyo-night & dracula go pastel neon with near-black text,
  nord & gruvbox ride their strong colors, light keeps dark
  chips with white text
- /theme recolors chips on the next frame; NO_COLOR and non-TTY
  degrade to plain text with identical widths — layout never
  shifts between terminals
- `tagent doctor`, `tagent sync`, `tagent clone` and `tagent
  auth` ride the same chip look on the CLI side

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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Chips: background badges on tool titles & reports" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
