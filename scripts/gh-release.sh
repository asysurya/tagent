#!/usr/bin/env bash
# Creates the GitHub release for the current version, cross-compiles the
# single-file binaries and uploads them (plus SHA256SUMS) as release assets.
#
# Usage: scripts/gh-release.sh <token> [version]
#   token   GitHub PAT with repo scope
#   version defaults to the version in packages/core/src/version.ts
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="${1:?usage: $0 <token> [version]}"
REPO="asysurya/tagent"
VERSION="${2:-$(grep -oP "(?<=CURRENT_VERSION = ')[0-9][0-9a-zA-Z.]*" packages/core/src/version.ts)}"
if [ -z "${VERSION:-}" ]; then echo "[release] cannot determine version" >&2; exit 1; fi
OUT="dist/tagent-v$VERSION"

echo "[release] tagent v$VERSION → $OUT"

# ---------------------------------------------------------------- 1. build --
bash scripts/build-binaries.sh "$VERSION"

# ---------------------------------------------------------- 2. the release --
BODY=$(cat <<'EOF'
## Single-file binaries: download, run, done

Tagent now ships as one self-contained executable per platform — like the
Node.js/Python downloads. No runtime, no install, no clone: grab the file
for your OS, run it, and both the TUI and the browser GUI just work (the web
GUI is embedded inside the binary and self-extracts on first run).

| File | Platform |
| --- | --- |
| `tagent-v0.7.0-windows-x64.exe` | Windows 10+ (64-bit) |
| `tagent-v0.7.0-windows-arm64.exe` | Windows 10+ on ARM |
| `tagent-v0.7.0-linux-x64` | Linux (glibc, 64-bit) |
| `tagent-v0.7.0-linux-arm64` | Linux ARM64 (incl. Raspberry Pi 5) |
| `tagent-v0.7.0-macos-x64` | macOS Intel |
| `tagent-v0.7.0-macos-arm64` | macOS Apple silicon |
| `SHA256SUMS.txt` | checksums for everything above |

Also linked from the website's [download page](https://tagent-web-sable.vercel.app/download),
which auto-detects your platform.

### Native Windows — no WSL needed
- The Windows builds run the full stack natively: TUI, daemon, web GUI, relay, the 40-provider catalog
- The bash tool uses Git for Windows' bash.exe (auto-detected in the usual install spots, override with `TAGENT_BASH`); `tagent doctor` tells you if it's missing
- Home/config/sessions now live in the real Windows user profile (`~/.tagent` via USERPROFILE) instead of the current directory
- Windows 10 or later, 64-bit or ARM64 — the bundled runtime does not support Windows 7/8 or 32-bit systems

### Embedded web GUI
- `gui-dist/` is baked into every binary as base64 and extracts to `~/.tagent/gui-cache/<digest>/` on first launch
- `tagent web` or `tagent start --web-gui` serves it like before; a `gui-dist` folder next to the binary (or the cwd) still takes precedence
- `tagent doctor` now also probes the shell it will use for the bash tool

---

**Install / upgrade**

Download the file for your platform, then:

```bash
# Linux / macOS
chmod +x tagent-v0.7.0-linux-x64 && ./tagent-v0.7.0-linux-x64 doctor
# Windows (PowerShell) — the .exe runs as-is
.\tagent-v0.7.0-windows-x64.exe doctor
```

Or keep installing from source (unchanged):

```bash
git clone https://github.com/asysurya/tagent.git
cd tagent && bash scripts/setup-ubuntu.sh
bun link            # makes the `tagent` command available
tagent start ~/my-project
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
shopt -s nullglob
for f in "$OUT"/tagent-v* "$OUT"/SHA256SUMS.txt; do
  name=$(basename "$f")
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
