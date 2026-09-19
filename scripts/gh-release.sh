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
## v0.8.0 — the token economist + MCP + plugins + interactive TUI

Tagent now spends turns and tokens like a miser, speaks the Model Context
Protocol, runs plugins with tools & slash commands, has opencode-style
arrow-key menus everywhere, and updates itself when a release drops.

### Smart cache — the token economist
- **File-state cache**: re-reading an UNCHANGED file returns a tiny "already in your context" stub instead of resending the whole file. Stamps persist per workspace (`.tagent/file-state.json`); writes/edits invalidate instantly
- **read_files**: batch up to 12 known paths in ONE call — the default way to read
- **task fast-path**: a subagent asked to just `read src/a.ts` serves the file directly — the subagent budget is never spent
- **@path mentions**: type `@src/app/page.tsx` in chat — the file rides along inline, zero tool turns
- **Context diet**: old tool results auto-compact past 150k chars (newest 4 stay full)
- **Web TTL cache** (10 min): repeated `web_fetch` / `ddg_search` skip the network
- **Anthropic prompt caching** on by default — the static prefix bills at ~10%; OpenAI/Gemini cached-token accounting included
- **Live token usage**: `12.3k in / 1.2k out (9.8k cache-hit)` on the TUI done-line
- `tagent cache` inspects everything; `tagent cache clear --all` resets

### Credentials store
- Secrets live in `~/.tagent/credentials.json` — chmod 600, separate from the shareable config
- Resolution order everywhere: credentials → config → environment

### MCP — Model Context Protocol
- Connect any stdio MCP server (npx/uvx/binary): Context7, filesystem, memory, sequential-thinking or your own — tools appear as `mcp_<server>_<tool>` behind the same permission gates
- TUI: `/mcp` manager with one-click templates · GUI: Settings → MCP · `tagent doctor` reports per-server health

### Plugins v2 — tools, commands, hooks
- Plugins export agent tools (`plugin_<name>_<tool>`) and slash commands; hot-reloading `.mjs` files
- Scaffold from `/plugins` in the TUI or Settings → Plugins in the GUI

### Interactive TUI + self-update
- Arrow-key menus everywhere: `/model` picker with type-to-filter, permission prompts, session browser, y/N confirms
- Startup update check with an arrow-key y/N prompt — binary installs swap in place (`tagent update` too)

---

## Single-file binaries: download, run, done

One self-contained executable per platform — like the Node.js/Python
downloads. No runtime, no install, no clone: grab the file for your OS,
run it, and both the TUI and the browser GUI just work (the web GUI is
embedded inside the binary and self-extracts on first run).

| File | Platform |
| --- | --- |
| `tagent-v0.8.0-windows-x64.exe` | Windows 10+ (64-bit) |
| `tagent-v0.8.0-windows-arm64.exe` | Windows 10+ on ARM |
| `tagent-v0.8.0-linux-x64` | Linux (glibc, 64-bit) |
| `tagent-v0.8.0-linux-arm64` | Linux ARM64 (incl. Raspberry Pi 5) |
| `tagent-v0.8.0-macos-x64` | macOS Intel |
| `tagent-v0.8.0-macos-arm64` | macOS Apple silicon |
| `SHA256SUMS.txt` | checksums for everything above |

Also linked from the website's [download page](https://tagent-website.vercel.app/download),
which auto-detects your platform.

### Native Windows — no WSL needed
- The Windows builds run the full stack natively: TUI, daemon, web GUI, relay, the 40-provider catalog
- The bash tool uses Git for Windows' bash.exe (auto-detected, override with `TAGENT_BASH`); `tagent doctor` tells you if it's missing
- Home/config/sessions live in the real Windows user profile (`~/.tagent` via USERPROFILE)
- Windows 10 or later, 64-bit or ARM64 — the bundled runtime does not support Windows 7/8 or 32-bit systems

**Install / upgrade**

```bash
# Linux / macOS
chmod +x tagent-v0.8.0-linux-x64 && ./tagent-v0.8.0-linux-x64 doctor
# Windows (PowerShell) — the .exe runs as-is
.\tagent-v0.8.0-windows-x64.exe doctor
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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — single-file binaries: download & run" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
