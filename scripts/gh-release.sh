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
## v__VER__ — TUI maximalization: themes, tool boxes, taps

The transcript gets the design it deserved. Every tool call rides a
rounded box in its category color, run stats and sync pushes ride
two-line banner boxes, and the AI reply renders as live markdown
while it streams — no more raw ## and ** on screen. Six themes
ship (dark, light, Tokyo Night, Dracula, Nord, Gruvbox) switched
live via /theme, menus grew number badges — press 1-9, or tap the
row on touch terminals — and the input box no longer collides
with the reply on narrow screens.

```
❯ /theme tokyo-night   ✔ theme → Tokyo Night · every surface recolors now

╭─ 🔧 write_file ─────────────────────────╮
│ src/app.ts                              │
│ ✔ done · 1.2s — 12 lines written        │
╰──────────────────────────────────────────╯
╭─ 💻 bash ────────────────────────────────╮
│ bash setup.sh --with-flags               │
│ ✔ done · 0.8s — setup complete           │
╰──────────────────────────────────────────╯
╭─ ✔ done ── 3 turns · 7 tool calls · 12.3s ─╮
╰──────────────────────────────────────────────╯
```

### Themes — /theme [name]

- six built-ins: dark (default, byte-identical to the old palette),
  light, tokyo-night, dracula, nord, gruvbox — 256-color SGR so
  every terminal renders them; NO_COLOR still wins
- switching is LIVE: navbar, editor, tool boxes, banners and
  markdown recolor on the very next frame; the pick is saved to
  the global config (~/.tagent) and reapplied at boot
- the markdown body follows the theme — headings, list markers,
  code chips and fence labels re-hue per palette

### Tool-call boxes

- every call rides a rounded box: icon + tool name in the title
  rail, the summarized input as the body, the result row closing
  it (drawn open at tool:start, closed at tool:end — the
  transcript stays append-only)
- the border carries the category color: bash tomato, MCP red,
  reads blue, writes green, search magenta, web cyan, ask yellow

### System banner boxes

- run verdicts: ✔ done / ■ stopped / ✗ error in the top rail, the
  stats (turns · tool calls · seconds · tokens) in the bottom rail
- auto-sync pushes and pulls get the same two-line frame —
  non-chat output stands apart from chat

### Live markdown streaming

- the streaming tail renders with the SAME renderer as the final
  flush — headings, lists, bold and links appear styled, not as
  raw markers
- a streaming code block renders as a code box: an unclosed fence
  is auto-closed mid-stream so partial code shows as code

### Mobile-friendly menus

- number badges: non-searchable lists pick directly with 1-9 (the
  ctrl+x menu, mode picker, theme picker); permission prompts take
  1-4 alongside y/a/s/n
- touch support in fullscreen: menu rows, permission options,
  ask-form options and submit, the /-palette and @-file completion
  all respond to a tap (SGR mouse reporting)
- the ctrl+x menu dropped type-to-filter — digits and taps are the
  path on phones (searchable pickers like the model list filter)

### Rendering fixes

- input-box / reply collisions fixed on narrow terminals: every
  sticky row is hard-truncated to the terminal width and the
  navbar's hard 34-column floor went responsive — the sticky-region
  geometry can no longer break and paint the editor over the
  transcript
- stale tap zones can no longer double-fire a menu action

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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — TUI maximalization: themes, tool boxes, taps" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
