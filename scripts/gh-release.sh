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
## v__VER__ — AI ask forms + Z.ai models as a config file

Two things this release: the agent can now **ask you questions through
interactive forms**, and the built-in Z.ai provider's model list is **a config
file you can edit**.

### ask_user — the interview form

When a decision materially changes the work, the agent asks, not guesses —
through a form, not a wall of text:

- **three field kinds** — `option` (single choice, radio), `multi` (multiple
  choice, checkboxes) and `input` (free text); one call batches up to 6
  questions, so plan-mode interviews become one form instead of a chat
  interrogation
- option/multi fields always offer **+ add your own option** — your custom
  answer becomes a first-class choice, selected like any other
- every form carries an **optional notes textarea** under the fields for
  anything else worth saying
- **the inline TUI** renders it as an interactive overlay: ↑↓ move ·
  space/enter pick · `a` add option · tab next field · esc cancel; required
  fields block submit and jump the cursor back to you
- **the web GUI** gets a matching dialog — radio pills, checkboxes, textareas,
  an inline add-option input
- **the classic TUI** asks sequentially with the arrow-key menus
- plan mode's INTERVIEW step uses the form by default; build and test modes
  can too
- headless-safe: pipes and subagents get an honest "no interactive user"
  answer, so the model proceeds with stated assumptions instead of hanging; a
  dismissed form says so explicitly
- answers flow back to the model verbatim (notes included), and a one-line
  trail lands in your transcript so the answers stay in the scrollback

### Z.ai models as a config file

The built-in provider's model catalog moved from hardcoded arrays to
`packages/core/src/data/zai-models.json` — data, not code. And you can
override or extend it without touching the binary:

- `~/.tagent/zai-models.json` (global) or `<workspace>/.tagent/zai-models.json`
  (per project)
- same-id entries replace the built-ins in place, new ids append,
  `"replace": true` swaps the whole list
- per-model `vision: true` now works end to end — the Z.ai adapter maps image
  parts to the SDK's content blocks, so GLM-4.7 / 4.6 / 4.5V actually receive
  the screenshots in test mode
- the model id is passed through to the SDK on every call — harmless where
  the endpoint ignores it, forward-compatible when it starts honoring it

### Fixes under the hood

- gh-release.sh had lost its header (token/version parsing + `--no-build`) in
  the 0.15.0 body rewrite — restored
- ask_user is allow-listed by default (risk: low) — no permission
  double-prompt for the privilege of being asked a question
- subagents never see the form tool (filtered from their toolset + a runtime
  guard) — only the primary agent faces the human

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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — AI ask forms + Z.ai models config" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
