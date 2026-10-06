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
## v__VER__ — Small-RAM profiles & render-guard fixes

Two stability fixes for the machines tagent actually runs on: a RAM
profile (performance.ramGb — 0 = auto-detect) that scales the TUI
transcript retention, subagent parallelism, the web cache and the
context diet to the machine budget — and the root-cause fix for the
reported render glitch ("box tool call tiba-tiba jadi kayak navbar").
Drop-in: nothing to configure — auto-detect picks the tier; /config ram
to pin it explicitly.

### Added — the RAM profile (performance.ramGb)

- new performance.ramGb (default 0 = auto-detect via os.totalmem) — pin
  the machine's RAM in GB: 4, 8, 16 …
- tiers (monotonic by construction):
  - ≤4 GB → transcript 1500 rows · 2 parallel subagents · 48 web-cache
    entries · context diet at 100k chars
  - ≤8 GB → 2500 · 3 · 96 · 120k
  - above → the existing defaults 4000 · 4 · 128 · 150k
- /config ram [gb|auto] — live rescale (no restart), a 🧠 dashboard row,
  persisted to the GLOBAL config (a machine property, not per-project);
  an explicit config always wins where stricter (min) — e.g.
  subagents.maxParallel 1 stays 1
- new core/src/memory-profile.ts; setWebCacheMax eviction is now a
  while-loop, so a lowered cap actually drains (clamped 8..128)

### Fixed — the render glitch (the "navbar" tool box)

- root cause: the sticky region repaints with cursor-up + erase-below;
  a foreign write landing between frames (a plugin console.error, a
  stray log) pushed the cursor down → the next erase started too low →
  the PREVIOUS frame's top rows (the tool box) froze on screen while
  the AI stream kept painting under them. Intermittent because it
  needed a plugin error to fire
- render guard: while the app owns the screen, console.log/info/warn/
  error and stdout/stderr writes are captured — the app's own frame
  writes pass through (tuiWriting flag), every foreign write is queued
  and flushed as a transcript row inside the next frame; restored on
  destroy
- resizes (SIGWINCH) re-anchor from the bottom and drop every
  width-dependent cache (wrapped / flat / stream) — no more frozen
  fragments after a terminal reflow
- lines printed while the inline history viewer was open no longer
  VANISH when it closes (flatLines flushed too early); streamCache is
  keyed by {length, width}

### Fixed — the build OOM (the 8 GB laptop report)

- scripts/build-binaries.sh detects free RAM (/proc/meminfo · vm_stat)
  and runs bun with --smol (smaller heap, small speed cost) whenever
  free is under 6 GB — bun build --compile peaks at a few GB per target
- TAGENT_BUILD_SMOL=1/0 forces it on/off; each target still compiles
  separately and sequentially; a single-target run
  ("linux x64") cuts the peak further for the tightest boxes
- the hog is the embedded web GUI — ~11.8 MB of base64 baked into every
  binary (the price of download-run-done, zero install)

### Audit — the rest of the memory surface

- verified bounded: bash tool output capped 32k · MCP stdio fully
  piped · session history disk-based (only metadata in memory) ·
  pending writes debounced 1.5s · transcript/wrapped/flat caches bound
  by the (now profile-scaled) log cap
- honest limits, not tunables: the Bun runtime baseline is ~80–150 MB
  RSS; MCP child processes are their own OS processes — a RAM pin does
  not shrink those

### Tests

- new scripts/test-render-guard.ts — 27 checks · new
  scripts/test-memory-profile.ts — 24 checks · new glitch-proof.py
  live-pty 6/6 (a noisy plugin console.error mid-session + a mid-run
  resize: error text as transcript rows, navbar rails intact, editor
  intact, coherent repaint)
- full battery green (tui-app 44 · plugin-hooks 62 · subagents 71 ·
  skills-router 112 · …); tsc 117 — 0 new vs baseline

### Upgrade note

- drop-in: nothing required — auto-detect picks the tier on first run;
  pin it explicitly with `/config ram 8` (or `/config ram auto`)
EOF
)

BODY=${BODY//__VER__/$VERSION}
echo "[release] creating GitHub release v$VERSION …"
RELEASE_JSON=$(curl -s -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/$REPO/releases \
  -d "$(jq -n --arg tag "v$VERSION" --arg name "v$VERSION — Small-RAM profiles & render-guard fixes" --arg body "$BODY" '{tag_name: $tag, name: $name, body: $body}')")

ID=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id') or '')")
URL=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('html_url') or json.load(sys.stdin).get('message'))")
echo "[release] $URL"
if [ -z "$ID" ]; then
  # a re-run after a partial cut 422s with "already_exists" — adopt the
  # existing release and finish the missing assets instead of dying
  # (found live at the v0.31.1 cut: the upload loop is idempotent, the
  # release creation was not)
  RELEASE_JSON=$(curl -s -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/releases/tags/v$VERSION")
  ID=$(echo "$RELEASE_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id') or '')")
  if [ -n "$ID" ]; then
    echo "[release] v$VERSION already exists (id $ID) — adopting it, uploading missing assets only"
  else
    echo "$RELEASE_JSON" >&2
    exit 1
  fi
fi

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
