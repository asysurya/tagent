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
## v0.13.0 — GitHub login & project sync, markdown in the terminal, TUI polish

Your projects now follow you. Log in with GitHub and tagent offers — once per
project — to sync the workspace to a private repo; `tagent clone` continues it
on any device. Guests keep everything local: no account is ever required.

### GitHub login & project sync
- **`tagent auth`** — PAT walkthrough by default (github.com/settings/tokens,
  scope `repo`), `--device` for the OAuth device flow, or pipe the token when
  non-interactive. It lands in `~/.tagent/credentials.json` (chmod 600) — never
  in config.json, never in .git/config
- **Guest-first**: every feature stays local without an account. After login,
  tagent asks once per project — “sync this workspace to GitHub?” with
  *Sync now / Later / Not this project* (answers are remembered)
- **`tagent sync [message]`** snapshots the workspace (commit + push) into a
  private repo — `tagent-<dirname>` by default; the token is used one-shot and
  never written anywhere persistent
- **`tagent projects`** lists linked projects (name · repo · last sync, ▸ marks
  the current one); **`tagent clone <owner/name | name>`** restores any of them
  on this machine and prints the next steps
- **`tagent whoami`** / **`tagent logout`** — status and local-token removal;
  the GitHub side is never touched
- **Web GUI**: matching login + sync dialogs, wired to the new daemon RPC
  events (`auth:*`, `sync:*`, `projects:*`) — any client can drive the same flow
- The TUI `/push` command now goes through the same sync engine, and the stats
  bar grows a dim `⎇ owner/repo` badge once a project is linked

### Markdown in the TUI
- Assistant replies render real markdown in the terminal — bold colored
  headings, **bold**, *italic*, `inline code`
- Fenced code blocks draw a dim left rail with a language label; nested lists
  indent; `>` quotes and `---` rules render
- Pipe tables render best-effort and links degrade to “text (url)” — all
  width-aware, double-width CJK glyphs included

### TUI polish
- Persistent stats bar under the chat input: model · mode · tokens · time ·
  workspace — always visible while you type
- **ESC stops a running agent** — model calls and bash tools cancel mid-flight,
  the conversation stays usable
- Arrow keys scroll the transcript without touching input history (while
  scrolled up, ↑/↓ move one line; pgup/pgdn a page as before)

### Under the hood
- Core sync engine: project registry (`~/.tagent/projects.json`),
  link/refuse state, guest→login flow, restore/clone — 57 offline hermetic tests
- CLI update flow hardened: the source-install updater verifies the git remote
  before ever running `git pull`
- GUI state slice for auth & sync (guest · login · linkedRepo · lastSyncAt)
- Website: responsive & tidy audit pass — mobile hamburger nav, scrollable
  download tables, focus rings, refreshed docs

---

## Single-file binaries: download, run, done

One self-contained executable per platform — like the Node.js/Python
downloads. No runtime, no install, no clone: grab the file for your OS,
run it, and both the TUI and the browser GUI just work (the web GUI is
embedded inside the binary and self-extracts on first run).

| File | Platform |
| --- | --- |
| `tagent-v0.13.0-windows-x64.exe` | Windows 10+ (64-bit) |
| `tagent-v0.13.0-windows-arm64.exe` | Windows 10+ on ARM |
| `tagent-v0.13.0-linux-x64` | Linux (glibc, 64-bit) |
| `tagent-v0.13.0-linux-arm64` | Linux ARM64 (incl. Raspberry Pi 5) |
| `tagent-v0.13.0-macos-x64` | macOS Intel |
| `tagent-v0.13.0-macos-arm64` | macOS Apple silicon |

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
- Windows 7/8/32-bit: use the native edition above — it has the same app TUI

**Install / upgrade**

```bash
# Linux / macOS
chmod +x tagent-v0.13.0-linux-x64 && ./tagent-v0.13.0-linux-x64 doctor
# Windows (PowerShell) — the .exe runs as-is
.\tagent-v0.13.0-windows-x64.exe doctor
# Windows 7 / 32-bit — native edition (just run it: the app TUI opens)
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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — GitHub login & project sync, markdown in the terminal, TUI polish" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
