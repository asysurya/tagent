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
## v__VER__ — Agent test mode: `tagent test`, the QA agent

A third agent mode joins build and plan: **TEST**. `tagent test` (or `/test`
in the TUI, or the Test button in the GUI) turns the agent into a QA engineer
for the project in your workspace — it boots the app itself, clicks through
it with a real browser, checks responsiveness and typography, and writes
`TEST-REPORT.md` with a pass/warn/fail verdict. And when your model accepts
image input, the screenshots ride along in its context — the agent JUDGES
the UI instead of guessing.

### The QA pipeline

- **serve** (new tool) — auto-detects the dev command from `package.json`
  (dev > start > serve, package manager from the lockfile; a bare
  `index.html` falls back to a static server), runs it in the background,
  waits for the port to answer, and cleans it up when the session ends —
  restart, status and logs included
- **browser** (rebuilt) — drives real Chromium via Playwright: open pages,
  click buttons, fill inputs, submit forms. Every interaction returns the
  new page state as an ARIA snapshot plus any console/network errors, so the
  agent SEES what its click did
- **responsiveness** — viewport switching to mobile (390x844), tablet
  (768x1024) and desktop (1280x800) with screenshots at each size
- **deterministic UI audit** — horizontal overflow (offending elements
  named), typography map with <12px text, skipped heading levels, tap
  targets <24px on mobile, images without alt, missing viewport meta, WCAG
  contrast sampling
- **vision** — screenshots are attached to the model's context when the
  model accepts image input (GPT-4o/5, Claude, Gemini, GLM-4V, Qwen-VL...);
  text-only models get the audit data and readable screenshot paths instead
- **test_report** — the one write test mode can do: `TEST-REPORT.md` at the
  workspace root (verdict, feature checklist with evidence, reproducible
  issues, per-viewport findings) plus a timestamped copy under
  `.tagent/test/`

### How you use it

- `tagent test` boots the TUI straight into QA mode
- `tagent test --url http://localhost:3000` (or `/test <url>`) verifies an
  already-running app — no serve step
- one-time setup per project:
  `bun add playwright && bunx playwright install chromium`
- test mode is read-only for source files — it verifies and reports; switch
  to build mode to fix what it found

### Fixes under the hood

- the old browser tool stored its page handle as a never-awaited promise —
  `page.goto` was literally undefined; the state is now awaited once and
  every action works (found by actually running it)
- multi-image context discipline: max 4 screenshots on the 2 newest
  tool-result messages, base64 read at request time (sessions store only
  paths), oversized images degrade to text references
- Z.ai adapter retries 429 rate-limits with backoff instead of dying mid-run
- the fallback chain strips image parts per-adapter, so failover to a
  text-only model survives
- browser tool default flips to ON (it was dead weight before — now the
  error message IS the install instruction; risk high + permission ask
  still gate every action)

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
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Agent test mode: tagent test, the QA agent" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

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
