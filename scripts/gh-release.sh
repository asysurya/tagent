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
## v__VER__ — TUI rebuilt Claude Code-style, web connect login & multi-device sync

The TUI is rebuilt on the Claude Code / opencode model: an **inline app — no
alternate screen**. The transcript lives in your terminal's own scrollback,
so scrolling works everywhere (mouse wheel, touch on a phone, shift+pgup,
tmux copy mode), and a small sticky region redraws at the bottom: live
stream tail → status row → the rounded editor box → a hint row with
model · tokens · ⎇ repo.

### The new TUI

- **inline rendering** (Claude Code's model, Ink-style): completed lines
  flow into the scrollback and are never redrawn — native scrolling on every
  device, including Termux/UserLAnd where there is no PageUp
- the old full-screen alt-buffer app is gone: it killed native scrollback,
  which is exactly why scrolling broke
- Claude Code visual language: ✻ banner, bold ❯ user echo, ● assistant
  bullets, ⎿ tree connectors for tool lines and results
- streaming stays in the sticky region while the message arrives; the final
  markdown render is flushed into the scrollback exactly once
- `?` on an empty editor opens the shortcuts overlay (Claude Code parity);
  ↑/↓ walk the input history; esc interrupts / clears; ctrl+x menu unchanged
- fixed a real history bug: ↑ recalled the same entry forever

### Web connect login

`tagent auth` now offers **web connect** — a one-time page opens in your
browser, you create a token (the `repo` scope is pre-selected by the link)
and paste it there; the CLI validates it against the GitHub API and prints
your login. `tagent auth --web` jumps straight to it; pasting a PAT in the
terminal and the device flow remain, and scripted pipes
(`echo "$GH_TOKEN" | tagent auth`) are unchanged.

- a tiny HTTP server binds **127.0.0.1** (loopback only) and the browser
  opens on a one-time secret URL
- the CLI validates the token against the GitHub API and stores it exactly
  like the paste flow (`~/.tagent/credentials.json`, chmod 600, never in
  config.json and never in your repos)
- loopback-only bind, random port, one-time 128-bit secret in the URL path,
  Origin/Referer checked on submit, page served `no-store`, one-shot
  endpoint — and the server dies right after the login
- no `xdg-open`? The URL is printed — on UserLAnd the phone's own browser
  reaches it (proot shares 127.0.0.1 with Android)

### Multi-device sync

Clone a project on a second machine (`tagent clone <name>`), keep working
on both, and `tagent sync` now **converges instead of colliding**:

- every sync fetches and rebases the remote's main *before* pushing — the
  raw git "fetch first" rejection is gone
- edits to different files, or different regions of the same file, merge
  automatically; history stays linear (no merge commits)
- a sync with no local changes doubles as a pull
- both devices change the same lines? The sync stops with a clear
  "nothing was lost" error and names the recovery: `git pull --rebase`,
  resolve, `tagent sync` again
- two devices pushing at the same moment: the loser re-integrates the
  winner and retries instead of failing
- fixed a 0.13.x latent bug: syncing silently deleted the clone's upstream
  tracking, which broke `git pull` in any project that had synced once

### Native edition retired

The Go port (`tagent-native-*`) is removed — the release ships the six
Bun-compiled binaries only: one engine, one feature set, one set of release
notes. It had fallen behind the main CLI (no MCP, plugins, relay, subagents
or web GUI), and the repo loses `native/` and the Go 1.21 toolchain pin.

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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — TUI rebuilt Claude Code-style, web connect login & multi-device sync" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
